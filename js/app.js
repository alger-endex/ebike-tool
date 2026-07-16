/**
 * app.js — Main application: state, event wiring, serial communication
 *
 * Keyboard shortcuts (same as WinForms original):
 *   Ctrl+E  Engineering mode
 *   Ctrl+U  User mode (hide SIG tab, apply Hidden filter)
 *   Ctrl+P  Show production fields
 *   Ctrl+L  Hide production fields
 *   Ctrl+S  Toggle SIG TextBox editable
 */

// All dependencies loaded via <script> tags in index.html

const APP_VERSION = 'v1.4.12';

// ─────────────────────────────────────────────────────────────
//  Application state
// ─────────────────────────────────────────────────────────────
const state = {
  hrList:   [],   // Array<HRItem>  — parameter definitions + current data
  paraList: [],   // Array<{address, data}>  — comparison file data
  tabList:  [],   // Array<{pageName, pageNum}>
  isCAN:    false,
  engineeringMode: true,
  productionMode:  false,
  showPara:        false,   // cBoxshowpara equivalent
  fileName1: 'N/A',
  fileName2: 'N/A',
  hrListSource:   null,   // null | 'import' | 'read'
  paraListSource: null,   // null | 'import' | 'read'
  dataImport1: [],   // {address,data} — from last import (showPara=false)
  dataImport2: [],   // {address,data} — from last import (showPara=true)
  dataRead:    [],   // {address,data} — from last device read
  paramFileHandle: null,   // FileSystemFileHandle — set when user picks parameter.ini via file picker
  comSerial: new SerialManager(),
  bleSerial: new BleManager(),
  serial:    null,   // active channel — set at boot and on channel change
  busy: false,
};

