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

/* Per-VIN first-run migration markers live under this prefix so local-only
 * history saved before server sync existed gets pushed up exactly once. */
export const KEY_HISTORY_MIGRATED_PREFIX = 'srt-lab.keywriter.keyhistory.migrated.';

/* Server endpoint. localStorage is an offline cache that mirrors this store;
 * the server is the canonical cross-device source of truth. */
const API_BASE = '/api/key-history';

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

/* ── server sync layer ───────────────────────────────────────────────────── */

/* Shape a stored entry into the JSON the server route expects. The server
 * scopes by VIN, so the VIN rides along in the body. */
function toServerBody(vin, entry) {
  return {
    id: entry.id,
    vin,
    chipId: entry.chipId,
    uidHex: entry.uidHex || '',
    skHex: entry.skHex || '',
    flags: entry.flags || null,
    label: entry.label || '',
    slotIdx: Number.isInteger(entry.slotIdx) ? entry.slotIdx : null,
    capturedAt: Number.isFinite(entry.capturedAt) ? entry.capturedAt : Date.now(),
  };
}

/* Normalize a server row back into the local entry shape. The server returns
 * capturedAt as epoch ms, matching makeHistoryEntry's numeric field. */
function fromServerRow(row) {
  return {
    id: row.id,
    chipId: row.chipId,
    uidHex: String(row.uidHex || ''),
    skHex: String(row.skHex || ''),
    flags: row.flags ? { ...row.flags } : null,
    label: String(row.label || ''),
    slotIdx: Number.isInteger(row.slotIdx) ? row.slotIdx : null,
    capturedAt: Number.isFinite(row.capturedAt) ? row.capturedAt : Date.now(),
  };
}

/* Best-effort write-through to the server. Failures are silent — the local
 * cache is the synchronous source of truth, and `refreshKeyHistoryFromServer`
 * retries stranded entries on the next refresh via the migration sweep. */
