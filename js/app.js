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

const APP_VERSION = 'v1.5.18';

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
  modelUserSelected: false,   // true once the user has manually picked a model via #selModel — disables auto-switch-on-mismatch so a deliberate choice is never silently overridden
  comSerial: new SerialManager(),
  bleSerial: new BleManager(),
  serial:    null,   // active channel — set at boot and on channel change
  busy: false,
  connecting: false,   // true while btnOpen's open() is in flight (BLE chooser / port picker)
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
  updateUiState();
}

// True while a device operation is running (read/write, burn or FW check,
// calibration) — used to lock the UI and to warn before leaving the page.
function isOperationRunning() {
  return state.busy || state.connecting || burnState.burning || calRunning;
}

// Single place that derives every connection/operation-dependent control's
// enabled state. A disabled control's title explains why; the original
// title is kept in data-title-orig and restored when it is re-enabled.
function updateUiState() {
  const isBle     = document.getElementById('selChannel').value === 'ble';
  const supported = isBle ? !!navigator.bluetooth : !!navigator.serial;
  const connected = !!(state.serial && state.serial.isOpen);
  const running   = isOperationRunning();

  const setCtl = (id, disabled, reason) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.dataset.titleOrig === undefined) el.dataset.titleOrig = el.title || '';
    el.disabled = disabled;
    el.title = disabled && reason ? reason : el.dataset.titleOrig;
  };
  const busyMsg = '作業進行中，請稍候';
  const connMsg = '請先開啟連線';

  setCtl('btnOpen',  !supported || connected || running,
    !supported ? '此瀏覽器不支援' + (isBle ? ' Web Bluetooth' : ' Web Serial') : connected ? '已連線' : busyMsg);
  setCtl('btnClose', !connected || running, running ? busyMsg : '尚未連線');
  ['selChannel', 'selProtocol', 'selBaudrate'].forEach(id =>
    setCtl(id, connected || running, connected ? '連線中無法變更，請先關閉連線' : busyMsg));

  setCtl('btnRead',  !connected || running, running ? busyMsg : connMsg);
  setCtl('btnWrite', !connected || running, running ? busyMsg : connMsg);

  const canMsg = !connected ? connMsg : running ? busyMsg : '僅支援 CAN 模式';
  ['btnDriverStatus', 'btnCalibrate', 'btnCalTrigger', 'btnTsDetect', 'btnTsSilent', 'btnTsResume'].forEach(id =>
    setCtl(id, !connected || !state.isCAN || running, canMsg));

  ['btnImport', 'btnConfig', 'selModel', 'btnReloadIni', 'btnClearIniCache',
   'btnLoadPageIni', 'btnLoadParamIni'].forEach(id => setCtl(id, running, busyMsg));

  // Burn buttons: while burning, setBurnBusy() owns btnBurn (it becomes the stop button)
  if (!burnState.burning) {
    const hasFile = burnState.lines.length > 0;
    const reason  = !hasFile ? '請先載入 HEX 檔' : !connected ? connMsg : busyMsg;
    setCtl('btnBurn',    !hasFile || !connected || running, reason);
    setCtl('btnCheckFw', !connected || running, !connected ? connMsg : busyMsg);
  }
  setCtl('btnLoadHex', running, busyMsg);
}

// Warn before closing/reloading the page mid-operation (write, burn, calibration)
window.addEventListener('beforeunload', (e) => {
  if (!isOperationRunning()) return;
  e.preventDefault();
  e.returnValue = '';
});

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

    state.connecting = true;
    updateUiState();
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
  } finally {
    state.connecting = false;
    updateUiState();
  }
  // CAN (COM or BLE): check for the torque sensor right after connecting (listen only, sends nothing)
  if (state.serial.isOpen && state.isCAN) await tsDetect(true);
});

document.getElementById('btnClose').addEventListener('click', async () => {
  const isBle = document.getElementById('selChannel').value === 'ble';
  await state.serial.close();
  setDot(false);
  setProgress(0);
  log(isBle ? 'BLE 連線已關閉' : 'SerialPort is closed!');
});