// ─────────────────────────────────────────────────────────────
//  Logging & progress
// ─────────────────────────────────────────────────────────────
function log(msg) {
  const el = document.getElementById('statusLog');
  el.value += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function setProgress(pct, label = '') {
  document.getElementById('progressBar').style.width   = pct + '%';
  document.getElementById('progressLabel').textContent = label;
}

function setBusy(busy) {
  state.busy = busy;
  ['btnRead', 'btnWrite', 'btnOpen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  });
}

// ─────────────────────────────────────────────────────────────
//  Serial port  ─  Open / Close
// ─────────────────────────────────────────────────────────────
document.getElementById('btnOpen').addEventListener('click', async () => {
  const channel = document.getElementById('selChannel').value;
  const isBle   = channel === 'ble';

  try {
    if (state.serial.isOpen) { log(isBle ? 'BLE 已連線' : '序列埠已開啟'); return; }

    const protocol = document.getElementById('selProtocol').value;
    if (protocol !== 'UART' && protocol !== 'CAN') {
      alert('請選擇通訊方式 (UART 或 CAN)');
      return;
    }

    let baudRate = parseInt(document.getElementById('selBaudrate').value);
    const dataBits = parseInt(document.getElementById('selDataBits').value);
    const stopBits = parseFloat(document.getElementById('selStopBits').value);
    const parity   = document.getElementById('selParity').value;

    if (protocol === 'CAN') {
      const canBaud = baudRate === 9600 ? 460800 : baudRate;
      await state.serial.open({ baudRate: canBaud, dataBits, stopBits, parity });
      if (!isBle) document.getElementById('selBaudrate').value = canBaud.toString();
      state.isCAN = true;
      log(isBle
        ? 'BLE CAN 連線成功！  (ESP32 baud=' + canBaud + ')'
        : 'Set comport to Tool_R OK!  (baud=' + canBaud + ')');
    } else {
      await state.serial.open({ baudRate, dataBits, stopBits, parity });
      state.isCAN = false;
      log(isBle
        ? 'BLE UART 連線成功！  (ESP32 baud=' + baudRate + ')'
        : 'serialPort open success  (baud=' + baudRate + ')');
    }
    setDot(true);
    checkSigProtocolMatch();
  } catch (e) {
    let hint;
    if (isBle) {
      // BleManager.open() 在每個步驟已拋出明確中文訊息
      hint = e.message || ('BLE 連線失敗：' + String(e));
    } else {
      hint = e.message.includes('Failed to open')
        ? '序列埠開啟失敗。\n\n可能原因：\n' +
          '① 序列埠被其他程式佔用（請先關閉 Endex 原始程式或裝置管理員中的連線）\n' +
          '② 裝置未連接或驅動程式未安裝\n' +
          '③ 在同一頁面重複開啟（請先按「關閉」再重試）\n\n' +
          '原始錯誤：' + e.message
        : e.message;
    }
    log('❌ ' + hint);
    alert(hint);
  }
});

document.getElementById('btnClose').addEventListener('click', async () => {
  const isBle = document.getElementById('selChannel').value === 'ble';
  await state.serial.close();
  setDot(false);
  setProgress(0);
  log(isBle ? 'BLE 連線已關閉' : 'SerialPort is closed!');
});

function setDot(connected) {
  const dot = document.getElementById('statusDot');
  dot.classList.toggle('connected',    connected);
  dot.classList.toggle('disconnected', !connected);

  const bleInfo = document.getElementById('bleInfo');
  if (!bleInfo) return;
  if (connected && state.serial === state.bleSerial) {
    const info = state.bleSerial.deviceInfo;
    const name = info.name || 'BLE';
    bleInfo.textContent = name + (info.profile ? '  [' + info.profile + ']' : '');
    bleInfo.style.display = '';
  } else {
    bleInfo.style.display = 'none';
    bleInfo.textContent = '';
  }
}

/** Log whether the loaded SIG matches the selected communication type. */
function checkSigProtocolMatch() {
  const list = state.showPara ? state.paraList : state.hrList;
  if (list.length < 4) return;
  const sig = decodeSig(list);
  if (!sig || sig === '\0\0\0\0\0\0\0\0') return;
  const proto   = document.getElementById('selProtocol').value;
  const sigProto = sigProtocol(sig);
  const match   = proto === sigProto;
  log(`設定${proto}  匯入 "${sig}"  與通訊${match ? '相符' : '不符'}!`);
}

document.getElementById('selProtocol').addEventListener('change', checkSigProtocolMatch);

// ─────────────────────────────────────────────────────────────
//  INI file loading  (auto + manual + localStorage cache)
// ─────────────────────────────────────────────────────────────
const LS_PAGE  = 'endex_page_ini';
const LS_PARAM = 'endex_parameter_ini';
const LS_PARAM_NAME = 'endex_parameter_ini_name';

/** Update the "currently loaded parameter.ini" filename display + cache. */
function setParamIniName(name) {
  localStorage.setItem(LS_PARAM_NAME, name);
  const el = document.getElementById('paramIniName');
  if (el) el.textContent = '📄 ' + name;
}

/**
 * Try to load INI files automatically:
 *  1. fetch('./page.ini') + fetch('./parameter.ini')  — works when served via HTTP
 *  2. Fall back to localStorage cache                 — works after first manual load
 */
async function autoLoadIni() {
  let pageText  = null;
  let paramText = null;

  // ── Step 1: fetch from same directory ──
  try {
    const r = await fetch('./page.ini');
    if (r.ok) { pageText = await r.text(); }
  } catch {}
  try {
    const r = await fetch('./parameter.ini');
    if (r.ok) { paramText = await r.text(); }
  } catch {}
  const paramFromFetch = paramText !== null;

  // ── Step 2: localStorage cache ──
  if (!pageText)  pageText  = localStorage.getItem(LS_PAGE);
  if (!paramText) paramText = localStorage.getItem(LS_PARAM);

  // ── Step 3: apply ──
  const fromCache = !pageText?.startsWith('\n') && localStorage.getItem(LS_PAGE) === pageText;
  if (pageText) {
    state.tabList = parsePageIni(pageText);
    log('page.ini 載入 (' + (fromCache ? '快取' : '檔案') + ') → ' + state.tabList.length + ' 個分頁');
  }
  if (paramText) {
    state.hrList = parseParameterIni(paramText);
    const paramName = paramFromFetch ? 'parameter.ini' : (localStorage.getItem(LS_PARAM_NAME) || 'parameter.ini');
    setParamIniName(paramName);
    log('parameter.ini 載入 (' + (paramFromFetch ? '檔案' : '快取') + ': ' + paramName + ') → ' + state.hrList.length + ' 個參數');
  }
  if (state.tabList.length && state.hrList.length) {
    rebuildTabs();
    updateAutoLoadStatus(true);
  } else {
    updateAutoLoadStatus(false);
  }
}

function updateAutoLoadStatus(ok) {
  const el = document.getElementById('autoLoadStatus');
  if (!el) return;
  if (ok) {
    el.textContent = '✓ INI 已載入';
    el.className = 'auto-status ok';
  } else {
    el.textContent = '⚠ 未找到 INI 檔案';
    el.className = 'auto-status warn';
  }
}

// ── Manual load buttons (also save to localStorage) ──
document.getElementById('btnLoadPageIni').addEventListener('click', () => {
  pickFile('.ini,.txt', async (file) => {
    const text = await file.text();
    localStorage.setItem(LS_PAGE, text);
    state.tabList = parsePageIni(text);
    log('page.ini 載入成功 → ' + state.tabList.length + ' 個分頁  [已存入快取]');
    rebuildTabs();
    updateAutoLoadStatus(state.tabList.length > 0 && state.hrList.length > 0);
  });
});

document.getElementById('btnLoadParamIni').addEventListener('click', async () => {
  if (window.showOpenFilePicker) {
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({
        types: [{ description: 'INI / TXT', accept: { 'text/plain': ['.ini', '.txt'] } }],
        multiple: false,
      });
    } catch (e) {
      if (e.name !== 'AbortError') log('開啟失敗：' + e.message);
      return;
    }
    const file = await handle.getFile();
    const text = await file.text();
    localStorage.setItem(LS_PARAM, text);
    state.hrList = parseParameterIni(text);
    state.paramFileHandle = handle;
    setParamIniName(file.name);
    log('parameter.ini 載入成功 → ' + state.hrList.length + ' 個參數  [已存入快取: ' + file.name + ']');
    rebuildTabs();
    updateAutoLoadStatus(state.tabList.length > 0 && state.hrList.length > 0);
  } else {
    pickFile('.ini,.txt', async (file) => {
      const text = await file.text();
      localStorage.setItem(LS_PARAM, text);
      state.hrList = parseParameterIni(text);
      setParamIniName(file.name);
      log('parameter.ini 載入成功 → ' + state.hrList.length + ' 個參數  [已存入快取: ' + file.name + ']');
      rebuildTabs();
      updateAutoLoadStatus(state.tabList.length > 0 && state.hrList.length > 0);
    });
  }
});

// ── Reload & Clear cache buttons ──
document.getElementById('btnReloadIni').addEventListener('click', () => {
  log('重新載入 INI...');
  autoLoadIni();
});

document.getElementById('btnClearIniCache').addEventListener('click', () => {
  localStorage.removeItem(LS_PAGE);
  localStorage.removeItem(LS_PARAM);
  localStorage.removeItem(LS_PARAM_NAME);
  state.tabList = [];
  state.hrList  = [];
  const el = document.getElementById('paramIniName');
  if (el) el.textContent = '';
  rebuildTabs();
  updateAutoLoadStatus(false);
  log('INI 快取已清除');
});

function rebuildTabs() {
  generateTabs(state, onParamChange, onSetBitClick);
  updateSigDisplay();
  updateSnDisplay();
}

// ─────────────────────────────────────────────────────────────
//  Config import / export
// ─────────────────────────────────────────────────────────────
document.getElementById('btnImport').addEventListener('click', () => {
  pickFile('.txt,.csv', async (file) => {
    const entries = parseConfigTxt(await file.text());
    const found   = new Set();
    const extra   = [];

    if (!state.showPara) state.dataImport1 = [];
    else                 state.dataImport2 = [];

    for (const { address, data } of entries) {
      const item = state.hrList.find(h => h.address === address);
      if (!item) { extra.push(address.toString(16).toUpperCase().padStart(4, '0')); continue; }
      found.add(address);
      if (!state.showPara) {
        item.data = data;
        state.dataImport1.push({ address, data });
      } else {
        const existing = state.paraList.find(p => p.address === address);
        if (existing) existing.data = data;
        else state.paraList.push({ address, data });
        state.dataImport2.push({ address, data });
      }
    }

    const missing = state.hrList
      .filter(h => !found.has(h.address))
      .map(h => h.address.toString(16).toUpperCase().padStart(4, '0'));

    if (!state.showPara) { state.fileName1 = file.name; state.hrListSource   = 'import'; }
    else                 { state.fileName2 = file.name; state.paraListSource = 'import'; }

    updateShowParaLabel();

    if (missing.length) log('缺少地址: ' + missing.join(', '));
    if (extra.length)   log('多餘地址: ' + extra.join(', '));
    log(`匯入完成: ${file.name}`);

    refreshAllDisplays(state);
    updateSigDisplay();
    updateSnDisplay();
    updateSourceDisplay();
    checkSigProtocolMatch();
  });
});

document.getElementById('btnExport').addEventListener('click', async () => {
  const list = state.showPara
    ? state.paraList
    : state.hrList.map(h => ({ address: h.address, data: h.data }));
  if (!list.length) { alert('沒有資料可匯出'); return; }
  const content = serializeConfigTxt(list);
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'CONFIG.txt',
        types: [{ description: 'Config 設定檔', accept: { 'text/plain': ['.txt'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      log('匯出完成：' + handle.name);
    } catch (e) {
      if (e.name !== 'AbortError') log('匯出失敗：' + e.message);
    }
  } else {
    downloadText(content, 'CONFIG.txt');
    log('匯出完成');
  }
});

// Show-Para checkbox
function updateShowParaLabel() {
  const name = state.showPara ? state.fileName2 : state.fileName1;
  document.getElementById('showParaLabel').textContent = name !== 'N/A' ? name : '顯示比較參數';
}

document.getElementById('chkShowPara').addEventListener('change', (e) => {
  state.showPara = e.target.checked;
  updateShowParaLabel();
  refreshAllDisplays(state);
  updateSigDisplay();
  updateSnDisplay();
});

// ─────────────────────────────────────────────────────────────
//  Read parameters from device
// ─────────────────────────────────────────────────────────────
document.getElementById('btnRead').addEventListener('click', async () => {
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return; }
  if (!state.hrList.length)  { alert('請先載入 parameter.ini'); return; }
  if (state.busy) return;

  setBusy(true);
  state.dataRead = [];
  const failed = [];
  const total  = state.hrList.length;
  log('開始讀取...');

  for (let i = 0; i < total; i++) {
    const item = state.hrList[i];
    const data = await retryOp(3, () =>
      state.isCAN ? readCanParam(item.address) : readUartParam(item.address)
    );

    if (data !== null) {
      state.dataRead.push({ address: item.address, data });
      if (!state.showPara) {
        item.data = data;
      } else {
        const p = state.paraList.find(p => p.address === item.address);
        if (p) p.data = data; else state.paraList.push({ address: item.address, data });
      }
    } else {
      failed.push(item.address.toString(16).toUpperCase().padStart(4, '0'));
      log(`  ${item.address.toString(16).toUpperCase().padStart(4, '0')} 無法讀取`);
      if (failed.length >= 10) { log('10 個地址失敗，停止讀取'); break; }
    }

    setProgress(Math.round((i + 1) / total * 100), `${i + 1}/${total}`);
  }

  setProgress(0);
  refreshAllDisplays(state);
  updateSigDisplay();
  updateSnDisplay();

  if (failed.length) log('讀取失敗地址: ' + failed.join(', '));
  else               log('讀取完成');

  if (!state.showPara) state.hrListSource   = 'read';
  else                 state.paraListSource = 'read';
  updateSourceDisplay();
  setBusy(false);
});

// ─────────────────────────────────────────────────────────────
//  Write parameters to device
// ─────────────────────────────────────────────────────────────
document.getElementById('btnWrite').addEventListener('click', async () => {
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return; }
  if (!state.hrList.length)  { alert('請先載入 parameter.ini'); return; }
  if (state.busy) return;

  setBusy(true);

  // ── 寫入前驗證：讀取裝置 SIG0~SIG3 與本機比對 ──────────────
  if (state.hrList.length >= 4) {
    log('驗證裝置 SIG...');
    const devSigItems = [];
    for (let i = 0; i < 4; i++) {
      const val = await retryOp(3, () =>
        state.isCAN
          ? readCanParam(state.hrList[i].address)
          : readUartParam(state.hrList[i].address)
      );
      if (val === null || val === false) {
        log('❌ SIG' + i + ' 讀取失敗，中止寫入');
        setBusy(false);
        return;
      }
      devSigItems.push({ data: val });
    }
    const devSig   = decodeSig(devSigItems);
    const sigSource = (state.showPara && state.paraList.length >= 4) ? state.paraList : state.hrList;
    const localSig = decodeSig(sigSource);
    if (devSig !== localSig) {
      log('❌ SIG 不符：裝置="' + devSig + '"  本機="' + localSig + '"，中止寫入');
      setBusy(false);
      return;
    }
    log('✅ SIG 驗證通過 "' + localSig + '"');
  }
  // ────────────────────────────────────────────────────────────

  // 決定寫入來源清單
  // UART skips first 4 items (SIG), CAN writes all
  const startIdx = state.isCAN ? 0 : 4;
  const countWritable = (lst) => lst.slice(startIdx).filter(item => {
    const hr = state.hrList.find(h => h.address === item.address);
    return !hr?.production && item.address > 0x0020;
  }).length;

  const filterNote = state.isCAN
    ? '※ 可寫入已排除：address ≤ 0x0020、production 參數'
    : '※ 可寫入已排除：SIG/SIN 序號（前 4 筆）、address ≤ 0x0020、production 參數';

  let list = state.showPara ? state.paraList : state.hrList;
  if (state.showPara && state.paraList.length !== state.hrList.length) {
    const wLocal  = countWritable(state.hrList);
    const wImport = countWritable(state.paraList);
    const useLocal = confirm(
      `匯入 Config 有 ${state.paraList.length} 個參數，本機有 ${state.hrList.length} 個參數。\n\n` +
      `確定 → 本機（${state.hrList.length} 個，可寫入 ${wLocal} 個）\n` +
      `取消 → 匯入 Config（${state.paraList.length} 個，可寫入 ${wImport} 個）\n\n` +
      filterNote
    );
    list = useLocal ? state.hrList : state.paraList;
    log('寫入來源：' + (useLocal ? `本機 (${state.hrList.length} 個，可寫入 ${wLocal} 個)` : `匯入 Config (${state.paraList.length} 個，可寫入 ${wImport} 個)`));
  }
  const failed   = [];
  let   count    = 0;

  // 預先過濾實際寫入清單（排除 production 與唯讀地址 ≤ 0x0020）
  const writeItems = list.slice(startIdx).filter(item => {
    const hrItem = state.hrList.find(h => h.address === item.address);
    if (hrItem?.production) return false;
    if (item.address <= 0x0020) return false;
    return true;
  });
  const total = writeItems.length;
  log('開始寫入... 共 ' + total + ' 個參數');

  for (const item of writeItems) {
    const hrItem  = state.hrList.find(h => h.address === item.address);
    const addrHex = item.address.toString(16).toUpperCase().padStart(4, '0');
    const name    = hrItem?.name ?? '';

    const ok = await retryOp(3, () =>
      state.isCAN
        ? writeCanParam(item.address, item.data)
        : writeUartParam(item.address, item.data)
    );

    log(`  [${addrHex}] ${name} = ${item.data}  ${ok ? '✓' : '✗'}`);

    if (!ok) {
      failed.push(addrHex);
      if (failed.length >= 10) { log('10 個地址失敗，停止寫入'); break; }
    }

    count++;
    setProgress(Math.round(count / total * 100), `${count}/${total}`);
  }

  // Save command
  try {
    if (state.isCAN) {
      state.serial.clearBuffer();
      await state.serial.write(buildCanSave());
      await sleep(10);
      const sr = await state.serial.readCanFrame(1000);
      const sp = sr ? parseCanResponse(sr) : null;
      log(sp?.data[1] !== 0x86 ? 'SAVE ok' : 'SAVE Err');

      state.serial.clearBuffer();
      await state.serial.write(buildCanReload());
      await sleep(10);
      const rr = await state.serial.readCanFrame(1000);
      const rp = rr ? parseCanResponse(rr) : null;
      log(rp?.data[1] !== 0x86 ? 'reLoad ok' : 'reLoad Err');

      await sleep(1000);
      const saveCheck = await readCanParam(0x0555);
      log(saveCheck === 0 ? 'Save 成功' : 'Save 失敗');
    } else {
      state.serial.clearBuffer();
      await state.serial.write(buildUartSave());

      await sleep(1000);
      const saveCheck = await readUartParam(0x0555);
      log(saveCheck === 0 ? 'Save 成功' : 'Save 失敗');
    }
  } catch (e) {
    log('儲存指令異常: ' + e.message);
  }

  setProgress(0);
  if (failed.length) log('寫入失敗: ' + failed.join(', '));
  else               log('寫入完成');
  setBusy(false);
});

// ─────────────────────────────────────────────────────────────
//  Low-level read / write helpers
// ─────────────────────────────────────────────────────────────
async function readUartParam(address) {
  state.serial.clearBuffer();
  await state.serial.write(buildUartRead(address));
  const frame = await state.serial.readUartFrame(1000);
  if (!frame) return null;
  const r = parseUartResponse(frame);
  return r.error ? null : r.data;
}

async function readCanParam(address) {
  state.serial.clearBuffer();
  await state.serial.write(buildCanRead(address));
  await sleep(10);
  const frame = await state.serial.readCanFrame(1000);
  if (!frame) return null;
  const r = parseCanResponse(frame);
  if (!r || r.id !== 0x01005020) return null;
  if (r.data[1] === 0x83) return null;
  return (r.data[4] << 8) | r.data[5];
}

async function writeUartParam(address, data) {
  state.serial.clearBuffer();
  await state.serial.write(buildUartWrite(address, data & 0xFFFF));
  const frame = await state.serial.readUartFrame(1000);
  if (!frame) return false;
  const r = parseUartResponse(frame);
  return !r.error;
}

async function writeCanParam(address, data) {
  state.serial.clearBuffer();
  await state.serial.write(buildCanWrite(address, data & 0xFFFF));
  await sleep(10);
  const frame = await state.serial.readCanFrame(1000);
  if (!frame) return false;
  const r = parseCanResponse(frame);
  return r?.id === 0x01005020 && r.data[1] !== 0x86;
}

async function retryOp(maxRetries, fn) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await fn();
      if (result !== null && result !== false) return result;
      if (result === false) {
        // write returned false — still retry
      }
    } catch {}
    await sleep(15);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
