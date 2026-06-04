// Cross-tab signal for UDS 0x29 Authentication observations.
//
// Two record streams live here:
//
//   1. detections — modules that asked for 0x29 but we could not unlock
//      (Task #567, the original detect-and-refuse path). Surfaced as the
//      orange "UDS 0x29 DETECTED" banner in SeedTab and UnlockCoverageTab.
//
//   2. unlocks — modules where the 0x29 challenge/response handshake
//      completed successfully (Task #572). Surfaced as the green
//      "UDS 0x29 UNLOCKED" banner so the operator can see WHICH modules
//      went through the new path instead of legacy SecurityAccess (0x27).
//
// Both streams persist to localStorage so a tab refresh keeps the
// banners in sync. Subscribers fire on local writes only — callers that
// need cross-tab updates should also wire window.addEventListener('storage', …)
// against the keys exposed in AUTH29_STORAGE_KEYS.
//
// Task #573 — the detections stream is now ALSO POSTed to the API server
// (`/api/auth29-detections`) and rehydrated on first read so the bench
// remembers across browsers / shop laptops / bench tablets which
// modules on which VINs have moved to 0x29. localStorage is still the
// in-tab/offline cache so the banner survives an API outage and a
// reload doesn't wait on the network before painting.
//
// Detections storage shape (localStorage key 'srtlab.auth29.detections'):
//   [
//     { vin: 'JC1...', tx: 0x7E0, rx: 0x7E8, label: 'ECM', nrc: 0x33, t: 1714760000000 },
//     ...
//   ]
//
// Cap raised 16 → 64 for detections now that records aggregate
// fleet-wide; we still hold the youngest record per (vin, tx) pair so a
// long bench session — or several VINs in a row — doesn't blow the key
// into the kilobytes. The unlocks stream stays at 16 (single-bench
// signal, not server-persisted).

const KEY_DETECTIONS = 'srtlab.auth29.detections';
const KEY_UNLOCKS    = 'srtlab.auth29.unlocks';
const CAP_DETECTIONS = 64;
const CAP_UNLOCKS    = 16;
const SUBS = new Set();
const API_BASE = '/api/auth29-detections';

let serverHydrated = false;
let serverHydrating = null;

export const AUTH29_STORAGE_KEYS = Object.freeze({
  DETECTIONS: KEY_DETECTIONS,
  UNLOCKS:    KEY_UNLOCKS,
});

function readRaw(key){
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x === 'object' && Number.isFinite(x.tx));
  } catch { return []; }
}

function writeRaw(key, list, cap){
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(list.slice(-cap)));
  } catch { /* quota / privacy mode — non-fatal */ }
  for (const fn of SUBS){ try { fn(); } catch {} }
}

// Coalesce by (vin, tx, rx) — keeping the youngest entry — so the banner
// reflects current state rather than churning on every probe. VIN
// defaults to '' (unknown bench) and rx to 0 (unknown) which matches
// the server's composite PK rule.
function dedupeDetections(list){
  const m = new Map();
  for (const e of list){
    if (!e || !Number.isFinite(e.tx)) continue;
    const vin = typeof e.vin === 'string' ? e.vin : '';
    const rxKey = Number.isFinite(e.rx) ? (e.rx >>> 0) : 0;
    const key = `${vin}|${e.tx >>> 0}|${rxKey}`;
    const prev = m.get(key);
    if (!prev || (e.t || 0) >= (prev.t || 0)) m.set(key, e);
  }
  return Array.from(m.values()).sort((a, b) => (a.t || 0) - (b.t || 0));
}

// Ambient bench VIN. MasterVinProvider calls setCurrentBenchVin() when
// the operator enters / clears a VIN, and every flagAuth29Detected()
// callsite (algos.js, bridgeEngine.js, flasherStateMachine.js, etc.)
// auto-inherits it without needing the VIN plumbed through every
// internal helper signature. An explicit `vin` arg on flagAuth29Detected
// still wins.
let CURRENT_VIN = '';
export function setCurrentBenchVin(vin){
  CURRENT_VIN = typeof vin === 'string' ? vin.toUpperCase().slice(0, 32) : '';
}
export function getCurrentBenchVin(){ return CURRENT_VIN; }

