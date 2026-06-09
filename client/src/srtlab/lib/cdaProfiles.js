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
    identify: ["22 F1 87", "22 F1 8C", "22 F1 80"],
    services: [
      { name: "Read Part Number",          type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read ECU Serial Number",     type: "read_did",  did: "F18C", request: "22 F1 8C" },
      { name: "Read Boot SW Version",       type: "read_did",  did: "F180", request: "22 F1 80" },
      { name: "Read App SW Version",        type: "read_did",  did: "F189", request: "22 F1 89" },
      { name: "Read Supplier ID",           type: "read_did",  did: "F18A", request: "22 F1 8A" },
      { name: "Read HW Version",            type: "read_did",  did: "F191", request: "22 F1 91" },
      { name: "Read Crash Event Counter",   type: "read_did",  did: "D001", request: "22 D0 01" },
      { name: "Read Deployment Status",     type: "read_did",  did: "D002", request: "22 D0 02" },
      { name: "Read Airbag Firing Data",    type: "read_did",  did: "D003", request: "22 D0 03" },
      { name: "Read Seatbelt Pretensioner", type: "read_did",  did: "D010", request: "22 D0 10" },
      { name: "Read Driver Airbag Status",  type: "read_did",  did: "D020", request: "22 D0 20" },
      { name: "Read Pass Airbag Status",    type: "read_did",  did: "D021", request: "22 D0 21" },
      { name: "Read Side Curtain Status",   type: "read_did",  did: "D022", request: "22 D0 22" },
      { name: "Read Knee Airbag Status",    type: "read_did",  did: "D023", request: "22 D0 23" },
      { name: "Read DTCs (All)",            type: "raw",       request: "19 02 08" },
      { name: "Read DTCs (Confirmed)",      type: "raw",       request: "19 02 09" },
      { name: "Clear DTCs",                 type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",           type: "raw",       request: "10 03" },
      { name: "Programming Session",        type: "raw",       request: "10 02" },
      { name: "Default Session",            type: "raw",       request: "10 01" },
      { name: "Tester Present",             type: "raw",       request: "3E 02" },
      { name: "Request Seed Lvl 01",        type: "raw",       request: "27 01" },
      { name: "Request Seed Lvl 03",        type: "raw",       request: "27 03" },
      { name: "Clear Crash Data Routine",   type: "routine",   request: "31 01 FF 00", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "Write Part Number",          type: "write_did", did: "F187", request: "2E F1 87", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "ECU Reset Hard",             type: "raw",       request: "11 01" },
      { name: "ECU Reset Soft",             type: "raw",       request: "11 03" },
    ],
  },

  // ─── RADIO / UConnect ────────────────────────────────────────────────────────
  {
    profile_name: "RADIO_FCA",
    ecu_name: "RADIO",
    display_name: "Radio / UConnect",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x772", rx_id: "0x77A", addressing: "11bit" },
    identify: ["22 F1 87", "22 F1 90", "22 F1 0B", "22 F1 80"],
    services: [
      { name: "Read VIN",                   type: "read_did",  did: "F190", request: "22 F1 90" },
      { name: "Read Part Number",           type: "read_did",  did: "F10B", request: "22 F1 0B" },
      { name: "Read SW Version",            type: "read_did",  did: "F189", request: "22 F1 89" },
      { name: "Read Boot SW Version",       type: "read_did",  did: "F180", request: "22 F1 80" },
      { name: "Read ECU Serial Number",     type: "read_did",  did: "F18C", request: "22 F1 8C" },
      { name: "Read Supplier ID",           type: "read_did",  did: "F18A", request: "22 F1 8A" },
      { name: "Read HW Version",            type: "read_did",  did: "F191", request: "22 F1 91" },
      { name: "Read System Name",           type: "read_did",  did: "F197", request: "22 F1 97" },
      { name: "Read Fingerprint",           type: "read_did",  did: "F15A", request: "22 F1 5A" },
      { name: "Read Active Diagnostic Session", type: "read_did", did: "F186", request: "22 F1 86" },
      { name: "Read Security Access Level", type: "read_did",  did: "F18E", request: "22 F1 8E" },
      { name: "Read NAD Config",            type: "read_did",  did: "4001", request: "22 40 01" },
      { name: "Read Paired Devices",        type: "read_did",  did: "4010", request: "22 40 10" },
      { name: "Read UConnect Map Version",  type: "read_did",  did: "4020", request: "22 40 20" },
      { name: "Read DTCs (All)",            type: "raw",       request: "19 02 08" },
      { name: "Read DTCs (Confirmed)",      type: "raw",       request: "19 02 09" },
      { name: "Clear DTCs",                 type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",           type: "raw",       request: "10 03" },
      { name: "Programming Session",        type: "raw",       request: "10 02" },
      { name: "Default Session",            type: "raw",       request: "10 01" },
      { name: "Tester Present",             type: "raw",       request: "3E 02" },
      { name: "Request Seed Lvl 01",        type: "raw",       request: "27 01" },
      { name: "Request Seed Lvl 03",        type: "raw",       request: "27 03" },
      { name: "Write VIN",                  type: "write_did", did: "F190", request: "2E F1 90", requires_session: "extended", session_request: "10 03", requires_security: "level1" },
      { name: "Write Part Number",          type: "write_did", did: "F10B", request: "2E F1 0B", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "Factory Reset Routine",      type: "routine",   request: "31 01 FF 01", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "Pair Device Routine",        type: "routine",   request: "31 01 40 11", requires_session: "extended", session_request: "10 03", requires_security: "level1" },
      { name: "ECU Reset Hard",             type: "raw",       request: "11 01" },
      { name: "ECU Reset Soft",             type: "raw",       request: "11 03" },
    ],
  },

  // ─── TIPM ────────────────────────────────────────────────────────────────────
  {
    profile_name: "TIPM_FCA",
    ecu_name: "TIPM",
    display_name: "Total Integrated Power Module",
    variant: "FCA",
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x740", rx_id: "0x748", addressing: "11bit" },
    identify: ["22 F1 87", "22 F1 8C", "22 F1 80", "22 F1 90"],
    services: [
      { name: "Read VIN",                    type: "read_did",  did: "F190", request: "22 F1 90" },
      { name: "Read Part Number",            type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read ECU Serial Number",      type: "read_did",  did: "F18C", request: "22 F1 8C" },
      { name: "Read Boot SW Version",        type: "read_did",  did: "F180", request: "22 F1 80" },
      { name: "Read App SW Version",         type: "read_did",  did: "F189", request: "22 F1 89" },
      { name: "Read Supplier ID",            type: "read_did",  did: "F18A", request: "22 F1 8A" },
      { name: "Read HW Version",             type: "read_did",  did: "F191", request: "22 F1 91" },
      { name: "Read Active Diag Session",    type: "read_did",  did: "F186", request: "22 F1 86" },
      { name: "Read Battery Voltage",        type: "read_did",  did: "2001", request: "22 20 01" },
      { name: "Read Ignition Status",        type: "read_did",  did: "2002", request: "22 20 02" },
      { name: "Read Relay States",           type: "read_did",  did: "2010", request: "22 20 10" },
      { name: "Read Fuse Status",            type: "read_did",  did: "2011", request: "22 20 11" },
      { name: "Read Power Mode",             type: "read_did",  did: "2020", request: "22 20 20" },
      { name: "Read Wake-Up Reason",         type: "read_did",  did: "2021", request: "22 20 21" },
      { name: "Read Sleep Counter",          type: "read_did",  did: "2022", request: "22 20 22" },
      { name: "Read CAN Bus Status",         type: "read_did",  did: "2030", request: "22 20 30" },
      { name: "Read DTCs (All)",             type: "raw",       request: "19 02 08" },
      { name: "Read DTCs (Confirmed)",       type: "raw",       request: "19 02 09" },
      { name: "Clear DTCs",                  type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",            type: "raw",       request: "10 03" },
      { name: "Programming Session",         type: "raw",       request: "10 02" },
      { name: "Default Session",             type: "raw",       request: "10 01" },
      { name: "Tester Present",              type: "raw",       request: "3E 02" },
      { name: "Request Seed Lvl 01",         type: "raw",       request: "27 01" },
      { name: "Request Seed Lvl 03",         type: "raw",       request: "27 03" },
      { name: "Request Seed Lvl 0x80",       type: "raw",       request: "27 80" },
      { name: "Relay Force On Routine",      type: "routine",   request: "31 01 20 10", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "Relay Force Off Routine",     type: "routine",   request: "31 01 20 11", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "Write VIN",                   type: "write_did", did: "F190", request: "2E F1 90", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "Write Part Number",           type: "write_did", did: "F187", request: "2E F1 87", requires_session: "extended", session_request: "10 03", requires_security: "level3" },
      { name: "ECU Reset Hard",              type: "raw",       request: "11 01" },
      { name: "ECU Reset Soft",              type: "raw",       request: "11 03" },
    ],
  },

  // ─── SGW (Security Gateway) ──────────────────────────────────────────────────
  {
    profile_name: "SGW_FCA",
    ecu_name: "SGW",
    display_name: "Security Gateway",
    variant: "FCA",
    // SGW typically does not respond on a single CAN ID — it proxies requests.
    // The IDs below are the FCA Stellantis SGW functional address.
    connection: { protocol: "ISO15765", baudrate: 500000, tx_id: "0x73E", rx_id: "0x73F", addressing: "11bit" },
    identify: ["22 F1 87", "22 F1 8C", "22 F1 80"],
    services: [
      { name: "Read Part Number",            type: "read_did",  did: "F187", request: "22 F1 87" },
      { name: "Read ECU Serial Number",      type: "read_did",  did: "F18C", request: "22 F1 8C" },
      { name: "Read Boot SW Version",        type: "read_did",  did: "F180", request: "22 F1 80" },
      { name: "Read App SW Version",         type: "read_did",  did: "F189", request: "22 F1 89" },
      { name: "Read Supplier ID",            type: "read_did",  did: "F18A", request: "22 F1 8A" },
      { name: "Read HW Version",             type: "read_did",  did: "F191", request: "22 F1 91" },
      { name: "Read Active Diag Session",    type: "read_did",  did: "F186", request: "22 F1 86" },
      { name: "Read SGW Bypass Status",      type: "read_did",  did: "3001", request: "22 30 01" },
      { name: "Read SGW Access Level",       type: "read_did",  did: "3002", request: "22 30 02" },
      { name: "Read Firewall Config",        type: "read_did",  did: "3010", request: "22 30 10" },
      { name: "Read Allowed Services",       type: "read_did",  did: "3011", request: "22 30 11" },
      { name: "Read SGW Log Count",          type: "read_did",  did: "3020", request: "22 30 20" },
      { name: "Read SGW Fault Log",          type: "read_did",  did: "3021", request: "22 30 21" },
      { name: "Read DTCs",                   type: "raw",       request: "19 02 08" },
      { name: "Clear DTCs",                  type: "raw",       request: "14 FF FF FF" },
      { name: "Extended Session",            type: "raw",       request: "10 03" },
      { name: "Programming Session",         type: "raw",       request: "10 02" },
      { name: "Default Session",             type: "raw",       request: "10 01" },
      { name: "Tester Present",              type: "raw",       request: "3E 02" },
      // SGW uses level 0x11/0x12 for gateway bypass — non-standard
      { name: "Request SGW Seed Lvl 11",     type: "raw",       request: "27 11" },
      { name: "Request SGW Seed Lvl 01",     type: "raw",       request: "27 01" },
      { name: "Request SGW Seed Lvl 03",     type: "raw",       request: "27 03" },
      { name: "SGW Bypass Routine",          type: "routine",   request: "31 01 30 01", requires_session: "extended", session_request: "10 03", requires_security: "level11" },
      { name: "Write Firewall Config",       type: "write_did", did: "3010", request: "2E 30 10", requires_session: "extended", session_request: "10 03", requires_security: "level11" },
      { name: "ECU Reset Hard",              type: "raw",       request: "11 01" },
      { name: "ECU Reset Soft",              type: "raw",       request: "11 03" },
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