//  SIG / SN display + editing
// ─────────────────────────────────────────────────────────────
function updateSourceDisplay() {
  const labels = { null: '—', import: '匯入 Config', read: '讀取參數' };
  document.getElementById('hrListSrc').textContent   = labels[state.hrListSource]   ?? '—';
  document.getElementById('paraListSrc').textContent = labels[state.paraListSource] ?? '—';
}

function updateSigDisplay() {
  const list = state.showPara ? state.paraList : state.hrList;
  const sig  = decodeSig(list);
  const el   = document.getElementById('tboxSIG');
  if (document.activeElement !== el) el.value = sig;
}

function updateSnDisplay() {
  const list = state.showPara ? state.paraList : state.hrList;
  const sn   = decodeSn(list);
  const el   = document.getElementById('tboxSN');
  if (document.activeElement !== el) el.value = sn;
}

function writeSigToList(sigStr) {
  const vals = encodeSig(sigStr);
  if (!vals) return;
  const list = state.showPara ? state.paraList : state.hrList;
  for (let i = 0; i < 4; i++) {
    const target = list.find(h => h.address === state.hrList[i]?.address);
    if (target) target.data = vals[i];
    if (!state.showPara) state.hrList[i].data = vals[i];
  }
  refreshAllDisplays(state);
}

function writeSnToList(snStr) {
  const vals = encodeSn(snStr);
  if (!vals) return;
  const list = state.showPara ? state.paraList : state.hrList;
  for (let i = 0; i < 8; i++) {
    const addr = state.hrList[4 + i]?.address;
    if (addr === undefined) continue;
    const target = list.find(h => h.address === addr);
    if (target) target.data = vals[i];
    if (!state.showPara) state.hrList[4 + i].data = vals[i];
  }
  refreshAllDisplays(state);
  updateSnDisplay();
}

document.getElementById('tboxSIG').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim();
  if (v.length !== 8) { log('SIG 必須為 8 個字元 (A-Z 0-9)'); return; }
  if (!/^[A-Z0-9]{8}$/i.test(v)) { log('格式錯誤：請輸入 A-Z 或 0-9'); return; }
  writeSigToList(v.toUpperCase());
  log(`${v} SIG 輸入!`);
});

document.getElementById('tboxSN').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = e.target.value;
  if (v.length !== 16) { log('SN 必須為 16 個字元'); return; }
  writeSnToList(v);
  log('SN 輸入完成');
});

// Production sub-fields
['Place','ToolNo','Person','Date','SerialNo'].forEach(field => {
  const el = document.getElementById('tbox' + field);
  if (!el) return;
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const key = field.charAt(0).toLowerCase() + field.slice(1);
    const { len } = SN_LAYOUT[key];
    if (el.value.length !== len) {
      log(`❌ ${field} 輸入錯誤：需為 ${len} 個字元（目前 ${el.value.length} 個）`);
      return;
    }
    if (field === 'Date' && !isValidDate(el.value)) { log('❌ 日期格式錯誤 (YYMMDD)'); return; }
    const snEl  = document.getElementById('tboxSN');
    const snStr = (snEl.value || '').padEnd(16, '\0').slice(0, 16);
    const newSn = snSetField(snStr, key, el.value);
    snEl.value  = newSn;
    writeSnToList(newSn);
    log(`✅ ${field} 輸入完成 → "${el.value}"`);
  });
});

function isValidDate(s) {
  if (!/^\d{6}$/.test(s)) return false;
  const y = 2000 + parseInt(s.slice(0, 2));
  const m = parseInt(s.slice(2, 4));
  const d = parseInt(s.slice(4, 6));
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= new Date(y, m, 0).getDate();
}

// ─────────────────────────────────────────────────────────────
//  SetBit handler (called from ui.js callback)
// ─────────────────────────────────────────────────────────────
async function onSetBitClick(idx) {
  const item = state.hrList[idx];
  if (!item) return;
  const newVal = await openSetbitModal(item);
  if (newVal === null) return;
  item.data = newVal;
  if (state.showPara) {
    const p = state.paraList.find(p => p.address === item.address);
    if (p) p.data = newVal;
  }
  refreshParamDisplay(item);
}

function onParamChange(idx, val) {
  // If showPara mode, also update paraList
  if (state.showPara) {
    const item = state.hrList[idx];
    const p    = state.paraList.find(p => p.address === item.address);
    if (p) p.data = val;
  }
}

// ─────────────────────────────────────────────────────────────
//  Diff comparison
// ─────────────────────────────────────────────────────────────
document.getElementById('btnDiff').addEventListener('click', () => {
  if (!state.hrList.length) { alert('請先載入 parameter.ini'); return; }
  const srcCount = [state.dataImport1, state.dataImport2, state.dataRead].filter(a => a.length > 0).length;
  if (srcCount < 2) {
    alert('需要至少 2 個資料來源才能比對。\n\n可用來源：\n' +
      '• 匯入資料1 — 匯入 Config（不勾選「顯示比較參數」）\n' +
      '• 匯入資料2 — 勾選「顯示比較參數」後再匯入第二個 Config\n' +
      '• 讀取參數資料 — 點「讀取參數」從裝置取得');
    return;
  }
  openDiffModal();
});

// ── Diff source helpers ──
function getDiffSourceData(key) {
  switch (key) {
    case 'import1': return state.dataImport1;
    case 'import2': return state.dataImport2;
    case 'read':    return state.dataRead;
    default:        return [];
  }
}

function getDiffSourceLabel(key) {
  switch (key) {
    case 'import1': return state.fileName1 !== 'N/A' ? state.fileName1 : '匯入資料1';
    case 'import2': return state.fileName2 !== 'N/A' ? state.fileName2 : '匯入資料2';
    case 'read':    return '讀取參數資料';
    default:        return key;
  }
}

// Track active source keys (persists between modal opens)
let diffSrcAKey = 'import1';
let diffSrcBKey = 'read';

function openDiffModal() {
  const selA = document.getElementById('diffSrcA');
  const selB = document.getElementById('diffSrcB');

  function makeOptions(curKey) {
    return ['import1', 'import2', 'read'].map(k => {
      const lbl   = getDiffSourceLabel(k);
      const empty = getDiffSourceData(k).length === 0;
      return `<option value="${k}"${k === curKey ? ' selected' : ''}${empty ? ' disabled' : ''}>${lbl}${empty ? ' (空)' : ''}</option>`;
    }).join('');
  }

  selA.innerHTML = makeOptions(diffSrcAKey);
  selB.innerHTML = makeOptions(diffSrcBKey);

  // Ensure selected keys are valid (have data)
  const avail = ['import1', 'import2', 'read'].filter(k => getDiffSourceData(k).length > 0);
  if (!getDiffSourceData(diffSrcAKey).length) diffSrcAKey = avail[0] || 'import1';
  if (!getDiffSourceData(diffSrcBKey).length || diffSrcBKey === diffSrcAKey)
    diffSrcBKey = avail.find(k => k !== diffSrcAKey) || avail[1] || 'read';
  selA.value = diffSrcAKey;
  selB.value = diffSrcBKey;

  let currentRows = [];

  function rediff() {
    diffSrcAKey = selA.value;
    diffSrcBKey = selB.value;
    currentRows = buildDiffRows(diffSrcAKey, diffSrcBKey);
    renderDiffSummary(currentRows, diffSrcAKey, diffSrcBKey);
    document.querySelectorAll('.diff-filter').forEach(b => b.classList.remove('active'));
    document.querySelector('.diff-filter[data-filter="all"]').classList.add('active');
    renderDiffTable(currentRows, 'all', diffSrcAKey, diffSrcBKey);
  }

  selA.onchange = selB.onchange = rediff;
  rediff();

  document.getElementById('modalDiff').style.display = 'flex';

  document.querySelectorAll('.diff-filter').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.diff-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderDiffTable(currentRows, btn.dataset.filter, diffSrcAKey, diffSrcBKey);
    };
  });
}

