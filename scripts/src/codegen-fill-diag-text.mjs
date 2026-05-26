#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/fillDiagTextVocabulary.generated.js from
// the FillDiagText decrypted-string dump.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/fill-diag-text-vocabulary.json");
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/fillDiagTextVocabulary.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));
const totalStrings = src.total_unique_strings;
const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/fill-diag-text-vocabulary.json
//
// PROXI / vehicle-configuration vocabulary extracted from AlfaOBD.exe
// Method[1376] FillDiagText (247 KB IL, salt=1). ${totalStrings} unique strings
// labeling every PROXI byte enumeration, HVAC fan combination, button backlight
// color, indicator state, and component name AlfaOBD knows.
//
// Use this as the lookup reference when interpreting a raw PROXI dump:
// each byte/bit in PROXI corresponds to one of these labels.

export const FILL_DIAG_TEXT_META = {
  source: "AlfaOBD.exe v2.5.7.0 Method[1376] FillDiagText IL strings",
  salt: ${src.salt},
  uniqueStrings: ${totalStrings},
};

/** Full PROXI/vehicle-config string library, keyed by US heap offset. */
export const FILL_DIAG_TEXT_VOCABULARY = ${j(src.strings)};

/** Same content as an alphabetized array (easier for UI dropdowns/search). */
export const FILL_DIAG_TEXT_STRINGS_SORTED = ${j(Object.values(src.strings).sort())};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${totalStrings} strings)`);
