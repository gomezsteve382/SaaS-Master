// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: client/src/lib/srt/alfaobdData.generated.js (3789 DIAG_NAMES rows)
//       + attached_assets/alfaobd-package-2026-05-25/extraction-report.md
// Re-extract: node scripts/extract-tier1-routines.mjs
//
// Tier-1 routine catalog (the 8 routines explicitly requested by SRT Lab).
// Per-routine fields:
//   - short_name + english_description: VERIFIED from DIAG_NAMES
//   - target_ecu: INFERRED from description text
//   - uds_service/sub_function: ISO 14229 — RoutineControl 0x31/0x01
//   - session_required: FCA convention for destructive routines
//   - routine_identifier / security_level / option_record_layout: UNKNOWN
//
// IMPORTANT: routine_identifier (the 2-byte UDS RID), security_level, and
// option_record_layout are NOT recoverable from anything currently in the
// repo. They live in a table in the decrypted AlfaOBD .db whose row shape
// has not been matched yet. Do NOT execute any routine_identifier=null
// entry on a live vehicle — it will either no-op or hit the wrong RID.

export const TIER1_ROUTINES = {
  "2504": {
    "label_id": "2504",
    "short_name": "RF-HUB Reset/Replace",
    "english_description": "RF-HUB Reset/Replace",
    "target_ecu": "RFHUB",
    "destructive": true,
    "code_card_required": false,
    "uds_service": 49,
    "uds_service_name": "RoutineControl",
    "sub_function": 1,
    "sub_function_name": "startRoutine",
    "session_required": 3,
    "session_name": "extendedDiagnosticSession",
    "routine_identifier": null,
    "routine_identifier_status": "unknown — not present in DIAG_NAMES, AlfaOBD.exe IL, or any extracted JSON. Dispatch table from the .db not yet identified by shape.",
    "security_level": null,
    "security_level_status": "unknown",
    "option_record_layout": null,
    "option_record_status": "unknown",
    "provenance": {
      "short_name_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "english_description_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "target_ecu_source": "inferred from short_name + english_description text",
      "uds_service_source": "ISO 14229 — all routines in this Tier-1 set are RoutineControl-shaped per their descriptions",
      "session_required_source": "FCA convention for destructive routines (verify per-routine before use)"
    }
  },
  "1520": {
    "label_id": "1520",
    "short_name": "Create BCM backup of RF-HUB secret",
    "english_description": "RAM only. Use this function when the BCM has been replaced. It will create the BCM backup of the secret key value stored in the RF-HUB.",
    "target_ecu": "BCM",
    "destructive": true,
    "code_card_required": false,
    "uds_service": 49,
    "uds_service_name": "RoutineControl",
    "sub_function": 1,
    "sub_function_name": "startRoutine",
    "session_required": 3,
    "session_name": "extendedDiagnosticSession",
    "routine_identifier": null,
    "routine_identifier_status": "unknown — not present in DIAG_NAMES, AlfaOBD.exe IL, or any extracted JSON. Dispatch table from the .db not yet identified by shape.",
    "security_level": null,
    "security_level_status": "unknown",
    "option_record_layout": null,
    "option_record_status": "unknown",
    "provenance": {
      "short_name_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "english_description_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "target_ecu_source": "inferred from short_name + english_description text",
      "uds_service_source": "ISO 14229 — all routines in this Tier-1 set are RoutineControl-shaped per their descriptions",
      "session_required_source": "FCA convention for destructive routines (verify per-routine before use)"
    }
  },
  "1126": {
    "label_id": "1126",
    "short_name": "BCM → ECM/ESL secret transfer (Code Card)",
    "english_description": "This routine is used to allow BCM to transfer secret keys to ECM and ESL operating on the protection of the BCM. Login with Code Card before running this procedure.",
    "target_ecu": "BCM",
    "destructive": true,
    "code_card_required": true,
    "uds_service": 49,
    "uds_service_name": "RoutineControl",
    "sub_function": 1,
    "sub_function_name": "startRoutine",
    "session_required": 3,
    "session_name": "extendedDiagnosticSession",
    "routine_identifier": null,
    "routine_identifier_status": "unknown — not present in DIAG_NAMES, AlfaOBD.exe IL, or any extracted JSON. Dispatch table from the .db not yet identified by shape.",
    "security_level": null,
    "security_level_status": "unknown",
    "option_record_layout": null,
    "option_record_status": "unknown",
    "provenance": {
      "short_name_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "english_description_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "target_ecu_source": "inferred from short_name + english_description text",
      "uds_service_source": "ISO 14229 — all routines in this Tier-1 set are RoutineControl-shaped per their descriptions",
      "session_required_source": "FCA convention for destructive routines (verify per-routine before use)"
    }
  },
  "1750": {
    "label_id": "1750",
    "short_name": "BCM → ECM/PCM secret transfer (replace ECM/PCM)",
    "english_description": "This routine is used to allow BCM to transfer secret keys to ECM/PCM operating on the protection of the BCM. Use it when replacing the ECM/PCM.",
    "target_ecu": "BCM",
    "destructive": true,
    "code_card_required": "likely",
    "uds_service": 49,
    "uds_service_name": "RoutineControl",
    "sub_function": 1,
    "sub_function_name": "startRoutine",
    "session_required": 3,
    "session_name": "extendedDiagnosticSession",
    "routine_identifier": null,
    "routine_identifier_status": "unknown — not present in DIAG_NAMES, AlfaOBD.exe IL, or any extracted JSON. Dispatch table from the .db not yet identified by shape.",
    "security_level": null,
    "security_level_status": "unknown",
    "option_record_layout": null,
    "option_record_status": "unknown",
    "provenance": {
      "short_name_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "english_description_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "target_ecu_source": "inferred from short_name + english_description text",
      "uds_service_source": "ISO 14229 — all routines in this Tier-1 set are RoutineControl-shaped per their descriptions",
      "session_required_source": "FCA convention for destructive routines (verify per-routine before use)"
    }
  },
  "1751": {
    "label_id": "1751",
    "short_name": "BCM → ESL secret transfer",
    "english_description": "This routine is used to allow BCM to transfer secret keys to ESL operating on the protection of the BCM. Use it when replacing the ESL.",
    "target_ecu": "BCM",
    "destructive": true,
    "code_card_required": "likely",
    "uds_service": 49,
    "uds_service_name": "RoutineControl",
    "sub_function": 1,
    "sub_function_name": "startRoutine",
    "session_required": 3,
    "session_name": "extendedDiagnosticSession",
    "routine_identifier": null,
    "routine_identifier_status": "unknown — not present in DIAG_NAMES, AlfaOBD.exe IL, or any extracted JSON. Dispatch table from the .db not yet identified by shape.",
    "security_level": null,
    "security_level_status": "unknown",
    "option_record_layout": null,
    "option_record_status": "unknown",
    "provenance": {
      "short_name_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "english_description_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "target_ecu_source": "inferred from short_name + english_description text",
      "uds_service_source": "ISO 14229 — all routines in this Tier-1 set are RoutineControl-shaped per their descriptions",
      "session_required_source": "FCA convention for destructive routines (verify per-routine before use)"
    }
  },
  "2505": {
    "label_id": "2505",
    "short_name": "Program Ignition FOBIKs Baseline System",
    "english_description": "Program Ignition FOBIKs Baseline System",
    "target_ecu": "RFHUB",
    "destructive": false,
    "code_card_required": false,
    "uds_service": 49,
    "uds_service_name": "RoutineControl",
    "sub_function": 1,
    "sub_function_name": "startRoutine",
    "session_required": 3,
    "session_name": "extendedDiagnosticSession",
    "routine_identifier": null,
    "routine_identifier_status": "unknown — not present in DIAG_NAMES, AlfaOBD.exe IL, or any extracted JSON. Dispatch table from the .db not yet identified by shape.",
    "security_level": null,
    "security_level_status": "unknown",
    "option_record_layout": null,
    "option_record_status": "unknown",
    "provenance": {
      "short_name_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "english_description_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "target_ecu_source": "inferred from short_name + english_description text",
      "uds_service_source": "ISO 14229 — all routines in this Tier-1 set are RoutineControl-shaped per their descriptions",
      "session_required_source": "FCA convention for destructive routines (verify per-routine before use)"
    }
  },
  "2507": {
    "label_id": "2507",
    "short_name": "Program Ignition FOBIKs Highline System",
    "english_description": "Program Ignition FOBIKs Highline System",
    "target_ecu": "RFHUB",
    "destructive": false,
    "code_card_required": false,
    "uds_service": 49,
    "uds_service_name": "RoutineControl",
    "sub_function": 1,
    "sub_function_name": "startRoutine",
    "session_required": 3,
    "session_name": "extendedDiagnosticSession",
    "routine_identifier": null,
    "routine_identifier_status": "unknown — not present in DIAG_NAMES, AlfaOBD.exe IL, or any extracted JSON. Dispatch table from the .db not yet identified by shape.",
    "security_level": null,
    "security_level_status": "unknown",
    "option_record_layout": null,
    "option_record_status": "unknown",
    "provenance": {
      "short_name_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "english_description_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "target_ecu_source": "inferred from short_name + english_description text",
      "uds_service_source": "ISO 14229 — all routines in this Tier-1 set are RoutineControl-shaped per their descriptions",
      "session_required_source": "FCA convention for destructive routines (verify per-routine before use)"
    }
  },
  "1367": {
    "label_id": "1367",
    "short_name": "FOBIK programming after RF-HUB replace (RAM highline)",
    "english_description": "RAM trucks only with high-line system. Use this function to program FOBIK(s) when the RF-HUB has been replaced or additional FOBIK(s) need to be added. The FOBIK(s) being pRograMmEd MUST bE",
    "target_ecu": "RFHUB",
    "destructive": false,
    "code_card_required": false,
    "uds_service": 49,
    "uds_service_name": "RoutineControl",
    "sub_function": 1,
    "sub_function_name": "startRoutine",
    "session_required": 3,
    "session_name": "extendedDiagnosticSession",
    "routine_identifier": null,
    "routine_identifier_status": "unknown — not present in DIAG_NAMES, AlfaOBD.exe IL, or any extracted JSON. Dispatch table from the .db not yet identified by shape.",
    "security_level": null,
    "security_level_status": "unknown",
    "option_record_layout": null,
    "option_record_status": "unknown",
    "provenance": {
      "short_name_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "english_description_source": "DIAG_NAMES (alfaobdData.generated.js)",
      "target_ecu_source": "inferred from short_name + english_description text",
      "uds_service_source": "ISO 14229 — all routines in this Tier-1 set are RoutineControl-shaped per their descriptions",
      "session_required_source": "FCA convention for destructive routines (verify per-routine before use)"
    }
  }
};

