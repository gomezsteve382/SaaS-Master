#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25");
const OUT = resolve(repoRoot, "artifacts/srt-lab/src/lib");

const j = (v) => JSON.stringify(v);

// Vehicle dump analysis
{
  const src = JSON.parse(readFileSync(resolve(ASSETS, "vehicle-dump-analysis.json"), "utf-8"));
  const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/vehicle-dump-analysis.json
//
// Analysis of two real FCA vehicle EEPROM dumps the user provided:
//   - 196.2charger_BCMDFLASH_NEWVIN.bin (64 KB): 2019 Dodge Charger SRT Hellcat
//     BCM dump, VIN 2C3CCABG1KH539430
//   - 20RFHUB_6.2_FRESH_EEE.bin (4 KB): 2020 Charger 6.2 RFHUB (unprogrammed)
//
// Includes the actual VIN byte offsets in the BCM (4 copies at stride 0x20),
// part-number storage locations, and RFH serial identifiers.

export const VEHICLE_DUMP_ANALYSIS = ${j(src)};
`;
  writeFileSync(resolve(OUT, "vehicleDumpAnalysis.generated.js"), out);
  console.log(`Wrote vehicleDumpAnalysis.generated.js (${out.length.toLocaleString()} bytes)`);
}

// CDA SWF + PDF findings
{
  const cda = JSON.parse(readFileSync(resolve(ASSETS, "cda-swf-extracted.json"), "utf-8"));
  const final = JSON.parse(readFileSync(resolve(ASSETS, "session-final-intel.json"), "utf-8"));
  const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/cda-swf-extracted.json
//         attached_assets/alfaobd-package-2026-05-25/session-final-intel.json
//
// Chrysler Diagnostic Application v6 (CDA.swf) — wiTECH 2 Flash UI shell.
// 4.15 MB compressed / 8.72 MB decompressed.
// 46,283 ASCII strings, 396 unique service class names.
//
// Plus AlfaOBD_Help.pdf — critical clarifications about CodeCard format,
// Yellow Adapter requirement, license activation flow.

/** CDA.swf intelligence — UDS commands, wiTECH endpoints, security gateway
 *  classes, service registry. */
export const CDA_SWF_INTEL = ${j(final.cda_swf)};

/** AlfaOBD user manual key findings (clarifies CodeCard format, adapters). */
export const ALFAOBD_HELP_PDF_INTEL = ${j(final.help_pdf)};

/** Full CDA.swf string extraction (UDS / wiTECH / class names / services). */
export const CDA_SWF_EXTRACTED = ${j(cda)};
`;
  writeFileSync(resolve(OUT, "cdaSwfAndHelpPdf.generated.js"), out);
  console.log(`Wrote cdaSwfAndHelpPdf.generated.js (${out.length.toLocaleString()} bytes)`);
}
