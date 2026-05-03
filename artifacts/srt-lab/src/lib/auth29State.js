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
// Each stream is capped at 16 records, coalesced by tx-id (latest wins),
// and persisted to localStorage so a tab refresh keeps the banners in
// sync. Subscribers fire on local writes only — callers that need
// cross-tab updates should also wire window.addEventListener('storage', …)
// against the keys exposed here.

const KEY_DETECTIONS = 'srtlab.auth29.detections';
const KEY_UNLOCKS    = 'srtlab.auth29.unlocks';
const CAP = 16;
const SUBS = new Set();

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

function writeRaw(key, list){
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(list.slice(-CAP)));
  } catch { /* quota / privacy mode — non-fatal */ }
  for (const fn of SUBS){ try { fn(); } catch {} }
}

// --- detections -----------------------------------------------------------

export function getAuth29Detections(){
  return readRaw(KEY_DETECTIONS);
}

export function clearAuth29Detections(){
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY_DETECTIONS); } catch {}
  for (const fn of SUBS){ try { fn(); } catch {} }
}

/**
 * Record a confirmed 0x29 detection that we could NOT unlock. Coalesces
 * duplicates by tx-id — the youngest record per ECU wins so the banner
 * reflects current state rather than churning on every probe.
 */
export function flagAuth29Detected({ tx, rx, label, nrc } = {}){
  if (!Number.isFinite(tx)) return;
  const next = readRaw(KEY_DETECTIONS).filter((e) => e.tx !== tx);
  next.push({
    tx: tx | 0,
    rx: Number.isFinite(rx) ? (rx | 0) : null,
    label: typeof label === 'string' ? label : null,
    nrc: Number.isFinite(nrc) ? (nrc & 0xFF) : null,
    t: Date.now(),
  });
  writeRaw(KEY_DETECTIONS, next);
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
    const remaining = readRaw(KEY_DETECTIONS).filter((e) => e.tx !== (tx | 0));
    if (typeof localStorage !== 'undefined'){
      if (remaining.length === 0) localStorage.removeItem(KEY_DETECTIONS);
      else localStorage.setItem(KEY_DETECTIONS, JSON.stringify(remaining.slice(-CAP)));
    }
  } catch {}
  writeRaw(KEY_UNLOCKS, next);
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