function pushToServer(vin, entry) {
  try {
    return fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toServerBody(vin, entry)),
    }).catch(() => { /* offline — keep local only */ });
  } catch { /* ignore */ }
  return Promise.resolve();
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
  // Best-effort write-through so the key shows up on other devices for this VIN.
  pushToServer(v, stored);
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
  try {
    fetch(`${API_BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .catch(() => { /* best-effort; writeStore already won locally */ });
  } catch { /* ignore */ }
  return { ok: true, list: next };
}

/* Drop every saved key for a VIN. Returns { ok, list }. */
export function clearKeyHistory(vin) {
  const v = normalizeVin(vin);
  if (!v) return { ok: false, error: 'invalid VIN', list: [] };
  const store = readStore();
  delete store[v];
  if (!writeStore(store)) return { ok: false, error: 'Could not write to local storage.', list: [] };
  try {
    fetch(`${API_BASE}?vin=${encodeURIComponent(v)}`, { method: 'DELETE' })
      .catch(() => { /* best-effort */ });
  } catch { /* ignore */ }
  return { ok: true, list: [] };
}


/* ── Whole-key-set wrapper export / import (Task #992) ────────────────────────
 * The history layer above lets an operator save and re-load keys one at a time.
 * For handoff, a tech needs to ship a car's *entire* key set as a single file
 * and re-import it on another bench. This mirrors the "EXPORT ALL" baseline
 * wrapper pattern (J2534Scanner.jsx): a typed/versioned envelope whose entries
 * deliberately drop their ids so a re-import mints fresh ones (no collisions),
 * even when imported into an already-populated history. */

export const KEY_HISTORY_EXPORT_TYPE = 'srtlab.keywriter.keyhistory';
export const KEY_HISTORY_EXPORT_VERSION = 1;

/* Normalize one stored history row into a portable wrapper entry, stripping the
 * id so the importer can mint a fresh one. */
function toWrapperEntry(e) {
  return {
    chipId: e?.chipId,
    uidHex: String(e?.uidHex || ''),
    skHex: String(e?.skHex || ''),
    flags: e?.flags ? { ...e.flags } : null,
    label: String(e?.label || ''),
    slotIdx: Number.isInteger(e?.slotIdx) ? e.slotIdx : null,
    capturedAt: Number.isFinite(e?.capturedAt) ? e.capturedAt : null,
  };
}

/* Pure builder: bundle a VIN's full key list into one serializable wrapper.
 * Ids are deliberately omitted from `keys` so re-import never collides. */
export function buildKeyHistoryExport(vin, list) {
  const arr = Array.isArray(list) ? list : [];
  return {
    type: KEY_HISTORY_EXPORT_TYPE,
    version: KEY_HISTORY_EXPORT_VERSION,
    exportedAt: Date.now(),
    vin: normalizeVin(vin),
    keys: arr.map(toWrapperEntry),
  };
}

/* Pure parser: accept the wrapper object, a JSON string of it, or a bare array
 * of entries. Returns the list of id-less entries ready to be re-minted.
 * Throws on malformed JSON, an unrelated wrapper type, or a shape with no keys.
 */
export function parseKeyHistoryImport(input) {
  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { throw new Error('Not valid JSON.'); }
  }
  let candidates = [];
  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (parsed && Array.isArray(parsed.keys)) {
    if (parsed.type && parsed.type !== KEY_HISTORY_EXPORT_TYPE) {
      throw new Error(`Unrecognized export type "${parsed.type}".`);
    }
    candidates = parsed.keys;
  } else {
    throw new Error('JSON does not look like a key-history export.');
  }
  const out = [];
  for (const c of candidates) {
    if (!c || !c.chipId) continue;
    out.push(toWrapperEntry(c));
  }
  if (!out.length) throw new Error('No keys found in the key-history export.');
  return out;
}

/* localStorage wrapper: import a key-set wrapper into a VIN's history. Each
 * entry is re-built through makeHistoryEntry (fresh id) and folded in with the
 * same upsert/dedupe/cap reducer used by single saves, so importing into a
 * populated history never produces id collisions or duplicate chip+UID rows.
 * Returns { ok, list?, imported?, error? }. */
export function importKeyHistory(vin, input) {
  const v = normalizeVin(vin);
  if (!v) return { ok: false, error: 'A valid 17-char Master VIN is required to import key history.' };
  let records;
  try {
    records = parseKeyHistoryImport(input);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const store = readStore();
  let next = Array.isArray(store[v]) ? store[v] : [];
  for (const r of records) {
    const entry = makeHistoryEntry(r);
    next = upsertEntry(next, entry);
    // Task #991 Enhancement: push each newly-imported entry to the server
    // Best-effort write-through so imported keys propagate cross-device.
    pushToServer(v, entry);
  }
  store[v] = next;
  if (!writeStore(store)) return { ok: false, error: 'Could not write to local storage.' };
  return { ok: true, list: next, imported: records.length };
}

/* Pull the canonical history for a VIN from the server, migrate any local-only
 * entries on first run, refresh the local cache, and return the merged list
 * (newest-first). Safe to call repeatedly. Falls back to the local cache
 * unchanged when the server is unreachable or the VIN is invalid.
 *
 * The first-run migration marker is per-VIN and is only set after every local
 * candidate is confirmed on the server — a transient outage leaves it unset so
 * the next refresh retries, and never strands local-only keys. */
export async function refreshKeyHistoryFromServer(vin) {
  const v = normalizeVin(vin);
  if (!v) return [];

  let serverList = null;
  try {
    const res = await fetch(`${API_BASE}?vin=${encodeURIComponent(v)}`);
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j.entries)) serverList = j.entries.map(fromServerRow);
    }
  } catch { /* offline — keep local cache */ }

  if (!serverList) return loadKeyHistory(v);

  const ls = globalThis.localStorage;
  const migratedKey = `${KEY_HISTORY_MIGRATED_PREFIX}${v}`;
  const serverIds = new Set(serverList.map((e) => e.id));
  const localList = loadKeyHistory(v);
  let migrated = false;

  let alreadyMigrated = false;
  try { alreadyMigrated = !!ls?.getItem(migratedKey); } catch { /* ignore */ }

  if (!alreadyMigrated) {
    let anyFailure = false;
    for (const entry of localList) {
      if (!entry?.id || serverIds.has(entry.id)) continue;
      let ok = false;
      try {
        const res = await fetch(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(toServerBody(v, entry)),
        });
        if (res.ok) { serverIds.add(entry.id); migrated = true; ok = true; }
      } catch { /* network error — retry next refresh */ }
      if (!ok) anyFailure = true;
    }
    if (!anyFailure) {
      try { ls?.setItem(migratedKey, new Date().toISOString()); } catch { /* ignore */ }
    }
  }

  if (migrated) {
    try {
      const res = await fetch(`${API_BASE}?vin=${encodeURIComponent(v)}`);
      if (res.ok) {
        const j = await res.json();
        if (Array.isArray(j.entries)) serverList = j.entries.map(fromServerRow);
      }
    } catch { /* ignore */ }
  }

  // Merge: server rows + any local-only entries that did NOT make it up, so a
  // partial migration failure never wipes them from the cache.
  const seen = new Set(serverList.map((e) => e.id));
  const merged = serverList.slice();
  for (const entry of localList) {
    if (entry?.id && !seen.has(entry.id)) {
      merged.push(entry);
      seen.add(entry.id);
    }
  }
  merged.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
  const normalized = merged.slice(0, KEY_HISTORY_LIMIT_PER_VIN);

  const store = readStore();
  store[v] = normalized;
  writeStore(store);
  return normalized;

}