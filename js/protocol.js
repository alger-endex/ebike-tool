/**
 * protocol.js — UART & CAN packet builders / parsers
 *
 * UART CRC  : sum of bytes[1..len-1]  (GetCRC in original)
 * CAN wrapper: Tool_R  0xFA 0x0D + ID(4B LE) + Len(1B) + Data(8B) = 15 bytes total
 */

// ─────────────────────────────────────────────────────────────
//  UART helpers
// ─────────────────────────────────────────────────────────────

/** CRC = sum of pkt[1..len-1] */
function uartCrc(pkt, len) {
  let crc = 0;
  for (let i = 1; i < len; i++) crc = (crc + pkt[i]) & 0xFFFF;
  return crc;
}

/** Build UART read request */
function buildUartRead(address) {
  const p = new Uint8Array(12);
  p[0] = 0x3A; p[1] = 0x2B; p[2] = 0x03; p[3] = 0x04;
  p[4] = (address >> 8) & 0xFF; p[5] = address & 0xFF;
  p[6] = 0; p[7] = 0;
  const crc = uartCrc(p, 8);
  p[8] = crc & 0xFF; p[9] = (crc >> 8) & 0xFF;
  p[10] = 0x0D; p[11] = 0x0A;
  return p;
}

/** Build UART write request */
function buildUartWrite(address, data) {
  const p = new Uint8Array(12);
  p[0] = 0x3A; p[1] = 0x2B; p[2] = 0x06; p[3] = 0x04;
  p[4] = (address >> 8) & 0xFF; p[5] = address & 0xFF;
  p[6] = (data >> 8) & 0xFF;    p[7] = data & 0xFF;
  const crc = uartCrc(p, 8);
  p[8] = crc & 0xFF; p[9] = (crc >> 8) & 0xFF;
  p[10] = 0x0D; p[11] = 0x0A;
  return p;
}

/** Build UART save command */
function buildUartSave() {
  const p = new Uint8Array(12);
  p[0] = 0x3A; p[1] = 0x2B; p[2] = 0x06; p[3] = 0x04;
  p[4] = 0x05; p[5] = 0x55; p[6] = 0x00; p[7] = 0x01;
  const crc = uartCrc(p, 8);
  p[8] = crc & 0xFF; p[9] = (crc >> 8) & 0xFF;
  p[10] = 0x0D; p[11] = 0x0A;
  return p;
}

/**
 * Parse UART response bytes.
 * Returns { address, data } on success, or { error: string } on failure.
 */
function parseUartResponse(bytes) {
  if (!bytes || bytes.length < 12) return { error: 'Short response' };
  const crcRecv = bytes[8] | (bytes[9] << 8);
  const crcCalc = uartCrc(bytes, 8);
  if (crcRecv !== crcCalc) return { error: 'CRC error' };
  if (bytes[2] === 0x83) return { error: 'Exception 0x83' };
  if (bytes[2] === 0x86) return { error: 'Write error 0x86' };
  return {
    address: (bytes[4] << 8) | bytes[5],
    data:    (bytes[6] << 8) | bytes[7],
  };
}

// ─────────────────────────────────────────────────────────────
//  CAN / Tool_R helpers
// ─────────────────────────────────────────────────────────────

function buildToolRPacket(canId, dataBytes) {
  const p = new Uint8Array(15);
  p[0] = 0xFA; p[1] = 0x0D;
  p[2] = canId & 0xFF;
  p[3] = (canId >> 8)  & 0xFF;
  p[4] = (canId >> 16) & 0xFF;
  p[5] = (canId >> 24) & 0xFF;
  p[6] = dataBytes.length;
  for (let i = 0; i < dataBytes.length && i < 8; i++) p[7 + i] = dataBytes[i];
  return p;
}

function buildCanRead(address) {
  const d = new Uint8Array([0x01, 0x03, (address >> 8) & 0xFF, address & 0xFF, 0, 0, 0, 0]);
  return buildToolRPacket(0x03002050, d);
}

function buildCanWrite(address, data) {
  const d = new Uint8Array([0x01, 0x06, (address >> 8) & 0xFF, address & 0xFF, (data >> 8) & 0xFF, data & 0xFF, 0, 0]);
  return buildToolRPacket(0x03002050, d);
}

function buildCanSave() {
  const d = new Uint8Array([0x01, 0x06, 0x05, 0x55, 0x00, 0x01, 0x00, 0x00]);
  return buildToolRPacket(0x03002050, d);
}

function buildCanReload() {
  const d = new Uint8Array([0x01, 0x06, 0x05, 0x55, 0x00, 0x02, 0x00, 0x00]);
  return buildToolRPacket(0x03002050, d);
}

/** Parse 13 bytes that follow 0xFA 0x0D. Returns { id, len, data } or null. */
function parseCanResponse(bytes) {
  if (!bytes || bytes.length < 13) return null;
  const id = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  const len = bytes[4];
  const data = bytes.slice(5, 5 + Math.min(len, 8));
  return { id, len, data };
}

