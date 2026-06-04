/**
 * serial.js — Web Serial API wrapper
 *
 * Usage:
 *   const mgr = new SerialManager();
 *   await mgr.open({ baudRate: 9600 });
 *   await mgr.write(bytes);
 *   const frame = await mgr.readUartFrame(1000);
 *   const frame = await mgr.readCanFrame(1000);
 *   await mgr.close();
 */
class SerialManager {
  constructor() {
    this._port    = null;
    this._writer  = null;
    this._reader  = null;
    this._rxBuf   = [];          // raw receive buffer
    this._loop    = null;        // read-loop promise
    // Debug callbacks — set by app.js when debug mode is on
    this.onDebugTx = null;       // fn(Uint8Array)
    this.onDebugRx = null;       // fn(Uint8Array)
  }

  get isOpen() {
    return this._port !== null
      && this._port.readable !== null
      && this._port.readable !== undefined;
  }

  /** Open serial port. Prompts user to select port if first time. */
  async open({ baudRate = 9600, dataBits = 8, stopBits = 1, parity = 'none' } = {}) {
    // Allow re-selecting if previously failed
    if (!this._port) {
      this._port = await navigator.serial.requestPort();
    }
    try {
      await this._port.open({ baudRate, dataBits, stopBits, parity });
    } catch (e) {
      this._port = null;   // reset so user can pick again next time
      throw e;
    }
    this._startLoop();
  }

  /** Close and reopen at a new baud rate (used for CAN mode switch). */
  async reopen({ baudRate, dataBits = 8, stopBits = 1, parity = 'none' }) {
    await this._stopLoop();
    if (this._writer) { try { await this._writer.close(); } catch {} this._writer = null; }
    await this._port.close();
    await this._port.open({ baudRate, dataBits, stopBits, parity });
    this._startLoop();
  }

  /** Close port completely. */
  async close() {
    await this._stopLoop();
    if (this._writer) { try { this._writer.releaseLock(); } catch {} this._writer = null; }
    if (this._port)   { try { await this._port.close(); }  catch {} this._port   = null; }
    this._rxBuf = [];
  }

  /** Write bytes to port. */
  async write(data) {
    if (!this._port || !this._port.writable) throw new Error('Port not open');
    if (!this._writer) this._writer = this._port.writable.getWriter();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (this.onDebugTx) this.onDebugTx(bytes);
    await this._writer.write(bytes);
  }

  /** Discard all buffered received bytes. */
  clearBuffer() { this._rxBuf.length = 0; }

  // ──────────────────────────────────────────────────────
  //  Protocol-level reads
  // ──────────────────────────────────────────────────────

  /**
   * Read a UART response frame.
   * Frame: starts with 0x3A, ends with 0x0D 0x0A.
   * Returns Uint8Array or null on timeout.
   */
  readUartFrame(timeoutMs = 1000) {
    return this._waitFor((buf) => {
      const start = buf.indexOf(0x3A);
      if (start < 0) return -1;
      // Look for 0x0D 0x0A pair after start
      for (let i = start + 1; i < buf.length - 1; i++) {
        if (buf[i] === 0x0D && buf[i + 1] === 0x0A) return i + 1; // inclusive end
      }
      return -1;
    }, timeoutMs, 0x3A);
  }

  /**
   * Read a UART burn response frame.
   * Frame: [cmdByte, lenBcd, data(lenBcd bytes), crc_lo, crc_hi]
   * lenBcd: hex-string-as-decimal (0x06 → "6" → 6).
   * Returns Uint8Array starting from cmdByte, or null on timeout.
   */
  readBurnUartFrame(cmdByte, timeoutMs = 3000) {
    return this._waitFor((buf) => {
      const start = buf.indexOf(cmdByte);
      if (start < 0) return -1;
      if (buf.length <= start + 1) return -1;
      const lenBcd = parseInt(buf[start + 1].toString(16), 10);
      if (isNaN(lenBcd)) return -1;
      const end = start + lenBcd + 3; // inclusive end index
      return buf.length > end ? end : -1;
    }, timeoutMs, cmdByte);
  }

  /**
   * Read UART burn line ACK: fixed 6 bytes starting with 0xF1.
   * Returns Uint8Array(6) or null on timeout.
   */
  readBurnUartLineAck(timeoutMs = 3000) {
    return this._waitFor((buf) => {
      const start = buf.indexOf(0xF1);
      if (start < 0) return -1;
      return buf.length >= start + 6 ? start + 5 : -1;
    }, timeoutMs, 0xF1);
  }

  /**
   * Read BLE-CAN burn line ACK: fixed 4 bytes starting with 0xF1 (no CRC).
   * Returns Uint8Array(4) or null on timeout.
   */
  readBurnBleCanLineAck(timeoutMs = 3000) {
    return this._waitFor((buf) => {
      const start = buf.indexOf(0xF1);
      if (start < 0) return -1;
      return buf.length >= start + 4 ? start + 3 : -1;
    }, timeoutMs, 0xF1);
  }

  /**
   * Read a CAN/Tool_R response frame.
   * Frame: 0xFA 0x0D followed by 13 bytes = 15 bytes total.
   * Returns a 13-byte Uint8Array (the payload after the 2-byte header) or null on timeout.
   */
  readCanFrame(timeoutMs = 1000) {
    return this._waitFor((buf) => {
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0xFA && buf[i + 1] === 0x0D) {
          if (buf.length >= i + 15) return i + 14; // end of 15-byte frame
        }
      }
      return -1;
    }, timeoutMs, null);
  }

  // ──────────────────────────────────────────────────────
  //  Internal
  // ──────────────────────────────────────────────────────

  _startLoop() {
    if (!this._port.readable) return;
    const reader = this._port.readable.getReader();
    this._reader = reader;
    this._loop = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const b of value) this._rxBuf.push(b);
          if (this.onDebugRx && value && value.length > 0) this.onDebugRx(new Uint8Array(value));
        }
      } catch { /* port closed / cancelled */ }
    })();
    this._writer = this._port.writable.getWriter();
  }

  async _stopLoop() {
    if (this._reader) {
      try { await this._reader.cancel(); } catch {}
      try { this._reader.releaseLock(); } catch {}
      this._reader = null;
    }
    if (this._loop) { try { await this._loop; } catch {} this._loop = null; }
  }

  /**
   * Poll _rxBuf until `matcher(buf)` returns the inclusive end index,
   * or until timeout. Returns a Uint8Array slice starting from the first
   * occurrence of `startByte` (or from where matcher found), or null.
   */
  _waitFor(matcher, timeoutMs, startByte) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        const endIdx = matcher(this._rxBuf);
        if (endIdx >= 0) {
          // Find start position
          let startIdx = 0;
          if (startByte !== null) {
            startIdx = this._rxBuf.indexOf(startByte);
            if (startIdx < 0) startIdx = 0;
          } else {
            // For CAN: find 0xFA 0x0D
            for (let i = 0; i <= endIdx - 1; i++) {
              if (this._rxBuf[i] === 0xFA && this._rxBuf[i + 1] === 0x0D) {
                startIdx = i + 2; // skip the header
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
