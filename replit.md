# SRT Lab - Jailbreak Edition

[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)

## Overview

SRT Lab is a React single-page application designed as a workbench for FCA/Stellantis ECU modules. It runs entirely client-side, enabling functionalities such as patching VINs, managing immobilizer keys, and communicating over OBD-II via Web Serial. The project aims to provide comprehensive tools for diagnosing, programming, and "jailbreaking" vehicle ECUs, focusing on high-performance SRT, Demon, Hellcat, and Redeye models to unlock features and enhance vehicle customization.

## User Preferences

I prefer iterative development and value clear, concise communication. Please ask before making any major architectural changes or introducing new dependencies. I prefer detailed explanations for complex technical decisions. Do not make changes to the `tools/python-bridge/` folder or its contents.

## System Architecture

### Frontend

React SPA built with Vite. All binary processing is client-side via `FileReader` and `Uint8Array`. A `MasterVinContext` tracks the active VIN and per-module status across tabs.

Core processing helpers in `artifacts/srt-lab/src/lib/`:
- `parseModule` — auto-detects and extracts fields from GPEC2A, RFHUB, BCM, 95640, XC2268_RFHUB, ZF_8HP_TCU.
- `crossValidate` — inter-module rule checking, VIN cross-comparison, SEC16/SEC6 verdicts.
- `securityBytes.js` — single source of truth for the three immobilizer-secret writers (BCM SEC16 split + mirrors + legacy flat, RFHUB Gen2 SEC16, PCM SEC6).
- `keyProgWizard.js` — `runKeyProgPatch` (full 3-module wizard) + `runRfhBcmSync` (bidirectional SEC16 sync).
- `crc.js`, `algos.js` — verified CRC primitives + seed-to-key algorithm table.

UI palette: light base `#F4F1EC`, SRT Red `#D32F2F`, black `#1A1A1A`. Fonts: Nunito (body), Righteous (display), JetBrains Mono (hex/data).

### Backend services

- **`artifacts/api-server/`** — Express API. Download counters, module backups, diff reports, Anthropic AI module assistant (stateless one-shot + persistent conversations), `vehicleJobs` + `vehicleJobEvents` persistence, investigation runs.
- **`tools/python-bridge/`** — separate Python package providing a desktop J2534 driver and localhost HTTP daemon for raw CAN PassThru when Web Serial isn't enough. Python deps are managed in isolation from the main build. **Not modified per user preference.**

### `@workspace/uds` library (`lib/uds/`)

Complete ISO 14229-1 UDS TypeScript library, composite pnpm workspace lib:
- `services.ts`, `nrc.ts`, `constants.ts` — full ISO 14229 service / NRC / constants tables.
- `build.ts` — frame builders for every standard service (return `Uint8Array`).
- `parse.ts` — generic + service-specific parsers (RDBI, SecurityAccess, RoutineControl, RequestDownload).
- `dids.ts` — `0xF1xx` ID block + common DID catalog.
- `isotp.ts` — ISO 15765-2 SF/FF/CF/FC encode/decode + `segmentPayload`.
- 54 unit tests in `src/__tests__/uds.test.ts`; README with 5 worked examples.

The BCM frame builder (`artifacts/srt-lab/src/lib/alfaobdMined/udsFrameBuilder.js`) delegates WDBI to `build.writeDataByIdentifier` and routine/reset frames to the matching lib builders.

## Tabs and features

### Module programming
Dedicated tabs for **BCM**, **RFHUB**, **ECM**, **ADCM** — VIN read/write, key programming, module-specific unlocks. SGW-gated VINs auto-route to the J2534 bridge.

The **ECM tab** also hosts an offline **GPEC2A PCM Immo Analyzer** (`Gpec2aImmoPanel.jsx` + pure `gpec2aPcmAnalyzer.js`): for a loaded GPEC2A dump it shows analysis cards (family/EEPROM/state/SEC6/IMMO), a checksum panel with per-row fix+download, VINs-by-offset, internal IDs/signatures, an apply-changes form (VIN + SEC6 + IMMO marker), and a one-click **Just FIX IT** immo repair. SEC6 secrets are derived from any loaded BCM/RFHUB donor (`PCM SEC6 = reverse(BCM SEC16)[0:6]`, marker `FF FF FF AA` @0x3C4) and the write delegates to `securityBytes.writePcmSec6`. GPEC2A only; no live-OBD coupling.

