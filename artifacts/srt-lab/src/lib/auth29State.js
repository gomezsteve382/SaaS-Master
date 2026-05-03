// Cross-tab signal for "we observed a module asking for UDS 0x29
// Authentication" (Task #567). The detector writes a small record
// here when it confirms 0x29 is required; SeedTab and UnlockCoverageTab
// subscribe so a banner lights up explaining why the unlock will not run.
//
// Storage shape (localStorage key 'srtlab.auth29.detections'):
//   [
//     { tx: 0x7E0, rx: 0x7E8, label: 'ECM', nrc: 0x33, t: 1714760000000 },
//     ...
//   ]
//
// We keep the latest N (cap = 16) and hold the youngest record per
// tx-id so a long bench session doesn't blow the key into the kilobytes.

const KEY = 'srtlab.auth29.detections';
const CAP = 16;
const SUBS = new Set();

function readRaw(){
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x === 'object' && Number.isFinite(x.tx));
  } catch { return []; }
}

function writeRaw(list){
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, JSON.stringify(list.slice(-CAP)));
  } catch { /* quota / privacy mode — non-fatal */ }
  for (const fn of SUBS){ try { fn(); } catch {} }
}

export function getAuth29Detections(){
  return readRaw();
}

export function clearAuth29Detections(){
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY); } catch {}
  for (const fn of SUBS){ try { fn(); } catch {} }
}

/**
 * Record a confirmed 0x29 detection. Coalesces duplicates by tx-id —
 * the youngest record per ECU wins so the banner reflects current state
 * rather than churning on every probe.
 */
export function flagAuth29Detected({ tx, rx, label, nrc } = {}){
  if (!Number.isFinite(tx)) return;
  const next = readRaw().filter((e) => e.tx !== tx);
  next.push({
    tx: tx | 0,
    rx: Number.isFinite(rx) ? (rx | 0) : null,
    label: typeof label === 'string' ? label : null,
    nrc: Number.isFinite(nrc) ? (nrc & 0xFF) : null,
    t: Date.now(),
  });
  writeRaw(next);
}

/**
 * Subscribe to in-tab updates. Returns an unsubscribe fn. Does NOT
 * cover cross-tab storage events on its own — callers that need that
 * should also wire window.addEventListener('storage', ...).
 */
export function subscribeAuth29(fn){
  if (typeof fn !== 'function') return () => {};
  SUBS.add(fn);
  return () => SUBS.delete(fn);
}
