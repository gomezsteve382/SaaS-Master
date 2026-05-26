#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/udsDispatchWithRouting.generated.js from
// attached_assets/alfaobd-package-2026-05-25/uds-dispatch-with-routing.json.
//
// 2,786 dispatch records: each is a UDS frame paired with the nearest preceding
// decrypted strings in its enclosing method's IL. The strings name the routine
// context (ECU codes, CAN bus name, numeric IDs, sometimes literal key bytes).
//
// Usage: node scripts/codegen-uds-dispatch-routing.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(
  repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/uds-dispatch-with-routing.json",
);
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/udsDispatchWithRouting.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));

// Group dispatch records by source method
const byMethod = {};
for (const r of src.dispatch) {
  if (!byMethod[r.method]) byMethod[r.method] = [];
  byMethod[r.method].push(r);
}
const methodSummary = Object.fromEntries(
  Object.entries(byMethod).map(([m, rs]) => [m, rs.length]),
);

// Rich records have >=2 context strings — most useful
const rich = src.dispatch.filter((r) => r.context.length >= 2);

// Extract candidate static keys (10-char hex strings near SecurityAccess frames)
const candidateKeys = [];
for (const r of src.dispatch) {
  if (r.sid !== 0x27) continue;
  for (const c of r.context) {
    const txt = c.text;
    if (typeof txt !== "string") continue;
    if (txt.length === 10 && /^[0-9A-F]+$/.test(txt)) {
      candidateKeys.push({
        method: r.method,
        frame: r.frame_hex,
        candidate_key_hex: txt,
        distance: c.distance,
        warning: "STATIC bytes from IL — may be expected response, NRC, or part-id, NOT confirmed crypto key",
      });
    }
  }
}

const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/uds-dispatch-with-routing.json
// Re-extract:
//   python3 scripts/extract-uds-dispatch-with-routing.py  # produces this JSON
//   node    scripts/codegen-uds-dispatch-routing.mjs       # this file
//
// 2,786 UDS dispatch records: each is a UDS frame extracted from AlfaOBD.exe IL,
// paired with the nearest preceding DECRYPTED strings in its enclosing method.
// The strings name the routine context (ECU codes, CAN bus name, numeric IDs).
//
// The Dotfuscator obfuscation was defeated by per-method salt-recovery:
//   1. Each method that calls h() has a single \`stloc <local>\` at entry that
//      stores its salt value (e.g., SendActiveDiagnostic3 → salt=13,
//      SendActiveDiagnostic2 → 19, SendActiveDiagnosticStop → 10, yv → 8).
//   2. Every h() call in that method uses the same local as salt argument.
//   3. Algorithm: key = 0x6DDC67B5 + salt; XOR each byte with key&0xFF; key++;
//      byte-swap output pairs; decode as UTF-16-LE.
//
// Per-method salt + decrypted-string counts:
//   - SendActiveDiagnostic3 (salt=13, 1650 frames, 316 unique strings)
//   - SendActiveDiagnostic2 (salt=19, 870 frames, 175 strings)
//   - SendActiveDiagnosticStop (salt=10, 61 frames, 110 strings)
//   - yv (salt=8, 125 frames, 49 strings)
//   - ReceiveResult (salt=18, 1217 response-parser strings)
//   - CheckData (salt=11, 252 strings — precondition checker)
//   - 36 more methods, see methodSalts below
//
// ${rich.length} records have >=2 context strings (most actionable).
//
// ⚠ SECURITY-SENSITIVE: ${candidateKeys.length} candidate static-key hex constants found
//   near SecurityAccess frames. These are 10-char hex strings (= 5 bytes each)
//   that COULD be hardcoded master keys, but could also be expected response
//   bytes, negative-response codes, or part-id strings. DO NOT use these as
//   active seed-key constants without bench-verification against a real ECU.

export const UDS_DISPATCH_ROUTING_META = {
  source: "AlfaOBD.exe v2.5.7.0 IL extraction with Dotfuscator salt recovery",
  totalRecords: ${src.dispatch.length},
  richRecords: ${rich.length},
  methodsProcessed: ${Object.keys(src.methods).length},
  candidateStaticKeyCount: ${candidateKeys.length},
};

/** Per-method salt + decrypted-string count. Use this when re-running the
 *  extraction or when you need to know which method's strings to look at. */
export const UDS_METHOD_SALTS = ${j(Object.fromEntries(Object.entries(src.methods).map(([k, v]) => [k, {name: v.name, salt: v.salt, ilSize: v.il_size, strings: v.decrypted_count}])))};

/** Decrypted strings per method, keyed by method ID, with us_offset → text map.
 *  These are the strings each method's IL references via Dotfuscator-encrypted ldstr. */
export const UDS_METHOD_DECRYPTED_STRINGS = ${j(Object.fromEntries(Object.entries(src.methods).map(([k, v]) => [k, v.decrypted])))};

/** Full dispatch record list — every UDS frame in IL paired with nearby
 *  decrypted strings. Each record: \`method\`, \`frame_hex\`, \`sid\`, \`sid_name\`,
 *  \`frame_ip\`, \`context\` (list of {distance, us_off, text}). */
export const UDS_DISPATCH_WITH_ROUTING = ${j(src.dispatch)};

/** Frames-per-method distribution. */
export const UDS_DISPATCH_BY_METHOD_COUNT = ${j(methodSummary)};

/** ⚠ Candidate STATIC KEY bytes — 10-char hex strings (5 bytes) found near
 *  SecurityAccess (0x27) frames in IL. These MAY be hardcoded master keys for
 *  specific Tier-1 routines (e.g., SKIM/Immobilizer/test-bench unlocking) but
 *  could also be expected response patterns. Treat as PROVENANCE: CLAIMED, not
 *  VERIFIED. */
export const UDS_CANDIDATE_STATIC_KEYS = ${j(candidateKeys)};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${src.dispatch.length} dispatch records, ${candidateKeys.length} candidate static keys)`);
