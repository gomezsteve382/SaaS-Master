// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/ecu-to-can-from-exe.json
// Re-extract: python3 scripts/extract-ecu-to-can-from-exe.py
//            node scripts/codegen-ecu-to-can.mjs
//
// 70 ECU-name → CAN-ID pairings extracted from AlfaOBD.exe IL
// by finding sequences `ldstr <encrypted>; <salt-load>; call h; ldc.i4 <can_id>`
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

export const ECU_TO_CAN_META = {"methods_scanned":1596,"unique_pairings":70};

/** ECU/platform name (decrypted from IL) → list of associated CAN IDs (decimal).
 *  Convert each entry to hex like `'0x' + n.toString(16).toUpperCase().padStart(3,'0')`. */
export const ECU_TO_CAN_FROM_EXE = {"10":[329,1284],"13":[1536,1568],"16":[1300],"20":[334,1300],"21":[1568],"25":[1280,1284,1696],"30":[1536],"31":[1284,1568,1696],"32":[1284],"33":[1284,1536],"34":[329],"35":[334,1536,1568],"37":[1536],"39":[1280],"43":[329],"60":[1280],"64":[1536],"67":[1284,1568],"68":[1696],"71":[1300],"79":[329,334],"679":[1300],"791":[334],"821":[1887],"2046":[329],"6613":[329],"6794":[334],"7519":[1568],"7948":[1284],"8187":[1536],"8244":[329,334],"8400":[1280],"9643":[1280],"9662":[1284],"10240":[1300],"14039":[1536,1568],"15336":[329,334],"19499":[1696],"TIPM_CGW":[329,334],"MY2008-14 Non-PowerNet":[329],"(KA) NITRO":[334],"MY2007-12 Non-PowerNet":[334],"AHBM":[1280],"MY2015+ non-PowerNet":[1280],"AFLS_PN":[1284],"RAM 1500/2500/3500/4500/5500":[1284],"MY2019+ PowerNet":[1284],"MARELLI_DASH":[1300],"Marelli 2: Fiat CROMA":[1300],"Marelli 2":[1300],"TPM":[1536],"(RM) ROUTAN":[1536],"MY2011-14 non-PowerNet":[1536],"DTCM_PN":[1568],"MY2011+ PowerNet":[1568],"Memory Seat module":[329],"MSM_PN":[329],"78A":[329],"LBSS_PN":[334],"Rear Right Door Module":[329],"On-Board Charging Module":[1280],"Electronic Shift Module":[1284],"UConnect Module":[1300],"Radio Frequency HUB":[1536,1568],"108,252":[329],"109,12":[334],"0235":[334],"AEB - P":[1868],"Radio Navigator (EP)":[329],"Radio/Navigator CUSW":[334]};
