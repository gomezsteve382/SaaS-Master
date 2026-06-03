---
name: RfhubImmoSection generation dispatcher
description: Why RfhubImmoSection renders the BCM-style workbench for all RFHUB generations via a thin hook-stable dispatcher
---

RfhubImmoSection (shared by the VIN Programmer RFHUB sub-tab AND the standalone RFHUB inspector) renders the shared ImmoChecksumPanel workbench for EVERY supported RFHUB generation, not just XC2268: XC2268 internal-flash, plus Gen1 (24C16 / 2 KB) and Gen2 (24C32 / 4 KB) EEPROM. Gen1/Gen2 VIN edits delegate to the verified `patchRfhubVin` writer and run through `runGatedExport`; non-canonical / unrecognised sizes render null (read-only fall-through).

**Why dispatcher shape:** the default export must stay a thin dispatcher that calls exactly ONE hook (the `isXc2268Rfhub` useMemo) and then conditionally renders one of two child components (XC vs Legacy), each owning its own hooks. `isXc` depends on the loaded buffer, so if the parent instead early-returned before its own `useState`/`useCallback` calls, the hook count would change when the user swaps a Gen2 dump for an XC2268 dump mid-session → rules-of-hooks violation / React crash. Do NOT collapse the two children back into one branchy component with conditional hooks.

**Test contract to preserve:** `immoSections.ui.test.jsx` asserts a 64 KB all-0xAA buffer "renders nothing" — the Legacy child returns null for non-canonical sizes (analyzeRfhubVin → generation null), which keeps that green. XC2268 + Gen1/Gen2 reuse the SAME testids (`rfhub-immo-panel`/`-vin-input`/`-apply-btn`/`-status`) because the two children are mutually exclusive (never mounted together).

**SEC16 display drift:** the Legacy child has a local `readRfhSec16` that duplicates engParseRfh's Gen1/Gen2 SEC16 offsets (gen1 0x0226/0x023A, gen2 hdr 0xAA5531 01 @0x0500 → slots 0x050E/0x0522). It is read-only display only — no writer depends on it — but keep it in lockstep with engParseRfh if those offsets ever move.
