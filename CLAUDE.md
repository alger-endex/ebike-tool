# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Endex eBike Tool** (v1.2.1) — A browser-based parameter configuration and firmware management utility for eBike motor controllers. Communicates with controllers over serial (Web Serial API), supporting UART and CAN bus protocols.

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
index.html          — Single-page app shell; all UI structure, modals, tab containers
manual.html         — User manual (Traditional Chinese)
style.css           — Dark theme; CSS variables for colors/layout
page.ini            — Tab/section definitions for parameter display
parameter.ini       — 100+ hardware register (HRItem) definitions
js/
  app.js            — Main orchestrator: state, event handlers, serial workflow, keyboard shortcuts
  ui.js             — Dynamic tab/row generation from INI data; modal controllers
  protocol.js       — UART and CAN packet builders/parsers
  serial.js         — Web Serial API wrapper with buffered frame reading
  ini.js            — INI parser/serializer; HRItem struct definition
```

### Data Flow

1. **INI loading**: `ini.js` parses `page.ini` + `parameter.ini` (or cached copies from `localStorage`) into an `hrList` of HRItem objects.
2. **UI generation**: `ui.js` reads the page sections and renders tab panels with parameter controls sourced from `hrList`.
3. **Serial read/write**: `app.js` coordinates — `protocol.js` builds frames, `serial.js` sends/receives, `protocol.js` parses responses, and `app.js` updates `state.hrList` values and re-renders controls.

### State Object (`app.js`)

Central `state` object holds:
- `hrList` — current parameter values (live)
- `paraList` — snapshot for diff comparison
- Serial connection status and protocol mode

### HRItem Structure (`ini.js`)

Each parameter entry from `parameter.ini` becomes an HRItem with: `name`, `address` (hex), `data` (current value), `unit`, `upper`/`lower` bounds, `tooltip`, and boolean flags: `writeable`, `hidden`, `setbit`, `production`.

### Protocol Details (`protocol.js`)

- **UART frame**: `0x3A [cmd] [len] [addr_h] [addr_l] [data_h] [data_l] [crc_lo] [crc_hi] 0x0D 0x0A`
  - CRC = sum of bytes[1..len-1]
- **CAN (Tool_R) frame**: `0xFA 0x0D + ID(4B LE) + Len(1B) + Data(8B)` = 15 bytes total

### Operating Modes & Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+E` | Engineering mode — shows SIG tab and hidden parameters |
| `Ctrl+U` | User mode — hides SIG tab and hidden parameters |
| `Ctrl+P` | Show production fields |
| `Ctrl+L` | Hide production fields |
| `Ctrl+S` | Toggle SIG TextBox editable |
| `Ctrl+D` | Toggle debug mode |

### INI Caching

Parsed INI files are cached in `localStorage` under keys `endex_page_ini` and `endex_parameter_ini`. The Config editor modal allows in-browser editing and saving of these cached values.

## UI Layout

- **Top bar** (44px): Serial connection controls (port open/close, protocol selector, baud rate)
- **Sidebar** (220px): Operations panel — load config, import/export, read/write all parameters, firmware burn
- **Main area**: Dynamically generated tab panels; 8-column grid per parameter row
- **Status bar** (220px): Progress bar + debug log output
- **Modals**: SetBit editor (bitfield visualization), Config editor (raw INI table), Diff viewer, Driver Status monitor

## Language

UI text is Traditional Chinese (zh-TW). Technical identifiers and code comments are in English.
