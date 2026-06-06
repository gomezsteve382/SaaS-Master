/**
 * udsEngine.js — Unified UDS Module Registry and Session State Machine
 *
 * Source of truth: RE analysis of SRT_Lab_UDS_Complete_Export.zip
 * (report.md, 06_can_ids_all_modules.txt, 05_seed_key_algorithms.txt,
 *  07_did_catalog.txt, 10_ipc_firmware_catalog.txt, 11_adcm_vehicle_codes.txt,
 *  lib__masterCipherDispatch.generated.js, lib__securityAccessSource.js)
 *
 * This file provides:
 *   MODULE_REGISTRY      — all FCA/Stellantis modules with CAN IDs, session
 *                          type, security levels, algorithm, DID catalog,
 *                          flash block layout, and post-programming steps.
 *   VEHICLE_BODY_CODES   — platform byte values (Trackhawk, Durango, Charger…)
 *   getModuleConfig(code)— look up a module by its short code (e.g. 'IPC')
 *   computeKey(algo, seed) — derive the UDS security-access key from a seed
 *   buildSessionSequence(moduleCode, operation) — produce the ordered UDS
 *                          byte sequences for a given operation
 *   buildFlashSequence(moduleCode, blocks) — produce the flash download
 *                          byte sequences for a given module
 *   buildIpcBodyCodeSwap(targetCode) — produce the full Durango→Trackhawk
 *                          DID-write sequence (no reflash needed)
 *   formatHex(bytes)     — format a number[] as "XX XX XX …" for display
 *   parseHexString(s)    — parse "XX XX XX …" into a number[]
 *
 * Existing libs this module wraps / orchestrates (do NOT duplicate):
 *   algos.js       — SBEC, CDA6, W6, W7, XTEA implementations
 *   sgwUnlock.js   — SGW bypass sequence generator
 *   vinProgrammer.js — VIN write engine
 *   uds.js         — multi-DID batching, ReadMemoryByAddress helpers
 *   flashSequencer.js — flash download state machine
 */

// ─── Seed-key algorithm IDs (match algos.js exports) ─────────────────────────
export const ALGO = Object.freeze({
  SBEC:   'sbec',    // key = (seed * 4) + 0x9018  (IPC, SKIM, legacy)
  CDA6:   'cda6',    // CDA6 transform              (BCM, RFHUB)
  GPEC2A: 'gpec2a',  // GPEC2A/TEA cipher           (ECM/PCM modern)
  GPEC2:  'gpec2',   // GPEC2 cipher                (ECM older, TCM, ADCM)
  NGC:    'ngc',     // NGC cipher                  (PCM legacy)
  TIPM:   't80',     // TIPM level-based            (TIPM)
  SGW:    'xtea_sgw',// XTEA SGW                    (SGW gateway)
  W6:     'alfa_w6', // AlfaOBD W6                  (various)
  W7:     'alfa_w7', // AlfaOBD W7                  (various)
});

// ─── Vehicle body / platform codes ───────────────────────────────────────────
// Source: 11_adcm_vehicle_codes.txt
export const VEHICLE_BODY_CODES = Object.freeze({
  WK:  { code: 0x09, name: 'Trackhawk (WK)',   platform: 'WK2 Grand Cherokee Trackhawk' },
  WD:  { code: 0x0B, name: 'Durango (WD)',     platform: 'WD Durango' },
  LD:  { code: 0x0D, name: 'Charger (LD)',     platform: 'LD Charger / Challenger' },
  LC:  { code: 0x0E, name: 'Challenger (LC)',  platform: 'LC Challenger' },
  LX:  { code: 0x10, name: 'Charger LX',       platform: 'LX Charger' },
  WK2: { code: 0x12, name: 'Grand Cherokee WK2', platform: 'WK2 Grand Cherokee' },
  DS:  { code: 0x15, name: 'Ram 1500 DS',      platform: 'DS Ram 1500' },
  DJ:  { code: 0x16, name: 'Ram 1500 DJ',      platform: 'DJ Ram 1500 Classic' },
  DT:  { code: 0x17, name: 'Ram 1500 DT',      platform: 'DT Ram 1500 (new body)' },
});

// ─── Common DID catalog ───────────────────────────────────────────────────────
// Source: 07_did_catalog.txt + lib__udsDidCatalog.generated.js
// Format: { did: 0xF190, name: '...', rw: 'R'|'RW', secLevel: null|0x01|0x03 }
export const COMMON_DIDS = Object.freeze([
  { did: 0xF190, name: 'VIN',                      rw: 'RW', secLevel: 0x01 },
  { did: 0xF10B, name: 'Part Number',               rw: 'R',  secLevel: null },
  { did: 0xF10C, name: 'Software Version',          rw: 'R',  secLevel: null },
  { did: 0xF10D, name: 'Calibration ID',            rw: 'R',  secLevel: null },
  { did: 0xF10E, name: 'Odometer (BCD, 8 bytes)',   rw: 'RW', secLevel: 0x03 },
  { did: 0xF10F, name: 'Vehicle Body Code',         rw: 'RW', secLevel: 0x03 },
  { did: 0xF110, name: 'Feature Flags (4 bytes)',   rw: 'RW', secLevel: 0x03 },
  { did: 0xF18C, name: 'ECU Serial Number',         rw: 'R',  secLevel: null },
  { did: 0xF186, name: 'Active Diagnostic Session', rw: 'R',  secLevel: null },
  { did: 0xF187, name: 'Vehicle Manufacturer ECU SW Version', rw: 'R', secLevel: null },
  { did: 0xF189, name: 'ECU Programming Date',      rw: 'R',  secLevel: null },
  { did: 0xF191, name: 'Vehicle Manufacturer ECU HW Number',  rw: 'R', secLevel: null },
  { did: 0xF192, name: 'System Supplier ECU HW Number',       rw: 'R', secLevel: null },
  { did: 0xF193, name: 'System Supplier ECU HW Version',      rw: 'R', secLevel: null },
  { did: 0xF194, name: 'System Supplier ECU SW Number',       rw: 'R', secLevel: null },
  { did: 0xF195, name: 'System Supplier ECU SW Version',      rw: 'R', secLevel: null },
  { did: 0xF197, name: 'Vehicle Name',              rw: 'R',  secLevel: null },
  { did: 0xF1A0, name: 'Boot Software Fingerprint', rw: 'R',  secLevel: null },
  { did: 0xF1A1, name: 'App Software Fingerprint',  rw: 'R',  secLevel: null },
]);

