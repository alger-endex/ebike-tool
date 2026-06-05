/**
 * ui.js — Dynamic Tab / Parameter UI generation, SetBit modal, Config editor modal
 */

// ─────────────────────────────────────────────────────────────
//  Tab + parameter panel generation
// ─────────────────────────────────────────────────────────────

function generateTabs(state, onParamChange, onSetBitClick) {
  const bar    = document.getElementById('tabBar');
  const panels = document.getElementById('tabPanels');
  const tabCtl = document.getElementById('tabControl');
  const hint   = document.getElementById('emptyHint');

  bar.innerHTML    = '';
  panels.innerHTML = '';

  if (state.tabList.length === 0 || state.hrList.length === 0) {
    tabCtl.style.display = 'none';
    hint.style.display   = '';
    return;
  }
  tabCtl.style.display = '';
  hint.style.display   = 'none';

  let firstActiveSet = false;

  state.tabList.forEach(function(tab, tabIdx) {
    if (!state.engineeringMode && tabIdx === 0) return;

    const btn = document.createElement('button');
    btn.className   = 'tab-btn';
    btn.textContent = tab.pageName;
    btn.dataset.tab = tabIdx;
    bar.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.id = 'panel-' + tabIdx;

    const items = state.hrList
      .map(function(item, idx) { return { item: item, idx: idx }; })
      .filter(function(o) {
        const addrHex = o.item.address.toString(16).toUpperCase().padStart(4, '0');
        return addrHex.startsWith(tab.pageNum.toUpperCase());
      });

    const visibleItems = items.filter(function(o) {
      return state.engineeringMode ? true : !o.item.hidden;
    });

    let col = null;
    visibleItems.forEach(function(o, visIdx) {
      if (visIdx % 8 === 0) {
        col = document.createElement('div');
        col.className = 'param-col';
        panel.appendChild(col);
      }
      col.appendChild(buildParamRow(o.item, o.idx, onParamChange, onSetBitClick));
    });

    panels.appendChild(panel);

    if (!firstActiveSet) {
      btn.classList.add('active');
      panel.classList.add('active');
      firstActiveSet = true;
    }
  });

  bar.addEventListener('click', function(e) {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    bar.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
    panels.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
    btn.classList.add('active');
    const p = document.getElementById('panel-' + btn.dataset.tab);
    if (p) p.classList.add('active');
  });

  refreshAllDisplays(state);
}

function buildParamRow(item, idx, onParamChange, onSetBitClick) {
  const row = document.createElement('div');
  row.className = 'param-row';

  const addrHex = item.address.toString(16).toUpperCase().padStart(4, '0');
  const nameEl  = document.createElement('span');
  nameEl.className = 'param-name' + (item.setBit ? ' setbit-name' : '');
  nameEl.textContent = item.name + ' (0x' + addrHex + ')';
  nameEl.dataset.idx = idx;
  if (item.tooltip) nameEl.title = item.tooltip.replace(/\\n/g, '\n');
  if (item.setBit) {
    nameEl.addEventListener('click', function() { onSetBitClick(idx); });
  }
  item.nameEl = nameEl;

  const valWrap = document.createElement('div');
  valWrap.className = 'param-val-wrap';
  let valueEl;
  if (item.writeable) {
    valueEl = document.createElement('input');
    valueEl.type = 'text';
    valueEl.dataset.idx = idx;
    valueEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') commitInput(item, idx, valueEl.value, onParamChange);
    });
    valueEl.addEventListener('blur', function() {
      commitInput(item, idx, valueEl.value, onParamChange);
    });
  } else {
    valueEl = document.createElement('span');
    valueEl.className = 'readonly-val';
  }
  valWrap.appendChild(valueEl);
  item.valueEl = valueEl;

  const unitEl = document.createElement('span');
  unitEl.className   = 'param-unit';
  unitEl.textContent = item.unit;
  item.unitEl = unitEl;

  const hexWrap = document.createElement('label');
  hexWrap.className = 'hex-chk-wrap';
  const hexChk = document.createElement('input');
  hexChk.type = 'checkbox';
  hexChk.dataset.idx = idx;
  hexChk.addEventListener('change', function() { refreshParamDisplay(item); });
  item.hexChkEl = hexChk;
  hexWrap.appendChild(hexChk);
  hexWrap.appendChild(document.createTextNode('Hex'));

  row.appendChild(nameEl);
  row.appendChild(valWrap);
  row.appendChild(unitEl);
  row.appendChild(hexWrap);
  return row;
}

function commitInput(item, idx, rawValue, onParamChange) {
  if (!rawValue || rawValue.trim() === '') return;
  const isHex = item.hexChkEl && item.hexChkEl.checked;
  const val = isNaN(rawValue) ? NaN : (isHex ? parseInt(rawValue, 16) : parseInt(rawValue, 10));
  if (isNaN(val)) return;
  const clamped = Math.max(item.lowerBound, Math.min(item.upperBound, val));
  item.data = clamped;
  refreshParamDisplay(item);
  if (onParamChange) onParamChange(idx, clamped);
}

