#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/udsDidCatalog.generated.js from did-database.json.
//
// Usage: node scripts/extract-did-database.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(
  repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/did-database.json",
);
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/udsDidCatalog.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));

// F1xx range = ISO 14229 standard — high confidence.
const standard = {};
for (const [did, info] of Object.entries(src.standard_dids)) {
  standard[did] = { ...info, confidence: "iso14229_standard" };
}

// F1B0+ module-specific = mostly unverified, flag accordingly.
const moduleSpecific = {};
for (const [mod, modData] of Object.entries(src.module_specific ?? {})) {
  const dids = {};
  for (const [did, info] of Object.entries(modData.additional_dids ?? {})) {
    dids[did] = { ...info, confidence: "unverified_module_specific" };
  }
  moduleSpecific[mod] = { ...modData, additional_dids: dids };
}

const totalModuleSpecific = Object.values(moduleSpecific).reduce(
  (acc, m) => acc + Object.keys(m.additional_dids ?? {}).length,
  0,
);

const j = (v) => JSON.stringify(v, null, 2);
const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/did-database.json
// Re-extract: node scripts/extract-did-database.mjs
//
// UDS Data Identifier (DID) catalog. The F1xx-range entries are ISO 14229
// standard DIDs — high confidence. The module-specific entries (F1B0+
// per-module ranges) are educated guesses based on common FCA conventions;
// each is flagged with \`confidence: "unverified_module_specific"\` and
// should be validated against a real vehicle before use.

/** ISO 14229 standard DIDs (F186-F1A5 range). High confidence. */
export const UDS_STANDARD_DIDS = ${j(standard)};

/** Module-specific DID ranges (F1B0+). UNVERIFIED — needs bench validation. */
export const UDS_MODULE_SPECIFIC_DIDS = ${j(moduleSpecific)};

/** Common module-clone workflows from the source. UNVERIFIED step ordering. */
export const UDS_CLONE_WORKFLOWS = ${j(src.clone_workflows ?? {})};

export const UDS_DIDS_META = {
  standardCount: ${Object.keys(standard).length},
  moduleSpecificCount: ${totalModuleSpecific},
  source: "Combined ISO 14229 standard + FCA convention assumptions",
};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes)`);
