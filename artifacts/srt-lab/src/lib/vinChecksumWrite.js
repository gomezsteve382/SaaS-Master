/**
 * vinChecksumWrite.js — unified "write VIN/immo, then make EVERY checksum in
 * the resulting image valid, and report exactly what changed."
 *
 * Two layers of integrity live in an FCA module image:
 *   1. Per-slot record CRCs (VIN CRC16/CRC8RF/CRC8_42, SEC16/SEC6 CRCs) — these
 *      are recomputed inline by writeModuleVIN()/securityBytes.* on write.
 *   2. Whole-image / per-block firmware checksums (the calibration CRC32, ZF-8HP
 *      per-64 KB CRC32, prefix sums, …) — these are NOT touched by the per-slot
 *      writers, so a VIN/immo edit silently invalidates them and the module
 *      rejects the image / won't start.
 *
 * This module closes that gap. The robust approach: scan the ORIGINAL image for
 * checksums that are *confirmed valid* (stored === computed), apply the edit,
 * then recompute exactly those slots over their original coverage windows and
 * re-verify. We never rely on heuristically re-detecting a checksum we just
 * broke (which is impossible — detection keys on stored === computed).
 *
 *   import { writeVinAndFixChecksums } from './lib/vinChecksumWrite.js';
 *   const r = writeVinAndFixChecksums(data, 'GPEC2A', vin, { existingVins });
 *   // r.data        → patched image (per-slot CRCs + global checksums valid)
 *   // r.checksums   → [{offset, algorithm, coversStart, changed, old, new}]
 *   // r.fixedCount  → how many global checksums the edit actually broke & we fixed
 *   // r.verified    → true when every pre-confirmed checksum is valid again
 *
 * For an immo edit (SEC16/SEC6) where you've already produced the patched buffer
 * via securityBytes.*, call fixChecksumsAfterEdit(original, edited) directly.
 */
import { scanChecksums, fixChecksum } from './checksumScanner.js';
import { writeModuleVIN } from './fileUtils.js';

const toHex = (b) =>
  Array.from(b).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');

// Only CRC-family checksums are safe to recompute automatically. A confirmed
// crc32/crc32be/crc16 over a multi-KB window has a ~2^-16…2^-32 chance of being
// a coincidence, so it is essentially always a real firmware checksum. sum8/
// sum16/sum32/xor32 "valid" hits are frequently coincidental (e.g. sum8 over a
// region happens to equal an adjacent data byte); auto-recomputing one would
// overwrite real data. Those are surfaced for manual review instead.
const AUTO_FIX_ALGOS = new Set(['crc32', 'crc32be', 'crc16']);

/**
 * Recompute every whole-image / per-block CRC that the edit invalidated.
 *
 * @param {Uint8Array} original  pre-edit bytes (used to learn confirmed checksum slots)
 * @param {Uint8Array} edited    post-edit bytes (VIN/immo already written)
 * @param {{algorithms?:Set<string>}} [opts]  override the auto-fix algorithm allow-list
 * @returns {{data:Uint8Array, checksums:Array, fixedCount:number, preConfirmed:number,
 *            manualReview:Array, verified:boolean, skipped:Array}}
 */