export const TIER1_RELATED_INTEL = {
  "immobilizer_default_pin": {
    "value": "59183",
    "source": "DIAG_NAMES[\"1674\"]: \"This routine will unlock the immobilizer. Hint: if you don't know the PIN of your car try the PIN: 59183\"",
    "confidence": "documented_in_alfaobd_help_text",
    "caveat": "This is a published \"if all else fails\" guess, not a per-vehicle PIN. Real PIN is VIN-derived."
  },
  "skim_secret_size": {
    "value_bytes": 6,
    "format": "hex",
    "example": "AFBFCFDFEFFF",
    "source": "DIAG_NAMES[\"1681\"]: \"This function writes the SKIM secret bytes to the engine control module. Enter the 6 bytes in HEX format...\"",
    "confidence": "documented_in_alfaobd_help_text"
  },
  "related_routines": {
    "unlock_immobilizer": "945",
    "unlock_immobilizer_with_pin": "1674",
    "enable_skim_in_ecm": "1680",
    "write_skim_secret_to_ecm": "1681",
    "erase_all_fobiks": "1394",
    "enable_keys_fobiks": "1668",
    "login_code_card": "263",
    "clear_vin_handshake_failure": "2364",
    "verify_rfh_door_handles": "1305",
    "verify_rfh_antenna_coil": "1306",
    "test_rfh_antennas": "1307"
  }
};

