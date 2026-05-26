#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/alfaobdExtractedText.generated.js from
// extraction-report.md. Parses the markdown sections "Routine Descriptions",
// "Security Access Data", "ECU/Device Names Found", "UDS Service References".
//
// Usage: node scripts/extract-alfaobd-extracted-text.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(
  repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/extraction-report.md",
);
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/alfaobdExtractedText.generated.js");

const md = readFileSync(sourcePath, "utf-8");

const j = (v) => JSON.stringify(v, null, 2);

// Parse a numbered list following a heading until the next ## or "**Total"
function parseNumberedList(headerPattern, terminatorPattern) {
  const m = md.match(
    new RegExp(
      headerPattern.source + "\\s*\\n\\s*\\n(?:.*?\\n)?\\s*\\n([\\s\\S]*?)" + terminatorPattern.source,
    ),
  );
  if (!m) return [];
  const block = m[1];
  const items = [];
  const itemRegex = /(?:^|\n\n)(\d+)\. ([\s\S]*?)(?=\n\n\d+\. |\n\n\*\*|$)/g;
  let match;
  while ((match = itemRegex.exec(block)) !== null) {
    items.push(match[2].replace(/\n/g, " ").trim());
  }
  return items.filter(Boolean);
}

const routineDescs = parseNumberedList(/## Routine Descriptions \(English\)/, /\n\n+\*\*Total unique/);
const securityRefs = parseNumberedList(/## Security Access Data/, /\n\n+\*\*Total unique security/);

// ECU counts
const ecuMatch = md.match(/## ECU\/Device Names Found\s*\n([\s\S]*?)\n\n+## UDS Service References/);
const ecus = {};
if (ecuMatch) {
  for (const m of ecuMatch[1].matchAll(/\| (\w+) \| (\d+) \|/g)) {
    ecus[m[1]] = parseInt(m[2], 10);
  }
}

// UDS service references
const udsMatch = md.match(/## UDS Service References\s*\n([\s\S]*?)\n\n+## VIN/);
const udsRefs = {};
if (udsMatch) {
  for (const m of udsMatch[1].matchAll(/\*\*(\w+) \(0x([0-9A-Fa-f]+)\)\*\*: (\d+) references/g)) {
    udsRefs[`0x${m[2].toUpperCase()}`] = { name: m[1], occurrences: parseInt(m[3], 10) };
  }
}

// Routine occurrence count from the section header
const occMatch = md.match(/Found (\d+) occurrences of 'routine' keyword/);
const totalOccurrences = occMatch ? parseInt(occMatch[1], 10) : 0;

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/extraction-report.md
// Re-extract: node scripts/extract-alfaobd-extracted-text.mjs
//
// Text extracted from the (partially-decrypted) AlfaOBD catalog database.
// The .db was decrypted via the 1024-byte XOR key (see alfaobdDbXorKey.js)
// and is ~90-95% correct — text data is clean, integer-keyed tables less so.

/** Multilingual routine descriptions concatenated as they appear in the DB rows.
 * Each entry is a single concatenated multilingual string from one row of
 * the Diag_names table (or near it). The numeric Diag_Name_ID values were
 * lost to corruption; only the text bodies are recoverable here. */
export const ALFAOBD_ROUTINE_DESCRIPTIONS = ${j(routineDescs)};

/** Security access related multilingual text from the catalog. */
export const ALFAOBD_SECURITY_ACCESS_STRINGS = ${j(securityRefs)};

/** ECU occurrence counts in the database — proxy measure of UI coverage per ECU. */
export const ALFAOBD_ECU_OCCURRENCE_COUNTS = ${j(ecus)};

/** UDS service references found in the database. */
export const ALFAOBD_UDS_SERVICE_REFERENCES = ${j(udsRefs)};

export const ALFAOBD_EXTRACTED_TEXT_META = {
  routineDescriptionsCount: ${routineDescs.length},
  securityRefsCount: ${securityRefs.length},
  ecuCount: ${Object.keys(ecus).length},
  udsServiceCount: ${Object.keys(udsRefs).length},
  totalRoutineOccurrencesInDb: ${totalOccurrences},
  dtcCodesInSource: 20043,
  vinReferencesInSource: 538,
  source: "AlfaOBD encrypted .db (66 MB) decrypted with 1024-byte XOR key, text-extracted",
};
`;

writeFileSync(outPath, out);
console.log(
  `Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${routineDescs.length} routines, ${
    securityRefs.length
  } security refs)`,
);
