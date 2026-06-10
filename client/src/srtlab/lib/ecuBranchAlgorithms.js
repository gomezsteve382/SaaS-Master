/**
 * ecuBranchAlgorithms.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for the 31 AlfaOBD advisory ECU branch algorithm
 * assignments. These are the explicit `eEcutype` equality checks inside
 * `abf()` that are NOT covered by the family-level DISPATCH table.
 *
 * HOW TO ADD A CONFIRMED ASSIGNMENT
 * ──────────────────────────────────
 * When the RE agent returns the table, update the entry for the ECU:
 *   1. Set `ecuType` to the confirmed hex value (e.g. 0x14F)
 *   2. Set `algo` to the confirmed algorithm: 'w6' | 'w7' | 'ht' | 'f' | 'ao'
 *   3. Set `wrapper` to the 2-letter wrapper name (for w6/w7 only)
 *   4. Set `level` to the confirmed security access level (1, 3, 5, or 7)
 *   5. Change `confidence` from 'pending' to 'confirmed'
 *   6. Remove or update the `note` field
 *
 * CONFIDENCE LEVELS
 * ─────────────────
 *   'confirmed'  — RE-verified: eEcutype hex + algorithm + wrapper + level all
 *                  extracted directly from AlfaOBD.exe abf() IL.
 *   'inferred'   — Best-evidence inference from ECU function + family grouping.
 *                  Validate on bench before relying on computed key.
 *   'pending'    — Not yet traced. Unlock path panel shows advisory-only badge.
 *
 * SOURCE
 * ──────
 * AlfaOBD.exe → abf() method → 41 explicit eEcutype equality checks.
 * Two already-confirmed branches (UCONNECT 0x149, RADIO_FGA 0x14E) are in
 * alfaobdSeedKey.js SPECIAL_ECUS and are NOT repeated here.
 */

/**
 * @typedef {Object} EcuBranchEntry
 * @property {string}  name        - ECU type name as used in AlfaOBD
 * @property {number|null} ecuType - eEcutype hex value (null = not yet traced)
 * @property {string}  algo        - Algorithm: 'w6'|'w7'|'ht'|'f'|'ao'|'unknown'
 * @property {string|null} wrapper - W6/W7 wrapper name (2-letter code), or null
 * @property {number}  level       - Security access level (1, 3, 5, or 7)
 * @property {string}  confidence  - 'confirmed'|'inferred'|'pending'
 * @property {string}  note        - Human-readable description / caveat
 * @property {string}  category    - ECU functional category for grouping
 */