/** Build comparison rows between two named data sources (A = left, B = right). */
function buildDiffRows(srcAKey, srcBKey) {
  const mapA = new Map(getDiffSourceData(srcAKey).map(p => [p.address, p.data]));
  const mapB = new Map(getDiffSourceData(srcBKey).map(p => [p.address, p.data]));
  const allAddrs = new Set([...mapA.keys(), ...mapB.keys()]);
  const rows = [];

  for (const addr of allAddrs) {
    const item = state.hrList.find(h => h.address === addr);
    const name = item ? item.name : '(未定義)';
    const hasA = mapA.has(addr), hasB = mapB.has(addr);
    if (hasA && hasB) {
      const vA = mapA.get(addr), vB = mapB.get(addr);
      rows.push({ address: addr, name, val1: vA, val2: vB, type: vA === vB ? 'same' : 'diff' });
    } else {
      rows.push({ address: addr, name, val1: hasA ? mapA.get(addr) : null, val2: hasB ? mapB.get(addr) : null, type: 'miss' });
    }
  }
  rows.sort((a, b) => a.address - b.address);
  return rows;
}

function renderDiffSummary(rows, srcAKey, srcBKey) {
  const diffCnt = rows.filter(r => r.type === 'diff').length;
  const sameCnt = rows.filter(r => r.type === 'same').length;
  const missCnt = rows.filter(r => r.type === 'miss').length;
  const labelA  = getDiffSourceLabel(srcAKey);
  const labelB  = getDiffSourceLabel(srcBKey);
  document.getElementById('diffSummary').innerHTML =
    '<span class="diff-chip total">共 ' + rows.length + ' 個</span>' +
    '<span class="diff-chip diff">差異 ' + diffCnt + ' 個</span>' +
    '<span class="diff-chip same">相同 ' + sameCnt + ' 個</span>' +
    (missCnt ? '<span class="diff-chip miss">缺少 ' + missCnt + ' 個</span>' : '') +
    '<span style="margin-left:8px;font-size:11px;color:var(--text-dim)">【' + labelA + '】vs【' + labelB + '】</span>';
}

function renderDiffTable(rows, filter, srcAKey, srcBKey) {
  const wrap = document.getElementById('diffTableWrap');
  const visible = filter === 'all'  ? rows :
                  filter === 'diff' ? rows.filter(r => r.type === 'diff') :
                  filter === 'same' ? rows.filter(r => r.type === 'same') :
                  rows.filter(r => r.type === 'miss');

  if (!visible.length) {
    wrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">無符合條件的項目</div>';
    return;
  }

  const labelA = getDiffSourceLabel(srcAKey);
  const labelB = getDiffSourceLabel(srcBKey);
  const table  = document.createElement('table');
  table.className = 'cfg-table diff-table';
  table.innerHTML =
    '<thead><tr>' +
    '<th style="width:70px">地址</th>' +
    '<th style="width:150px">名稱</th>' +
    '<th style="width:110px">' + labelA + '</th>' +
    '<th style="width:110px">' + labelB + '</th>' +
    '<th style="width:80px">差值 (Δ)</th>' +
    '<th style="width:60px">狀態</th>' +
    '</tr></thead>';

  const tbody = document.createElement('tbody');
  for (const r of visible) {
    const tr = document.createElement('tr');
    tr.className = 'row-' + r.type;
    const addrHex = '0x' + r.address.toString(16).toUpperCase().padStart(4, '0');
    const vAStr = r.val1 !== null ? r.val1 + ' (0x' + (r.val1 & 0xFFFF).toString(16).toUpperCase().padStart(4,'0') + ')' : '—';
    const vBStr = r.val2 !== null ? r.val2 + ' (0x' + (r.val2 & 0xFFFF).toString(16).toUpperCase().padStart(4,'0') + ')' : '—';
    let delta = '—', deltaClass = '';
    if (r.val1 !== null && r.val2 !== null && r.type === 'diff') {
      const d = r.val1 - r.val2;
      delta = (d > 0 ? '+' : '') + d;
      deltaClass = d > 0 ? 'pos' : 'neg';
    }
    const statusIcon = r.type === 'diff' ? '✗ 差異' : r.type === 'same' ? '✓ 相同' : '⚠ 缺少';
    const colClass   = r.type === 'diff' ? 'col-diff-val' : 'col-same-val';
    tr.innerHTML =
      '<td style="font-family:var(--mono)">' + addrHex + '</td>' +
      '<td>' + r.name + '</td>' +
      '<td class="' + colClass + '">' + vAStr + '</td>' +
      '<td class="' + colClass + '">' + vBStr + '</td>' +
      '<td class="col-delta ' + deltaClass + '">' + delta + '</td>' +
      '<td>' + statusIcon + '</td>';
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);
}

// Export diff report
document.getElementById('btnDiffExport').addEventListener('click', () => {
  const rows     = buildDiffRows(diffSrcAKey, diffSrcBKey);
  const diffRows = rows.filter(r => r.type === 'diff');
  const labelA   = getDiffSourceLabel(diffSrcAKey);
  const labelB   = getDiffSourceLabel(diffSrcBKey);
  let txt = '比對差異報告\n';
  txt += '比較: 【' + labelA + '】vs【' + labelB + '】\n';
  txt += '時間: ' + new Date().toLocaleString() + '\n';
  txt += '共 ' + rows.length + ' 個參數，差異 ' + diffRows.length + ' 個，相同 ' + rows.filter(r=>r.type==='same').length + ' 個\n';
  txt += '─'.repeat(80) + '\n';
  txt += '地址      名稱                           ' + labelA.slice(0,12).padEnd(12) + labelB.slice(0,12).padEnd(12) + '差值\n';
  txt += '─'.repeat(80) + '\n';
  for (const r of diffRows) {
    const addr = '0x' + r.address.toString(16).toUpperCase().padStart(4,'0');
    const d = (r.val1 ?? 0) - (r.val2 ?? 0);
    txt += addr.padEnd(10) + r.name.padEnd(35) +
           String(r.val1 ?? '—').padEnd(12) + String(r.val2 ?? '—').padEnd(12) +
           (d > 0 ? '+' : '') + d + '\n';
  }
  if (!diffRows.length) txt += '（無差異）\n';
  downloadText(txt, 'diff_report.txt');
});

// Close diff modal
document.querySelectorAll('[data-close="modalDiff"]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('modalDiff').style.display = 'none';
  });
});

// ─────────────────────────────────────────────────────────────
//  Config editor
// ─────────────────────────────────────────────────────────────
document.getElementById('btnConfig').addEventListener('click', async () => {
  const updated = await openConfigModal(state.hrList);
  if (!updated) return;
  // Preserve runtime .data values that weren't in the editor
  updated.forEach(newItem => {
    const old = state.hrList.find(h => h.address === newItem.address);
    if (old) newItem.data = old.data;
  });
  state.hrList = updated;
  const iniText = serializeParameterIni(updated);
  localStorage.setItem(LS_PARAM, iniText);
  if (state.paramFileHandle) {
    try {
      const writable = await state.paramFileHandle.createWritable();
      await writable.write(iniText);
      await writable.close();
      log('parameter.ini 已更新並儲存：' + state.paramFileHandle.name);
    } catch {
      state.paramFileHandle = null;
      await saveParamWithPicker(iniText);
    }
  } else {
    await saveParamWithPicker(iniText);
  }
  rebuildTabs();
});

// ─────────────────────────────────────────────────────────────
//  Keyboard shortcuts
// ─────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return;
  switch (e.key.toUpperCase()) {
    case 'E':
      e.preventDefault();
      state.engineeringMode = true;
      document.getElementById('modeBadge').textContent = 'Engineering';
      document.getElementById('modeBadge').className   = 'mode-badge';
      document.getElementById('engSection').style.display = '';
      rebuildTabs();
      break;
    case 'U':
      e.preventDefault();
      state.engineeringMode = false;
      document.getElementById('modeBadge').textContent = 'User';
      document.getElementById('modeBadge').className   = 'mode-badge user-mode';
      rebuildTabs();
      break;
    case 'P':
      e.preventDefault();
      state.productionMode = true;
      document.getElementById('prodSection').style.display = '';
      document.getElementById('tboxSN').disabled = false;
      break;
    case 'L':
      e.preventDefault();
      state.productionMode = false;
      document.getElementById('prodSection').style.display = 'none';
      document.getElementById('tboxSN').disabled = true;
      break;
    case 'S':
      e.preventDefault();
      const sigEl = document.getElementById('tboxSIG');
      sigEl.readOnly = !sigEl.readOnly;
      sigEl.style.opacity = sigEl.readOnly ? '.5' : '1';
      break;
    case 'D':
      e.preventDefault();
      toggleDebugMode();
      break;
  }
});

// ─────────────────────────────────────────────────────────────
//  Utility helpers
// ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pickFile(accept, callback) {
  const inp  = document.createElement('input');
  inp.type   = 'file';
  inp.accept = accept;
  inp.onchange = (e) => { if (e.target.files[0]) callback(e.target.files[0]); };
  inp.click();
}

