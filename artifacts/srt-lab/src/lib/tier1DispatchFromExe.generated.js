// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: AlfaOBD.exe IL dispatch sweep (Method[5] .cctor)
// Re-extract: python3 scripts/extract-tier1-dispatch-from-exe.py
//
// Per-Tier-1 routine dispatch fields extracted from AlfaOBD.exe IL.
// For each (routine_id, field_index) pair, the IL contains a
// `dup; ldc.i4 rid; ldc.i4 idx; ldstr <encrypted>; ldloc <salt>;
//  call b::h(string,int32); call string[0...,0...]::Set(int32,int32,string)`
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
// MISSING ROUTINES — 2504, 2505, 2507, 2508 — IL TRACE FINDING (Task #833):
// An exhaustive IL grep across the full decompiled assembly (ilspycmd -il on
// AlfaOBD_managed.exe, 6.93M lines) for every `ldc.i4 2504|2505|2507|2508`
// returned 23 references. Every one of them is a CONSUMER of the dispatch
// arrays — either `string[0...,0...]::Get(int32, int32)` on the 2D field
// `af::a` (15 occurrences inside a switch handler), or `ldelem.ref` on the
// 1D label field `af::b` followed by `Control::set_Text(string)` (4 UI
// occurrences). NONE of the 23 references appears as the rid argument of
// the producer pattern documented above (`dup; ldc.i4 <rid>; ldc.i4 <idx>;
// ldstr ...; ldloc <salt>; call b::h; call Set`). For comparison, the 5
// routines that DO have dispatch (1126/1367/1520/1750/1751) each show that
// producer pattern at IL offsets 0x6c386 / 0x... / 0x10ca9b / 0x16baa0 /
// 0x16bb3c respectively, alongside their consumer reads.
//
// Conclusion (IL side): 2504/2505/2507/2508 have no Form-builder dispatch
// payload in AlfaOBD.exe at all. The original "computed-value MemberRef
// dispatch" hypothesis is not supported by the IL — there is no producer
// in any form (literal, computed, or MemberRef call) for these four rids.
//
// DB EXTRACTION FOLLOWUP (Task #837 — this revision):
// The encrypted AlfaOBD database was unpacked (1024-byte repeating XOR over
// 66,625 × 1024-byte SQLite pages — see `alfaobd-db-schema-notes.txt`).
// The decrypted image (`attached_assets/alfao_bd.decrypted_*.db`) has a
// malformed B-tree root, so the schema was reconstructed via `sqlite3
// .recover` into `attached_assets/.cache/alfao_bd.recovered.db`. The
// recovered schema lists 19 tables:
//   BODY_PN_CONFIG, CAN_DELPHI_500_CONFIG, CAN_DELPHI_RAM_CONFIG,
//   CAN_MARELLI_CONFIG, Devices_params_units, Diag_names, FCM_CGW_CONFIG,
//   FGA_ABS_DATA, FGA_DIESEL_DYNAMIC, FGA_DIESEL_STATIC, FGA_ENGINE_DATA,
//   FGA_IPC_DATA, FGA_IPC_SNAPSHOT, FGA_IPC_SNAPSHOT_DATA, Faults, STATES,
//   TIPM_CGW_CONFIG, Units, newTable.
//
// NONE of those 19 tables has a "routine_id → (ECU code, security level,
// numeric param tuple)" shape. The only DB row carrying any of the four
// target rids is `Diag_names` (LABEL text in 10+ languages). The dispatch
// payload (the per-rid `af::a[rid, idx]` tuple this file represents) is
// therefore NOT held in the AlfaOBD database either. The 17.6% routine→
// frame static coverage ceiling reported in prior sweeps stands; closing
// the gap for these four rids requires live bench capture, not further
// static extraction.
//
// What the DB DID yield: the English (and multilingual) human-readable
// labels for all four rids, recovered verbatim from `Diag_names` and
// surfaced below in `TIER1_LABELS_FROM_DB`. These are LABEL strings only,
// not dispatch tuples — they intentionally do NOT populate any `af::a`
// field index, because doing so would conflate label text with the
// ECU-code / security-level slots that index[0..16] carry for the five
// known-good rids.
//
// Per the task rule "do NOT invent new routines/frames", the four dispatch
// entries below remain empty `{}`.

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

// Labels recovered from the decrypted AlfaOBD SQLite database (`Diag_names`
// table, reconstructed via `sqlite3 .recover` from the malformed-but-
// decrypted image). For each rid the row appears once under its own
// rootpgno (1473 for 2504, 1475 for 2505, 1477 for 2507+2508 — they share
// a B-tree page) with nfield=14 and `c0` carrying the Diag_Name_ID. Only
// the English column is surfaced here; the other 9 language columns are
// present in the recovered row but not needed by SRT Lab's coverage UI.
export const TIER1_LABELS_FROM_DB = {
  "2504": "RF-HUB Reset/Replace",
  "2505": "Program Ignition FOBIKs Baseline System",
  "2507": "Program Ignition FOBIKs Highline System",
  "2508": "Transfer secret key",
};

