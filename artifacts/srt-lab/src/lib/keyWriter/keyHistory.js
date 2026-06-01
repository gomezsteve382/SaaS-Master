/* ============================================================================
 * keyHistory.js — Task #986
 *
 * Per-vehicle "keys on file" history for the standalone Key Dump card.
 *
 * The Key Dump card (KeyWriterTab.jsx) captures individual transponder reads
 * (chip family, UID, SK, flags) but, until now, those reads evaporated when
 * the operator moved on. A locksmith working several keys for the same car
 * needs a persistent, at-a-glance list of every key captured for a VIN so
 * they can confirm how many keys exist and which RFHUB slot each maps to
 * before cloning a spare.
 *
 * This module is the persistence layer: a localStorage-backed store keyed by
 * the active Master VIN. Each saved entry carries the full captured record so
 * it can be re-loaded into the Key Dump card later for re-export or
 * clone-on-bench.
 *
 * ┌──────────────────────────── SK persistence ─────────────────────────────┐
 * │ Entries keep the per-transponder SK so a re-load can re-export the key    │
 * │ dump. SK is the chip secret the operator's external tool calculated — it  │
 * │ is NEVER the 16-byte RFHUB SEC16 master secret. SEC16 is never written    │
 * │ into a history entry (the Key Dump card has no SK==SEC16 path).           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The pure reducers (`upsertEntry`, `removeEntryById`) operate on plain arrays
 * so they can be unit-tested without a DOM; the localStorage wrappers
 * (`loadKeyHistory`, `saveKeyToHistory`, …) layer persistence on top.
 * ========================================================================== */

export const KEY_HISTORY_KEY = 'srt-lab.keywriter.keyhistory.v1';
export const KEY_HISTORY_LIMIT_PER_VIN = 50;

const VIN_RX = /^[A-HJ-NPR-Z0-9]{17}$/;

/* Normalize a VIN the same way MasterVinContext does (uppercase, no
 * whitespace). Returns '' for anything that is not a 17-char VIN so callers
 * never key the store under a partial/garbage VIN. */
export function normalizeVin(vin) {
  if (typeof vin !== 'string') return '';
  const v = vin.toUpperCase().replace(/\s/g, '');
  return VIN_RX.test(v) ? v : '';
}

let __seq = 0;
function nextId() {
  __seq += 1;
  return `keyh-${Date.now().toString(36)}-${__seq}`;
}

/* Compact, case-insensitive UID used for de-duplication: two captures of the
 * same physical chip (same chip family + UID) should update one row, not
 * stack up duplicates every time the operator re-saves. */
function dedupeKey(entry) {
  const uid = String(entry?.uidHex || '').replace(/[\s:_-]/g, '').toUpperCase();
  const chip = String(entry?.chipId || '').toLowerCase();
  return `${chip}|${uid}`;
}

/* Build a normalized, serializable history entry from a captured key record.
 * Assigns an id + capturedAt when absent. `slotIdx` is the 0-based RFHUB slot
 * the capture was associated with (null when captured with no RFHUB loaded). */
export function makeHistoryEntry({
  chipId,
  uidHex = '',
  skHex = '',
  flags = null,
  label = '',
  slotIdx = null,
  id = null,
  capturedAt = null,
} = {}) {
  return {
    id: id || nextId(),
    chipId,
    uidHex: String(uidHex || ''),
    skHex: String(skHex || ''),
    flags: flags ? { ...flags } : null,
    label: String(label || ''),
    slotIdx: Number.isInteger(slotIdx) ? slotIdx : null,
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : Date.now(),
  };
}

/* Pure reducer: insert `entry`, or update the existing same-chip+UID row in
 * place (preserving its id, refreshing the rest + capturedAt). Returns a new
 * array sorted newest-first and capped at KEY_HISTORY_LIMIT_PER_VIN. */
export function upsertEntry(list, entry) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const key = dedupeKey(entry);
  const idx = arr.findIndex((e) => dedupeKey(e) === key);
  if (idx >= 0) {
    arr[idx] = { ...entry, id: arr[idx].id };
  } else {
    arr.push(entry);
  }
  arr.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
  return arr.slice(0, KEY_HISTORY_LIMIT_PER_VIN);
}

/* Pure reducer: drop the entry with the given id. */
export function removeEntryById(list, id) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e.id !== id);
}

/* ── localStorage layer ──────────────────────────────────────────────────── */

function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY_HISTORY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    globalThis.localStorage?.setItem(KEY_HISTORY_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/* Load the saved keys for a VIN, newest-first. Returns [] for an invalid VIN
 * or when nothing has been saved yet. */
export function loadKeyHistory(vin) {
  const v = normalizeVin(vin);
  if (!v) return [];
  const store = readStore();
  const list = Array.isArray(store[v]) ? store[v] : [];
  return list
    .slice()
    .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
}

/* Persist a captured key under a VIN. Returns
 *   { ok, entry?, list?, error? }
 * `entry` is the normalized stored record; `list` is the refreshed history. */
export function saveKeyToHistory(vin, raw) {
  const v = normalizeVin(vin);
  if (!v) return { ok: false, error: 'A valid 17-char Master VIN is required to save key history.' };
  const entry = makeHistoryEntry(raw);
  if (!entry.chipId) return { ok: false, error: 'Key record has no chip family.' };
  const store = readStore();
  const next = upsertEntry(store[v] || [], entry);
  store[v] = next;
  if (!writeStore(store)) return { ok: false, error: 'Could not write to local storage.' };
  // Return the actual stored row: an upsert over an existing chip+UID preserves
  // the original id, so re-read it from `next` rather than handing back the
  // pre-dedupe `entry` (whose id may differ).
  const stored = next.find((e) => dedupeKey(e) === dedupeKey(entry)) || entry;
  return { ok: true, entry: stored, list: next };
}

/* Drop a single saved key. Returns { ok, list }. */
export function removeKeyFromHistory(vin, id) {
  const v = normalizeVin(vin);
  if (!v) return { ok: false, error: 'invalid VIN', list: [] };
  const store = readStore();
  const next = removeEntryById(store[v] || [], id);
  store[v] = next;
  if (!writeStore(store)) return { ok: false, error: 'Could not write to local storage.', list: next };
  return { ok: true, list: next };
}

/* Drop every saved key for a VIN. Returns { ok, list }. */
export function clearKeyHistory(vin) {
  const v = normalizeVin(vin);
  if (!v) return { ok: false, error: 'invalid VIN', list: [] };
  const store = readStore();
  delete store[v];
  if (!writeStore(store)) return { ok: false, error: 'Could not write to local storage.', list: [] };
  return { ok: true, list: [] };
}