async function saveParamWithPicker(iniText) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'parameter.ini',
        types: [{ description: 'INI 設定檔', accept: { 'text/plain': ['.ini'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(iniText);
      await writable.close();
      state.paramFileHandle = handle;
      setParamIniName(handle.name);
      log('parameter.ini 已更新並儲存：' + handle.name);
    } catch (e) {
      if (e.name !== 'AbortError') log('儲存失敗：' + e.message);
    }
  } else {
    downloadText(iniText, 'parameter.ini');
    log('parameter.ini 已更新並下載');
  }
}

function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────
//  Debug mode
// ─────────────────────────────────────────────────────────────
let debugEnabled = false;
const MAX_DEBUG_ROWS = 500;

function toggleDebugMode() {
  debugEnabled = !debugEnabled;
  const btn   = document.getElementById('btnDebugToggle');
  const badge = document.getElementById('debugBadge');
  if (debugEnabled) {
    btn.textContent = 'Debug ON';
    btn.className   = 'btn-tiny debug-on';
    badge.style.display = '';
    state.serial.onDebugTx = (bytes) => appendDebugRow('TX', bytes);
    state.serial.onDebugRx = (bytes) => appendDebugRow('RX', bytes);
    // Auto-switch to debug tab
    switchLogTab('debugPanel');
    log('Debug 模式已開啟');
  } else {
    btn.textContent = 'Debug OFF';
    btn.className   = 'btn-tiny debug-off';
    badge.style.display = 'none';
    state.serial.onDebugTx = null;
    state.serial.onDebugRx = null;
    log('Debug 模式已關閉');
  }
}

function appendDebugRow(dir, bytes) {
  const log  = document.getElementById('debugLog');
  if (!log) return;

  // Auto-limit rows
  while (log.children.length >= MAX_DEBUG_ROWS) log.removeChild(log.firstChild);

  const now  = new Date();
  const ts   = now.getHours().toString().padStart(2,'0') + ':' +
               now.getMinutes().toString().padStart(2,'0') + ':' +
               now.getSeconds().toString().padStart(2,'0') + '.' +
               now.getMilliseconds().toString().padStart(3,'0');

  const hex  = Array.from(bytes)
    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');

  // Printable ASCII (. for non-printable)
  const ascii = Array.from(bytes)
    .map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.')
    .join('');

  const row  = document.createElement('div');
  row.className = 'debug-row';

  const tsEl  = document.createElement('span');
  tsEl.className   = 'debug-ts';
  tsEl.textContent = ts;

  const dirEl = document.createElement('span');
  dirEl.className   = 'debug-dir ' + dir.toLowerCase();
  dirEl.textContent = dir;

  const lenEl = document.createElement('span');
  lenEl.className   = 'debug-len';
  lenEl.textContent = bytes.length + 'B';

  const hexEl = document.createElement('span');
  hexEl.className   = 'debug-hex';
  hexEl.textContent = hex;

  const asciiEl = document.createElement('span');
  asciiEl.className   = 'debug-ascii';
  asciiEl.textContent = ascii;

  row.appendChild(tsEl);
  row.appendChild(dirEl);
  row.appendChild(lenEl);
  row.appendChild(hexEl);
  row.appendChild(asciiEl);
  log.appendChild(row);

  // Auto-scroll if near bottom
  const panel = document.getElementById('debugPanel');
  if (panel && panel.style.display !== 'none') {
    const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 60;
    if (atBottom) panel.scrollTop = panel.scrollHeight;
  }
}

// ── Log / Debug tab switching ──
function switchLogTab(panelId) {
  ['statusLog', 'debugPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (id === panelId) ? '' : 'none';
  });
  document.querySelectorAll('.log-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === panelId);
  });
}

document.querySelectorAll('.log-tab').forEach(btn => {
  btn.addEventListener('click', () => switchLogTab(btn.dataset.panel));
});

document.getElementById('btnDebugToggle').addEventListener('click', toggleDebugMode);

document.getElementById('btnClearLog').addEventListener('click', () => {
  const active = document.querySelector('.log-tab.active');
  if (active && active.dataset.panel === 'debugPanel') {
    const dl = document.getElementById('debugLog');
    if (dl) dl.innerHTML = '';
  } else {
    document.getElementById('statusLog').value = '';
  }
});

// ── 狀態記錄區塊 收合切換 ──
(function () {
  const bar   = document.querySelector('.statusbar');
  const btn   = document.getElementById('btnLogToggle');
  const LS_KEY = 'endex_statuslog_collapsed';

  function setCollapsed(collapsed) {
    bar.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('log-collapsed', collapsed);
    btn.textContent = collapsed ? '▴' : '▾';
    btn.title = collapsed ? '展開狀態記錄區塊' : '收合狀態記錄區塊';
    localStorage.setItem(LS_KEY, collapsed ? '1' : '');
  }

  setCollapsed(!!localStorage.getItem(LS_KEY));
  btn.addEventListener('click', () => setCollapsed(!bar.classList.contains('collapsed')));
})();

// ─────────────────────────────────────────────────────────────
//  Driver Status — real-time CAN monitoring
// ─────────────────────────────────────────────────────────────
let drvMonitorActive = false;
let drvMonitorTimer  = null;
const drvCurrentLog  = [];   // {ts, val} for log checkbox

document.getElementById('btnDriverStatus').addEventListener('click', () => {
  if (!state.isCAN) { alert('Driver Status 僅支援 CAN 模式\n請先選擇 CAN 並開啟序列埠'); return; }
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return; }
  document.getElementById('modalDriverStatus').style.display = 'flex';
});

document.getElementById('btnDrvMonitor').addEventListener('click', () => {
  drvMonitorActive ? stopDrvMonitor() : startDrvMonitor();
});

document.querySelectorAll('[data-close="modalDriverStatus"]').forEach(btn => {
  btn.addEventListener('click', () => {
    stopDrvMonitor();
    document.getElementById('modalDriverStatus').style.display = 'none';
  });
});

function startDrvMonitor() {
  drvMonitorActive = true;
  const btn = document.getElementById('btnDrvMonitor');
  btn.textContent = '⏹ 停止監控';
  btn.classList.remove('btn-action');
  btn.classList.add('btn-danger');
  drvCurrentLog.length = 0;
  log('Driver Status 監控已開啟');
  drvMonitorLoop();
}

function stopDrvMonitor() {
  drvMonitorActive = false;
  if (drvMonitorTimer) { clearTimeout(drvMonitorTimer); drvMonitorTimer = null; }
  const btn = document.getElementById('btnDrvMonitor');
  btn.textContent = '▶ 開始監控';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-action');
  if (drvCurrentLog.length > 1) log('電流 Log: ' + drvCurrentLog.length + ' 筆已記錄');
}

async function drvMonitorLoop() {
  if (!drvMonitorActive) return;
  await drvMonitorTick();
  if (drvMonitorActive) drvMonitorTimer = setTimeout(drvMonitorLoop, 300);
}

async function drvMonitorTick() {
  if (!state.serial.isOpen) { stopDrvMonitor(); return; }
  const pushAssist = document.getElementById('chkPushAssist').checked;
  try {
    // ── 1. Start command ──
    await state.serial.write(buildDrvStartCmd(pushAssist));
    await sleep(5);

    // ── 2. Fault Register ──
    state.serial.clearBuffer();
    await state.serial.write(buildDrvFaultReq());
    await sleep(10);
    const faultFrame = await state.serial.readCanFrame(300);
    if (faultFrame) {
      const r = parseCanResponse(faultFrame);
      if (r && r.id === DRV_RX_FAULT && r.len >= 6) drvUpdateFault(r.data);
    }

    // ── 3. Status + Speed/Current/Voltage ──
    state.serial.clearBuffer();
    await state.serial.write(buildDrvStatusReq());
    await sleep(10);
    const statusFrame = await state.serial.readCanFrame(300);
    if (statusFrame) {
      const r = parseCanResponse(statusFrame);
      if (r && r.id === DRV_RX_STATUS && r.len >= 8) drvUpdateStatus(r.data);
    }

    // ── 4. Assist / Pedal ──
    state.serial.clearBuffer();
    await state.serial.write(buildDrvAssistReq());
    await sleep(10);
    const assistFrame = await state.serial.readCanFrame(300);
    if (assistFrame) {
      const r = parseCanResponse(assistFrame);
      if (r && r.id === DRV_RX_ASSIST && r.len >= 8) drvUpdateAssist(r.data);
    }

    // ── 5. Trip / Distance ──
    state.serial.clearBuffer();
    await state.serial.write(buildDrvDistanceReq());
    await sleep(10);
    const distFrame = await state.serial.readCanFrame(300);
    if (distFrame) {
      const r = parseCanResponse(distFrame);
      if (r && r.id === DRV_RX_DISTANCE && r.len >= 6) drvUpdateDistance(r.data);
    }
  } catch { /* ignore serial errors during monitoring */ }
}

