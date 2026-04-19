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
  {code:'ECM',   name:'Engine Control Module',         tx:0x7E0, rx:0x7E8, kind:'vin-writable', unlockId:'gpec2', notes:'Primary PCM. ECM tab auto-tries 10 algorithms.'},
  {code:'TCM',   name:'Transmission Control Module',   tx:0x7E1, rx:0x7E9, kind:'vin-writable', unlockId:'gpec2'},
  {code:'DTCM',  name:'Drive Train Control Module',    tx:0x7E2, rx:0x7EA, kind:'vin-writable', unlockId:'gpec2'},
  {code:'BPCM',  name:'Battery Pack Control Module',   tx:0x7E4, rx:0x7EC, kind:'vin-writable', unlockId:'gpec2'},

  // ── Body bus (CDA6 family) ────────────────────────────────────────────
  {code:'BCM',   name:'Body Control Module',           tx:0x750, rx:0x758, kind:'vin-writable', unlockId:'cda6',  notes:'CRC16-CCITT auto-calc; ALSO writes 0x6E2025 mirror.'},
  {code:'RFHUB', name:'RF Hub Module',                 tx:0x75F, rx:0x767, kind:'vin-writable', unlockId:'cda6',  notes:'SBEC unlock per RfhubTab; ALSO writes 0x6E2027 mirror.'},
  {code:'ABS',   name:'Anti-lock Brake System',        tx:0x760, rx:0x768, kind:'vin-writable', unlockId:'cda6'},
  {code:'IPC',   name:'Instrument Panel Cluster',      tx:0x740, rx:0x748, kind:'vin-writable', unlockId:'cda6'},
  {code:'ORC',   name:'Occupant Restraint Controller', tx:0x758, rx:0x760, kind:'vin-writable', unlockId:'cda6'},
  {code:'ADCM',  name:'Active Damping Module',         tx:0x7A8, rx:0x7B0, kind:'vin-writable', unlockId:'cda6',  notes:'AdcmTab uses Routine 0x0312 (try first) then SBEC fallback.'},
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
    notes:'SGW authenticates other writes; it does not store a VIN slot. Excluded from Program-All.'},

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
    if (r.unlockStatus === 'pending-w7') { pendingW7.push(r); continue; }
    const target = { ...r, sgwRequired: sgwRequiredFor(r, vin) };
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
