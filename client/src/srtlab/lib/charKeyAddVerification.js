/* ============================================================================
 * charKeyAddVerification.js
 *
 * Records "this offline key-add path is bench-verified" confirmations produced
 * by the before/after self-check (CharRfhubKeyDiffPanel) so the Offline Key
 * Adder (CharRfhubKeyAdderPanel) can soften its permanent "NOT BENCH-VERIFIED"
 * caveat once a real clean single key-add pair has been confirmed.
 *
 * A confirmation is scoped by LAYOUT, not by VIN: a clean single-add pair proves
 * the layout's write path (slot rule + no companion regions), which is exactly
 * what the adder needs to trust. The only layout this panel supports today is
 * the MPC Charger/Challenger 8-slot key table (CHAR_MPC_8SLOT_LAYOUT).
 *
 * Persistence mirrors keyHistory.js: localStorage is an OFFLINE CACHE that
 * mirrors the api-server (`/api/key-add-verifications`), which is the canonical
 * cross-device source of truth. Server write-through is best-effort (silent on
 * failure); `refreshVerificationsFromServer(layout)` does the GET + first-run
 * migration of local-only rows + cache rewrite. These sibling endpoints use
 * plain fetch (no openapi codegen), same as the other history-sync features.
 *
 * Pure reducers (`buildVerification`, `isVerifiableCleanAdd`) operate on plain
 * objects so they can be unit-tested without a DOM.
 * ========================================================================== */

export const CHAR_MPC_8SLOT_LAYOUT = 'char-mpc-8slot';

export const KEY_ADD_VERIFY_KEY = 'srt-lab.charkeyadd.verifications.v1';
export const KEY_ADD_VERIFY_LIMIT_PER_LAYOUT = 50;

/* Per-layout first-run migration markers so local-only confirmations saved
 * before server sync existed get pushed up exactly once. */
export const KEY_ADD_VERIFY_MIGRATED_PREFIX = 'srt-lab.charkeyadd.verifications.migrated.';

/* Window event fired after a successful save/clear so sibling panels in the
 * same session react without waiting for a refresh. */
export const KEY_ADD_VERIFY_EVENT = 'srt-lab:char-key-add-verified';

const API_BASE = '/api/key-add-verifications';

const LAYOUT_RX = /^[A-Za-z0-9_.:-]{1,64}$/;

function normalizeLayout(layout) {
  if (typeof layout !== 'string') return '';
  const s = layout.trim();
  return LAYOUT_RX.test(s) ? s : '';
}

let __seq = 0;
function nextId() {
  __seq += 1;
  return `kav-${Date.now().toString(36)}-${__seq}`;
}

function intOrNull(v) {
  return Number.isInteger(v) ? v : null;
}

/* ── Pure verdict gate ───────────────────────────────────────────────────────
 * The single source of truth for "this diff proves a clean single key-add":
 * exactly one key added (none removed, master unchanged), landed in the
 * highest-free-slot the adder would pick, and nothing changed outside the key
 * table. CharRfhubKeyDiffPanel's overall banner and the save flow both use this
 * so they can never drift. */
export function isVerifiableCleanAdd(diff) {
  return !!diff
    && diff.ok === true
    && diff.isSingleKeyAdd === true
    && diff.addedSlotMatchesRule === true
    && Array.isArray(diff.companionRegions)
    && diff.companionRegions.length === 0
    && !diff.masterChanged;
}

/* Build a serializable confirmation record from a clean diff verdict. Returns
 * null when the diff does not pass isVerifiableCleanAdd (callers must never
 * persist a non-clean pair). */
export function buildVerification(diff, { layout = CHAR_MPC_8SLOT_LAYOUT, beforeName = '', afterName = '', id = null, confirmedAt = null } = {}) {
  if (!isVerifiableCleanAdd(diff)) return null;
  const added = diff.addedKeys[0] || {};
  return {
    id: id || nextId(),
    layout: normalizeLayout(layout) || CHAR_MPC_8SLOT_LAYOUT,
    addedKeyId: String(added.keyId || ''),
    slot: intOrNull(added.slot),
    slotIdx: intOrNull(added.slotIdx),
    expectedSlotIdx: intOrNull(diff.expectedSlotIdx),
    beforeKeyCount: intOrNull(diff.beforeKeyCount),
    afterKeyCount: intOrNull(diff.afterKeyCount),
    beforeName: String(beforeName || ''),
    afterName: String(afterName || ''),
    confirmedAt: Number.isFinite(confirmedAt) ? confirmedAt : Date.now(),
  };
}

/* Pure reducer: insert newest-first, cap, dedupe by id. */
export function upsertVerification(list, entry) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const idx = arr.findIndex((e) => e.id === entry.id);
  if (idx >= 0) arr[idx] = entry;
  else arr.push(entry);
  arr.sort((a, b) => (b.confirmedAt || 0) - (a.confirmedAt || 0));
  return arr.slice(0, KEY_ADD_VERIFY_LIMIT_PER_LAYOUT);
}

/* ── localStorage layer ──────────────────────────────────────────────────── */

function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY_ADD_VERIFY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    globalThis.localStorage?.setItem(KEY_ADD_VERIFY_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

function emitChanged(layout) {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(KEY_ADD_VERIFY_EVENT, { detail: { layout } }));
  } catch { /* non-DOM env — ignore */ }
}

/* ── server sync layer ───────────────────────────────────────────────────── */

