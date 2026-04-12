# SRT Lab - Jailbreak Edition

## Overview

FCA/Stellantis ECU module workbench. React single-page app (Vite + React) running entirely client-side. Patches VINs, manages immobilizer keys, communicates over OBD-II via Web Serial.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **Frontend**: React 18+, Vite, inline styles (no UI library)
- **Fonts**: Nunito (body), Righteous (display), JetBrains Mono (hex/data)
- **Color palette**: Light base (#F4F1EC), SRT Red (#D32F2F) + black (#1A1A1A) accents

## Architecture

Single file: `artifacts/srt-lab/src/App.jsx` — all processing is client-side in the browser. Binary files loaded via FileReader API, processed as Uint8Array.

No backend required — the API server exists but is unused by this app.

## Tabs

1. **DUMPS** — Load .bin files, auto-detect type, VIN patch with correct CRC, hex viewer, virginizer
2. **LIVE OBD** — Web Serial connect, scan modules, read/write VIN over UDS, RFHUB virginize, proxi read
3. **SEED->KEY** — 14 algorithm calculator (GPEC, NGC, JTEC, CDA6, TIPM variants)
4. **GPEC** — Firmware unlock (0x2FFFC = 0x96)
5. **SECURITY** — Module file loader, cross-module key matching, VIN sync, SKIM key grid
6. **GPEC2A** — SKIM byte toggle, secret key extract, transponder keys, ZZZZ tamper, hex diff

## Key Commands

- `pnpm --filter @workspace/srt-lab run dev` — Start dev server
- `pnpm run typecheck` — Full typecheck across all packages

## Verified CRC Algorithms

- **BCM D-FLASH**: CRC-16 CCITT-FALSE (poly 0x1021, init 0xFFFF)
- **95640 EEPROM**: CRC-8 Forward (poly 0x26, init 0x00)
- **RFHUB EEE**: Context-dependent, preserved on patch
- **GPEC2A**: No CRC (plain ASCII VIN storage)

## File Type Detection

- 64KB/128KB -> BCM D-FLASH
- 8KB/16KB -> 95640 EEPROM
- 4KB with VIN at byte 0 -> GPEC2A
- 4KB otherwise -> RFHUB EEE
- >128KB -> Firmware
