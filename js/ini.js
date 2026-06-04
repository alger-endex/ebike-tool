/**
 * ini.js — INI file parser / serialiser
 */

/** Low-level parser: returns { [section]: { [key]: value } } */
function parseIni(text) {
  const sections = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sm = line.match(/^\[(.+)\]$/);
    if (sm) {
      current = sm[1].trim();
      sections[current] = {};
    } else if (current) {
      const eq = line.indexOf('=');
      if (eq >= 0) {
        sections[current][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
  }
  return sections;
}

/**
 * Parse page.ini → Array<{ pageName, pageNum }>
 */
function parsePageIni(text) {
  const ini = parseIni(text);
  const tabs = [];
  let k = 0;
  while (ini[`Section${k}`]) {
    const s = ini[`Section${k}`];
    tabs.push({
      pageName: s['Key_pagename'] ?? '',
      pageNum:  s['Key_pagenum']  ?? '',
    });
    k++;
  }
  return tabs;
}

/**
 * Parse parameter.ini → Array<HRItem>
 *
 * HRItem shape:
 *   name, address (uint16), data (int, runtime value),
 *   unit, upperBound, lowerBound, tooltip,
 *   writeable, hidden, setBit, production
 *   + UI refs: nameEl, valueEl, unitEl, hexChkEl  (set by ui.js)
 */
function parseParameterIni(text) {
  const ini = parseIni(text);
  const items = [];
  let i = 0;
  while (ini[`Section${i}`]) {
    const s = ini[`Section${i}`];
    if (s['Key_address'] == null) break;
    items.push(makeHRItem(s));
    i++;
  }
  return items;
}

function makeHRItem(s) {
  return {
    name:       s['Key_name']       ?? '',
    address:    parseInt(s['Key_address'] ?? '0', 16),
    data:       0,
    unit:       s['Key_unit']       ?? '',
    upperBound: parseInt(s['Key_upperbound'] ?? '65535'),
    lowerBound: parseInt(s['Key_lowerbound'] ?? '0'),
    tooltip:    s['Key_tooltip']    ?? '',
    writeable:  parseBool(s['Key_writeable']),
    hidden:     parseBool(s['Key_hidden']),
    setBit:     parseBool(s['Key_setbit']),
    production: parseBool(s['Key_production']),
    // UI element references — filled in by ui.js
    nameEl:   null,
    valueEl:  null,
    unitEl:   null,
    hexChkEl: null,
  };
}

function parseBool(v) {
  return (v ?? 'false').toLowerCase() === 'true';
}

/**
 * Serialise an array of HRItems back to parameter.ini format.
 * Items are expected to be pre-sorted by address.
 */
function serializeParameterIni(items) {
  let out = '';
  items.forEach((item, i) => {
    out += `[Section${i}]\r\n`;
    out += `Key_name=${item.name}\r\n`;
    out += `Key_address=${item.address.toString(16).toUpperCase().padStart(4, '0')}\r\n`;
    out += `Key_unit=${item.unit}\r\n`;
    out += `Key_upperbound=${item.upperBound}\r\n`;
    out += `Key_lowerbound=${item.lowerBound}\r\n`;
    out += `Key_tooltip=${item.tooltip ?? ''}\r\n`;
    out += `Key_writeable=${item.writeable}\r\n`;
    out += `Key_hidden=${item.hidden}\r\n`;
    out += `Key_setbit=${item.setBit}\r\n`;
    out += `Key_production=${item.production}\r\n`;
  });
  return out;
}

/**
 * Parse a CONFIG TXT file (each line: "AAAADDDD" hex).
 * Returns Array<{ address, data }>.
 */
function parseConfigTxt(text) {
  const result = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 8) continue;
    result.push({
      address: parseInt(line.slice(0, 4), 16),
      data:    parseInt(line.slice(4, 8), 16),
    });
  }
  return result;
}

/**
 * Serialise an array of { address, data } to CONFIG TXT format.
 */
function serializeConfigTxt(items) {
  return items
    .map(i =>
      i.address.toString(16).toUpperCase().padStart(4, '0') +
      (i.data & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')
    )
    .join('\r\n') + '\r\n';
}
