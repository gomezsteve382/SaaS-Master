/**
 * CDA J2534 Module Map
 * Ported from CDAJ2534/vehicle/module_map.py and corrected/expanded.
 *
 * BCM TX/RX corrected to 0x750/0x758 (verified from RE analysis).
 * IPC corrected to 0x746/0x766 (verified from RE analysis).
 * All modules include: name, display_name, tx_id, rx_id, baudrate, algo, notes.
 */

export const CDA_MODULES = [
  // ─── Primary powertrain ───────────────────────────────────────────────────────
  { name: "ECM",    display: "Engine Control Module",         tx: 0x7E0, rx: 0x7E8, baud: 500000, algo: "gpec2a",   icon: "⚙️",  notes: "GPEC2A — main PCM" },
  { name: "TCM",    display: "Transmission Control Module",   tx: 0x7E1, rx: 0x7E9, baud: 500000, algo: "gpec2",    icon: "⚙️",  notes: "Transmission" },
  { name: "DTCM",   display: "Dual Transfer Case Module",     tx: 0x7E2, rx: 0x7EA, baud: 500000, algo: "gpec2",    icon: "⚙️",  notes: "4WD transfer case" },
  { name: "BPCM",   display: "Battery Pack Control Module",   tx: 0x7E4, rx: 0x7EC, baud: 500000, algo: "gpec2",    icon: "🔋",  notes: "Hybrid/EV battery" },

  // ─── Body / security ─────────────────────────────────────────────────────────
  { name: "BCM",    display: "Body Control Module",           tx: 0x750, rx: 0x758, baud: 500000, algo: "cda6",     icon: "🚗",  notes: "BCM — corrected TX/RX" },
  { name: "RFHUB",  display: "RF Hub / SKREEM",               tx: 0x75F, rx: 0x767, baud: 500000, algo: "cda6",     icon: "📡",  notes: "Transponder/key ring" },
  { name: "TIPM",   display: "Total Integrated Power Module", tx: 0x740, rx: 0x748, baud: 500000, algo: "t80",      icon: "⚡",  notes: "Fuse/relay center" },
  { name: "SGW",    display: "Security Gateway",              tx: 0x73E, rx: 0x73F, baud: 500000, algo: "xtea_sgw", icon: "🔒",  notes: "SGW bypass required on 2018+" },

  // ─── Chassis ─────────────────────────────────────────────────────────────────
  { name: "ABS",    display: "Anti-lock Brake System",        tx: 0x760, rx: 0x768, baud: 500000, algo: "gpec2",    icon: "🛑",  notes: "" },
  { name: "EPS",    display: "Electric Power Steering",       tx: 0x761, rx: 0x769, baud: 500000, algo: "sbec",     icon: "🔄",  notes: "" },
  { name: "ORC",    display: "Occupant Restraint Controller", tx: 0x758, rx: 0x760, baud: 500000, algo: "sbec",     icon: "💺",  notes: "Airbag module" },
  { name: "TPMS",   display: "Tire Pressure Monitor",         tx: 0x752, rx: 0x75A, baud: 500000, algo: "sbec",     icon: "🔵",  notes: "" },
  { name: "BSM",    display: "Blind Spot Monitor",            tx: 0x770, rx: 0x778, baud: 500000, algo: "sbec",     icon: "👁️",  notes: "" },
  { name: "ACC",    display: "Adaptive Cruise Control",       tx: 0x700, rx: 0x708, baud: 500000, algo: "alfa_w6",  icon: "🚦",  notes: "" },

  // ─── Cluster / infotainment ───────────────────────────────────────────────────
  { name: "IPC",    display: "Instrument Panel Cluster",      tx: 0x746, rx: 0x766, baud: 500000, algo: "sbec",     icon: "📊",  notes: "IPCM — corrected TX/RX" },
  { name: "RADIO",  display: "Radio / UConnect",              tx: 0x772, rx: 0x77A, baud: 500000, algo: "alfa_w6",  icon: "📻",  notes: "" },
  { name: "AMP",    display: "Audio Amplifier",               tx: 0x7A0, rx: 0x7A8, baud: 500000, algo: "alfa_w6",  icon: "🔊",  notes: "" },
  { name: "HVAC",   display: "HVAC Control Module",           tx: 0x751, rx: 0x759, baud: 500000, algo: "alfa_w6",  icon: "❄️",  notes: "" },

  // ─── Doors / seats ───────────────────────────────────────────────────────────
  { name: "DDM",    display: "Driver Door Module",            tx: 0x748, rx: 0x768, baud: 500000, algo: "sbec",     icon: "🚪",  notes: "" },
  { name: "PDM",    display: "Passenger Door Module",         tx: 0x749, rx: 0x769, baud: 500000, algo: "sbec",     icon: "🚪",  notes: "" },
  { name: "SCCM",   display: "Steering Column Control",       tx: 0x74D, rx: 0x76D, baud: 500000, algo: "sbec",     icon: "🎮",  notes: "" },
  { name: "ADCM",   display: "All Door Control Module",       tx: 0x7A8, rx: 0x7B0, baud: 500000, algo: "gpec2",    icon: "🚪",  notes: "" },
];

/** Look up a module by name */
export function getModuleByName(name) {
  return CDA_MODULES.find(m => m.name === name) || null;
}

/** Look up a module by TX ID */
export function getModuleByTx(txId) {
  return CDA_MODULES.find(m => m.tx === txId) || null;
}

/** Get all module names */
export function getAllModuleNames() {
  return CDA_MODULES.map(m => m.name);
}
