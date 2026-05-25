/**
 * Filename-derived labels for BCM flat-0x40C9 double-emit outputs.
 *
 * Task #800 emits two BCM .bin files per double-emit run:
 *   - BCM_FLAT40C9_REPAIRED_CANONICAL_<ts>.bin
 *   - BCM_FLAT40C9_REPAIRED_LEGACYFLAT_<ts>.bin
 *
 * Bench techs browsing the vault or "Restore original" UI weeks later
 * need to tell at a glance which copy belongs to which class of bench
 * tool. This helper derives that label purely from the filename suffix
 * so it works for files that already exist on disk too.
 *
 * Strictly pure — no side effects, no I/O.
 */

export const FLAT_REPAIR_KINDS = Object.freeze({
  CANONICAL: Object.freeze({
    kind: 'canonical',
    suffix: '_CANONICAL',
    shortLabel: 'Canonical',
    audience: 'modern tools + SRT Lab',
    fullLabel: 'Canonical (modern tools + SRT Lab)',
    color: '#1E6F3A',
    background: '#1E6F3A18',
  }),
  LEGACY_FLAT: Object.freeze({
    kind: 'legacy-flat',
    suffix: '_LEGACYFLAT',
    shortLabel: 'Legacy-flat',
    audience: 'CGDI / Autel / AlfaOBD / SINCRO',
    fullLabel: 'Legacy-flat (CGDI / Autel / AlfaOBD / SINCRO)',
    color: '#B45309',
    background: '#B4530918',
  }),
});

/**
 * Classify a BCM flat-0x40C9 repair filename.
 *
 * Accepts a string filename (with or without a path/extension) and
 * returns the matching descriptor from FLAT_REPAIR_KINDS, or null when
 * the filename is not a recognized flat-repair output.
 *
 * Matching rules:
 *   - Filename must contain "FLAT40C9_REPAIRED" (case-insensitive).
 *   - The suffix "_CANONICAL" or "_LEGACYFLAT" must follow that token
 *     (case-insensitive). A trailing timestamp/extension after the
 *     suffix is allowed.
 *
 * Anything else returns null — the caller decides whether to render a
 * badge at all.
 *
 * @param {unknown} filename
 * @returns {null | typeof FLAT_REPAIR_KINDS.CANONICAL | typeof FLAT_REPAIR_KINDS.LEGACY_FLAT}
 */
export function classifyFlatRepairFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return null;
  const base = filename.split(/[\\/]/).pop() || filename;
  if (!/FLAT40C9_REPAIRED/i.test(base)) return null;
  if (/FLAT40C9_REPAIRED_CANONICAL(?:[_.]|$)/i.test(base)) {
    return FLAT_REPAIR_KINDS.CANONICAL;
  }
  if (/FLAT40C9_REPAIRED_LEGACYFLAT(?:[_.]|$)/i.test(base)) {
    return FLAT_REPAIR_KINDS.LEGACY_FLAT;
  }
  return null;
}
