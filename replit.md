# SRT Lab - Jailbreak Edition

## Overview

SRT Lab is a React single-page application designed as a workbench for FCA/Stellantis ECU modules. It runs entirely client-side, enabling functionalities such as patching VINs, managing immobilizer keys, and communicating over OBD-II via Web Serial. The project aims to provide comprehensive tools for diagnosing, programming, and "jailbreaking" vehicle ECUs, focusing on high-performance SRT, Demon, Hellcat, and Redeye models to unlock features and enhance vehicle customization.

## User Preferences

I prefer iterative development and value clear, concise communication. Please ask before making any major architectural changes or introducing new dependencies. I prefer detailed explanations for complex technical decisions. Do not make changes to the `tools/python-bridge/` folder or its contents.

## System Architecture

The application is built as a React SPA using Vite, with all binary processing handled client-side via `FileReader` and `Uint8Array`. A `MasterVinContext` manages the current VIN and per-module status across tabs. Core processing helpers in `src/lib/` include `parseModule` for auto-detecting and extracting fields from various ECU types (GPEC2A, RFHUB, BCM, 95640), `crossValidate` for inter-module rule checking and hex diffing, `crc.js` for verified CRC primitives, and `algos.js` for seed-to-key algorithms.

The UI/UX adheres to a consistent color palette of light base (`#F4F1EC`), SRT Red (`#D32F2F`), and black (`#1A1A1A`) accents, using Nunito for body text, Righteous for display, and JetBrains Mono for hex/data.

The system incorporates a desktop J2534 driver (a separate Python package located in `tools/python-bridge/`) for raw CAN PassThru when Web Serial is insufficient, communicating via a localhost HTTP daemon. Python dependencies for this bridge are managed separately to prevent conflicts with the main build process.

An API server (`artifacts/api-server/`) provides functionalities like download counters, module backups, diff reports, and an Anthropic AI module assistant. The AI assistant supports both stateless one-shot queries and persistent conversations, with conversation data stored in a database and scoped for per-launcher isolation, enabling features like the Mismatch Wizard to resume chats.

Key features and modules include:
- **Module Programming:** Dedicated tabs for BCM, RFHUB, ECM, and ADCM, handling VIN read/write, key programming, and module-specific unlocks.
- **Proxi Decoder (read-only):** `ProxiTab` decodes the BCM 0x2023 proxi blob (16 B from `BODY_PN_CONFIG` via `cgwConfig.decodeBcmConfig`) plus the curated DEnn family (`DE00`–`DE0C`, 155 fields) sourced from `bcmFeatureCatalog.generated.js` (extracted from the user-supplied `BCMConfiguration.tsx`). Two input modes — upload a BCM `.bin` (16 B sliced at offset `0x2023`) or paste hex for any DID with optional `62 DD DD` UDS header strip. UI shows a category sidebar (15 buckets, regex match order mirrors the source TSX), search, and grouped/expand-collapse rows. Intentionally no write path; encoder + UDS programmer ship in a follow-up once labels are ground-truthed against a real bench dump. Decoder + tests live in `src/lib/proxiDecoder.js` + `src/lib/__tests__/proxiDecoder.test.js`.
- **UDS Programmer:** A universal raw UDS console.
- **Data Management:** Tabs for viewing backups, session logs, and managing module dumps (load, auto-detect, VIN patch, hex viewer, virginizer).
- **Diagnostics:** Live OBD-II scanning, bench diagnostics, and a comprehensive FCA Analyzer for multi-file, cross-module audits.
- **Advanced Tools:** Seed-to-key calculator, GPEC/GPEC2A firmware unlocks, CAN bus diagnostics (SWARM), J2534 raw CAN PassThru, and calibration file analysis (C-FLASH).
- **Workflow Orchestration:** A `WORKFLOW` tab manages persistent `vehicleJobs`, provides a unified Module Census, and facilitates a Fix Plan builder with pluggable `SecurityAccessSource` for unlocking and verification steps.
- **CAN Universe (read-only catalog):** `CanUniverseTab` (id `canuniverse`) browses ~485 deduplicated CAN bus / OSS automotive projects merged from three upstream lists — `iDoka/awesome-canbus` (CC0), `eclipse-sdv-landscape/the-automotive-collection` (CC-BY-SA-4.0, canonical), and `ariexi/the-automotive-collection` (legacy snapshot) — plus a small user-curated extras block (currently `provrb/obdium`). The merger lives in `scripts/src/fetch-can-catalogs.mjs` (run via `pnpm -F @workspace/scripts run fetch:can-catalogs`) and writes the static `src/lib/awesomeCanbus.generated.js`. UI ships category sidebar with counts, search, source/tag filter chips, star-to-localStorage shortlist (`srtlab.canUniverse.shortlist.v1`) with JSON export, and a "How these plug into SRT Lab" hints panel mapping categories to existing tabs (J2534 Bridge, Live OBD, UDS Programmer, SWARM, Module Inspector). Strictly read-only — no downloads, no executions, no auto-wiring; per-entry integration is a separate decision.