### Module Sync (`ModuleSync.jsx`)
Cross-module security-byte sync: `runRfhBcmSync` in either direction, `Repair flat 0x40C9 from split records`, full 3-module `runKeyProgPatch`. **SYNC ALL now enforces the same virgin-GPEC2A SEC6 refusal as `runKeyProgPatch`** (the two flows are consistent): the `pcmSec6Blank` predicate — a canonical-size GPEC2A (4 KB 95320 / 8 KB 95640) whose SEC6 secret slot is unpopulated (`classifyPcmSec6().populated === false`) — both disables the **SYNC ALL** button (with a `modsync-pcm-virgin-blocked-help` notice) and halts `executeSync('sync-all')` before any write, so a virgin/blank engine module is never paired and no files are emitted. A populated SEC6 still pairs and exports as `PCM_SYNCED`. A non-canonical buffer size is caught earlier by the separate `pcmHasNonCanonicalSize` guard. The refusal is scoped to `sync-all` only; preview gating and the writer share the single `pcmSec6Blank` predicate to avoid drift.

### UDS Programmer
Universal raw UDS console driving `@workspace/uds` builders.

### Proxi Decoder (read-only)
`ProxiTab` decodes the BCM `0x2023` proxi blob (16 B from `BODY_PN_CONFIG` via `cgwConfig.decodeBcmConfig`) plus the curated `DEnn` family (`DE00`–`DE0C`, 155 fields) sourced from `bcmFeatureCatalog.generated.js`. Upload BCM `.bin` or paste hex (optional `62 DD DD` UDS header strip). Category sidebar + search + grouped rows. No write path until labels are ground-truthed against a real bench dump.

### Data Management
Backups, session logs, module-dump load/auto-detect/VIN patch/hex viewer/virginizer.

### Diagnostics
Live OBD-II scan, bench diagnostics, **FCA Analyzer** (multi-file cross-module audit).

### Advanced Tools
Seed-to-key calculator (iterates `ALGOS`), GPEC/GPEC2A firmware unlocks, **SWARM** CAN bus diagnostics, J2534 raw CAN PassThru, C-FLASH calibration analysis.

### Workflow Orchestration
`WORKFLOW` tab — persistent `vehicleJobs`, unified Module Census, Fix Plan builder with pluggable `SecurityAccessSource`.

### Read-only references
- **CAN Universe** (`canuniverse`) — ~485 deduplicated CAN/OSS automotive projects merged from three upstream lists + curated extras. Generator: `scripts/src/fetch-can-catalogs.mjs`. Strictly catalog — no downloads/executions.
- **Binary Intel** (`binintel`) — hand-curated third-party binary-analysis reports cross-referenced against SRT Lab coverage with COVERED / PARTIAL / GAP tags. First report: VILLAIN intel (unverified). Read-only.
- **Dispatch Coverage** — AlfaOBD routine-ID coverage browser.

### Capabilities added for competitor parity
- **XC2268-class RFHUB parser** (`xc2268Rfhub.js`) — 2019+ internal-flash RFHUB (64 KB).
- **ZF-8HP TCU parser** (`zf8hp.js`) — GROUNDED on real bench dumps (the earlier synthetic "ZF8HP"-ASCII-header / per-64KB-block-CRC contract was fiction and is retired). Two real formats: (1) OBDSTAR-tool internal-EEPROM dump (128 KB, `OBDSTAR6` filler) whose identity block is mirrored ~3x and holds two ADJACENT VINs (17 ASCII each, NO per-VIN checksum) plus the ZF unit number (`1034420271`=8HP95), Mopar p/n (`05035827AC`), ZF calibration (`0260TP1122V02`) and build date; (2) Infineon TriCore program flash (2 MB `.HexTemp`, software version `TPROT_TC_G2_V05.01.00` @0x1F00, no VIN). VINs are check-digit validated + require an alphabetic WMI char (rejects calibration junk like `1034420271011270H`). `patchZf8hpVin` rewrites the ASCII VIN in every mirror of a named source VIN (refuses to guess when a dump carries two distinct VINs; no checksum recompute — none exists). ISN/global integrity are not located, so neither is read or written. Flash is read-only.
- **Mopar radio codes** (`moparRadioCode.js`) — legacy RAQ/REF code derivation.
- **2019+ Dealer Lockout Bypass** (`dealerLockoutBypass.js`) — 5-step state machine surfaced on `RfhubTab`, gated on observed NRC `0x36`/`0x37` + `XC2268_RFHUB` inspector hint (or bench-override checkbox).
- **Radio Codes tab** (`radiocodes`).

