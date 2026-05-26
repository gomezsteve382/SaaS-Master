#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/receiveResultMessages.generated.js from
// attached_assets/alfaobd-package-2026-05-25/receive-result-messages.json
// — the categorized diagnostic message library from Method[2535] ReceiveResult.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(
  repoRoot,
  "attached_assets/alfaobd-package-2026-05-25/receive-result-messages.json",
);
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/receiveResultMessages.generated.js");

const src = JSON.parse(readFileSync(sourcePath, "utf-8"));
const cats = src.categorized_messages;
const totalMsgs = Object.values(cats).reduce((acc, arr) => acc + arr.length, 0);

const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/receive-result-messages.json
//
// Categorized diagnostic message library extracted from AlfaOBD.exe
// Method[2535] ReceiveResult (524 KB IL, salt=18, 1217 unique decrypted strings).
// This method is the UDS response parser — it formats every diagnostic outcome
// into a human-readable message for the operator.
//
// ${totalMsgs} categorized messages across ${Object.keys(cats).length} categories.

export const RECEIVE_RESULT_META = {
  source: "AlfaOBD.exe v2.5.7.0 Method[2535] ReceiveResult IL strings",
  salt: ${src.salt},
  totalDecrypted: ${src.total_decrypted},
  totalCategorized: ${totalMsgs},
};

/** Categorized FCA diagnostic messages. Use for UI lookup when an SRT Lab
 *  operation completes — match expected response patterns to provide a clear
 *  outcome explanation. */
export const RECEIVE_RESULT_MESSAGES = ${j(cats)};

/** Security-key transfer outcome messages (BCM ↔ RFH key transfer flow). */
export const SECURITY_KEY_TRANSFER_OUTCOMES = ${j(cats.security_key_transfer)};

/** VIN/PIN/PROXI programming outcome messages. */
export const VIN_PIN_PROXI_OUTCOMES = ${j(cats.vin_pin_proxi)};

/** DEF (Diesel Exhaust Fluid) system status messages. */
export const DEF_SYSTEM_MESSAGES = ${j(cats.def_system)};

/** DPF regeneration status messages. */
export const DPF_REGEN_MESSAGES = ${j(cats.dpf_regeneration)};

/** Hybrid/EV battery / high-voltage system messages. */
export const HYBRID_EV_MESSAGES = ${j(cats.hybrid_ev_battery)};

/** Communication-error messages. */
export const COMMUNICATION_ERROR_MESSAGES = ${j(cats.communication_errors)};

/** Test-precondition failure messages (why a routine wouldn't start). */
export const TEST_PRECONDITION_MESSAGES = ${j(cats.test_preconditions)};

/** Calibration/Learn-procedure outcome messages. */
export const CALIBRATION_OUTCOME_MESSAGES = ${j(cats.calibration_results)};

/** Sensor-related error messages. */
export const SENSOR_ERROR_MESSAGES = ${j(cats.sensor_errors)};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes, ${totalMsgs} messages)`);
