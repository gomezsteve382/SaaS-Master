/**
 * CDA J2534 Profile Database
 * Ported from CDAJ2534/database/profiles.json and expanded with all FCA/Stellantis modules.
 * Each profile defines: connection params, identify DIDs, and available services.
 *
 * BCM TX/RX corrected to 0x750/0x758 (verified from RE analysis).
 */

export const CDA_PROFILES = [
  // ─── BCM ─────────────────────────────────────────────────────────────────────
  {
    profile_name: "BCM_FGA_SUP0004_VAR90_V09_V10",
    ecu_name: "BCM",
    display_name: "Body Control Module",
    variant: "90",
    ident: "9006",
    supplier: "0004",
    min_version: 9,
    max_version: 10,
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x750", rx_id: "0x758", addressing: "11bit" },
    identify: ["22 F1 80", "22 F1 81", "22 F1 87", "22 F1 8A", "22 F1 B0"],
    services: [
      { name: "Read VIN Current",     type: "read_did",  did: "F1B0", request: "22 F1 B0" },
      { name: "Read VIN Original",    type: "read_did",  did: "F190", request: "22 F1 90" },
      { name: "Read Proxy VIN Data",  type: "read_did",  did: "2023", request: "22 20 23" },
      { name: "Read Part Number",     type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read Supplier",        type: "read_did",  did: "F18A", request: "22 F1 8A" },
      { name: "Read SW Version",      type: "read_did",  did: "F189", request: "22 F1 89" },
      { name: "Read Body Code",       type: "read_did",  did: "F10F", request: "22 F1 0F" },
      { name: "Read Odometer",        type: "read_did",  did: "F10E", request: "22 F1 0E" },
      { name: "Read DTCs",            type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",           type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Default Session",      type: "raw",       request: "10 01" },
      { name: "Tester Present",       type: "raw",       request: "3E 02" },
      { name: "Request Seed Lvl 01",  type: "raw",       request: "27 01" },
      { name: "Request Seed Lvl 03",  type: "raw",       request: "27 03" },
      { name: "Request Seed Lvl 05",  type: "raw",       request: "27 05" },
      { name: "VIN Unlock Routine",   type: "routine",   request: "31 01 20 01", requires_session: "extended", session_request: "10 03", requires_security: "level5" },
      { name: "VIN Lock Routine",     type: "routine",   request: "31 01 20 00", requires_session: "extended", session_request: "10 03", requires_security: "level5" },
      { name: "Write VIN Current",    type: "write_did", did: "F1B0", request: "2E F1 B0", requires_session: "extended", session_request: "10 03", requires_security: "level5" },
      { name: "Write VIN Original",   type: "write_did", did: "F190", request: "2E F1 90", requires_session: "extended", session_request: "10 03", requires_security: "level5" },
      { name: "Write Body Code",      type: "write_did", did: "F10F", request: "2E F1 0F", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
    ],
  },

  // ─── ECM / PCM ───────────────────────────────────────────────────────────────
  {
    profile_name: "ECM_GPEC2A_FCA",
    ecu_name: "ECM",
    display_name: "Engine Control Module (GPEC2A)",
    variant: "GPEC2A",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x7E0", rx_id: "0x7E8", addressing: "11bit" },
    identify: ["22 F1 80", "22 F1 87", "22 F1 90"],
    services: [
      { name: "Read VIN",             type: "read_did",  did: "F190", request: "22 F1 90" },
      { name: "Read Part Number",     type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read SW Version",      type: "read_did",  did: "F189", request: "22 F1 89" },
      { name: "Read Calibration ID",  type: "read_did",  did: "F18A", request: "22 F1 8A" },
      { name: "Read Odometer",        type: "read_did",  did: "F10E", request: "22 F1 0E" },
      { name: "Read DTCs",            type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",           type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Programming Session",  type: "raw",       request: "10 02" },
      { name: "Request Seed Lvl 01",  type: "raw",       request: "27 01" },
      { name: "Request Seed Lvl 03",  type: "raw",       request: "27 03" },
      { name: "Write VIN",            type: "write_did", did: "F190", request: "2E F1 90", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "Write Odometer",       type: "write_did", did: "F10E", request: "2E F1 0E", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "ECU Reset Hard",       type: "raw",       request: "11 01" },
      { name: "ECU Reset Soft",       type: "raw",       request: "11 03" },
    ],
  },

  // ─── TCM ─────────────────────────────────────────────────────────────────────
  {
    profile_name: "TCM_FCA",
    ecu_name: "TCM",
    display_name: "Transmission Control Module",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x7E1", rx_id: "0x7E9", addressing: "11bit" },
    identify: ["22 F1 87", "22 F1 90"],
    services: [
      { name: "Read VIN",             type: "read_did",  did: "F190", request: "22 F1 90" },
      { name: "Read Part Number",     type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read SW Version",      type: "read_did",  did: "F189", request: "22 F1 89" },
      { name: "Read DTCs",            type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",           type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Request Seed Lvl 01",  type: "raw",       request: "27 01" },
      { name: "ECU Reset",            type: "raw",       request: "11 01" },
    ],
  },

  // ─── RFHUB ───────────────────────────────────────────────────────────────────
  {
    profile_name: "RFHUB_FCA",
    ecu_name: "RFHUB",
    display_name: "RF Hub / SKREEM",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x75F", rx_id: "0x767", addressing: "11bit" },
    identify: ["22 F1 87", "22 F1 90"],
    services: [
      { name: "Read VIN",             type: "read_did",  did: "F190", request: "22 F1 90" },
      { name: "Read Part Number",     type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read SW Version",      type: "read_did",  did: "F189", request: "22 F1 89" },
      { name: "Read DTCs",            type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",           type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Request Seed Lvl 01",  type: "raw",       request: "27 01" },
      { name: "Request Seed Lvl 03",  type: "raw",       request: "27 03" },
      { name: "Write VIN",            type: "write_did", did: "F190", request: "2E F1 90", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "ECU Reset",            type: "raw",       request: "11 01" },
    ],
  },

  // ─── IPC / Cluster ───────────────────────────────────────────────────────────
  {
    profile_name: "IPC_FCA",
    ecu_name: "IPC",
    display_name: "Instrument Panel Cluster",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x746", rx_id: "0x766", addressing: "11bit" },
    identify: ["22 F1 87", "22 F1 90", "22 F1 0F"],
    services: [
      { name: "Read VIN",             type: "read_did",  did: "F190", request: "22 F1 90" },
      { name: "Read Part Number",     type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read Body Code",       type: "read_did",  did: "F10F", request: "22 F1 0F" },
      { name: "Read Odometer",        type: "read_did",  did: "F10E", request: "22 F1 0E" },
      { name: "Read DTCs",            type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",           type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Request Seed Lvl 01",  type: "raw",       request: "27 01" },
      { name: "Write Body Code",      type: "write_did", did: "F10F", request: "2E F1 0F", requires_session: "extended", session_request: "10 03", requires_security: "level1" },
      { name: "Write VIN",            type: "write_did", did: "F190", request: "2E F1 90", requires_session: "extended", session_request: "10 03", requires_security: "level1" },
      { name: "Write Odometer",       type: "write_did", did: "F10E", request: "2E F1 0E", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "ECU Reset",            type: "raw",       request: "11 01" },
    ],
  },

  // ─── ABS ─────────────────────────────────────────────────────────────────────
  {
    profile_name: "ABS_FCA",
    ecu_name: "ABS",
    display_name: "Anti-lock Brake System",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x760", rx_id: "0x768", addressing: "11bit" },
    identify: ["22 F1 87", "22 F1 90"],
    services: [
      { name: "Read VIN",             type: "read_did",  did: "F190", request: "22 F1 90" },
      { name: "Read Part Number",     type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read DTCs",            type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",           type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Request Seed Lvl 01",  type: "raw",       request: "27 01" },
      { name: "ECU Reset",            type: "raw",       request: "11 01" },
    ],
  },

  // ─── ORC (Occupant Restraint Controller) ─────────────────────────────────────
  {
    profile_name: "ORC_FCA",
    ecu_name: "ORC",
    display_name: "Occupant Restraint Controller",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x758", rx_id: "0x760", addressing: "11bit" },
    identify: ["22 F1 87"],
    services: [
      { name: "Read Part Number",     type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read DTCs",            type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",           type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Request Seed Lvl 01",  type: "raw",       request: "27 01" },
      { name: "ECU Reset",            type: "raw",       request: "11 01" },
    ],
  },

  // ─── RADIO ───────────────────────────────────────────────────────────────────
  {
    profile_name: "RADIO_FCA",
    ecu_name: "RADIO",
    display_name: "Radio / UConnect",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x772", rx_id: "0x77A", addressing: "11bit" },
    identify: ["22 F1 87", "22 F1 90", "22 F1 0B"],
    services: [
      { name: "Read VIN",             type: "read_did",  did: "F190", request: "22 F1 90" },
      { name: "Read Part Number",     type: "read_did",  did: "F10B", request: "22 F1 0B" },
      { name: "Read SW Version",      type: "read_did",  did: "F189", request: "22 F1 89" },
      { name: "Read DTCs",            type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",           type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Request Seed Lvl 01",  type: "raw",       request: "27 01" },
      { name: "Write VIN",            type: "write_did", did: "F190", request: "2E F1 90", requires_session: "extended", session_request: "10 03", requires_security: "level1" },
      { name: "ECU Reset",            type: "raw",       request: "11 01" },
    ],
  },

  // ─── TIPM ────────────────────────────────────────────────────────────────────
  {
    profile_name: "TIPM_FCA",
    ecu_name: "TIPM",
    display_name: "Total Integrated Power Module",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x740", rx_id: "0x748", addressing: "11bit" },
    identify: ["22 F1 87"],
    services: [
      { name: "Read Part Number",     type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read DTCs",            type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",           type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Request Seed Lvl 01",  type: "raw",       request: "27 01" },
      { name: "ECU Reset",            type: "raw",       request: "11 01" },
    ],
  },

  // ─── SGW (Security Gateway) ──────────────────────────────────────────────────
  {
    profile_name: "SGW_FCA",
    ecu_name: "SGW",
    display_name: "Security Gateway",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x73E", rx_id: "0x73F", addressing: "11bit" },
    identify: ["22 F1 87"],
    services: [
      { name: "Read Part Number",     type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Extended Session",     type: "raw",       request: "10 03" },
      { name: "Request SGW Seed",     type: "raw",       request: "27 11" },
      { name: "ECU Reset",            type: "raw",       request: "11 01" },
    ],
  },
];

/** Look up a profile by ECU name */
export function getProfileByEcu(ecuName) {
  return CDA_PROFILES.find(p => p.ecu_name === ecuName) || null;
}

/** Get all profiles */
export function getAllProfiles() {
  return CDA_PROFILES;
}

/** Get services for a given ECU */
export function getServicesForEcu(ecuName) {
  const profile = getProfileByEcu(ecuName);
  return profile ? profile.services : [];
}

/** Get services by type filter */
export function getServicesByType(ecuName, type) {
  return getServicesForEcu(ecuName).filter(s => s.type === type);
}
