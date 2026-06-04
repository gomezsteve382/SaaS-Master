// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/alfaobd-db-schema-notes.txt
// Re-extract: scripts/extract-alfaobd-db-schema.mjs
//
// AlfaOBD SQLite catalog database schema. The DB is 68,224,000 bytes
// (66,625 × 1024-byte SQLite pages), encrypted with the 1024-byte XOR
// key in attached_assets/alfaobd-db-xor-key.bin. SQLite header version
// is 3, schema format 4, text encoding UTF-8, created with SQLite 3.19.3.

/** All 19 tables in the AlfaOBD SQLite catalog database. */
export const ALFAOBD_DB_TABLES = {
  Diag_names: {
    purpose:
      "Multilingual descriptive labels for every diagnostic procedure (3789+ entries). The Tier-1 routine label IDs (2504, 1520, 1126, ...) live here.",
    columns: [
      { name: "Diag_Name_ID", type: "INTEGER NOT NULL", role: "primary_key" },
      { name: "Diag_Name_EN", type: "TEXT(40) NOT NULL", role: "english" },
      { name: "Diag_Name_DE", type: "TEXT(50) NOT NULL", role: "german" },
      { name: "Diag_Name_CZ", type: "TEXT(50) NOT NULL", role: "czech" },
      { name: "Diag_Name_ES", type: "TEXT(60) NOT NULL", role: "spanish" },
      { name: "Diag_Name_IT", type: "TEXT(50) NOT NULL", role: "italian" },
      { name: "Diag_Name_FR", type: "TEXT(60) NOT NULL", role: "french" },
      { name: "Diag_Name_HU", type: "TEXT(70) NOT NULL", role: "hungarian" },
      { name: "Diag_Name_RU", type: "TEXT(50) NOT NULL", role: "russian" },
    ],
    rowCountEstimate: 3789,
    extractionStatus: "text_recovered (numeric IDs corrupted by 5-10% XOR residual)",
  },
  Faults: {
    purpose: "DTC (Diagnostic Trouble Code) catalog with multilingual descriptions.",
    columns: [
      { name: "hexcode", type: "TEXT(10) NOT NULL", role: "dtc_code" },
      { name: "device_id", type: "TEXT NOT NULL", role: "owning_ecu" },
      { name: "code_en", type: "TEXT NOT NULL", role: "english" },
      { name: "code_de", type: "TEXT NOT NULL" },
      { name: "code_cz", type: "TEXT NOT NULL" },
      { name: "code_es", type: "TEXT NOT NULL" },
      { name: "code_fr", type: "TEXT NOT NULL" },
      { name: "code_hu", type: "TEXT NOT NULL" },
      { name: "code_it", type: "TEXT NOT NULL" },
      { name: "code_po", type: "TEXT NOT NULL" },
      { name: "code_ru", type: "TEXT NOT NULL" },
    ],
    rowCountEstimate: 20043,
    extractionStatus: "text_recovered",
  },
  STATES: {
    purpose: "Multilingual state names (used by data display modules).",
    columns: [{ name: "ID", type: "INTEGER NOT NULL" }, { name: "CZ1", type: "TEXT(2)" }],
    extractionStatus: "partial",
  },
  Units: {
    purpose: "Multilingual unit names (km/h, °C, Volt, etc.).",
    columns: [
      { name: "Unit_ID", type: "INTEGER NOT NULL" },
      { name: "Unit_EN", type: "TEXT(10) NOT NULL" },
      { name: "Unit_ES", type: "TEXT(10) NOT NULL" },
      { name: "Unit_DE", type: "TEXT(10) NOT NULL" },
      { name: "Unit_CZ", type: "TEXT(10) NOT NULL" },
      { name: "Unit_FR", type: "TEXT(20) NOT NULL" },
      { name: "Unit_IT", type: "TEXT(20) NOT NULL" },
      { name: "Unit_PO", type: "TEXT(10) NOT NULL" },
      { name: "Unit_PL", type: "TEXT(20) NOT NULL" },
      { name: "Unit_RU", type: "TEXT(10) NOT NULL" },
      { name: "Unit_HU", type: "TEXT(10) NOT NULL" },
      { name: "Unit_CN", type: "TEXT(10) NOT NULL" },
      { name: "Unit_TR", type: "TEXT(10) NOT NULL" },
      { name: "Unit_GR", type: "TEXT(10) NOT NULL" },
    ],
    extractionStatus: "schema_recovered",
  },
  Devices_params_units: {
    purpose: "Maps each (Device, Param) pair to a Unit (joins Diag_names, Devices, Units).",
    columns: [
      { name: "ID", type: "INTEGER NOT NULL" },
      { name: "Device_ID", type: "INTEGER NOT NULL", role: "foreign_key" },
      { name: "Param_ID", type: "INTEGER NOT NULL", role: "foreign_key" },
      { name: "Unit_ID", type: "INTEGER", role: "foreign_key" },
    ],
    extractionStatus: "schema_recovered",
  },
  newTable: {
    purpose:
      "Device ASO-code mapping. ASO = AlfaObd-internal device identifier scheme. Links 'aso_code' string to numeric device_id.",
    columns: [
      { name: "aso_code", type: "TEXT(20) NOT NULL" },
      { name: "device_id", type: "INTEGER NOT NULL" },
      { name: "device_type", type: "TEXT(90) NOT NULL" },
    ],
    extractionStatus: "schema_recovered",
  },
  BODY_PN_CONFIG: { purpose: "Body PN (Part Number) configuration bytes per setting." },
  CAN_DELPHI_500_CONFIG: { purpose: "CAN frame layouts for Delphi 500-series ECUs." },
  CAN_DELPHI_RAM_CONFIG: { purpose: "CAN frame layouts for Delphi RAM ECUs." },
  CAN_MARELLI_CONFIG: { purpose: "CAN frame layouts for Marelli ECUs." },
  FCM_CGW_CONFIG: { purpose: "FCM (Front Control Module) / CGW (Central Gateway) configuration." },
  TIPM_CGW_CONFIG: {
    purpose: "TIPM (Totally Integrated Power Module) / CGW configuration.",
  },
  FGA_ABS_DATA: { purpose: "Fiat-Group ABS data display parameters." },
  FGA_DIESEL_DYNAMIC: { purpose: "Fiat-Group diesel engine dynamic data display parameters." },
  FGA_DIESEL_STATIC: { purpose: "Fiat-Group diesel engine static (config) parameters." },
  FGA_ENGINE_DATA: { purpose: "Fiat-Group generic engine data display." },
  FGA_IPC_DATA: { purpose: "Fiat-Group IPC (Instrument Panel Cluster) data display." },
  FGA_IPC_SNAPSHOT: { purpose: "IPC snapshot DTC frames (freeze-frame data)." },
  FGA_IPC_SNAPSHOT_DATA: { purpose: "IPC snapshot data records keyed by snapshot ID." },
};

