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
      'CB manual p.20: GPEC 2A FCA variant uses SA 0x63/0x64 (not 0x03/0x04)',
      'GPEC 2A full session: 1A 87 → 10 92 → 10 85 → 27 63 (seed) → 27 64 + key → 21 A9 + 21 AA (read EEPROM 4KB)',
      'GPEC 2A key algo: key = M-seed XOR C, C=0x47EC21F8 (35/35 in-sample verified)',
      'GPEC 3 key algo: key = M-seed XOR C, C=0x129D657F (44/44 LOO verified)',
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

  // ── ORC / AIRBAG ────────────────────────────────────────────────────────────
  ORC: {
    code: 'ORC',
    name: 'Occupant Restraint Controller',
    tx: 0x747,
    rx: 0x767,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS', 'DJ', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'ORC Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['Write VIN (2E F1 90)', 'ECU Reset (11 01)'],
    notes: [
      'CRITICAL: Airbag module — do NOT write unless you know what you are doing',
      'Requires ignition ON, all airbag connectors seated',
    ],
  },

  // ── CCM / CLIMATE ─────────────────────────────────────────────────────────
  CCM: {
    code: 'CCM',
    name: 'Climate Control Module',
    tx: 0x743,
    rx: 0x763,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'CCM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['HVAC/climate head unit — dual-zone or single-zone depending on build'],
  },

  // ── ADM / ACTIVE DAMPENING ────────────────────────────────────────────────
  ADM: {
    code: 'ADM',
    name: 'Active Dampening Module',
    tx: 0x744,
    rx: 0x764,
    platforms: ['WK2', 'WD'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'ADM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Active suspension dampening — Quadra-Lift / Bilstein DampTronic'],
  },

  // ── SDM / SUSPENSION DAMPENING ────────────────────────────────────────────
  SDM: {
    code: 'SDM',
    name: 'Suspension Dampening Module',
    tx: 0x745,
    rx: 0x765,
    platforms: ['WK2', 'WD'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'SDM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Passive/semi-active suspension — variant of ADM on some platforms'],
  },

  // ── CGW / CENTRAL GATEWAY ─────────────────────────────────────────────────
  CGW: {
    code: 'CGW',
    name: 'Central Gateway Module',
    tx: 0x748,
    rx: 0x768,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS', 'DT'],
    sgwRequired: false,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'CGW Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Central gateway — distinct from SGW (0x7A0). Handles CAN bus routing.'],
  },

  // ── DDM / DRIVER DOOR ─────────────────────────────────────────────────────
  DDM: {
    code: 'DDM',
    name: 'Driver Door Module',
    tx: 0x749,
    rx: 0x769,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'DDM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Note: Some DDM/PDM variants use KWP2000 (legacy) — verify protocol before connecting'],
  },

  // ── PDM / PASSENGER DOOR ──────────────────────────────────────────────────
  PDM: {
    code: 'PDM',
    name: 'Passenger Door Module',
    tx: 0x74A,
    rx: 0x76A,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'PDM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Note: Some DDM/PDM variants use KWP2000 (legacy) — verify protocol before connecting'],
  },

  // ── PLGM / POWER LIFTGATE ─────────────────────────────────────────────────
  PLGM: {
    code: 'PLGM',
    name: 'Power Liftgate Module',
    tx: 0x74B,
    rx: 0x76B,
    platforms: ['WK2', 'WD'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'PLGM Part Number', rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Power liftgate — requires liftgate closed and unobstructed during programming'],
  },

  // ── MSM / MEMORY SEAT ─────────────────────────────────────────────────────
  MSM: {
    code: 'MSM',
    name: 'Memory Seat Module',
    tx: 0x74C,
    rx: 0x76C,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'MSM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Memory seat/mirror module — stores up to 3 seat position profiles'],
  },

  // ── SCCM / STEERING COLUMN ────────────────────────────────────────────────
  SCCM: {
    code: 'SCCM',
    name: 'Steering Column Control Module',
    tx: 0x74D,
    rx: 0x76D,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',               rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'SCCM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Steering column — cruise control, wiper stalk, turn signal stalk'],
  },

  // ── PAM / PARK ASSIST ─────────────────────────────────────────────────────
  PAM: {
    code: 'PAM',
    name: 'Park Assist Module',
    tx: 0x74E,
    rx: 0x76E,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'PAM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Park assist — front/rear ultrasonic sensors + camera'],
  },

  // ── FCM / FORWARD COLLISION ───────────────────────────────────────────────
  FCM: {
    code: 'FCM',
    name: 'Forward Collision Module',
    tx: 0x74F,
    rx: 0x76F,
    platforms: ['WK2', 'WD', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'FCM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Forward collision warning / autonomous emergency braking radar'],
  },

  // ── BSM / BLIND SPOT ──────────────────────────────────────────────────────
  BSM: {
    code: 'BSM',
    name: 'Blind Spot Module',
    tx: 0x750,
    rx: 0x770,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'BSM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Blind spot detection — rear corner radar modules'],
  },

  // ── ACM / ACTIVE CRUISE ───────────────────────────────────────────────────
  ACM: {
    code: 'ACM',
    name: 'Active Cruise Module',
    tx: 0x751,
    rx: 0x771,
    platforms: ['WK2', 'WD', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'ACM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Adaptive cruise control — front radar + throttle/brake integration'],
  },

  // ── LDW / LANE DEPARTURE ──────────────────────────────────────────────────
  LDW: {
    code: 'LDW',
    name: 'Lane Departure Warning',
    tx: 0x752,
    rx: 0x772,
    platforms: ['WK2', 'WD', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'LDW Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Lane departure warning / lane keep assist — front camera module'],
  },

  // ── APIM / ACCESSORY PROTOCOL INTERFACE ───────────────────────────────────
  APIM: {
    code: 'APIM',
    name: 'Accessory Protocol Interface Module',
    tx: 0x753,
    rx: 0x773,
    platforms: ['WK2', 'WD', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',               rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'APIM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['SYNC/Uconnect accessory interface — USB hub, Bluetooth, phone integration'],
  },

  // ── VGM / VIDEO GRAPHICS ──────────────────────────────────────────────────
  VGM: {
    code: 'VGM',
    name: 'Video Graphics Module',
    tx: 0x754,
    rx: 0x774,
    platforms: ['WK2', 'WD'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'VGM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Video graphics — backup camera display, 360-view camera processing'],
  },

  // ── RFH / RADIO FREQUENCY HUB ─────────────────────────────────────────────
  RFH: {
    code: 'RFH',
    name: 'Radio Frequency Hub',
    tx: 0x755,
    rx: 0x775,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'RFH Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['RF hub (alternate address) — distinct from RFHUB at 0x742. Verify address before use.'],
  },

  // ── AMP / AMPLIFIER ───────────────────────────────────────────────────────
  AMP: {
    code: 'AMP',
    name: 'Amplifier Module',
    tx: 0x756,
    rx: 0x776,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'AMP Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Audio amplifier — Harman/Beats/Alpine depending on trim level'],
  },

  // ── RSM / RAIN SENSE ──────────────────────────────────────────────────────
  RSM: {
    code: 'RSM',
    name: 'Rain Sense Module',
    tx: 0x757,
    rx: 0x777,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'RSM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Rain-sensing windshield wiper module — optical sensor on windshield'],
  },

  // ── HSM / HEATED SEAT ─────────────────────────────────────────────────────
  HSM: {
    code: 'HSM',
    name: 'Heated Seat Module',
    tx: 0x758,
    rx: 0x778,
    platforms: ['WK2', 'WD', 'LD', 'LC'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'HSM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Heated/ventilated seat module — controls seat heater elements and fans'],
  },

  // ── WCM / WIRELESS CONTROL ────────────────────────────────────────────────
  WCM: {
    code: 'WCM',
    name: 'Wireless Control Module',
    tx: 0x759,
    rx: 0x779,
    platforms: ['WK2', 'WD', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'WCM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Wireless control — UConnect WiFi hotspot, Bluetooth stack, cellular modem'],
  },

  // ── SKREEM / SECURE KEY REMOTE ENTRY ──────────────────────────────────────
  SKREEM: {
    code: 'SKREEM',
    name: 'Secure Key Remote Entry Module',
    tx: 0x75A,
    rx: 0x77A,
    platforms: ['WK2', 'WD', 'LD', 'LC', 'DS'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',                rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'SKREEM Part Number', rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['Write VIN (2E F1 90)', 'Program FOBIKs (31 01 02 05)', 'ECU Reset (11 01)'],
    notes: [
      'SKREEM = Sentry Key Remote Entry Module — immobilizer + key fob programming',
      'Must program all keys/FOBIKs after replacement (routine 0x0205)',
      'Distinct from RFHUB (0x742) — SKREEM is the immobilizer, RFHUB is the RF transceiver',
    ],
  },

  // ── TCCM / TRANSFER CASE ──────────────────────────────────────────────────
  TCCM: {
    code: 'TCCM',
    name: 'Transfer Case Control Module',
    tx: 0x75B,
    rx: 0x77B,
    platforms: ['WK2', 'WD', 'DS', 'DT'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',               rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'TCCM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Transfer case — 4WD/AWD mode selection, Quadra-Trac/Quadra-Drive'],
  },

  // ── FDCM / FINAL DRIVE ────────────────────────────────────────────────────
  FDCM: {
    code: 'FDCM',
    name: 'Final Drive Control Module',
    tx: 0x75C,
    rx: 0x77C,
    platforms: ['WK2', 'WD'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',               rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'FDCM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Final drive / rear differential control — electronic limited-slip diff'],
  },

  // ── EAS / ELECTRONIC AIR SUSPENSION ──────────────────────────────────────
  EAS: {
    code: 'EAS',
    name: 'Electronic Air Suspension',
    tx: 0x75D,
    rx: 0x77D,
    platforms: ['WK2', 'WD'],
    sgwRequired: true,
    sessions: [0x01, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',              rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'EAS Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Electronic air suspension — Quadra-Lift ride height control'],
  },

  // ── DTCM / DRIVE TRAIN CONTROL ────────────────────────────────────────────
  DTCM: {
    code: 'DTCM',
    name: 'Drive Train Control Module',
    tx: 0x7E2,
    rx: 0x7EA,
    platforms: ['WK2', 'WD', 'DS', 'DT'],
    sgwRequired: false,
    sessions: [0x01, 0x02, 0x03],
    security: { diagnostic: 0x01, programming: 0x03 },
    algo: ALGO.SBEC,
    dids: [
      { did: 0xF190, name: 'VIN',               rw: 'RW', secLevel: 0x01 },
      { did: 0xF10B, name: 'DTCM Part Number',  rw: 'R',  secLevel: null },
    ],
    flash: null,
    postFlash: ['ECU Reset (11 01)'],
    notes: ['Drive train control — AWD torque split, axle disconnect, traction control'],
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
// Source: ISO 14229-1:2020, workspace-uds/nrc.ts — full 132-entry table
// Covers all defined NRC codes from 0x10 through 0x93 including ISO-SAE
// reserved ranges and vehicle-condition codes (0x81–0x93).
export const NRC_TABLE = Object.freeze({
  0x10: { name: 'GR', desc: 'General reject — the ECU cannot process this request' },
  0x11: { name: 'SNS', desc: 'Service not supported in the current session' },
  0x12: { name: 'SFNS', desc: 'Sub-function not supported' },
  0x13: { name: 'IMLOIF', desc: 'Incorrect message length or invalid format' },
  0x14: { name: 'RTL', desc: 'Response too long — ECU cannot fit response in available buffer' },
  0x15: { name: 'ISOSAERESERVED15', desc: 'ISO-SAE reserved (0x15)' },
  0x16: { name: 'ISOSAERESERVED16', desc: 'ISO-SAE reserved (0x16)' },
  0x17: { name: 'ISOSAERESERVED17', desc: 'ISO-SAE reserved (0x17)' },
  0x18: { name: 'ISOSAERESERVED18', desc: 'ISO-SAE reserved (0x18)' },
  0x19: { name: 'ISOSAERESERVED19', desc: 'ISO-SAE reserved (0x19)' },
  0x1A: { name: 'ISOSAERESERVED1A', desc: 'ISO-SAE reserved (0x1A)' },
  0x1B: { name: 'ISOSAERESERVED1B', desc: 'ISO-SAE reserved (0x1B)' },
  0x1C: { name: 'ISOSAERESERVED1C', desc: 'ISO-SAE reserved (0x1C)' },
  0x1D: { name: 'ISOSAERESERVED1D', desc: 'ISO-SAE reserved (0x1D)' },
  0x1E: { name: 'ISOSAERESERVED1E', desc: 'ISO-SAE reserved (0x1E)' },
  0x1F: { name: 'ISOSAERESERVED1F', desc: 'ISO-SAE reserved (0x1F)' },
  0x20: { name: 'ISOSAERESERVED20', desc: 'ISO-SAE reserved (0x20)' },
  0x21: { name: 'BRR', desc: 'Busy repeat request — ECU is temporarily busy, retry shortly' },
  0x22: { name: 'CNC', desc: 'Conditions not correct — preconditions (session, lock state, etc.) not met' },
  0x23: { name: 'ISOSAERESERVED23', desc: 'ISO-SAE reserved (0x23)' },
  0x24: { name: 'RSE', desc: 'Request sequence error — service called out of order' },
  0x25: { name: 'NRFSC', desc: 'No response from sub-net component' },
  0x26: { name: 'FPEORA', desc: 'Failure prevents execution of requested action' },
  0x27: { name: 'ISOSAERESERVED27', desc: 'ISO-SAE reserved (0x27)' },
  0x28: { name: 'ISOSAERESERVED28', desc: 'ISO-SAE reserved (0x28)' },
  0x29: { name: 'ISOSAERESERVED29', desc: 'ISO-SAE reserved (0x29)' },
  0x2A: { name: 'ISOSAERESERVED2A', desc: 'ISO-SAE reserved (0x2A)' },
  0x2B: { name: 'ISOSAERESERVED2B', desc: 'ISO-SAE reserved (0x2B)' },
  0x2C: { name: 'ISOSAERESERVED2C', desc: 'ISO-SAE reserved (0x2C)' },
  0x2D: { name: 'ISOSAERESERVED2D', desc: 'ISO-SAE reserved (0x2D)' },
  0x2E: { name: 'ISOSAERESERVED2E', desc: 'ISO-SAE reserved (0x2E)' },
  0x2F: { name: 'ISOSAERESERVED2F', desc: 'ISO-SAE reserved (0x2F)' },
  0x30: { name: 'ISOSAERESERVED30', desc: 'ISO-SAE reserved (0x30)' },
  0x31: { name: 'ROOR', desc: 'Request out of range — DID or parameter value not supported' },
  0x32: { name: 'ISOSAERESERVED32', desc: 'ISO-SAE reserved (0x32)' },
  0x33: { name: 'SAD', desc: 'Security access denied — security level not unlocked' },
  0x34: { name: 'AR', desc: 'Authentication required (UDS 0x29) — module requires certificate-based auth' },
  0x35: { name: 'IK', desc: 'Invalid key — seed/key challenge failed' },
  0x36: { name: 'ENOA', desc: 'Exceeded number of attempts — security lockout active' },
  0x37: { name: 'RTDNE', desc: 'Required time delay not expired — must wait before retry' },
  0x38: { name: 'RBEDNE38', desc: 'Reserved by extended data link security document (0x38)' },
  0x39: { name: 'RBEDNE39', desc: 'Reserved by extended data link security document (0x39)' },
  0x3A: { name: 'RBEDNE3A', desc: 'Reserved by extended data link security document (0x3A)' },
  0x3B: { name: 'RBEDNE3B', desc: 'Reserved by extended data link security document (0x3B)' },
  0x3C: { name: 'RBEDNE3C', desc: 'Reserved by extended data link security document (0x3C)' },
  0x3D: { name: 'RBEDNE3D', desc: 'Reserved by extended data link security document (0x3D)' },
  0x3E: { name: 'RBEDNE3E', desc: 'Reserved by extended data link security document (0x3E)' },
  0x3F: { name: 'RBEDNE3F', desc: 'Reserved by extended data link security document (0x3F)' },
  0x40: { name: 'RBEDNE40', desc: 'Reserved by extended data link security document (0x40)' },
  0x41: { name: 'RBEDNE41', desc: 'Reserved by extended data link security document (0x41)' },
  0x42: { name: 'RBEDNE42', desc: 'Reserved by extended data link security document (0x42)' },
  0x43: { name: 'RBEDNE43', desc: 'Reserved by extended data link security document (0x43)' },
  0x44: { name: 'RBEDNE44', desc: 'Reserved by extended data link security document (0x44)' },
  0x45: { name: 'RBEDNE45', desc: 'Reserved by extended data link security document (0x45)' },
  0x46: { name: 'RBEDNE46', desc: 'Reserved by extended data link security document (0x46)' },
  0x47: { name: 'RBEDNE47', desc: 'Reserved by extended data link security document (0x47)' },
  0x48: { name: 'RBEDNE48', desc: 'Reserved by extended data link security document (0x48)' },
  0x49: { name: 'RBEDNE49', desc: 'Reserved by extended data link security document (0x49)' },
  0x4A: { name: 'RBEDNE4A', desc: 'Reserved by extended data link security document (0x4A)' },
  0x4B: { name: 'RBEDNE4B', desc: 'Reserved by extended data link security document (0x4B)' },
  0x4C: { name: 'RBEDNE4C', desc: 'Reserved by extended data link security document (0x4C)' },
  0x4D: { name: 'RBEDNE4D', desc: 'Reserved by extended data link security document (0x4D)' },
  0x4E: { name: 'RBEDNE4E', desc: 'Reserved by extended data link security document (0x4E)' },
  0x4F: { name: 'RBEDNE4F', desc: 'Reserved by extended data link security document (0x4F)' },
  0x50: { name: 'ISOSAERESERVED50', desc: 'ISO-SAE reserved (0x50)' },
  0x51: { name: 'ISOSAERESERVED51', desc: 'ISO-SAE reserved (0x51)' },
  0x52: { name: 'ISOSAERESERVED52', desc: 'ISO-SAE reserved (0x52)' },
  0x53: { name: 'ISOSAERESERVED53', desc: 'ISO-SAE reserved (0x53)' },
  0x54: { name: 'ISOSAERESERVED54', desc: 'ISO-SAE reserved (0x54)' },
  0x55: { name: 'ISOSAERESERVED55', desc: 'ISO-SAE reserved (0x55)' },
  0x56: { name: 'ISOSAERESERVED56', desc: 'ISO-SAE reserved (0x56)' },
  0x57: { name: 'ISOSAERESERVED57', desc: 'ISO-SAE reserved (0x57)' },
  0x58: { name: 'ISOSAERESERVED58', desc: 'ISO-SAE reserved (0x58)' },
  0x59: { name: 'ISOSAERESERVED59', desc: 'ISO-SAE reserved (0x59)' },
  0x5A: { name: 'ISOSAERESERVED5A', desc: 'ISO-SAE reserved (0x5A)' },
  0x5B: { name: 'ISOSAERESERVED5B', desc: 'ISO-SAE reserved (0x5B)' },
  0x5C: { name: 'ISOSAERESERVED5C', desc: 'ISO-SAE reserved (0x5C)' },
  0x5D: { name: 'ISOSAERESERVED5D', desc: 'ISO-SAE reserved (0x5D)' },
  0x5E: { name: 'ISOSAERESERVED5E', desc: 'ISO-SAE reserved (0x5E)' },
  0x5F: { name: 'ISOSAERESERVED5F', desc: 'ISO-SAE reserved (0x5F)' },
  0x60: { name: 'ISOSAERESERVED60', desc: 'ISO-SAE reserved (0x60)' },
  0x61: { name: 'ISOSAERESERVED61', desc: 'ISO-SAE reserved (0x61)' },
  0x62: { name: 'ISOSAERESERVED62', desc: 'ISO-SAE reserved (0x62)' },
  0x63: { name: 'ISOSAERESERVED63', desc: 'ISO-SAE reserved (0x63)' },
  0x64: { name: 'ISOSAERESERVED64', desc: 'ISO-SAE reserved (0x64)' },
  0x65: { name: 'ISOSAERESERVED65', desc: 'ISO-SAE reserved (0x65)' },
  0x66: { name: 'ISOSAERESERVED66', desc: 'ISO-SAE reserved (0x66)' },
  0x67: { name: 'ISOSAERESERVED67', desc: 'ISO-SAE reserved (0x67)' },
  0x68: { name: 'ISOSAERESERVED68', desc: 'ISO-SAE reserved (0x68)' },
  0x69: { name: 'ISOSAERESERVED69', desc: 'ISO-SAE reserved (0x69)' },
  0x6A: { name: 'ISOSAERESERVED6A', desc: 'ISO-SAE reserved (0x6A)' },
  0x6B: { name: 'ISOSAERESERVED6B', desc: 'ISO-SAE reserved (0x6B)' },
  0x6C: { name: 'ISOSAERESERVED6C', desc: 'ISO-SAE reserved (0x6C)' },
  0x6D: { name: 'ISOSAERESERVED6D', desc: 'ISO-SAE reserved (0x6D)' },
  0x6E: { name: 'ISOSAERESERVED6E', desc: 'ISO-SAE reserved (0x6E)' },
  0x6F: { name: 'ISOSAERESERVED6F', desc: 'ISO-SAE reserved (0x6F)' },
  0x70: { name: 'UDNA', desc: 'Upload/download not accepted — flash conditions not ready' },
  0x71: { name: 'TDS', desc: 'Transfer data suspended — data transfer aborted by ECU' },
  0x72: { name: 'GPF', desc: 'General programming failure — write/erase error' },
  0x73: { name: 'WBSC', desc: 'Wrong block sequence counter — transfer block number mismatch' },
  0x74: { name: 'ISOSAERESERVED74', desc: 'ISO-SAE reserved (0x74)' },
  0x75: { name: 'ISOSAERESERVED75', desc: 'ISO-SAE reserved (0x75)' },
  0x76: { name: 'ISOSAERESERVED76', desc: 'ISO-SAE reserved (0x76)' },
  0x77: { name: 'ISOSAERESERVED77', desc: 'ISO-SAE reserved (0x77)' },
  0x78: { name: 'RCRRP', desc: 'Response correctly received, request pending — ECU still processing; poll for final response' },
  0x79: { name: 'ISOSAERESERVED79', desc: 'ISO-SAE reserved (0x79)' },
  0x7A: { name: 'ISOSAERESERVED7A', desc: 'ISO-SAE reserved (0x7A)' },
  0x7B: { name: 'ISOSAERESERVED7B', desc: 'ISO-SAE reserved (0x7B)' },
  0x7C: { name: 'ISOSAERESERVED7C', desc: 'ISO-SAE reserved (0x7C)' },
  0x7D: { name: 'ISOSAERESERVED7D', desc: 'ISO-SAE reserved (0x7D)' },
  0x7E: { name: 'SFNSIAS', desc: 'Sub-function not supported in active session' },
  0x7F: { name: 'SNSIAS', desc: 'Service not supported in active session' },
  0x80: { name: 'ISOSAERESERVED80', desc: 'ISO-SAE reserved (0x80)' },
  0x81: { name: 'RPMTOHIGH', desc: 'RPM too high — engine speed above allowed threshold for this operation' },
  0x82: { name: 'RPMTOLOW', desc: 'RPM too low — engine speed below allowed threshold' },
  0x83: { name: 'ENG_IS_RUNNING', desc: 'Engine is running — operation requires engine off' },
  0x84: { name: 'ENG_IS_NOT_RUNNING', desc: 'Engine is not running — operation requires engine running' },
  0x85: { name: 'ENG_RUN_TIME_TOO_LOW', desc: 'Engine run time too low — warm-up period incomplete' },
  0x86: { name: 'TEMP_TOO_HIGH', desc: 'Temperature too high' },
  0x87: { name: 'TEMP_TOO_LOW', desc: 'Temperature too low' },
  0x88: { name: 'VEHICLE_SPEED_TOO_HIGH', desc: 'Vehicle speed too high' },
  0x89: { name: 'VEHICLE_SPEED_TOO_LOW', desc: 'Vehicle speed too low' },
  0x8A: { name: 'THROTTLE_TOO_HIGH', desc: 'Throttle/pedal position too high' },
  0x8B: { name: 'THROTTLE_TOO_LOW', desc: 'Throttle/pedal position too low' },
  0x8C: { name: 'TRANS_RANGE_NOT_IN_NEUTRAL', desc: 'Transmission range not in neutral' },
  0x8D: { name: 'TRANS_RANGE_NOT_IN_GEAR', desc: 'Transmission range not in gear' },
  0x8E: { name: 'ISOSAERESERVED8E', desc: 'ISO-SAE reserved (0x8E)' },
  0x8F: { name: 'BRAKE_SWITCH_NOT_CLOSED', desc: 'Brake switch not closed (brake not pressed)' },
  0x90: { name: 'SHIFTER_LEVER_NOT_IN_PARK', desc: 'Shift lever not in park' },
  0x91: { name: 'TORQUE_CONV_CLUTCH_LOCKED', desc: 'Torque converter clutch locked' },
  0x92: { name: 'VOLT_TOO_HIGH', desc: 'Voltage too high — supply voltage exceeds threshold' },
  0x93: { name: 'VOLT_TOO_LOW', desc: 'Voltage too low — supply voltage below threshold' },
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

// ═══════════════════════════════════════════════════════════════════════════════

// ─── Sync Family Database ─────────────────────────────────────────────────────
// 3 families, 14 models, sync offsets, block structures, checksum algorithms,
// PCM inversion rules, transponder types, pinout references.
//
// REGLA CB: "EL ORDEN MATA" (CB manual page 10)
// ALWAYS write in this order: BCM → RFH → PCM. Never reversed.
// If PCM is written before BCM, the immobilizer enters protection mode
// and locks the kit for 30 minutes.
export const CB_WRITE_ORDER = Object.freeze(['BCM', 'RFH', 'PCM']);
export const CB_WRITE_ORDER_NOTE = 'REGLA CB: BCM → RFH → PCM. Writing PCM before BCM triggers immobilizer protection (30-min lockout).';
export const CB_SYNC_FAMILIES = Object.freeze([
  {
    id: 'chrysler_usa',
    name: 'Chrysler USA',
    label: 'FAMILIA 1',
    bcm: 'Continental MPC5606B (D-Flash 64KB)',
    bcmAccess: 'BDM/Nexus (Trasdata, New Genius, KESS)',
    bcmWritable: true,
    models: [
      {
        id: 'wrangler_jl',
        name: 'Wrangler JL / Gladiator JT',
        years: '2018-2024',
        pcm: '95320/95640',
        rfh: 'Continental 9S12XEG384',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        // CB manual page 17: Continental MPC5606B D-Flash 64KB layout
        // 0x0000-0x00FF: Config inicial (protected zone)
        // 0x0100-0x01FF: VIN del vehículo (3 réplicas)
        // 0x40C8: SYNC motor 16B (1st copy)
        // 0x40F0: SYNC motor 16B (mirror)
        // 0x81B0/0x81D0/0x81F0: Footer fraccionado (3 parts)
        // 0x9000+: Configuraciones (luces, central, etc.)
        bcmVinOffset: 0x0100,
        bcmVinReplicas: 3,
        bcmConfigOffset: 0x0000,
        bcmSyncOffset: 0x40C8,
        bcmSyncMirror: 0x40F0,
        bcmFooter: [0x81B0, 0x81D0, 0x81F0],
        bcmFooterNote: 'Footer fraccionado — 3 parts at 0x81B0, 0x81D0, 0x81F0. Must update all 3.',
        bcmConfigZone: 0x9000,
        // CB manual page 17: PCM marker is AA (single byte) for Wrangler JL/RAM
        // Note: Cherokee KL uses CC AA (2-byte) — different family
        pcmMarker: 0xAA,
        pcmMarkerOffset: 0x3C7,
        pcmSyncOffset: 0x3C9,
        pcmSyncRule: 'marker_aa_6b',
        rfhSyncOffset: 0x0C22,
        rfhSyncMirror: 0x0C34,
        rfhPattern: '66CC55AA',
        checksumAlgo: 'none',
        // CB manual page 16: Transponder data required from RFH dump
        transponderDataRequired: {
          sn: { offset: 0x040, len: 4, rule: 'le_to_be', desc: 'S/N 4B — invert LE→BE before writing to PCF7936' },
          cryptoHigh: { offset: 0x166, len: 2, rule: 'direct', desc: 'Crypto HIGH 2B — DIRECT (no invert)' },
          cryptoLow: { offset: 0x168, len: 4, rule: 'direct', desc: 'Crypto LOW 4B — DIRECT (no invert)' },
          config: { offset: 0x1A0, len: 4, rule: 'le_to_be', desc: 'Config/TMCF 4B — invert LE→BE before writing' },
        },
        notes: 'BCM sync 16B + mirror. PCM marker AA @ 0x3C7 + 6B sync. VIN 3 replicas @ 0x0100. Footer fraccionado @ 0x81B0/0x81D0/0x81F0.',
      },
      {
        id: 'ram_1500',
        name: 'RAM 1500 / 2500 / 3500',
        years: '2009-2018',
        pcm: '95320/95640',
        rfh: 'Continental 9S12XEG384',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        bcmVinOffset: 0x0100,
        bcmVinReplicas: 3,
        bcmSyncOffset: 0x40C8,
        bcmSyncMirror: 0x40F0,
        bcmFooter: [0x81B0, 0x81D0, 0x81F0],
        bcmFooterNote: 'Footer fraccionado — 3 parts at 0x81B0, 0x81D0, 0x81F0. Must update all 3.',
        pcmMarker: 0xAA,
        pcmMarkerOffset: 0x3C7,
        pcmSyncOffset: 0x3C9,
        pcmSyncRule: 'marker_aa_6b',
        rfhSyncOffset: 0x0C22,
        rfhSyncMirror: 0x0C34,
        checksumAlgo: 'none',
        transponderDataRequired: {
          sn: { offset: 0x040, len: 4, rule: 'le_to_be', desc: 'S/N 4B — invert LE→BE before writing to PCF7936' },
          cryptoHigh: { offset: 0x166, len: 2, rule: 'direct', desc: 'Crypto HIGH 2B — DIRECT' },
          cryptoLow: { offset: 0x168, len: 4, rule: 'direct', desc: 'Crypto LOW 4B — DIRECT' },
          config: { offset: 0x1A0, len: 4, rule: 'le_to_be', desc: 'Config/TMCF 4B — invert LE→BE' },
        },
        notes: 'Same BCM family as Wrangler JL. Classic 24C32 EEPROM on older variants. VIN 3 replicas @ 0x0100.',
      },
    ],
  },
  {
    id: 'cuswide',
    name: 'Cuswide',
    label: 'FAMILIA 2',
    bcm: '95640 SPI (Cherokee KL, Dart, C200) or Renesas R7F70xxxx (Compass MP, Renegade BU)',
    bcmAccess: 'TL866/XGecu (95640) or Trasdata BDM (Renesas — READ ONLY)',
    bcmWritable: 'partial',
    // CB manual page 18: Renesas R7F701056 (RH850/F1L) exact offsets
    renesas_offsets: {
      syncCompassRenegade: 0x16F4,   // SYNC 16B Compass MP / Renegade BU
      syncMirror: 0x1704,            // Mirror exactão contiguo
      syncAlternate: 0x05EC8,        // Sync alternativo — alineamiento BCM
      vinStyle: 'F2',                // [marker 1B][VIN inv 17B][CS 1B]
      vinInverted: true,             // VIN stored INVERTED — attention!
    },
    // CB manual page 18: Cuswide F2 checksum formula
    // cs(data, K) = (~(H + L + K)) & 0xFF
    // H = high byte of sum16, L = low byte, K = constant (1, 2, or 3 by firmware version)
    // RE of K requires 2-3 virgin dumps of same model/year
    cuswide_checksum_f2: {
      formula: 'cs(data, K) = (~(H + L + K)) & 0xFF',
      kValues: [1, 2, 3],
      kNote: 'K varies by firmware version. RE K with 2-3 virgin dumps of same model/year.',
    },
    models: [
      {
        id: 'chrysler_200',
        name: 'Chrysler 200',
        years: '2011-2017',
        bcm: '95640 EEPROM SPI',
        pcm: 'Continental 95320/95640',
        rfh: '9S12XEG384',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        bcmSyncOffset: 0x0FE0,
        bcmSyncMirror: null,
        pcmSyncOffset: 0x03C0,
        pcmSyncRule: 'direct_6b',
        // GAP 6 FIX: CTS block at 0x400 is REQUIRED for Chrysler 200 PCM.
        // Without it, PCM rejects RFH handshake and registers DTC P0513.
        // CTS block starts with ASCII 'CTSAA' (43 54 53 41 41) followed by 6 sync bytes.
        // Source: CB manual page 23 — field-verified requirement.
        pcmCtsBlockOffset: 0x0400,
        pcmCtsBlockMarker: [0x43, 0x54, 0x53, 0x41, 0x41],
        pcmCtsBlockRequired: true,
        pcmCtsBlockNote: 'REQUIRED: Write CTS block at 0x400 ("CTSAA" + 6 sync bytes). Without it: DTC P0513.',
        rfhSyncOffset: 0x0470,
        rfhChecksumOffset: 0x0476,
        rfhChecksumAlgo: 'crc16_ccitt',
        rfhChecksumPoly: 0x1021,
        rfhChecksumInit: 0xFFFF,
        rfhChecksumNote: 'CRC16-CCITT (poly 0x1021, init 0xFFFF) over the 6 sync bytes. Must recalculate after any sync change.',
        checksumAlgo: 'crc16_ccitt',
        notes: 'C200: 3-module sync (BCM 0xFE0 + PCM 0x3C0 + CTS@0x400 + RFH 0x470). RFH CRC16-CCITT at 0x476. Without CTS block: DTC P0513.',
        exampleSync: '3D 6E 11 38 5C 4C',
        // CB manual page 35: verified real CRC value A1 23 for sync 3D 6E 11 38 5C 4C
        exampleRfhCrc: 'A1 23',
      },
      {
        id: 'cherokee_kl',
        name: 'Cherokee KL',
        years: '2014-2023',
        bcm: '95640 EEPROM SPI (8KB)',
        pcm: 'GPEC',
        rfh: 'Continental 9S12XEG384 (AES native)',
        transponder: 'HITAG AES (16B)',
        syncBytes: 16,
        bcmSyncOffset: 0x0838,
        bcmSyncMirror: null,
        // CB manual page 36: Cherokee KL uses CC AA (2-byte marker) at 0x3C7
        // Real dump: 000003C0 FF FF FF FF FF FF FF CC AA 02 A7 97 65 E9 F5 FF
        pcmMarker: 0xAA,
        pcmMarkerBytes: [0xCC, 0xAA],
        pcmMarkerOffset: 0x3C7,
        pcmMarkerNote: 'Cherokee KL uses CC AA (2-byte) at 0x3C7 — not single AA like GPEC 2/2A',
        pcmSyncOffset: 0x3C9,
        pcmSyncRule: 'marker_ccaa_6b',
        rfhSyncOffset: 0x02B2,
        rfhSyncMirror: 0x02E0,
        rfhSyncRule: 'reverse_of_bcm',
        checksumAlgo: 'none',
        // CB manual page 38: RFH AES native offsets
        rfhAesHeaderOffset: 0x140,
        rfhAesHeaderFixed: [0x14, 0x24, 0x96, 0x04],
        rfhPreCrcOffset: 0x146,
        rfhPreCrcLength: 10,
        rfhVinOffset: 0x16A,
        rfhPostCrcOffset: 0x17B,
        rfhKeyIdOffset: 0x040,
        rfhAesKeyOffset: 0x230,
        rfhAesKeyLength: 16,
        rfhChecksumNote: 'Pre-CRC AES @ 0x146 (10B) + post-CRC AES @ 0x17B. Key ID @ 0x040. AES key candidate @ 0x230 (16B).',
        transponderNote: 'HITAG AES 128-bit. NOT clonable with basic Tango — requires Tango Plus or Autel IM608.',
        notes: 'BCM 16B sync (AES key). RFH stores reversed copy. PCM uses 6B subset with CC AA marker (2-byte). AES key @ RFH 0x230.',
      },
      {
        id: 'dodge_dart',
        name: 'Dodge Dart',
        years: '2013-2016',
        bcm: '95640 EEPROM SPI',
        pcm: 'Continental',
        rfh: '9S12XEG384',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        bcmSyncOffset: 0x0FE0,
        bcmSyncMirror: null,
        pcmSyncOffset: 0x03C0,
        pcmSyncRule: 'direct_6b',
        checksumAlgo: 'crc16_ccitt',
        notes: 'Same family as C200. 6B sync shared across BCM/PCM/RFH.',
      },
      {
        id: 'compass_mp',
        name: 'Compass MP',
        years: '2017-2023',
        bcm: 'Renesas R7F70xxxx (READ ONLY via BDM)',
        pcm: 'GPEC',
        rfh: '9S12XEG384',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        bcmSyncOffset: null,
        bcmReadOnly: true,
        // CB manual page 47: OBD proxy write procedure for Renesas BCM
        obd_proxy: {
          protocol: 'KWP',
          sessions: ['10 92', '10 85'],
          saLevel: '27 05/06',
          algId: '0016',
          supplier: 'C6',
          writeDid: '2E 2023',
          proxyBytes: 235,
          responseOk: '6E 2023',
          verifyDid: '22 2023',
          tool: 'Scanmatik2 / Autel J2534',
          warning: 'READ ONLY — writing without valid OEM signature BRICKS the chip irreversibly',
        },
        notes: 'BCM is Renesas — READ ONLY. Cannot write sync. Use donor BCM only.',
      },
      {
        id: 'renegade_bu',
        name: 'Renegade BU (Fiat)',
        years: '2015-2022',
        bcm: 'Renesas R7F70xxxx (READ ONLY via BDM)',
        pcm: 'GPEC',
        rfh: '9S12XEG384',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        bcmSyncOffset: null,
        bcmReadOnly: true,
        // CB manual page 47: OBD proxy write procedure for Renesas BCM
        obd_proxy: {
          protocol: 'KWP',
          sessions: ['10 92', '10 85'],
          saLevel: '27 05/06',
          algId: '0016',
          supplier: 'C6',
          writeDid: '2E 2023',
          proxyBytes: 235,
          responseOk: '6E 2023',
          verifyDid: '22 2023',
          tool: 'Scanmatik2 / Autel J2534',
          warning: 'READ ONLY — writing without valid OEM signature BRICKS the chip irreversibly',
        },
        notes: 'BCM is Renesas — READ ONLY. Cannot write sync. Use donor BCM only.',
      },
    ],
  },
  {
    id: 'fiat_brasil',
    name: 'Fiat Brasil',
    label: 'FAMILIA 3',
    bcm: 'Fujitsu MB91F526 (Flash 512KB + EEPROM 32KB)',
    bcmAccess: 'Trasdata / New Genius (BDM)',
    bcmWritable: true,
    // CB manual page 19: Fujitsu MB91F526 key zone offsets
    fujitsu_key_zone: {
      keyIdOffset: 0x0420,           // IDEs de llaves (CHAVE 1, CHAVE 2)
      keyMasterZone: 0xC400,         // Zona maestra de llaves (3× repetición)
      keyChecksumOffset: 0xC46E,     // Checksum 16-bit zona llaves (verified: 04 CB)
      keyChecksumVerified: '04 CB',  // Verified checksum value from real dump
      keyZoneRepetitions: 3,         // Key data repeated 3 times in master zone
      checksumAlgo: '16bit_per_block', // 16-bit per block, 2 bytes at end
    },
    pcmFamilies: [
      {
        id: 'pcm_continental',
        name: 'Continental (Argo, Cronos, Toro)',
        pcmChip: 'Continental',
        syncOffset: 0x0080,
        syncBytes: 6,
        checksumAlgo: 'add16_not',
        checksumNote: 'ADD16+NOT: sum all bytes in block, invert 16-bit result. Applied to 64B sync block.',
        edc17: false,
      },
      {
        id: 'pcm_edc17',
        name: 'EDC17 (Toro Diesel)',
        pcmChip: 'Bosch EDC17',
        syncOffset: 0x0080,
        syncBytes: 6,
        checksumAlgo: 'edc17_invert',
        checksumNote: 'EDC17 uses inverted byte order: BCM bytes [1,2,3,4,5,6] to PCM [6,4,2,5,3,1]. DO NOT recalculate CRC — EDC17 manages its own internal checksum.',
        edc17: true,
        edc17Warning: 'NEVER manually recalculate CRC on EDC17 files. The ECU will reject the file and may brick.',
      },
    ],
    models: [
      {
        id: 'fiat_argo',
        name: 'Fiat Argo',
        years: '2017-2024',
        pcm: 'Marelli IAW10GFEG',
        rfh: 'Continental C200 (9S12XEG384)',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        // GAP 7 FIX: BCM sync is at 0xE085 (64B block ×4), NOT 0x7C00.
        // Sync motor 6B starts at byte offset 5 within the 64B block (after 00 00 00 1D 00 header).
        // 4 blocks: cfg=01/01/02/02. Checksums: 1A 8E (cfg=01) / 1A 8F (cfg=02).
        // Source: CB manual page 41 — verified real dump Fiat Argo.
        bcmSyncOffset: 0xE085,
        bcmSyncHeaderBytes: 5,
        bcmSyncHeaderPattern: [0x00, 0x00, 0x00, 0x1D, 0x00],
        bcmBlockSize: 64,
        bcmBlockCount: 4,
        bcmBlockCfg: [0x01, 0x01, 0x02, 0x02],
        bcmChecksumCfg01: [0x1A, 0x8E],
        bcmChecksumCfg02: [0x1A, 0x8F],
        bcmSyncMirror: null,
        // GAP 7 FIX: Marelli IAW10GF PCM sync is DIRECT (no inversion), at 0x202.
        // Checksum: A1 03 (cfg=01) / A2 02 (cfg=02). Tester Code '44652' + ASCII '333580'.
        // Source: CB manual page 41 — real dump shows sync at 0x200+2=0x202.
        pcmVariant: 'marelli_iaw10gf',
        pcmSyncOffset: 0x0202,
        pcmSyncRule: 'direct_6b',
        pcmChecksumCfg01: [0xA1, 0x03],
        pcmChecksumCfg02: [0xA2, 0x02],
        pcmChecksumAlgo: 'marelli_16bit',
        pcmChecksumNote: 'Marelli verifies checksum at startup. A1 03 (cfg=01) / A2 02 (cfg=02).',
        // CB manual page 23: Marelli has NO Security Access at OBD level — only startup validation
        pcmSaRequired: false,
        pcmSaNote: 'Marelli IAW 10GF has NO Security Access at diagnostic level. Checksum verified at ECU startup only.',
        pcmProtocol: 'KWP/UDS',
        pcmMarkerNote: 'Marelli uses proprietary marker (not AA like GPEC). Sync at 0x202 DIRECT — no inversion.',
        pcmTesterCode: '44652',
        pcmFirmwareSig: '333580',
        pcmTesterCodeOffset: 0x230,
        pcmFirmwareSigOffset: 0x210,
        // GAP 8 FIX: RFH sync at 0x4FE (primary) + mirror at 0x512.
        // Source: CB manual page 40 — Toro Diesel dump shows mirror at 0x512.
        rfhSyncOffset: 0x04FE,
        rfhSyncMirror: 0x0512,
        rfhChecksumAlgo: 'add16_not',
        checksumAlgo: 'add16_not',
        notes: 'BCM 64B block ×4 at 0xE085 (5B header + 6B sync). PCM Marelli DIRECT sync at 0x202 (no inversion). RFH 0x4FE + mirror 0x512. Tester Code 44652 @ 0x230. No SA at OBD level.'
      },
      {
        id: 'fiat_cronos',
        name: 'Fiat Cronos',
        years: '2018-2024',
        pcm: 'Marelli IAW10GFEG',
        rfh: 'Continental C200',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        bcmSyncOffset: 0xE085,
        bcmSyncHeaderBytes: 5,
        bcmSyncHeaderPattern: [0x00, 0x00, 0x00, 0x1D, 0x00],
        bcmBlockSize: 64,
        bcmBlockCount: 4,
        bcmBlockCfg: [0x01, 0x01, 0x02, 0x02],
        bcmChecksumCfg01: [0x1A, 0x8E],
        bcmChecksumCfg02: [0x1A, 0x8F],
        bcmSyncMirror: null,
        pcmVariant: 'marelli_iaw10gf',
        pcmSyncOffset: 0x0202,
        pcmSyncRule: 'direct_6b',
        pcmChecksumCfg01: [0xA1, 0x03],
        pcmChecksumCfg02: [0xA2, 0x02],
        pcmChecksumAlgo: 'marelli_16bit',
        pcmSaRequired: false,
        pcmSaNote: 'Marelli IAW 10GF has NO Security Access at diagnostic level. Checksum verified at ECU startup only.',
        pcmProtocol: 'KWP/UDS',
        pcmTesterCode: '44652',
        pcmFirmwareSig: '333580',
        pcmTesterCodeOffset: 0x230,
        pcmFirmwareSigOffset: 0x210,
        rfhSyncOffset: 0x04FE,
        rfhSyncMirror: 0x0512,
        rfhChecksumAlgo: 'add16_not',
        checksumAlgo: 'add16_not',
        notes: 'Identical to Argo. BCM dump and PCM dump are interchangeable between Argo/Cronos. Tester Code 44652 @ 0x230. No SA at OBD level.'
      },
      {
        id: 'fiat_toro_diesel',
        name: 'Fiat Toro Diesel',
        years: '2016-2023',
        pcm: 'Bosch EDC17C69',
        rfh: 'Continental C200',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        bcmSyncOffset: 0xE085,
        bcmSyncHeaderBytes: 5,
        bcmSyncHeaderPattern: [0x00, 0x00, 0x00, 0x1D, 0x00],
        bcmBlockSize: 64,
        bcmBlockCount: 4,
        bcmBlockCfg: [0x01, 0x01, 0x02, 0x02],
        bcmChecksumCfg01: [0x15, 0x9A],
        bcmChecksumCfg02: [0x15, 0x9B],
        bcmSyncMirror: null,
        // EDC17 PCM: sync at 0x204, inverted 6-4-2-5-3-1 relative to BCM.
        // Source: CB manual page 40 — verified real dump Toro Diesel.
        pcmVariant: 'edc17c69',
        pcmSyncOffset: 0x0204,
        pcmSyncRule: 'edc17_invert_6421531',
        pcmChecksumAlgo: 'edc17_internal',
        edc17: true,
        edc17Warning: 'NEVER manually recalculate CRC on EDC17 files. ECU manages its own internal checksum. Use BSL Tool / KESS / MultiBoot.',
        // CB manual page 22: EDC17 validates CRC on every engine start. Wrong CRC = DTC P1601 = no-start.
        crcRecalcRequired: true,
        crcRecalcTool: 'BSL Tool / KESS V2 / MultiBoot / EDC17 Tool',
        dtcOnCrcFail: 'P1601',
        dtcNote: 'If CRC invalid after sync write → DTC P1601 → engine no-start. CRC recalc is MANDATORY.',
        // Verified real Toro Diesel example from CB manual page 21:
        // BCM: 2C 81 4D 81 04 F9 → PCM (inverted): F9 81 81 04 4D 2C
        exampleBcmSync: '2C 81 4D 81 04 F9',
        examplePcmSync: 'F9 81 81 04 4D 2C',
        // GAP 8 FIX: RFH sync at 0x4FE (primary) + mirror at 0x512.
        rfhSyncOffset: 0x04FE,
        rfhSyncMirror: 0x0512,
        rfhChecksumAlgo: 'add16_not',
        checksumAlgo: 'edc17_invert',
        notes: 'EDC17 PCM sync at 0x204 — inverted 6-4-2-5-3-1 from BCM. RFH same order as BCM. NEVER recalculate EDC17 CRC manually.',
      },
      {
        id: 'renegade_b1_hitag2',
        name: 'Renegade B1 1.8/2.0 (Brasil)',
        years: '2015-2022',
        pcm: 'Continental',
        rfh: 'Continental C200',
        transponder: 'PCF7936 / HITAG2',
        syncBytes: 6,
        bcmSyncOffset: 0xE085,
        bcmSyncHeaderBytes: 5,
        bcmSyncHeaderPattern: [0x00, 0x00, 0x00, 0x1D, 0x00],
        bcmBlockSize: 64,
        bcmBlockCount: 4,
        bcmBlockCfg: [0x01, 0x01, 0x02, 0x02],
        bcmSyncMirror: null,
        pcmSyncOffset: 0x0202,
        pcmSyncRule: 'direct_6b',
        rfhSyncOffset: 0x04FE,
        rfhSyncMirror: 0x0512,
        rfhChecksumAlgo: 'add16_not',
        checksumAlgo: 'add16_not',
        notes: 'Standard HITAG2. Same Fujitsu BCM family as Argo/Cronos. BCM 64B block ×4 at 0xE085.',
      },
      {
        id: 'renegade_b1_aes',
        name: 'Renegade B1 1.3T (Brasil)',
        years: '2019-2024',
        pcm: 'GPEC 4LM',
        rfh: 'Continental C200 (AES)',
        transponder: 'HITAG AES (16B)',
        syncBytes: 6,
        // GAP 4 FIX: Renegade B1 1.3T uses BCM Fujitsu 28B block at 0xE03D (not 0xE085)
        // Two contiguous copies: 0xE03D and 0xE059.
        // CB manual page 48 flash map: checksum sync at 0xE076 (NOT 0xE676 — was a typo in previous version)
        // Page 48 explicitly: 0xE076 = Checksum sync (Renegade B1)
        bcmSyncOffset: 0xE03D,
        bcmSyncMirror: 0xE059,
        bcmBlockSize: 28,
        bcmChecksumOffset: 0xE076,
        bcmChecksumValue: 0x0856,
        bcmChecksumNote: 'Fixed 16-bit checksum 0x0856 — no dual cfg, does not change.',
        // GAP 5 FIX: GPEC 4LM sync is in 28B block around 0x230 area — different from GPEC 2A 0x3C7
        pcmVariant: 'gpec4lm',
        pcmSyncOffset: 0x0230,
        pcmSyncRule: 'gpec4lm_28b',
        pcmChecksumRequired: true,
        pcmChecksumValue: 0x0856,
        pcmChecksumNote: 'GPEC 4LM requires checksum 0x0856 — only GPEC variant with mandatory checksum.',
        rfhChecksumAlgo: 'add16_not',
        checksumAlgo: 'linear_16bit',
        transponderNote: 'HITAG AES 128-bit stored LE in RFH. NOT clonable with basic Tango.',
        transponderCryptoKey: '16B AES-128 — stored Little-Endian (inverted byte order) in RFH',
        // CB manual page 42: BCM dump structure for Renegade B1 1.3T
        // BCM: 28B block repeated 2x contiguous. Checksum 16B unique (0x0856) — no dual cfg.
        // Key zone (IDEs llaves) repeated 3x in BCM.
        // CB manual page 42/50: Verified real Renegade B1 Crypto Key (from Tango verification)
        transponderCryptoKeyVerified: 'DA C2 02 DC 63 CA FA 38 4F 9A D5 C0 C5 16 79 B5',
        transponderCryptoKeyNote: 'Verified with Tango Plus. 16B AES-128 stored LE in RFH. Requires Tango Plus or Autel IM608.',
        // CB manual page 42: RFH dump structure for Renegade B1 AES
        // RFH: Crypto Key AES 16B at 0x140 (LE storage). IDEs llaves repeated 3x from 0x500.
        rfhCryptoKeyOffset: 0x0140,
        rfhCryptoKeyLen: 16,
        rfhCryptoKeyRule: 'le_stored',  // Stored LE — read as-is, write inverted to transponder
        rfhKeyIdeOffset: 0x0500,
        rfhKeyIdeRepetitions: 3,
        rfhKeyIdeSpacing: 0x100,        // 0x500, 0x600, 0x700
        // CB manual page 42: BCM key IDE zone
        bcmKeyIdeOffset: 0x0040,
        bcmKeyIdeRepetitions: 3,
        notes: 'HITAG AES. Requires Tango Plus or Autel IM608. BCM 28B block ×2 at 0xE03D+0xE059. GPEC 4LM PCM (not GPEC 2A). Verified Crypto Key: DA C2 02 DC 63 CA FA 38 4F 9A D5 C0 C5 16 79 B5.',
      },
    ],
  },
]);

// ─── RFH Dump Field Map ───────────────────────────────────────────────────────
// Source: CB Master Premium 2026 v6 — pages 25-38 + 4 verified real dump cases
//
// GAP 1 FIX (2026-06-06): Classic offsets corrected from verified ISAC case dump
//   (RAM 1500 2016, VIN 1C6RR7PM7GS145444, PIN 1507) + HYHY, CESAR, V1 cases.
//   Previous code had all offsets wrong (0x0000-0x0020 range).
//   Correct offsets span the full 4KB dump (0x020-0x1EA).
//
// GAP 2 FIX (2026-06-06): 2019+ variant detection corrected.
//   Previous code looked for AA 55 AA 55 at 0x0000 — WRONG.
//   2019+ dumps still have 5A 5A 5A 5A at 0x020 (same as classic).
//   Detection: check if bytes at 0x040 are printable ASCII (VIN format).
//   VIN moves to 0x040, S/N moves to 0x069 in FW 68363202xx.
//
// LE→BE inversion applies to: S/N (4B), Config/TMCF (4B), PIN (2B).
// Direct (no inversion): Signature, Crypto HIGH (2B), Crypto LOW (4B), all mirrors.
export const RFH_DUMP_FIELD_MAP = Object.freeze({
  classic: {
    label: 'Classic (2014-2018)',
    totalSize: 0x1000,
    // Verified: ISAC (RAM 1500 2016), HYHY, CESAR, V1 — all 4 cases confirmed
    signature:   { offset: 0x020, len: 4,  rule: 'raw',     expected: [0x5A, 0x5A, 0x5A, 0x5A], desc: 'Magic signature (5A 5A 5A 5A) at 0x020' },
    sn:          { offset: 0x040, len: 4,  rule: 'le_to_be', desc: 'Serial Number 4B LE→BE (write inverted to transponder)' },
    snMirror:    { offset: 0x080, len: 4,  rule: 'raw',      desc: 'S/N Mirror — must match raw bytes at 0x040' },
    cryptoHigh:  { offset: 0x166, len: 2,  rule: 'raw',      desc: 'Crypto HIGH 2B — direct order, no inversion' },
    cryptoLow:   { offset: 0x168, len: 4,  rule: 'raw',      desc: 'Crypto LOW 4B — direct order, no inversion' },
    cryptoMirror:{ offset: 0x180, len: 6,  rule: 'raw',      desc: 'Crypto Mirror 6B (HIGH+LOW) — must match 0x166-0x16B' },
    config:      { offset: 0x1A0, len: 4,  rule: 'le_to_be', desc: 'Config/TMCF 4B LE→BE (write inverted to transponder)' },
    configMirror:{ offset: 0x1C0, len: 4,  rule: 'raw',      desc: 'Config Mirror — must match raw bytes at 0x1A0' },
    pin:         { offset: 0x1C6, len: 2,  rule: 'le_to_be', desc: 'PIN 2B LE→BE → decimal 4-digit customer code' },
    vin:         { offset: 0x1EA, len: 17, rule: 'ascii',    desc: 'VIN 17 ASCII bytes' },
  },
  new2019: {
    label: '2019+ (FW 68363202xx)',
    totalSize: 0x1000,
    // Detection: signature still 5A×4 at 0x020; VIN moved to 0x040 (ASCII), S/N to 0x069
    // Source: CB manual page 33 — verified real dump RAM 1500 USA VIN 1C6RR6TTOKS731726
    signature:   { offset: 0x020, len: 4,  rule: 'raw',     expected: [0x5A, 0x5A, 0x5A, 0x5A], desc: 'Magic signature (5A 5A 5A 5A) — same as classic' },
    vin:         { offset: 0x040, len: 17, rule: 'ascii',    desc: 'VIN 17 ASCII bytes — MOVED to 0x040 in 2019+ (was 0x1EA)' },
    sn:          { offset: 0x069, len: 4,  rule: 'le_to_be', desc: 'Serial Number 4B LE→BE — MOVED to 0x069 in 2019+ (was 0x040)' },
    snMirror:    { offset: 0x080, len: 4,  rule: 'raw',      desc: 'S/N Mirror — unchanged at 0x080' },
    cryptoHigh:  { offset: 0x166, len: 2,  rule: 'raw',      desc: 'Crypto HIGH 2B — unchanged' },
    cryptoLow:   { offset: 0x168, len: 4,  rule: 'raw',      desc: 'Crypto LOW 4B — unchanged' },
    cryptoMirror:{ offset: 0x180, len: 6,  rule: 'raw',      desc: 'Crypto Mirror 6B — unchanged' },
    config:      { offset: 0x1A0, len: 4,  rule: 'le_to_be', desc: 'Config/TMCF 4B LE→BE — unchanged' },
    configMirror:{ offset: 0x1C0, len: 4,  rule: 'raw',      desc: 'Config Mirror — unchanged' },
    pin:         { offset: 0x1C6, len: 2,  rule: 'le_to_be', desc: 'PIN 2B LE→BE — unchanged' },
  },
});

// ─── Checksum Algorithms ──────────────────────────────────────────────────────
// Source: CB manual pages 39-48
export const CB_CHECKSUM_ALGOS = Object.freeze([
  {
    id: 'add16_not',
    name: 'ADD16+NOT',
    label: 'ADD16+NOT (RFH Continental / Fiat Brasil PCM)',
    desc: 'Sum all bytes in the target block as 16-bit unsigned, then bitwise NOT the result. Store as 2 bytes LE.',
    applies: ['RFH Continental C200', 'Fiat Brasil PCM (non-EDC17)', 'BCM Fujitsu sync block'],
    example: 'Block [0x3D, 0x6E, 0x11, 0x38, 0x5C, 0x4C] -> sum=0x01FA -> NOT=0xFE05',
  },
  {
    id: 'crc16_ccitt',
    name: 'CRC16-CCITT',
    label: 'CRC16-CCITT (RFH C200 / Chrysler 200)',
    desc: 'CRC16-CCITT (polynomial 0x1021, init 0xFFFF) over the sync bytes. Store as 2 bytes BE.',
    applies: ['RFH C200 (Chrysler 200, Dodge Dart)', 'Cuswide family RFH'],
    example: 'Sync [3D 6E 11 38 5C 4C] -> CRC16-CCITT = computed live',
  },
  {
    id: 'f2_8bit',
    name: 'F2 8-bit',
    label: 'F2 8-bit (BCM Renesas / Cuswide)',
    desc: 'XOR-based 8-bit checksum: sum all bytes, XOR with 0xF2, mask to 8 bits.',
    applies: ['BCM Renesas Compass MP (read-only)', 'Cuswide family BCM'],
    example: 'Block sum XOR 0xF2 = checksum byte',
  },
  {
    id: 'linear_16bit',
    name: '16-bit Linear',
    label: '16-bit Linear (BCM Fujitsu)',
    desc: 'Simple 16-bit sum of all bytes in the 64B or 28B sync block. No inversion.',
    applies: ['BCM Fujitsu MB91F526 (Fiat Brasil)'],
    example: 'Sum all bytes in 64B block -> 16-bit result stored at end of block',
  },
  {
    id: 'edc17_invert',
    name: 'EDC17 Invert',
    label: 'EDC17 Sync Inversion (Toro Diesel)',
    desc: 'BCM bytes [B1,B2,B3,B4,B5,B6] to PCM EDC17 bytes [B6,B4,B2,B5,B3,B1]. DO NOT recalculate CRC.',
    applies: ['Fiat Toro Diesel EDC17 PCM'],
    example: 'BCM: 3D 6E 11 38 5C 4C -> EDC17 PCM: 4C 38 6E 5C 11 3D',
    warning: 'NEVER manually recalculate CRC on EDC17 files. The ECU manages its own internal checksum.',
  },
]);

// ─── EDC17 Sync Inversion ─────────────────────────────────────────────────────
// Source: CB manual pages 43-44
// Rule: BCM bytes [1,2,3,4,5,6] -> PCM EDC17 [6,4,2,5,3,1] (1-indexed)
// i.e. input[0..5] -> output = [input[5], input[3], input[1], input[4], input[2], input[0]]
export function edc17SyncInvert(bcmSync6) {
  if (!bcmSync6 || bcmSync6.length < 6) throw new Error('EDC17 invert requires exactly 6 bytes');
  const b = bcmSync6;
  return [b[5], b[3], b[1], b[4], b[2], b[0]];
}

// ─── ADD16+NOT Checksum ───────────────────────────────────────────────────────
export function calcAdd16Not(blockBytes) {
  let sum = 0;
  for (const b of blockBytes) sum = (sum + b) & 0xFFFF;
  return (~sum) & 0xFFFF;
}

// ─── CRC16-CCITT Checksum ─────────────────────────────────────────────────────
export function calcCrc16Ccitt(bytes, init = 0xFFFF) {
  let crc = init;
  for (const b of bytes) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

// ─── F2 8-bit Checksum ────────────────────────────────────────────────────────
export function calcF28bit(blockBytes) {
  let sum = 0;
  for (const b of blockBytes) sum = (sum + b) & 0xFF;
  return (sum ^ 0xF2) & 0xFF;
}

// ─── Cuswide F2 Checksum (Renesas BCM — CB manual page 18) ───────────────────────────────────────────────────────────────────
// Formula: cs(data, K) = (~(H + L + K)) & 0xFF
// H = high byte of sum16, L = low byte, K = firmware constant (1, 2, or 3)
// K must be determined by RE from 2-3 virgin dumps of same model/year.
// NOT the same as calcF28bit (which is a simple XOR variant).
export function calcCuswideF2(blockBytes, K = 1) {
  let sum16 = 0;
  for (const b of blockBytes) sum16 = (sum16 + b) & 0xFFFF;
  const H = (sum16 >> 8) & 0xFF;
  const L = sum16 & 0xFF;
  return (~(H + L + K)) & 0xFF;
}

// ─── BCM Fujitsu 16-bit Linear Checksum ──────────────────────────────────────
// GAP 3 FIX (2026-06-06): Added dual-cfg +1 rule.
// Argo/Toro pattern: 4 blocks with cfg=01/01/02/02.
// When cfg=02, checksum = (linear sum) + 1.
// Renegade B1 1.3T: single 28B block, no dual cfg, cfg param not used.
// Source: CB manual page 39 — verified from Argo (1A 8E/1A 8F) and Toro (15 9A/15 9B) real dumps.
export function calcFujitsuChecksum(blockBytes, cfg = 1) {
  let sum = 0;
  for (const b of blockBytes) sum = (sum + b) & 0xFFFF;
  if (cfg === 2) sum = (sum + 1) & 0xFFFF;
  return sum;
}

// ─── RFH Dump Analyzer ───────────────────────────────────────────────────────
// Source: CB manual pages 25-38
// Auto-detects firmware variant (classic vs 2019+) from signature bytes.
// Extracts all 10 fields with correct LE->BE inversion.
export function analyzeRfhDump(bytes) {
  if (!bytes || bytes.length < 0x100) return { error: 'Dump too small - minimum 256 bytes required' };
  const sig4 = Array.from(bytes.slice(0, 4));
  let variant = null;
  // GAP 2 FIX: 2019+ detection uses VIN-at-0x040 heuristic, not a different signature.
  // Both classic and 2019+ have 5A 5A 5A 5A at 0x020. The difference is:
  //   classic: S/N at 0x040 (binary), VIN at 0x1EA (ASCII)
  //   2019+:   VIN at 0x040 (ASCII), S/N at 0x069 (binary)
  const sig4at020 = bytes.length >= 0x024 ? Array.from(bytes.slice(0x020, 0x024)) : [];
  const isClassicSig = sig4at020.every(b => b === 0x5A);
  // Check if bytes at 0x040 look like printable ASCII (VIN = letters + digits)
  const bytes040 = bytes.length >= 0x051 ? Array.from(bytes.slice(0x040, 0x051)) : [];
  const looksLikeVin = bytes040.length === 17 && bytes040.every(b => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A));
  if (isClassicSig && looksLikeVin) variant = 'new2019';
  else if (isClassicSig || (sig4[0] === 0x5A && sig4[1] === 0x5A)) variant = 'classic';
  else variant = 'classic'; // fallback
  const map = RFH_DUMP_FIELD_MAP[variant];
  const readField = (field) => {
    if (!field || field.offset + field.len > bytes.length) return null;
    const raw = Array.from(bytes.slice(field.offset, field.offset + field.len));
    if (field.rule === 'le_to_be') return { raw, value: [...raw].reverse(), inverted: true };
    if (field.rule === 'ascii') return { raw, value: raw, text: raw.map(b => String.fromCharCode(b)).join('') };
    return { raw, value: raw, inverted: false };
  };
  const sig = readField(map.signature);
  const isValidRfh = sig && (map.signature.expected
    ? sig.value.every((b, i) => b === map.signature.expected[i])
    : true);
  const sn = readField(map.sn);
  const snMirror = readField(map.snMirror);
  const cryptoHigh = readField(map.cryptoHigh);
  const cryptoLow = readField(map.cryptoLow);
  const cryptoMirror = readField(map.cryptoMirror);
  const config = readField(map.config);
  const configMirror = readField(map.configMirror);
  const pin = readField(map.pin);
  const vin = readField(map.vin);
  // PIN is stored as 2-byte BCD: after LE→BE inversion, read each byte as 2 hex digits.
  // Example: raw [0x07, 0x15] → reversed [0x15, 0x07] → BCD '1507'
  // Example: raw [0x08, 0x28] → reversed [0x28, 0x08] → BCD '2808'
  let pinDecimal = null;
  if (pin && pin.value.length === 2) {
    pinDecimal = pin.value.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  }
  const snMirrorMatch = sn && snMirror && sn.raw.every((b, i) => b === snMirror.raw[i]);
  const cryptoMirrorMatch = cryptoHigh && cryptoLow && cryptoMirror &&
    [...cryptoHigh.raw, ...cryptoLow.raw].every((b, i) => b === cryptoMirror.raw[i]);
  return {
    variant,
    isValidRfh,
    map,
    fields: { sig, sn, snMirror, cryptoHigh, cryptoLow, cryptoMirror, config, configMirror, pin, vin },
    derived: {
      pinDecimal,
      snMirrorMatch,
      cryptoMirrorMatch,
      vinText: vin ? vin.text : null,
      cryptoFull: cryptoHigh && cryptoLow ? [...cryptoHigh.value, ...cryptoLow.value] : null,
    },
    transponderSheet: {
      sn:         sn ? sn.value : null,
      cryptoHigh: cryptoHigh ? cryptoHigh.value : null,
      cryptoLow:  cryptoLow ? cryptoLow.value : null,
      config:     config ? config.value : null,
      pin:        pinDecimal,
      vin:        vin ? vin.text : null,
      note: 'Write S/N + Crypto HIGH + Crypto LOW + Config to PCF7936 via Tango/KeyMaker. PIN is customer code.',
    },
  };
}

// ─── Transponder Type Matrix ──────────────────────────────────────────────────
// Source: CB manual pages 50, glossary
export const TRANSPONDER_TYPE_MATRIX = Object.freeze([
  { model: 'RAM 1500/2500/3500 (Chrysler)', type: 'HITAG2 / PCF7936', crypto: '4B', tool: 'Tango / KeyMaker', note: 'Classic RFH 24C32 EEPROM' },
  { model: 'Wrangler JL / Gladiator JT', type: 'HITAG2 / PCF7936', crypto: '4B', tool: 'Tango / KeyMaker', note: 'RFH 9S12XEG384' },
  { model: 'Chrysler 200', type: 'HITAG2 / PCF7936', crypto: '4B', tool: 'Tango / KeyMaker', note: 'RFH 9S12XEG384' },
  { model: 'Dodge Dart', type: 'HITAG2 / PCF7936', crypto: '4B', tool: 'Tango / KeyMaker', note: 'Cuswide family' },
  { model: 'Compass MP', type: 'HITAG2 / PCF7936', crypto: '4B', tool: 'Tango / KeyMaker', note: 'Renesas BCM - READ ONLY' },
  { model: 'Cherokee KL', type: 'HITAG AES', crypto: '16B AES-128', tool: 'Tango Plus / Autel IM608', note: 'NOT clonable with basic Tango. Cost ~3-4x HITAG2.' },
  { model: 'Fiat Argo / Cronos', type: 'HITAG2 / PCF7936', crypto: '4B', tool: 'Tango / KeyMaker', note: 'Fujitsu BCM' },
  { model: 'Fiat Toro Diesel', type: 'HITAG2 / PCF7936', crypto: '4B', tool: 'Tango / KeyMaker', note: 'Fujitsu BCM + EDC17' },
  { model: 'Renegade B1 1.3T (Brasil)', type: 'HITAG AES', crypto: '16B AES-128', tool: 'Tango Plus / Autel IM608', note: 'NOT clonable with basic Tango.' },
  { model: 'Renegade B1 1.8/2.0 (Brasil)', type: 'HITAG2 / PCF7936', crypto: '4B', tool: 'Tango / KeyMaker', note: 'Standard HITAG2' },
]);

// ─── Common Errors & Mitigation Table ────────────────────────────────────────
// Source: CB manual page 11 — "Los que cuestan caro"
export const CB_COMMON_ERRORS = Object.freeze([
  {
    error: 'Writing over RH850 (Renesas) without backup',
    cause: 'Irreversible brick of BCM',
    mitigation: 'ALWAYS backup before touching. Renesas BCM is READ ONLY — never write.',
    severity: 'CRITICAL',
  },
  {
    error: 'Incorrect checksum (F2)',
    cause: 'BCM rejects dump at startup',
    mitigation: 'Recalculate checksum with correct K constant. Verify with 2-3 virgin dumps.',
    severity: 'HIGH',
  },
  {
    error: 'VIN not inverted (Familia F2 / Cuswide)',
    cause: 'BCM stores VIN inverted — if written direct, BCM rejects it',
    mitigation: 'VIN must be inverted byte-by-byte before writing to Renesas BCM.',
    severity: 'HIGH',
  },
  {
    error: 'Sync motor copied inverted in EDC17',
    cause: 'Engine no-start. DTC P1601.',
    mitigation: 'EDC17 requires permutation [6,4,2,5,3,1] from BCM bytes. Never copy direct.',
    severity: 'HIGH',
  },
  {
    error: 'Writing PCM before BCM',
    cause: 'Immobilizer enters protection mode — kit locked 30 minutes',
    mitigation: 'REGLA CB: always write BCM → RFH → PCM. Never reversed.',
    severity: 'HIGH',
  },
  {
    error: 'Mirror not updated in Renesas BCM',
    cause: 'BCM detects inconsistency between primary and mirror — rejects sync',
    mitigation: 'Always update mirror at 0x1704 when writing sync at 0x16F4.',
    severity: 'MEDIUM',
  },
  {
    error: 'Crypto Key in Big-Endian (Renegade B1)',
    cause: 'HITAG AES key written wrong — transponder not recognized',
    mitigation: 'Renegade B1 stores AES key LE in RFH. Invert before writing to transponder.',
    severity: 'HIGH',
  },
  {
    error: 'PIN read in direct order (RAM Chrysler)',
    cause: 'Wrong PIN shown to customer',
    mitigation: 'PIN at 0x1C6/0x1C7 must be inverted LE→BE. Raw [07 15] → PIN 1507.',
    severity: 'MEDIUM',
  },
  {
    error: 'Confusing BCM Renesas with BCM Fujitsu',
    cause: 'Wrong procedure applied — potential brick',
    mitigation: 'Renesas = Compass MP, Renegade BU (READ ONLY). Fujitsu = Argo, Cronos, Toro, Renegade B1 (writable).',
    severity: 'HIGH',
  },
]);

// ─── Chip BCM Matrix ──────────────────────────────────────────────────────────
// Source: CB manual page 15
export const CB_CHIP_MATRIX = Object.freeze([
  { model: 'Wrangler JL / Gladiator JT', chassis: 'JL/JT', years: '2018+', chip: 'Continental MPC5606B (D-Flash 64KB)', family: 'Chrysler USA', notes: '2 complete copies + footer fraccionado' },
  { model: 'RAM 1500/2500/3500', chassis: 'DT/DJ', years: '2014+', chip: 'Continental MPC5606B (D-Flash 64KB)', family: 'Chrysler USA', notes: 'RFH PCF7936 — TRA with 24C32' },
  { model: 'Cherokee KL', chassis: 'KL', years: '2014+', chip: '95640 EEPROM SPI (8KB)', family: 'Cuswide', notes: 'RFH AES native — BCM serial SPI (not Renesas)' },
  { model: 'Dodge Dart', chassis: 'PF', years: '2013-2016', chip: '95640 EEPROM SPI (8KB)', family: 'Cuswide', notes: 'BCM serial SPI — Cuswide pre-Renesas' },
  { model: 'Chrysler 200', chassis: 'UF', years: '2015-2017', chip: '95640 EEPROM SPI (8KB)', family: 'Cuswide', notes: 'BCM serial SPI — NOT Continental MPC5606B' },
  { model: 'Compass MP', chassis: 'MP', years: '2017+', chip: 'Renesas R7F70xxxx (RH850)', family: 'Cuswide', notes: 'USA — VIN italiano — READ ONLY — brickeable' },
  { model: 'Renegade BU', chassis: 'BU', years: '2018+', chip: 'Renesas R7F70xxxx (RH850)', family: 'Cuswide', notes: 'USA — VIN italiano — READ ONLY — brickeable' },
  { model: 'Fiat Argo', chassis: 'F2', years: '2017+', chip: 'Fujitsu MB91F526', family: 'Fiat Brasil', notes: 'BCM blanco — sync 6B at 0xE085+' },
  { model: 'Fiat Cronos', chassis: 'F2', years: '2018+', chip: 'Fujitsu MB91F526', family: 'Fiat Brasil', notes: 'Identical to Argo' },
]);

// ─── Tool Reference Matrix ────────────────────────────────────────────────────
// Source: CB manual page 52
export const CB_TOOL_MATRIX = Object.freeze([
  { tool: 'TL866II Plus / XGecu T56', use: 'EEPROM 95xxx / 24Cxx', notes: 'Standard SPI programmer for 95640, 24C32' },
  { tool: 'Trasdata', use: 'BDM/Nexus/JTAG', notes: 'BCM Renesas RH850 (read) / Fujitsu (read+write)' },
  { tool: 'New Genius (Dimsport)', use: 'BDM', notes: 'PCM EDC17' },
  { tool: 'KESS V2 / KTAG', use: 'OBD/BSL', notes: 'EDC17 + GPEC' },
  { tool: 'Scanmatik 2 Pro', use: 'J2534', notes: 'OEM-style scanner — Renesas proxy write' },
  { tool: 'Iprog+', use: 'Multi-chip', notes: 'Renesas + Fujitsu' },
  { tool: 'Tango (Scorpio)', use: 'Transponder', notes: 'HITAG2 programmer — PCF7936' },
  { tool: 'Tango Plus', use: 'Transponder', notes: 'HITAG AES + 16B Crypto — Cherokee KL / Renegade B1' },
  { tool: 'Autel IM608 Pro', use: 'Transponder', notes: 'HITAG AES via OEM — Cherokee KL / Renegade B1' },
  { tool: 'WinHex', use: 'Hex editor', notes: 'Dump editing and checksum calculation' },
  { tool: 'KeyMaker', use: 'Transponder', notes: 'HITAG2 / PCF7936 — basic key programming' },
]);

// ─── Method Comparison Table ──────────────────────────────────────────────────
// Source: CB manual page 9 — Método Usado vs Método Nuevo
export const CB_METHOD_COMPARISON = Object.freeze({
  used: {
    name: 'Método Usado (CB)',
    steps: [
      '1. BCM/PCM/RFH from junkyard or donor',
      '2. Full dump in bench (EEPROM programmer)',
      '3. Edit specific bytes per family',
      '4. Recalculate checksum manually (CRC16/ADD16)',
      '5. Write 3 dumps with AUTEL/KESS/New Genius',
    ],
    advantages: [
      'No active OEM diagnostic required',
      'Works on BCMs locked to diagnostics',
      'Compatible with any standard programmer',
    ],
    verified: '100+ cases',
  },
  new: {
    name: 'Método Nuevo (OEM)',
    steps: [
      '1. New BCM from Mopar (unprogrammed)',
      '2. VIN identification via OBD',
      '3. Signature programming via diagnostic tool',
      '4. Checksum automatic by tool',
      '5. OBD via WiTECH/AVDI/Autel',
    ],
    advantages: [
      'Guaranteed result (valid OEM signature)',
      'No reverse engineering of proxies required',
      'Activation of advanced features (HMI, BLE)',
    ],
    disadvantages: [
      'Requires VIN registered with Stellantis',
      'Cost per activation (AVDI/Autel credits)',
      'Traceability in OEM system',
    ],
    tools: ['WiTECH', 'AVDI', 'Autel IM608'],
  },
});

// ─── CDA6 SA Algorithm Table ──────────────────────────────────────────────────
// Source: client/public/sa-algorithms/sa_algorithms.json
// Extracted from CDA6 ABS database files (52 databases, 25 entries, 9 unique algorithms).
// All use the standard FCA byte-swap + shift + XOR pattern:
//   tempSeed = byte-swap(seed)
//   shiftSeed = ((tempSeed << 11) | (tempSeed >>> 22)) & 0xFFFFFFFF
//   key = shiftSeed ^ KEY_CONSTANT_1 ^ (KEY_CONSTANT_2 & seed)
//
// Pattern variants:
//   cda6_standard: seed read from bytes 0..3 (arrayToBigInt(seed, 0, 4))
//   cda6_v42:      seed read from last 4 bytes (arrayToBigInt(seed, seed.length-4, 4))
//   cda6_v43:      uses getSeedInt/getKeyInt helpers (different byte-swap order)
//
// Supplier codes: 0003=Continental, 0022=Bosch, 0027=TRW
export const SA_ALGORITHMS_CDA6 = Object.freeze([
  // ABS FGA platform — Supplier 0003 (Continental)
  { id:'abs_fga_s1', module:'ABS_FGA', level:1, supplier:'0003', var:'01',
    kc1:0xEA4E62A5, kc2:0x2AFC74C2, andConst:0xFFFFFFFF, pattern:'cda6_standard',
    file:'S1_ABS_FGA_Sup0003_Var01_V01.esu' },
  { id:'abs_fga_s5', module:'ABS_FGA', level:5, supplier:'0003', var:'01',
    kc1:0x78829BFC, kc2:0xA1D1B1DB, andConst:0xFFFFFFFF, pattern:'cda6_standard',
    file:'S5_ABS_FGA_Sup0003_Var01_V01.esu' },
  // ABS PN platform — Supplier 0022 (Bosch)
  { id:'abs_pn_s5_sup22_v40', module:'ABS_PN', level:5, supplier:'0022', var:'40',
    kc1:0x2C72C073, kc2:0x74A1D07A, andConst:0xFFFFFFFF, pattern:'cda6_v42',
    file:'S5_ABS_PN_Sup0022_Var40_V01.esu' },
  // ABS PN platform — Supplier 0027 (TRW)
  { id:'abs_pn_s1_sup27_v40', module:'ABS_PN', level:1, supplier:'0027', var:'40',
    kc1:0x67789E8A, kc2:0x67EEDB64, andConst:0xFFFFFFFF, pattern:'cda6_standard',
    file:'S1_ABS_PN_Sup0027_Var40_V01.esu' },
  { id:'abs_pn_s5_sup27_v40', module:'ABS_PN', level:5, supplier:'0027', var:'40',
    kc1:0x289FC9B3, kc2:0x82D9782E, andConst:0xFFFFFFFF, pattern:'cda6_standard',
    file:'S5_ABS_PN_Sup0027_Var40_V01.esu' },
  // ABS PN platform — Supplier 0003 Var41
  { id:'abs_pn_s1_sup03_v41', module:'ABS_PN', level:1, supplier:'0003', var:'41',
    kc1:0x5E1443A2, kc2:0xB59F8AC0, andConst:0xFFFFFFFF, pattern:'cda6_standard',
    file:'S1_ABS_PN_Sup0003_Var41_V01.esu' },
  { id:'abs_pn_s5_sup03_v41', module:'ABS_PN', level:5, supplier:'0003', var:'41',
    kc1:0x3D83D147, kc2:0x8D014ADC, andConst:0xFFFFFFFF, pattern:'cda6_standard',
    file:'S5_ABS_PN_Sup0003_Var41_V01.esu' },
  // ABS PN platform — Supplier 0003 Var42 (AlgID 0x0183)
  { id:'abs_pn_s1_sup03_v42', module:'ABS_PN', level:1, supplier:'0003', var:'42', algId:0x0183,
    kc1:0x7C72C58C, kc2:0x4F6CE8AA, andConst:0xFFFFFFFF, pattern:'cda6_v42',
    file:'S1_ABS_PN_Sup0003_Var42_AlgID0183_V01.esu' },
  // ABS PN platform — Supplier 0003 Var43 (AlgID 0x01D9) — different byte-swap helper
  { id:'abs_pn_s5_sup03_v43', module:'ABS_PN', level:5, supplier:'0003', var:'43', algId:0x01D9,
    kc1:0x25905977, kc2:0xC4EFE8A4, andConst:0xFFFFFFFF, pattern:'cda6_v43',
    file:'S5_ABS_PN_Sup0003_Var43_AlgID01D9_V02.esu' },
]);

/**
 * Compute CDA6 SA key from a 4-byte seed using the standard pattern.
 * Byte-swap: [b0,b1,b2,b3] → [b2,b3,b0,b1] (swap pairs, then swap bytes within pairs)
 * Actually: tempSeed = (b2<<24)|(b3<<16)|(b0<<8)|b1  (FCA standard byte-swap)
 * Then: shiftSeed = rol32(tempSeed, 11)
 * Then: key = shiftSeed ^ KC1 ^ (KC2 & seedInt)
 * @param {number[]} seed  4-byte seed array
 * @param {number} kc1     KEY_CONSTANT_1 (32-bit)
 * @param {number} kc2     KEY_CONSTANT_2 (32-bit)
 * @param {string} [pattern='cda6_standard']  'cda6_standard' | 'cda6_v42' | 'cda6_v43'
 * @returns {number[]} 4-byte key array
 */
export function calcCda6SaKey(seed, kc1, kc2, pattern = 'cda6_standard') {
  const u32 = (n) => (n >>> 0);
  let seedInt, tempSeed;

  if (pattern === 'cda6_v43') {
    // getSeedInt: BE read from last 4 bytes
    seedInt = u32(
      ((seed[seed.length-4] & 0xFF) << 24) |
      ((seed[seed.length-3] & 0xFF) << 16) |
      ((seed[seed.length-2] & 0xFF) << 8)  |
       (seed[seed.length-1] & 0xFF)
    );
    // getKeyInt: different byte-swap order
    tempSeed = u32(
      ((seed[seed.length-3] & 0xFF) << 24) |
      ((seed[seed.length-4] & 0xFF) << 16) |
      ((seed[seed.length-1] & 0xFF) << 8)  |
       (seed[seed.length-2] & 0xFF)
    );
    // shiftLeft helper: mask-aware left shift
    const shiftLeft = (n, amt) => {
      const mask = (0x7FFFFFFF >>> (amt - 1)) >>> 0;
      return u32((n & mask) << amt);
    };
    const keyInt = u32(shiftLeft(tempSeed, 11) + (tempSeed >>> 22));
    const temp = u32(kc2 & seedInt);
    const result = u32(keyInt ^ kc1 ^ temp);
    return [(result >>> 24) & 0xFF, (result >>> 16) & 0xFF, (result >>> 8) & 0xFF, result & 0xFF];
  }

  // Standard and v42 both use same formula, differ only in seed read offset
  const off = (pattern === 'cda6_v42') ? seed.length - 4 : 0;
  seedInt = u32(
    ((seed[off]   & 0xFF) << 24) |
    ((seed[off+1] & 0xFF) << 16) |
    ((seed[off+2] & 0xFF) << 8)  |
     (seed[off+3] & 0xFF)
  );
  // FCA standard byte-swap: (b2<<24)|(b3<<16)|(b0<<8)|b1
  tempSeed = u32(
    (((seedInt >>> 8)  & 0xFF) << 24) |
    (((seedInt)        & 0xFF) << 16) |
    (((seedInt >>> 24) & 0xFF) << 8)  |
     ((seedInt >>> 16) & 0xFF)
  );
  const shiftSeed = u32(((tempSeed << 11) | (tempSeed >>> 21)));
  const result = u32(shiftSeed ^ kc1 ^ u32(kc2 & seedInt));
  return [(result >>> 24) & 0xFF, (result >>> 16) & 0xFF, (result >>> 8) & 0xFF, result & 0xFF];
}