// ─── Module Registry ──────────────────────────────────────────────────────────
// Source: 06_can_ids_all_modules.txt, lib__udsProtocolsExtracted.generated.js,
//         lib__masterCipherDispatch.generated.js, lib__securityAccessSource.js
//
// Each entry:
//   code        — short module code used as key
//   name        — human-readable module name
//   tx          — tester→ECU CAN ID (11-bit)
//   rx          — ECU→tester CAN ID (11-bit)
//   platforms   — vehicle platforms this module appears on
//   sgwRequired — whether SGW bypass is needed (2018+ vehicles)
//   sessions    — supported DSC sessions: 0x01=default, 0x02=programming, 0x03=extended
//   security    — { diagnostic: level, programming: level }
//   algo        — security-access algorithm ID (from ALGO constants above)
//   dids        — module-specific DIDs beyond COMMON_DIDS
//   flash       — flash block layout (null if not flashable via bench)
//   postFlash   — ordered post-flash steps (strings)
//   notes       — known issues / quirks
export const MODULE_REGISTRY = Object.freeze({

  // ── ECM / PCM (modern GPEC2A) ──────────────────────────────────────────────
  ECM: {
    code: 'ECM',
    name: 'Engine Control Module (GPEC2A)',
    tx: 0x7E0,
    rx: 0x7E8,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.GPEC2A,
    dids: [
      { did: 0xF15A, name: 'ECM Fingerprint',       rw: 'RW', secLevel: 0x03 },
      { did: 0xF180, name: 'Boot Software ID',       rw: 'R',  secLevel: null },
      { did: 0xF181, name: 'App Software ID',        rw: 'R',  secLevel: null },
      { did: 0xF1A2, name: 'Calibration SW Fingerprint', rw: 'R', secLevel: null },
    ],
    flash: {
      startAddr: 0x00000000,
      blockCount: 3,
      blockSize: null,          // varies: LB18=3,407,872 LB19=524,288 LB20=data
      compressionByte: 0x00,
      checksumAlgo: 'CRC-16',
      eraseRoutineId: [0x31, 0x01, 0xFF, 0x00],
      blocks: [
        { id: 'LB18', addr: 0x00000000, size: 3407872, desc: 'INT FLASH (Multi-PROG target)' },
        { id: 'LB19', addr: 0x00340000, size: 524288,  desc: 'CFLASH calibration' },
        { id: 'LB20', addr: 0x003C0000, size: 262144,  desc: 'Data flash' },
      ],
    },
    postFlash: [
      'Write VIN (2E F1 90)',
      'Write fingerprint (2E F1 5A)',
      'Run CheckProgrammingDependencies (31 01 02 02)',
      'ECU Reset (11 01)',
    ],
    notes: [
      'LB18 must be written before LB19 and LB20',
      'GPEC2A requires programming-level security (27 03/04) for flash',
      'SEC6 bytes at GPEC2A-specific offsets — must resync with BCM after flash',
      'NRC 0x70 if wrong compression byte (must be 0x00)',
    ],
  },

  // ── BCM (Body Control Module) ──────────────────────────────────────────────
  BCM: {
    code: 'BCM',
    name: 'Body Control Module',
    tx: 0x744,
    rx: 0x74C,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS', 'DT', 'DJ'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.CDA6,
    dids: [
      { did: 0xF15A, name: 'BCM Fingerprint',        rw: 'RW', secLevel: 0x03 },
      { did: 0xF1A3, name: 'BCM Config Block',        rw: 'RW', secLevel: 0x03 },
      { did: 0x0101, name: 'BCM Variant Coding',      rw: 'RW', secLevel: 0x03 },
      { did: 0x0102, name: 'BCM Feature Enable',      rw: 'RW', secLevel: 0x03 },
    ],
    flash: {
      startAddr: 0x00000000,
      blockCount: 2,
      blockSize: null,
      compressionByte: 0x00,
      checksumAlgo: 'CRC-16',
      eraseRoutineId: [0x31, 0x01, 0xFF, 0x00],
      blocks: [
        { id: 'P-FLASH', addr: 0x00000000, size: 1048576, desc: 'Program flash (main code)' },
        { id: 'D-FLASH', addr: 0x00800000, size: 65536,   desc: 'Data/EEPROM flash (config + keys)' },
      ],
    },
    postFlash: [
      'Write VIN (2E F1 90)',
      'Resync SEC16 to RFHUB (BCM→RFHUB write)',
      'Resync SEC6 to PCM/ECM',
      'Run key programming sequence if keys were lost',
      'ECU Reset (11 01)',
    ],
    notes: [
      'D-FLASH (EEPROM) must be written separately from P-FLASH',
      'SEC16 at BCM offsets 0x81A0, 0xC0, 0xE0 — must resync after any flash',
      'CDA6 algorithm for both diagnostic and programming security levels',
      'NRC 0x22 if engine running or voltage < 11.5V',
    ],
  },

  // ── TCM (Transmission Control Module) ─────────────────────────────────────
  TCM: {
    code: 'TCM',
    name: 'Transmission Control Module (ZF 8HP)',
    tx: 0x7E2,
    rx: 0x7EA,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.GPEC2,
    dids: [
      { did: 0xF15A, name: 'TCM Fingerprint',        rw: 'RW', secLevel: 0x03 },
      { did: 0x0200, name: 'TCM Shift Config',        rw: 'RW', secLevel: 0x03 },
    ],
    flash: {
      startAddr: 0x00000000,
      blockCount: 2,
      blockSize: 262144,
      compressionByte: 0x00,
      checksumAlgo: 'CRC-16',
      eraseRoutineId: [0x31, 0x01, 0xFF, 0x00],
      blocks: [
        { id: 'MAIN',  addr: 0x00000000, size: 524288, desc: 'Main program flash' },
        { id: 'CALIB', addr: 0x00080000, size: 262144, desc: 'Calibration data' },
      ],
    },
    postFlash: [
      'Write VIN (2E F1 90)',
      'Run CheckProgrammingDependencies (31 01 02 02)',
      'ECU Reset (11 01)',
      'Perform transmission adaptation reset if needed',
    ],
    notes: [
      'ZF 8HP transmission — TCM is separate from ECM',
      'GPEC2 algorithm (not GPEC2A)',
    ],
  },

  // ── IPC (Instrument Panel Cluster) ────────────────────────────────────────
  // Source: 06_can_ids_all_modules.txt, 10_ipc_firmware_catalog.txt,
  //         lib__securityAccessSource.js (IPC entry), 05_seed_key_algorithms.txt
  IPC: {
    code: 'IPC',
    name: 'Instrument Panel Cluster',
    tx: 0x746,
    rx: 0x766,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF10E, name: 'Odometer (BCD, 8 bytes)',   rw: 'RW', secLevel: 0x03 },
      { did: 0xF10F, name: 'Vehicle Body Code',         rw: 'RW', secLevel: 0x03 },
      { did: 0xF110, name: 'Feature Flags',             rw: 'RW', secLevel: 0x03 },
      { did: 0xF15A, name: 'IPC Fingerprint',           rw: 'RW', secLevel: 0x03 },
    ],
    flash: {
      // Source: 10_ipc_firmware_catalog.txt
      startAddr: 0x00000000,
      blockCount: 64,
      blockSize: 0x4000,        // 16 KB per block
      compressionByte: 0x00,
      checksumAlgo: 'CRC-32',
      eraseRoutineId: [0x31, 0x01, 0x01],  // EraseAll
      // Calibration block (block 12) contains VIN and odometer
      calibBlock: { index: 12, addrRange: [0x30000, 0x33FFF] },
      // Flash offsets for preserved data
      vinOffset:      0xF190,
      odometerOffset: 0xF1E0,
      bodyCodeOffset: 0xF101,
      blocks: null,             // 64 × 0x4000 blocks starting at 0x00000000
    },
    postFlash: [
      'Write VIN (2E F1 90)',
      'Write body code (2E F1 0F) — restore or set to target platform',
      'Write odometer (2E F1 0E) — restore pre-flash value',
      'Run CheckProgrammingDependencies (31 01 02 02)',
      'ECU Reset (11 01)',
    ],
    notes: [
      'Body code DID F1 0F: 0x09=Trackhawk(WK), 0x0B=Durango(WD), 0x0D=Charger(LD)',
      'Durango→Trackhawk swap: single DID write 2E F1 0F 09 — NO full reflash needed',
      'VIN stored at flash offset 0xF190; odometer at 0xF1E0 — both in calib block 12',
      'SBEC algorithm for both diagnostic (0x01) and programming (0x03) levels',
      'Trackhawk calibration: speedometer max 260 km/h, boost gauge max 18 psi',
      'CRC-32 checksum per 16 KB block stored at end of each block',
    ],
  },

  // ── RFHUB (RF Hub / Keyless Entry) ────────────────────────────────────────
  RFHUB: {
    code: 'RFHUB',
    name: 'RF Hub (Keyless Entry Module)',
    tx: 0x75F,
    rx: 0x76C,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.CDA6,
    dids: [
      { did: 0xF190, name: 'VIN (all 4 slots)',       rw: 'RW', secLevel: 0x01 },
      { did: 0xF1A4, name: 'SEC16 Key',               rw: 'RW', secLevel: 0x03 },
      { did: 0xF1A5, name: 'Key Fob Count',           rw: 'R',  secLevel: null },
    ],
    flash: null,   // RFHUB is EEPROM-only (95640 / 93C66), not UDS-flashable
    postFlash: [
      'Write VIN to all 4 RFHUB VIN slots',
      'Write SEC16 from BCM (reverse of BCM SEC16)',
      'Verify SEC16 readback matches expected',
    ],
    notes: [
      'Gen2 RFHUB: 4 VIN slots at fixed offsets, SEC16 at 0x050E and 0x0522',
      'SEC16 must match BCM after any swap — BCM SEC16 reversed = RFHUB SEC16',
      'Virgin chip: all 0x30-fill VIN slots, blank SEC16',
      '8 KB size = Trackhawk double-dump (two 4 KB images concatenated)',
    ],
  },

  // ── SKIM (Sentry Key Immobilizer Module) ──────────────────────────────────
  SKIM: {
    code: 'SKIM',
    name: 'Sentry Key Immobilizer Module',
    tx: 0x744,
    rx: 0x74C,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',                     rw: 'RW', secLevel: 0x01 },
      { did: 0xF1B0, name: 'Transponder Key Count',   rw: 'R',  secLevel: null },
      { did: 0xF1B1, name: 'Transponder Key Table',   rw: 'R',  secLevel: 0x03 },
      { did: 0xF1B2, name: 'SKIM Secret Key',         rw: 'RW', secLevel: 0x03 },
    ],
    flash: null,   // SKIM is not bench-flashable via UDS in normal workflow
    postFlash: [],
    notes: [
      'SKIM shares CAN IDs with BCM on some platforms — use physical addressing',
      'Transponder table must be preserved across any BCM swap',
      'SBEC algorithm (same as IPC)',
      'Key programming requires SKIM secret key match with PCM',
    ],
  },

  // ── SGW (Security Gateway, 2018+) ─────────────────────────────────────────
  SGW: {
    code: 'SGW',
    name: 'Security Gateway (2018+)',
    tx: 0x74F,
    rx: 0x76F,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS', 'DT'],
    sgwRequired: false,   // SGW is the gateway itself
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: null },
    algo: ALGO.SGW,       // XTEA with key [0xBC474048, 0xA33B483A, 0x63687279, 0x73313372]
    dids: [
      { did: 0xF190, name: 'VIN',                     rw: 'R',  secLevel: null },
      { did: 0xF10B, name: 'SGW Part Number',         rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: [],
    notes: [
      'SGW XTEA key: [0xBC474048, 0xA33B483A, 0x63687279, 0x73313372]',
      'SGW bypass sequence: 10 03 → 27 01 (seed) → 27 02 (XTEA key)',
      'Required before accessing any module on 2018+ vehicles',
      'CAN IDs: TX 0x74F / RX 0x76F',
    ],
  },

  // ── ADCM (Active Damping Control Module) ──────────────────────────────────
  ADCM: {
    code: 'ADCM',
    name: 'Active Damping Control Module',
    tx: 0x7E4,
    rx: 0x7EC,
    platforms: ['WK2', 'WD'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.GPEC2,
    dids: [
      { did: 0xF190, name: 'VIN',                     rw: 'RW', secLevel: 0x01 },
      { did: 0xF10F, name: 'Vehicle Body Code',       rw: 'RW', secLevel: 0x03 },
    ],
    flash: {
      startAddr: 0x00000000,
      blockCount: 2,
      blockSize: 262144,
      compressionByte: 0x00,
      checksumAlgo: 'CRC-16',
      eraseRoutineId: [0x31, 0x01, 0xFF, 0x00],
      blocks: null,
    },
    postFlash: [
      'Write VIN (2E F1 90)',
      'Write body code (2E F1 0F)',
      'ECU Reset (11 01)',
    ],
    notes: [
      'ADCM body code must match IPC body code for correct damping profile',
      'GPEC2 algorithm (not GPEC2A)',
    ],
  },

  // ── TIPM (Totally Integrated Power Module) ────────────────────────────────
  TIPM: {
    code: 'TIPM',
    name: 'Totally Integrated Power Module',
    tx: 0x74C,
    rx: 0x76C,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.TIPM,
    dids: [
      { did: 0xF190, name: 'VIN',                     rw: 'RW', secLevel: 0x01 },
    ],
    flash: null,
    postFlash: ['Write VIN (2E F1 90)', 'ECU Reset (11 01)'],
    notes: [
      'TIPM algorithm is level-based (t80/t3605/t8101) — check SA dispatch table',
    ],
  },

  // ── ABS (Anti-lock Brake System) ──────────────────────────────────────────
  ABS: {
    code: 'ABS',
    name: 'Anti-lock Brake System Module',
    tx: 0x760,
    rx: 0x768,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.W6,
    dids: [
      { did: 0xF190, name: 'VIN',                     rw: 'RW', secLevel: 0x01 },
    ],
    flash: null,
    postFlash: ['Write VIN (2E F1 90)', 'ECU Reset (11 01)'],
    notes: [
      'ABS uses AlfaOBD W6 algorithm — (r, s) constants vary by part number',
    ],
  },

  // ── EPS (Electric Power Steering) ─────────────────────────────────────────
  EPS: {
    code: 'EPS',
    name: 'Electric Power Steering Module',
    tx: 0x75F,
    rx: 0x769,
    platforms: ['WK2', 'WD'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.W6,
    dids: [
      { did: 0xF190, name: 'VIN',                     rw: 'RW', secLevel: 0x01 },
    ],
    flash: null,
    postFlash: ['Write VIN (2E F1 90)', 'ECU Reset (11 01)'],
    notes: [],
  },

  // ── RADIO / UCONNECT ──────────────────────────────────────────────────────
  RADIO: {
    code: 'RADIO',
    name: 'Uconnect Radio / Head Unit',
    tx: 0x772,
    rx: 0x77A,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS'],
    sgwRequired: true,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.W6,
    dids: [
      { did: 0xF190, name: 'VIN',                     rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'Radio Part Number',       rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['Write VIN (2E F1 90)', 'ECU Reset (11 01)'],
    notes: [
      'Radio PIN code algorithm varies by head unit type (RAQ/REF/TM9)',
    ],
  },
});

// ─── SBEC seed-key formula ────────────────────────────────────────────────────
// Source: 05_seed_key_algorithms.txt, SBEC2/SBEC3 legacy SCI-bus protocol
// Formula: key = ((seed * 4) + 0x9018) & 0xFFFF
// Used by: IPC (both levels), SKIM (both levels), SGW diagnostic level
export function sbecKey(seed) {
  const s = (seed >>> 0) & 0xFFFF;
  return ((s * 4) + 0x9018) & 0xFFFF;
}

// ─── computeKey — dispatch to the correct algorithm ───────────────────────────
/**
 * Compute the UDS security-access key from a seed value.
 * For algorithms that require the full algos.js implementation (CDA6, GPEC2A,
 * XTEA), this function returns null and the caller must use algos.js directly.
 * SBEC is implemented inline here because it is the primary algorithm for IPC
 * and SKIM and the formula is trivial.
 *
 * @param {string} algo   — one of the ALGO constants
 * @param {number} seed   — 16-bit or 32-bit seed from the 67 XX response
 * @returns {{ key: number|null, keyBytes: number[]|null, formula: string, needsAlgosJs: boolean }}
 */
export function computeKey(algo, seed) {
  if (algo === ALGO.SBEC) {
    const key = sbecKey(seed);
    return {
      key,
      keyBytes: [(key >> 8) & 0xFF, key & 0xFF],
      formula: `(0x${seed.toString(16).toUpperCase().padStart(4,'0')} × 4) + 0x9018 = 0x${key.toString(16).toUpperCase().padStart(4,'0')}`,
      needsAlgosJs: false,
    };
  }
  // All other algorithms require algos.js (CDA6, GPEC2A, XTEA, W6, W7, etc.)
  return {
    key: null,
    keyBytes: null,
    formula: `${algo} — use algos.js computeKey(${algo}, 0x${seed.toString(16).toUpperCase()})`,
    needsAlgosJs: true,
  };
}

// ─── getModuleConfig ─────────────────────────────────────────────────────────
/**
 * Look up a module by its short code (case-insensitive).
 * Returns the module config object or null if not found.
 */
export function getModuleConfig(code) {
  if (!code) return null;
  const upper = String(code).toUpperCase();
  return MODULE_REGISTRY[upper] || null;
}

// ─── getAllModules ────────────────────────────────────────────────────────────
/** Return all module configs as an array, sorted by code. */
export function getAllModules() {
  return Object.values(MODULE_REGISTRY).sort((a, b) => a.code.localeCompare(b.code));
}

// ─── getModuleDids ───────────────────────────────────────────────────────────
/**
 * Return the merged DID list for a module: COMMON_DIDS + module-specific DIDs.
 * Module-specific entries override COMMON_DIDS entries with the same DID number.
 */
export function getModuleDids(code) {
  const mod = getModuleConfig(code);
  if (!mod) return [...COMMON_DIDS];
  const modDids = mod.dids || [];
  const modDidSet = new Set(modDids.map(d => d.did));
  const base = COMMON_DIDS.filter(d => !modDidSet.has(d.did));
  return [...base, ...modDids].sort((a, b) => a.did - b.did);
}

// ─── UDS byte sequence builders ──────────────────────────────────────────────

/** Format a number[] as "XX XX XX …" hex string for display. */
export function formatHex(bytes) {
  if (!bytes || !bytes.length) return '';
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** Parse a "XX XX XX …" hex string into a number[]. */
export function parseHexString(s) {
  if (!s) return [];
  return s.trim().split(/\s+/).map(h => parseInt(h, 16)).filter(n => !isNaN(n));
}

/** Build a 0x22 ReadDataByIdentifier request for a single DID. */
export function buildReadDid(did) {
  return [0x22, (did >> 8) & 0xFF, did & 0xFF];
}

/** Build a 0x2E WriteDataByIdentifier request for a DID + data bytes. */
export function buildWriteDid(did, dataBytes) {
  return [0x2E, (did >> 8) & 0xFF, did & 0xFF, ...dataBytes];
}

/** Build a 0x10 DiagnosticSessionControl request. */
export function buildDsc(session) {
  return [0x10, session & 0xFF];
}

/** Build a 0x27 SecurityAccess seed request (odd level). */
export function buildSeedRequest(level) {
  return [0x27, level & 0xFF];
}

/** Build a 0x27 SecurityAccess key send (even level = seed level + 1). */
export function buildKeySend(level, keyBytes) {
  return [0x27, (level + 1) & 0xFF, ...keyBytes];
}

/** Build a 0x3E TesterPresent request. */
export function buildTesterPresent() {
  return [0x3E, 0x00];
}

/** Build a 0x11 ECUReset request (0x01 = hard reset). */
export function buildEcuReset(resetType = 0x01) {
  return [0x11, resetType & 0xFF];
}

/** Build a 0x31 RoutineControl Start request. */
export function buildRoutineStart(routineId, params = []) {
  const hi = (routineId >> 8) & 0xFF;
  const lo = routineId & 0xFF;
  return [0x31, 0x01, hi, lo, ...params];
}

// ─── buildSessionSequence ────────────────────────────────────────────────────
/**
 * Build the ordered UDS byte sequences for a given module operation.
 *
 * @param {string} moduleCode   — e.g. 'IPC', 'ECM', 'BCM'
 * @param {'diagnostic'|'programming'|'extended'} operation
 * @param {{ sgwBypass?: boolean }} opts
 * @returns {Array<{ step: number, name: string, bytes: number[], description: string }>}
 */
export function buildSessionSequence(moduleCode, operation = 'extended', opts = {}) {
  const mod = getModuleConfig(moduleCode);
  if (!mod) throw new Error(`udsEngine: unknown module code "${moduleCode}"`);

  const steps = [];
  let stepNum = 1;

  // Step 1: SGW bypass (if required and not disabled by caller)
  const needsSgw = mod.sgwRequired && opts.sgwBypass !== false;
  if (needsSgw) {
    steps.push({
      step: stepNum++,
      name: 'SGW Extended Session',
      bytes: buildDsc(0x03),
      description: 'Open extended diagnostic session on SGW (TX 0x74F / RX 0x76F)',
      canTx: 0x74F, canRx: 0x76F,
    });
    steps.push({
      step: stepNum++,
      name: 'SGW Seed Request',
      bytes: buildSeedRequest(0x01),
      description: 'Request SGW security seed (level 0x01) — response: 67 01 SS SS SS SS',
      canTx: 0x74F, canRx: 0x76F,
    });
    steps.push({
      step: stepNum++,
      name: 'SGW Key Send',
      bytes: buildKeySend(0x01, [0x00, 0x00, 0x00, 0x00]),  // placeholder — XTEA computed at runtime from seed
      description: 'Send SGW XTEA key (computed from seed via xtea_sgw() in algos.js)',
      canTx: 0x74F, canRx: 0x76F,
      note: 'Key = xtea_sgw(seed) — 4 bytes from high word of XTEA block cipher',
    });
  }

  // Step 2: Open target module session
  const sessionByte = operation === 'programming' ? 0x02
    : operation === 'extended' ? 0x03
    : 0x01;
  steps.push({
    step: stepNum++,
    name: `${mod.name} ${operation.charAt(0).toUpperCase() + operation.slice(1)} Session`,
    bytes: buildDsc(sessionByte),
    description: `Open ${operation} session on ${mod.name} (TX 0x${mod.tx.toString(16).toUpperCase()} / RX 0x${mod.rx.toString(16).toUpperCase()})`,
    canTx: mod.tx, canRx: mod.rx,
  });

  // Step 3: Security access (if not default session)
  if (operation !== 'diagnostic') {
    const secLevel = operation === 'programming'
      ? mod.security.programming
      : mod.security.diagnostic;
    if (secLevel != null) {
      steps.push({
        step: stepNum++,
        name: `${mod.name} Seed Request (level 0x${secLevel.toString(16).padStart(2,'0')})`,
        bytes: buildSeedRequest(secLevel),
        description: `Request security seed at level 0x${secLevel.toString(16).padStart(2,'0')} — response: 67 ${secLevel.toString(16).padStart(2,'0').toUpperCase()} SS SS [SS SS]`,
        canTx: mod.tx, canRx: mod.rx,
      });
      steps.push({
        step: stepNum++,
        name: `${mod.name} Key Send (level 0x${(secLevel+1).toString(16).padStart(2,'0')})`,
        bytes: buildKeySend(secLevel, [0x00, 0x00]),  // placeholder — computed at runtime from seed
        description: `Send computed key using ${mod.algo} algorithm`,
        canTx: mod.tx, canRx: mod.rx,
        note: `Algorithm: ${mod.algo} — use computeKey('${mod.algo}', seed) or algos.js`,
      });
    }
  }

  return steps;
}

// ─── buildIpcBodyCodeSwap ─────────────────────────────────────────────────────
/**
 * Build the complete Durango→Trackhawk IPC body code swap sequence.
 * This is the primary use case for the IpcClusterReprogramTab.
 *
 * The swap is a SINGLE DID write (2E F1 0F 09) after programming-level
 * security unlock — NO full reflash is needed.
 *
 * Source: RE analysis report section 3.1, confirmed from 11_adcm_vehicle_codes.txt
 *
 * @param {number} targetBodyCode   — e.g. VEHICLE_BODY_CODES.WK.code (0x09)
 * @returns {Array<{ step: number, name: string, bytes: number[], description: string }>}
 */
export function buildIpcBodyCodeSwap(targetBodyCode = 0x09) {
  const steps = [];
  let s = 1;

  // Step 1: SGW extended session
  steps.push({
    step: s++,
    name: 'SGW Extended Session',
    bytes: [0x10, 0x03],
    description: 'Open extended diagnostic session on SGW (TX 0x74F / RX 0x76F)',
    canTx: 0x74F, canRx: 0x76F,
    phase: 'sgw',
  });

  // Step 2: SGW seed request
  steps.push({
    step: s++,
    name: 'SGW Seed Request',
    bytes: [0x27, 0x01],
    description: 'Request SGW security seed — response: 67 01 SS SS SS SS',
    canTx: 0x74F, canRx: 0x76F,
    phase: 'sgw',
  });

  // Step 3: SGW key send (XTEA computed at runtime)
  steps.push({
    step: s++,
    name: 'SGW Key Send',
    bytes: [0x27, 0x02, 0x00, 0x00, 0x00, 0x00],  // XTEA key placeholder
    description: 'Send SGW XTEA key: xtea_sgw(seed) → 4 bytes',
    canTx: 0x74F, canRx: 0x76F,
    phase: 'sgw',
    note: 'Key = xtea_sgw(seed) from algos.js — high word of XTEA encrypt block',
  });

  // Step 4: IPC extended session
  steps.push({
    step: s++,
    name: 'IPC Extended Session',
    bytes: [0x10, 0x03],
    description: 'Open extended diagnostic session on IPC (TX 0x746 / RX 0x766)',
    canTx: 0x746, canRx: 0x766,
    phase: 'ipc_session',
  });

  // Step 5: IPC programming seed request (level 0x03)
  steps.push({
    step: s++,
    name: 'IPC Programming Seed Request',
    bytes: [0x27, 0x03],
    description: 'Request IPC programming security seed — response: 67 03 SS SS',
    canTx: 0x746, canRx: 0x766,
    phase: 'ipc_security',
  });

  // Step 6: IPC programming key send (level 0x04)
  steps.push({
    step: s++,
    name: 'IPC Programming Key Send',
    bytes: [0x27, 0x04, 0x00, 0x00],  // SBEC key placeholder
    description: 'Send IPC SBEC key: key = (seed × 4) + 0x9018 → 2 bytes',
    canTx: 0x746, canRx: 0x766,
    phase: 'ipc_security',
    note: 'SBEC formula: key = ((seed * 4) + 0x9018) & 0xFFFF',
  });

  // Step 7: Read current body code
  steps.push({
    step: s++,
    name: 'Read Current Body Code',
    bytes: [0x22, 0xF1, 0x0F],
    description: 'Read current vehicle body code DID F1 0F — response: 62 F1 0F XX',
    canTx: 0x746, canRx: 0x766,
    phase: 'read',
  });

  // Step 8: Read VIN (preserve before any write)
  steps.push({
    step: s++,
    name: 'Read VIN',
    bytes: [0x22, 0xF1, 0x90],
    description: 'Read VIN DID F1 90 — response: 62 F1 90 [17 bytes ASCII]',
    canTx: 0x746, canRx: 0x766,
    phase: 'read',
  });

  // Step 9: Read odometer (preserve before any write)
  steps.push({
    step: s++,
    name: 'Read Odometer',
    bytes: [0x22, 0xF1, 0x0E],
    description: 'Read odometer DID F1 0E — response: 62 F1 0E [8 bytes BCD]',
    canTx: 0x746, canRx: 0x766,
    phase: 'read',
  });

  // Step 10: Write target body code (THE KEY STEP)
  steps.push({
    step: s++,
    name: 'Write Body Code',
    bytes: [0x2E, 0xF1, 0x0F, targetBodyCode & 0xFF],
    description: `Write body code 0x${(targetBodyCode & 0xFF).toString(16).toUpperCase().padStart(2,'0')} to DID F1 0F — response: 6E F1 0F`,
    canTx: 0x746, canRx: 0x766,
    phase: 'write',
    critical: true,
    note: `0x09=Trackhawk(WK), 0x0B=Durango(WD), 0x0D=Charger(LD)`,
  });

  // Step 11: ECU reset
  steps.push({
    step: s++,
    name: 'ECU Reset',
    bytes: [0x11, 0x01],
    description: 'Hard reset IPC — response: 51 01 (then module reboots)',
    canTx: 0x746, canRx: 0x766,
    phase: 'reset',
  });

  // Step 12: Restore VIN (after reset, re-open session + security)
  steps.push({
    step: s++,
    name: 'Restore VIN (post-reset)',
    bytes: [0x2E, 0xF1, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // VIN bytes placeholder
    description: 'Write VIN back to DID F1 90 (17 bytes ASCII) — response: 6E F1 90',
    canTx: 0x746, canRx: 0x766,
    phase: 'post_reset',
    note: 'Must re-open extended session and re-unlock security before writing',
  });

  // Step 13: Restore odometer (after reset)
  steps.push({
    step: s++,
    name: 'Restore Odometer (post-reset)',
    bytes: [0x2E, 0xF1, 0x0E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // odometer bytes placeholder
    description: 'Write odometer back to DID F1 0E (8 bytes BCD) — response: 6E F1 0E',
    canTx: 0x746, canRx: 0x766,
    phase: 'post_reset',
    note: 'Requires programming-level security (27 03/04) before writing',
  });

  return steps;
}

// ─── buildFlashSequence ───────────────────────────────────────────────────────
/**
 * Build the flash programming byte sequences for a module.
 * Returns the ordered steps for the full flash state machine.
 *
 * @param {string} moduleCode
 * @param {Array<{ id: string, addr: number, size: number, data?: Uint8Array }>} blocks
 * @returns {Array<{ step: number, name: string, bytes: number[], description: string }>}
 */
export function buildFlashSequence(moduleCode, blocks = []) {
  const mod = getModuleConfig(moduleCode);
  if (!mod) throw new Error(`udsEngine: unknown module code "${moduleCode}"`);
  if (!mod.flash) throw new Error(`udsEngine: module ${moduleCode} has no flash layout`);

  const steps = [];
  let s = 1;

  // 1. Enter programming session
  steps.push({
    step: s++, name: 'Enter Programming Session',
    bytes: [0x10, 0x02],
    description: 'Switch to programming session (10 02)',
    canTx: mod.tx, canRx: mod.rx,
  });

  // 2. Programming security seed
  const progLevel = mod.security.programming || 0x03;
  steps.push({
    step: s++, name: `Security Seed (level 0x${progLevel.toString(16).padStart(2,'0')})`,
    bytes: [0x27, progLevel & 0xFF],
    description: `Request programming seed — response: 67 ${progLevel.toString(16).padStart(2,'0').toUpperCase()} SS SS [SS SS]`,
    canTx: mod.tx, canRx: mod.rx,
  });

  // 3. Programming security key
  steps.push({
    step: s++, name: `Security Key (level 0x${(progLevel+1).toString(16).padStart(2,'0')})`,
    bytes: [0x27, (progLevel + 1) & 0xFF, 0x00, 0x00],  // key placeholder
    description: `Send computed key using ${mod.algo} algorithm`,
    canTx: mod.tx, canRx: mod.rx,
    note: `Algorithm: ${mod.algo}`,
  });

  // 4. Erase memory
  const eraseId = mod.flash.eraseRoutineId || [0x31, 0x01, 0xFF, 0x00];
  steps.push({
    step: s++, name: 'Erase Memory',
    bytes: eraseId,
    description: `RoutineControl: erase flash (${formatHex(eraseId)})`,
    canTx: mod.tx, canRx: mod.rx,
  });

  // 5-7. For each block: RequestDownload → TransferData → RequestTransferExit
  const flashBlocks = blocks.length > 0 ? blocks : (mod.flash.blocks || []);
  for (const block of flashBlocks) {
    const addrBytes = [
      (block.addr >>> 24) & 0xFF,
      (block.addr >>> 16) & 0xFF,
      (block.addr >>> 8) & 0xFF,
      block.addr & 0xFF,
    ];
    const sizeBytes = [
      (block.size >>> 24) & 0xFF,
      (block.size >>> 16) & 0xFF,
      (block.size >>> 8) & 0xFF,
      block.size & 0xFF,
    ];

    steps.push({
      step: s++, name: `RequestDownload — ${block.id}`,
      bytes: [0x34, mod.flash.compressionByte || 0x00, 0x44, ...addrBytes, ...sizeBytes],
      description: `Request download for block ${block.id} @ 0x${block.addr.toString(16).toUpperCase()} (${block.size} bytes)`,
      canTx: mod.tx, canRx: mod.rx,
    });

    steps.push({
      step: s++, name: `TransferData — ${block.id}`,
      bytes: [0x36, 0x01, 0x00, 0x00, 0x00, 0x00],  // block seq 0x01, data placeholder
      description: `Transfer data blocks for ${block.id} (repeated with incrementing block counter)`,
      canTx: mod.tx, canRx: mod.rx,
      note: `Max block size: ${mod.flash.blockSize || 'per ECU response'}`,
    });

    steps.push({
      step: s++, name: `RequestTransferExit — ${block.id}`,
      bytes: [0x37],
      description: `Signal end of transfer for block ${block.id}`,
      canTx: mod.tx, canRx: mod.rx,
    });
  }

  // 8. CheckProgrammingDependencies
  steps.push({
    step: s++, name: 'CheckProgrammingDependencies',
    bytes: [0x31, 0x01, 0x02, 0x02],
    description: 'Verify programming dependencies (checksum validation)',
    canTx: mod.tx, canRx: mod.rx,
  });

  // 9. ECU Reset
  steps.push({
    step: s++, name: 'ECU Reset',
    bytes: [0x11, 0x01],
    description: 'Hard reset ECU — module reboots and applies new firmware',
    canTx: mod.tx, canRx: mod.rx,
  });

  return steps;
}

// ─── NRC decoder ─────────────────────────────────────────────────────────────
// Source: ISO 14229, witech_uds_map.json
export const NRC_TABLE = Object.freeze({
  0x10: { name: 'generalReject',                    desc: 'General reject — request not supported' },
  0x11: { name: 'serviceNotSupported',              desc: 'Service not supported by this module' },
  0x12: { name: 'subFunctionNotSupported',          desc: 'Sub-function not supported' },
  0x13: { name: 'incorrectMessageLengthOrFormat',   desc: 'Wrong message length or format' },
  0x14: { name: 'responseTooLong',                  desc: 'Response too long for transport layer' },
  0x21: { name: 'busyRepeatRequest',                desc: 'Module busy — retry after delay' },
  0x22: { name: 'conditionsNotCorrect',             desc: 'Conditions not correct: engine running, voltage out of range, or wrong session' },
  0x24: { name: 'requestSequenceError',             desc: 'Request sequence error — wrong order of services' },
  0x25: { name: 'noResponseFromSubnetComponent',    desc: 'No response from subnet component' },
  0x26: { name: 'failurePreventsExecutionOfRequestedAction', desc: 'Failure prevents execution' },
  0x31: { name: 'requestOutOfRange',                desc: 'Request out of range: wrong address, wrong block size, or unsupported DID' },
  0x33: { name: 'securityAccessDenied',             desc: 'Security access denied: wrong key or too many failed attempts' },
  0x35: { name: 'invalidKey',                       desc: 'Invalid key — computed key does not match ECU expectation' },
  0x36: { name: 'exceededNumberOfAttempts',         desc: 'Exceeded number of attempts — module locked for 5 minutes' },
  0x37: { name: 'requiredTimeDelayNotExpired',      desc: 'Required time delay not expired — wait before retrying' },
  0x70: { name: 'uploadDownloadNotAccepted',        desc: 'Upload/download not accepted: wrong compression byte or wrong address' },
  0x71: { name: 'transferDataSuspended',            desc: 'Transfer data suspended' },
  0x72: { name: 'generalProgrammingFailure',        desc: 'General programming failure — flash write error' },
  0x73: { name: 'wrongBlockSequenceCounter',        desc: 'Wrong block sequence counter in TransferData' },
  0x78: { name: 'requestCorrectlyReceivedResponsePending', desc: 'Response pending (0x78) — ECU is processing, wait for final response' },
  0x7E: { name: 'subFunctionNotSupportedInActiveSession', desc: 'Sub-function not supported in active session' },
  0x7F: { name: 'serviceNotSupportedInActiveSession', desc: 'Service not supported in active session' },
});

/** Decode a negative response code to a human-readable description. */
export function decodeNrc(nrc) {
  const entry = NRC_TABLE[nrc & 0xFF];
  if (!entry) return { name: 'unknown', desc: `Unknown NRC 0x${nrc.toString(16).toUpperCase().padStart(2,'0')}` };
  return entry;
}

// ─── Tester Present interval ─────────────────────────────────────────────────
// Source: witech_uds_map.json testerPresentIntervalMs per module
// Default: 1000ms (1s). Some modules allow 2000ms.
export const TESTER_PRESENT_INTERVAL_MS = 1000;

// ─── Voltage requirements ─────────────────────────────────────────────────────
export const VOLTAGE_REQUIREMENTS = Object.freeze({
  min: 11.5,
  max: 14.5,
  unit: 'V',
  note: 'Battery voltage must be in range during all programming operations',
});

// ─── CAN bus parameters ───────────────────────────────────────────────────────
export const CAN_PARAMS = Object.freeze({
  speed: 500,         // kbps
  speedUnit: 'kbps',
  addressing: 'normal-11bit',
  isotpMode: 'physical',
  note: '500 kbps, normal 11-bit CAN addressing, physical ISO-TP',
});