// ── Update helpers ──
function drvSet(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

function drvUpdateFault(d) {
  const faultRag = (d[0] | (d[1] << 8)) >>> 0;
  drvSet('drvDriverTemp', (d[4] - 40) + ' °C');
  drvSet('drvMotorTemp',  (d[5] - 40) + ' °C');
  drvUpdateBits('drvFault', faultRag);
  drvUpdateBits('drvDRV',   faultRag);  // original uses fault_rag for DRV too
}

function drvUpdateStatus(d) {
  const bikeSpeed    = ((d[2] | (d[3] << 8)) * 0.1).toFixed(1);
  const driveCurrent = ((d[4] | (d[5] << 8)) * 0.1).toFixed(1);
  const driveVoltage = ((d[6] | (d[7] << 8)) * 0.1).toFixed(1);
  drvSet('drvBikeSpeed',    bikeSpeed);
  drvSet('drvDriveCurrent', driveCurrent);
  drvSet('drvDriveVoltage', driveVoltage);
  drvUpdateBits('drvStatus',    d[0]);
  drvUpdateBits('drvPepherial', d[1]);
  if (document.getElementById('chkDrvLog').checked) {
    drvCurrentLog.push({ ts: Date.now(), val: parseFloat(driveCurrent) });
    drvUpdateLogCount();
  }
}

function drvUpdateAssist(d) {
  drvSet('drvTotalAssist',   d[0]);
  drvSet('drvAssistLevel',   d[1]);
  drvSet('drvPedalTorque',  ((d[2] | (d[3] << 8)) * 0.1).toFixed(1));
  drvSet('drvPedalCadence',  d[4]);
  drvSet('drvPedalPower',    d[5] | (d[6] << 8));
  drvSet('drvMotorPhaseCurr', d[7]);
}

function drvUpdateDistance(d) {
  drvSet('drvSingleTrip',  ((d[0] | (d[1] << 8)) * 0.1).toFixed(1));
  drvSet('drvRemainDist',  ((d[2] | (d[3] << 8)) * 0.1).toFixed(1));
}

function drvUpdateBits(containerId, regVal) {
  const inds = document.querySelectorAll('#' + containerId + ' .drv-bit-ind');
  inds.forEach((ind, i) => ind.classList.toggle('on', ((regVal >> i) & 1) === 1));
}

function drvUpdateLogCount() {
  const n = drvCurrentLog.length;
  const countEl  = document.getElementById('drvLogCount');
  const exportBtn = document.getElementById('btnDrvLogExport');
  if (countEl)  countEl.textContent = n + ' 筆';
  if (exportBtn) exportBtn.disabled = n === 0;
}

document.getElementById('btnDrvLogExport').addEventListener('click', () => {
  if (!drvCurrentLog.length) return;
  const t0 = drvCurrentLog[0].ts;
  let csv = '時間(ms),相對時間(s),Drive Current(A)\r\n';
  for (const row of drvCurrentLog) {
    const rel = ((row.ts - t0) / 1000).toFixed(3);
    csv += row.ts + ',' + rel + ',' + row.val + '\r\n';
  }
  const ts = new Date().toISOString().slice(0,19).replace(/[T:]/g, '-');
  downloadText(csv, 'drive_current_' + ts + '.csv');
  log('電流 Log 已下載，共 ' + drvCurrentLog.length + ' 筆');
});

// ─────────────────────────────────────────────────────────────
//  Motor Calibration  (CAN only)
// ─────────────────────────────────────────────────────────────
let calRunning = false;

document.getElementById('btnCalibrate').addEventListener('click', () => {
  if (!state.isCAN) { alert('馬達校正僅支援 CAN 模式\n請先選擇 CAN 並開啟序列埠'); return; }
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return; }
  document.getElementById('modalCalibrate').style.display = 'flex';
});

// Standalone sidebar action — sends just the CAN ID 0x141030FF /
// [00,00,00,5A,00,00,00,00] frame on its own, independent of the automatic
// enable→start→poll flow in runCalibration() below.
document.getElementById('btnCalTrigger').addEventListener('click', async () => {
  if (!state.isCAN) { alert('僅支援 CAN 模式\n請先選擇 CAN 並開啟序列埠'); return; }
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return; }
  try {
    await state.serial.write(buildCalEnableCmd());
    log('已送出觸發訊框 (CAN ID 0x141030FF)');
  } catch (e) {
    log('觸發訊框送出失敗: ' + e.message);
  }
});

document.querySelectorAll('[data-close="modalCalibrate"]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('modalCalibrate').style.display = 'none';
  });
});

document.getElementById('btnCalStart').addEventListener('click', runCalibration);

function setCalProgress(pct, label = '') {
  document.getElementById('calProgressBar').style.width   = pct + '%';
  document.getElementById('calProgressLabel').textContent = label;
}

// Writes to the calibration modal's own log panel (visible while the modal
// is open) as well as the main status log (kept for history/consistency).
function calLog(msg) {
  const el = document.getElementById('calLog');
  el.value += msg + '\n';
  el.scrollTop = el.scrollHeight;
  log(msg);
}

async function runCalibration() {
  if (calRunning) return;
  document.getElementById('calLog').value = '';
  if (drvMonitorActive) { calLog('請先停止 Driver Status 監控再進行校正'); return; }
  if (!state.serial.isOpen) { calLog('序列埠未開啟'); return; }

  calRunning = true;
  const btn = document.getElementById('btnCalStart');
  btn.disabled = true;
  btn.textContent = '校正中...';
  setCalProgress(0, '');
  calLog('校正開始 ==>');

  try {
    // ── 1. Enable trigger ──
    await state.serial.write(buildCalEnableCmd());
    await sleep(500);

    // ── 2. Start command ──
    state.serial.clearBuffer();
    await state.serial.write(buildCalStartCmd());
    await sleep(5);

    // Other CAN traffic (e.g. a straggler frame) can arrive before the real
    // ACK — keep reading instead of aborting on the first mismatch, and only
    // give up after 10 consecutive timeouts/mismatches.
    let ack = null;
    let ackErrCnt = 0;
    while (ackErrCnt < 10) {
      const ackFrame = await state.serial.readCanFrame(1000);
      const ackResp  = ackFrame ? parseCanResponse(ackFrame) : null;
      if (!ackResp) { calLog('接收逾時，無回應'); ackErrCnt++; continue; }
      ack = parseCalAck(ackResp);
      if (ack === null) {
        calLog('ACK ID 錯誤 0x' + ackResp.id.toString(16) + '，繼續等待...');
        ackErrCnt++;
        continue;
      }
      break;
    }
    if (ack === null) { calLog('連續 ' + ackErrCnt + ' 次未收到正確 ACK，中止校正'); return; }
    if (ack === 'busy') { calLog('驅動器忙碌中，校正未啟動'); return; }
    calLog('驅動器已回應，開始輪詢校正進度...');

    // ── 3. Poll progress (up to 60 tries, ~590ms interval) ──
    // Same tolerance as the ACK wait above: an unrelated/mismatched frame
    // doesn't abort the poll — only 5 *consecutive* timeouts/mismatches do.
    let errorCnt = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(590);
      state.serial.clearBuffer();
      await state.serial.write(buildCalPollCmd());
      await sleep(5);
      const frame  = await state.serial.readCanFrame(1000);
      const resp   = frame ? parseCanResponse(frame) : null;
      const status = resp ? parseCalStatus(resp) : null;

      if (!status) {
        errorCnt++;
        calLog(resp ? ('ACK ID 錯誤 0x' + resp.id.toString(16)) : '接收逾時');
        if (errorCnt >= 5) { calLog('連續 ' + errorCnt + ' 次未收到正確回應，中止校正'); break; }
        continue;
      }
      errorCnt = 0;
      if (status.error) calLog('錯誤碼 0x' + status.error.toString(16));
      setCalProgress((status.step / 12 * 100).toFixed(0), `Process ${status.step} / 12`);
      if (status.done) {
        calLog(status.success ? '校正成功' : '校正失敗');
        break;
      }
    }
  } catch (e) {
    calLog('校正發生錯誤: ' + e.message);
  } finally {
    calLog('校正結束');
    calRunning = false;
    btn.disabled = false;
    btn.textContent = '▶ 開始校正';
  }
}

// ─────────────────────────────────────────────────────────────
//  Burn / Firmware Update
// ─────────────────────────────────────────────────────────────

const burnState = {
  lines:           [],
  fileSize:        0,
  fileName:        '',
  newVersion:      '',
  burning:         false,
  cancelRequested: false,
};

function setBurnBusy(busy) {
  const hasFile = burnState.lines.length > 0;
  const btn = document.getElementById('btnBurn');
  burnState.burning = busy;
  if (busy) {
    btn.textContent = '⏹ 停止燒錄';
    btn.classList.add('btn-burn-stop');
    btn.disabled = false;
  } else {
    btn.textContent = '⚡ 開始燒錄';
    btn.classList.remove('btn-burn-stop');
    btn.disabled = !hasFile;
  }
  document.getElementById('btnCheckFw').disabled = busy || !hasFile;
  document.getElementById('btnLoadHex').disabled = busy;
}

function setBurnProgress(pct, label = '') {
  document.getElementById('burnProgressBar').style.width    = pct + '%';
  document.getElementById('burnProgressLabel').textContent  = label;
}

// ── Load HEX file ─────────────────────────────────────────

document.getElementById('btnLoadHex').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.hex,.txt,.bin';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => burnLoadFile(ev.target.result, file.name);
    reader.readAsText(file);
  };
  input.click();
});

function burnEnableFileButtons(enabled) {
  document.getElementById('btnCheckFw').disabled = !enabled;
  document.getElementById('btnBurn').disabled    = !enabled;
}

function burnLoadFile(text, fileName) {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines = [];
  for (const line of raw) {
    lines.push(line);
    if (line.startsWith('@$')) break;
  }
  burnState.lines    = lines;
  burnState.fileName = fileName;
  let size = 0;
  for (const l of lines) size += l.length + 2; // +2 for \r\n
  burnState.fileSize = size;
  const mv = lines[0]?.match(/[vV]\d{2}\.\d{2}/);
  burnState.newVersion = mv ? mv[0] : '';
  document.getElementById('hexFileName').textContent  = fileName;
  document.getElementById('hexFileInfo').textContent  =
    (burnState.newVersion ? '新版本: ' + burnState.newVersion + '  ' : '') +
    lines.length + ' 行  ' + size + ' bytes';
  burnEnableFileButtons(true);
  setBurnProgress(0);
  log('已載入 HEX: ' + fileName + (burnState.newVersion ? '  新版本: ' + burnState.newVersion : ''));
}

// ── Helpers ───────────────────────────────────────────────

async function burnCheckFirmware(sig) {
  // Returns 0=bootloader, 1=app, 2=error/timeout
  try {
    state.serial.clearBuffer();
    if (state.isCAN) {
      await state.serial.write(buildBurnCanCheckFw(sig));
      await sleep(1);
      const frame = await state.serial.readCanFrame(3000);
      if (!frame) { log('check_Firmware: 無回應'); return 2; }
      const r = parseCanResponse(frame);
      if (!r || r.id !== 0x000000B3) { log('check_Firmware: ID錯誤 ' + (r ? '0x' + r.id.toString(16) : 'null')); return 2; }
      const execState = r.data[0] + r.data[1];
      const major = r.data[2] | (r.data[3] << 8);
      const minor = r.data[4] | (r.data[5] << 8);
      log('版本: V' + major.toString().padStart(2, '0') + '.' + minor.toString().padStart(2, '0') +
          (execState === 130 ? '  [Bootloader]' : '  [App]'));
      return execState === 130 ? 0 : 1;
    } else {
      await state.serial.write(buildBurnUartCheckFw(sig));
      const bytes = await state.serial.readBurnUartFrame(0xF6, 3000);
      if (!bytes) { log('check_Firmware: 無回應'); return 2; }
      const r = parseBurnUartFwResp(bytes);
      if (r.error) { log('check_Firmware: ' + r.error); return 2; }
      log('版本: V' + r.major.toString().padStart(2, '0') + '.' + r.minor.toString().padStart(2, '0') +
          (r.state === 0 ? '  [Bootloader]' : '  [App]'));
      return r.state;
    }
  } catch (e) {
    log('check_Firmware 異常: ' + e.message);
    return 2;
  }
}

