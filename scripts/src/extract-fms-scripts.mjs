#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/fmsScripts.generated.js from fms_analysis.json.
// Full per-script string dumps stay in the source JSON; the generated file
// keeps only the first 30 strings per script + summary metadata.
//
// Usage: node scripts/extract-fms-scripts.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(
  repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/fms_analysis.json",
);
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/fmsScripts.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));
const slim = src.scripts.map((s) => ({
  filename: s.filename,
  fileSize: s.file_size,
  stringSample: (s.strings ?? []).slice(0, 30),
  totalStrings: (s.strings ?? []).length,
}));

const j = (v) => JSON.stringify(v);
const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/fms_analysis.json
// Re-extract: node scripts/extract-fms-scripts.mjs
//
// FMS (Flash Manager Script) files used by wiTECH to drive ECU flash
// reprogramming workflows. Each .fms is a state machine for one flash
// procedure. Common UDS commands referenced across all 21 scripts:
//   0x10 DiagSession, 0x11 ECUReset, 0x22 ReadDID, 0x27 SecurityAccess,
//   0x2E WriteDID, 0x31 RoutineControl, 0x34 RequestDownload,
//   0x36 TransferData, 0x37 RequestTransferExit.
// Protocols: ISO9141. Baudrates: 9600, 10400, 1000000 (CAN-FD).

/** Per-script metadata + first 30 strings (full strings preserved in source JSON). */
export const FMS_SCRIPTS = ${j(slim)};

export const FMS_COMMON_COMMANDS = ${j(src.common_commands)};
export const FMS_PROTOCOLS = ${j(src.protocols_found)};
export const FMS_BAUDRATES = ${j(src.baudrates_found)};

export const FMS_SCRIPTS_META = {
  totalScripts: ${src.total_scripts},
  source: "wiTECH FMS dump (received 2026-05-25)",
  note: "Full per-script string dumps live in the source JSON. Slimmed here for browser bundle size.",
};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${slim.length} scripts)`);