export const TIER1_ROUTINES_META = {
  "source": "Cross-referenced from alfaobdData.generated.js (3789 DIAG_NAMES entries) + alfaobd-package-2026-05-25/extraction-report.md (324 multilingual blobs)",
  "tier_1_count": 8,
  "verified_fields_per_routine": [
    "label_id",
    "short_name",
    "english_description"
  ],
  "unverified_fields_per_routine": [
    "routine_identifier",
    "security_level",
    "option_record_layout"
  ],
  "note": "The dispatch bytes (RID, security level, option record) are NOT in DIAG_NAMES or any extracted JSON. They live in a table in the decrypted .db whose shape has not been matched yet. The 10-entry W6/W7 dispatch in alfaobdAlgorithms.generated.js is for SecurityAccess (0x27), not RoutineControl (0x31)."
};


/** Audit findings 2026-05-26 — corrections from the other agent's
 *  recovered.db shape analysis: */
export const TIER1_AUDIT_FINDINGS_2026_05_26 = {
  collision_2508: {
    rid: "2508",
    wrong_description_was: "governor output duty cycle for LSU heater 0",
    correct_for_our_domain: "Transfer secret key",
    family_pages: { "2504": 1473, "2505": 1475, "2507": 1477, "2508": 1477 },
    note: "RF-HUB key family lives on pages 1473/1475/1477. label_id is NOT unique across rootpgno groups. Re-audit pending for the other 3789 routines.",
  },
  ui_hints_demoted: ["default_immobilizer_pin: '59183'", "skim_secret_size: 6 bytes"],
  ui_hints_demoted_note: "Both came from DIAG_NAMES tooltip strings, NOT from any extracted cryptographic table. Not per-vehicle values. Don't ship as 'intel'.",
  cipher_vs_uds_dispatch: "The 10-entry W6/W7 dispatch is cipher-algorithm selection for SecurityAccess (0x27), NOT UDS RoutineControl (0x31) dispatch.",
};