function normalizeServerRow(row){
  if (!row || !Number.isFinite(row.tx)) return null;
  const t = row.detectedAt ? Date.parse(row.detectedAt) : Date.now();
  return {
    vin: typeof row.vin === 'string' ? row.vin : '',
    tx: row.tx | 0,
    rx: Number.isFinite(row.rx) ? (row.rx | 0) : null,
    label: typeof row.label === 'string' ? row.label : null,
    nrc: Number.isFinite(row.nrc) ? (row.nrc & 0xFF) : null,
    t: Number.isFinite(t) ? t : Date.now(),
  };
}

// --- detections -----------------------------------------------------------

export function getAuth29Detections(){
  return readRaw(KEY_DETECTIONS);
}

/**
 * Fetch the server-side detection set and merge it into local cache.
 * Returns the merged list. Safe to call repeatedly; subsequent calls
 * after the first successful hydration short-circuit unless `force` is
 * passed so React effects don't refetch on every render.
 */
export async function loadAuth29Detections({ vin, force } = {}){
  if (typeof fetch !== 'function') return readRaw(KEY_DETECTIONS);
  if (!force && serverHydrated && !vin) return readRaw(KEY_DETECTIONS);
  if (serverHydrating && !force) return serverHydrating;
  const url = vin
    ? `${API_BASE}?vin=${encodeURIComponent(vin)}`
    : API_BASE;
  serverHydrating = (async () => {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      const rows = Array.isArray(body && body.detections) ? body.detections : [];
      const fromServer = rows.map(normalizeServerRow).filter(Boolean);
      // Merge with whatever the local cache already has so an offline
      // detection from this session isn't blown away by a server fetch
      // that doesn't know about it yet.
      const merged = dedupeDetections([...readRaw(KEY_DETECTIONS), ...fromServer]);
      writeRaw(KEY_DETECTIONS, merged, CAP_DETECTIONS);
      serverHydrated = true;
      return merged;
    } catch {
      // Server unavailable — keep whatever we already have in cache.
      return readRaw(KEY_DETECTIONS);
    } finally {
      serverHydrating = null;
    }
  })();
  return serverHydrating;
}

/**
 * LOCAL-ONLY dismiss. Wipes this browser's cached detection list (so
 * the banner closes) but deliberately does NOT touch the server-side
 * fleet map — the next call to loadAuth29Detections() will re-hydrate
 * from the API. This is the right behavior for a banner DISMISS:
 * other workstations should still see the same history.
 *
 * Set `serverHydrated = false` so the next mount re-fetches instead of
 * short-circuiting on the in-memory "already hydrated" flag.
 */
export function clearAuth29Detections(){
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY_DETECTIONS); } catch {}
  serverHydrated = false;
  for (const fn of SUBS){ try { fn(); } catch {} }
}

/**
 * Explicit, scoped server-side clear — for an "admin" path that wants
 * to forget a recorded detection for one VIN (and optionally one
 * tx/rx pair). Called by no UI today; reserved for a future operator
 * action so the surface is documented.
 */
export function clearAuth29DetectionOnServer({ vin, tx, rx } = {}){
  if (typeof fetch !== 'function') return Promise.resolve();
  const v = typeof vin === 'string' ? vin.toUpperCase().slice(0, 32) : '';
  if (!v) return Promise.resolve();
  const params = new URLSearchParams({ vin: v });
  if (Number.isFinite(tx)) params.set('tx', String(tx | 0));
  if (Number.isFinite(rx)) params.set('rx', String(rx | 0));
  return fetch(`${API_BASE}?${params.toString()}`, { method: 'DELETE' })
    .catch(() => {});
}

