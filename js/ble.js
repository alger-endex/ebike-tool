/**
 * ble.js — Web Bluetooth (BLE) channel manager
 *
 * 與 SerialManager 相同介面，app.js 可無縫切換兩個通道。
 *
 * 連線流程:
 *   1. 掃描名稱 = "ESP_GATTS_DEMO" 的裝置
 *   2. 建立 GATT 連線
 *   3. 自動偵測支援 UART bridge 的 Service/Characteristic
 *      (依序嘗試 NUS → ESP_GATTS → HM10 → SPP，找到第一組 write+notify 即使用)
 *   4. 訂閱 notify characteristic → 資料推入 _rxBuf
 *   5. write() 直接寫入 write characteristic
 */

// ── 常見 BLE UART Service 組態（依優先順序嘗試）─────────────
// write:  browser → ESP32   (characteristic 要有 write 或 writeWithoutResponse property)
// notify: ESP32  → browser  (characteristic 要有 notify property)
const BLE_UART_PROFILES = [
  // ── 優先嘗試（已確認裝置使用 Service 0x00FF）────────────
  {
    name:   'ESP_GATTS',
    svc:    0x00ff,
    write:  0xff01,
    notify: 0xff01,   // 同一個 char 同時有 write + notify
    cfg:    null,
  },
  // ── 備用 ────────────────────────────────────────────────
  {
    name:   'NUS',
    svc:    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    write:  '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    cfg:    '6e400004-b5a3-f393-e0a9-e50e24dcca9e',
  },
  {
    name:   'HM10',
    svc:    0xffe0,
    write:  0xffe1,
    notify: 0xffe1,
    cfg:    null,
  },
  {
    name:   'SPP',
    svc:    0xabf0,
    write:  0xabf1,
    notify: 0xabf2,
    cfg:    null,
  },
];

// requestDevice 時需預先宣告所有可能用到的 service UUID
const BLE_OPTIONAL_SERVICES = [
  0x00ff,                                          // ESP_GATTS (使用中)
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',         // NUS
  0xffe0, 0xffe1,                                  // HM10
  0xabf0,                                          // SPP
];

// NUS CFG UUID (只有使用 NUS profile 時才有)
const BLE_NUS_CFG = '6e400004-b5a3-f393-e0a9-e50e24dcca9e';

class BleManager {
  constructor() {
    this._device      = null;
    this._server      = null;
    this._writeChar   = null;   // browser → ESP32 (write)
    this._notifChar   = null;   // ESP32 → browser (notify)
    this._cfgChar     = null;   // baud rate 設定 (NUS only, 選用)
    this._profileName = null;   // 成功配對的 profile 名稱
    this._rxBuf       = [];
    this.onDebugTx    = null;
    this.onDebugRx    = null;
    this.onDisconnect = null;
  }

  /** 連線後的裝置資訊，供 UI 顯示用 */
  get deviceInfo() {
    return {
      name:    this._device ? this._device.name : null,
      profile: this._profileName || null,
    };
  }

  get isOpen() {
    return !!(this._device && this._device.gatt.connected);
  }

