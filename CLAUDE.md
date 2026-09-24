# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Endex eBike Tool** (`APP_VERSION` in [js/app.js](js/app.js) — currently v1.5.08) — A browser-based parameter configuration and firmware management utility for eBike motor controllers. Communicates with controllers over UART or CAN (via Web Serial API) or over BLE (via Web Bluetooth, bridged to UART by an ESP32-H2).

## Running the App

No build step required. Serve the static files via any HTTP server or open `index.html` directly. The Web Serial API requires a secure context (HTTPS or `localhost`).

```powershell
# Simplest approach — Python HTTP server
python -m http.server 8080
```

Then open `http://localhost:8080` in Chrome (Web Serial API is Chrome/Edge only).

## Architecture

### File Layout

```
index.html              — Single-page app shell; all UI structure, modals, tab containers
manual.html             — User manual (Traditional Chinese)
flow.html               — Standalone reference doc: read/write parameter sequence walkthrough
appendix-ini.html       — Standalone reference doc: page.ini / parameter.ini field spec
style.css               — Dark theme; CSS variables for colors/layout
page.ini                — Tab/section definitions for parameter display
parameter.ini           — Default hardware register (HRItem) definitions
parameter_ENEBDV01.ini  — Per-model HRItem variant for the UART line (ENEBDV01/11)
parameter_ENEBDV04.ini  — Per-model HRItem variant for the ENEBDV04 (Schaca) motor
js/
  app.js                — Main orchestrator: state, event handlers, connection workflow, keyboard shortcuts
  ui.js                 — Dynamic tab/row generation from INI data; modal controllers
  protocol.js           — UART, CAN, BLE-CAN packet builders/parsers (params, driver status, calibration, firmware burn)
  serial.js             — Web Serial API wrapper with buffered frame reading
  ble.js                — Web Bluetooth wrapper (BleManager) — same interface as SerialManager
  ini.js                — INI parser/serializer; HRItem struct definition
  paramData.js          — EMBEDDED_PARAM_INI: parameter.ini text embedded per model, for file:// fallback
esp32h2/
  ble_bridge/ble_bridge.ino — ESP32-H2 (NimBLE) firmware: transparent BLE↔UART bridge to the motor controller
```

### Data Flow

1. **INI loading**: `ini.js` parses `page.ini` + the model's parameter INI (fetched over HTTP, or cached copies from `localStorage`, or — under `file://` where `fetch()` fails — `EMBEDDED_PARAM_INI` from `paramData.js`) into an `hrList` of HRItem objects. `autoLoadIni()` in `app.js` drives this and picks the file via `MODEL_FILES[model]`.
2. **UI generation**: `ui.js` reads the page sections and renders tab panels with parameter controls sourced from `hrList`.
3. **Read/write**: `app.js` coordinates — `protocol.js` builds frames, the active channel (`serial.js` or `ble.js`) sends/receives, `protocol.js` parses responses, and `app.js` updates `state.hrList` values and re-renders controls.

### Transport Channels

`app.js` holds both `state.comSerial` (`SerialManager`, Web Serial) and `state.bleSerial` (`BleManager`, Web Bluetooth) and points `state.serial` at whichever is active. The `#selChannel` dropdown (`comport` / `ble`) switches via `applyChannelSelection()`; switching while connected is blocked. `BleManager` exposes the same interface as `SerialManager` (`open`, `close`, `write`, `isOpen`, `readUartFrame`, `readCanFrame`) so `app.js` and `protocol.js` don't need to know which channel is active.

`BleManager` scans for a GATT UART-bridge profile, trying `BLE_UART_PROFILES` in order (Nordic NUS → ESP_GATTS → HM10 → SPP) until it finds one with a writable + notifiable characteristic. The companion `esp32h2/ble_bridge/ble_bridge.ino` firmware implements the NUS side of this: RX char writes go to the controller's UART, UART bytes are batched and pushed back via the TX notify characteristic, and a CFG characteristic sets the bridge's UART baud rate.

### Multi-Model Support

The `#selModel` dropdown selects the connected motor's model. `MODEL_FILES` (app.js) maps model → parameter INI filename; `MODEL_PRODUCT_IDS` maps model → expected `PRODUCT_SPECIFIED_ID` string(s) decoded from the SIG registers, used to verify the loaded INI actually matches the connected hardware. Cache keys in `localStorage` are namespaced per model.

On a parameter read (`performRead()` in app.js), a SIG mismatch against a *known* other model auto-switches `#selModel`, reloads that model's INI, and retries the read once — unless `state.modelUserSelected` is set (true once the user has manually changed `#selModel`), in which case the mismatch is only logged so a deliberate manual choice is never silently overridden.

### State Object (`app.js`)

Central `state` object holds:
- `hrList` — current parameter values (live)
- `paraList` — snapshot for diff comparison
- `comSerial` / `bleSerial` / `serial` — transport channels (see above)
- Connection status and protocol mode

### HRItem Structure (`ini.js`)

Each parameter entry from `parameter.ini` becomes an HRItem with: `name`, `address` (hex), `data` (current value), `unit`, `upper`/`lower` bounds, `tooltip`, and boolean flags: `writeable`, `hidden`, `setbit`, `production`.

### Protocol Details (`protocol.js`)

- **UART frame**: `0x3A [cmd] [len] [addr_h] [addr_l] [data_h] [data_l] [crc_lo] [crc_hi] 0x0D 0x0A`
  - CRC = sum of bytes[1..len-1]
- **CAN (Tool_R) frame**: `0xFA 0x0D + ID(4B LE) + Len(1B) + Data(8B)` = 15 bytes total
- **BLE-CAN**: reuses the CAN Tool_R framing over the `BleManager` channel instead of Web Serial.
- Also builds: driver-status CAN requests (fault/status/assist/distance), motor calibration start/poll commands, SIG/SN string encode-decode, and the firmware burn protocol (separate command set per channel: UART, CAN, BLE-CAN — CRC32 poly `0x19041383`).

### Operating Modes & Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+E` | Engineering mode — shows SIG tab and hidden parameters |
| `Ctrl+U` | User mode — hides SIG tab and hidden parameters |
| `Ctrl+P` | Show production fields |
| `Ctrl+L` | Hide production fields |
| `Ctrl+S` | Toggle SIG TextBox editable |
| `Ctrl+D` | Toggle debug mode |

These shortcuts apply regardless of transport channel — there are no BLE-specific shortcuts.

### INI Caching

Parsed INI files are cached in `localStorage` under `endex_page_ini` and `endex_parameter_ini` (the latter suffixed `_<model>` per selected model, via `lsParamKey()`/`lsParamNameKey()` in `app.js`). The Config editor modal allows in-browser editing and saving of these cached values.

## UI Layout

- **Top bar** (44px): Connection controls (channel selector: COM port / BLE, port open/close, protocol selector, baud rate)
- **Sidebar** (220px): Operations panel — load config, import/export, read/write all parameters, firmware burn
- **Main area**: Dynamically generated tab panels; 8-column grid per parameter row
- **Status bar** (220px): Progress bar + debug log output
- **Modals**: SetBit editor (bitfield visualization), Config editor (raw INI table), Diff viewer, Driver Status monitor

## Language

UI text is Traditional Chinese (zh-TW). Technical identifiers and code comments are in English.