async function burnJumpToBootLoader(sig) {
  try {
    state.serial.clearBuffer();
    log('Jump to BootLoader...');
    if (state.isCAN) {
      await state.serial.write(buildBurnCanJumpBoot(sig));
      const frame = await state.serial.readCanFrame(5000);
      if (!frame) { log('Jump to BootLoader: 無回應'); return false; }
      const r = parseCanResponse(frame);
      if (!r || r.id !== 0x000000B5) { log('Jump to BootLoader: ID錯誤'); return false; }
      if (r.data[0] !== 0x30) { log('Jump to BootLoader: 狀態錯誤 0x' + r.data[0].toString(16)); return false; }
    } else {
      await state.serial.write(buildBurnUartJumpBoot(sig));
      const bytes = await state.serial.readBurnUartFrame(0xF4, 5000);
      if (!bytes) { log('Jump to BootLoader: 無回應'); return false; }
      if (!parseBurnUartJumpResp(bytes)) { log('Jump to BootLoader: 狀態錯誤'); return false; }
    }
    log('Jump to BootLoader OK');
    return true;
  } catch (e) {
    log('Jump to BootLoader 異常: ' + e.message);
    return false;
  }
}

async function burnJumpToApp(sig) {
  for (let cnt = 0; cnt < 3; cnt++) {
    state.serial.clearBuffer();
    if (state.isCAN) {
      await state.serial.write(buildBurnCanJumpApp());
    } else {
      await state.serial.write(buildBurnUartJumpApp(sig));
    }
    log('Jump to App, 等待...');
    await sleep(1000);
    const check = await burnCheckFirmware(sig);
    if (check === 1) { log('Jump to App OK'); return true; }
  }
  log('Jump to App 失敗');
  return false;
}

// ── UART flash ────────────────────────────────────────────

async function burnFlashUart(sig) {
  let totalBytes = burnState.lines.reduce((s, l) => s + l.length, 0);
  let doRetry = false;

  do {
    if (doRetry) await sleep(3000);
    doRetry = false;
    let sentBytes = 0;
    setBurnProgress(0, 'Programming...');
    log('Programming...');

    for (const line of burnState.lines) {
      if (line === '') break;
      const fc = line.charCodeAt(0);
      if (fc !== 0x40 /* @ */ && fc !== 0x3A /* : */) continue;

      const lineBytes = new TextEncoder().encode(line);
      let lineRetry = false;
      let lineRetryCnt = 0;

      do {
        if (lineRetry) await sleep(100);
        lineRetry = false;

        state.serial.clearBuffer();
        await state.serial.write(buildBurnUartLine(lineBytes));
        const ack = await state.serial.readBurnUartLineAck(3000);
        const result = parseBurnUartLineAck(ack);

        if (result === 'timeout') {
          log('timeout, retry...');
          doRetry = true;
          break;
        } else if (result === 'crc_err') {
          log('Response CRC check error!');
          doRetry = true;
          break;
        } else if (result === 'nak') {
          if (lineRetryCnt >= 10) { log('Still fail after retry 10 times, aborted.'); return false; }
          log('Line error, retry...');
          lineRetry = true;
        } else {
          sentBytes += lineBytes.length;
          const pct = totalBytes > 0 ? Math.round(sentBytes * 100 / totalBytes) : 0;
          setBurnProgress(pct, pct + '% (' + sentBytes + '/' + totalBytes + ')');
        }
        lineRetryCnt++;
      } while (lineRetry);

      if (doRetry) break;
      if (burnState.cancelRequested) { log('⏹ 燒錄已終止'); return false; }
    }
  } while (doRetry);

  log('Program done!');
  return true;
}

// ── BLE-CAN flash ────────────────────────────────────────

async function burnFlashBleCan(sig) {
  const CHUNK_SIZE = parseInt(document.getElementById('selBleChunk').value, 10) || 124;

  // Build flat byte stream: each filtered line followed by \r\n
  const enc = new TextEncoder();
  const parts = [];
  for (const line of burnState.lines) {
    if (line === '') break;
    const fc = line.charCodeAt(0);
    if (fc !== 0x40 /* @ */ && fc !== 0x3A /* : */) continue;
    for (const b of enc.encode(line)) parts.push(b);
    parts.push(0x0D, 0x0A);
  }
  const allBytes = new Uint8Array(parts);
  const totalBytes = allBytes.length;

  let doRetry = false;
  const flashT0 = Date.now();
  let chunkCount = 0;
  let totalRttMs = 0;

  do {
    if (doRetry) await sleep(3000);
    doRetry = false;
    let sentBytes = 0;
    setBurnProgress(0, 'BLE-CAN Programming...');
    log('BLE-CAN Programming...  ' + totalBytes + ' bytes  chunk=' + CHUNK_SIZE);

    for (let i = 0; i < allBytes.length; i += CHUNK_SIZE) {
      const chunk = allBytes.slice(i, i + CHUNK_SIZE);
      const pkt = buildBurnBleCanChunk(chunk);
      let chunkRetry = false;
      let chunkRetryCnt = 0;

      do {
        if (chunkRetry) await sleep(300);
        chunkRetry = false;

        state.serial.clearBuffer();
        const tChunk = Date.now();
        await state.serial.write(pkt);
        const ack = await state.serial.readBurnBleCanLineAck(1000);
        const rtt = Date.now() - tChunk;
        const result = parseBurnBleCanLineAck(ack);

        if (result === 'timeout') {
          log('timeout, retry...');
          doRetry = true;
          break;
        } else if (result === 'nak') {
          if (chunkRetryCnt >= 3) { log('Still fail after retry 3 times, aborted.'); return false; }
          log('Chunk error, retry...');
          chunkRetry = true;
        } else {
          chunkCount++;
          totalRttMs += rtt;
          sentBytes += chunk.length;
          const pct = Math.round(sentBytes * 100 / totalBytes);
          setBurnProgress(pct, pct + '% (' + sentBytes + '/' + totalBytes + ')');
        }
        chunkRetryCnt++;
      } while (chunkRetry);

      if (doRetry) break;
      if (burnState.cancelRequested) { log('⏹ 燒錄已終止'); return false; }
    }
  } while (doRetry);

  const flashMs = Date.now() - flashT0;
  const avgRtt = chunkCount > 0 ? Math.round(totalRttMs / chunkCount) : 0;
  log('BLE-CAN Program done!  Flash: ' + (flashMs / 1000).toFixed(1) + 's  chunks: ' + chunkCount + '  avg RTT: ' + avgRtt + 'ms/chunk');
  return true;
}

// ── CAN flash ─────────────────────────────────────────────

async function burnFlashCan(sig) {
  const text = burnState.lines.join('\r\n') + '\r\n';
  const allBytes = new TextEncoder().encode(text);
  const totalBytes = allBytes.length;
  const PART_LEN = 62;
  let retryCount = 0;
  let doRetry = false;
  const t0 = Date.now();

  do {
    if (doRetry) {
      if (retryCount >= 5) { log('still fail after 5 retries, aborted.'); return false; }
      // Reset device buffer by sending SIG twice
      state.serial.clearBuffer();
      await state.serial.write(buildBurnCanCheckFw(sig));
      await sleep(100);
      state.serial.clearBuffer();
      await state.serial.write(buildBurnCanCheckFw(sig));
      await sleep(3000);
    }
    doRetry = false;
    let sentBytes = 0;
    setBurnProgress(0, 'CAN Program Start...');
    log('CAN Program Start...');

    for (let i = 0; i < allBytes.length; i += PART_LEN) {
      const chunk = allBytes.slice(i, i + PART_LEN);
      const frames = buildBurnCanSegments(chunk);

      state.serial.clearBuffer();
      for (const frame of frames) {
        await state.serial.write(frame);
        await sleep(3); // 3 ms inter-frame delay
      }
      await sleep(2); // 2 ms post-segment

      // Read ACK (ID 0xBF), filtering noise
      let receive = null;
      let rawFrame = await state.serial.readCanFrame(1000);
      if (!rawFrame) {
        await sleep(5);
        rawFrame = await state.serial.readCanFrame(500);
      }
      if (rawFrame) {
        let r = parseCanResponse(rawFrame);
        if (r && r.id !== 0xBF) {
          for (let kk = 0; kk < 200 && r && r.id !== 0xBF; kk++) {
            log('Rcv any ID reRcv =' + kk);
            await sleep(1);
            rawFrame = await state.serial.readCanFrame(500);
            r = rawFrame ? parseCanResponse(rawFrame) : null;
          }
        }
        receive = (rawFrame && r && r.id === 0xBF) ? r : null;
      }

      if (receive) {
        if (receive.data[0] === 0xF1 && receive.data[2] === 0x30) {
          sentBytes += chunk.length;
          const pct = Math.round(sentBytes * 100 / totalBytes);
          setBurnProgress(pct, pct + '% (' + sentBytes + '/' + totalBytes + ')');
        } else {
          log('CAN Ack Error..');
          doRetry = true; retryCount++;
        }
      } else {
        log('控制器沒有回覆..');
        doRetry = true; retryCount++;
      }

      if (doRetry) break;
      if (burnState.cancelRequested) { log('⏹ 燒錄已終止'); return false; }
    }
  } while (doRetry);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log('CAN program done! ' + elapsed + ' sec');
  return true;
}

// ── Check Firmware button ─────────────────────────────────