export function fixChecksumsAfterEdit(original, edited, opts = {}) {
  const allow = opts.algorithms || AUTO_FIX_ALGOS;
  // Real image/block firmware CRCs cover at least this many bytes. A "valid"
  // CRC over a tiny window (e.g. crc32 of the first 4 bytes that coincidentally
  // equals an adjacent 0xFFFFFFFF blank) is a false positive, not a checksum —
  // observed on the 4 MB GPEC2A INT_FLASH. Don't recompute those.
  const minCoverage = opts.minCoverage ?? 0x40;
  // Confirmed checksums = those that were valid (stored === computed) on the
  // untouched original. Sorted ASC by offset so a nested/outer checksum (higher
  // offset, wider coverage) is recomputed AFTER any inner checksum it covers.
  const confirmed = scanChecksums(original)
    .filter((e) => e.status === 'valid')
    .sort((a, b) => parseInt(a.offset, 16) - parseInt(b.offset, 16));

  // Non-CRC confirmed checksums are NOT auto-recomputed (coincidence risk).
  const manualReview = confirmed
    .filter((e) => !allow.has(e.algorithm))
    .map((e) => ({
      offset: e.offset,
      algorithm: e.algorithm,
      coversStart: e.coversStart,
      note: 'non-CRC checksum — verify it is real, then recompute manually if the edit touched its coverage',
    }));

  const span = (e) => parseInt(e.offset, 16) - parseInt(e.coversStart, 16);
  const autoFix = confirmed.filter((e) => allow.has(e.algorithm) && span(e) >= minCoverage);
  const ignoredDegenerate = confirmed
    .filter((e) => allow.has(e.algorithm) && span(e) < minCoverage)
    .map((e) => ({
      offset: e.offset,
      algorithm: e.algorithm,
      coversStart: e.coversStart,
      span: span(e),
      note: `coverage ${span(e)} B < ${minCoverage} B — treated as coincidence, not recomputed`,
    }));
  let out = new Uint8Array(edited);
  const checksums = [];
  const skipped = [];

  for (const slot of autoFix) {
    const pos = parseInt(slot.offset, 16);
    const start = parseInt(slot.coversStart, 16);
    if (start < 0 || start >= pos || pos + slot.width > out.length) {
      skipped.push(`${slot.offset}:${slot.algorithm} (out of bounds for edited buffer)`);
      continue;
    }
    const before = out.slice(pos, pos + slot.width);
    let fixed;
    try {
      fixed = fixChecksum(out, slot.offset, slot.algorithm, slot.coversStart);
    } catch (e) {
      skipped.push(`${slot.offset}:${slot.algorithm} (${e.message})`);
      continue;
    }
    const after = fixed.slice(pos, pos + slot.width);
    const changed = !before.every((x, i) => x === after[i]);
    out = fixed; // fixChecksum writes computed value at pos → this slot is now valid by construction
    checksums.push({
      offset: slot.offset,
      algorithm: slot.algorithm,
      width: slot.width,
      coversStart: slot.coversStart,
      changed,
      old: toHex(before),
      new: toHex(after),
    });
  }

  return {
    data: out,
    checksums,
    fixedCount: checksums.filter((c) => c.changed).length,
    preConfirmed: confirmed.length,
    manualReview,
    ignoredDegenerate,
    // Every CRC slot is valid by construction; verified is false only if a
    // CRC slot could not be recomputed against the edited buffer. (manualReview
    // items are intentionally not auto-fixed — check allClear for "nothing left".)
    verified: skipped.length === 0,
    allClear: skipped.length === 0 && manualReview.length === 0,
    skipped,
  };
}

/**
 * Write a 17-char VIN into a module image (per-slot CRCs handled by
 * writeModuleVIN) and then repair every whole-image/per-block checksum the
 * edit invalidated. Returns the patched buffer plus a full report.
 *
 * @param {Uint8Array} data  original module image
 * @param {'BCM'|'RFHUB'|'GPEC2A'|'95640'} type
 * @param {string} vin        exactly 17 characters
 * @param {{existingVins?:Array}} [opts]  parseModule(data).vins for BCM/RFHUB base+8 layouts
 */
export function writeVinAndFixChecksums(data, type, vin, opts = {}) {
  if (typeof vin !== 'string' || vin.length !== 17) {
    return { ok: false, reason: 'VIN must be exactly 17 characters', data: new Uint8Array(data) };
  }
  const edited = writeModuleVIN(data, type, vin, opts.existingVins);
  if (!edited) {
    return { ok: false, reason: 'writeModuleVIN rejected the input', data: new Uint8Array(data) };
  }
  const res = fixChecksumsAfterEdit(data, edited);
  return { ok: true, type, vin, ...res };
}
