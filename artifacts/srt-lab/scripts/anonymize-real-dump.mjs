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
 *   - RFHUB Gen1 (24C16, 2 KB) plain-VIN slot at 0x92 — VIN overwritten +
 *     CRC16 re-stamped at +17/+18 (matches parseModule's `rfhVin92` field).
 *   - 95640 BCM-backup EEPROM (8 KB) plain-VIN slots at 0x275/0x288/0x1B82
 *     — VIN overwritten (no CRC on these slots, mirroring the parser).
 *   - SGW (Secure Gateway, 0x74F req / 0x76F resp on 2018+ FCA) — slot
 *     table is intentionally EMPTY by DESIGN (Task #457). **No VIN slot
 *     — confirmed by bench trace on dump X = the cracked OEM Chrysler
 *     diagnostic SWF (`attached_assets/CDA_1776448059516.swf`),
 *     automated in `src/lib/__tests__/cdaSwfSgwBenchTrace.test.js`.**
 *     The OEM tool exposes the SGW authentication / status / timeout
 *     API surface (proves it's the SGW-aware tool) and exposes ZERO
 *     SGW VIN read/write API surface across 17 naming-convention
 *     variants plus the F190 UDS DID. Full rationale lives in
 *     `docs/SGW_VIN_STORAGE.md` §0; the short version is in the
 *     `SGW_VIN_OFFSETS` comment in `src/lib/donorLeakScan.js`. The
 *     scrubber writes nothing AND the post-scrub leak guard runs
 *     WITHOUT MASKING (no documented slot windows to mask out), so
 *     if a real SGW dump ever turns out to embed the donor VIN at
 *     some undocumented offset (audit log, config table, future
 *     firmware revision) the helper exits 1 with a "donor-vin-forward
 *     at 0x????" pointer telling the maintainer where to dig — that
 *     fail-loud behavior is the documented escape hatch for revisiting
 *     the design decision if reality ever changes.
 *
 * Slot-offset constants (BCM_FULL_VIN_BASES / BCM_FULL_VIN_BASES_ALT /
 * BCM_PARTIAL_VIN_OFFSETS / RFH_GEN2_VIN_OFFSETS / RFH_GEN1_VIN_OFFSET /
 * PCM_VIN_OFFSETS / EEP95640_VIN_OFFSETS / SGW_VIN_OFFSETS) are imported
 * from `src/lib/donorLeakScan.js` (Task #447 moved them out of
 * parseModule.js so the in-app pre-share leak check can use them without
 * the CLI's `node:fs|path|url` dependencies; parseModule.js now re-imports
 * the BCM ones from there too — see the BCM_FULL_VIN_BASES_ALT import
 * comment in parseModule.js, Task #463). This way this helper, the parser,
 * and the in-app scrubber share a single source of truth — when a new VIN
 * slot or alternate base is documented for an existing family, updating it
 * in donorLeakScan.js automatically extends scrubbing coverage in lock-
 * step (no more "scrubber knew about 0x4098 but not the freshly-added
 * partial slot at 0x4118" drift, the failure mode that surfaced as
 * Task #436; same reasoning for the alt-base zone added in Task #463).
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
 *        --module <bcm|rfhub|rfhubg1|pcm|95640|sgw>            \
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

// Task #447 — the whole-buffer leak scanner + slot-window table moved into
// `src/lib/donorLeakScan.js` so the in-app pre-share leak check (BackupsTab,
// ModuleSync) can import it from a Vite-bundled file without dragging in the
// `node:fs|path|url` imports this CLI uses below. Re-exported from this
// module so existing tests that pin the script as the public surface keep
// working. Task #441 then extended donorLeakScan with the rfhubg1 / 95640
// slot tables so this script and the in-app scanner stay in lock-step on
// every documented family — adding a new family is a one-line edit there
// plus a scrubber registration here, nothing more.
import {
  VIN_LEN,
  BCM_FULL_VIN_BASES,
  BCM_FULL_VIN_BASES_ALT,
  BCM_PARTIAL_VIN_OFFSETS,
  BCM_PARTIAL_VIN_LEN,
  RFH_GEN2_VIN_OFFSETS,
  RFH_GEN1_VIN_OFFSET,
  PCM_VIN_OFFSETS,
  EEP95640_VIN_OFFSETS,
  SGW_VIN_OFFSETS,
  SUPPORTED_MODULE_TYPES,
  vinAsBytes,
  reverseBytes,
  findBytes,
  fmtOff,
  findBcmPartialVinSlots,
  getDocumentedSlotWindows,
  scanBufferForDonorLeak,
} from '../src/lib/donorLeakScan.js';

export { findBcmPartialVinSlots, getDocumentedSlotWindows, scanBufferForDonorLeak };

// VIN-illegal letters (matches parseModule.extractVIN + the
// realDumps.anonymization.test.js looksLikeVin classifier).
const VIN_DISALLOWED_BYTES = new Set([0x49 /* I */, 0x4F /* O */, 0x51 /* Q */]);


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
  //
  // Task #463 — iterate the union of the canonical 0x5300-zone bases AND
  // the alternate 0x1300-zone bases (FCA SINCRO output for some Charger
  // BCMs). Both zones share the same per-record layout, so the same
  // detect-and-rewrite loop covers them. Bases that hold no valid VIN
  // are skipped silently — a real dump only populates one zone, so the
  // other zone's bases simply produce no slots in the output.
  for (const base of [...BCM_FULL_VIN_BASES, ...BCM_FULL_VIN_BASES_ALT]) {
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
  // scrubbed.
  //
  // Task #452 — the rewrite list is the UNION of:
  //   (a) the always-known registered offsets in `BCM_PARTIAL_VIN_OFFSETS`
  //       (so a virgin/blank capture, where the slot bytes haven't yet been
  //       written and therefore can't be auto-detected by CRC, still gets
  //       stamped to a valid anon tail),
  //   (b) every partial-VIN-shaped record auto-detected in the buffer
  //       (8 VIN-character bytes + valid CRC16 at +8/+9). 2020+ Redeye
  //       BCMs may grow additional partial-VIN slots elsewhere (e.g. a
  //       cluster-B mirror) — the CRC16 + tight VIN-character filter make
  //       false positives essentially impossible, so the helper picks
  //       those up automatically without any code change here.
  // Every rewrite is recorded in `slots` so the post-scrub leak scan can
  // mask the bytes that are LEGITIMATELY the anon tail (vs a leftover
  // donor-tail leak elsewhere in the buffer).
  const tailBytes = anonBytes.slice(9);
  const partialOffsets = new Set(BCM_PARTIAL_VIN_OFFSETS);
  for (const d of findBcmPartialVinSlots(out)) partialOffsets.add(d.offset);
  for (const po of [...partialOffsets].sort((a, b) => a - b)) {
    if (po + BCM_PARTIAL_VIN_LEN + 2 > out.length) continue;
    for (let i = 0; i < BCM_PARTIAL_VIN_LEN; i++) out[po + i] = tailBytes[i];
    const c = crc16(tailBytes);
    out[po + BCM_PARTIAL_VIN_LEN]     = (c >> 8) & 0xFF;
    out[po + BCM_PARTIAL_VIN_LEN + 1] =  c       & 0xFF;
    slots.push({ kind: 'bcm-partial', offset: po, length: BCM_PARTIAL_VIN_LEN });
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

// RFHUB Gen1 (24C16, 2 KB Yazaki FCM EEPROM). Only one VIN slot at 0x92,
// stored plain, with a BE16 CRC16 at +17/+18 (parseModule's `rfhVin92`
// field). The 0xEA5+ Gen2 slot table is past the end of a 24C16 image
// so this family intentionally never touches those offsets.
function anonymizeRfhubGen1(buf, anonBytes) {
  const out = new Uint8Array(buf);
  const slots = [];
  const off = RFH_GEN1_VIN_OFFSET;
  if (off + 19 <= out.length) {
    for (let i = 0; i < VIN_LEN; i++) out[off + i] = anonBytes[i];
    const c = crc16(anonBytes);
    out[off + 17] = (c >> 8) & 0xFF;
    out[off + 18] = c & 0xFF;
    slots.push({ kind: 'rfh-gen1-vin', offset: off, length: VIN_LEN });
  }
  return { buffer: out, slots };
}

// 95640 BCM-backup EEPROM (8 KB). Three plaintext VIN slots; no CRC on
// any of them in the parser, so write-only — same shape as PCM.
function anonymize95640(buf, anonBytes) {
  const out = new Uint8Array(buf);
  const slots = [];
  for (const off of EEP95640_VIN_OFFSETS) {
    if (off + VIN_LEN > out.length) continue;
    for (let i = 0; i < VIN_LEN; i++) out[off + i] = anonBytes[i];
    slots.push({ kind: '95640-vin', offset: off, length: VIN_LEN });
  }
  return { buffer: out, slots };
}

// SGW (Secure Gateway, 0x74F req / 0x76F resp on 2018+ FCA). The empty
// slot table is a DESIGN DECISION (Task #457), not a placeholder — SGW
// is an authentication module that does not store the VIN in any
// documented flash / EEPROM slot. Full rationale + evidence:
// `docs/SGW_VIN_STORAGE.md`. The mirror constants in
// `src/lib/parseModule.js` and `src/lib/donorLeakScan.js` carry the
// same comment block.
//
// Why we still wire this scrubber: the CLI alias `--module sgw` stays
// accepted so a maintainer who somehow acquires an SGW dump can hand
// it to the helper. With an empty slot table this function writes
// nothing AND the post-scrub leak guard in `anonymizeBuffer` runs
// WITHOUT MASKING (`getDocumentedSlotWindows('sgw')` returns []). Any
// donor-VIN occurrence anywhere in the buffer — forward, byte-reversed,
// or as the trailing 6-character serial — trips the guard at the exact
// offset. The helper exits 1 and refuses to write the output file.
// That fail-loud behavior is the documented revisit path: if a real
// SGW dump ever surfaces with a stored VIN at some undocumented
// offset, the maintainer finds out where to dig with a single
// invocation, then populates `SGW_VIN_OFFSETS` in donorLeakScan.js
// (mirrored in parseModule.js) and this scrubber + the in-app
// pre-share scanner pick it up in lock-step — same one-stop extension
// story as the rfhubg1 / 95640 families.
function anonymizeSgw(buf, anonBytes) {
  const out = new Uint8Array(buf);
  const slots = [];
  for (const off of SGW_VIN_OFFSETS) {
    if (off + VIN_LEN > out.length) continue;
    for (let i = 0; i < VIN_LEN; i++) out[off + i] = anonBytes[i];
    slots.push({ kind: 'sgw-vin', offset: off, length: VIN_LEN });
  }
  return { buffer: out, slots };
}

// Per-module dispatch table. Adding a new family is a one-line edit here
// PLUS appending its CLI alias to SUPPORTED_MODULE_TYPES; the test suite
// iterates this map's keys so any new entry that lacks fixture coverage
// surfaces as a missing-fixture failure (loud, not silent).
const SCRUBBERS_BY_TYPE = {
  bcm:     anonymizeBcm,
  rfhub:   anonymizeRfhubGen2,
  rfhubg1: anonymizeRfhubGen1,
  pcm:     anonymizePcm,
  '95640': anonymize95640,
  sgw:     anonymizeSgw,
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
//
// `anonymizeBuffer(opts)` runs the full scrub-then-scan pipeline; throws
// on validation or post-scrub leak. The CLI wraps it in try/catch.
//
// `scanBufferForDonorLeak(opts)` and `getDocumentedSlotWindows(moduleType)`
// are re-exported above (Task #447) from `src/lib/donorLeakScan.js` — the
// same pure-JS module the in-app pre-share leak check imports. This module
// remains the single public surface tests pin against, so they cannot
// drift from the in-app scanner.
// ─────────────────────────────────────────────────────────────────────────────

// Re-export the module-type registry so the test suite can iterate it
// (see the coverage-completeness sentinel in anonymizeRealDump.test.js)
// and so future scrubber families can be added without changing call
// sites elsewhere. `SUPPORTED_MODULE_TYPES` is re-exported from
// `donorLeakScan.js` (single source of truth, also consumed by
// LeakScanPanel) so the script and the in-app scanner stay in lock-step.
export { SUPPORTED_MODULE_TYPES, SCRUBBERS_BY_TYPE };

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
  const scrubber = SCRUBBERS_BY_TYPE[mt];
  if (!scrubber) {
    // Should be unreachable — SUPPORTED_MODULE_TYPES is gate-checked
    // above — but the guard avoids a confusing TypeError if the two
    // tables ever drift.
    throw new Error(`internal: no scrubber registered for module type '${mt}'`);
  }
  const result = scrubber(buffer, anonBytes);

  // ── Post-scrub sanity scan ────────────────────────────────────────────
  // Delegate to the same `scanBufferForDonorLeak` exported function the
  // CI test in `realDumps.helperLeakScan.test.js` calls — keeps the two
  // call sites guaranteed to use the same scanner. We pass the actual
  // slots that were just rewritten as `slotWindows` so the donor-tail
  // masking is precise (tighter than the documented-window default,
  // since here we know exactly which BCM full-VIN layout — base+0 vs
  // base+8 — was used at each base).
  const leak = scanBufferForDonorLeak({
    buffer: result.buffer,
    donorVin: donorUpper,
    slotWindows: result.slots,
  });
  if (leak !== null) {
    throw new Error(`post-scrub leak: ${leak.message}`);
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
    '         --module <' + SUPPORTED_MODULE_TYPES.join('|') + '> \\',
    '         --donor-vin <17-char donor VIN> \\',
    '         --anon-vin  <17-char anonymized stand-in VIN> \\',
    '         [--out <output path>]',
    '',
    'Scrubs the donor VIN out of an ECU dump and re-stamps every parser CRC',
    'so the result drops cleanly into src/lib/__fixtures__/realDumps/ and',
    'passes realDumps.anonymization.test.js without further hand-editing.',
    '',
    'Module families:',
    '  bcm      — BCM MPC5605B/06B DFLASH (64 KB / 128 KB).',
    '  rfhub    — RFHUB Gen2 (24C32, 4 KB) — VINs stored byte-reversed.',
    '  rfhubg1  — RFHUB Gen1 (24C16, 2 KB) — single plain-VIN slot at 0x92.',
    '  pcm      — Continental GPEC2A PCM (4 KB or 8 KB).',
    '  95640    — 95640 BCM-backup EEPROM (8 KB).',
    '  sgw      — Secure Gateway (2018+ FCA, 0x74F req / 0x76F resp). No',
    '             documented VIN slots yet — the scrubber writes nothing',
    '             but the post-scrub leak guard still scans the buffer for',
    '             the donor VIN. If a real SGW dump turns out to embed it',
    '             at some undocumented offset the helper exits 1 with a',
    '             pointer to the offset (see SGW_VIN_OFFSETS in',
    '             src/lib/donorLeakScan.js).',
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