function setDot(connected) {
  if (!connected) { setTsStatus('unknown'); tsAutoSilentDone = false; }
  const dot = document.getElementById('statusDot');
  dot.classList.toggle('connected',    connected);
  dot.classList.toggle('disconnected', !connected);
  updateUiState();

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
const LS_MODEL = 'endex_model';

/** Model → parameter.ini filename. '' = standard CAN line (ENEBDV02/12). */
const MODEL_FILES = {
  '':         'parameter.ini',
  'ENEBDV01': 'parameter_ENEBDV01.ini',
  'ENEBDV04': 'parameter_ENEBDV04.ini',
};

/** Model → expected PRODUCT_SPECIFIED_ID string(s), decoded from SIG0-3 (0x0000-0x0003). */
const MODEL_PRODUCT_IDS = {
  '':         ['ENEBDV02', 'ENEBDV12'],
  'ENEBDV01': ['ENEBDV01', 'ENEBDV11'],
  'ENEBDV04': ['ENEBDV04'],
};

/** Model → display label used in model-mismatch log messages. */
const MODEL_LABELS = {
  '':         '標準 CAN (ENEBDV02/12)',
  'ENEBDV01': 'UART (ENEBDV01/11)',
  'ENEBDV04': 'ENEBDV04 (Schaca)',
};

function currentModel() {
  return document.getElementById('selModel')?.value || '';
}
function lsParamKey(model)     { return model ? `${LS_PARAM}_${model}`      : LS_PARAM; }
function lsParamNameKey(model) { return model ? `${LS_PARAM_NAME}_${model}` : LS_PARAM_NAME; }

/** Update the "currently loaded parameter.ini" filename display + cache. */
function setParamIniName(name, model = currentModel()) {
  localStorage.setItem(lsParamNameKey(model), name);
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
  const model     = currentModel();
  const paramFile = MODEL_FILES[model] || MODEL_FILES[''];

  // ── Step 1: fetch from same directory ──
  try {
    const r = await fetch('./page.ini');
    if (r.ok) { pageText = await r.text(); }
  } catch {}
  try {
    const r = await fetch('./' + paramFile);
    if (r.ok) { paramText = await r.text(); }
  } catch {}
  const paramFromFetch = paramText !== null;

  // ── Step 2: localStorage cache ──
  if (!pageText)  pageText  = localStorage.getItem(LS_PAGE);
  if (!paramText) paramText = localStorage.getItem(lsParamKey(model));

  // ── Step 2b: embedded fallback (works under file:// with no prior cache) ──
  let paramFromEmbedded = false;
  if (!paramText && typeof EMBEDDED_PARAM_INI !== 'undefined' && EMBEDDED_PARAM_INI[model]) {
    paramText = EMBEDDED_PARAM_INI[model];
    paramFromEmbedded = true;
  }

  // ── Step 3: apply ──
  const fromCache = !pageText?.startsWith('\n') && localStorage.getItem(LS_PAGE) === pageText;
  if (pageText) {
    state.tabList = parsePageIni(pageText);
    log('page.ini 載入 (' + (fromCache ? '快取' : '檔案') + ') → ' + state.tabList.length + ' 個分頁');
  }
  if (paramText) {
    state.hrList = parseParameterIni(paramText);
    // Fetched or embedded text is always MODEL_FILES[model]; only a cache hit uses the stored name
    // (which may be a stale '(未載入)' placeholder left by an earlier failed load).
    const paramName = (paramFromFetch || paramFromEmbedded) ? paramFile
                    : (localStorage.getItem(lsParamNameKey(model)) || paramFile);
    setParamIniName(paramName, model);
    const src = paramFromFetch ? '檔案' : (paramFromEmbedded ? '內嵌預設值' : '快取');
    log('parameter.ini 載入 (' + src + ': ' + paramName + ') → ' + state.hrList.length + ' 個參數');
  } else {
    // Fetch failed (e.g. opened via file://) AND this model has no cache yet —
    // don't silently keep the previous model's stale hrList on screen.
    state.hrList = [];
    setParamIniName('(未載入)', model);
    log('⚠ 找不到 ' + paramFile + '（伺服器無回應且此機種尚無快取）。請按「手動選 parameter.ini」選擇 ' + paramFile + ' 一次以建立快取。');
  }
  rebuildTabs();
  updateAutoLoadStatus(state.tabList.length > 0 && state.hrList.length > 0);
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
    localStorage.setItem(lsParamKey(currentModel()), text);
    state.hrList = parseParameterIni(text);
    state.paramFileHandle = handle;
    setParamIniName(file.name);
    log('parameter.ini 載入成功 → ' + state.hrList.length + ' 個參數  [已存入快取: ' + file.name + ']');
    rebuildTabs();
    updateAutoLoadStatus(state.tabList.length > 0 && state.hrList.length > 0);
  } else {
    pickFile('.ini,.txt', async (file) => {
      const text = await file.text();
      localStorage.setItem(lsParamKey(currentModel()), text);
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
  const model = currentModel();
  localStorage.removeItem(LS_PAGE);
  localStorage.removeItem(lsParamKey(model));
  localStorage.removeItem(lsParamNameKey(model));
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
// 韌體已退役的位址：匯入檔若含這些行，除了列入「多餘地址」（照常不寫入）外，
// 另以 ⚠ 提示替代位址，提醒使用者清理流通中的舊 CONFIG 檔。
const RETIRED_ADDRESSES = {
  0x0416: '已退役 (UART v3.11+ / CAN 同批)，扭力靈敏度請用 0x0410',
};

document.getElementById('btnImport').addEventListener('click', () => {
  pickFile('.txt,.csv', async (file) => {
    const entries = parseConfigTxt(await file.text());
    const found   = new Set();
    const extra   = [];
    const retired = [];   // 命中 RETIRED_ADDRESSES 的提示訊息

    if (!state.showPara) state.dataImport1 = [];
    else                 state.dataImport2 = [];

    for (const { address, data } of entries) {
      const item = state.hrList.find(h => h.address === address);
      if (!item) {
        const addrHex = address.toString(16).toUpperCase().padStart(4, '0');
        extra.push(addrHex);
        if (RETIRED_ADDRESSES[address]) retired.push(`⚠ ${addrHex}${data.toString(16).toUpperCase().padStart(4, '0')}：${RETIRED_ADDRESSES[address]}（未寫入，請從 CONFIG 檔刪除此行）`);
        continue;
      }
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

    const missingItems = state.hrList.filter(h => !found.has(h.address));
    const missing = missingItems.map(h => h.address.toString(16).toUpperCase().padStart(4, '0'));

    if (!state.showPara) { state.fileName1 = file.name; state.hrListSource   = 'import'; }
    else                 { state.fileName2 = file.name; state.paraListSource = 'import'; }

    updateShowParaLabel();

    if (missing.length) log('缺少地址: ' + missing.join(', '));
    if (extra.length)   log('多餘地址: ' + extra.join(', '));
    for (const msg of retired) log(msg);
    log(`匯入完成: ${file.name}`);

    applyImportDiffHighlight(state, new Set(missingItems.map(h => h.address)), found);
    refreshAllDisplays(state);
    updateSigDisplay();
    updateSnDisplay();
    updateSourceDisplay();
    checkSigProtocolMatch();

    // ── 機種比對：匯入檔案的 SIG0-3 (PRODUCT_SPECIFIED_ID) 是否與目前選擇的機種一致 ──
    const sig0to3Missing = ['0000', '0001', '0002', '0003'].some(a => missing.includes(a));
    const model = currentModel();
    let modelCheckLine = null;
    if (!sig0to3Missing) {
      const readSig     = decodeSig(state.showPara ? state.paraList : state.hrList);
      const expectedIds = MODEL_PRODUCT_IDS[model] || [];
      const modelOk      = expectedIds.length === 0 || expectedIds.includes(readSig);
      const modelLabel   = MODEL_LABELS[model] || model;
      if (modelOk) {
        log('✓ 機種比對：匯入檔案 PRODUCT_SPECIFIED_ID = ' + readSig + '，與目前選擇機種相符');
        modelCheckLine = '機種比對: ' + readSig + ' ✓';
      } else {
        log('⚠ 機種比對不符：匯入檔案 PRODUCT_SPECIFIED_ID = ' + readSig + '，但目前選擇機種為「' + modelLabel + '」。請確認左側「機種」選單是否選對，或確認匯入的檔案是否對應此機種！');
        modelCheckLine = '⚠ 機種比對不符: 檔案=' + readSig + '，工具選擇=' + modelLabel;
      }
    }

    const importLines = [
      '檔名: ' + file.name,
      '匯入筆數: ' + entries.length + ' 個',
      '缺少地址: ' + missing.length + ' 個',
      '多餘地址: ' + extra.length + ' 個',
    ];
    if (missing.length) importLines.push('缺少地址列表: ' + missing.join(', '));
    if (extra.length)   importLines.push('多餘地址列表: ' + extra.join(', '));
    importLines.push(...retired);
    if (modelCheckLine) importLines.push(modelCheckLine);
    const importOk = missing.length === 0 && extra.length === 0;
    showResultModal('匯入' + (importOk ? '完成' : '完成（有差異）'), importOk, importLines);
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
/**
 * @param isRetryAfterModelSwitch  true when this call is the automatic re-read
 *   triggered after an auto model-switch — disables further auto-switching so
 *   a persistently-mismatched SIG can't cause an infinite retry loop.
 * @param switchNote  message describing the auto-switch, carried into the
 *   final result modal so the user sees what happened even if they missed the log.
 */
async function performRead(isRetryAfterModelSwitch = false, switchNote = null) {
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return; }
  if (!state.hrList.length)  { alert('請先載入 parameter.ini'); return; }
  if (state.busy) return;

  setBusy(true);
  state.dataRead = [];
  const failed = [];
  const total  = state.hrList.length;
  log('開始讀取...');
  clearImportDiffHighlight(state);

  for (let i = 0; i < total; i++) {
    const item = state.hrList[i];
    const failReasons = [];
    const data = await retryOp(3, async () => {
      if (!state.isCAN) return readUartParam(item.address);
      const v = await readCanParam(item.address);
      if (v === null && lastCanReadFail) failReasons.push(lastCanReadFail);
      return v;
    }, () => state.isCAN && lastCanReadRejected);

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
      // 同一原因合併計次，例如「裝置回 0x83：不支援此地址 ×3」
      const counts = new Map();
      for (const r of failReasons) counts.set(r, (counts.get(r) || 0) + 1);
      const why = [...counts].map(([r, n]) => n > 1 ? `${r} ×${n}` : r).join(' / ');
      log(`  ${item.address.toString(16).toUpperCase().padStart(4, '0')} 無法讀取${why ? '（' + why + '）' : ''}`);
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

  // ── 機種比對：讀回的 SIG0-3 (PRODUCT_SPECIFIED_ID) 是否與目前選擇的機種一致 ──
  const sigAddrsFailed = failed.some(a => ['0000', '0001', '0002', '0003'].includes(a));
  const model = currentModel();
  let modelCheckLine = null;
  if (!sigAddrsFailed) {
    const readSig     = decodeSig(state.showPara ? state.paraList : state.hrList);
    const expectedIds = MODEL_PRODUCT_IDS[model] || [];
    const modelOk      = expectedIds.length === 0 || expectedIds.includes(readSig);
    const modelLabel   = MODEL_LABELS[model] || model;
    if (modelOk) {
      log('✓ 機種比對：裝置 PRODUCT_SPECIFIED_ID = ' + readSig + '，與目前選擇機種相符');
      modelCheckLine = '機種比對: ' + readSig + ' ✓';
    } else {
      const correctModel = Object.keys(MODEL_PRODUCT_IDS).find(k => MODEL_PRODUCT_IDS[k].includes(readSig));
      if (correctModel !== undefined && !isRetryAfterModelSwitch && !state.modelUserSelected) {
        // Device reports a SIG belonging to a known, different model — switch
        // to it, reload the matching parameter.ini, and re-read automatically
        // (the wrong-model read above is discarded; e.g. addresses only present
        // on one variant would otherwise keep failing every time).
        const correctLabel = MODEL_LABELS[correctModel] || correctModel;
        log('⚠ 機種比對不符：裝置 PRODUCT_SPECIFIED_ID = ' + readSig + '，但目前選擇機種為「' + modelLabel +
            '」。自動切換為「' + correctLabel + '」並重新讀取...');
        document.getElementById('selModel').value = correctModel;
        localStorage.setItem(LS_MODEL, correctModel);
        await autoLoadIni();
        setBusy(false);
        await performRead(true, '已自動切換機種：' + modelLabel + ' → ' + correctLabel);
        return;
      }
      const suffix = (correctModel !== undefined && state.modelUserSelected)
        ? '（機種為手動選擇，不自動切換）請確認左側「機種」選單是否選對！'
        : '請確認左側「機種」選單是否選對！';
      log('⚠ 機種比對不符：裝置 PRODUCT_SPECIFIED_ID = ' + readSig + '，但目前選擇機種為「' + modelLabel + '」。' + suffix);
      modelCheckLine = '⚠ 機種比對不符: 裝置=' + readSig + '，工具選擇=' + modelLabel;
    }
  }

  const readLines = [
    '共 ' + total + ' 個參數',
    '成功: ' + (total - failed.length) + ' 個',
    '失敗: ' + failed.length + ' 個',
  ];
  if (failed.length) readLines.push('失敗位址: ' + failed.join(', '));
  if (switchNote) readLines.push(switchNote);
  if (modelCheckLine) readLines.push(modelCheckLine);
  showResultModal('讀取' + (failed.length ? '完成（部分失敗）' : '完成'), failed.length === 0, readLines);

  setBusy(false);
}

document.getElementById('btnRead').addEventListener('click', () => performRead());

// ─────────────────────────────────────────────────────────────
//  Write parameters to device
// ─────────────────────────────────────────────────────────────
/** 寫入確認視窗用：說明主/副列表目前的值從哪裡來。 */
function describeListOrigin(source, fileName, fallback) {
  if (source === 'import') return `匯入 Config（${fileName}）`;
  if (source === 'read')   return '從裝置讀取';
  return fallback;
}

document.getElementById('btnWrite').addEventListener('click', async () => {
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return; }
  if (!state.hrList.length)  { alert('請先載入 parameter.ini'); return; }
  if (state.busy) return;

  // ── 寫入前確認來源（在任何裝置通訊之前，取消時不碰裝置）────────
  // UART skips first 4 items (SIG), CAN writes all
  const startIdx = state.isCAN ? 0 : 4;
  const countWritable = (lst) => lst.slice(startIdx).filter(item => {
    const hr = state.hrList.find(h => h.address === item.address);
    return !hr?.production && item.address > 0x0020;
  }).length;
  const filterNote = state.isCAN
    ? '※ 不寫入：address ≤ 0x0020、production 參數'
    : '※ 不寫入：SIG/SIN 序號（前 4 筆）、address ≤ 0x0020、production 參數';

  const srcInfo = {
    hr: {
      key: 'hr', list: state.hrList,
      title: '主：畫面上的參數值',
      origin: describeListOrigin(state.hrListSource, state.fileName1, '參數表預設值'),
      warn: state.hrListSource === null ? '尚未從裝置讀取或匯入 Config，寫入的會是參數表的預設值' : null,
    },
    para: {
      key: 'para', list: state.paraList,
      title: '副：比較參數',
      origin: describeListOrigin(state.paraListSource, state.fileName2, '（無資料）'),
      warn: state.paraList.length === 0 ? '比較參數沒有資料，沒有可寫入的值' : null,
    },
  };
  // 勾選「顯示比較參數」時寫入的是副列表；兩份筆數不同時才讓使用者改選主列表
  const shown = state.showPara
    ? (state.paraList.length !== state.hrList.length ? ['para', 'hr'] : ['para'])
    : ['hr'];
  const current = shown[0];
  const choice = await showWriteConfirmModal(shown.map(k => {
    const s = srcInfo[k];
    const writable = countWritable(s.list);
    return { ...s, count: s.list.length, writable, current: k === current,
             btnLabel: `寫入${k === 'hr' ? '主' : '副'}參數 (${writable} 個)` };
  }), filterNote + (state.showPara && shown.length === 1
    ? '\n※ 目前勾選「顯示比較參數」，寫入的是副列表；要寫入主列表請先取消勾選'
    : ''));
  if (!choice) { log('已取消寫入'); return; }
  const list = srcInfo[choice].list;
  log(`寫入來源：${srcInfo[choice].title}（${srcInfo[choice].origin}，可寫入 ${countWritable(list)} 個）`);

  setBusy(true);

  // ── 寫入前驗證：讀取裝置 SIG0~SIG3 與本機比對 ──────────────
  if (state.hrList.length >= 4) {
    log('驗證裝置 SIG...');
    const devRead = await readDeviceSig();
    if (devRead.sig === null) {
      log('❌ SIG' + devRead.failedIdx + ' 讀取失敗，中止寫入');
      setBusy(false);
      return;
    }
    const devSig   = devRead.sig;
    const sigSource = (choice === 'para' && state.paraList.length >= 4) ? state.paraList : state.hrList;
    const localSig = decodeSig(sigSource);
    if (devSig !== localSig) {
      log('❌ SIG 不符：裝置="' + devSig + '"  本機="' + localSig + '"，中止寫入');
      setBusy(false);
      return;
    }
    log('✅ SIG 驗證通過 "' + localSig + '"');
  }
  // ────────────────────────────────────────────────────────────

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
        : writeUartParam(item.address, item.data),
      () => lastWriteRejected
    );

    log(`  [${addrHex}] ${name} = ${item.data}  ${ok ? '✓' : '✗' + (lastWriteFail ? '（' + lastWriteFail + '）' : '')}`);

    if (!ok) {
      failed.push(addrHex);
      if (failed.length >= 10) { log('10 個地址失敗，停止寫入'); break; }
    }

    count++;
    setProgress(Math.round(count / total * 100), `${count}/${total}`);
  }

  // Save command — 有地址寫入失敗時先確認，避免把不完整的參數組存進 flash
  let saveOk = null;
  let saveMsg = '未執行/異常';
  let reloadMsg = null;
  const doSave = !failed.length || confirm(
    `有 ${failed.length} 個地址寫入失敗：${failed.join(', ')}\n\n` +
    `確定 → 仍存入 flash (SAVE)\n取消 → 不存檔（裝置重開機後回到原本的參數）`
  );
  if (!doSave) {
    saveMsg = '已取消（有地址寫入失敗）';
    log('有地址寫入失敗，使用者取消 SAVE');
  } else {
    try {
      const s = await runFlashCommand(1);
      saveOk = s.ok;
      saveMsg = s.ok ? '成功' : '失敗：' + s.msg;
      logFlashResult('Save', s);

      // CAN 存檔完成後再重新載入 Flash → RAM（存檔進行中送 reLoad 會被韌體以 0x86 拒絕）
      if (s.ok && state.isCAN) {
        const r = await runFlashCommand(2);
        reloadMsg = r.ok ? '成功' : '失敗：' + r.msg;
        logFlashResult('reLoad', r);
      }
    } catch (e) {
      log('儲存指令異常: ' + e.message);
    }
  }

  setProgress(0);
  if (failed.length) log('寫入失敗: ' + failed.join(', '));
  else               log('寫入完成');

  const writeLines = [
    '共 ' + total + ' 個參數',
    '成功: ' + (total - failed.length) + ' 個',
    '失敗: ' + failed.length + ' 個',
  ];
  if (failed.length) writeLines.push('失敗位址: ' + failed.join(', '));
  writeLines.push('儲存(Save): ' + saveMsg);
  if (reloadMsg) writeLines.push('重新載入(reLoad): ' + reloadMsg);
  showResultModal('寫入' + (failed.length || !saveOk ? '完成（部分失敗）' : '完成'), failed.length === 0 && saveOk === true, writeLines);

  setBusy(false);
});

// ─────────────────────────────────────────────────────────────
//  Low-level read / write helpers
// ─────────────────────────────────────────────────────────────
// CAN bus 上可能混雜其他 ID 的訊框（如 driver status 廣播）。
// readCanFrame() 只認 framing 邊界、不看 ID，收到不相關的訊框時
// 這裡最多再多讀幾次找出正確 ID，避免單一雜訊訊框就讓整次操作判失敗。
const CAN_ID_MISMATCH_MAX_SKIP = 10;

// readCanParam() 回傳 null 時，這裡記錄最後一次失敗的原因（供 log 顯示），
// 區分：裝置回 0x83 例外 / 逾時無回應 / 一直收到其他 CAN ID 或不相符的回應。
let lastCanReadFail = null;
// 最後一次失敗是裝置回 0x83 例外（地址不支援）— 結果固定，呼叫端不必重試。
let lastCanReadRejected = false;

function fmtHex(v, width) {
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

function hexBytes(bytes) {
  return Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** 描述 readCanParam 途中略過的訊框：foreignIds 為其他 CAN ID，staleCount 為 FC/位址不符的殘留回應。 */
function describeCanSkips(foreignIds, staleCount) {
  const parts = [];
  if (foreignIds.length) {
    const ids = [...new Set(foreignIds)];
    parts.push(`其他 CAN ID ${foreignIds.length} 筆：${ids.slice(0, 4).map(id => fmtHex(id, 8)).join(', ')}${ids.length > 4 ? ' …' : ''}`);
  }
  if (staleCount) parts.push(`FC/位址不符的殘留回應 ${staleCount} 筆`);
  return parts.join('；');
}

// UART 回應的位址或功能碼不符時（前一筆逾時後遲到的殘留回應），最多再讀幾筆。
const UART_STALE_MAX_SKIP = 3;

async function readUartParam(address) {
  state.serial.clearBuffer();
  await state.serial.write(buildUartRead(address));
  for (let skipped = 0; skipped < UART_STALE_MAX_SKIP; skipped++) {
    const frame = await state.serial.readUartFrame(skipped === 0 ? 1000 : 200);
    if (!frame) return null;
    const r = parseUartResponse(frame);
    if (r.address === undefined) return null;   // 長度不足 / CRC 錯誤
    // 回應須為讀取 (FC 0x03 或其例外 0x83) 且位址回音與請求相同，否則是殘留回應
    if ((r.func & 0x7F) !== 0x03 || r.address !== (address & 0xFFFF)) continue;
    return r.error ? null : r.data;
  }
  return null;
}

async function readCanParam(address) {
  state.serial.clearBuffer();
  await state.serial.write(buildCanRead(address));
  await sleep(10);
  // Bus 上可能混雜其他 ID 的訊框（如 driver status 廣播）先於回應抵達；
  // ID 不符時直接再讀一次，而非白白判失敗、耗掉外層 retryOp 的次數。
  // BLE-CAN 經 ESP32 橋接多一段延遲，逾時需放寬；COM-CAN 維持短逾時以加快讀取。
  const isBle = state.serial === state.bleSerial;
  const firstMs = isBle ? 1000 : 50;
  const nextMs  = isBle ? 500  : 20;
  const foreignIds = [];
  let staleCount = 0;
  lastCanReadFail = null;
  lastCanReadRejected = false;
  for (let skipped = 0; skipped < CAN_ID_MISMATCH_MAX_SKIP; skipped++) {
    const frame = await state.serial.readCanFrame(skipped === 0 ? firstMs : nextMs);
    if (!frame) {
      const skips = describeCanSkips(foreignIds, staleCount);
      lastCanReadFail = skipped === 0 ? '逾時無回應' : `逾時無回應（之前略過 ${skips}）`;
      return null;
    }
    const r = parseCanResponse(frame);
    if (!r) { staleCount++; continue; }
    if (r.id !== 0x01005020) { foreignIds.push(r.id); continue; }
    if (r.data[1] === 0x83) {
      const code = r.data.length > 2 ? '，例外碼 ' + fmtHex(r.data[2], 2) : '';
      lastCanReadFail = `裝置回 0x83：不支援此地址${code}`;
      lastCanReadRejected = true;
      return null;
    }
    // 回應須為讀取 (FC 0x03)、位址與請求相同、長度足夠；否則視為前一筆逾時後
    // 遲到的殘留回應，略過再讀，避免把別的位址的值寫進這一筆。
    if (r.data[1] !== 0x03) { staleCount++; continue; }
    if (r.data.length < 6) { staleCount++; continue; }
    if (((r.data[2] << 8) | r.data[3]) !== (address & 0xFFFF)) { staleCount++; continue; }
    return (r.data[4] << 8) | r.data[5];
  }
  lastCanReadFail = `連續 ${CAN_ID_MISMATCH_MAX_SKIP} 筆都不是本次回應（${describeCanSkips(foreignIds, staleCount)}）`;
  return null;
}

// write*Param() 回傳 false 時記錄失敗原因（供 log 顯示）；
// lastWriteRejected = 裝置明確拒絕或回填值不同 — 結果固定，呼叫端不必重試。
let lastWriteFail = null;
let lastWriteRejected = false;
// 最後一次採用的寫入回應訊框（hex），供 SAVE 等需要顯示回應內容的地方 log。
let lastWriteResp = null;

/** 判定一筆位址已比對相符的寫入回應。checkData=false 時不比對回填值（如 0x0555 SAVE）。 */
function acceptWriteEcho(rejected, echoed, sent, checkData) {
  if (rejected) {
    lastWriteFail = '裝置回 0x86：拒絕寫入';
    lastWriteRejected = true;
    return false;
  }
  // 韌體寫入成功時回填實際生效值；不同代表被截斷或修正（例如 uint8 寫入 >255）
  if (checkData && echoed !== sent) {
    lastWriteFail = `回填值 ${echoed} ≠ 寫入值 ${sent}`;
    lastWriteRejected = true;
    return false;
  }
  return true;
}

async function writeUartParam(address, data, checkData = true) {
  data &= 0xFFFF;
  lastWriteFail = null;
  lastWriteRejected = false;
  lastWriteResp = null;
  state.serial.clearBuffer();
  await state.serial.write(buildUartWrite(address, data));
  for (let skipped = 0; skipped < UART_STALE_MAX_SKIP; skipped++) {
    const frame = await state.serial.readUartFrame(skipped === 0 ? 1000 : 200);
    if (!frame) { lastWriteFail = '逾時無回應'; return false; }
    const r = parseUartResponse(frame);
    if (r.address === undefined) { lastWriteFail = r.error; return false; }
    // 功能碼須為寫入 (0x06 或其例外 0x86) 且位址回音相同，否則是殘留回應
    if ((r.func & 0x7F) !== 0x06 || r.address !== (address & 0xFFFF)) continue;
    lastWriteResp = hexBytes(frame);
    return acceptWriteEcho(!!r.error, r.data, data, checkData);
  }
  lastWriteFail = `連續 ${UART_STALE_MAX_SKIP} 筆都不是本次回應`;
  return false;
}

async function writeCanParam(address, data, checkData = true) {
  data &= 0xFFFF;
  lastWriteFail = null;
  lastWriteRejected = false;
  lastWriteResp = null;
  state.serial.clearBuffer();
  await state.serial.write(buildCanWrite(address, data));
  await sleep(10);
  // 同上：ID 不符就立即再讀一次，濾掉 bus 雜訊而不是直接判失敗。
  for (let skipped = 0; skipped < CAN_ID_MISMATCH_MAX_SKIP; skipped++) {
    const frame = await state.serial.readCanFrame(skipped === 0 ? 1000 : 500);
    if (!frame) { lastWriteFail = '逾時無回應'; return false; }
    const r = parseCanResponse(frame);
    if (!r || r.id !== 0x01005020) continue;
    if (r.data[1] === 0x86) {
      // 錯誤幀：data[2]=例外碼，位址在 data[3..4]（比成功幀多位移一格）
      if (r.data.length >= 5 && ((r.data[3] << 8) | r.data[4]) !== (address & 0xFFFF)) continue;
      lastWriteResp = `ID ${fmtHex(r.id, 8)} data ${hexBytes(r.data)}`;
      return acceptWriteEcho(true, 0, data, checkData);
    }
    // 成功幀：data[1]=0x06、data[2..3]=位址、data[4..5]=回填值；不符視為殘留回應
    if (r.data[1] !== 0x06 || r.data.length < 6) continue;
    if (((r.data[2] << 8) | r.data[3]) !== (address & 0xFFFF)) continue;
    lastWriteResp = `ID ${fmtHex(r.id, 8)} data ${hexBytes(r.data)}`;
    return acceptWriteEcho(false, (r.data[4] << 8) | r.data[5], data, checkData);
  }
  lastWriteFail = `連續 ${CAN_ID_MISMATCH_MAX_SKIP} 筆都不是本次回應`;
  return false;
}

// 0x0555 flash 旗標：寫 1 = 存檔、2 = 重載；完成後回 0，進行中為 1/2，其他非零 = 失敗。
const FLASH_FLAG_ADDR = 0x0555;
const FLASH_POLL_TIMEOUT_MS = 5000;

/**
 * 送出 0x0555 指令（1 = SAVE、2 = reLoad）並輪詢至完成。
 * 回傳 { ok, msg, resp, poll }：resp = 指令回應訊框（hex，無回應為 null），
 * poll = 輪詢經過（例如「1 → 1 → 0，3 次，612ms」，「—」代表該次無回應）。
 */
async function runFlashCommand(value) {
  const sent = state.isCAN
    ? await writeCanParam(FLASH_FLAG_ADDR, value, false)
    : await writeUartParam(FLASH_FLAG_ADDR, value, false);
  const resp = lastWriteResp;
  if (!sent) return { ok: false, msg: '指令未被接受（' + lastWriteFail + '）', resp, poll: null };

  const t0 = Date.now();
  const deadline = t0 + FLASH_POLL_TIMEOUT_MS;
  const trace = [];
  const result = (ok, msg) => ({
    ok, msg, resp,
    poll: `${trace.map(v => v === null ? '—' : v).join(' → ')}，${trace.length} 次，${Date.now() - t0}ms`,
  });
  let last = null;
  do {
    await sleep(200);
    const v = state.isCAN ? await readCanParam(FLASH_FLAG_ADDR) : await readUartParam(FLASH_FLAG_ADDR);
    trace.push(v);
    if (v === 0) return result(true, '');
    if (v !== null && v !== 1 && v !== 2) return result(false, `0x0555 = ${v}（韌體回報 flash 寫入失敗）`);
    if (v !== null) last = v;
  } while (Date.now() < deadline);
  return result(false,
    last === null ? '0x0555 讀取無回應' : `逾時 ${FLASH_POLL_TIMEOUT_MS / 1000}s，0x0555 仍為 ${last}（進行中）`);
}

/** 將 runFlashCommand 結果寫入 log：指令回應訊框 + 輪詢經過 + 成敗。 */
function logFlashResult(label, r) {
  log(`${label} 指令回應：${r.resp ?? '無'}`);
  if (r.poll) log(`${label} 0x0555 輪詢：${r.poll}`);
  log(r.ok ? `${label} 成功` : `${label} 失敗：${r.msg}`);
}

/** stopIf()：失敗後回傳 true 則不再重試（例如裝置明確拒絕，重試結果必然相同）。 */
// Reads SIG0~SIG3 from the device and decodes the 8-char SIG string.
// Returns { sig } on success, or { sig: null, failedIdx } on the first register that fails.
async function readDeviceSig() {
  const items = [];
  for (let i = 0; i < 4; i++) {
    const addr = state.hrList.length >= 4 ? state.hrList[i].address : i;
    const val = await retryOp(3, () =>
      state.isCAN ? readCanParam(addr) : readUartParam(addr),
      () => state.isCAN && lastCanReadRejected
    );
    if (val === null || val === false) return { sig: null, failedIdx: i };
    items.push({ data: val });
  }
  return { sig: decodeSig(items) };
}

async function retryOp(maxRetries, fn, stopIf = null) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await fn();
      if (result !== null && result !== false) return result;
      if (result === false) {
        // write returned false — still retry
      }
      if (stopIf?.()) return null;
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

  // Edit whichever single list is currently on screen — 副/paraList when
  // comparing and this address has a paraList entry, otherwise 主/hrList.
  // Matches the write-parameters source rule (list = showPara ? paraList : hrList)
  // so confirming here never silently mutates the list you're NOT looking at.
  const paraEntry  = state.showPara ? state.paraList.find(p => p.address === item.address) : null;
  const displayItem = paraEntry ? { ...item, data: paraEntry.data } : item;

  const newVal = await openSetbitModal(displayItem);
  if (newVal === null) return;

  if (paraEntry) paraEntry.data = newVal;
  else           item.data = newVal;

  refreshAllDisplays(state);
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
  localStorage.setItem(lsParamKey(currentModel()), iniText);
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

// ── Torque sensor bus command (0x08F20020 D0=F0/F1) ──
// The sensor broadcasts 0x18F50133 (D0=0xFF) on its own; seeing that frame on
// the bus is taken as proof the sensor is fitted. Both commands are sent
// straight away; after Silent (F0) the bus is polled until the broadcast
// stops, after Resume (F1) it is listened to once to confirm it is back.

/** Listen for torque sensor broadcasts for `ms`. Returns { count, last } (last = data bytes or null). */
async function tsListen(ms) {
  state.serial.clearBuffer();
  const deadline = Date.now() + ms;
  let count = 0, last = null;
  for (let left = ms; left > 0; left = deadline - Date.now()) {
    const frame = await state.serial.readCanFrame(left);
    if (!frame) break;
    const r = parseCanResponse(frame);
    if (r && r.id === TORQUE_SENSOR_RX && r.len >= 8 && r.data[0] === 0xFF) { count++; last = r.data; }
  }
  return { count, last };
}

function tsDescribe(d) {
  const torque = ((d[4] >> 6) << 8) | d[2];
  const temp   = d[1] <= 210 ? (d[1] - 30) + '°C' : '—';
  return `Torque=${torque}  Cadence=${d[3]}  Temp=${temp}`;
}

function tsListenMs() {
  // BLE bridge batches notifications, so allow a longer window
  return state.serial === state.bleSerial ? 1500 : 1000;
}

/**
 * Sidebar torque sensor status. kind: 'unknown' (not checked / disconnected),
 * 'ok' (broadcast received), 'none' (nothing received), 'silent' (silenced by F0).
 */
function setTsStatus(kind, detail = '') {
  const text = { unknown: '未偵測', ok: '✔ 有訊號', none: '✖ 訊號斷訊', silent: '⏸ 已靜默' }[kind];
  const box = document.getElementById('tsStatus');
  box.className = 'ts-status' + (kind === 'unknown' ? '' : ' ' + kind);
  document.getElementById('tsStatusText').textContent = '力矩感測器：' + text;
  document.getElementById('tsStatusSub').textContent = kind === 'unknown' ? '' :
    [detail, new Date().toLocaleTimeString('zh-TW', { hour12: false })].filter(Boolean).join('  ');
  if (kind !== 'unknown') {
    void box.offsetWidth;   // restart the flash animation on every update
    box.classList.add('flash');
  }
}

function tsCheckReady() {
  if (!state.isCAN) { alert('僅支援 CAN 模式\n請先選擇 CAN 並開啟序列埠'); return false; }
  if (!state.serial.isOpen) { alert('請先開啟序列埠'); return false; }
  return true;
}

let tsToastTimer = null;

/** Pop-up banner at the top of the page; click to dismiss, auto-hides after 5 s. */
function showTsToast(kind, title, sub) {
  const el = document.getElementById('tsToast');
  el.className = 'ts-toast ' + kind;
  document.getElementById('tsToastTitle').textContent = title;
  document.getElementById('tsToastSub').textContent = sub;
  el.hidden = false;
  clearTimeout(tsToastTimer);
  tsToastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}
document.getElementById('tsToast').addEventListener('click', (e) => { e.currentTarget.hidden = true; });

/** Listen for the torque sensor broadcast and update the sidebar status. auto = run on connect. */
// "Auto silent" checkbox: once a detection sees the sensor, send F0 straight away.
// Checked by default; the user's last choice is remembered per browser (a
// convenience only — falls back to checked when nothing is stored).
const LS_TS_AUTO_SILENT = 'endex_ts_auto_silent';
const chkTsAutoSilent = document.getElementById('chkTsAutoSilent');
try {
  const saved = localStorage.getItem(LS_TS_AUTO_SILENT);
  if (saved !== null) chkTsAutoSilent.checked = saved === '1';
} catch {}
chkTsAutoSilent.addEventListener('change', () => {
  try { localStorage.setItem(LS_TS_AUTO_SILENT, chkTsAutoSilent.checked ? '1' : '0'); } catch {}
});

// Auto silent runs only once per connection: set when it has confirmed the sensor
// went silent, cleared on disconnect (setDot(false)).
let tsAutoSilentDone = false;

async function tsDetect(auto = false) {
  const ms = tsListenMs();
  let found = false;
  setBusy(true);
  try {
    if (auto) log(`偵測力矩感測器廣播 0x18F50133（${ms} ms）...`);
    const r = await tsListen(ms);
    if (r.count) {
      found = true;
      setTsStatus('ok', `(${r.count} 筆)`);
      log(`✓ 力矩感測器 0x18F50133：${ms} ms 內收到 ${r.count} 筆  ${tsDescribe(r.last)}`);
      showTsToast('ok', '✔ 偵測到力矩感測器訊號', `0x18F50133  ${ms} ms 內收到 ${r.count} 筆  ${tsDescribe(r.last)}`);
    } else {
      setTsStatus('none');
      log(`✖ 力矩感測器訊號斷訊：0x18F50133 ${ms} ms 內未收到（未接、或已靜默）`);
      showTsToast('none', '✖ 力矩感測器訊號斷訊', `0x18F50133  ${ms} ms 內未收到（未接、或已靜默）`);
    }
  } catch (e) {
    log('力矩感測器偵測失敗: ' + e.message);
  } finally {
    setBusy(false);
  }
  if (found && chkTsAutoSilent.checked && state.serial.isOpen) {
    if (tsAutoSilentDone) {
      log('本次連線已自動靜默過一次，不再自動靜默（需要時請按「靜默 (F0)」）');
    } else {
      log('已勾選「偵測到力矩感測器自動靜默」→ 自動送出靜默 (F0)');
      if (await tsRunBusCmd(TS_BUS_SILENT)) tsAutoSilentDone = true;
    }
  }
}

document.getElementById('btnTsDetect').addEventListener('click', () => {
  if (tsCheckReady()) tsDetect();
});

/**
 * After F0: keep listening in short windows until one window passes with no
 * 0x18F50133 frame (sensor has gone silent), or give up after TS_SILENT_TIMEOUT_MS.
 */
const TS_SILENT_TIMEOUT_MS = 10000;

/** Returns true once the broadcast has stopped, false if it was still running at the timeout. */
async function tsWaitSilent(sentAt) {
  // Window must comfortably exceed the broadcast period (~15 ms) plus BLE notify batching
  const win = state.serial === state.bleSerial ? 500 : 300;
  log(`自動偵測力矩感測器，直到無訊號（每輪 ${win} ms，最多 ${TS_SILENT_TIMEOUT_MS / 1000} 秒）...`);
  let total = 0, last = null;
  while (Date.now() - sentAt < TS_SILENT_TIMEOUT_MS) {
    const r = await tsListen(win);
    if (!r.count) {
      // Sensor stopped somewhere before this empty window began
      const stopMs = Date.now() - sentAt - win;
      setTsStatus('silent');
      if (total) {
        log(`✅ 力矩感測器已靜默：送出後約 ${stopMs} ms 停止廣播（停止前收到 ${total} 筆）`);
        showTsToast('silent', '⏸ 力矩感測器已靜默', `送出 F0 後約 ${stopMs} ms 停止廣播 0x18F50133`);
      } else {
        log('✅ 送出後未收到任何 0x18F50133（已靜默，或未接力矩感測器）');
        showTsToast('silent', '⏸ 力矩感測器無訊號', '送出 F0 後未收到 0x18F50133（已靜默，或未接感測器）');
      }
      return true;
    }
    total += r.count;
    last = r.last;
    setTsStatus('ok', `(靜默中… ${total} 筆)`);
  }
  setTsStatus('ok', `(${total} 筆)`);
  log(`⚠ 送出 F0 後 ${TS_SILENT_TIMEOUT_MS / 1000} 秒內仍持續收到 0x18F50133（${total} 筆），靜默未生效  ${tsDescribe(last)}`);
  showTsToast('none', '⚠ 力矩感測器靜默未生效', `送出 F0 後 ${TS_SILENT_TIMEOUT_MS / 1000} 秒內仍收到 ${total} 筆 0x18F50133`);
  return false;
}

async function tsRunBusCmd(cmd) {
  if (!tsCheckReady()) return;
  const silent = cmd === TS_BUS_SILENT;
  const label  = silent ? '靜默 (F0)' : '恢復 (F1)';
  const ms     = tsListenMs();
  setBusy(true);
  try {
    log(`--- 力矩感測器 ${label} ---`);
    await state.serial.write(buildTorqueSensorBusCmd(cmd));
    const sentAt = Date.now();
    log(`已送出總線命令 0x08F20020 D0=0x${cmd.toString(16).toUpperCase()}`);
    if (silent) {
      return await tsWaitSilent(sentAt);
    }
    await sleep(100);
    const after = await tsListen(ms);
    setTsStatus(after.count ? 'ok' : 'none', after.count ? `(${after.count} 筆)` : '');
    log(after.count ? `✅ 力矩感測器已恢復廣播：${after.count} 筆  ${tsDescribe(after.last)}`
                    : `⚠ 送出後 ${ms} ms 內未收到 0x18F50133（感測器可能未接或尚未恢復）`);
  } catch (e) {
    log(`力矩感測器 ${label} 失敗: ` + e.message);
  } finally {
    setBusy(false);
  }
}

document.getElementById('btnTsSilent').addEventListener('click', () => tsRunBusCmd(TS_BUS_SILENT));
document.getElementById('btnTsResume').addEventListener('click', () => tsRunBusCmd(TS_BUS_RESUME));

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
  document.getElementById('btnCheckFw').disabled = busy;
  document.getElementById('btnLoadHex').disabled = busy;
  updateUiState();
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
  updateUiState();
  setBurnProgress(0);
  log('已載入 HEX: ' + fileName + (burnState.newVersion ? '  新版本: ' + burnState.newVersion : ''));
}

// ── Helpers ───────────────────────────────────────────────

/**
 * Read CAN frames until one with `id` arrives or `timeoutMs` runs out, skipping
 * frames with other IDs (e.g. torque sensor / battery broadcasts that share the bus).
 * Returns { r, skipped } — r = parseCanResponse() result or null on timeout,
 * skipped = IDs of the frames passed over.
 */
async function readCanFrameById(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const skipped = [];
  for (let left = timeoutMs; left > 0; left = deadline - Date.now()) {
    const frame = await state.serial.readCanFrame(left);
    if (!frame) break;
    const r = parseCanResponse(frame);
    if (r && r.id === id) return { r, skipped };
    if (r) skipped.push(r.id);
  }
  return { r: null, skipped };
}

async function burnCheckFirmware(sig) {
  // Returns 0=bootloader, 1=app, 2=error/timeout
  try {
    state.serial.clearBuffer();
    if (state.isCAN) {
      await state.serial.write(buildBurnCanCheckFw(sig));
      await sleep(1);
      const { r, skipped } = await readCanFrameById(0x000000B3, 3000);
      if (!r) {
        log('check_Firmware: 無回應' + (skipped.length ? `（期間略過 ${describeCanSkips(skipped, 0)}）` : ''));
        return 2;
      }
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

/**
 * 比對 HEX 檔 SIG 與裝置 SIG0~SIG3。App 模式的韌體回應 check_fw 時不驗 SIG，
 * 所以 HEX 與裝置是否相符必須由這裡另外確認。
 * Returns 'match' | 'mismatch' | 'unknown'（讀不到裝置 SIG，例如停在 Bootloader）。
 */
async function verifyHexSigWithDevice() {
  // BLE bridge (ESP32) enables a CAN ID filter once it sees a 0x03002050
  // param command, which then drops the 0xB2/0xB3 burn frames — so over BLE
  // the device SIG is not read here.
  if (state.serial === state.bleSerial) {
    log('BLE 模式：略過讀取裝置 SIG0~SIG3 比對（避免觸發 ESP32 CAN ID 過濾）');
    return 'unknown';
  }
  // Readable order (no UART reversal), same form as decodeSig()
  const hexSig = Array.from(burnGetSig(burnState.lines[0], false))
    .map(b => String.fromCharCode(b)).join('');
  const dev = await readDeviceSig();
  if (dev.sig === null || dev.sig.length !== 8) {
    log('⚠ 無法讀取裝置 SIG（裝置可能停在 Bootloader），略過 HEX / 裝置 SIG 比對');
    return 'unknown';
  }
  log('SIG（裝置）: ' + dev.sig);
  if (dev.sig !== hexSig) {
    log(`❌ SIG 不符：HEX 檔為 ${hexSig}，裝置為 ${dev.sig}，此 HEX 不適用於這台裝置`);
    return 'mismatch';
  }
  return 'match';
}

async function burnJumpToBootLoader(sig) {
  try {
    state.serial.clearBuffer();
    log('Jump to BootLoader...');
    if (state.isCAN) {
      await state.serial.write(buildBurnCanJumpBoot(sig));
      const { r, skipped } = await readCanFrameById(0x000000B5, 5000);
      if (!r) {
        log('Jump to BootLoader: 無回應' + (skipped.length ? `（期間略過 ${describeCanSkips(skipped, 0)}）` : ''));
        return false;
      }
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
          log(`Chunk error, retry...  (offset ${i}, ACK: ${hexBytes(ack)})`);
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

  setBurnBusy(true);
  log('--- Check Firmware ---');
  try {
    // SIG source: the loaded HEX (checked against the device's SIG0~SIG3),
    // otherwise SIG0~SIG3 read from the device itself.
    let sig;
    if (burnState.lines.length) {
      sig = burnGetSig(burnState.lines[0], !state.isCAN);
      if (!sig) { log('❌ SIG 解析失敗：HEX 檔第一行格式不符'); return; }
      log('SIG（HEX 檔）: ' + Array.from(burnGetSig(burnState.lines[0], false))
        .map(b => String.fromCharCode(b)).join(''));
      if (await verifyHexSigWithDevice() === 'mismatch') {
        log('結果: ❌ HEX 與裝置 SIG 不符');
        return;
      }
    } else if (state.serial === state.bleSerial) {
      // Reading SIG0~SIG3 over BLE would trigger the ESP32 CAN ID filter (see verifyHexSigWithDevice)
      log('❌ BLE 模式不讀取裝置 SIG，請先載入 HEX 檔後再檢查');
      return;
    } else {
      const dev = await readDeviceSig();
      if (dev.sig === null || dev.sig.length !== 8) {
        log('❌ 無法讀取裝置 SIG' + (dev.sig === null ? dev.failedIdx : '') +
            '（裝置可能停在 Bootloader），請載入 HEX 檔後再檢查');
        return;
      }
      log('SIG（裝置）: ' + dev.sig);
      // Same byte order as burnGetSig(): UART takes the SIG reversed, CAN as-is
      const s = state.isCAN ? dev.sig : dev.sig.split('').reverse().join('');
      sig = new Uint8Array(s.split('').map(c => c.charCodeAt(0)));
    }
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
    log('SIG（HEX 檔）: ' + Array.from(burnGetSig(burnState.lines[0], false))
      .map(b => String.fromCharCode(b)).join(''));
    // 讀不到裝置 SIG（停在 Bootloader）時仍允許燒錄，以便救回燒錄中斷的裝置
    if (await verifyHexSigWithDevice() === 'mismatch') {
      log('❌ 燒錄中止：HEX 與裝置 SIG 不符');
      return;
    }

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

    // Ask the torque sensor to resume once the new firmware is up. Sent whenever
    // checked: the page can't know whether the sensor was silenced (F0 may have
    // been sent before a reload or by another tool), and F1 is harmless otherwise.
    if (jumpOk && state.isCAN && document.getElementById('chkTsResumeAfterBurn').checked) {
      log('已勾選「燒錄完成後恢復力矩感測器」→ 自動送出恢復 (F1)');
      await tsRunBusCmd(TS_BUS_RESUME);
    }

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
initResultModal();
initWriteConfirmModal();

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
  // Burn mode follows the channel: BLE → BLE-CAN with 248-byte chunks, COM port → standard.
  // Still changeable by hand afterwards.
  document.getElementById('selBurnMode').value = isBle ? 'blecan' : 'uart';
  if (isBle) document.getElementById('selBleChunk').value = '248';
  applyBurnModeSelection(document.getElementById('selBurnMode').value);
  // Wire up BLE unexpected-disconnect handler (set once; no-op for comport)
  state.bleSerial.onDisconnect = () => {
    setDot(false);
    log('⚠ BLE 連線意外中斷');
  };
  state.bleSerial._onLog = (msg) => log(msg);
  updateUiState();
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

// ── Model selection (parameter.ini variant) ──
document.getElementById('selModel').value = localStorage.getItem(LS_MODEL) || '';
document.getElementById('selModel').addEventListener('change', (e) => {
  // Only a real user interaction fires 'change' (programmatic .value = ... in
  // the auto-switch path below does not), so this reliably marks "the user
  // deliberately picked this model" and disables further auto-switching.
  state.modelUserSelected = true;
  localStorage.setItem(LS_MODEL, e.target.value);
  log('機種切換 → ' + (e.target.options[e.target.selectedIndex].text) + '，重新載入 parameter.ini...');
  autoLoadIni();
});

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
updateUiState();

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
