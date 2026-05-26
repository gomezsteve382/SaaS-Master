#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/udsDispatchFromExe.generated.js from
// attached_assets/alfaobd-package-2026-05-25/uds-dispatch-catalog.json
// (851 unique UDS frames extracted from AlfaOBD.exe IL — confirmed against
// CDA.swf's PROXI 22 20 23 / 2E 20 23 frames).
//
// Usage: node scripts/codegen-uds-dispatch.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(
  repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/uds-dispatch-catalog.json",
);
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/udsDispatchFromExe.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));

const groupBy = (sid) => src.frames.filter((f) => f.sid === sid);

const routineControl = groupBy(0x31);
const securityAccess = groupBy(0x27);
const rdbi = groupBy(0x22);
const wdbi = groupBy(0x2e);
const dsc = groupBy(0x10);
const ecuReset = groupBy(0x11);
const otherFrames = src.frames.filter(
  (f) => ![0x31, 0x27, 0x22, 0x2e, 0x10, 0x11].includes(f.sid),
);

// Build RID index for RoutineControl frames (RID = bytes[2..3] when len>=4)
const ridIndex = {};
for (const f of routineControl) {
  if (f.len < 4) continue;
  const rid = ((f.bytes[2] << 8) | f.bytes[3]).toString(16).padStart(4, "0").toUpperCase();
  if (!ridIndex[rid]) ridIndex[rid] = [];
  ridIndex[rid].push({
    sub: f.bytes[1],
    optionRecord: f.bytes.slice(4),
    occurrences: f.occurrences,
    hex: f.hex,
  });
}

// Build DID index for RDBI and WDBI
const ridFromDid = (bytes) => {
  if (bytes.length < 3) return null;
  return ((bytes[1] << 8) | bytes[2]).toString(16).padStart(4, "0").toUpperCase();
};
const didIndexRead = {};
for (const f of rdbi) {
  const did = ridFromDid(f.bytes);
  if (!did) continue;
  if (!didIndexRead[did]) didIndexRead[did] = [];
  didIndexRead[did].push({
    extraBytes: f.bytes.slice(3),
    occurrences: f.occurrences,
    hex: f.hex,
  });
}
const didIndexWrite = {};
for (const f of wdbi) {
  const did = ridFromDid(f.bytes);
  if (!did) continue;
  if (!didIndexWrite[did]) didIndexWrite[did] = [];
  didIndexWrite[did].push({
    payload: f.bytes.slice(3),
    occurrences: f.occurrences,
    hex: f.hex,
  });
}

const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/uds-dispatch-catalog.json
// Re-extract:
//   python3 scripts/extract-uds-dispatch-from-exe.py   # produces uds_frames_v3.json
//   python3 scripts/catalog-uds-frames.py              # dedupes -> uds-dispatch-catalog.json
//   node    scripts/codegen-uds-dispatch.mjs           # this file
//
// 851 unique UDS frames extracted from AlfaOBD.exe v2.5.7.0 IL — found by
// scanning every .NET method body for the IL pattern:
//
//   ldloc.X; ldc.i4 <idx>; ldc.i4 <val>; stelem.i1   (repeated)
//
// which is how AlfaOBD's SendActiveDiagnostic2 / SendActiveDiagnostic3 build UDS
// payloads. The frames extracted this way are the LITERAL portions (SID,
// subfunction, fixed DIDs, fixed RIDs, fixed option-record bytes). Parameterized
// values (computed key bytes for SecurityAccess 0x27+1, VIN bytes, EEPROM
// payloads) are NOT in here — those are runtime data.
//
// VERIFIED against CDA.swf:
//   * 22 20 23 PROXI Read  — 29 occurrences in IL  ✓
//   * 2E 20 23 PROXI Write — 66 occurrences in IL  ✓
//
// Breakdown (unique frames):
//   - ${routineControl.length} RoutineControl (0x31) frames spanning ${Object.keys(ridIndex).length} RIDs
//   - ${securityAccess.length} SecurityAccess (0x27) request-seed levels
//   - ${rdbi.length} RDBI (0x22) DIDs
//   - ${wdbi.length} WDBI (0x2E) DIDs
//   - ${dsc.length} DSC (0x10) session entries
//   - ${ecuReset.length} ECUReset (0x11) sub-functions
//   - ${otherFrames.length} other UDS service frames (ReadDTC, RequestDownload, etc.)

export const UDS_DISPATCH_META = ${j(src.meta)};

/** Full deduplicated UDS frame catalog. Each entry has \`hex\`, \`bytes\`, \`sid\`,
 *  \`sid_name\`, \`len\`, \`occurrences\`, and \`methods\` (which IL methods used the frame). */
export const UDS_DISPATCH_FRAMES = ${j(src.frames)};

/** RoutineControl frames grouped by RID (2-byte hex string, upper case, no \`0x\`). */
export const UDS_ROUTINE_CONTROL_BY_RID = ${j(ridIndex)};

/** SecurityAccess request-seed frames extracted from IL. Send-key frames (with
 *  computed key bytes) are NOT in this list — those are runtime-constructed. */
export const UDS_SECURITY_ACCESS_REQUESTS = ${j(securityAccess)};

/** RDBI frames keyed by DID (4-char hex, upper). */
export const UDS_RDBI_BY_DID = ${j(didIndexRead)};

/** WDBI frames keyed by DID (4-char hex, upper). */
export const UDS_WDBI_BY_DID = ${j(didIndexWrite)};

/** DiagnosticSessionControl (0x10) frames extracted, including FCA-specific
 *  sessions like 0x40, 0x50, 0x60, 0x70, 0x81, 0x92, 0xFA. */
export const UDS_DSC_FRAMES = ${j(dsc)};

/** ECUReset (0x11) frames extracted from IL. */
export const UDS_ECU_RESET_FRAMES = ${j(ecuReset)};

/** All other UDS service frames (ReadDTC, ClearDTC, TesterPresent, RequestDownload,
 *  TransferData, ExitTransfer, KWP-legacy). */
export const UDS_OTHER_FRAMES = ${j(otherFrames)};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${src.frames.length} unique UDS frames)`);