The `parseModule()` function merges original analysis with richer `fca_module_analyzer` for deeper extraction of data points across GPEC2A, RFHUB, BCM, and 95640 modules. `crossValidate()` performs cross-vehicle matching by comparing VINs and security bytes across different modules.

File type detection is based on file size and content patterns to identify BCM D-FLASH, 95640 EEPROM, GPEC2A, RFHUB EEE, and general firmware files.

## Vendored External Tools (`artifacts/srt-lab/vendor/`)

Two Windows binaries are pre-staged with their license bypass intact for internal bench use:

- **FCA PROXI Tool v1.2.0.1** (`vendor/fca-proxi/`): PyInstaller bundle of Stellantis' PROXI configuration tool. Uses a Safengine-Shielden DLL sideload (`shfolder.dll`) to bypass the license check. Activated against HWID `2899614-B9E65D4-73F1D98-D6D5DCB`. The EXE must be launched with CWD set to the vendor folder so the sideload resolves before `%SYSTEM32%`.
- **GPEC Unlocker v1.0** (`vendor/gpec-unlocker/`): WinLicense-protected .NET binary for Continental GPEC2A unlock. No separate license file required.

Each vendor directory contains `manifest.json` (SHA-256 + byte-size for every file) and `README.md`.

The **External Tools tab** (`src/tabs/ExternalToolsTab.jsx`, id `exttools`) lists both tools with status (present/missing/bridge-offline), a Launch button, and a Reveal in Folder button. Launch and Reveal are handled by three new J2534 bridge endpoints: `POST /tools/status`, `POST /tools/launch`, `POST /tools/reveal`.

The **native PROXI JS module** (`src/lib/fcaProxi.js`) provides: `parseProxi()`, `serializeProxi()`, `buildProxi()`, `validateLicenseJson()`, `verifyManifest()`. All functions are covered by 22 Vitest tests in `src/tabs/__tests__/fcaProxi.test.js`.