document.getElementById('btnCheckFw').addEventListener('click', async () => {
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return; }
  if (!burnState.lines.length) { alert('請先載入 HEX 檔案'); return; }

  setBurnBusy(true);
  log('--- Check Firmware ---');
  try {
    const sig = burnGetSig(burnState.lines[0], !state.isCAN);
    if (!sig) { log('❌ SIG 解析失敗：HEX 檔第一行格式不符'); return; }
    log('SIG: ' + Array.from(sig).map(b => String.fromCharCode(b)).join(''));
    const result = await burnCheckFirmware(sig);
    const label = result === 0 ? '✅ Bootloader（可燒錄）'
                : result === 1 ? '✅ App（正常運行中）'
                :                '❌ 無回應 / SIG 不符';
    log('結果: ' + label);
  } catch (e) {
    log('❌ 異常: ' + e.message);
  } finally {
    setBurnBusy(false);
  }
});

// ── Burn button ───────────────────────────────────────────

document.getElementById('btnBurn').addEventListener('click', async () => {
  // ── Stop mode ──────────────────────────────────────────
  if (burnState.burning) {
    burnState.cancelRequested = true;
    document.getElementById('btnBurn').textContent = '⏹ 停止中...';
    document.getElementById('btnBurn').disabled = true;
    return;
  }

  // ── Start mode ─────────────────────────────────────────
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return; }
  if (!burnState.lines.length) { alert('請先載入 HEX 檔案'); return; }

  burnState.cancelRequested = false;
  setBurnBusy(true);
  setBusy(true);
  setBurnProgress(0, '');
  log('--- Burn Start ---');
  const burnT0 = Date.now();
  const burnElapsed = () => {
    const ms = Date.now() - burnT0;
    const s  = (ms / 1000).toFixed(1);
    return s + ' 秒 (' + ms + ' ms)';
  };

  try {
    const sig = burnGetSig(burnState.lines[0], !state.isCAN);
    if (!sig) {
      log('❌ SIG 解析失敗：HEX 檔第一行格式不符 (@@<SIG8>v<VV>.<vv>)');
      return;
    }
    log('SIG: ' + Array.from(sig).map(b => String.fromCharCode(b)).join(''));

    const burnMode = document.getElementById('selBurnMode').value;
    const versionState = await burnCheckFirmware(sig);
    let burnOk = false;

    const doFlash = (s) => burnMode === 'blecan' ? burnFlashBleCan(s)
                         : state.isCAN          ? burnFlashCan(s)
                         :                        burnFlashUart(s);

    if (versionState === 0) {
      burnOk = await doFlash(sig);
    } else if (versionState === 1) {
      const jumped = await burnJumpToBootLoader(sig);
      if (!jumped) { log('❌ Jump to BootLoader 失敗'); return; }
      await sleep(800);
      const stateAfter = await burnCheckFirmware(sig);
      if (stateAfter === 0) {
        burnOk = await doFlash(sig);
      } else {
        log('❌ Jump to BootLoader 後仍非 Bootloader 狀態');
        return;
      }
    } else {
      log('❌ 無回應 Or SIG Error!');
      return;
    }

    if (!burnOk) { log('❌ 燒錄失敗  耗時: ' + burnElapsed()); return; }

    setBurnProgress(100, '完成');
    log('✅ Burn Finished!  耗時: ' + burnElapsed());

    const jumpOk = await burnJumpToApp(sig);
    if (!jumpOk) log('⚠ Jump to App 失敗（燒錄已完成但無法驗證）');

  } catch (e) {
    log('❌ Burn 異常: ' + e.message + '  耗時: ' + burnElapsed());
    console.error(e);
  } finally {
    setBurnBusy(false);
    setBusy(false);
  }
});

// ─────────────────────────────────────────────────────────────
//  Boot: wire up modals and initial state
// ─────────────────────────────────────────────────────────────
initSetbitModal();
initConfigModal();

// Show version
document.getElementById('appVersion').textContent = APP_VERSION;

// ── BLE chunk row visibility ──────────────────────────────────────
function applyBurnModeSelection(mode) {
  const row = document.getElementById('bleChunkRow');
  if (row) row.style.display = mode === 'blecan' ? '' : 'none';
}

document.getElementById('selBurnMode').addEventListener('change', (e) => {
  applyBurnModeSelection(e.target.value);
});

applyBurnModeSelection(document.getElementById('selBurnMode').value);

// ── Channel selector ──────────────────────────────────────────────
function applyChannelSelection(channel) {
  const isBle = channel === 'ble';
  state.serial = isBle ? state.bleSerial : state.comSerial;
  // Show/hide comport-specific params
  const params = document.getElementById('serialParams');
  if (params) params.style.display = isBle ? 'none' : 'contents';
  // Wire up BLE unexpected-disconnect handler (set once; no-op for comport)
  state.bleSerial.onDisconnect = () => {
    setDot(false);
    log('⚠ BLE 連線意外中斷');
  };
  state.bleSerial._onLog = (msg) => log(msg);
}

document.getElementById('selChannel').addEventListener('change', (e) => {
  if (state.serial && state.serial.isOpen) {
    alert('請先關閉目前連線再切換通道');
    e.target.value = state.serial === state.bleSerial ? 'ble' : 'comport';
    return;
  }
  applyChannelSelection(e.target.value);
});

// Initialize active channel to comport (default)
applyChannelSelection('comport');

// Auto-load INI files on startup
autoLoadIni();

// SIG box read-only by default
document.getElementById('tboxSIG').readOnly = true;
document.getElementById('tboxSIG').style.opacity = '.5';
document.getElementById('tboxSN').disabled = true;

// Check API support
if (!navigator.serial) {
  document.getElementById('statusLog').value +=
    '⚠ 此瀏覽器不支援 Web Serial API。Comport 通道無法使用。\n請使用 Chrome 或 Edge 89+。\n';
}
if (!navigator.bluetooth) {
  document.getElementById('statusLog').value +=
    '⚠ 此瀏覽器不支援 Web Bluetooth API。BLE 通道無法使用。\n請使用 Chrome 或 Edge 並以 https:// 開啟。\n';
}
if (!navigator.serial && !navigator.bluetooth) {
  document.getElementById('btnOpen').disabled = true;
}

// ── 桌機版：讓收合按鈕跟隨 sidebar 右邊緣 ──
function updateSbTogglePos() {
  if (window.innerWidth > 768) {
    const s = document.getElementById('sidebar');
    const b = document.getElementById('btnSidebarToggle');
    const r = document.getElementById('sidebarResizer');
    if (s && b) b.style.left = (s.offsetWidth + (r ? r.offsetWidth : 5)) + 'px';
  }
}

// ── Sidebar resize ──
(function () {
  const sidebar  = document.getElementById('sidebar');
  const resizer  = document.getElementById('sidebarResizer');
  const STORAGE_KEY = 'endex_sidebar_w';
  const MIN_W = 140, MAX_W = 480;

  const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (saved >= MIN_W && saved <= MAX_W) sidebar.style.width = saved + 'px';

  let startX, startW;

  function startResize(clientX) {
    startX = clientX;
    startW = sidebar.offsetWidth;
    resizer.classList.add('resizing');
    document.body.style.userSelect = 'none';
  }
  function doResize(clientX) {
    const w = Math.min(MAX_W, Math.max(MIN_W, startW + clientX - startX));
    sidebar.style.width = w + 'px';
    updateSbTogglePos();
  }
  function endResize() {
    resizer.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(STORAGE_KEY, sidebar.offsetWidth);
    updateSbTogglePos();
  }

  // 滑鼠
  resizer.addEventListener('mousedown', e => {
    startResize(e.clientX);
    document.body.style.cursor = 'col-resize';
    function onMove(e) { doResize(e.clientX); }
    function onUp()   { endResize(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // 觸控（手機版不啟用 resize，避免攔截子元素的 touch 事件）
  resizer.addEventListener('touchstart', e => {
    if (window.innerWidth <= 768) return;
    e.preventDefault();
    startResize(e.touches[0].clientX);
  }, { passive: false });
  resizer.addEventListener('touchmove', e => {
    if (window.innerWidth <= 768) return;
    e.preventDefault();
    doResize(e.touches[0].clientX);
  }, { passive: false });
  resizer.addEventListener('touchend', () => endResize());
})();

// ── Sidebar 收合切換 ──
(function () {
  const sidebar  = document.getElementById('sidebar');
  const btn      = document.getElementById('btnSidebarToggle');
  const backdrop = document.getElementById('sidebarBackdrop');
  const LS_KEY   = 'endex_sidebar_collapsed';
  const isMobile = () => window.innerWidth <= 768;

  function setCollapsed(collapsed) {
    sidebar.classList.toggle('sidebar--collapsed', collapsed);
    btn.textContent = collapsed ? '▶' : '◀';
    localStorage.setItem(LS_KEY, collapsed ? '1' : '');
    if (backdrop) backdrop.classList.toggle('active', !collapsed && isMobile());
    updateSbTogglePos();
  }

  // 行動版預設收合；桌機讀 localStorage
  setCollapsed(isMobile() ? true : !!localStorage.getItem(LS_KEY));
  updateSbTogglePos();

  btn.addEventListener('click', e => {
    e.stopPropagation();
    setCollapsed(!sidebar.classList.contains('sidebar--collapsed'));
  });

  if (backdrop) backdrop.addEventListener('click', () => setCollapsed(true));

  window.addEventListener('resize', () => {
    if (!isMobile() && backdrop) backdrop.classList.remove('active');
    updateSbTogglePos();
  });
})();

// ── 參數列表字體大小 ──
(function () {
  const slider = document.getElementById('rngParamFontSize');
  const label  = document.getElementById('paramFontSizeVal');
  const STORAGE_KEY = 'endex_param_font_size';
  const MIN_SIZE = 10, MAX_SIZE = 16, DEFAULT_SIZE = 11;

  function apply(size) {
    document.documentElement.style.setProperty('--param-font-size', size + 'px');
    label.textContent = size + 'px';
  }

  const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  const initial = (saved >= MIN_SIZE && saved <= MAX_SIZE) ? saved : DEFAULT_SIZE;
  slider.value = initial;
  apply(initial);

  slider.addEventListener('input', () => {
    const size = parseInt(slider.value, 10);
    apply(size);
    localStorage.setItem(STORAGE_KEY, size);
  });
})();
