import { describe, it, expect } from 'vitest';

import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';
import { PCM_VIN_OFFSETS_GPEC2A, RFH_GEN1_VIN_OFFSET } from '../parseModule.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #434 — anonymization sanity scan for every committed real-dump fixture.
//
// The real-bench ECU dump fixtures wired through `__fixtures__/realDumps/`
// must always have the donor vehicle's VIN scrubbed to a documented
// anonymized stand-in. The other golden tests in this directory only
// exercise the security-byte writers, so they can't notice if a future
// maintainer drops in a fresh capture and forgets to anonymize the VIN.
//
// This file closes that gap by walking every binary the loader returns
// (top-level `bcm`/`rfhub`/`pcm` plus every entry in `extraBcms[]` and
// `extraPcms[]`, no hardcoded indices) and, for both the `before` and
// `after` halves of each pair, asserts:
//
//   1. The module-type scanner finds every documented VIN slot (BCM
//      records at 0x5300..0x5380 base+0/+8, RFHUB Gen2 reversed slots
//      at 0x0EA5/0x0EB9/0x0ECD/0x0EE1, PCM GPEC2A forward slots at
//      0x0000/0x01F0/0x0224/0x0CE0). Counts that fall short fail.
//   2. Every populated slot agrees on the same 17-character VIN value
//      (catches partial scrubs).
//   3. That VIN equals the manifest's per-fixture `anonVin` field
//      (the documented anonymized stand-in for THIS particular pair) —
//      a fixture-scoped check, not a global allow-list.
//   4. That VIN does not appear in the global forbidden-donor set.
//   5. NO forbidden donor VIN appears anywhere in the binary, forward
//      or byte-reversed. The forbidden set is the union of:
//        - HARDCODED_FORBIDDEN_DONOR_VINS below (always-on baseline),
//        - every `donorVin` field declared on any manifest entry
//          (lets a fresh capture self-declare its donor for the
//          test to enforce).
//   6. NO forbidden donor VIN's last-6 character serial (the unique
//      vehicle serial — e.g. `652640` for donor `2C3CDXCT1HH652640`)
//      appears anywhere in the binary OUTSIDE the documented full-VIN
//      slot windows. Catches the "scrubbed the WMI/VDS but forgot the
//      tail" mistake — the surviving 6-char serial is enough to
//      re-identify the donor when combined with module-type / part
//      numbers that survive in the rest of the dump (e.g. BCM
//      partial-VIN slots @ 0x4098 / 0x40B0). The full-VIN slot
//      windows themselves are masked out because they legitimately
//      hold the per-fixture anonymized 17-char VIN, whose own tail
//      could collide with a donor tail if a maintainer ever chose
//      to reuse the donor's serial as the anonymization stand-in;
//      slot-internal leaks are already covered by checks (3) & (4).
//
// If the manifest or any fixture file is absent the suite skips
// cleanly, matching the existing skip-instead-of-fail policy used by
// `securityBytes.realDump.golden.test.js` and `pcmSec6.realDump.golden.test.js`.
// ─────────────────────────────────────────────────────────────────────────────

// Always-on forbidden donor VINs. The test additionally adds every
// `donorVin` field declared anywhere in the manifest at runtime — so
// new fixtures self-extend the deny-list when they declare their own
// donor. This list is the floor for "donors we know about even if a
// future maintainer accidentally drops the manifest field".
const HARDCODED_FORBIDDEN_DONOR_VINS = [
  '2C3CDXCT1HH652640', // donor for the GPEC2A triple (rfhub/pcm/extraBcms[0]/extraPcms[0])
  // Primary BCM (anon `2C3CDXL90MH582899`) original donor VIN is unknown
  // to this repo — the SAMPLE_BCM file landed already anonymized
  // upstream. If/when it surfaces, add it here AND set `donorVin` on
  // the `bcm` entry in manifest.json so the consistency check fires.
];

/* True iff `bytes` is a valid 17-character VIN: ASCII letters/digits
 * with the VIN-illegal letters I, O, Q rejected. Matches the same
 * letter set that `parseModule.extractVIN` accepts (0x30..0x5A). */
function looksLikeVin(bytes) {
  if (bytes.length !== 17) return false;
  for (const b of bytes) {
    if (b < 0x30 || b > 0x5A) return false;
    if (b > 0x39 && b < 0x41) return false; // skip 0x3A..0x40 punctuation
    if (b === 0x49 /* I */ || b === 0x4F /* O */ || b === 0x51 /* Q */) return false;
  }
  return true;
}

