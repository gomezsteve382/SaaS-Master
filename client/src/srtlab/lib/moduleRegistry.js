/* moduleRegistry — single source of truth for every CAN module the app
   can talk to. Consolidates the addresses previously scattered across
   OBDSwarmDiagnostic.ALL_KNOWN_ADDRS, programmerData.js, and
   quickRefData.generated.js into one schema that the universal VIN
   programmer (vinProgrammer.js) and the Program-All UI consume.

   Each entry carries:
     code         — short identifier (e.g. 'BCM', 'ECM_7E0')
     name         — human-readable label
     tx,rx        — UDS request / response CAN IDs
     kind         — 'vin-writable' | 'no-vin' | 'unsupported'
     unlockId     — preferred unlock algorithm id from algos.js ALGOS;
                    if absent, pickUnlockChain(tx, code) is used
     accessLevel  — Security Access level (default 0x01)
     vinDids      — explicit list of UDS DIDs to write the VIN to;
                    if absent, vinWriteDids(code) is used
     crc          — 'module-computed' (firmware recomputes on flash —
                    nothing to do) | 'ccitt-tail8' (we send CRC16-CCITT
                    of the last-8 VIN bytes alongside the write — used
                    today only by tabs that prebuild a payload) | 'none'
     unlockStatus — 'ready' | 'pending-w7' (algorithm not yet
                    translated — the W7 cipher tracking task #145)
     sgwRequired  — computed at runtime: vinHasSGW(vin) && tx !== 0x74F
     notes        — free-form

   The registry is intentionally a flat array keyed by tx:rx so duplicate
   addresses with different sources collapse into one row. Per-tab UIs
   (BCM/ECM/ADCM/RFHub) keep their bespoke flows for now; the universal
   ProgramAll UI is registry-driven. */

import {vinHasSGW} from './vin.js';

