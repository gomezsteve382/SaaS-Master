#!/usr/bin/env node
/* ============================================================================
 * anonymize-real-dump.mjs — one-shot helper for committing a fresh real ECU
 * dump as a fixture under `src/lib/__fixtures__/realDumps/`.
 *
 * Anonymizing a captured `.bin` is currently a manual checklist (see
 * `__fixtures__/realDumps/README.md` "Anonymization checklist") that has to
 * walk every documented VIN slot per module type AND re-stamp the parser
 * CRCs that guard them. Forgetting any one slot leaks the donor vehicle's
 * VIN — exactly the failure that surfaced in Task #436 when the secondary
 * BCM fixture had its full-VIN slots scrubbed but the maintainer missed
 * the partial-VIN records at 0x4098 / 0x40B0 (donor tail `652640` survived).
 *
 * This script handles the entire scrub in one command:
 *
 *   - BCM full-VIN slots at 0x5300/0x5320/0x5340/0x5360/0x5380 (each at
 *     base+0 legacy or base+8 Redeye 2020+, auto-detected per slot) — VIN
 *     overwritten + CRC16 re-stamped at +17/+18.
 *   - BCM partial-VIN records at 0x4098 / 0x40B0 — last-8 chars overwritten
 *     + CRC16 re-stamped at +8/+9 (the field that #436 missed).
 *   - RFHUB Gen2 byte-reversed VIN slots at 0x0EA5/0x0EB9/0x0ECD/0x0EE1 —
 *     reverse(VIN) overwritten + Gen2 VIN CS re-stamped at +17 (magic auto-
 *     detected from the existing populated slot, 0xDB / 0x87 / etc.).
 *   - PCM (GPEC2A 4 KB and 8 KB) full-VIN slots at 0x0000/0x01F0/0x0224/
 *     0x0CE0 — VIN overwritten (no CRC on these slots).
 *
 * After the writes, the script self-verifies the output:
 *   - The donor VIN must NOT appear forward or byte-reversed anywhere in
 *     the output buffer.
 *   - The donor VIN's last-6 character serial must NOT appear forward or
 *     byte-reversed OUTSIDE the documented full-VIN slot windows (catches
 *     leaks in unrelated text fields, audit logs, partial-VIN records the
 *     scanner doesn't yet know about, etc.).
 *
 * If either check fails the script aborts with a non-zero exit code and
 * does NOT write the output file — a maintainer never accidentally
 * commits a partially-scrubbed dump. The same checks mirror the ones
 * `realDumps.anonymization.test.js` runs at CI time, so a successful
 * scrub here means the fixture will pass that test without further hand-
 * editing (the explicit "done looks like" in Task #438).
 *
 * ----------------------------------------------------------------------------
 * Usage
 *
 *   node scripts/anonymize-real-dump.mjs <input.bin>           \
 *        --module <bcm|rfhub|pcm>                              \
 *        --donor-vin <17-char donor VIN>                       \
 *        --anon-vin  <17-char anonymized stand-in VIN>         \
 *        [--out <output path>]
 *
 * If `--out` is omitted, writes to `<input>.anon.bin` next to the input.
 *
 * Exit codes:
 *   0  success — anonymized file written
 *   1  validation / scrub failure (no file written)
 *
 * ============================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { crc16, rfhGen2VinCs, rfhGen2DetectMagic } from '../src/lib/crc.js';

const VIN_LEN = 17;

// VIN-illegal letters (matches parseModule.extractVIN + the
// realDumps.anonymization.test.js looksLikeVin classifier).
const VIN_DISALLOWED_BYTES = new Set([0x49 /* I */, 0x4F /* O */, 0x51 /* Q */]);