/** @type {EcuBranchEntry[]} */
export const ECU_BRANCH_ALGORITHMS = [
  // ── Restraint / Safety ────────────────────────────────────────────────────
  {
    name: 'ORC',        ecuType: 0x107, algo: 'ht', wrapper: null, level: 1,
    confidence: 'confirmed',
    note: 'Occupant Restraint Controller — eEcutype 0x107, ad::ht (no wrapper), RE-verified from abf() IL',
    category: 'safety',
  },
  {
    name: 'OCM_PN',     ecuType: 0x139, algo: 'ht', wrapper: null, level: 1,
    confidence: 'confirmed',
    note: 'Occupant Classification Module (PN variant) — eEcutype 0x139, ad::ht (no wrapper), RE-verified from abf() IL',
    category: 'safety',
  },

  // ── Braking ───────────────────────────────────────────────────────────────
  {
    name: 'ABS_PN',     ecuType: 0x12C, algo: 'ht', wrapper: null, level: 1,
    confidence: 'confirmed',
    note: 'Anti-lock Braking System (PN variant) — eEcutype 0x12C, ad::ht (no wrapper), RE-verified from abf() IL',
    category: 'braking',
  },
  {
    name: 'ABS_CHRYSLER', ecuType: 0x12B, algo: 'ht', wrapper: null, level: 1,
    confidence: 'confirmed',
    note: 'Chrysler-platform ABS — eEcutype 0x12B, ad::ht (no wrapper), RE-verified from abf() IL',
    category: 'braking',
  },
  {
    name: 'ASBS_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Active Safety Braking System (PN variant) — awaiting RE trace',
    category: 'braking',
  },

  // ── Power / Integration ───────────────────────────────────────────────────
  {
    name: 'TIPM_CGW',   ecuType: 0x12E, algo: 'f', wrapper: null, level: 1,
    confidence: 'confirmed',
    note: 'Total Integrated Power Module / Central Gateway variant — eEcutype 0x12E, ad::f, RE-verified from abf() IL',
    category: 'power',
  },
  {
    name: 'OBCM',       ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'On-Board Charger Module — awaiting RE trace',
    category: 'power',
  },
  {
    name: 'BPCM',       ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Battery Pack Control Module — awaiting RE trace',
    category: 'power',
  },
  {
    name: 'BPCM_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Battery Pack Control Module (PN variant) — awaiting RE trace',
    category: 'power',
  },
  {
    name: 'EVCU',       ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'EV Control Unit — awaiting RE trace',
    category: 'power',
  },
  {
    name: 'APM_PN',     ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Active Park Module (PN variant) — awaiting RE trace',
    category: 'power',
  },

  // ── Infotainment / HMI ────────────────────────────────────────────────────
  {
    name: 'RADIO_NON_PN', ecuType: 0x143, algo: 'ao', wrapper: null, level: 5,
    confidence: 'confirmed',
    note: 'Non-PN Radio — eEcutype 0x143, ad::ao (XTEA-BE, same family as UCONNECT/RADIO_FGA), RE-verified from abf() IL',
    category: 'infotainment',
  },
  {
    name: 'ICS_PN',     ecuType: null, algo: 'unknown', wrapper: null, level: 5,
    confidence: 'pending',
    note: 'Integrated Center Stack (PN variant) — awaiting RE trace',
    category: 'infotainment',
  },
  {
    name: 'AMP_PN',     ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Audio Amplifier (PN variant) — awaiting RE trace',
    category: 'infotainment',
  },
  {
    name: 'ANC_PN',     ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Active Noise Cancellation (PN variant) — awaiting RE trace',
    category: 'infotainment',
  },

  // ── Chassis / Steering / Suspension ──────────────────────────────────────
  {
    name: 'EPS_PN',     ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Electric Power Steering (PN variant) — awaiting RE trace',
    category: 'chassis',
  },
  {
    name: 'ADCM',       ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Active Damping Control Module — awaiting RE trace',
    category: 'chassis',
  },
  {
    name: 'ADCM_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Active Damping Control Module (PN variant) — awaiting RE trace',
    category: 'chassis',
  },
  {
    name: 'AFLS_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Adaptive Front Lighting System (PN variant) — awaiting RE trace',
    category: 'chassis',
  },

  // ── Cluster / Displays ────────────────────────────────────────────────────
  {
    name: 'IPC_PN',     ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Instrument Panel Cluster (PN variant) — awaiting RE trace',
    category: 'cluster',
  },

  // ── Doors / Body ──────────────────────────────────────────────────────────
  {
    name: 'DDM_DT',     ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Driver Door Module (DT platform) — awaiting RE trace',
    category: 'body',
  },
  {
    name: 'PDM_DT',     ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Passenger Door Module (DT platform) — awaiting RE trace',
    category: 'body',
  },
  {
    name: 'CSWM_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Column Switch / Wiper Module (PN variant) — awaiting RE trace',
    category: 'body',
  },
  {
    name: 'ASCM_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Active Speed Control Module (PN variant) — awaiting RE trace',
    category: 'body',
  },

  // ── Blind Spot / Sensing ──────────────────────────────────────────────────
  {
    name: 'LBSS_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Left Blind Spot Sensor (PN variant) — awaiting RE trace',
    category: 'sensing',
  },
  {
    name: 'RBSS_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Right Blind Spot Sensor (PN variant) — awaiting RE trace',
    category: 'sensing',
  },
  {
    name: 'CVPM_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Central Vision Processing Module (PN variant) — awaiting RE trace',
    category: 'sensing',
  },

  // ── Telematics / Connectivity ─────────────────────────────────────────────
  {
    name: 'TGW_PN',     ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Telematics Gateway (PN variant) — awaiting RE trace',
    category: 'telematics',
  },

  // ── Trailer / Towing ──────────────────────────────────────────────────────
  {
    name: 'TTPM_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Trailer Tow Power Module (PN variant) — awaiting RE trace',
    category: 'towing',
  },
  {
    name: 'TBM2',       ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Trailer Brake Module 2 — awaiting RE trace',
    category: 'towing',
  },
  {
    name: 'TBM2_PN',    ecuType: null, algo: 'unknown', wrapper: null, level: 1,
    confidence: 'pending',
    note: 'Trailer Brake Module 2 (PN variant) — awaiting RE trace',
    category: 'towing',
  },
];

/**
 * Look up a branch entry by ECU name.
 * @param {string} name
 * @returns {EcuBranchEntry|undefined}
 */
export function getBranchByName(name) {
  return ECU_BRANCH_ALGORITHMS.find(e => e.name === name);
}

/**
 * Look up a branch entry by eEcutype hex value.
 * @param {number} ecuType
 * @returns {EcuBranchEntry|undefined}
 */
export function getBranchByEcuType(ecuType) {
  return ECU_BRANCH_ALGORITHMS.find(e => e.ecuType === ecuType);
}

/**
 * Returns all entries that are ready to compute (confidence !== 'pending').
 * @returns {EcuBranchEntry[]}
 */
export function getComputableBranches() {
  return ECU_BRANCH_ALGORITHMS.filter(e => e.confidence !== 'pending' && e.algo !== 'unknown');
}

/**
 * Returns all entries still awaiting RE trace.
 * @returns {EcuBranchEntry[]}
 */
export function getPendingBranches() {
  return ECU_BRANCH_ALGORITHMS.filter(e => e.confidence === 'pending');
}

/**
 * Summary stats for the dispatch coverage panel.
 */
export function getBranchCoverage() {
  const total = ECU_BRANCH_ALGORITHMS.length;
  const confirmed = ECU_BRANCH_ALGORITHMS.filter(e => e.confidence === 'confirmed').length;
  const inferred  = ECU_BRANCH_ALGORITHMS.filter(e => e.confidence === 'inferred').length;
  const pending   = ECU_BRANCH_ALGORITHMS.filter(e => e.confidence === 'pending').length;
  return { total, confirmed, inferred, pending };
}
