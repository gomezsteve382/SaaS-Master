import { describe, it, expect } from 'vitest';

import { anonymizeBuffer } from '../../../scripts/anonymize-real-dump.mjs';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #438 — anonymize-real-dump.mjs sanity tests.
//
// The companion script is the one-shot helper a maintainer runs when
// committing a fresh ECU dump as a fixture under
// `__fixtures__/realDumps/`. Its core promise is two-fold:
//
//   (a) Every documented VIN slot for the named module type gets the
//       anonymized stand-in written + every parser CRC re-stamped.
//   (b) The donor VIN does not leak forward, byte-reversed, or as a
//       trailing-6 serial anywhere outside the documented slot windows.
//
// This test exercises both promises against the committed real-dump
// fixtures. For each fixture we:
//
//   1. Take the committed `after.bin` (which holds the manifest's
//      `anonVin` at every documented slot).
//   2. Re-anonymize with the script: donor = the existing anonVin,
//      anon = a different valid stand-in. Confirm the slot count
//      matches the per-module floor and the original anonVin no
//      longer appears anywhere.
//   3. Re-anonymize the result back to the original anonVin and
//      verify every documented VIN slot now reads the original
//      anonVin again (functional round-trip). NB: byte-for-byte
//      round-trip is intentionally NOT asserted because some
//      committed fixtures were hand-anonymized with stale CRCs that
//      `parseModule` tolerates — the script's correct behavior is to
//      RE-STAMP those CRCs, which is a one-way fix, not a bug.
//
// If the manifest or any fixture file is absent the suite skips
// cleanly, matching the same skip-instead-of-fail policy used by the
// other realDumps tests.
// ─────────────────────────────────────────────────────────────────────────────

// Local copies of the slot scanners used by `realDumps.anonymization.test.js`.
// Kept here (rather than imported) so this test catches drift from the
// script's slot table independently of the production scan.
function looksLikeVinBytes(bytes) {
  if (bytes.length !== 17) return false;
  for (const b of bytes) {
    if (b < 0x30 || b > 0x5A) return false;
    if (b > 0x39 && b < 0x41) return false;
    if (b === 0x49 || b === 0x4F || b === 0x51) return false;
  }
  return true;
}
function decodeAscii(bytes) { return Array.from(bytes).map(b => String.fromCharCode(b)).join(''); }
function reverseUint8(b) { const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[b.length - 1 - i]; return o; }
function scanFullVins(buf, moduleType) {
  const out = [];
  if (moduleType === 'bcm') {
    for (const base of [0x5300, 0x5320, 0x5340, 0x5360, 0x5380]) {
      for (const delta of [8, 0]) {
        const off = base + delta;
        if (off + 17 > buf.length) continue;
        const slice = buf.slice(off, off + 17);
        if (looksLikeVinBytes(slice)) { out.push({ offset: off, vin: decodeAscii(slice) }); break; }
      }
    }
  } else if (moduleType === 'rfhub') {
    for (const off of [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1]) {
      if (off + 17 > buf.length) continue;
      const slice = reverseUint8(buf.slice(off, off + 17));
      if (looksLikeVinBytes(slice)) out.push({ offset: off, vin: decodeAscii(slice), reversed: true });
    }
  } else if (moduleType === 'pcm') {
    for (const off of [0x0000, 0x01F0, 0x0224, 0x0CE0]) {
      if (off + 17 > buf.length) continue;
      const slice = buf.slice(off, off + 17);
      if (looksLikeVinBytes(slice)) out.push({ offset: off, vin: decodeAscii(slice) });
    }
  }
  return out;
}

// Two well-formed VINs we can swap between. Both pass the realDumps
// anonymization test's `looksLikeVin` (no I/O/Q) and have distinct
// last-6 serials so the donor-tail self-check has something to bite on.
const STAND_IN_A = '1HGBH41JXMN109186'; // famous test VIN, valid check digit
const STAND_IN_B = '5YJSA1E26HF000337'; // arbitrary Tesla test VIN, valid check digit

const fixtures = loadRealDumpFixtures();