/* Convert an ASCII VIN string into its raw byte form. */
function vinAsBytes(vin) {
  const out = new Uint8Array(vin.length);
  for (let i = 0; i < vin.length; i++) out[i] = vin.charCodeAt(i);
  return out;
}

/* Return a new Uint8Array that is the reverse of the input. */
function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

/* Read 17 bytes from `buf` at `offset`, reversing them first if
 * `reversed` is true, and decode as ASCII. */
function readVin(buf, offset, reversed) {
  const slice = buf.slice(offset, offset + 17);
  const ordered = reversed ? Array.from(slice).reverse() : Array.from(slice);
  return ordered.map(b => String.fromCharCode(b)).join('');
}

/* Find the first occurrence of `needle` in `buf`, or -1. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-module-type VIN-slot scanners. Each returns an array of
// `{ offset, reversed }` for slots that contain a valid 17-char VIN.
//
// MIN_SLOTS is the floor every committed fixture of that type must meet.
// We choose 4 for every type because every committed fixture (primary
// BCM, secondary BCM, RFHUB Gen2, PCM 4 KB, PCM 8 KB) carries exactly
// 4 VIN slots — a fixture that comes up short means either an
// incomplete scrub at one slot (failed `looksLikeVin`) or a layout
// the scanner doesn't yet know about. Either case warrants attention.
// ─────────────────────────────────────────────────────────────────────────────

// Task #449 — rfhubg1 (24C16, 2 KB Yazaki FCM EEPROM) carries a single
// plain-VIN slot at 0x92, so its floor is 1 (everything else carries 4).
const MIN_SLOTS = { bcm: 4, rfhub: 4, rfhubg1: 1, pcm: 4 };

const MODULE_SCANNERS = {
  // BCM: EEPROM VIN-record bases at 0x5300..0x5380 (32 B apart). The VIN
  // payload lives at base+0 (legacy layout) or base+8 (Redeye 2020+).
  // Both layouts are documented in parseModule.js. We scan all five
  // bases — empty/zeroed records are skipped by the looksLikeVin filter.
  // The committed fixtures use base+8 and have 4 VIN-bearing records
  // (primary at 0x5308..0x5368, secondary at 0x5328..0x5388).
  //
  // Task #463 — also scan the alternate 0x1300-zone bases. Some Charger
  // BCMs (FCA SINCRO output) carry the same record layout at 0x1320..
  // 0x1380 instead of 0x5320..0x5380. A real fixture populates exactly
  // one zone — the other zone's bases simply produce no slots.
  bcm(buf) {
    const slots = [];
    for (const base of [
      0x5300, 0x5320, 0x5340, 0x5360, 0x5380,
      0x1300, 0x1320, 0x1340, 0x1360, 0x1380,
    ]) {
      for (const delta of [0, 8]) {
        const off = base + delta;
        if (off + 17 > buf.length) continue;
        if (looksLikeVin(buf.slice(off, off + 17))) {
          slots.push({ offset: off, reversed: false });
          break; // one VIN per base
        }
      }
    }
    return slots;
  },

  // RFHUB: Gen2 4 KB image stores VIN byte-reversed at four canonical
  // addresses. Gen1 (≤ 2 KB) images don't carry VIN at these offsets;
  // return [] so the test treats the binary as VIN-less.
  rfhub(buf) {
    if (buf.length < 0x0EE1 + 17) return [];
    const slots = [];
    for (const off of [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1]) {
      if (looksLikeVin(reverseBytes(buf.slice(off, off + 17)))) {
        slots.push({ offset: off, reversed: true });
      }
    }
    return slots;
  },

  // RFHUB Gen1 (24C16, 2 KB Yazaki FCM EEPROM): a single plain-VIN slot
  // at 0x92 — no Gen2-style 0xEA5+ table. Mirrors `RFH_GEN1_VIN_OFFSET`
  // in parseModule.js so a future layout change there fails this test.
  rfhubg1(buf) {
    const off = RFH_GEN1_VIN_OFFSET;
    if (off + 17 > buf.length) return [];
    if (!looksLikeVin(buf.slice(off, off + 17))) return [];
    return [{ offset: off, reversed: false }];
  },

  // PCM (GPEC2A): four canonical forward VIN slots, identical on both
  // 4 KB and 8 KB sibling captures. Filter by file size in case a
  // smaller GPEC variant ever lands.
  pcm(buf) {
    const slots = [];
    for (const off of PCM_VIN_OFFSETS_GPEC2A) {
      if (off + 17 > buf.length) continue;
      if (looksLikeVin(buf.slice(off, off + 17))) {
        slots.push({ offset: off, reversed: false });
      }
    }
    return slots;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Build the dynamic target list straight from the loader output. Adding a
// new entry to manifest.json (e.g. extraBcms[1] / extraPcms[2]) automatically
// pulls it under the same scan — no test edit required.
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = loadRealDumpFixtures();

const targets = [];
if (fixtures !== null) {
  if (fixtures.bcm)     targets.push({ label: 'bcm',     moduleType: 'bcm',     entry: fixtures.bcm });
  if (fixtures.rfhub)   targets.push({ label: 'rfhub',   moduleType: 'rfhub',   entry: fixtures.rfhub });
  if (fixtures.rfhubg1) targets.push({ label: 'rfhubg1', moduleType: 'rfhubg1', entry: fixtures.rfhubg1 });
  if (fixtures.pcm)     targets.push({ label: 'pcm',     moduleType: 'pcm',     entry: fixtures.pcm });
  if (Array.isArray(fixtures.extraBcms)) {
    fixtures.extraBcms.forEach((entry, i) => {
      targets.push({ label: `extraBcms[${i}]`, moduleType: 'bcm', entry });
    });
  }
  if (Array.isArray(fixtures.extraPcms)) {
    fixtures.extraPcms.forEach((entry, i) => {
      targets.push({ label: `extraPcms[${i}]`, moduleType: 'pcm', entry });
    });
  }
}

// Build the global forbidden-donor set: hardcoded baseline + every
// donorVin declared on any manifest entry.
const forbiddenDonors = new Set(HARDCODED_FORBIDDEN_DONOR_VINS);
for (const t of targets) {
  if (typeof t.entry.donorVin === 'string' && t.entry.donorVin.length === 17) {
    forbiddenDonors.add(t.entry.donorVin);
  }
}
const forbiddenDonorList = Array.from(forbiddenDonors);

(targets.length > 0 ? describe : describe.skip)(
  'realDumps — anonymization sanity scan',
  () => {
    if (targets.length === 0) {
      it.skip('no real-dump fixtures committed yet (see __fixtures__/realDumps/README.md)', () => {});
      return;
    }

    for (const { label, moduleType, entry } of targets) {
      describe(`${label} (${moduleType})`, () => {
        const scanner = MODULE_SCANNERS[moduleType];
        const minSlots = MIN_SLOTS[moduleType];
        const expectedAnonVin = entry.anonVin; // may be null

        for (const half of ['before', 'after']) {
          describe(`${half}.bin`, () => {
            const buf = entry[half];
            const path = entry[`${half}Path`] ?? '?';

            // Run the scanner once and pre-compute everything the
            // assertions below need. Each `it` makes a single focused
            // assertion against the cached results.
            const slots = scanner(buf);
            const vinValues = slots.map(s => readVin(buf, s.offset, s.reversed));
            const uniqueVins = Array.from(new Set(vinValues));
            const canonicalVin = uniqueVins.length === 1 ? uniqueVins[0] : null;

            it(`finds all ${minSlots} canonical ${moduleType.toUpperCase()} VIN slot(s)`, () => {
              expect(
                slots.length,
                `${label}.${half} (${path}): scanner found ${slots.length} VIN slot(s) at the ` +
                  `canonical ${moduleType.toUpperCase()} addresses (expected ${minSlots}). ` +
                  `Either the fixture is corrupt, the wrong module type was wired, the binary ` +
                  `was partially scrubbed (one slot wiped to non-VIN bytes), or this module ` +
                  `uses a slot layout the scanner doesn't yet know about.`,
              ).toBeGreaterThanOrEqual(minSlots);
            });

            it('every populated VIN slot agrees on the same VIN value', () => {
              if (slots.length === 0) return; // covered by slot-count failure
              const slotDump = slots.map((s, i) =>
                `0x${s.offset.toString(16).toUpperCase().padStart(4, '0')}` +
                `${s.reversed ? ' (rev)' : ''} = '${vinValues[i]}'`,
              ).join(', ');
              expect(
                uniqueVins,
                `${label}.${half} (${path}): VIN slots disagree — partial anonymization? ${slotDump}`,
              ).toHaveLength(1);
            });

            // Per-fixture expected-VIN check — sourced from manifest.
            // This is THE check the reviewer asked for: "fixture-scoped
            // expected VIN", not a global allow-list. If the manifest
            // entry omits `anonVin`, we skip this assertion (and the
            // skip is loud enough in the test report to surface the
            // gap so a maintainer can fill it in).
            if (typeof expectedAnonVin === 'string' && expectedAnonVin.length === 17) {
              it(`slot VIN equals manifest anonVin '${expectedAnonVin}'`, () => {
                if (canonicalVin === null) return; // covered by earlier failures
                expect(
                  canonicalVin,
                  `${label}.${half} (${path}): slot VIN '${canonicalVin}' does not match the ` +
                    `manifest's documented anonymized VIN '${expectedAnonVin}' for this entry. ` +
                    `Either the fixture wasn't scrubbed to the documented stand-in, or the ` +
                    `manifest's anonVin field is stale and needs updating.`,
                ).toBe(expectedAnonVin);
              });
            } else {
              it.skip(`manifest entry missing 17-char 'anonVin' (skipping per-fixture VIN check) — please add it`, () => {});
            }

            it('slot VIN is not in the forbidden donor set', () => {
              if (canonicalVin === null) return;
              expect(
                forbiddenDonors.has(canonicalVin),
                `${label}.${half} (${path}): slot VIN '${canonicalVin}' IS a known donor VIN — ` +
                  `the fixture leaked the original.`,
              ).toBe(false);
            });

            // Catch-all whole-buffer scan for every forbidden donor —
            // covers leaks outside the documented VIN slots (e.g. donor
            // VIN copied into an unrelated text field).
            for (const donor of forbiddenDonorList) {
              const forward  = vinAsBytes(donor);
              const reversed = reverseBytes(forward);

              it(`donor VIN '${donor}' does NOT appear forward anywhere in the binary`, () => {
                const at = findBytes(buf, forward);
                expect(
                  at,
                  `${label}.${half} (${path}): original donor VIN '${donor}' leaked at offset ` +
                    `0x${at >= 0 ? at.toString(16).toUpperCase().padStart(4, '0') : '????'}`,
                ).toBe(-1);
              });

              it(`donor VIN '${donor}' does NOT appear byte-reversed anywhere in the binary`, () => {
                const at = findBytes(buf, reversed);
                expect(
                  at,
                  `${label}.${half} (${path}): original donor VIN '${donor}' (byte-reversed) ` +
                    `leaked at offset 0x${at >= 0 ? at.toString(16).toUpperCase().padStart(4, '0') : '????'}`,
                ).toBe(-1);
              });
            }

            // Partial-VIN tail scan — see check #6 in the file header.
            // We mask the documented full-VIN slot windows (each 17 B
            // starting at slot.offset) by overwriting them with 0x00 in
            // a working copy. 0x00 is safe as a sentinel: every
            // forbidden donor tail is ASCII alphanumeric (looksLikeVin
            // confines slot bytes to 0x30..0x5A), so the masked region
            // can never spuriously match a tail. Any remaining hit is a
            // genuine leak in a non-slot region (e.g. a partial-VIN
            // record, a part-number field, an audit log).
            const maskedBuf = new Uint8Array(buf);
            for (const s of slots) {
              const end = Math.min(s.offset + 17, maskedBuf.length);
              for (let i = s.offset; i < end; i++) maskedBuf[i] = 0x00;
            }

            for (const donor of forbiddenDonorList) {
              const tailStr = donor.slice(-6);
              const tailFwd = vinAsBytes(tailStr);
              const tailRev = reverseBytes(tailFwd);

              it(`donor VIN tail '${tailStr}' (last 6 of '${donor}') does NOT appear forward outside the documented VIN slot windows`, () => {
                const at = findBytes(maskedBuf, tailFwd);
                expect(
                  at,
                  `${label}.${half} (${path}): donor VIN tail '${tailStr}' (last 6 of donor ` +
                    `'${donor}') leaked at offset 0x${at >= 0 ? at.toString(16).toUpperCase().padStart(4, '0') : '????'} ` +
                    `outside the documented full-VIN slot windows. The donor's WMI/VDS appear ` +
                    `scrubbed but the unique vehicle serial survived — combined with module / ` +
                    `part numbers in the rest of the dump that's enough to re-identify the donor ` +
                    `(common offender on BCM dumps: the partial-VIN records at 0x4098 / 0x40B0).`,
                ).toBe(-1);
              });

              it(`donor VIN tail '${tailStr}' (last 6 of '${donor}') does NOT appear byte-reversed outside the documented VIN slot windows`, () => {
                const at = findBytes(maskedBuf, tailRev);
                expect(
                  at,
                  `${label}.${half} (${path}): donor VIN tail '${tailStr}' (last 6 of donor ` +
                    `'${donor}', byte-reversed) leaked at offset ` +
                    `0x${at >= 0 ? at.toString(16).toUpperCase().padStart(4, '0') : '????'} ` +
                    `outside the documented full-VIN slot windows.`,
                ).toBe(-1);
              });
            }
          });
        }
      });
    }
  },
);