Decompiled Python source from the PyInstaller bundle is in `tools/fca-proxi-extract/src/` (hwid.py, license_check.py, proxi_record.py, uds_transport.py). The full reverse-engineering reference is in `artifacts/srt-lab/docs/fca-proxi-reference.md`. SGW protocol and UDS function map is in `artifacts/srt-lab/docs/sgw-and-uds-reference.md`. Third-party binary intel for `VILLAIN_protected.exe` (CAN IDs, UDS service map, FCA DIDs, RoutineControl IDs, claimed `0x27 0x61` seed-to-key algorithm — all unverified) is in `artifacts/srt-lab/docs/villain-binary-intel.md`. The step-by-step bench methodology for independently verifying the unpacking and the `0x27 0x61` seed/key algorithm is in `artifacts/srt-lab/docs/villain-unpack-workflow.md`. The candidate JS implementation of `CalculateSecurityKey_0x61` (with placeholder S-box) lives in `artifacts/srt-lab/src/lib/_unverified/villain27_61.candidate.js`; the quarantine policy for that directory is in its `README.md`. Nothing in `_unverified/` is imported by application code until the Phase 3 integration gate passes. The algorithm has been **structurally promoted** to `artifacts/srt-lab/src/lib/villain27_61.js` (Steps 1–4 verbatim from the candidate) and surfaced in `algos.js` as `ALGOS` entry `villain_0x61`, gated behind the `ENABLE_VILLAIN_0x61` feature flag exported from `algos.js`. The flag **defaults to `false`** because the embedded S-box is still the identity-permutation placeholder — flipping it true before the real 256-byte `FCA_SBox` is substituted will produce keys the ECU rejects with NRC 0x35. The SeedTab picker (`SeedTab.jsx`) iterates `ALGOS`, so the entry appears in the calculator automatically the moment the flag is flipped. The `_unverified/` candidate file and its bench-pair harness remain in place per the workflow doc's "team preference" footnote (so the existing test fixtures keep running unchanged until real bench pairs land).

## `@workspace/uds` Library (`lib/uds/`)

A complete ISO 14229-1 UDS (Unified Diagnostic Services) TypeScript library, registered as a composite pnpm workspace lib. Covers:

- **services.ts** — full ISO 14229 service table (0x10–0x87) with sub-functions
- **nrc.ts** — complete NRC table (0x10–0x93) with shortName, description, isPending flag
- **constants.ts** — sessions, resetTypes, securityLevels, routineControlTypes, dtcStatusMask, commCtrlTypes, ioControlParams, dtcSettingTypes, linkControlBaudrates
- **build.ts** — pure frame builders for every standard UDS service (all return Uint8Array)
- **parse.ts** — generic parseResponse + service-specific parsers (RDBI, SecurityAccess, RoutineControl, RequestDownload)
- **dids.ts** — 0xF1xx standard identification block + common DID catalog with decode functions
- **isotp.ts** — SF/FF/CF/FC encode+decode + segmentPayload for ISO 15765-2 framing
- **index.ts** — barrel with named exports and `build.*`/`parse.*`/`nrc.*`/`services.*`/`dids.*`/`isotp.*` namespaces
- **54 unit tests** in `src/__tests__/uds.test.ts` covering all builders, NRC round-trip, ISO-TP segmentation, and parsers
- **README.md** with 5 worked examples (Read VIN, Write VIN, SecurityAccess handshake, RoutineControl, flash download)

The existing BCM frame builder (`artifacts/srt-lab/src/lib/alfaobdMined/udsFrameBuilder.js`) was refactored to delegate WDBI frame assembly to `build.writeDataByIdentifier` and routine/reset frames to `build.routineControl`, `build.clearDiagnosticInformation`, and `build.ecuReset`. Public API and read-modify-write bit logic are unchanged.

## Task #634 — Competitor Parity Additions

Four new bench-tool capabilities, modeled on the screenshot reference in `.local/tasks/task-634.md`:

- **XC2268-class RFHUB parser** (`src/lib/xc2268Rfhub.js`): 2019+ internal-flash RFHUB image (64 KB). Detects the `XC22`/`RFHUB` header + variant byte at 0x0020 (0x01/0x02/0x03), reads two VIN slots with CRC16/CCITT, and validates the image-wide BE32 checksum. Refuses to write when the variant tag is unknown or any banner is set. Companion `patchXc2268Vin()` re-stamps VIN slots and re-computes both per-slot CRC16 and the image-wide checksum.
- **ZF-8HP TCU parser** (`src/lib/zf8hp.js`): `ZF8HP` header + variant 0x45/0x70/0x90 (845RE / 8HP70 / 8HP90), 256 KB / 512 KB / 1 MB images, two VIN slots per variant with CRC16/CCITT, per-64KB-block CRC32 (zlib polynomial). `patchZf8hpVin()` writes VIN + recomputes every touched block's CRC32.
- **Mopar radio code derivations** (`src/lib/moparRadioCode.js`): pinned algorithm for legacy Mopar RAQ/REF radio codes from serial number (e.g. RBZ12345 → 7176). Deterministic — refuses unsupported serial prefixes.
- **2019+ Dealer Lockout Bypass** (`src/lib/dealerLockoutBypass.js`): pure 5-step state machine — extended session (0x10 0x03) → alt-level security access (0x27 0x0B) → RoutineControl 0xFF00 with 4-byte clear payload → ECU reset (0x11 0x01) → re-probe 0x27 0x01 to confirm. Uses `@workspace/uds` builders with correct `subFunction` / `resetType` / `type` / `routineIdentifier` / `routineOptionRecord` parameter names. Each step surfaces its exact request bytes / response / NRC.