// Documented VIN slot offsets per module type. Single source of truth; if a
// new slot is ever added to the parser/writer, mirror it here so this
// scrub helper continues to cover every documented location.
const BCM_FULL_VIN_BASES        = [0x5300, 0x5320, 0x5340, 0x5360, 0x5380];
const BCM_PARTIAL_VIN_OFFSETS   = [0x4098, 0x40B0];
const RFH_GEN2_VIN_OFFSETS      = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
const PCM_VIN_OFFSETS           = [0x0000, 0x01F0, 0x0224, 0x0CE0];

const SUPPORTED_MODULE_TYPES = ['bcm', 'rfhub', 'pcm'];

// ─────────────────────────────────────────────────────────────────────────────
// Small byte-handling helpers (kept local — avoids dragging in unrelated
// parser code and keeps the script self-contained for one-shot CLI use).
// ─────────────────────────────────────────────────────────────────────────────

function vinAsBytes(vin) {
  const out = new Uint8Array(vin.length);
  for (let i = 0; i < vin.length; i++) out[i] = vin.charCodeAt(i);
  return out;
}

function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

function findBytes(buf, needle) {
  if (needle.length === 0 || needle.length > buf.length) return -1;
  outer: for (let i = 0; i + needle.length <= buf.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function fmtOff(n) { return '0x' + n.toString(16).toUpperCase().padStart(4, '0'); }

// True iff `vin` is a well-formed 17-char VIN: ASCII alphanumeric, no I/O/Q.
function looksLikeVin(vin) {
  if (typeof vin !== 'string' || vin.length !== VIN_LEN) return false;
  for (let i = 0; i < vin.length; i++) {
    const c = vin.charCodeAt(i);
    if (c < 0x30 || c > 0x5A) return false;
    if (c > 0x39 && c < 0x41) return false; // skip 0x3A..0x40 punctuation
    if (VIN_DISALLOWED_BYTES.has(c)) return false;
  }
  return true;
}

// True iff a valid 17-char VIN sits at `buf[off..off+17)`. Used to choose
// between the BCM legacy (base+0) and Redeye 2020+ (base+8) layouts at
// each full-VIN slot base — whichever holds the live VIN gets the rewrite.
function isValidVinAt(buf, off) {
  if (off + VIN_LEN > buf.length) return false;
  for (let i = 0; i < VIN_LEN; i++) {
    const c = buf[off + i];
    if (c < 0x30 || c > 0x5A) return false;
    if (c > 0x39 && c < 0x41) return false;
    if (c === 0x49 || c === 0x4F || c === 0x51) return false;
  }
  return true;
}

// Same as `isValidVinAt`, but for a byte-reversed VIN at `buf[off..off+17)`
// (RFHUB Gen2 stores the VIN reversed). Used to detect populated RFH slots
// for magic-byte derivation before the rewrite.
function isValidReversedVinAt(buf, off) {
  if (off + VIN_LEN > buf.length) return false;
  for (let i = 0; i < VIN_LEN; i++) {
    const c = buf[off + (VIN_LEN - 1 - i)];
    if (c < 0x30 || c > 0x5A) return false;
    if (c > 0x39 && c < 0x41) return false;
    if (c === 0x49 || c === 0x4F || c === 0x51) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-module scrubbers. Each returns
//   { buffer: Uint8Array, slots: [{ kind, offset, length }] }
// where `slots` describes the byte ranges that were rewritten — the post-
// scrub donor-tail check masks these ranges before scanning so legitimate
// in-slot bytes (the per-fixture anon VIN, which may share characters with
// the donor) cannot generate spurious leak hits.
// ─────────────────────────────────────────────────────────────────────────────

function anonymizeBcm(buf, anonBytes) {
  const out = new Uint8Array(buf);
  const slots = [];

  // Full-VIN records. Each base holds a VIN at base+0 (legacy) OR base+8
  // (Redeye 2020+ FEE-record header). Real captures use one layout per
  // record but the table can mix; check base+8 first (newer is more
  // common on dumps maintainers ship today) then fall back to base+0.
  for (const base of BCM_FULL_VIN_BASES) {
    let off = null;
    if (isValidVinAt(out, base + 8)) off = base + 8;
    else if (isValidVinAt(out, base)) off = base;
    if (off === null) continue;
    if (off + VIN_LEN > out.length) continue;

    for (let i = 0; i < VIN_LEN; i++) out[off + i] = anonBytes[i];

    // Re-stamp the trailing CRC16 if it fits (matches parseModule.js's
    // `crc16(slice(off, off+17))` formula at +17/+18).
    if (off + 19 <= out.length) {
      const c = crc16(anonBytes);
      out[off + 17] = (c >> 8) & 0xFF;
      out[off + 19 - 1] = c & 0xFF;
    }
    slots.push({ kind: 'bcm-full', offset: off, length: VIN_LEN });
  }

  // Partial-VIN records: 8-char trailing serial + CRC16 at +8/+9. THIS is
  // the field Task #436 missed — committed `bcm2.*.bin` had the donor's
  // last-6 serial leaking here even though the full-VIN records had been
  // scrubbed. Always re-stamped, unconditionally, on every BCM scrub.
  const tailBytes = anonBytes.slice(9);
  for (const po of BCM_PARTIAL_VIN_OFFSETS) {
    if (po + 10 > out.length) continue;
    for (let i = 0; i < 8; i++) out[po + i] = tailBytes[i];
    const c = crc16(tailBytes);
    out[po + 8] = (c >> 8) & 0xFF;
    out[po + 9] = c & 0xFF;
    slots.push({ kind: 'bcm-partial', offset: po, length: 8 });
  }

  return { buffer: out, slots };
}

function anonymizeRfhubGen2(buf, anonBytes) {
  const out = new Uint8Array(buf);
  const reversedAnon = reverseBytes(anonBytes);

  // Auto-detect the Gen2 VIN-CS magic byte (0xDB on 2020+ Redeye, 0x87 on
  // earlier Gen2, etc.) from any populated existing slot. If the dump is
  // already virgin (no populated slot) fall back to 0xDB — that's the
  // most common variant maintainers will see when capturing a fresh sync.
  let magic = 0xDB;
  for (const off of RFH_GEN2_VIN_OFFSETS) {
    if (off + 18 > out.length) continue;
    const slice = out.slice(off, off + VIN_LEN);
    const cs    = out[off + VIN_LEN];
    const blank = slice.every(b => b === 0xFF || b === 0x00);
    if (!blank && cs !== 0x00 && cs !== 0xFF && isValidReversedVinAt(out, off)) {
      magic = rfhGen2DetectMagic(slice, cs);
      break;
    }
  }

  const slots = [];
  for (const off of RFH_GEN2_VIN_OFFSETS) {
    if (off + 18 > out.length) continue;
    for (let i = 0; i < VIN_LEN; i++) out[off + i] = reversedAnon[i];
    out[off + VIN_LEN] = rfhGen2VinCs(reversedAnon, magic);
    slots.push({ kind: 'rfh-rev-vin', offset: off, length: VIN_LEN });
  }
  return { buffer: out, slots, magic };
}

function anonymizePcm(buf, anonBytes) {
  const out = new Uint8Array(buf);
  const slots = [];
  for (const off of PCM_VIN_OFFSETS) {
    if (off + VIN_LEN > out.length) continue;
    for (let i = 0; i < VIN_LEN; i++) out[off + i] = anonBytes[i];
    slots.push({ kind: 'pcm-full', offset: off, length: VIN_LEN });
  }
  return { buffer: out, slots };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API: anonymizeBuffer(opts) → { buffer, slots, magic? }
//
// Throws Error on any validation or post-scrub leak. Callers that want a
// non-throwing variant can wrap in try/catch — the CLI does exactly that.
// ─────────────────────────────────────────────────────────────────────────────

export function anonymizeBuffer({ buffer, moduleType, donorVin, anonVin }) {
  if (!(buffer instanceof Uint8Array)) {
    throw new Error('buffer must be a Uint8Array');
  }
  if (typeof moduleType !== 'string') {
    throw new Error('moduleType is required (one of: ' + SUPPORTED_MODULE_TYPES.join(', ') + ')');
  }
  const mt = moduleType.toLowerCase();
  if (!SUPPORTED_MODULE_TYPES.includes(mt)) {
    throw new Error(`unsupported module type '${moduleType}' (expected one of: ${SUPPORTED_MODULE_TYPES.join(', ')})`);
  }
  if (typeof anonVin !== 'string' || anonVin.length !== VIN_LEN) {
    throw new Error(`anonVin must be a 17-character string (got ${anonVin == null ? 'null' : `'${anonVin}' (${anonVin.length} chars)`})`);
  }
  const anonUpper = anonVin.toUpperCase();
  if (!looksLikeVin(anonUpper)) {
    throw new Error(`anonVin '${anonVin}' is not a valid VIN — must be 17 ASCII alphanumeric chars with no I/O/Q`);
  }
  if (typeof donorVin !== 'string' || donorVin.length !== VIN_LEN) {
    throw new Error(`donorVin must be a 17-character string (got ${donorVin == null ? 'null' : `'${donorVin}' (${donorVin.length} chars)`})`);
  }
  const donorUpper = donorVin.toUpperCase();
  if (donorUpper === anonUpper) {
    throw new Error(`donorVin and anonVin are identical ('${donorUpper}') — refusing to no-op scrub`);
  }
  if (donorUpper.slice(-6) === anonUpper.slice(-6)) {
    throw new Error(
      `donorVin and anonVin share the same last-6 vehicle serial ('${donorUpper.slice(-6)}'). ` +
      `That defeats the purpose of anonymization — pick an anonVin with a different tail.`,
    );
  }

  const anonBytes = vinAsBytes(anonUpper);
  let result;
  if (mt === 'bcm')   result = anonymizeBcm(buffer, anonBytes);
  else if (mt === 'rfhub') result = anonymizeRfhubGen2(buffer, anonBytes);
  else                result = anonymizePcm(buffer, anonBytes);

  // ── Post-scrub sanity scan ────────────────────────────────────────────
  // 1. Donor VIN must not appear forward or byte-reversed anywhere.
  const donorFwd = vinAsBytes(donorUpper);
  const donorRev = reverseBytes(donorFwd);
  const fwdAt = findBytes(result.buffer, donorFwd);
  if (fwdAt !== -1) {
    throw new Error(
      `post-scrub leak: donor VIN '${donorUpper}' still appears forward at offset ${fmtOff(fwdAt)}. ` +
      `The scrubber doesn't know about a VIN slot at that location — please scrub manually and ` +
      `consider extending the slot table in this script.`,
    );
  }
  const revAt = findBytes(result.buffer, donorRev);
  if (revAt !== -1) {
    throw new Error(
      `post-scrub leak: donor VIN '${donorUpper}' still appears byte-reversed at offset ${fmtOff(revAt)}. ` +
      `The scrubber doesn't know about a reversed-VIN slot at that location — please scrub manually.`,
    );
  }

  // 2. Donor's last-6 serial must not appear outside the documented slot
  //    windows. Mask the windows we wrote so legitimate in-slot bytes
  //    (which may contain the anon VIN's own tail) do not generate false
  //    positives. Sentinel 0x00 is safe here: every donor tail is ASCII
  //    alphanumeric (0x30..0x5A), so the masked region cannot spuriously
  //    match a tail byte.
  const masked = new Uint8Array(result.buffer);
  for (const s of result.slots) {
    const end = Math.min(s.offset + s.length, masked.length);
    for (let i = s.offset; i < end; i++) masked[i] = 0x00;
  }
  const tail = donorUpper.slice(-6);
  const tailFwd = vinAsBytes(tail);
  const tailRev = reverseBytes(tailFwd);
  const tFwdAt = findBytes(masked, tailFwd);
  if (tFwdAt !== -1) {
    throw new Error(
      `post-scrub leak: donor VIN tail '${tail}' (last 6 of '${donorUpper}') survived at offset ` +
      `${fmtOff(tFwdAt)} OUTSIDE the documented VIN slot windows. Common offender on BCM dumps: ` +
      `the partial-VIN records at 0x4098 / 0x40B0 — but if those were scrubbed and this still ` +
      `fires, the donor's serial is leaking from a part-number / audit field this scrubber ` +
      `doesn't yet know about. Hand-scrub that location and re-run.`,
    );
  }
  const tRevAt = findBytes(masked, tailRev);
  if (tRevAt !== -1) {
    throw new Error(
      `post-scrub leak: donor VIN tail '${tail}' (byte-reversed) survived at offset ` +
      `${fmtOff(tRevAt)} OUTSIDE the documented VIN slot windows.`,
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { input: null, module: null, donor: null, anon: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--module' || a === '-m') opts.module = argv[++i];
    else if (a === '--donor-vin' || a === '--donor') opts.donor = argv[++i];
    else if (a === '--anon-vin'  || a === '--anon')  opts.anon  = argv[++i];
    else if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else if (!a.startsWith('-') && opts.input === null) opts.input = a;
    else throw new Error(`unrecognized arg '${a}' (try --help)`);
  }
  if (!opts.input)  throw new Error('missing <input.bin> positional argument');
  if (!opts.module) throw new Error('missing --module flag');
  if (!opts.donor)  throw new Error('missing --donor-vin flag');
  if (!opts.anon)   throw new Error('missing --anon-vin flag');
  if (!opts.out)    opts.out = opts.input.replace(/\.bin$/i, '') + '.anon.bin';
  return opts;
}

function printUsage() {
  process.stdout.write([
    'Usage: node scripts/anonymize-real-dump.mjs <input.bin> \\',
    '         --module <bcm|rfhub|pcm> \\',
    '         --donor-vin <17-char donor VIN> \\',
    '         --anon-vin  <17-char anonymized stand-in VIN> \\',
    '         [--out <output path>]',
    '',
    'Scrubs the donor VIN out of an ECU dump and re-stamps every parser CRC',
    'so the result drops cleanly into src/lib/__fixtures__/realDumps/ and',
    'passes realDumps.anonymization.test.js without further hand-editing.',
    '',
  ].join('\n'));
}

async function cli(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { process.stderr.write(`error: ${e.message}\n\n`); printUsage(); process.exit(1); }

  let buf;
  try { buf = new Uint8Array(fs.readFileSync(opts.input)); }
  catch (e) { process.stderr.write(`error: cannot read input '${opts.input}': ${e.message}\n`); process.exit(1); }

  let result;
  try {
    result = anonymizeBuffer({
      buffer: buf,
      moduleType: opts.module,
      donorVin:   opts.donor,
      anonVin:    opts.anon,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }

  fs.writeFileSync(opts.out, Buffer.from(result.buffer));
  const slotSummary = result.slots.map(s => `  ${s.kind} @ ${fmtOff(s.offset)} (${s.length} B)`).join('\n');
  process.stdout.write(
    `Anonymized ${opts.input} (${buf.length} B, module=${opts.module})\n` +
    `  donor → ${opts.donor.toUpperCase()}\n` +
    `  anon  → ${opts.anon.toUpperCase()}\n` +
    (result.magic !== undefined ? `  RFH magic = 0x${result.magic.toString(16).toUpperCase().padStart(2, '0')}\n` : '') +
    `Scrubbed ${result.slots.length} slot(s):\n${slotSummary}\n` +
    `Wrote ${opts.out}\n`,
  );
}

const __isCli = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch { return false; }
})();

if (__isCli) {
  cli(process.argv.slice(2));
}