export const TIER1_DISPATCH_FROM_EXE_META = {
  source: "AlfaOBD_PC.exe v2.5.7.0 Method[5] .cctor IL pattern extraction",
  pattern: "dup; ldc.i4 <rid>; ldc.i4 <idx>; ldstr <encrypted>; ldloc <salt>; call b::h(string,int32); call Set(int32,int32,string)",
  routines_with_dispatch: ["1126", "1367", "1520", "1750", "1751"],
  routines_missing: ["2504", "2505", "2507", "2508"],
  routines_missing_reason:
    "Exhaustive IL trace (Task #833) found ZERO producer-pattern occurrences for these four rids in the full decompiled assembly. Task #837 then unpacked and schema-recovered the encrypted AlfaOBD SQLite database (1024-byte XOR over 66,625 pages) and confirmed the dispatch payload is NOT held there either: the 19-table schema (BODY_PN_CONFIG, CAN_*_CONFIG, Diag_names, Devices_params_units, FCM_CGW_CONFIG, TIPM_CGW_CONFIG, FGA_*, Faults, STATES, Units, newTable) contains no routine_id→(ECU code, security level, numeric param tuple) table. The only DB row carrying these four rids is `Diag_names`, which yields LABEL text only (now surfaced in TIER1_LABELS_FROM_DB). The dispatch tuples remain unrecoverable by static means and need live bench capture.",
  routines_missing_db_evidence: {
    db_decrypted_source: "attached_assets/alfao_bd.decrypted_<ts>.db (68,224,000 B, 1024-byte repeating XOR cracked via Kasiski autocorrelation + SQLite header constraint — see attached_assets/alfaobd-package-2026-05-25/alfaobd-db-schema-notes.txt)",
    db_recovered_source: "attached_assets/.cache/alfao_bd.recovered.db (35,288,064 B, produced by `sqlite3 attached_assets/alfao_bd.decrypted_<ts>.db .recover` because the decrypted image has a corrupt B-tree root)",
    schema_tables_total: 19,
    schema_tables: [
      "BODY_PN_CONFIG", "CAN_DELPHI_500_CONFIG", "CAN_DELPHI_RAM_CONFIG",
      "CAN_MARELLI_CONFIG", "Devices_params_units", "Diag_names",
      "FCM_CGW_CONFIG", "FGA_ABS_DATA", "FGA_DIESEL_DYNAMIC",
      "FGA_DIESEL_STATIC", "FGA_ENGINE_DATA", "FGA_IPC_DATA",
      "FGA_IPC_SNAPSHOT", "FGA_IPC_SNAPSHOT_DATA", "Faults", "STATES",
      "TIPM_CGW_CONFIG", "Units", "newTable",
    ],
    routine_dispatch_table_present: false,
    rid_hits_per_table: {
      "Diag_names (recovered via lost_and_found rootpgno=1473/1475/1477, nfield=14)":
        "1 row per rid (2504/2505/2507/2508), label column only — surfaced in TIER1_LABELS_FROM_DB",
    },
    cross_check: "attached_assets/alfaobd-package-2026-05-25/cctor-dispatch-pairs.json `tier1_lookups` block lists all four rids with empty arrays, matching the IL trace.",
  },
  routines_missing_il_evidence: {
    method: "ilspycmd -il AlfaOBD_managed.exe (6,932,292 lines)",
    ldc_i4_2504_total_refs: 3,
    ldc_i4_2505_total_refs: 3,
    ldc_i4_2507_total_refs: 13,
    ldc_i4_2508_total_refs: 4,
    producer_pattern_hits: 0,
    consumer_breakdown: {
      "string[0...,0...]::Get(int32,int32) on af::a": 15,
      "ldelem.ref on af::b -> Control::set_Text": 4,
      "other reads (consumer-side concat sites)": 4
    },
    representative_consumer_il_offsets: {
      "2504_get": "IL_0ba7 (af::a Get rid=2504, idx=0)",
      "2505_get": "IL_0c0b (af::a Get rid=2505, idx=0)",
      "2507_get": "IL_097b (af::a Get rid=2507, idx=0)",
      "2508_get": "IL_0b43 (af::a Get rid=2508, idx=1)",
      "2504_label_read": "IL_94f8 (af::b[2504] ldelem.ref -> TextBox.Text)",
      "2505_label_read": "IL_9510 (af::b[2505] ldelem.ref -> TextBox.Text)",
      "2507_label_read": "IL_9540 (af::b[2507] ldelem.ref -> TextBox.Text)",
      "2508_label_read": "IL_956c (af::b[2508] ldelem.ref -> TextBox.Text)"
    },
    producer_pattern_reference_for_known_good: {
      "1126": "IL_6c386 (dup; ldc.i4 1126; ldc.i4 <idx>; ldstr ...; ldloc 7; call b::h; call Set) — 17 consecutive Set calls",
      "1751": "IL_efb26 (same pattern, salt ldloc varies per method)"
    }
  },
  field_count_per_routine: {"1520": 12, "1126": 11, "1750": 6, "1751": 6, "1367": 11},
  notable_finding: "Routines 1750 and 1751 have IDENTICAL dispatch except index[3] (0 vs 1) — index[3] is the sub-parameter that distinguishes BCM->ECM/PCM (1750) from BCM->ESL (1751).",
};
