#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/ecuToCanFromExe.generated.js and
// artifacts/srt-lab/src/lib/securityIntelFromExe.generated.js from the JSON sources.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25");
const OUT = resolve(repoRoot, "artifacts/srt-lab/src/lib");

const j = (v) => JSON.stringify(v);

// ---- ecuToCanFromExe.generated.js ----
{
  const src = JSON.parse(readFileSync(resolve(ASSETS, "ecu-to-can-from-exe.json"), "utf-8"));
  const pairings = Object.entries(src.ecu_to_can);
  const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/ecu-to-can-from-exe.json
// Re-extract: python3 scripts/extract-ecu-to-can-from-exe.py
//            node scripts/codegen-ecu-to-can.mjs
//
// ${pairings.length} ECU-name → CAN-ID pairings extracted from AlfaOBD.exe IL
// by finding sequences \`ldstr <encrypted>; <salt-load>; call h; ldc.i4 <can_id>\`
// that look like dictionary-add operations.
//
// Notable Tier-1 mappings:
//   - "Radio Frequency HUB" → 0x600, 0x620 (legacy buses)
//   - "MARELLI_DASH"        → 0x514
//   - "TIPM_CGW"            → 0x149, 0x14E
//   - "AHBM"                → 0x500
//   - "AEB - P"             → 0x74C (BCM response channel)
//
// Vehicle-platform mappings:
//   - "MY2007-12 Non-PowerNet"  → 0x14E
//   - "MY2008-14 Non-PowerNet"  → 0x149
//   - "MY2011+ PowerNet"        → 0x620
//   - "MY2015+ non-PowerNet"    → 0x500
//   - "MY2019+ PowerNet"        → 0x504
//   - "RAM 1500/2500/3500/4500/5500" → 0x504
//   - "(WD) DURANGO/(WK2) GRAND CHEROKEE" → 0x500
//   - "(LX) 300/LANCIA THEMA/(LA) CHALLENGER/(LD) CHARGER" → 0x620 (TCM legacy)

export const ECU_TO_CAN_META = ${j(src.meta)};

/** ECU/platform name (decrypted from IL) → list of associated CAN IDs (decimal).
 *  Convert each entry to hex like \`'0x' + n.toString(16).toUpperCase().padStart(3,'0')\`. */
export const ECU_TO_CAN_FROM_EXE = ${j(src.ecu_to_can)};
`;
  writeFileSync(resolve(OUT, "ecuToCanFromExe.generated.js"), out);
  console.log(`Wrote ecuToCanFromExe.generated.js (${out.length.toLocaleString()} bytes, ${pairings.length} pairings)`);
}

// ---- securityIntelFromExe.generated.js ----
{
  const src = JSON.parse(readFileSync(resolve(ASSETS, "security-intel-addendum.json"), "utf-8"));
  const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/security-intel-addendum.json
// Regenerate: node scripts/codegen-ecu-to-can.mjs
//
// Security-relevant intelligence extracted from AlfaOBD.exe IL.
//
// ⚠ INTERPRETATION CAVEATS:
// - The 5-byte hex strings (\`4083618902\`, \`3E07860DAD\`) are NOT confirmed to be
//   live cryptographic keys. They could be sample CodeCards baked in for testing,
//   expected-response patterns, or key-derivation inputs. Do not use as active
//   crypto material without bench-verification against a real ECU.
// - The registry-credential storage path is verified-by-IL-string but the
//   in-registry data is per-installation, not extracted from this binary.

/** Where AlfaOBD persists dealer credentials (CodeCard + PIN) on the user's
 *  Windows machine. Extracted from Method[2526] StartButton_Click1 IL. */
export const ALFAOBD_CREDENTIAL_STORAGE = ${j(src.alfaobd_credential_storage)};

/** The \`SendCodeCardLogin\` method (Method[1436] zz, salt=10) decrypted profile.
 *  Includes the candidate 5-byte hex CodeCard tokens paired with SA frames. */
export const SEND_CODE_CARD_LOGIN_METHOD = ${j(src.send_code_card_login_method)};

/** Door modules using legacy KWP2000, not UDS. */
export const KWP2000_DOOR_MODULES = ${j(src.kwp2000_door_modules)};

/** CAN bus protocol names AlfaOBD recognizes. */
export const ALFAOBD_CAN_PROTOCOL_NAMES = ${j(src.alfaobd_can_protocol_names)};

/** Legacy diagnostic protocols supported. */
export const LEGACY_PROTOCOLS_SUPPORTED = ${j(src.legacy_protocols_supported)};

/** OBD-II adapter chipsets AlfaOBD auto-detects. */
export const OBD_ADAPTER_DETECTION = ${j(src.obd_adapter_detection)};
`;
  writeFileSync(resolve(OUT, "securityIntelFromExe.generated.js"), out);
  console.log(`Wrote securityIntelFromExe.generated.js (${out.length.toLocaleString()} bytes)`);
}