// ─── primary registry ──────────────────────────────────────────────────────
// Order matters for the UI: most-common bench modules first, then DVIN /
// PowerNet / SWARM-only oddballs. Anything marked `kind: 'no-vin'` is
// excluded from the Program-All checklist and rendered separately as a
// reference.
const ROWS = [
  // ── Powertrain (GPEC family) ──────────────────────────────────────────
  {code:'ECM',   name:'Engine Control Module',         tx:0x7E0, rx:0x7E8, kind:'vin-writable', unlockId:'gpec2',
    unlockChain:['gpec2','gpec2f','gpec2e','gpec3','gpec2a','gpec15','gpec1','ngc','sbec','jtec'],
    notes:'Primary PCM. 10-algorithm GPEC platform sweep (ECM tab parity).'},
  {code:'TCM',   name:'Transmission Control Module',   tx:0x7E1, rx:0x7E9, kind:'vin-writable', unlockId:'gpec2'},
  {code:'DTCM',  name:'Drive Train Control Module',    tx:0x7E2, rx:0x7EA, kind:'vin-writable', unlockId:'gpec2'},
  {code:'BPCM',  name:'Battery Pack Control Module',   tx:0x7E4, rx:0x7EC, kind:'vin-writable', unlockId:'gpec2'},

  // ── Body bus (CDA6 family) ────────────────────────────────────────────
  {code:'BCM',   name:'Body Control Module',           tx:0x750, rx:0x758, kind:'vin-writable', unlockId:'cda6',  notes:'CRC16-CCITT auto-calc; ALSO writes 0x6E2025 mirror.'},
  {code:'RFHUB', name:'RF Hub Module',                 tx:0x75F, rx:0x767, kind:'vin-writable', unlockId:'sbec',
    unlockChain:['sbec','cda6','alfa_ao','gpec2'],
    notes:'SBEC unlock per RfhubTab; ALSO writes 0x6E2027 mirror.'},
  {code:'ABS',   name:'Anti-lock Brake System',        tx:0x760, rx:0x768, kind:'vin-writable', unlockId:'cda6'},
  {code:'IPC',   name:'Instrument Panel Cluster',      tx:0x746, rx:0x766, kind:'vin-writable', unlockId:'sbec',
    unlockChain:['sbec','cda6'],
    notes:'RE-verified UDS addr 0x746/0x766. SBEC algo: key=(seed*4)+0x9018. Body code DID F10F. Legacy OBD addr 0x740/0x748 kept as IPC_OBD.'},
  {code:'IPC_OBD', name:'IPC (legacy OBD addr)',            tx:0x740, rx:0x748, kind:'vin-writable', unlockId:'cda6',
    notes:'Legacy OBD address for IPC. Use IPC (0x746/0x766) for UDS programming.'},
  {code:'ORC',   name:'Occupant Restraint Controller', tx:0x758, rx:0x760, kind:'vin-writable', unlockId:'cda6'},
  {code:'ADCM',  name:'Active Damping Module',         tx:0x7A8, rx:0x7B0, kind:'vin-writable', unlockId:'sbec',
    routinePreUnlock:0x0312, unlockChain:['sbec','cda6'],
    notes:'AdcmTab quirk: Routine 0x0312 first (engine pre-unlock), SBEC fallback.'},
  {code:'AMP',   name:'Audio Amplifier',               tx:0x7A0, rx:0x7A8, kind:'vin-writable', unlockId:'cda6'},
  {code:'BSM',   name:'Blind Spot Monitor',            tx:0x770, rx:0x778, kind:'vin-writable', unlockId:'cda6'},
  {code:'EPS',   name:'Electric Power Steering',       tx:0x761, rx:0x769, kind:'vin-writable', unlockId:'cda6',  notes:'Has 0x6EF190 mirror DID.'},
  {code:'RADIO', name:'Uconnect Radio',                tx:0x772, rx:0x77A, kind:'vin-writable', unlockId:'alfa_ao'},
  {code:'HVAC',  name:'HVAC Climate',                  tx:0x751, rx:0x759, kind:'vin-writable', unlockId:'cda6'},
  {code:'TPMS',  name:'Tire Pressure Monitoring',      tx:0x752, rx:0x75A, kind:'vin-writable', unlockId:'cda6'},
  {code:'SCCM',  name:'Steering Column Control',       tx:0x74D, rx:0x76D, kind:'vin-writable', unlockId:'cda6'},
  {code:'TIPM',  name:'Integrated Power Module',       tx:0x74C, rx:0x76C, kind:'vin-writable', unlockId:'t80'},
  {code:'SKREEM',name:'SKIM / SKREEM Immobilizer',     tx:0x75A, rx:0x77A, kind:'vin-writable', unlockId:'cda6'},

  // ── Secure Gateway — never written to directly ────────────────────────
  {code:'SGW',   name:'Security Gateway',              tx:0x74F, rx:0x76F, kind:'unsupported', unlockId:'xtea_sgw',
    notes:'SGW authenticates other writes; it does not store a VIN slot. Excluded from Program-All. Design decision documented in docs/SGW_VIN_STORAGE.md (Task #457).'},

  // ── Passive / no-VIN-slot modules (rendered for reference) ────────────
  // These respond on the bus but do not own a F190 DID per AlfaOBD's
  // catalog — programming them would either NRC 0x31 (request-out-of-range)
  // or silently no-op. The Program-All UI shows them in a separate panel
  // so techs know why they're skipped.
  {code:'BSM_RDR',  name:'Blind-Spot Radar Element',   tx:0x771, rx:0x779, kind:'no-vin',
    notes:'Passive radar — no VIN slot per AlfaOBD wrapper map.'},
  {code:'TPMS_SENS',name:'TPMS Wheel Sensor Array',    tx:0x718, rx:0x720, kind:'no-vin',
    notes:'Per-wheel passive sensor — VIN held by the parent TPMS.'},
  {code:'OCS_SENS', name:'Occupant Classification Sens',tx:0x728, rx:0x730, kind:'no-vin',
    notes:'Weight sensor — ORC owns the VIN slot.'},

  // ── W7 cipher pending (algorithm not yet translated, task #145) ───────
  // These ECUs respond and would otherwise be VIN-writable, but their
  // unlock requires the W7 cipher core which is being ported under
  // task #145. Listing them here lets techs see they are recognised but
  // intentionally gated.
  {code:'ECM_W7',   name:'ECM (W7 cipher variant)',    tx:0x7E5, rx:0x7ED, kind:'vin-writable',
    unlockId:'w7_ecm', accessLevel:0x03, unlockStatus:'pending-w7',
    notes:'AlfaOBD-mapped W7 PCM (e.g. some ICE Renegade/Compass). Awaiting cipher port.'},
  {code:'TCM_W7',   name:'TCM (W7 cipher variant)',    tx:0x7E6, rx:0x7EE, kind:'vin-writable',
    unlockId:'w7_tcm', accessLevel:0x03, unlockStatus:'pending-w7',
    notes:'W7 transmission controller — AlfaOBD wrapper present, cipher pending.'},
  {code:'BCM_W7',   name:'BCM (W7 hybrid)',            tx:0x7B2, rx:0x7BA, kind:'vin-writable',
    unlockId:'w7_bcm', accessLevel:0x03, unlockStatus:'pending-w7',
    notes:'Body controller variant on W7 platforms (newer Maserati). Pending W7 port.'},

  // ── DVIN-class / DarkVIN address aliases ──────────────────────────────
  {code:'BCM_DVIN',  name:'BCM (DarkVIN alt)',         tx:0x6B0, rx:0x6B8, kind:'vin-writable', unlockId:'cda6'},
  {code:'CCM',       name:'Climate Control Module',    tx:0x743, rx:0x763, kind:'vin-writable', unlockId:'cda6'},
  {code:'ADM',       name:'Active Dampening Module',   tx:0x744, rx:0x764, kind:'vin-writable', unlockId:'cda6'},
  {code:'IPCM',      name:'IPC (DVIN)',                tx:0x746, rx:0x766, kind:'vin-writable', unlockId:'cda6'},
  {code:'DDM',       name:'Driver Door Module',        tx:0x748, rx:0x768, kind:'vin-writable', unlockId:'cda6'},
  {code:'PDM',       name:'Passenger Door Module',     tx:0x749, rx:0x769, kind:'vin-writable', unlockId:'cda6'},
  {code:'EPS_ALT',   name:'EPS (alternate addr)',      tx:0x74A, rx:0x76A, kind:'vin-writable', unlockId:'cda6'},
  {code:'SCCM_ALT',  name:'Steering Column (alt)',     tx:0x74B, rx:0x76B, kind:'vin-writable', unlockId:'cda6'},
  {code:'TPMS_ALT',  name:'TPMS (alternate addr)',     tx:0x74E, rx:0x76E, kind:'vin-writable', unlockId:'cda6'},
  {code:'BCM_ALT',   name:'BCM (CLAUDE/alt addr)',     tx:0x742, rx:0x762, kind:'vin-writable', unlockId:'cda6'},
  {code:'IPC_ALT',   name:'IPC / SDM (alt addr)',      tx:0x745, rx:0x765, kind:'vin-writable', unlockId:'cda6'},
  {code:'RADIO_ALT', name:'Radio (alternate addr)',    tx:0x754, rx:0x75C, kind:'vin-writable', unlockId:'alfa_ao'},
  {code:'RADIO_753', name:'Radio (DVIN 0x753)',        tx:0x753, rx:0x773, kind:'vin-writable', unlockId:'alfa_ao'},

  // ── SWARM-class (broader scan inventory) ──────────────────────────────
  {code:'BCM_SWARM',  name:'BCM (swarm scanner)',      tx:0x7B0, rx:0x7B8, kind:'vin-writable', unlockId:'cda6'},
  {code:'IPC_SWARM',  name:'IPC (swarm)',              tx:0x720, rx:0x728, kind:'vin-writable', unlockId:'cda6'},
  {code:'RFHUB_SWARM',name:'RFHub (swarm 0x762)',      tx:0x762, rx:0x76A, kind:'vin-writable', unlockId:'cda6'},
  {code:'GWAY',       name:'Central Gateway',          tx:0x7C0, rx:0x7C8, kind:'unsupported', notes:'Gateway proxy — does not own a VIN slot.'},
  {code:'RADIO_SWARM',name:'Radio (swarm 0x7D0)',      tx:0x7D0, rx:0x7D8, kind:'vin-writable', unlockId:'alfa_ao'},
  {code:'ORC_SWARM',  name:'ORC (swarm 0x730)',        tx:0x730, rx:0x738, kind:'vin-writable', unlockId:'cda6'},
  {code:'REAR_AXLE',  name:'Rear Axle Controller',     tx:0x6C0, rx:0x6C8, kind:'vin-writable', unlockId:'cda6'},
  {code:'ACC',        name:'Adaptive Cruise',          tx:0x700, rx:0x708, kind:'vin-writable', unlockId:'cda6'},

  // ── PowerNet legacy ───────────────────────────────────────────────────
  {code:'BCM_PNET',   name:'BCM (PowerNet)',           tx:0x620, rx:0x628, kind:'vin-writable', unlockId:'cda6'},
  {code:'SKIM_PNET',  name:'SKIM (PowerNet)',          tx:0x741, rx:0x749, kind:'vin-writable', unlockId:'cda6'},
  {code:'RADIO_PNET', name:'Radio (PowerNet)',         tx:0x7C8, rx:0x7D0, kind:'vin-writable', unlockId:'alfa_ao'},
  {code:'HVAC_PNET',  name:'HVAC (PowerNet)',          tx:0x688, rx:0x690, kind:'vin-writable', unlockId:'cda6'},
];

