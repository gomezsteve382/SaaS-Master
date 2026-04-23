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

`artifacts/srt-lab/` — React + Vite SPA. All binary processing is client-side via FileReader → Uint8Array. The shared `MasterVinContext` (`src/lib/masterVinContext.jsx`) holds the current VIN, vinValid regex, and per-module status (BCM / RFHUB / ECM / ADCM) so any tab can drive the next.

Processing helpers live in `src/lib/`:
- `parseModule.js` — auto-detects GPEC2A / RFHUB / BCM / 95640 and extracts every documented field per type.
- `crossValidate.js` — cross-module rules + `computeDiff(a,b)` hex diff with adjacent grouping.
- `crc.js` — verified CRC primitives (CCITT-FALSE 0x1021, 95640 0x42, RFHUB 0xA0 reflected).
- `algos.js` — seed→key algorithms (cda6, sxor, ngc, jtec, sbec).
- `initAdapter.js` — shared OBD adapter init (ATZ 3000 ms + 1000 ms settle + STN PP2C/PP2D) and `parseVinFromResponse`.
- `backups.js` — localStorage-backed module backups, capped at 50 entries (`srtlab_backup_*`).
- `paperTrail.js` — session log, capped at 500 entries (`srtlab_sessions`).
- `nrc.js` — UDS negative-response code decoder.
- `programmerData.js` — ADCM_VARIANTS (14) + ADCM_MODULES (5).
- `alfaobdData.generated.js` — codegen-emitted slice of the AlfaOBD
  reverse-engineered SQLite database (`DIAG_NAMES`, `CGW_CONFIG`, plus
  empty stubs for tables lost to source-data corruption). See
  `scripts/README.md` → "AlfaOBD database codegen" for regen, source
  `.db` location, and the corruption caveats.

A desktop J2534 driver (Python, separate package) handles raw CAN PassThru when Web Serial is insufficient. The reference implementation of that driver — the localhost HTTP daemon `bridgeClient.js`/`bridgeEngine.js` talk to, plus 16 operational helper scripts and the per-module unlock DLL catalog — lives at `tools/python-bridge/` (sibling to `artifacts/`, **not** a pnpm package, not built or tested by CI). See `tools/python-bridge/README.md` for the wire protocol, Windows prerequisites, and per-script purpose.

The API server (`artifacts/api-server/`) is used for download counters, module backups, diff reports, and the **Anthropic AI module assistant**:

- **Stateless one-shot** — `/api/anthropic/module-assistant` (SSE) — accepts module context and streams a single Claude reply. Used by code paths that don't persist a chat.
- **Persistent conversations** — `/api/anthropic/conversations` (CRUD) and `/api/anthropic/conversations/:id/messages` (SSE). Conversations are stored in the `conversations` + `conversation_messages` tables (`lib/db/src/schema/conversations.ts`) and tagged with an optional `scope` string for per-launcher isolation. The Mismatch Wizard uses this so chats survive close/reopen.

The shared SRT system prompt + module-context block + auto-titling logic live in `artifacts/api-server/src/routes/anthropic/_shared.ts` so both endpoints stay in lock-step.

### Wizard chat persistence (Continue Last Session)

`MismatchWizard` accepts a `sessionKey` prop that is used to scope the persisted Claude chat per launcher:

| Launcher                         | sessionKey                              |
|----------------------------------|-----------------------------------------|
| Workspace header (App.jsx)       | `workspace:<vehicleId>`                 |
| Module Sync tab                  | `modsync:<vehicleId\|global>`           |
| FCA Analyzer tab                 | `fca:<vehicleId\|global>`               |

The internal `useChatStream(sessionKey)` hook:
- on mount, reads `localStorage["srt-wizard-last-conv:<sessionKey>"]` and hydrates the prior conversation (404 ⇒ pointer is cleared);
- lazily creates a server-side conversation on the first send, tagged `scope=<sessionKey>`;
- streams responses through `POST /:id/messages`, persisting the assistant reply server-side even if the client disconnects mid-stream;
- exposes `+ New chat` (clears pointer) and `Past sessions ▾` (lists conversations filtered by `?scope=<sessionKey>`, with delete buttons).

A `↻ RESUMED` pill appears in the chat header whenever the panel was hydrated from a saved pointer.

## Tabs (order mirrors reference App.jsx)

1. **PROGRAM ALL** — sequential BCM → RFHUB → ECM → ADCM programmer with cross-verify *(placeholder — pending migration)*
2. **BCM** — VIN read/write at DIDs F190/7B90/7B88 with CDA6 unlock, CRC patch, IMMO backup sync
3. **RFHUB** — VIN read/write, key fob program/locate/erase routines (0x0401/0x0403/0x0404), known-algo lookup
4. **ECM** — Engine module with 10 seed→key algorithms (GPEC1/2/2A/3 sxor variants, NGC, SBEC, JTEC, CDA6)
5. **ACTIVE DAMPING (ADCM)** — VIN + variant config (DIDs F1A1/DE10/DE11) with Routine 0x0312 unlock + SBEC fallback
6. **UDS PROGRAMMER** — universal raw UDS console *(placeholder — pending migration)*
7. **BACKUPS** — view, restore, and export historical module dumps
8. **SESSIONS** — paper-trail report (technician, addresses, algorithm, success/fail) with PDF export
9. **JAILBREAK** — SRT / Demon / Hellcat / Redeye feature unlocks
10. **DUMPS** — load .bin, auto-detect, VIN patch with CRC, hex viewer, virginizer
11. **LIVE OBD** — Web Serial scan, read/write VIN, RFHUB virginize, proxi read, ECM/TCM/IPC/DAMP write
12. **BENCH** — offline diagnostics + on-bench UDS VIN read/write
13. **SEED→KEY** — 14 algorithm calculator
14. **GPEC** — firmware unlock (0x2FFFC = 0x96)
15. **GPEC2A** — SKIM byte toggle, secret key extract, transponder keys, ZZZZ tamper
16. **FCA ANALYZER** — multi-file cross-module audit (overview / security / diff / tools sub-tabs); virginize, writeVIN, SKIM toggle, extract key with downloadable .bin
17. **SWARM** — CAN bus scan diagnostic *(SRT Lab addition, not in reference)*
18. **J2534** — raw CAN PassThru via desktop driver *(SRT Lab addition, not in reference)*

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
- `pnpm --filter @workspace/srt-lab run manifest:update` — Refresh `srt_lab.manifest.json` sizeBytes/sha256/lastUpdated from `public/srt_lab.py` (also runs automatically as `prebuild`)
- `pnpm --filter @workspace/srt-lab run manifest:check` — Fail if the manifest is out of sync with `srt_lab.py` (use as pre-commit / CI guard)
- `pnpm --filter @workspace/srt-lab exec node scripts/update-manifest.mjs --bump <ver> --notes "<text>"` — Bump version and prepend a changelog entry in one command
- `pnpm bundle` — Regenerate the offsite codebase package: `srt-lab-monorepo.tar.gz` + `srt-lab-monorepo-bundle.txt` at the repo root (see `scripts/README.md` → "Codebase packager")

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

## Regenerating the SRT Lab flyer

The marketing flyer at `attached_assets/flyers/srt_lab_flyer.{svg,png,pdf}` is
generated from `scripts/build-flyer.mjs` (inline SVG → librsvg → PNG + PDF).
See `scripts/README.md` for prerequisites (ImageMagick + librsvg + the three
brand fonts), the one-line font install steps, and the regen command:

```bash
node scripts/build-flyer.mjs
```
