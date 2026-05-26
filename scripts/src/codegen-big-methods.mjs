#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/big-methods-strings.json");
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/bigMethodsVocabulary.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));
const all = src.all_strings_from_big_methods;

// Group by method_idx
const byMethod = {};
for (const e of all) {
  if (!byMethod[e.method_idx]) byMethod[e.method_idx] = { name: e.method_name, strings: [] };
  byMethod[e.method_idx].strings.push({ us_off: e.us_off, text: e.text });
}

const j = (v) => JSON.stringify(v);
const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/big-methods-strings.json
//
// 8,479 unique decrypted strings from AlfaOBD.exe's eight largest non-dispatcher
// methods, each with its own Dotfuscator salt recovered. These are the vocabulary
// libraries AlfaOBD uses to label specific FCA subsystems:
//
//   Method[2127] ProcessBody_ChryslerData (salt=0): 555 strings — Intelligent
//      Battery Sensor / BCM data labels
//   Method[2532] CheckPreConditions (salt=14):     301 strings — preflight
//      validation failure messages
//   Method[2079] j9 (salt=1):                      184 strings — Cruise Control
//      / engine learn-fields
//   Method[2216] gq (salt=19):                   6,693 strings — HV battery
//      contactor / BPCM hybrid-EV diagnostics
//   Method[2087] j2 (salt=4):                      120 strings — transmission
//      shifter type enumeration (PRNDL/PRNDS variants)
//   Method[2086] j3 (salt=11):                      47 strings — brake system /
//      vehicle speed signal labels
//   Method[2135] iz (salt=5):                      427 strings — per-wheel speed
//      sensor implausibility counters
//   Method[2160] ia (salt=0):                      152 strings — remote-start /
//      LID counter data

export const BIG_METHODS_META = {
  source: "AlfaOBD.exe v2.5.7.0 IL — eight largest non-dispatcher methods",
  totalUniqueStrings: ${all.length},
  methods: ${j(Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, { name: v.name, stringCount: v.strings.length }])))},
};

/** Per-method vocabulary, keyed by method index. Each entry has \`name\` and
 *  \`strings\` (list of {us_off, text}). */
export const BIG_METHODS_VOCABULARY = ${j(byMethod)};

/** HV battery / BPCM diagnostic vocabulary (Method[2216] gq) — the largest single
 *  vocabulary library for FCA hybrid/EV systems. */
export const HV_BATTERY_VOCABULARY = ${j(byMethod["2216"] || {})};

/** Transmission shifter type enumeration (Method[2087] j2). */
export const TRANSMISSION_SHIFTER_TYPES = ${j(byMethod["2087"] || {})};

/** Intelligent Battery Sensor / BCM body-data labels (Method[2127]). */
export const BODY_CHRYSLER_DATA_VOCABULARY = ${j(byMethod["2127"] || {})};

/** Wheel-speed implausibility counter labels (Method[2135] iz). */
export const WHEEL_SPEED_IMPLAUSIBILITY_VOCABULARY = ${j(byMethod["2135"] || {})};

/** Pre-condition failure messages (Method[2532] CheckPreConditions). */
export const CHECK_PRE_CONDITIONS_MESSAGES = ${j(byMethod["2532"] || {})};
`;
writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${all.length} strings across ${Object.keys(byMethod).length} methods)`);