/**
 * Record a confirmed 0x29 detection that we could NOT unlock. Coalesces
 * duplicates by (vin, tx) — the youngest record per ECU per VIN wins
 * so the banner reflects current state rather than churning on every
 * probe. Best-effort POST to the API server so other browsers /
 * machines see the same record (Task #573).
 */
export function flagAuth29Detected({ tx, rx, label, nrc, vin } = {}){
  if (!Number.isFinite(tx)) return;
  // Inherit the ambient bench VIN if the caller didn't pass one — this
  // is how every existing detection callsite (algos.js, bridgeEngine.js,
  // flasherStateMachine.js) becomes VIN-scoped without each having to
  // re-plumb the VIN through its internal helper signatures.
  const vinSrc = typeof vin === 'string' && vin ? vin : CURRENT_VIN;
  const vinNorm = typeof vinSrc === 'string' ? vinSrc.toUpperCase().slice(0, 32) : '';
  const entry = {
    vin: vinNorm,
    tx: tx | 0,
    rx: Number.isFinite(rx) ? (rx | 0) : null,
    label: typeof label === 'string' ? label : null,
    nrc: Number.isFinite(nrc) ? (nrc & 0xFF) : null,
    t: Date.now(),
  };
  const next = dedupeDetections([...readRaw(KEY_DETECTIONS), entry]);
  writeRaw(KEY_DETECTIONS, next, CAP_DETECTIONS);
  if (typeof fetch === 'function'){
    try {
      fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vin: entry.vin,
          tx: entry.tx,
          rx: entry.rx,
          label: entry.label,
          nrc: entry.nrc,
        }),
      }).catch(() => {});
    } catch {}
  }
}

// --- unlocks --------------------------------------------------------------

export function getAuth29Unlocks(){
  return readRaw(KEY_UNLOCKS);
}

export function clearAuth29Unlocks(){
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY_UNLOCKS); } catch {}
  for (const fn of SUBS){ try { fn(); } catch {} }
}

/**
 * Record a successful 0x29 challenge/response handshake. Like the
 * detections stream, the youngest record per tx-id wins. We also clear
 * the corresponding detection entry so a module that was previously
 * "detected but unsupported" stops showing the orange refusal banner
 * once we have a working handshake for it.
 */
export function flagAuth29Unlocked({ tx, rx, label, statusInfo } = {}){
  if (!Number.isFinite(tx)) return;
  const next = readRaw(KEY_UNLOCKS).filter((e) => e.tx !== tx);
  next.push({
    tx: tx | 0,
    rx: Number.isFinite(rx) ? (rx | 0) : null,
    label: typeof label === 'string' ? label : null,
    statusInfo: Number.isFinite(statusInfo) ? (statusInfo & 0xFF) : null,
    t: Date.now(),
  });
  // Clear any stale detection entry for the same tx-id — once we have an
  // unlock the orange "not yet supported" banner is wrong.
  try {
    const remaining = readRaw(KEY_DETECTIONS).filter((e) => (e.tx | 0) !== (tx | 0));
    if (typeof localStorage !== 'undefined'){
      if (remaining.length === 0) localStorage.removeItem(KEY_DETECTIONS);
      else localStorage.setItem(KEY_DETECTIONS, JSON.stringify(remaining.slice(-CAP_DETECTIONS)));
    }
  } catch {}
  writeRaw(KEY_UNLOCKS, next, CAP_UNLOCKS);
}

// --- subscriptions --------------------------------------------------------

/**
 * Subscribe to in-tab updates for either stream. Returns an unsubscribe fn.
 * Callers that need cross-tab updates should also wire
 * window.addEventListener('storage', …) for both AUTH29_STORAGE_KEYS values.
 */
export function subscribeAuth29(fn){
  if (typeof fn !== 'function') return () => {};
  SUBS.add(fn);
  return () => SUBS.delete(fn);
}
