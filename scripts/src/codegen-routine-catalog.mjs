#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/routineCatalogFromExe.generated.js and
// artifacts/srt-lab/src/lib/dispatchToRoutine.generated.js from the JSONs.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25");
const OUT = resolve(repoRoot, "artifacts/srt-lab/src/lib");

// ---- routineCatalogFromExe.generated.js ----
{
  const src = JSON.parse(readFileSync(resolve(ASSETS, "routine-catalog-from-exe.json"), "utf-8"));
  const j = (v) => JSON.stringify(v);
  const totalRoutines = Object.keys(src.routines).length;
  // Indexes
  const byEcuCode = {};      // idx[2] (numeric ECU code) -> routine_ids
  const byEcuFamily = {};    // idx[0]
  const byEcuName = {};      // idx[1]
  for (const [ridStr, fields] of Object.entries(src.routines)) {
    if (fields["2"]) {
      for (const piece of fields["2"].replace(/,/g, " ").split(/\s+/).filter(Boolean)) {
        if (!byEcuCode[piece]) byEcuCode[piece] = [];
        byEcuCode[piece].push(Number(ridStr));
      }
    }
    if (fields["0"]) {
      if (!byEcuFamily[fields["0"]]) byEcuFamily[fields["0"]] = [];
      byEcuFamily[fields["0"]].push(Number(ridStr));
    }
    if (fields["1"]) {
      if (!byEcuName[fields["1"]]) byEcuName[fields["1"]] = [];
      byEcuName[fields["1"]].push(Number(ridStr));
    }
  }

  const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/routine-catalog-from-exe.json
// Re-extract: python3 scripts/extract-routine-catalog-from-exe.py
//            node scripts/codegen-routine-catalog.mjs
//
// ${totalRoutines} routines with per-routine description fields extracted from
// AlfaOBD.exe IL. Found in Method[1163] .ctor (1.2 MB IL, salt=14) plus 4 supplementary
// methods. Each routine has 1-17 fields:
//   idx[0]: ECU family code (e.g. "MARELLI6F3_CAN", "TBM2", "CCN")
//   idx[1]: ECU friendly name (e.g. "Chrysler Pentastar/Hemi engine", "Radio Frequency HUB")
//   idx[2]: Decimal ECU numeric code (e.g. "825" for routine 1126, "55732" for 1520)
//   idx[3]: Vehicle applicability text (model list)
//   idx[4..14]: Various numeric parameters (model-year codes, security/session flags)
//   idx[15]: Model-year notes (e.g. "MY2020+", "MY2011+ Non-PowerNet")
//   idx[16]: Additional flag (often 0 or 1)
//
// Cross-reference with alfaobdData.generated.js DIAG_NAMES for the routine description.

export const ROUTINE_CATALOG_META = {
  source: "AlfaOBD.exe v2.5.7.0 IL extraction (Method[1163] .ctor + supplementary)",
  salt: ${src.total_routines ? 14 : "?"},
  totalRoutines: ${totalRoutines},
  primaryMethod: "Method[1163] .ctor",
};

/** Routine catalog: rid → { fieldIdx: text }. */
export const ROUTINE_CATALOG_FROM_EXE = ${j(src.routines)};

/** Index: idx[0] (ECU family code) → list of routine_ids. */
export const ROUTINE_BY_ECU_FAMILY = ${j(byEcuFamily)};

/** Index: idx[1] (ECU friendly name) → list of routine_ids. */
export const ROUTINE_BY_ECU_NAME = ${j(byEcuName)};

/** Index: idx[2] (decimal ECU numeric code) → list of routine_ids.
 *  This is the key field for cross-matching dispatch context strings against routines. */
export const ROUTINE_BY_ECU_CODE = ${j(byEcuCode)};
`;
  writeFileSync(resolve(OUT, "routineCatalogFromExe.generated.js"), out);
  console.log(`Wrote routineCatalogFromExe.generated.js (${out.length.toLocaleString()} bytes, ${totalRoutines} routines)`);
}

// ---- dispatchToRoutine.generated.js ----
{
  const src = JSON.parse(readFileSync(resolve(ASSETS, "dispatch-to-routine-resolved.json"), "utf-8"));
  const j = (v) => JSON.stringify(v);

  // Build a frame_hex → routine_ids map for unambiguous matches
  const unambig = {};
  for (const r of src.matched_dispatch) {
    if (r.matched_routine_count !== 1) continue;
    const rid = r.matched_routines[0].rid;
    if (!unambig[r.frame_hex]) unambig[r.frame_hex] = new Set();
    unambig[r.frame_hex].add(rid);
  }
  const unambigOut = {};
  for (const [hex, rids] of Object.entries(unambig)) {
    unambigOut[hex] = [...rids].sort((a, b) => a - b);
  }

  const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/dispatch-to-routine-resolved.json
// Re-extract: python3 scripts/match-dispatch-to-routines.py
//            node scripts/codegen-routine-catalog.mjs
//
// Resolves AlfaOBD.exe UDS dispatch frames (from udsDispatchWithRouting.generated.js)
// to routine_id(s) by cross-matching the decrypted-string context of each frame
// against the routine catalog idx[2] (ECU numeric code), idx[0] (ECU family),
// idx[1] (ECU friendly name).
//
// ${src.meta.matched_dispatch_count} dispatch records resolved to >=1 routine.
// ${src.meta.unambiguous_matches} unambiguous single-routine resolutions.
// ${src.meta.tier1_hits} Tier-1 routine hits (1126/1367/1520/1750/1751/2504-2508).
//
// Use UDS_FRAME_TO_ROUTINES below to look up which routine(s) a UDS frame
// hex string corresponds to. Many frames are SHARED across multiple routines
// (e.g., \`31 01 02 0B\` is used by 30+ routines on different ECUs). Use the
// frame + the target CAN ID + the SecurityAccess level to disambiguate.

export const DISPATCH_TO_ROUTINE_META = ${j(src.meta)};

/** Map: UDS frame hex string → list of resolved routine_ids (unambiguous matches only). */
export const UDS_FRAME_TO_ROUTINES = ${j(unambigOut)};

/** Full matched dispatch records (including multi-routine matches). Each entry:
 *  { method, frame_hex, sid, sid_name, matched_routine_count, matched_routines,
 *    matched_via, context }. */
export const MATCHED_DISPATCH_FULL = ${j(src.matched_dispatch)};
`;

  writeFileSync(resolve(OUT, "dispatchToRoutine.generated.js"), out);
  console.log(`Wrote dispatchToRoutine.generated.js (${out.length.toLocaleString()} bytes, ${Object.keys(unambigOut).length} unambiguous frames)`);
}
