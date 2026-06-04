/* ============================================================================
 * rfhPinnedRegistry.js — Ground-truth registry of bench-confirmed RFHUB
 * fixtures (Task #796).
 *
 * Mirrors the PINNED map in charger62bench.realfiles.test.js so the UI can
 * tell, per loaded RFHUB dump, whether the extractor's best-pick OS / PN /
 * SERIAL has already been confirmed against a real bench fixture or is
 * still an "unconfirmed best pick" awaiting human verification.
 *
 * The shape of each entry intentionally matches the test's expected layout
 * so a Confirm-as-ground-truth round trip (clipboard → paste into test or
 * a future shared registry) lands as a drop-in addition.
 * ============================================================================ */

const SCAT_EXPECTED = {
  os:     { value: 'AA30712804',     len: 10, offset: 0x808, matchesCanonical: true,  supplierBonus: 0  },
  pn:     { value: '30712804CA',     len: 10, offset: 0x80a, matchesCanonical: false, supplierBonus: 0  },
  serial: { value: '7161A9870IR00T', len: 14, offset: 0x82c, matchesCanonical: true,  supplierBonus: 20 },
};
const CARTMAN_EXPECTED = {
  os:     { value: 'AA40712804',     len: 10, offset: 0x808, matchesCanonical: true,  supplierBonus: 0  },
  pn:     { value: '40712804AA',     len: 10, offset: 0x80a, matchesCanonical: false, supplierBonus: 0  },
  serial: { value: '3280D2211IR00T', len: 14, offset: 0x82c, matchesCanonical: true,  supplierBonus: 20 },
};

export const PINNED_RFH_FIXTURES = Object.freeze({
  'RFH_SCAT_OG_1776883386715.bin': SCAT_EXPECTED,
  'RFH_SCAT_OG_1776883397469.bin': SCAT_EXPECTED,
  'RFH_SCAT_OG__1776953366762.bin': SCAT_EXPECTED,
  'RFH_SCAT_OG_1776953518379.bin': SCAT_EXPECTED,
  'RFH_SCAT_OG_1776959969103.bin': SCAT_EXPECTED,
  'CARTMAN21CHARGER6.2RFHUBOG_1776135438588.bin': CARTMAN_EXPECTED,
  'CARTMAN21CHARGER6.2RFHUBOG_1776135460754.bin': CARTMAN_EXPECTED,
});

const FIELDS = ['os', 'pn', 'serial'];
const COMPARED_KEYS = ['value', 'len', 'offset', 'matchesCanonical', 'supplierBonus'];

/** Look up a pinned entry by exact filename. Returns null if not pinned. */
export function getPinnedExpectation(filename) {
  if (!filename) return null;
  return PINNED_RFH_FIXTURES[filename] || null;
}

/**
 * Classify a loaded dump as 'pinned' (matches ground truth),
 * 'pinned-mismatch' (registry says it should match but extractor disagrees —
 * regression), or 'unconfirmed' (no registry entry, best pick awaits human
 * confirmation).
 *
 * `identity` is the object returned by extractRfhPflashIdentity. Pass null
 * if it hasn't been computed yet — pinned files still report 'pinned'.
 */
export function pinnedStatus(filename, identity) {
  const expected = getPinnedExpectation(filename);
  if (!expected) return { status: 'unconfirmed', expected: null, mismatches: [] };
  if (!identity) return { status: 'pinned', expected, mismatches: [] };
  const mismatches = [];
  for (const field of FIELDS) {
    const e = expected[field];
    const a = identity[field];
    if (!a) { mismatches.push({ field, key: '(missing)', expected: e?.value, actual: null }); continue; }
    for (const k of COMPARED_KEYS) {
      const ev = e[k];
      const av = k === 'supplierBonus' ? (a[k] || 0) : a[k];
      if (ev !== av) mismatches.push({ field, key: k, expected: ev, actual: av });
    }
  }
  return { status: mismatches.length ? 'pinned-mismatch' : 'pinned', expected, mismatches };
}

/**
 * Format a ready-to-paste registry entry from an extractor result. The
 * output matches the PINNED_RFH_FIXTURES shape literally so it can be
 * dropped into either this file or the test fixture map.
 */
export function formatRegistryEntry(filename, identity) {
  const snap = (f) => {
    if (!f) return 'null';
    const offsetHex = '0x' + f.offset.toString(16).toLowerCase();
    return `{ value: ${JSON.stringify(f.value)}, len: ${f.len}, offset: ${offsetHex}, matchesCanonical: ${!!f.matchesCanonical}, supplierBonus: ${f.supplierBonus || 0} }`;
  };
  const safeName = String(filename || '(unknown).bin');
  return [
    `'${safeName}': {`,
    `  os:     ${snap(identity?.os)},`,
    `  pn:     ${snap(identity?.pn)},`,
    `  serial: ${snap(identity?.serial)},`,
    `},`,
  ].join('\n');
}
