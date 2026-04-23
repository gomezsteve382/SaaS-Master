/* ============================================================================
 * keyProgArchiveHistory.js — log of every Key Prog ZIP a user has downloaded
 * from the wizard (Tasks #392, #394).
 *
 * Entries are persisted server-side via /api/key-prog-archives so the SAVED
 * ARCHIVES list survives across browsers, machines, and cleared site data —
 * matching the round-trip pattern used by `audit.js` (module backups) and
 * `diffReports.js`. localStorage is kept as an offline cache so the UI can
 * render synchronously while the server fetch is in flight.
 *
 * Storage shape (under STORAGE_KEY):
 *   { version: 1, archives: [
 *     { id, vin, zipName, savedAt,
 *       bcmSec16: { source, label, blank, offsetHex, beHex } | null }
 *   ]}
 *
 * Newest first; capped at MAX_ARCHIVES so localStorage doesn't grow unbounded.
 * ========================================================================== */

export const STORAGE_KEY = 'srtlab.keyprog.archives.v1';
export const MIGRATED_KEY = 'srtlab.keyprog.archives.migrated.v1';
export const MAX_ARCHIVES = 100;
export const ARCHIVE_TYPE = 'srtlab_keyprog_archive_v1';
const API_BASE = '/api/key-prog-archives';

function getStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch { /* SSR / disabled */ }
  return null;
}

function newId() {
  return 'kpa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function notify() {
  try { window.dispatchEvent(new Event('srtlab:keyProgArchives')); } catch { /* ignore */ }
}

export function loadArchives() {
  const ls = getStorage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.archives)) return [];
    return parsed.archives;
  } catch {
    return [];
  }
}

function writeArchives(archives) {
  const ls = getStorage();
  if (!ls) return false;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify({ version: 1, archives }));
    return true;
  } catch {
    return false;
  }
}

/* Trim a `formatBcmSec16Provenance` result down to the small, JSON-safe
 * subset we actually need to render history rows. Returns null when nothing
 * usable was captured (older saves, or a non-BCM-aware download path). */
function snapshotProvenance(prov) {
  if (!prov) return null;
  return {
    source: prov.source ?? null,
    label: prov.label ?? '(no SEC16 source)',
    blank: !!prov.blank,
    offsetHex: prov.offsetHex ?? null,
    beHex: prov.beHex ?? null,
  };
}

/* Best-effort write-through to the server. Failures are silent — the local
 * cache is the synchronous source of truth, and `refreshArchivesFromServer`
 * will retry stranded entries on the next refresh via the migration sweep. */
function pushToServer(entry) {
  try {
    return fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }).catch(() => { /* offline — keep local only */ });
  } catch { /* ignore */ }
  return Promise.resolve();
}

export function recordArchive({ vin, zipName, bcmSec16, savedAt }) {
  const entry = {
    id: newId(),
    vin: vin || '',
    zipName: zipName || '',
    savedAt: savedAt || new Date().toISOString(),
    bcmSec16: snapshotProvenance(bcmSec16),
  };
  const next = [entry, ...loadArchives()].slice(0, MAX_ARCHIVES);
  writeArchives(next);
  pushToServer(entry);
  notify();
  return entry;
}

export function deleteArchive(id) {
  const next = loadArchives().filter((a) => a.id !== id);
  writeArchives(next);
  fetch(API_BASE + '/' + encodeURIComponent(id), { method: 'DELETE' })
    .catch(() => { /* best-effort; will not reappear because writeArchives wins locally */ });
  notify();
  return next;
}

export function clearArchives() {
  writeArchives([]);
  fetch(API_BASE, { method: 'DELETE' }).catch(() => { /* best-effort */ });
  notify();
  return [];
}

export function subscribeArchives(handler) {
  const listener = () => handler();
  window.addEventListener('srtlab:keyProgArchives', listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener('srtlab:keyProgArchives', listener);
    window.removeEventListener('storage', listener);
  };
}

/* Pulls the canonical list from the server, migrates any local-only entries
 * on first run, and refreshes the local cache so loadArchives() is up to
 * date. Safe to call repeatedly; returns the merged list (or the local cache
 * unchanged when the server is unreachable). */