// ─────────────────────────────────────────────────────────────
//  Driver Status CAN builders  (CAN mode only)
// ─────────────────────────────────────────────────────────────

// Start command — part[1]: 0x00=normal, 0xA5=push assist
function buildDrvStartCmd(pushAssist) {
  return buildToolRPacket(0x141030FF, [0x01, pushAssist ? 0xA5 : 0x00, 0x00, 0x5A, 0, 0, 0, 0]);
}
// Fault Register request  → RX ID 0x10235030  6 bytes
function buildDrvFaultReq()    { return buildToolRPacket(0x12233050, [0x06, 0, 0, 0, 0, 0, 0, 0]); }
// Status + Speed/Current/Voltage → RX ID 0x10205030  8 bytes
function buildDrvStatusReq()   { return buildToolRPacket(0x12203050, [0x08, 0, 0, 0, 0, 0, 0, 0]); }
// Assist / Pedal data      → RX ID 0x10215030  8 bytes
function buildDrvAssistReq()   { return buildToolRPacket(0x12213050, [0x08, 0, 0, 0, 0, 0, 0, 0]); }
// Trip / Distance data     → RX ID 0x10225030  6 bytes
function buildDrvDistanceReq() { return buildToolRPacket(0x12223050, [0x06, 0, 0, 0, 0, 0, 0, 0]); }

const DRV_RX_FAULT    = 0x10235030;
const DRV_RX_STATUS   = 0x10205030;
const DRV_RX_ASSIST   = 0x10215030;
const DRV_RX_DISTANCE = 0x10225030;

// ─────────────────────────────────────────────────────────────
//  SIG utilities
// ─────────────────────────────────────────────────────────────