// Dedupe by tx:rx — first row wins. Catches the cases where two source
// inventories described the same address (e.g. ORC at 0x758 vs 0x758).
const REGISTRY = (() => {
  const seen = new Set();
  const out = [];
  for (const r of ROWS) {
    const k = r.tx + ':' + r.rx;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      accessLevel: 0x01,
      crc: 'module-computed',
      unlockStatus: 'ready',
      ...r,
    });
  }
  return out;
})();

// Lookup by unique code.
const BY_CODE = (() => {
  const m = new Map();
  for (const r of REGISTRY) m.set(r.code, r);
  return m;
})();

// Lookup by tx address (returns the canonical row for that bus address).
const BY_TX = (() => {
  const m = new Map();
  for (const r of REGISTRY) if (!m.has(r.tx)) m.set(r.tx, r);
  return m;
})();

function getRegistry() { return REGISTRY.slice(); }
function getRow(code) { return BY_CODE.get(code) || null; }
function getRowByTx(tx) { return BY_TX.get(tx) || null; }
function vinWritableRows() { return REGISTRY.filter(r => r.kind === 'vin-writable'); }
function noVinRows() { return REGISTRY.filter(r => r.kind === 'no-vin'); }
function unsupportedRows() { return REGISTRY.filter(r => r.kind === 'unsupported'); }