export async function refreshArchivesFromServer() {
  const ls = getStorage();

  let serverList = null;
  try {
    const res = await fetch(API_BASE);
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j.archives)) serverList = j.archives;
    }
  } catch { /* offline; keep local cache */ }

  if (!serverList) return loadArchives();

  // First-run migration: push any local-only entries up to the server so
  // archives saved before this sync existed don't disappear when the server
  // list overwrites the cache. The migration marker is only set after every
  // candidate succeeds — partial failures leave it unset AND keep the
  // failed entries in the local cache so the next refresh can retry them.
  // Without that guarantee a transient outage during the first refresh
  // would silently strand local-only archives.
  const serverIds = new Set(serverList.map((a) => a.id));
  const localList = loadArchives();
  let migrated = false;
  const unsynced = []; // local-only entries that did NOT make it to the server
  if (ls && !ls.getItem(MIGRATED_KEY)) {
    let anyFailure = false;
    for (const entry of localList) {
      if (!entry?.id) continue;
      if (serverIds.has(entry.id)) continue;
      let ok = false;
      try {
        const res = await fetch(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
        if (res.ok) { serverIds.add(entry.id); migrated = true; ok = true; }
      } catch { /* network error — retry on next refresh */ }
      if (!ok) {
        anyFailure = true;
        unsynced.push(entry);
      }
    }
    if (!anyFailure) {
      try { ls.setItem(MIGRATED_KEY, new Date().toISOString()); } catch { /* ignore */ }
    }
  }

  if (migrated) {
    try {
      const res = await fetch(API_BASE);
      if (res.ok) {
        const j = await res.json();
        if (Array.isArray(j.archives)) serverList = j.archives;
      }
    } catch { /* ignore */ }
  }

  const fromServer = serverList.map((a) => ({
    id: a.id,
    vin: a.vin || '',
    zipName: a.zipName || '',
    savedAt: a.savedAt || null,
    bcmSec16: a.bcmSec16 ?? null,
  }));

  // Merge unsynced local-only entries back in so a partial migration
  // failure never wipes them from the cache. The retry loop above will
  // try them again on the next refresh until the marker can be set.
  const seen = new Set(fromServer.map((a) => a.id));
  for (const entry of unsynced) {
    if (!seen.has(entry.id)) {
      fromServer.push(entry);
      seen.add(entry.id);
    }
  }

  fromServer.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  const normalized = fromServer.slice(0, MAX_ARCHIVES);

  writeArchives(normalized);
  notify();
  return normalized;
}

/* Build an export bundle of every archive currently in the local cache.
 * Used by the Backups tab "Export all" so saved Key Prog history rides along
 * with module backups when a tech moves shops. */
export function exportArchives() {
  const archives = loadArchives();
  return {
    type: ARCHIVE_TYPE,
    version: 1,
    exportedAt: new Date().toISOString(),
    count: archives.length,
    archives,
  };
}

/* Merge an exported bundle (or a backup-archive bundle that embeds one) back
 * into the local cache and the server. Duplicates by id are skipped so
 * re-importing the same file is a no-op. Returns counts for the caller. */
export function importArchives(bundle) {
  const result = { imported: 0, skipped: 0, invalid: 0 };
  if (!bundle) return result;

  let entries = null;
  if (Array.isArray(bundle.keyProgArchives)) {
    entries = bundle.keyProgArchives;
  } else if (bundle.type === ARCHIVE_TYPE && Array.isArray(bundle.archives)) {
    entries = bundle.archives;
  }
  if (!Array.isArray(entries)) return result;

  const existing = loadArchives();
  const existingIds = new Set(existing.map((a) => a.id));
  const merged = existing.slice();

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
      result.invalid++;
      continue;
    }
    if (existingIds.has(raw.id)) { result.skipped++; continue; }
    const entry = {
      id: raw.id,
      vin: raw.vin || '',
      zipName: raw.zipName || '',
      savedAt: raw.savedAt || new Date().toISOString(),
      bcmSec16: raw.bcmSec16 ?? null,
    };
    merged.push(entry);
    existingIds.add(entry.id);
    pushToServer(entry);
    result.imported++;
  }

  if (result.imported > 0) {
    merged.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    writeArchives(merged.slice(0, MAX_ARCHIVES));
    notify();
  }
  return result;
}