Wiring:
- `parseModule.js` auto-detects both new families before the UNKNOWN bucket via header signatures, and surfaces full parser payloads on `info.xc2268` / `info.zf8hp` (field names mirror the parsers — no rewrapping).
- `CANONICAL_SIZES_BY_TYPE`, `MODULE_MIN_SIZES`, `MODULE_MIN_LABELS` extended for both new families so the inspector's tooSmall guard works correctly.
- `FcaModuleInspector.jsx`: `INSPECTOR_TYPES` now includes `XC2268_RFHUB` and `ZF_8HP_TCU` so the cross-module browser surfaces them alongside GPEC2A/RFHUB/BCM.
- `RfhubTab.jsx`: new `DealerLockoutBypassCard` after the VIN status card. Run button is gated on (a) standard `unlockRfhub` having actually surfaced NRC 0x36 / 0x37 (recorded into `lockoutNrc` state) AND (b) the loaded inspector module being `XC2268_RFHUB`, with a visible "bench override" checkbox as the explicit opt-out. `lockoutNrc` clears on successful unlock or after a successful bypass via `onCleared`.
- New `RadioCodesTab.jsx` (id `radiocodes`) — registered between `exttools` and `sigdisc` in `App.jsx`.

Catalog: the canonical `public/unlock_catalog.json` is regenerated by `tools/python-bridge/tools/srtlab_unlock_catalog_gen.py` and the `unlock_catalog_extended.json` extension entries are repopulated by `tools/asset-sweep` from the DLL scan. Both are out of scope per the user preference "no edits to `tools/python-bridge/`". A hand-curated companion list of the four new capabilities lives in `public/task634_entries.json`; surfacing it in the Unlock Coverage tab is filed as a deferred follow-up.

## srt-lab-ultimate Merge (Task #842)

The external `srt-lab-ultimate` zip was merged into the monorepo as a verbatim file drop. Three landing zones:

- **`artifacts/srt-lab/src/lib/`** — four upstream files added to the existing artifact:
  - `bigMethodsVocabulary.generated.js` (1.1 MB) — user opted in this time despite the bundle-size note in the sister-repo integration rule.
  - `j2534Raw.js` — aliased from upstream `j2534.js` to avoid collision with existing `bridgeEngine.js`.
  - `export-report.ts` + `workbench-types.ts` — TS helpers, resolve via the `@/lib/*` path alias.
- **`scripts/src/`** — 36 codegen / extractor scripts (`codegen-*.mjs`, `extract-*.mjs`, `generate-*.mjs`, `decrypt-*.mjs`, plus a few Python helpers). All hard-coded `client/src/lib/srt/...` output paths were rewritten to `artifacts/srt-lab/src/lib/...`. A new `codegen:ultimate:*` namespace in `scripts/package.json` exposes them individually but **deliberately not chained into any `codegen:all`** — each one overwrites a `*.generated.js` and several would clobber audited local forks.
- **`artifacts/srt-lab-ultimate/`** — net-new directory holding the standalone React + Express + Drizzle reverse-engineering workbench (220 client files, 42 server files, MySQL/TiDB schema). **Not registered as an artifact and not wired into the workspace**: its `package.json`, `pnpm-lock.yaml`, and `tsconfig.json` were renamed to `*.from-zip` so pnpm-install does not try to resolve its 90+ deps and `tsc --build` does not pick up the orphan tsconfig. See `artifacts/srt-lab-ultimate/MERGED.md` for the full WIP state and the open questions (Drizzle MySQL→Postgres port, dependency catalog reconciliation, artifact registration decision).

