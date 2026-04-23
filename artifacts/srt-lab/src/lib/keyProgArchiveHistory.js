/* ============================================================================
 * keyProgArchiveHistory.js — localStorage-backed log of every Key Prog ZIP a
 * user has downloaded from the wizard (Task #392). Exists so the Key Prog
 * tab's saved-archive history can show the BCM SEC16 source line per row,
 * matching the badge above the dropzone, the post-download summary card,
 * and VERIFY.txt — without forcing the user to re-open each ZIP just to see
 * how the shared secret was derived.
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
export const MAX_ARCHIVES = 100;

function getStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch { /* SSR / disabled */ }
  return null;
}

function newId() {
  return 'kpa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
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
  return entry;
}

export function deleteArchive(id) {
  const next = loadArchives().filter((a) => a.id !== id);
  writeArchives(next);
  return next;
}

export function clearArchives() {
  writeArchives([]);
  return [];
}
