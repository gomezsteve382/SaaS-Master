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
- **UDS Programmer:** A universal raw UDS console.
- **Data Management:** Tabs for viewing backups, session logs, and managing module dumps (load, auto-detect, VIN patch, hex viewer, virginizer).
- **Diagnostics:** Live OBD-II scanning, bench diagnostics, and a comprehensive FCA Analyzer for multi-file, cross-module audits.
- **Advanced Tools:** Seed-to-key calculator, GPEC/GPEC2A firmware unlocks, CAN bus diagnostics (SWARM), J2534 raw CAN PassThru, and calibration file analysis (C-FLASH).
- **Workflow Orchestration:** A `WORKFLOW` tab manages persistent `vehicleJobs`, provides a unified Module Census, and facilitates a Fix Plan builder with pluggable `SecurityAccessSource` for unlocking and verification steps.

The `parseModule()` function merges original analysis with richer `fca_module_analyzer` for deeper extraction of data points across GPEC2A, RFHUB, BCM, and 95640 modules. `crossValidate()` performs cross-vehicle matching by comparing VINs and security bytes across different modules.

File type detection is based on file size and content patterns to identify BCM D-FLASH, 95640 EEPROM, GPEC2A, RFHUB EEE, and general firmware files.

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