/** Missing table — NOTE: prior claim about "fgaipcroutines" was wrong.
 *  The 19 tables documented in analysis_notes.txt are listed above.
 *  None of them is named fgaipcroutines. The user-verified read of the
 *  decrypted DB shows the routine-description table is Diag_names
 *  (nfield=14, c0=int 1-9999, c1..c8=EN/DE/CZ/ES/IT/FR/HU/RU).
 *  What's actually NEEDED is the dispatch lookup that joins a
 *  (eEcutype, security_level) pair to a W6/W7 algorithm name — and
 *  that lookup is only partially extracted (10 entries in
 *  alfaobdAlgorithms.generated.js AOBD_DISPATCH out of the 41+
 *  branches listed in alfaobdDispatchAuxiliary.js README_ECU_BRANCHES). */
export const ALFAOBD_DB_DISPATCH_GAP = {
  realRoutineDescTable: "Diag_names",
  realRoutineDescShape: { nfield: 14, c0: "int 1-9999 (Diag_Name_ID)", c1_c8: "8 language strings (EN/DE/CZ/ES/IT/FR/HU/RU)" },
  recoverableViaRecover: true,
  recoveredRowsLandInTable: "lost_and_found (sqlite3 .recover output)",
  recoveredCellCount: 54218,
  dispatchTableExtracted: false,
  dispatchTableExtractedNote:
    "The Diag_names rows give human-readable descriptions per routine label ID. They do NOT contain the UDS dispatch bytes (target ECU, RID, security level, payload). The dispatch mapping (label ID → UDS bytes) was never found — it may live in a different table whose name we haven't matched yet, or in CAN_*_CONFIG / FGA_* tables alongside the data display parameters.",
  pathForward: [
    "Enumerate every (rootpgno, nfield) signature in lost_and_found",
    "Match each signature back to one of the 19 documented tables by column shape",
    "Once Diag_names rows are isolated, the (Diag_Name_ID, EN, DE, CZ, ES, IT, FR, HU, RU) tuples ARE the routine descriptions",
    "Separately, find any table whose rows look like (label_id INT, target_ecu_id INT, uds_bytes BLOB) — that's the dispatch table if it exists at all",
    "Otherwise the dispatch is constructed at runtime in AlfaOBD.exe from a combination of CAN_*_CONFIG + per-procedure code paths",
  ],
};

/** @deprecated — kept for compatibility; replaced by ALFAOBD_DB_DISPATCH_GAP above.
 *  Prior version claimed a "fgaipcroutines" table that does not exist in the
 *  documented schema. */
export const ALFAOBD_DB_MISSING_TABLE = {
  name: null,
  superseded: "Use ALFAOBD_DB_DISPATCH_GAP instead",
  retractedClaim: "Earlier claim that 'fgaipcroutines' was the missing table — that table is not in the schema",
};

export const ALFAOBD_DB_META = {
  fileSize: 68224000,
  totalPages: 66625,
  pageSize: 1024,
  freelistPages: 592,
  sqliteFormatVersion: 3,
  schemaFormat: 4,
  textEncoding: "UTF-8",
  sqliteVersion: "3.19.3",
  tableCount: 19,
  encryptionMethod: "1024-byte repeating XOR (see alfaobdDbXorKey.js)",
  decryptionAccuracy: "~90-95%",
};
