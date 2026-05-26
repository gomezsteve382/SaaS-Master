#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/MASTER-security-syncing-keys-report.json");
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/securityMasterReport.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));
const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/MASTER-security-syncing-keys-report.json
//
// CONSOLIDATED SRT LAB INTEL — Security bytes, Module syncing, Key programming.
// Compiled from all extracted sources in this session:
//
//   - AlfaOBD.exe IL (41,556 unique decrypted strings across 1,596 methods)
//   - CDA.swf (Stellantis Authenticated Diagnostics layer)
//   - algorithm-catalog.json (380 W6 + 360 W7 cipher entries)
//   - Routine catalog (1,696 entries from Method[1163] .ctor)
//   - DIAG_NAMES (3,789 routine descriptions, 168 sync/key-related)
//   - AlfaOBD_Help.pdf (operator UI manual)
//   - Method[1140] .cctor (W7 cipher initialization with 12 byte-array constants)

export const SECURITY_MASTER_REPORT_META = ${j(src.meta)};

/** SECURITY BYTES section:
 *  - 8 unique SecurityAccess frame shapes extracted from IL
 *  - Cipher dispatch table (which wrapper for which family+level)
 *  - W6 (380) + W7 (360) cipher catalog sizes
 *  - Located cipher methods in IL (Method[204] w6 core, Method[203] w7 harness)
 *  - 57 real candidate 5-byte hex strings (after CAN-frame exclusion)
 *  - SecurityAccess outcome messages from ReceiveResult */
export const SECURITY_BYTES = ${j(src.security_bytes)};

/** MODULE SYNCING section:
 *  - All RFH ECU variants (RFH_200, RFH_CHEROKEE, RFH_COMPASS, RFH_CUSW,
 *    RFH_CUSW_OTTIMO, RFH_FGA, RFH_PN)
 *  - FOBIK transponder chips identified (PCF7961ATT, PCF7953ATT)
 *  - WIN modules (Wireless Ignition Node variants)
 *  - All ECU type variants for RFH/BCM/PCM/SKIM/SCM
 *  - 8 BCM ↔ RFH secret-key transfer status messages
 *  - RFH-specific status messages
 *  - Tier-1 routine descriptions (1126, 1520, 1750, 1751, 2504-2508, 1367)
 *  - SGW unlock flow (Authenticated Diagnostics for 2018+ vehicles) */
export const MODULE_SYNCING = ${j(src.module_syncing)};

/** PROGRAMMING KEYS section:
 *  - CodeCard flow (5-digit decimal input, 27 03/27 04 SA cycle, registry storage)
 *  - PIN flow (separate from CodeCard, 4-digit, distinct registry path)
 *  - SKIM/Immobilizer (PCF7936AS HITAG2 transponder, HCP-CBC handshake protocol,
 *    up to 8 FOBIKs paired per vehicle)
 *  - 168 Tier-1 sync routines from DIAG_NAMES with full descriptions */
export const PROGRAMMING_KEYS = ${j(src.programming_keys)};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes)`);
