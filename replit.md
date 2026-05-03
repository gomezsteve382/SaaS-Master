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

The `parseModule()` function merges original analysis with richer `fca_module_analyzer` for deeper extraction of data points across GPEC2A, RFHUB, BCM, and 95640 modules. `crossValidate()` performs cross-vehicle matching by comparing VINs and security bytes across different modules.

File type detection is based on file size and content patterns to identify BCM D-FLASH, 95640 EEPROM, GPEC2A, RFHUB EEE, and general firmware files.

## Vendored External Tools (`artifacts/srt-lab/vendor/`)

Two Windows binaries are pre-staged with their license bypass intact for internal bench use:

- **FCA PROXI Tool v1.2.0.1** (`vendor/fca-proxi/`): PyInstaller bundle of Stellantis' PROXI configuration tool. Uses a Safengine-Shielden DLL sideload (`shfolder.dll`) to bypass the license check. Activated against HWID `2899614-B9E65D4-73F1D98-D6D5DCB`. The EXE must be launched with CWD set to the vendor folder so the sideload resolves before `%SYSTEM32%`.
- **GPEC Unlocker v1.0** (`vendor/gpec-unlocker/`): WinLicense-protected .NET binary for Continental GPEC2A unlock. No separate license file required.

Each vendor directory contains `manifest.json` (SHA-256 + byte-size for every file) and `README.md`.

The **External Tools tab** (`src/tabs/ExternalToolsTab.jsx`, id `exttools`) lists both tools with status (present/missing/bridge-offline), a Launch button, and a Reveal in Folder button. Launch and Reveal are handled by three new J2534 bridge endpoints: `POST /tools/status`, `POST /tools/launch`, `POST /tools/reveal`.

The **native PROXI JS module** (`src/lib/fcaProxi.js`) provides: `parseProxi()`, `serializeProxi()`, `buildProxi()`, `validateLicenseJson()`, `verifyManifest()`. All functions are covered by 22 Vitest tests in `src/tabs/__tests__/fcaProxi.test.js`.

Decompiled Python source from the PyInstaller bundle is in `tools/fca-proxi-extract/src/` (hwid.py, license_check.py, proxi_record.py, uds_transport.py). The full reverse-engineering reference is in `artifacts/srt-lab/docs/fca-proxi-reference.md`.

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