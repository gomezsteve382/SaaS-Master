#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25");
const OUT = resolve(repoRoot, "artifacts/srt-lab/src/lib");
const j = (v) => JSON.stringify(v);

const abf = JSON.parse(readFileSync(resolve(ASSETS, "abf-dispatcher-full.json"), "utf-8"));
const master = JSON.parse(readFileSync(resolve(ASSETS, "master-cipher-dispatch.json"), "utf-8"));
const deep = JSON.parse(readFileSync(resolve(ASSETS, "deep-ecm-bcm-rfh-dossier.json"), "utf-8"));

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/abf-dispatcher-full.json
//         attached_assets/alfaobd-package-2026-05-25/master-cipher-dispatch.json
//         attached_assets/alfaobd-package-2026-05-25/deep-ecm-bcm-rfh-dossier.json
//
// MASTER CIPHER DISPATCH TABLE — extracted from Method[1307] abf (32,238 bytes IL).
// abf is AlfaOBD's SecurityAccess dispatcher: it takes the ECU's identifier
// string + the SA level, decrypts the comparison strings via h(...) with salt=17,
// then dispatches to a specific cipher wrapper method.
//
// Coverage:
//   - 596 dispatch entries decoded
//   - 223 distinct ECU code strings compared
//   - 177 ECU types with explicit wrapper assignment
//   - 279 unique cipher wrapper methods invoked
//   - 226 of those (104+122) catalogued in W6/W7
//   - 53 are level-routing wrappers (call deeper into W6/W7)
//   - Default fallback (any ECU not matched): 'ht' linear cipher
//     compute: key = ((seed * 0x41AA42BB) + 0x22BA9A31) & 0xFFFFFFFF

export const MASTER_CIPHER_DISPATCH_META = ${j(master.meta)};

/** Full ECU-code → cipher-wrapper(s) → (r,s) or (n,o,p) parameters table.
 *  Each key is the decrypted ECU identifier string AlfaOBD's abf compares.
 *  Each value is an array of wrapper entries (one ECU can dispatch to
 *  multiple wrappers, typically one per SecurityAccess level 1/3/5). */
export const ECU_CODE_TO_CIPHER = ${j(master.ecu_code_to_cipher)};

/** Default fallback cipher (the verified 'ht' linear bit-shuffle).
 *  Used for any ECU not explicitly matched in abf — including most BCM/ECM
 *  variants. Bench-confirmed via PROVENANCE.md. */
export const DEFAULT_FALLBACK_CIPHER = ${j(master.fallback_default_cipher)};

/** ECUs with special non-W6/W7 ciphers. */
export const SPECIAL_ECU_CIPHERS = ${j(master.special_ecus)};

/** BCM-specific ECU codes with explicit cipher dispatch (8 of 123 BCM codes).
 *  The other 115 BCM codes use the default 'ht' linear cipher. */
export const BCM_ECU_CODES_WITH_CIPHER = ${j(master.bcm_codes_with_dispatch)};

/** ECM-specific ECU codes with explicit cipher dispatch (19 of 234 ECM codes).
 *  Engine families 65/66/67/71/73/74 have extensive per-variant W6 entries. */
export const ECM_ECU_CODES_WITH_CIPHER = ${j(master.ecm_codes_with_dispatch)};

/** RFH/RFHUB cipher dispatch: zero explicit entries in abf. RFH uses the
 *  default 'ht' linear cipher for SecurityAccess. */
export const RFH_ECU_CODES_WITH_CIPHER = ${j(master.rfh_codes_with_dispatch)};

/** Family-level W7 BigInteger dispatch (8 families catalogued). */
export const FAMILY_LEVEL_W7_DISPATCH = ${j(deep.cipher_dispatch_full_table || {})};

/** BCM family (idx[12]=3) deep details. */
export const BCM_FAMILY_DEEP = ${j(deep.bcm)};

/** ECM family (idx[12]=11) deep details. */
export const ECM_FAMILY_DEEP = ${j(deep.ecm)};

/** RFHUB family deep details. */
export const RFHUB_FAMILY_DEEP = ${j(deep.rfhub)};
`;

writeFileSync(resolve(OUT, "masterCipherDispatch.generated.js"), out);
console.log(`Wrote masterCipherDispatch.generated.js (${out.length.toLocaleString()} bytes)`);
