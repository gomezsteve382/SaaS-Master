#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25");
const OUT = resolve(repoRoot, "artifacts/srt-lab/src/lib");

const j = (v) => JSON.stringify(v);

const dispatch = JSON.parse(readFileSync(resolve(ASSETS, "cctor-dispatch-pairs.json"), "utf-8"));
const pairs = JSON.parse(readFileSync(resolve(ASSETS, "cctor-all-ldstr-pairs.json"), "utf-8"));

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/cctor-dispatch-pairs.json
//         attached_assets/alfaobd-package-2026-05-25/cctor-all-ldstr-pairs.json
//
// Adjacent-ldstr-pair extraction from AlfaOBD.exe Method[5] .cctor.
// 7,192 total ldstrs in .cctor; 3,596 adjacent decrypted-string pairs.
//
// The cctor builds AlfaOBD's runtime data tables via sequences of ldstr pairs:
//   ldstr <KEY>; ... ldstr <VALUE>; <some-dict-assign>
//
// Two filtered subsets are especially actionable:
//   1. 863 (4-digit-id, 2-hex-byte) pairs — \`numeric_id\` -> single byte. Looks
//      like routine-id -> command-byte or status-code mapping. Most start at
//      label IDs 3028-3050 with bytes 0x07, 0x09, 0x10, 0x11, 0x12, 0x43, 0x44...
//   2. 45 (numeric, hex-frame) pairs — \`numeric_id\` -> multi-byte UDS frame.
//      E.g. 6812 -> '0003405018', 7721 -> '0003404116'. Format is 5-byte
//      KWP/legacy framing: '00 03 [40/50/70] [XX] [YY]'.

export const CCTOR_META = {
  totalLdstrsInCctor: ${pairs.total_ldstrs},
  totalAdjacentPairs: ${pairs.total_pairs_adjacent},
  filtered4DigitTo2HexCount: ${pairs.filtered_4digit_to_2hex.length},
  filteredNumericToHexFrameCount: ${pairs.filtered_numeric_to_hex_frame.length},
};

/** Adjacent ldstr pairs from .cctor where first is a 4-digit decimal (likely
 *  routine_id or ECU code) and second is a 2-hex-byte string (single byte). */
export const CCTOR_4DIGIT_TO_BYTE = ${j(dispatch.four_digit_to_two_hex_pairs)};

/** Adjacent ldstr pairs where first is a numeric_id (5+ digits) and second is
 *  a multi-byte hex string (UDS/KWP-style frame). 5-byte frames in 00 03 X Y Z form. */
export const CCTOR_NUMERIC_TO_FRAME = ${j(dispatch.numeric_to_uds_frame_pairs)};

/** First 500 adjacent ldstr pairs (raw, including non-numeric ones). Useful
 *  for studying the .cctor data-table-building patterns. */
export const CCTOR_FIRST_500_PAIRS = ${j(dispatch.all_pairs_first_500)};
`;

writeFileSync(resolve(OUT, "cctorPairs.generated.js"), out);
console.log(`Wrote cctorPairs.generated.js (${out.length.toLocaleString()} bytes)`);