### Transponder writer bridge (`KEY WRITER` tab)
`keyWriter/` USB-CDC bridge that hands a single RFHUB slot's chip ID + resolved SEC16 master secret to Xhorse VVDI Mini / Tango writers via Web Serial (with a Simulator fallback for bench dry-runs). `burnSlot()` runs ping → detect → burn → verify with refuse-on-doubt gates (`securityBytes.js`-style: blank SEC16, wrong chip family, id-shape mismatch, or unknown writer all halt before any bytes leave the host). Chip burn only — vehicle pairing still goes through the existing RoutineControl 0x0401 flow on RFHUB tab. Protocol framing matches public VVDI captures but is **unverified**; see `docs/key-writer-bridge.md`.

### Vendored external tools (`artifacts/srt-lab/vendor/`)
Two Windows binaries pre-staged for internal bench use with manifests + READMEs:
- **FCA PROXI Tool v1.2.0.1** (`vendor/fca-proxi/`) — Stellantis PROXI tool. License bypass via Safengine-Shielden DLL sideload (`shfolder.dll`). Activated against HWID `2899614-B9E65D4-73F1D98-D6D5DCB`. Launch with CWD set to the vendor folder.
- **GPEC Unlocker v1.0** (`vendor/gpec-unlocker/`) — WinLicense-protected .NET binary for Continental GPEC2A unlock.

Surfaced via **External Tools tab** (`exttools`) with status / Launch / Reveal-in-Folder backed by `POST /tools/{status,launch,reveal}` on the J2534 bridge. Native PROXI JS module: `src/lib/fcaProxi.js` (parse/serialize/build + 22 Vitest tests).

Reference docs: `artifacts/srt-lab/docs/{fca-proxi-reference,sgw-and-uds-reference,villain-binary-intel,villain-unpack-workflow}.md`. Decompiled Python source: `tools/fca-proxi-extract/src/`.

### VILLAIN `0x27/0x61` algorithm (quarantined)
Candidate in `artifacts/srt-lab/src/lib/_unverified/villain27_61.candidate.js`. Structurally promoted to `src/lib/villain27_61.js` and surfaced in `algos.js` as `villain_0x61`, **gated behind `ENABLE_VILLAIN_0x61` (defaults `false`)** because the embedded S-box is still the identity-permutation placeholder. Flipping the flag before the real 256-byte `FCA_SBox` is substituted will produce keys the ECU rejects with NRC `0x35`. SeedTab picker iterates `ALGOS`, so it appears automatically the moment the flag flips.

## External Dependencies

- **Node.js** 24, **pnpm** for monorepo workspaces.
- **React** 18+, **Vite** for the SPA.
- **Anthropic API** — AI module assistant (`/api/anthropic/module-assistant`, `/api/anthropic/conversations`).
- **Web Serial API** — OBD-II.
- **Python J2534 driver** (`tools/python-bridge/`) — localhost HTTP daemon, uses `pefile`.
- **PostgreSQL** — API server storage (conversations, vehicleJobs, investigation runs).
- **`ilspycmd`** — decompiler for the `alfaobd-extractor` pipeline.
- **`librsvg` + ImageMagick** — `scripts/build-flyer.mjs` marketing flyers.
- **FCA Seed-to-Key DLLs** — unlock coverage in the J2534 desktop driver.
- **AlfaOBD.exe** — user-supplied binary processed by `alfaobd-extractor` for structured JSON.

---

Historical notes (per-task narrative, file-drop provenance, secret-rotation history): see [`CHANGELOG.md`](CHANGELOG.md).
