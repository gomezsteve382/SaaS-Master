#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/witechServices.generated.js from
// witech-backend-services.json (285 wiTECH 2 backend HTTP endpoints).
//
// Usage: node scripts/extract-witech-services.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(
  repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/witech-backend-services.json",
);
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/witechServices.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));

const slim = (s) => ({
  name: s.name,
  method: s.method,
  uri: s.uri,
  impl: s.implementation,
  sourceFile: s.source_file,
  dataType: s.dataType,
  requiredArgs: (s.arguments ?? []).filter((a) => a.required).map((a) => a.key),
  optionalArgs: (s.arguments ?? []).filter((a) => !a.required).map((a) => a.key),
});

const all = src.all_services.map(slim);
const vin = src.vin_services.map(slim);
const flash = src.flash_services.map(slim);

const j = (v) => JSON.stringify(v);
const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/witech-backend-services.json
// Re-extract: node scripts/extract-witech-services.mjs
//
// 285 backend HTTP service endpoints from a Stellantis dealer-services.xml
// (DealerCONNECT, NOT AlfaOBD-specific, NOT extracted from the AlfaOBD .db).
// API contract: getVIDfromVIN, getKeyCodes, getPROXI, updateImmobilizerInfo,
// getFlashListByVIN, all POSTing to /service/mds2002/Dispatcher.
//
// ${all.length} total services. ${vin.length} specifically for VIN operations. ${flash.length} for flash.

/** All ${all.length} wiTECH backend service endpoints. */
export const WITECH_SERVICES_ALL = ${j(all)};

/** Services that specifically handle VIN lookup / programming. */
export const WITECH_VIN_SERVICES = ${j(vin)};

/** Services that specifically handle flash operations. */
export const WITECH_FLASH_SERVICES = ${j(flash)};

export const WITECH_SERVICES_META = {
  totalServices: ${all.length},
  vinServices: ${vin.length},
  flashServices: ${flash.length},
  source: "wiTECH 2 release (dealer-services.xml + services.xml, received 2026-05-25)",
};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${all.length} services)`);
