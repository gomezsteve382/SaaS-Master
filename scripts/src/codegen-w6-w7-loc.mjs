#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = JSON.parse(readFileSync(
  resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25/w6-w7-il-location.json"),
  "utf-8"));
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/w6w7CipherLocation.generated.js");
const j = (v) => JSON.stringify(v);
const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/w6-w7-il-location.json
//
// Location and summary of W6/W7 cipher cores in AlfaOBD.exe IL.

/** W6 cipher core - 138 bytes, linear bit-shuffle, returns 2 bytes. */
export const W6_CIPHER_CORE_LOCATION = ${j(src.w6_cipher_core)};

/** W7 cipher harness - 765 bytes, loads 23 parameters + 6 helper-method calls. */
export const W7_CIPHER_HARNESS_LOCATION = ${j(src.w7_cipher_harness)};

/** Naming-confusion warning: methods 1594/1595 are also named w7/w6 but are UI button handlers, NOT cipher code. */
export const W6_W7_NAMING_NOTE = ${j(src.ui_event_handlers_not_cipher)};
`;
writeFileSync(outPath, out);
console.log(`Wrote ${outPath}`);