// ─────────────────────────────────────────────────────────────
//  Display refresh helpers
// ─────────────────────────────────────────────────────────────

function refreshParamDisplay(item) {
  if (!item.valueEl) return;
  const isHex = item.hexChkEl && item.hexChkEl.checked;
  const text  = isHex
    ? (item.data & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')
    : item.data.toString();

  if (item.writeable && item.valueEl.tagName === 'INPUT') {
    if (document.activeElement !== item.valueEl) item.valueEl.value = text;
    const inRange = item.data >= item.lowerBound && item.data <= item.upperBound;
    item.valueEl.classList.toggle('out-of-range', !inRange);
  } else {
    item.valueEl.textContent = text;
  }
}

function refreshAllDisplays(state) {
  const paraList = state.showPara ? state.paraList : null;
  state.hrList.forEach(function(item) {
    if (!item.valueEl) return;
    const isHex = item.hexChkEl && item.hexChkEl.checked;

    let displayData = item.data;
    let fromPara = false;
    if (paraList) {
      const para = paraList.find(function(p) { return p.address === item.address; });
      if (para !== undefined) { displayData = para.data; fromPara = true; }
    }

    const text = isHex
      ? (displayData & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')
      : displayData.toString();

    if (item.writeable && item.valueEl.tagName === 'INPUT') {
      if (document.activeElement !== item.valueEl) item.valueEl.value = text;
    } else {
      item.valueEl.textContent = text;
    }

    item.valueEl.classList.toggle('val-from-para',     paraList !== null &&  fromPara);
    item.valueEl.classList.toggle('val-from-fallback', paraList !== null && !fromPara);
  });
}

// ─────────────────────────────────────────────────────────────
//  SetBit modal
// ─────────────────────────────────────────────────────────────

var _setbitResolve = null;

function openSetbitModal(item) {
  return new Promise(function(resolve) {
    _setbitResolve = resolve;

    const modal   = document.getElementById('modalSetBit');
    const title   = document.getElementById('setbitTitle');
    const grid    = document.getElementById('setbitGrid');
    const preview = document.getElementById('setbitPreview');

    title.textContent = item.name + '  (0x' + item.address.toString(16).toUpperCase().padStart(4, '0') + ')';
    grid.innerHTML = '';

    const bitLabels = {};
    if (item.tooltip) {
      item.tooltip.split(/\\n/).forEach(function(part) {
        const m = part.match(/^bit(\d+)\s*(.*)/i);
        if (m) bitLabels[parseInt(m[1])] = 'bit' + m[1] + ' ' + m[2].trim();
      });
    }

    const checkboxes = [];
    for (let bit = 15; bit >= 0; bit--) {
      const rowEl = document.createElement('div');
      rowEl.className = 'setbit-row';

      const cb  = document.createElement('input');
      cb.type   = 'checkbox';
      cb.id     = 'sb_bit' + bit;
      cb.checked = ((item.data >> bit) & 1) === 1;
      cb.dataset.bit = bit;

      const lbl = document.createElement('label');
      lbl.htmlFor     = 'sb_bit' + bit;
      lbl.textContent = bitLabels[bit] || ('bit' + bit);

      cb.addEventListener('change', function() { updateSetbitPreview(checkboxes, preview); });

      rowEl.appendChild(cb);
      rowEl.appendChild(lbl);
      grid.appendChild(rowEl);
      checkboxes.push(cb);
    }

    updateSetbitPreview(checkboxes, preview);
    modal.style.display = 'flex';
  });
}

function updateSetbitPreview(checkboxes, preview) {
  let val = 0;
  checkboxes.forEach(function(cb) {
    if (cb.checked) val |= (1 << parseInt(cb.dataset.bit));
  });
  preview.textContent = 'HEX: 0x' + val.toString(16).toUpperCase().padStart(4, '0') + '   DEC: ' + val;
}

function collectSetbitValue() {
  let val = 0;
  document.querySelectorAll('#setbitGrid input[type="checkbox"]').forEach(function(cb) {
    if (cb.checked) val |= (1 << parseInt(cb.dataset.bit));
  });
  return val;
}

function initSetbitModal() {
  document.getElementById('btnSetbitOK').addEventListener('click', function() {
    const val = collectSetbitValue();
    document.getElementById('modalSetBit').style.display = 'none';
    if (_setbitResolve) { _setbitResolve(val); _setbitResolve = null; }
  });
  document.querySelectorAll('[data-close="modalSetBit"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.getElementById('modalSetBit').style.display = 'none';
      if (_setbitResolve) { _setbitResolve(null); _setbitResolve = null; }
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  Config editor modal
// ─────────────────────────────────────────────────────────────

var _configResolve = null;

function openConfigModal(hrList) {
  return new Promise(function(resolve) {
    _configResolve = resolve;
    const wrap = document.getElementById('configTableWrap');
    wrap.innerHTML = '';
    wrap.appendChild(buildConfigTable(hrList));
    document.getElementById('modalConfig').style.display = 'flex';
  });
}

const CFG_COLS = [
  { key: 'name',       label: 'Name',       type: 'text',     width: '120px' },
  { key: 'address',    label: 'Address',    type: 'hex',      width: '70px'  },
  { key: 'unit',       label: 'Unit',       type: 'text',     width: '50px'  },
  { key: 'upperBound', label: 'Upper',      type: 'num',      width: '60px'  },
  { key: 'lowerBound', label: 'Lower',      type: 'num',      width: '60px'  },
  { key: 'tooltip',    label: 'Tooltip',    type: 'text',     width: '200px' },
  { key: 'writeable',  label: 'Writeable',  type: 'bool',     width: '70px'  },
  { key: 'hidden',     label: 'Hidden',     type: 'bool',     width: '60px'  },
  { key: 'setBit',     label: 'SetBit',     type: 'bool',     width: '60px'  },
  { key: 'production', label: 'Production', type: 'readonly', width: '80px'  },
];

function buildConfigTable(hrList) {
  const table = document.createElement('table');
  table.className = 'cfg-table';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  CFG_COLS.forEach(function(col) {
    const th = document.createElement('th');
    th.textContent    = col.label;
    th.style.minWidth = col.width;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  hrList.forEach(function(item, rowIdx) {
    tbody.appendChild(buildConfigRow(item, rowIdx));
  });
  table.appendChild(tbody);

  tbody.addEventListener('click', function(e) {
    const tr = e.target.closest('tr');
    if (!tr) return;
    tbody.querySelectorAll('tr').forEach(function(r) { r.classList.remove('selected'); });
    tr.classList.add('selected');
  });

  return table;
}

function buildConfigRow(item, rowIdx) {
  const tr = document.createElement('tr');
  tr.dataset.row = rowIdx;
  CFG_COLS.forEach(function(col) {
    const td = document.createElement('td');
    if (col.type === 'readonly') {
      td.className   = 'readonly-col';
      td.textContent = item[col.key].toString();
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.dataset.key = col.key;
      inp.value = (col.type === 'hex')
        ? item.address.toString(16).toUpperCase().padStart(4, '0')
        : item[col.key].toString();
      inp.addEventListener('input', function() { validateConfigCell(inp, col); });
      td.appendChild(inp);
    }
    tr.appendChild(td);
  });
  return tr;
}

function validateConfigCell(inp, col) {
  const v = inp.value.trim();
  let ok = true;
  if (col.type === 'hex') ok = /^[0-9A-Fa-f]{1,4}$/.test(v);
  else if (col.type === 'num') { const n = parseInt(v); ok = !isNaN(n) && n >= 0 && n <= 65535; }
  else if (col.type === 'bool') ok = v.toLowerCase() === 'true' || v.toLowerCase() === 'false';
  inp.classList.toggle('err', !ok);
}

function readConfigTable() {
  const tbody = document.querySelector('.cfg-table tbody');
  if (!tbody) return null;
  const items = [];
  let hasError = false;
  tbody.querySelectorAll('tr').forEach(function(tr) {
    const item = { data: 0, nameEl: null, valueEl: null, unitEl: null, hexChkEl: null };
    tr.querySelectorAll('td').forEach(function(td) {
      const inp = td.querySelector('input');
      if (!inp) { item.production = td.textContent.trim().toLowerCase() === 'true'; return; }
      const key = inp.dataset.key;
      const col = CFG_COLS.find(function(c) { return c.key === key; });
      validateConfigCell(inp, col);
      if (inp.classList.contains('err')) { hasError = true; return; }
      const v = inp.value.trim();
      if      (col.type === 'hex')  item.address = parseInt(v, 16);
      else if (col.type === 'num')  item[key]    = parseInt(v);
      else if (col.type === 'bool') item[key]    = v.toLowerCase() === 'true';
      else                          item[key]    = v;
    });
    items.push(item);
  });
  if (hasError) return null;
  items.sort(function(a, b) { return a.address - b.address; });
  return items;
}

function initConfigModal() {
  document.getElementById('btnConfigOK').addEventListener('click', function() {
    const items = readConfigTable();
    if (items === null) { alert('請修正表格中標紅色的欄位！'); return; }
    document.getElementById('modalConfig').style.display = 'none';
    if (_configResolve) { _configResolve(items); _configResolve = null; }
  });

  document.getElementById('btnConfigDel').addEventListener('click', function() {
    const tbody = document.querySelector('.cfg-table tbody');
    const sel   = tbody && tbody.querySelector('tr.selected');
    if (sel) sel.remove();
  });

  document.getElementById('btnConfigAdd').addEventListener('click', function() {
    const tbody = document.querySelector('.cfg-table tbody');
    if (!tbody) return;
    const newItem = {
      name: 'NEW', address: 0, unit: '', upperBound: 65535, lowerBound: 0,
      tooltip: '', writeable: false, hidden: false, setBit: false, production: false,
    };
    tbody.appendChild(buildConfigRow(newItem, tbody.querySelectorAll('tr').length));
  });

  document.querySelectorAll('[data-close="modalConfig"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.getElementById('modalConfig').style.display = 'none';
      if (_configResolve) { _configResolve(null); _configResolve = null; }
    });
  });
}