// Compute SGW-routing requirement for a row + a candidate VIN.
// SGW (0x74F) itself is never "routed through SGW" — it IS the gateway.
// Anything else on a 2018+ FCA VIN must route through Autel for the gateway
// to authorize the write.
function sgwRequiredFor(row, vin) {
  if (!row || row.tx === 0x74F) return false;
  if (typeof vin !== 'string' || vin.length !== 17) return false;
  return vinHasSGW(vin);
}

// Partition the registry against a candidate VIN into the four UI buckets
// the Program-All page renders. The result is stable: the same VIN always
// produces the same partitioning.
function partitionForVin(vin) {
  const writable = [];
  const blockedBySgw = [];
  const pendingW7 = [];
  const noVin = [];
  const unsupported = [];
  for (const r of REGISTRY) {
    if (r.kind === 'no-vin') { noVin.push(r); continue; }
    if (r.kind === 'unsupported') { unsupported.push(r); continue; }
    const target = { ...r, sgwRequired: sgwRequiredFor(r, vin) };
    // W7-pending rows are STILL added to the writable bucket so the
    // batch runner can attempt them. They also appear in pendingW7 so
    // the UI can render the dedicated reference panel and surface the
    // expected outcome ("unlock will fail until task #145 lands").
    if (r.unlockStatus === 'pending-w7') pendingW7.push(target);
    if (target.sgwRequired) blockedBySgw.push(target);
    writable.push(target);
  }
  return { writable, blockedBySgw, pendingW7, noVin, unsupported };
}

export {
  REGISTRY,
  getRegistry,
  getRow,
  getRowByTx,
  vinWritableRows,
  noVinRows,
  unsupportedRows,
  sgwRequiredFor,
  partitionForVin,
};
