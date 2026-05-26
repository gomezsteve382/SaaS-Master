// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: AlfaOBD.exe IL dispatch sweep (Method[5] .cctor)
// Re-extract: python3 scripts/extract-tier1-dispatch-from-exe.py
//
// Per-Tier-1 routine dispatch fields extracted from AlfaOBD.exe IL.
// For each (routine_id, field_index) pair, the IL contains a
// `ldc.i4 rid; ldc.i4 idx; ldstr <encrypted>; ldloc <salt>; call h`
// sequence that decrypts to a dispatch field value.
//
// FIELD SEMANTICS (preliminary, by observation across 5 Tier-1 routines):
//   index[0]: ECU code OR sub-id (string or numeric)
//   index[1]: ECU friendly name OR ECU type description
//   index[2]: Some numeric code (possibly UDS RID-related)
//   index[3]: Sub-parameter — DIFFERS between 1750/1751 (0 vs 1) — likely a routine sub-id
//   index[4]: Numeric param (possibly security level)
//   index[5]: Numeric param (possibly session/RID byte)
//   index[6-12]: Additional numeric params
//   index[13-14]: More numeric (possibly RID hi/lo)
//   index[15]: Vehicle applicability (year/platform notes)
//   index[16]: Numeric param (often 0 or 1)
//
// MISSING: routines 2504, 2505, 2507, 2508 use a computed-value
// dispatch path (MemberRef calls instead of ldstr literals). Those need
// IL-level analysis of the producing methods, not string extraction.

export const TIER1_DISPATCH_FROM_EXE = {
  "2504": {},
  "1520": {
    "0": [
      "TBM2",
      "14039"
    ],
    "1": [
      "TBM2",
      "Radio Frequency HUB"
    ],
    "2": [
      "55732",
      "64"
    ],
    "3": [
      "ALFA GIULIA/STELVIO,ProMaster VF,500E,Fiat 6V,Jeep RENEGADE",
      "5"
    ],
    "4": [
      ",16,17,",
      "35"
    ],
    "5": [
      ",71,72,",
      "13"
    ],
    "8": [
      ",88,"
    ],
    "10": [
      ",1,"
    ],
    "13": [
      "16"
    ],
    "14": [
      "29"
    ],
    "15": [
      "MY2020+"
    ],
    "16": [
      "0"
    ]
  },
  "1126": {
    "0": [
      "MARELLI6F3_CAN",
      "8935"
    ],
    "1": [
      "MARELLI6F3_CAN",
      "Chrysler Pentastar/Hemi engine"
    ],
    "2": [
      "825",
      "108"
    ],
    "3": [
      "Alfa MITO,Fiat DOBLO/GRANDE PUNTO/PUNTO EVO/FIORINO/QUBO",
      "89"
    ],
    "4": [
      ",13,",
      "11"
    ],
    "5": [
      ",0,9,10,16,18,19,37,38,41,",
      "0"
    ],
    "7": [
      ",0,18,37,"
    ],
    "13": [
      "11"
    ],
    "14": [
      "0"
    ],
    "15": [
      "EOBD EP engine 1.3 JTD 2"
    ],
    "16": [
      "0"
    ]
  },
  "1750": {
    "0": [
      "53765"
    ],
    "1": [
      "Comfort Steering Wheel Module Continental"
    ],
    "2": [
      "67"
    ],
    "3": [
      "0"
    ],
    "4": [
      "36"
    ],
    "5": [
      "12"
    ]
  },
  "1751": {
    "0": [
      "53765"
    ],
    "1": [
      "Comfort Steering Wheel Module Continental"
    ],
    "2": [
      "67"
    ],
    "3": [
      "1"
    ],
    "4": [
      "36"
    ],
    "5": [
      "12"
    ]
  },
  "2505": {},
  "2507": {},
  "1367": {
    "0": [
      "CCN",
      "11747"
    ],
    "1": [
      "CCN",
      "Audio Amplifier"
    ],
    "2": [
      "8519",
      "64"
    ],
    "3": [
      "(MK)COMPASS/PATRIOT/LIBERTY",
      "0"
    ],
    "10": [
      ",4,"
    ],
    "13": [
      "7"
    ],
    "14": [
      "20"
    ],
    "15": [
      "MY2011+ Non-PowerNet"
    ],
    "16": [
      "0"
    ],
    "4": [
      "16"
    ],
    "5": [
      "4"
    ]
  },
  "2508": {}
};

export const TIER1_DISPATCH_FROM_EXE_META = {
  source: "AlfaOBD_PC.exe v2.5.7.0 Method[5] .cctor IL pattern extraction",
  pattern: "ldc.i4 <rid>; ldc.i4 <idx>; ldstr <encrypted>; ldloc <salt>; call h(string,int)",
  routines_with_dispatch: ["1126", "1367", "1520", "1750", "1751"],
  routines_missing: ["2504", "2505", "2507", "2508"],
  routines_missing_reason: "Use computed dispatch via MemberRef calls, not ldstr literals. Need IL trace through the producer methods.",
  field_count_per_routine: {"1520": 12, "1126": 11, "1750": 6, "1751": 6, "1367": 11},
  notable_finding: "Routines 1750 and 1751 have IDENTICAL dispatch except index[3] (0 vs 1) — index[3] is the sub-parameter that distinguishes BCM->ECM/PCM (1750) from BCM->ESL (1751).",
};