const targets = [];
if (fixtures !== null) {
  if (fixtures.bcm)   targets.push({ label: 'bcm',   moduleType: 'bcm',   entry: fixtures.bcm });
  if (fixtures.rfhub) targets.push({ label: 'rfhub', moduleType: 'rfhub', entry: fixtures.rfhub });
  if (fixtures.pcm)   targets.push({ label: 'pcm',   moduleType: 'pcm',   entry: fixtures.pcm });
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

const MIN_SLOTS = { bcm: 4 + 2 /* full + partial */, rfhub: 4, pcm: 4 };

(targets.length > 0 ? describe : describe.skip)(
  'anonymize-real-dump.mjs',
  () => {
    if (targets.length === 0) {
      it.skip('no real-dump fixtures committed yet', () => {});
      return;
    }

    for (const { label, moduleType, entry } of targets) {
      const inputAnonVin = entry.anonVin;
      // If the manifest didn't declare an anonVin we can't drive the
      // round-trip — skip cleanly with a loud reason rather than fail.
      if (typeof inputAnonVin !== 'string' || inputAnonVin.length !== 17) {
        describe.skip(`${label} (${moduleType}) — manifest missing anonVin, skipping`, () => {});
        continue;
      }

      describe(`${label} (${moduleType})`, () => {
        it(`re-anonymizes ${label}.after.bin to a different stand-in without leaking the original VIN`, () => {
          const buf = entry.after;

          const result = anonymizeBuffer({
            buffer: buf,
            moduleType,
            donorVin: inputAnonVin,
            anonVin:  STAND_IN_A,
          });

          // The slot list is the script's own report of what it wrote.
          // Every committed fixture should hit the per-module floor.
          expect(result.slots.length, `${label}: scrubbed slot count`).toBeGreaterThanOrEqual(MIN_SLOTS[moduleType]);

          // The script's own post-scrub guard should already have thrown
          // if anything leaked, but assert the intent here too so the
          // failure message points at THIS test if the guard ever
          // regresses to a no-op.
          const donorBytes = new TextEncoder().encode(inputAnonVin);
          const donorRev   = new Uint8Array(donorBytes).reverse();
          expect(indexOfBytes(result.buffer, donorBytes), `${label}: original VIN must not appear forward`).toBe(-1);
          expect(indexOfBytes(result.buffer, donorRev),   `${label}: original VIN must not appear byte-reversed`).toBe(-1);

          // Every documented full-VIN slot should now read STAND_IN_A.
          // (BCM partial-VIN records are tail-only and covered separately
          // by the script's own post-scrub donor-tail guard.)
          const slots = scanFullVins(result.buffer, moduleType);
          expect(slots.length, `${label}: post-scrub full-VIN slot count`).toBeGreaterThanOrEqual(4);
          for (const s of slots) {
            expect(
              s.vin,
              `${label}: full-VIN slot @ 0x${s.offset.toString(16).toUpperCase()} should hold STAND_IN_A`,
            ).toBe(STAND_IN_A);
          }
        });

        it(`functionally round-trips ${label}.after.bin (anon → other → anon restores every slot's VIN)`, () => {
          const buf = entry.after;

          // Step 1: anon → STAND_IN_A
          const step1 = anonymizeBuffer({
            buffer: buf,
            moduleType,
            donorVin: inputAnonVin,
            anonVin:  STAND_IN_A,
          });

          // Step 2: STAND_IN_A → original anonVin
          const step2 = anonymizeBuffer({
            buffer: step1.buffer,
            moduleType,
            donorVin: STAND_IN_A,
            anonVin:  inputAnonVin,
          });

          // Length must be preserved — the script never grows or shrinks
          // a buffer.
          expect(step2.buffer.length, `${label}: round-trip length`).toBe(buf.length);

          // Every documented full-VIN slot reads the original anonVin
          // again. Byte-for-byte equality is intentionally NOT asserted
          // — see the suite header for why (stale-CRC fixtures).
          const slots = scanFullVins(step2.buffer, moduleType);
          expect(slots.length, `${label}: round-trip full-VIN slot count`).toBeGreaterThanOrEqual(4);
          for (const s of slots) {
            expect(
              s.vin,
              `${label}: full-VIN slot @ 0x${s.offset.toString(16).toUpperCase()} should restore to '${inputAnonVin}'`,
            ).toBe(inputAnonVin);
          }
        });

        it(`refuses to scrub when donor and anon share the same last-6 serial (${label})`, () => {
          // Pick an anonVin whose tail equals the inputAnonVin's tail —
          // that defeats anonymization, the script must refuse.
          const sharedTailAnon = STAND_IN_B.slice(0, 11) + inputAnonVin.slice(-6);
          // sharedTailAnon may not be a valid-shape VIN if inputAnonVin's
          // tail contains chars STAND_IN_B doesn't accept — only run the
          // assertion when the tail substitution yields a structurally
          // valid VIN (else the validator throws a different message).
          if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(sharedTailAnon)) {
            return;
          }
          expect(() => anonymizeBuffer({
            buffer: entry.after,
            moduleType,
            donorVin: inputAnonVin,
            anonVin:  sharedTailAnon,
          })).toThrow(/share the same last-6/);
        });
      });
    }

    describe('input validation', () => {
      it('rejects a non-Uint8Array buffer', () => {
        expect(() => anonymizeBuffer({
          buffer: 'not-a-buffer',
          moduleType: 'bcm',
          donorVin: STAND_IN_A,
          anonVin:  STAND_IN_B,
        })).toThrow(/Uint8Array/);
      });

      it('rejects an unsupported module type', () => {
        expect(() => anonymizeBuffer({
          buffer: new Uint8Array(65536),
          moduleType: 'tcm',
          donorVin: STAND_IN_A,
          anonVin:  STAND_IN_B,
        })).toThrow(/unsupported module type/);
      });

      it('rejects an anonVin containing the VIN-illegal letter O', () => {
        expect(() => anonymizeBuffer({
          buffer: new Uint8Array(65536),
          moduleType: 'bcm',
          donorVin: STAND_IN_A,
          anonVin:  'OOOOOOOOOOOOOOOOO',
        })).toThrow(/not a valid VIN/);
      });

      it('rejects identical donor and anon VINs', () => {
        expect(() => anonymizeBuffer({
          buffer: new Uint8Array(65536),
          moduleType: 'bcm',
          donorVin: STAND_IN_A,
          anonVin:  STAND_IN_A,
        })).toThrow(/identical/);
      });
    });
  },
);

function indexOfBytes(buf, needle) {
  if (needle.length === 0 || needle.length > buf.length) return -1;
  outer: for (let i = 0; i + needle.length <= buf.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
