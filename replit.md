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
2. **LIVE OBD** — Web Serial connect with baud rate auto-detection (115200/38400/9600/2M), scan modules, read/write VIN over UDS, RFHUB virginize, proxi read, individual module write (DAMP/IPC/ECM/TCM) via CDA6 security; proper ELM327 prompt detection with control-char stripping, timeout logging for debug visibility, CAN header stripping for ATH1, ISO-TP PCI byte stripping for multi-frame responses
3. **BENCH** — Offline module diagnostics + UDS bench tools: load .bin files, auto-detect module type, VIN write with CRC to all, BCM proxi read, GPEC2A SKIM read, RFHUB virginize; separate Web Serial bench connection for on-bench UDS VIN read/write (DAMP/IPC/ECM/TCM/BCM)
4. **SEED→KEY** — 14 algorithm calculator (GPEC, NGC, JTEC, CDA6, TIPM variants)
5. **GPEC** — Firmware unlock (0x2FFFC = 0x96)
6. **SECURITY** — Cross-vehicle security matcher with 4 sub-views:
   - **Overview**: Per-module offset table (VIN/SKIM/SECRET/FOBIK/IMMO/TAMPER/LOCK/CTR), cross-module validation (pass/warn/fail), runtime counters for GPEC2A
   - **Security**: Side-by-side architecture cards per module with VIN match/mismatch, SKIM status, vehicle secrets (endianness-aware), FOBIK slots/count, lock status, tamper status, key sync buttons
   - **Diff**: Hex diff between any two loaded modules with changed-byte highlighting, region grouping, byte counts
   - **Tools**: VIN writer (all modules at once), SKIM toggle, virginize, extract/sync secret key with user-chosen key source picker, and "Files to Flash" summary with download for each modified module
7. **GPEC2A** — SKIM byte toggle, secret key extract, transponder keys, ZZZZ tamper, hex diff

## Enhanced Module Parser

`parseModule()` merges the original `analyzeFile`/`secAnalyze` with the richer `fca_module_analyzer` for deeper extraction:
- **GPEC2A**: Runtime counters, transponder keys, part number, ZZZZ tamper, secret key mirror validation
- **RFHUB**: FOBIK slot counting (AA50), CC66AA55 security markers, ZZZZ blocks, part numbers, 16-byte vehicle secret, mirrored VIN support
- **BCM**: Security lock byte (0x8028), FOBIK count (0x5862), IMMO key entries, FOBIK part number, FEE1000 header detection, vehicle secret (little-endian), IMMO SKIM record counting (24-byte records at 0x40C0 primary, 0x2000 backup), backup sync status
- **95640**: Secret key at 0x40–0x50, fob data at 0x200–0x240

## Cross-Vehicle Matching

- Loads modules from different vehicles, compares VINs and security bytes
- `crossValidate()` checks: VIN consistency, RFHUB↔BCM vehicle secret (byte-reversed), GPEC2A key consistency, SKIM state, FOBIK count match, 95640↔RFHUB key match
- "Match All" syncs VINs+keys from a user-chosen source module to all others, producing downloadable .bin files with plain-English flash instructions per module type

## Key Commands

- `pnpm --filter @workspace/srt-lab run dev` — Start dev server
- `pnpm run typecheck` — Full typecheck across all packages

## BCM IMMO Backup Sync

BCM SKIM key tables use 24-byte records (IMMO_REC=24, IMMO_KC=8, IMMO_BLOCK=192 bytes):
- **Primary**: 0x40C0 (SRT layout, up to 8 SKIM key records, 0x40C0–0x417F)
- **Backup**: 0x2000 (Trackhawk layout, mirrors primary)
- `syncImmoBackup()`: copies 192 bytes from 0x40C0→0x2000 with bounds check
- Auto-syncs during BCM VIN patching (both `patchFile` and `writeModuleVIN`)
- Standalone sync buttons in DUMPS, BENCH, and SECURITY Tools tabs
- Virginize clears full 192-byte IMMO block at both addresses

## Verified CRC Algorithms

- **BCM D-FLASH**: CRC-16 CCITT-FALSE (poly 0x1021, init 0xFFFF)
- **95640 EEPROM**: CRC-8 Forward (poly 0x42, init 0x2E)
- **RFHUB EEE**: Context-dependent, preserved on patch
- **GPEC2A**: No CRC (plain ASCII VIN storage)

## File Type Detection

- 64KB/128KB → BCM D-FLASH (with FEE1000 header confirmation)
- 8KB/16KB → 95640 EEPROM
- 4KB with VIN at byte 0 → GPEC2A (confirmed via SKIM byte 0x0011 or VIN copy at 0x01F0)
- 4KB otherwise → RFHUB EEE
- >128KB → Firmware
