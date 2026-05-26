#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = JSON.parse(readFileSync(
  resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25/acc-aeb-vocabulary.json"),
  "utf-8"));
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/accAebVocabulary.generated.js");

const j = (v) => JSON.stringify(v);
const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/acc-aeb-vocabulary.json
//
// ACC (Adaptive Cruise Control), AEB (Automatic Emergency Braking), FCW (Forward
// Collision Warning), and PEB (Pedestrian Emergency Braking) crash-event data
// vocabulary extracted from AlfaOBD.exe Method[2143] ir (41 KB IL, salt=19).
//
// This is the method that handles Tier-1 routines 2504/2505/2507/2508
// (RF-HUB family) — those routine_ids appear ONLY in this method as dictionary
// keys, not in the main catalog. AlfaOBD uses them to display the FCA Event
// Data Recorder fields after a collision-mitigation event has been triggered.
//
// ${src.unique_strings} unique strings categorized across 4 buckets.

export const ACC_AEB_META = {
  source: "AlfaOBD.exe v2.5.7.0 Method[2143] ir",
  salt: ${src.salt},
  uniqueStrings: ${src.unique_strings},
  tier1RoutinesHandled: [2504, 2505, 2507, 2508],
};

/** ACC/AEB/FCW/PEB warning text — operator-visible status messages. */
export const ACC_AEB_WARNING_TEXT = ${j(src.categories.acc_aeb_warning_text)};

/** Crash-event recorder data fields — every parameter the radar/cameras log
 *  when a collision-mitigation event is triggered. */
export const CRASH_EVENT_DATA_FIELDS = ${j(src.categories.crash_event_data_fields)};

/** Crash-event kinematics labels (velocity / acceleration / angle / distance). */
export const CRASH_EVENT_KINEMATICS = ${j(src.categories.crash_event_kinematics)};

/** Other diagnostic text from this method. */
export const ACC_AEB_OTHER_TEXT = ${j(src.categories.other_diagnostic_text)};
`;
writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${src.unique_strings} strings)`);