function decodeSig(list) {
  if (list.length < 4) return '';
  const hex = [3, 2, 1, 0]
    .map(i => (list[i].data & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'))
    .join('');
  const chars = [];
  for (let i = 0; i < hex.length; i += 2)
    chars.push(String.fromCharCode(parseInt(hex.slice(i, i + 2), 16)));
  for (let i = 0; i < chars.length; i += 2)
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  return chars.join('');
}

function encodeSig(sigStr) {
  if (sigStr.length !== 8) return null;
  const chars = sigStr.split('');
  for (let i = 0; i < 4; i += 2)
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  const hex = chars.map(c => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
  const result = [];
  for (let w = 0; w < 4; w++)
    result[3 - w] = parseInt(hex.slice(w * 4, w * 4 + 4), 16);
  return result;
}

function sigProtocol(sigStr) {
  if (sigStr.length < 8) return '';
  return (sigStr.charCodeAt(7) % 2 === 0) ? 'CAN' : 'UART';
}

// ─────────────────────────────────────────────────────────────
//  SN utilities  (16-char string in HRItems[4..11])
// ─────────────────────────────────────────────────────────────

const SN_LAYOUT = {
  place:    { start: 0,  len: 2 },
  toolNo:   { start: 2,  len: 2 },
  person:   { start: 4,  len: 1 },
  date:     { start: 5,  len: 6 },
  serialNo: { start: 11, len: 5 },
};

function decodeSn(list) {
  if (list.length < 12) return '';
  const hex = list.slice(4, 12)
    .map(item => (item.data & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'))
    .join('');
  let s = '';
  for (let i = 0; i < hex.length; i += 2)
    s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return s;
}

function encodeSn(snStr) {
  if (snStr.length !== 16) return null;
  const result = [];
  for (let i = 0; i < 8; i++)
    result.push((snStr.charCodeAt(i * 2) << 8) | snStr.charCodeAt(i * 2 + 1));
  return result;
}

function snSetField(snStr, field, value) {
  const padded = snStr.padEnd(16, '\0');
  const { start, len } = SN_LAYOUT[field];
  const v = value.padEnd(len, '\0').slice(0, len);
  return padded.slice(0, start) + v + padded.slice(start + len);
}

// ─────────────────────────────────────────────────────────────
//  Burn / Firmware Update protocol  (separate from parameter R/W)
//  CRC32 polynomial: 0x19041383
// ─────────────────────────────────────────────────────────────

function burnCrc32(data, size) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < size; i++) {
    crc ^= data[i];
    for (let j = 8; j > 0; j--)
      crc = ((crc >>> 1) ^ ((crc & 1) ? 0x19041383 : 0)) >>> 0;
  }
  return (~crc) >>> 0;
}

/**
 * Extract 8-byte SIG from the first line of a HEX file.
 * Pattern: @@<SIG8chars>v<VV>.<vv>
 * UART: SIG bytes are reversed. CAN: not reversed.
 */
function burnGetSig(firstLine, isUart) {
  const m = firstLine.match(/@@(.*?)[vV]\d{2}\.\d{2}/);
  if (!m || m[1].length < 8) return null;
  let sig = m[1].slice(0, 8);
  if (isUart) sig = sig.split('').reverse().join('');
  return new Uint8Array(sig.split('').map(c => c.charCodeAt(0)));
}

// ── UART burn packets ──────────────────────────────────────

/** [cmd, 0x08, sig(8B), crc16_lo, crc16_hi] = 12 bytes */
function buildBurnUartCmd(cmd, sig) {
  const p = new Uint8Array(12);
  p[0] = cmd; p[1] = 0x08;
  for (let i = 0; i < 8; i++) p[2 + i] = sig[i];
  const crc = burnCrc32(p, 10) & 0xFFFF;
  p[10] = crc & 0xFF; p[11] = (crc >> 8) & 0xFF;
  return p;
}

function buildBurnUartCheckFw(sig)  { return buildBurnUartCmd(0xF6, sig); }
function buildBurnUartJumpBoot(sig) { return buildBurnUartCmd(0xF4, sig); }
function buildBurnUartJumpApp(sig)  { return buildBurnUartCmd(0xF3, sig); }

/**
 * Build UART firmware line packet.
 * [0xF1, len+2, lineBytes..., 0x0D, 0x0A, crc16_lo, crc16_hi]
 */
function buildBurnUartLine(lineBytes) {
  const p = new Uint8Array(lineBytes.length + 6);
  p[0] = 0xF1; p[1] = lineBytes.length + 2;
  for (let i = 0; i < lineBytes.length; i++) p[2 + i] = lineBytes[i];
  p[2 + lineBytes.length] = 0x0D;
  p[3 + lineBytes.length] = 0x0A;
  const crc = burnCrc32(p, lineBytes.length + 4) & 0xFFFF;
  p[4 + lineBytes.length] = crc & 0xFF;
  p[5 + lineBytes.length] = (crc >> 8) & 0xFF;
  return p;
}

/** Parse 6-byte UART line ACK. Returns 'ok', 'nak', 'crc_err', or 'timeout'. */
function parseBurnUartLineAck(bytes) {
  if (!bytes || bytes.length < 6) return 'timeout';
  const crcRecv = bytes[4] | (bytes[5] << 8);
  if ((burnCrc32(bytes, 4) & 0xFFFF) !== crcRecv) return 'crc_err';
  return bytes[2] === 0x30 ? 'ok' : 'nak';
}

/**
 * Parse UART firmware status response (reply to 0xF6).
 * Frame: [0xF6, 0x06, execByte0, execByte1, majLo, majHi, minLo, minHi, crcLo, crcHi]
 * Returns { state: 0=bootloader|1=app, major, minor } or { error }.
 */
function parseBurnUartFwResp(bytes) {
  if (!bytes || bytes.length < 10) return { error: 'short' };
  const crcRecv = bytes[8] | (bytes[9] << 8);
  if ((burnCrc32(bytes, 8) & 0xFFFF) !== crcRecv) return { error: 'crc' };
  const execState = bytes[2] + bytes[3];
  const major = bytes[4] | (bytes[5] << 8);
  const minor = bytes[6] | (bytes[7] << 8);
  return { state: execState === 130 ? 0 : 1, major, minor };
}

/** Parse UART jump response (0xF4 / 0xF3). Returns true if OK. */
function parseBurnUartJumpResp(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (bytes[1] === 0) return true;   // empty response is OK
  if (bytes.length < 5) return false;
  return bytes[2] === 0x30;
}

// ── CAN burn packets ───────────────────────────────────────

function buildBurnCanCheckFw(sig)  { return buildToolRPacket(0x000000B2, sig); }
function buildBurnCanJumpBoot(sig) { return buildToolRPacket(0x000000B4, sig); }
function buildBurnCanJumpApp()     { return buildToolRPacket(0x000000BE, [0xF3, 0x00]); }

/**
 * Split a 62-byte chunk into CAN frames for flashing.
 * Prepends [0xF1, len] header, then splits into 8-byte Tool_R packets (ID 0xBE).
 */
function buildBurnCanSegments(chunk) {
  const modified = [0xF1, chunk.length, ...Array.from(chunk)];
  const frames = [];
  for (let j = 0; j < modified.length; j += 8)
    frames.push(buildToolRPacket(0x000000BE, modified.slice(j, j + 8)));
  return frames;
}

// ── BLE-CAN burn packets ───────────────────────────────────────

/**
 * Build BLE-CAN firmware line packet (no CRC).
 * [0xF1, len, lineBytes..., 0x0D, 0x0A]
 */
function buildBurnBleCanLine(lineBytes) {
  const p = new Uint8Array(lineBytes.length + 4);
  p[0] = 0xF1; p[1] = lineBytes.length + 2;
  for (let i = 0; i < lineBytes.length; i++) p[2 + i] = lineBytes[i];
  p[2 + lineBytes.length] = 0x0D;
  p[3 + lineBytes.length] = 0x0A;
  return p;
}

/** Parse 4-byte BLE-CAN line ACK. Returns 'ok', 'nak', or 'timeout'. */
function parseBurnBleCanLineAck(bytes) {
  if (!bytes || bytes.length < 4) return 'timeout';
  return bytes[2] === 0x30 ? 'ok' : 'nak';
}