function toServerBody(entry) {
  return {
    id: entry.id,
    layout: entry.layout,
    addedKeyId: entry.addedKeyId || '',
    slot: intOrNull(entry.slot),
    slotIdx: intOrNull(entry.slotIdx),
    expectedSlotIdx: intOrNull(entry.expectedSlotIdx),
    beforeKeyCount: intOrNull(entry.beforeKeyCount),
    afterKeyCount: intOrNull(entry.afterKeyCount),
    beforeName: entry.beforeName || '',
    afterName: entry.afterName || '',
    confirmedAt: Number.isFinite(entry.confirmedAt) ? entry.confirmedAt : Date.now(),
  };
}

function fromServerRow(row) {
  return {
    id: row.id,
    layout: String(row.layout || ''),
    addedKeyId: String(row.addedKeyId || ''),
    slot: intOrNull(row.slot),
    slotIdx: intOrNull(row.slotIdx),
    expectedSlotIdx: intOrNull(row.expectedSlotIdx),
    beforeKeyCount: intOrNull(row.beforeKeyCount),
    afterKeyCount: intOrNull(row.afterKeyCount),
    beforeName: String(row.beforeName || ''),
    afterName: String(row.afterName || ''),
    confirmedAt: Number.isFinite(row.confirmedAt) ? row.confirmedAt : Date.now(),
  };
}

function pushToServer(entry) {
  try {
    return fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toServerBody(entry)),
    }).catch(() => { /* offline — keep local only */ });
  } catch { /* ignore */ }
  return Promise.resolve();
}

/* Load the saved confirmations for a layout, newest-first. */
export function loadVerifications(layout = CHAR_MPC_8SLOT_LAYOUT) {
  const l = normalizeLayout(layout);
  if (!l) return [];
  const store = readStore();
  const list = Array.isArray(store[l]) ? store[l] : [];
  return list.slice().sort((a, b) => (b.confirmedAt || 0) - (a.confirmedAt || 0));
}

/* True when at least one clean confirmation exists for the layout. */
export function isLayoutVerified(layout = CHAR_MPC_8SLOT_LAYOUT) {
  return loadVerifications(layout).length > 0;
}

/* Persist a confirmation built from a clean diff verdict. Returns
 *   { ok, entry?, list?, error? }. */
export function saveVerification(diff, opts = {}) {
  const entry = buildVerification(diff, opts);
  if (!entry) {
    return { ok: false, error: 'This pair is not a clean single key-add, so it cannot be saved as bench evidence.' };
  }
  const store = readStore();
  const next = upsertVerification(store[entry.layout] || [], entry);
  store[entry.layout] = next;
  if (!writeStore(store)) return { ok: false, error: 'Could not write to local storage.' };
  pushToServer(entry);
  emitChanged(entry.layout);
  return { ok: true, entry, list: next };
}

/* Drop every saved confirmation for a layout. Returns { ok, list }. */
export function clearVerifications(layout = CHAR_MPC_8SLOT_LAYOUT) {
  const l = normalizeLayout(layout);
  if (!l) return { ok: false, error: 'invalid layout', list: [] };
  const store = readStore();
  delete store[l];
  if (!writeStore(store)) return { ok: false, error: 'Could not write to local storage.', list: [] };
  try {
    fetch(`${API_BASE}?layout=${encodeURIComponent(l)}`, { method: 'DELETE' })
      .catch(() => { /* best-effort */ });
  } catch { /* ignore */ }
  emitChanged(l);
  return { ok: true, list: [] };
}

/* Pull the canonical confirmations for a layout from the server, migrate any
 * local-only rows on first run, refresh the local cache, and return the merged
 * list (newest-first). Falls back to the local cache when the server is
 * unreachable. The migration marker is only set after every local candidate is
 * confirmed on the server, so a transient outage retries instead of stranding
 * local-only confirmations. */
export async function refreshVerificationsFromServer(layout = CHAR_MPC_8SLOT_LAYOUT) {
  const l = normalizeLayout(layout);
  if (!l) return [];

  let serverList = null;
  try {
    const res = await fetch(`${API_BASE}?layout=${encodeURIComponent(l)}`);
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j.entries)) serverList = j.entries.map(fromServerRow);
    }
  } catch { /* offline — keep local cache */ }

  if (!serverList) return loadVerifications(l);

  const ls = globalThis.localStorage;
  const migratedKey = `${KEY_ADD_VERIFY_MIGRATED_PREFIX}${l}`;
  const serverIds = new Set(serverList.map((e) => e.id));
  const localList = loadVerifications(l);
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
          body: JSON.stringify(toServerBody(entry)),
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
      const res = await fetch(`${API_BASE}?layout=${encodeURIComponent(l)}`);
      if (res.ok) {
        const j = await res.json();
        if (Array.isArray(j.entries)) serverList = j.entries.map(fromServerRow);
      }
    } catch { /* ignore */ }
  }

  const seen = new Set(serverList.map((e) => e.id));
  const merged = serverList.slice();
  for (const entry of localList) {
    if (entry?.id && !seen.has(entry.id)) {
      merged.push(entry);
      seen.add(entry.id);
    }
  }
  merged.sort((a, b) => (b.confirmedAt || 0) - (a.confirmedAt || 0));
  const normalized = merged.slice(0, KEY_ADD_VERIFY_LIMIT_PER_LAYOUT);

  const store = readStore();
  store[l] = normalized;
  writeStore(store);
  return normalized;
}
