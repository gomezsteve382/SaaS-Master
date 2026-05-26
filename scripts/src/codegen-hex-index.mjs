#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = JSON.parse(readFileSync(
  resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25/hex-index-from-binary.json"),
  "utf-8"));
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/binaryHexIndex.generated.js");
const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/hex-index-from-binary.json
//
// Numerical index of every CAN ID, DID, and DTC code found as a literal hex
// string in the 41,556-string AlfaOBD.exe vocabulary. Useful as a lookup table:
// when you see a CAN ID or DID in a live capture, search here for AlfaOBD's
// label.
//
// Caveats:
//   - 3-char hex CAN IDs (0x100-0x7FF) include both diagnostic IDs (0x744 BCM,
//     0x75F RFH) AND broadcast message IDs (0x10C, 0x20C etc. for wheel speed,
//     engine RPM, etc.). The high-occurrence ones (>200x) are almost certainly
//     broadcast message IDs that AlfaOBD passively monitors.
//   - 4-char hex DIDs include both UDS standard DIDs (F-region 0xF1xx) AND
//     FCA-proprietary DIDs (0x20xx PROXI/EOL range, 0xC5xx/0xC6xx calibration).
//   - DTCs are filtered to ASCII P/B/C/U-format only — 242 unique. This is the
//     real DTC count AlfaOBD references in its IL strings (vs. the fabricated
//     20,043 from the earlier regex-on-corrupted-db extraction).

export const BINARY_HEX_INDEX_META = ${j(src.meta)};

/** 3-character hex tokens in range 0x100-0x7FF that appear in the binary —
 *  CAN message IDs (both diagnostic and broadcast). Keyed by \`0xXXX\` string. */
export const ALFAOBD_CAN_IDS_FROM_BINARY = ${j(src.can_ids)};

/** 4-character hex tokens — UDS DIDs (Data Identifiers) and RoutineControl RIDs. */
export const ALFAOBD_DIDS_FROM_BINARY = ${j(src.dids)};

/** ASCII P/B/C/U-format DTC codes — 242 unique. */
export const ALFAOBD_DTCS_FROM_BINARY = ${j(src.dtcs)};
`;
writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes)`);