  async open({ baudRate = 115200 } = {}) {
    // ── 環境檢查 ────────────────────────────────────────────
    if (!window.isSecureContext) {
      throw new Error('Web Bluetooth 需要 HTTPS 或 localhost 環境');
    }
    if (!navigator.bluetooth) {
      throw new Error('此瀏覽器不支援 Web Bluetooth API\n請使用 Chrome / Edge 並以 HTTPS 或 localhost 開啟');
    }

    // ── Step 1: 掃描裝置 ────────────────────────────────────
    try {
      this._device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: BLE_OPTIONAL_SERVICES,
      });
    } catch (e) {
      if (e.name === 'NotFoundError') throw new Error('BLE 掃描已取消（未選擇裝置）');
      throw e;
    }

    this._device.addEventListener('gattserverdisconnected', () => {
      this._rxBuf = [];
      if (this.onDisconnect) this.onDisconnect();
    });

    // ── Step 2: 建立 GATT 連線 ──────────────────────────────
    try {
      this._server = await this._device.gatt.connect();
    } catch (e) {
      this._device = null;
      throw new Error('GATT 連線失敗：' + e.message);
    }

    // ── Step 3: 自動偵測 UART bridge Characteristics ────────
    const found = await this._findUartChars();
    this._writeChar   = found.writeChar;
    this._notifChar   = found.notifChar;
    this._cfgChar     = found.cfgChar;
    this._profileName = found.profileName;

    // ── Step 4: 訂閱 Notification (ESP32 → browser) ─────────
    try {
      await this._notifChar.startNotifications();
    } catch {
      await this.close();
      throw new Error('無法訂閱 Notification，請重試');
    }
    this._notifChar.addEventListener('characteristicvaluechanged', (e) => {
      const bytes = new Uint8Array(e.target.value.buffer);
      for (const b of bytes) this._rxBuf.push(b);
      if (this.onDebugRx) this.onDebugRx(bytes);
    });

    // ── Step 5: 傳送 baud rate 設定給 ESP32（NUS only）───────
    if (this._cfgChar && baudRate) {
      const cfg = new Uint8Array(5);
      cfg[0] = 0x01;
      cfg[1] =  baudRate        & 0xFF;
      cfg[2] = (baudRate >>  8) & 0xFF;
      cfg[3] = (baudRate >> 16) & 0xFF;
      cfg[4] = (baudRate >> 24) & 0xFF;
      await this._cfgChar.writeValueWithoutResponse(cfg);
    }
  }

  /**
   * 依序嘗試 BLE_UART_PROFILES：
   *   1. 先用 profile 設定的 UUID 找 characteristic
   *   2. 若找不到，枚舉該 service 下所有 characteristics，
   *      自動選出第一個有 write 屬性 + 第一個有 notify 屬性的
   * 回傳 { writeChar, notifChar, cfgChar, profileName }
   */
  async _findUartChars() {
    const errors = [];

    for (const profile of BLE_UART_PROFILES) {
      // ── 1. 找 Service ──────────────────────────────────────
      let svc;
      try {
        svc = await this._server.getPrimaryService(profile.svc);
      } catch (e) {
        errors.push(profile.name + ': ' + e.message);
        continue;
      }

      // ── 2. 嘗試 profile 指定的 UUID ───────────────────────
      let writeChar = null, notifChar = null;
      try { writeChar = await svc.getCharacteristic(profile.write);  } catch {}
      try { notifChar = await svc.getCharacteristic(profile.notify); } catch {}

      // ── 3. 若找不到，枚舉全部 Characteristics 自動選配 ────
      if (!writeChar || !notifChar) {
        let allChars = [];
        try {
          allChars = await svc.getCharacteristics();
        } catch (e) {
          errors.push(profile.name + ': getCharacteristics 失敗 — ' + e.message);
          continue;
        }

        // 記錄所有 Characteristic UUID 和屬性供除錯
        if (this._onLog) {
          const svcHex = typeof profile.svc === 'number'
            ? '0x' + profile.svc.toString(16).toUpperCase().padStart(4, '0')
            : profile.svc.slice(0, 8).toUpperCase() + '...';
          const lines = allChars.map(c => {
            const props = Object.keys(c.properties)
              .filter(k => c.properties[k]).join(', ');
            return '  ' + c.uuid + '  [' + props + ']';
          }).join('\n');
          this._onLog('Service ' + svcHex + ' 的 Characteristics:\n' + lines);
        }

        for (const char of allChars) {
          if (!writeChar && (char.properties.write || char.properties.writeWithoutResponse)) {
            writeChar = char;
          }
          if (!notifChar && char.properties.notify) {
            notifChar = char;
          }
        }
      }

      // ── 4. 驗證屬性 ────────────────────────────────────────
      const canWrite  = writeChar  && (writeChar.properties.write  || writeChar.properties.writeWithoutResponse);
      const canNotify = notifChar  && notifChar.properties.notify;

      if (!canWrite || !canNotify) {
        errors.push(profile.name + ': 找不到符合的 write + notify characteristics');
        continue;
      }

      // ── 5. 成功 ─────────────────────────────────────────────
      let cfgChar = null;
      if (profile.cfg) {
        try { cfgChar = await svc.getCharacteristic(profile.cfg); } catch {}
      }

      const svcHex = typeof profile.svc === 'number'
        ? '0x' + profile.svc.toString(16).toUpperCase().padStart(4, '0')
        : profile.svc.slice(0, 8).toUpperCase() + '...';
      if (this._onLog) {
        this._onLog(
          'BLE 連線成功  Profile: ' + profile.name + '  Service: ' + svcHex +
          '\n  Write char : ' + writeChar.uuid +
          '\n  Notify char: ' + notifChar.uuid
        );
      }

      return { writeChar, notifChar, cfgChar, profileName: profile.name };
    }

    await this.close();
    throw new Error(
      '無法自動偵測 BLE UART Characteristics\n\n' +
      '嘗試的 Profile:\n' + errors.map(s => '  • ' + s).join('\n') + '\n\n' +
      '請確認裝置 GATT Service 包含 Write + Notify Characteristic'
    );
  }

  async close() {
    if (this._notifChar) {
      try { await this._notifChar.stopNotifications(); } catch {}
      this._notifChar = null;
    }
    if (this._device && this._device.gatt.connected) {
      try { this._device.gatt.disconnect(); } catch {}
    }
    this._device      = null;
    this._server      = null;
    this._writeChar   = null;
    this._cfgChar     = null;
    this._profileName = null;
    this._rxBuf       = [];
  }

  async write(data) {
    if (!this.isOpen) throw new Error('BLE 未連線');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (this.onDebugTx) this.onDebugTx(bytes);
    await this._writeChar.writeValueWithoutResponse(bytes);
  }

  clearBuffer() { this._rxBuf.length = 0; }

  // ── Protocol-level reads（邏輯與 SerialManager 相同）────────

  readUartFrame(timeoutMs = 1000) {
    return this._waitFor((buf) => {
      const start = buf.indexOf(0x3A);
      if (start < 0) return -1;
      for (let i = start + 1; i < buf.length - 1; i++) {
        if (buf[i] === 0x0D && buf[i + 1] === 0x0A) return i + 1;
      }
      return -1;
    }, timeoutMs, 0x3A);
  }

  readCanFrame(timeoutMs = 1000) {
    return this._waitFor((buf) => {
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0xFA && buf[i + 1] === 0x0D) {
          if (buf.length >= i + 15) return i + 14;
        }
      }
      return -1;
    }, timeoutMs, null);
  }

  readBurnUartFrame(cmdByte, timeoutMs = 3000) {
    return this._waitFor((buf) => {
      const start = buf.indexOf(cmdByte);
      if (start < 0) return -1;
      if (buf.length <= start + 1) return -1;
      const lenBcd = parseInt(buf[start + 1].toString(16), 10);
      if (isNaN(lenBcd)) return -1;
      const end = start + lenBcd + 3;
      return buf.length > end ? end : -1;
    }, timeoutMs, cmdByte);
  }

  readBurnUartLineAck(timeoutMs = 3000) {
    return this._waitFor((buf) => {
      const start = buf.indexOf(0xF1);
      if (start < 0) return -1;
      return buf.length >= start + 6 ? start + 5 : -1;
    }, timeoutMs, 0xF1);
  }

  readBurnBleCanLineAck(timeoutMs = 3000) {
    return this._waitFor((buf) => {
      const start = buf.indexOf(0xF1);
      if (start < 0) return -1;
      return buf.length >= start + 4 ? start + 3 : -1;
    }, timeoutMs, 0xF1);
  }

  _waitFor(matcher, timeoutMs, startByte) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        const endIdx = matcher(this._rxBuf);
        if (endIdx >= 0) {
          let startIdx = 0;
          if (startByte !== null) {
            startIdx = this._rxBuf.indexOf(startByte);
            if (startIdx < 0) startIdx = 0;
          } else {
            for (let i = 0; i <= endIdx - 1; i++) {
              if (this._rxBuf[i] === 0xFA && this._rxBuf[i + 1] === 0x0D) {
                startIdx = i + 2;
                break;
              }
            }
          }
          const slice = this._rxBuf.splice(0, endIdx + 1).slice(startIdx);
          resolve(new Uint8Array(slice));
          return;
        }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(poll, 2);
      };
      poll();
    });
  }
}
