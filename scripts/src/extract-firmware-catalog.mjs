#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/firmwareCatalog.generated.js from the
// source firmware_database.json in attached_assets/.
//
// Usage: node scripts/extract-firmware-catalog.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(
  repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/firmware_database.json",
);
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/firmwareCatalog.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));
const entries = src.firmware;
const byType = {};
for (const e of entries) {
  const t = e.module_type ?? "UNKNOWN";
  (byType[t] ??= []).push(e);
}
const countByType = Object.fromEntries(
  Object.entries(byType).map(([k, v]) => [k, v.length]),
);

const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/firmware_database.json
// Re-extract: node scripts/extract-firmware-catalog.mjs
//
// FCA/Stellantis firmware files cataloged from a wiTECH 2 release. Each
// entry has a real Mopar part number, its .efd filename, controller type,
// calibration text (year+platform+engine), and application metadata.
//
// ${entries.length} firmware files across ${Object.keys(byType).length} module types (${Object.entries(countByType)
  .map(([k, v]) => `${k}:${v}`)
  .join(", ")}).
// Sourced from a wiTECH backend dump, not from AlfaOBD.

/** Complete firmware catalog. */
export const FIRMWARE_CATALOG = ${j(entries)};

/** Group by module type for fast UI filtering. */
export const FIRMWARE_BY_MODULE_TYPE = ${j(byType)};

export const FIRMWARE_CATALOG_META = {
  totalFiles: ${entries.length},
  moduleTypes: ${j(Object.keys(byType).sort())},
  countByType: ${j(countByType)},
  source: "wiTECH 2 backend release (received 2026-05-25)",
};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${entries.length} entries)`);
