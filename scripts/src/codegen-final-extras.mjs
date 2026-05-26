#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25");
const OUT = resolve(repoRoot, "artifacts/srt-lab/src/lib");
const j = (v) => JSON.stringify(v);

// ECU → routines cross-link
{
  const src = JSON.parse(readFileSync(resolve(ASSETS, "ecu-to-routines-crosslink.json"), "utf-8"));
  const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/ecu-to-routines-crosslink.json
//
// Cross-link between ECU type identifiers (from AlfaOBD's full registry, 672 types)
// and routine_ids from the catalog (Method[1163] .ctor). Match is by idx[0] (ECU
// family code) and idx[1] (ECU friendly name).
//
// ${src.meta.ecu_types_with_routine_matches} of ${src.meta.ecu_types_total} ECU types have one or more routine matches.
// ${src.meta.total_routine_mappings} total ECU→routine mappings.

export const ECU_TO_ROUTINES_META = ${j(src.meta)};

/** ECU type → { routine_count, routine_ids, routine_descriptions (sample) }.
 *  Use this to filter routines by ECU when an operator selects a specific module. */
export const ECU_TO_ROUTINES = ${j(src.ecu_to_routines)};
`;
  writeFileSync(resolve(OUT, "ecuToRoutines.generated.js"), out);
  console.log(`Wrote ecuToRoutines.generated.js (${out.length.toLocaleString()} bytes)`);
}

// VIN offset correction
{
  const src = JSON.parse(readFileSync(resolve(ASSETS, "vin-offset-correction.json"), "utf-8"));
  const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/vin-offset-correction.json
//
// CORRECTION to vin-offset-database.json's BCM_CHRYSLER claims.
// The package claimed VIN at 0x100/0x200; the actual 2019 Hellcat BCM dump
// stores VIN at 0x52E8/0x5308/0x5328/0x5348 (4 copies, stride 0x20) with a
// previously-undocumented record-prefix structure.

export const VIN_OFFSET_CORRECTION = ${j(src)};
`;
  writeFileSync(resolve(OUT, "vinOffsetCorrection.generated.js"), out);
  console.log(`Wrote vinOffsetCorrection.generated.js (${out.length.toLocaleString()} bytes)`);
}

// Help PDF full text
{
  const src = JSON.parse(readFileSync(resolve(ASSETS, "help-pdf-full-text.json"), "utf-8"));
  const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/help-pdf-full-text.json
//
// AlfaOBD_Help.pdf full text extraction (${src.total_pages} pages, ${src.full_text_concatenated.length.toLocaleString()} chars).
// 7 sections: Install, START tab, STATUS/FAULTS tab, ACTIVE DIAG tab,
// PLOTTED DATA tab, MANUAL CONNECT tab, ABOUT tab.

export const ALFAOBD_HELP_PDF_META = {
  totalPages: ${src.total_pages},
  totalCharacters: ${src.full_text_concatenated.length},
};

/** Per-page text from the AlfaOBD operator manual. */
export const ALFAOBD_HELP_PDF_PAGES = ${j(src.per_page)};
`;
  writeFileSync(resolve(OUT, "helpPdfFullText.generated.js"), out);
  console.log(`Wrote helpPdfFullText.generated.js (${out.length.toLocaleString()} bytes)`);
}