Provenance: `.local/tasks/srt-lab-ultimate-merge.manifest.tsv` lists every zip entry with SHA-256 (349 NEW, 68 IDENTICAL with the `alfaobd-package-2026-05-25/` block imported in a prior task, 1 DIFFER on a charger PNG, 1 DENY on `.project-config.json`, 1 SKIP on a yarn-style wouter patch).

**Secret hygiene:** the source zip included a `.project-config.json` with **live credentials** (`ANTHROPIC_API_KEY`, `JWT_SECRET`, `DATABASE_URL` (TiDB), `DRIZZLE_DATABASE_URL`, `BUILT_IN_FORGE_API_KEY`, `SWARM_DELEGATE_SECRET`, `OAUTH_SERVER_URL`, several VITE_* Forge/OAuth keys, plus AWS STS `git_remote.*`). That file was deny-listed and never copied into the repo, but every credential listed there should be treated as compromised and rotated.

## Binary Intel Tab (Task #649)

`BinaryIntelTab.jsx` (id `binintel`) is a read-only report cross-reference that ingests hand-curated third-party binary-analysis reports from `src/lib/binaryIntel.generated.js` and maps each finding against SRT Lab's existing coverage. The first report is the VILLAIN intel (`VILLAIN_protected.exe`), covering CAN TX/RX IDs, UDS service map, FCA-proprietary DIDs, RoutineControl IDs, and a claimed `0x27/0x61` seed-to-key algorithm (unverified, S-box missing).

For each finding, the tab emits one of three coverage tags — **COVERED** (frame builder or dedicated UI exists), **PARTIAL** (related capability exists but specific sub-function / DID / algorithm step is missing), or **GAP** (net-new) — computed at runtime by the pure `binaryIntelCoverage.js` helper. A prominent "UNVERIFIED — THIRD-PARTY REPORT" banner sits at the top of each report card; the algorithm detail block for `0x27/0x61` is collapsed by default with a second warning that it is not wired into any executable code path. A search/filter box narrows all finding groups. Coverage logic is covered by 18 Vitest tests in `src/lib/__tests__/binaryIntelCoverage.test.js`. Tab is registered between `radiocodes` and `sigdisc` in `App.jsx`. Strictly read-only — no buttons that touch a real ECU.

## External Dependencies

- **Node.js**: Version 24
- **pnpm**: As the package manager for monorepo workspaces.
- **React**: Version 18+ for the frontend SPA.
- **Vite**: For frontend tooling and bundling.
- **Anthropic API**: For the AI module assistant (`/api/anthropic/module-assistant`, `/api/anthropic/conversations`).
- **Web Serial API**: For OBD-II communication.
- **Python-based J2534 Driver**: A custom desktop application for raw CAN PassThru, communicating via a localhost HTTP daemon. This driver utilizes `pefile` for Python provisioning.
- **SQLite Database**: Used by the API server for storing AI assistant conversations (`conversations` and `conversation_messages` tables) and `vehicleJobs` + `vehicleJobEvents`.
- **`ilspycmd`**: Decompiler used by the `alfaobd-extractor` pipeline.
- **`librsvg` and `ImageMagick`**: Used in `scripts/build-flyer.mjs` for generating marketing flyers.
- **FCA Seed-to-Key DLLs**: Referenced for unlock coverage in the J2534 desktop driver.
- **AlfaOBD.exe**: User-supplied binary processed by `alfaobd-extractor` to generate structured JSON data.