import { describe, it, expect } from 'vitest';

import {
  anonymizeBuffer,
  SCRUBBERS_BY_TYPE,
  SUPPORTED_MODULE_TYPES,
  findBcmPartialVinSlots,
} from '../../../scripts/anonymize-real-dump.mjs';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';
import { parseModule, RFH_GEN1_VIN_OFFSET, EEP95640_VIN_OFFSETS, SGW_VIN_OFFSETS } from '../parseModule.js';
import { crc16 } from '../crc.js';
import { BCM_PARTIAL_VIN_OFFSETS, BCM_PARTIAL_VIN_LEN } from '../donorLeakScan.js';

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
//      anonVin again (functional round-trip).
//   4. Task #448 — assert BYTE-FOR-BYTE equality between the original
//      `after.bin` and the result of step 3. This is the only check
//      that catches a fixture which never went through the helper
//      at all (e.g. a maintainer hand-edited the full-VIN bytes but
//      left the trailing CRC16 stale, or skipped the partial-VIN
//      slots, or — for a future module-type variant — never told the
//      leak scanner about a new slot the helper has since learned to
//      cover). The functional round-trip in step 3 only checks the
//      VIN bytes themselves; the byte-equality check in step 4 also
//      pins every CRC the helper re-stamps. A failing test points
//      the maintainer at the exact slot whose CRC differs, with
//      guidance to re-run the helper on the original capture.
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
  } else if (moduleType === 'rfhubg1') {
    // Gen1 (24C16, 2 KB) carries a single plain-VIN slot at 0x92.
    const off = RFH_GEN1_VIN_OFFSET;
    if (off + 17 <= buf.length) {
      const slice = buf.slice(off, off + 17);
      if (looksLikeVinBytes(slice)) out.push({ offset: off, vin: decodeAscii(slice) });
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

const MIN_SLOTS = { bcm: 4 + 2 /* full + partial */, rfhub: 4, rfhubg1: 1, pcm: 4 };

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
          // Per-module floor: BCM/RFHUB Gen2/PCM each carry 4 full-VIN
          // slots; RFHUB Gen1 (24C16) only carries the single 0x92 slot.
          const minFullVinSlots = moduleType === 'rfhubg1' ? 1 : 4;
          const slots = scanFullVins(result.buffer, moduleType);
          expect(slots.length, `${label}: post-scrub full-VIN slot count`).toBeGreaterThanOrEqual(minFullVinSlots);
          for (const s of slots) {
            expect(
              s.vin,
              `${label}: full-VIN slot @ 0x${s.offset.toString(16).toUpperCase()} should hold STAND_IN_A`,
            ).toBe(STAND_IN_A);
          }
        });

        it(`byte-for-byte round-trips ${label}.after.bin (anon → other → anon reproduces the file exactly)`, () => {
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
          // again (functional round-trip). Per-module floor: BCM/RFHUB
          // Gen2/PCM each carry 4 full-VIN slots; RFHUB Gen1 (24C16)
          // only carries the single 0x92 slot.
          const minFullVinSlots = moduleType === 'rfhubg1' ? 1 : 4;
          const slots = scanFullVins(step2.buffer, moduleType);
          expect(slots.length, `${label}: round-trip full-VIN slot count`).toBeGreaterThanOrEqual(minFullVinSlots);
          for (const s of slots) {
            expect(
              s.vin,
              `${label}: full-VIN slot @ 0x${s.offset.toString(16).toUpperCase()} should restore to '${inputAnonVin}'`,
            ).toBe(inputAnonVin);
          }

          // Task #448 — byte-for-byte equality. This is the check that
          // catches a fixture whose `after.bin` never went through the
          // helper (hand-edited VIN bytes leave stale CRCs; skipped
          // partial-VIN slots leave the donor tail intact; a future
          // module-type variant might add a new slot the leak scanner
          // doesn't yet know about). Two passes through `anonymizeBuffer`
          // re-stamp every documented slot the helper covers; if the
          // committed file was produced by the helper itself, those
          // bytes are already canonical and the round-trip is a no-op.
          // Any mismatch here means the fixture and the helper have
          // drifted — re-run `node scripts/anonymize-real-dump.mjs` on
          // the original captured `.bin` and re-commit the result.
          const diffs = listDiffs(buf, step2.buffer, 5);
          if (diffs.length > 0) {
            const fmt = diffs.map(d =>
              `  off=0x${d.offset.toString(16).toUpperCase().padStart(4, '0')} ` +
              `committed=0x${d.committed.toString(16).padStart(2, '0')} ` +
              `helper=0x${d.helper.toString(16).padStart(2, '0')}`,
            ).join('\n');
            throw new Error(
              `${label}: round-trip through anonymizeBuffer changed bytes — ` +
              `the committed fixture was not produced by the helper.\n` +
              `First mismatching bytes (helper would re-stamp these):\n${fmt}\n` +
              `Re-run \`node scripts/anonymize-real-dump.mjs <original-capture>.bin ` +
              `--module ${moduleType} --donor-vin <donor> --anon-vin ${inputAnonVin}\` ` +
              `against the ORIGINAL captured dump and re-commit ${label}.after.bin ` +
              `(and the matching .before.bin if it touches the same offsets).`,
            );
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

    // ─────────────────────────────────────────────────────────────────
    // Task #441 — synthetic-fixture coverage for module families that
    // don't yet have a committed real-bench dump under
    // __fixtures__/realDumps/. The script is correct but its slot tables
    // grow as new families are documented; this block exercises the same
    // round-trip + leak-scan asserts used for BCM/RFHUB/PCM against
    // hand-built buffers so a regression in (e.g.) the rfhubg1 scrubber
    // surfaces here even before the first real Gen1 dump is captured.
    //
    // When a real-bench fixture for one of these families lands, register
    // it in manifest.json + extend loader.js, then promote the family out
    // of this synthetic block into the per-fixture iteration above. The
    // synthetic coverage can stay as a "minimum baseline" alongside.
    //
    // The coverage-completeness sentinel below asserts every entry in
    // SCRUBBERS_BY_TYPE is exercised by either the real-fixture loop OR
    // this synthetic block — so a future maintainer who adds a new
    // family to the script (e.g. SGW) but forgets to add a matching test
    // sees a loud failure here, not a silent gap.
    // ─────────────────────────────────────────────────────────────────
    describe('synthetic-fixture coverage (no committed real-bench dump yet)', () => {
      // Helper: build a 2 KB Gen1 RFHUB buffer with the donor VIN + valid
      // CRC16 at 0x92, and rfh part-number ASCII at the documented
      // 0x0808/0x0812/0x082c slots so parseModule classifies it as RFHUB.
      function buildSyntheticRfhubGen1(vin) {
        const buf = new Uint8Array(2048).fill(0xFF);
        for (let i = 0; i < 17; i++) buf[RFH_GEN1_VIN_OFFSET + i] = vin.charCodeAt(i);
        const c = crc16(buf.slice(RFH_GEN1_VIN_OFFSET, RFH_GEN1_VIN_OFFSET + 17));
        buf[RFH_GEN1_VIN_OFFSET + 17] = (c >> 8) & 0xFF;
        buf[RFH_GEN1_VIN_OFFSET + 18] = c & 0xFF;
        return buf;
      }
      // Helper: build an 8 KB 95640 buffer with the donor VIN at every
      // documented plaintext slot.
      function buildSynthetic95640(vin) {
        const buf = new Uint8Array(8192).fill(0xFF);
        for (const off of EEP95640_VIN_OFFSETS) {
          for (let i = 0; i < 17; i++) buf[off + i] = vin.charCodeAt(i);
        }
        return buf;
      }

      // Task #449 — rfhubg1 graduated out of this synthetic round-trip
      // iteration once `__fixtures__/realDumps/rfhubg1.{before,after}.bin`
      // landed; it's now covered by the per-fixture loop above against an
      // actual 2 KB image. The parseModule cross-check below stays — the
      // real-fixture loop never calls parseModule, so the synthetic test
      // is the cheapest way to keep proving parseModule classifies a 2 KB
      // rfh buffer as RFHUB and surfaces the scrubbed 0x92 VIN.
      const synthetics = [
        { label: '95640',   moduleType: '95640',   minSlots: 3, build: buildSynthetic95640,   scan: scan95640Vins },
      ];

      // Task #450 — SGW (Secure Gateway) coverage. The slot table is
      // intentionally EMPTY (see SGW_VIN_OFFSETS in parseModule.js /
      // donorLeakScan.js) because no SGW dump byte offsets are documented
      // anywhere in the codebase yet. The shape of the assertions below is
      // therefore different from the rfhubg1 / 95640 synthetics:
      //
      //   1. A clean SGW buffer (no donor VIN anywhere) round-trips as a
      //      no-op — the scrubber reports 0 slots and the buffer comes out
      //      byte-for-byte identical.
      //   2. A buffer that DOES contain the donor VIN at an undocumented
      //      offset must throw — the post-scrub leak guard is the only
      //      thing standing between us and a silent leak when SGW dumps
      //      eventually start carrying VIN-shaped strings (audit logs,
      //      future firmware revisions, etc.).
      //
      // When real SGW VIN slot offsets are documented, populate
      // SGW_VIN_OFFSETS in donorLeakScan.js + parseModule.js, then promote
      // SGW out of this special block into the standard synthetic loop
      // above (its scrubber will start reporting slots automatically with
      // no further changes here — single source of truth).
      describe('sgw (synthetic, empty slot table)', () => {
        // Use a 4 KB buffer — a plausible size for an SGW EEPROM slice.
        // The exact size doesn't matter for these assertions; we just
        // need something the leak guard can scan.
        const SGW_BUF_SIZE = 4096;

        it('exposes an empty SGW_VIN_OFFSETS export', () => {
          // Pin the precondition the scrubber relies on. If this ever
          // grows entries (i.e. real SGW slots get documented), the
          // synthetic block above this one should be the one exercising
          // SGW — promote it out of this special case.
          expect(Array.isArray(SGW_VIN_OFFSETS)).toBe(true);
          expect(SGW_VIN_OFFSETS.length).toBe(0);
        });

        it('no-op scrubs a clean SGW buffer (0 slots, buffer unchanged)', () => {
          const buf = new Uint8Array(SGW_BUF_SIZE).fill(0xFF);
          const result = anonymizeBuffer({
            buffer: buf,
            moduleType: 'sgw',
            donorVin: STAND_IN_B,
            anonVin:  STAND_IN_A,
          });
          expect(result.slots.length, 'sgw: scrubber reports zero slots (empty table)').toBe(0);
          expect(result.buffer.length, 'sgw: buffer length preserved').toBe(buf.length);
          // Byte-for-byte equality — empty slot table means no writes.
          let firstDiff = -1;
          for (let i = 0; i < buf.length; i++) {
            if (buf[i] !== result.buffer[i]) { firstDiff = i; break; }
          }
          expect(firstDiff, 'sgw: clean buffer must round-trip unchanged').toBe(-1);
        });

        it('throws when the donor VIN appears verbatim at an undocumented offset', () => {
          // Plant the donor VIN at an offset the scrubber doesn't know
          // about (and never will, until SGW_VIN_OFFSETS gains entries).
          // The post-scrub leak guard MUST fire — that's the only thing
          // protecting future SGW fixtures from silent donor leaks.
          const buf = new Uint8Array(SGW_BUF_SIZE).fill(0xFF);
          const donorBytes = new TextEncoder().encode(STAND_IN_B);
          const leakOff = 0x100;
          for (let i = 0; i < donorBytes.length; i++) buf[leakOff + i] = donorBytes[i];

          expect(() => anonymizeBuffer({
            buffer: buf,
            moduleType: 'sgw',
            donorVin: STAND_IN_B,
            anonVin:  STAND_IN_A,
          })).toThrow(/post-scrub leak.*donor VIN.*still appears forward/);
        });

        it('throws when the donor VIN appears byte-reversed at an undocumented offset', () => {
          const buf = new Uint8Array(SGW_BUF_SIZE).fill(0xFF);
          const donorBytes = new TextEncoder().encode(STAND_IN_B);
          const donorRev = new Uint8Array(donorBytes).reverse();
          const leakOff = 0x200;
          for (let i = 0; i < donorRev.length; i++) buf[leakOff + i] = donorRev[i];

          expect(() => anonymizeBuffer({
            buffer: buf,
            moduleType: 'sgw',
            donorVin: STAND_IN_B,
            anonVin:  STAND_IN_A,
          })).toThrow(/post-scrub leak.*byte-reversed/);
        });

        it('throws when the donor tail-6 serial appears at an undocumented offset', () => {
          // With an empty slot-window table, ANY donor-tail occurrence is
          // outside-the-windows by definition — there are no windows.
          const buf = new Uint8Array(SGW_BUF_SIZE).fill(0xFF);
          const tailBytes = new TextEncoder().encode(STAND_IN_B.slice(-6));
          const leakOff = 0x300;
          for (let i = 0; i < tailBytes.length; i++) buf[leakOff + i] = tailBytes[i];

          expect(() => anonymizeBuffer({
            buffer: buf,
            moduleType: 'sgw',
            donorVin: STAND_IN_B,
            anonVin:  STAND_IN_A,
          })).toThrow(/post-scrub leak.*donor VIN tail/);
        });

        it('refuses to scrub when donor and anon share the same last-6 serial (sgw)', () => {
          const sharedTailAnon = STAND_IN_A.slice(0, 11) + STAND_IN_B.slice(-6);
          if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(sharedTailAnon)) return;
          expect(() => anonymizeBuffer({
            buffer: new Uint8Array(SGW_BUF_SIZE).fill(0xFF),
            moduleType: 'sgw',
            donorVin: STAND_IN_B,
            anonVin:  sharedTailAnon,
          })).toThrow(/share the same last-6/);
        });
      });

      for (const { label, moduleType, minSlots, build, scan } of synthetics) {
        describe(`${label} (synthetic)`, () => {
          it(`re-anonymizes ${label} buffer to STAND_IN_A without leaking the donor VIN`, () => {
            const donor = STAND_IN_B; // arbitrary donor for the synthetic
            const buf = build(donor);

            const result = anonymizeBuffer({
              buffer: buf,
              moduleType,
              donorVin: donor,
              anonVin:  STAND_IN_A,
            });

            expect(result.slots.length, `${label}: scrubbed slot count`).toBeGreaterThanOrEqual(minSlots);

            const donorBytes = new TextEncoder().encode(donor);
            const donorRev   = new Uint8Array(donorBytes).reverse();
            expect(indexOfBytes(result.buffer, donorBytes), `${label}: donor VIN must not appear forward`).toBe(-1);
            expect(indexOfBytes(result.buffer, donorRev),   `${label}: donor VIN must not appear byte-reversed`).toBe(-1);

            const slots = scan(result.buffer);
            expect(slots.length, `${label}: post-scrub VIN slot count`).toBeGreaterThanOrEqual(minSlots);
            for (const s of slots) {
              expect(
                s.vin,
                `${label}: VIN slot @ 0x${s.offset.toString(16).toUpperCase()} should hold STAND_IN_A`,
              ).toBe(STAND_IN_A);
            }
          });

          it(`functionally round-trips ${label} buffer (donor → other → donor restores every slot's VIN)`, () => {
            const donor = STAND_IN_B;
            const buf = build(donor);

            const step1 = anonymizeBuffer({
              buffer: buf,
              moduleType,
              donorVin: donor,
              anonVin:  STAND_IN_A,
            });
            const step2 = anonymizeBuffer({
              buffer: step1.buffer,
              moduleType,
              donorVin: STAND_IN_A,
              anonVin:  donor,
            });

            expect(step2.buffer.length, `${label}: round-trip length`).toBe(buf.length);

            const slots = scan(step2.buffer);
            expect(slots.length, `${label}: round-trip VIN slot count`).toBeGreaterThanOrEqual(minSlots);
            for (const s of slots) {
              expect(
                s.vin,
                `${label}: VIN slot @ 0x${s.offset.toString(16).toUpperCase()} should restore to '${donor}'`,
              ).toBe(donor);
            }
          });

          it(`refuses to scrub when donor and anon share the same last-6 serial (${label})`, () => {
            const donor = STAND_IN_B;
            const sharedTailAnon = STAND_IN_A.slice(0, 11) + donor.slice(-6);
            if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(sharedTailAnon)) return;
            expect(() => anonymizeBuffer({
              buffer: build(donor),
              moduleType,
              donorVin: donor,
              anonVin:  sharedTailAnon,
            })).toThrow(/share the same last-6/);
          });
        });
      }

      it('synthetic Gen1 RFHUB buffer parses as RFHUB and surfaces the scrubbed VIN', () => {
        // Sanity-cross-check: parseModule should agree the Gen1 buffer is
        // a real RFHUB so the helper's "module=rfhubg1" CLI alias actually
        // covers what the parser sees on disk. If parseModule ever stops
        // recognizing 0x92 as the Gen1 VIN slot, this test catches it
        // instead of letting the scrubber silently drift.
        const donor = STAND_IN_B;
        const result = anonymizeBuffer({
          buffer: buildSyntheticRfhubGen1(donor),
          moduleType: 'rfhubg1',
          donorVin: donor,
          anonVin:  STAND_IN_A,
        });
        const parsed = parseModule(result.buffer, 'rfh-gen1.bin');
        expect(parsed.type, 'parseModule should classify a 2 KB rfh-named buffer as RFHUB').toBe('RFHUB');
        const v92 = parsed.rfhVin92;
        expect(v92, 'parseModule should expose the 0x92 Gen1 VIN field').toBeTruthy();
        expect(v92.vin, 'Gen1 VIN should now read STAND_IN_A').toBe(STAND_IN_A);
        expect(v92.csOk, 'Gen1 VIN CRC should re-stamp to a valid checksum').toBe(true);
      });
    });

    // Coverage-completeness sentinel — see the synthetic-fixture block
    // header for the rationale.
    describe('coverage completeness', () => {
      const realFixtureFamilies = new Set(targets.map(t => t.moduleType));
      // Task #449 — rfhubg1 graduated into the per-fixture loop, so it
      // is no longer in the synthetic-only set.
      // Task #450 — sgw is registered with an empty slot table; its
      // round-trip is synthetic-only until a real SGW dump lands.
      // '95640' remains synthetic because no real-bench dump is
      // committed yet.
      const syntheticFamilies = new Set(['95640', 'sgw']);
      const covered = new Set([...realFixtureFamilies, ...syntheticFamilies]);

      for (const mt of Object.keys(SCRUBBERS_BY_TYPE)) {
        it(`module type '${mt}' has at least one round-trip test`, () => {
          expect(
            covered.has(mt),
            `Scrubber '${mt}' is registered in SCRUBBERS_BY_TYPE but no test exercises it. ` +
            `Add it to the synthetic-fixture block above (or commit a real-bench fixture).`,
          ).toBe(true);
        });
      }

      it('SUPPORTED_MODULE_TYPES and SCRUBBERS_BY_TYPE keys agree', () => {
        // Drift between the two tables is the most common way a maintainer
        // accidentally exposes a scrubber as a CLI alias without
        // implementing the actual write path (or vice versa).
        expect(new Set(SUPPORTED_MODULE_TYPES)).toEqual(new Set(Object.keys(SCRUBBERS_BY_TYPE)));
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Task #452 — auto-detection: a partial-VIN-shaped slot at a NON-
    // registered offset (e.g. a 2020+ Redeye cluster-B mirror) must be
    // scrubbed AND restored by the helper without any code change to the
    // slot table. The synthetic 64 KB BCM below plants exactly such a
    // slot and asserts both halves of the contract:
    //   1. After the first scrub, the donor's tail no longer appears at
    //      the variant offset (the helper found it on its own).
    //   2. The byte-for-byte round-trip restores the original buffer
    //      (including the variant slot's CRC), which is the round-trip
    //      check the task acceptance criterion calls for.
    // ─────────────────────────────────────────────────────────────────────
    describe('Task #452 auto-detection of non-registered partial-VIN slots', () => {
      const VARIANT_OFF = 0x4200; // outside BCM_PARTIAL_VIN_OFFSETS

      function buildSyntheticBcm(donorVin) {
        // 64 KB BCM EEPROM: 0xFF baseline, donor VIN at every documented
        // full-VIN base+8 slot (with CRC), donor's last 8 chars at both
        // registered partial-VIN offsets AND at VARIANT_OFF (with CRC).
        const buf = new Uint8Array(0x10000).fill(0xFF);
        const vinBytes = new TextEncoder().encode(donorVin);
        for (const base of [0x5300, 0x5320, 0x5340, 0x5360, 0x5380]) {
          const off = base + 8;
          for (let i = 0; i < 17; i++) buf[off + i] = vinBytes[i];
          const c = crc16(buf.slice(off, off + 17));
          buf[off + 17] = (c >> 8) & 0xFF;
          buf[off + 18] =  c       & 0xFF;
        }
        const tail = vinBytes.slice(9);
        const stamp = (po) => {
          for (let i = 0; i < BCM_PARTIAL_VIN_LEN; i++) buf[po + i] = tail[i];
          const c = crc16(tail);
          buf[po + BCM_PARTIAL_VIN_LEN]     = (c >> 8) & 0xFF;
          buf[po + BCM_PARTIAL_VIN_LEN + 1] =  c       & 0xFF;
        };
        for (const po of BCM_PARTIAL_VIN_OFFSETS) stamp(po);
        stamp(VARIANT_OFF);
        return buf;
      }

      const DONOR_VIN = '2C3CDXKT3FH796320';

      it('helper auto-detects + scrubs a partial-VIN slot at a non-registered offset', () => {
        expect(BCM_PARTIAL_VIN_OFFSETS.includes(VARIANT_OFF)).toBe(false);
        const buf = buildSyntheticBcm(DONOR_VIN);

        // Sanity: the helper sees the variant slot before the scrub.
        const preDetected = findBcmPartialVinSlots(buf).map(d => d.offset);
        expect(preDetected).toContain(VARIANT_OFF);

        const result = anonymizeBuffer({
          buffer: buf,
          moduleType: 'bcm',
          donorVin: DONOR_VIN,
          anonVin:  STAND_IN_A,
        });

        // The helper must report the variant slot in its own slots[] list.
        const scrubbedOffsets = result.slots
          .filter(s => s.kind === 'bcm-partial')
          .map(s => s.offset);
        expect(scrubbedOffsets).toContain(VARIANT_OFF);

        // The donor's tail bytes at VARIANT_OFF must now be the anon's tail.
        const newTail = decodeAscii(result.buffer.slice(VARIANT_OFF, VARIANT_OFF + BCM_PARTIAL_VIN_LEN));
        expect(newTail).toBe(STAND_IN_A.slice(-BCM_PARTIAL_VIN_LEN));

        // And the helper's own post-scrub leak guard already throws if the
        // donor's last-6 survived anywhere — getting here means it didn't.
      });

      it('byte-for-byte round-trip restores the variant slot (would fail if helper missed it)', () => {
        const buf = buildSyntheticBcm(DONOR_VIN);

        // Step 1: DONOR → STAND_IN_A. Auto-detection rewrites VARIANT_OFF.
        const step1 = anonymizeBuffer({
          buffer: buf,
          moduleType: 'bcm',
          donorVin: DONOR_VIN,
          anonVin:  STAND_IN_A,
        });
        // Step 2: STAND_IN_A → DONOR. Auto-detection rewrites VARIANT_OFF
        // again (the slot now holds STAND_IN_A's tail with valid CRC, so
        // the detector picks it up), restoring the original bytes.
        const step2 = anonymizeBuffer({
          buffer: step1.buffer,
          moduleType: 'bcm',
          donorVin: STAND_IN_A,
          anonVin:  DONOR_VIN,
        });

        expect(step2.buffer.length).toBe(buf.length);
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] !== step2.buffer[i]) {
            throw new Error(
              `byte mismatch at 0x${i.toString(16).toUpperCase().padStart(4, '0')}: ` +
              `original=0x${buf[i].toString(16).padStart(2, '0')} ` +
              `round-trip=0x${step2.buffer[i].toString(16).padStart(2, '0')} — ` +
              `auto-detection of the non-registered partial-VIN slot at ` +
              `0x${VARIANT_OFF.toString(16).toUpperCase()} regressed.`,
            );
          }
        }
      });
    });

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

// Synthetic-fixture VIN scanner — local, narrow analog of scanFullVins
// that reads the 3-slot 95640 layout. Kept inline (rather than imported)
// to catch drift between the script's slot table and the test's
// expectations. (Task #449 — the Gen1 analog `scanGen1Vin` was retired
// when rfhubg1 graduated into the per-fixture loop above.)
function scan95640Vins(buf) {
  const out = [];
  for (const off of EEP95640_VIN_OFFSETS) {
    if (off + 17 > buf.length) continue;
    const slice = buf.slice(off, off + 17);
    if (looksLikeVinBytes(slice)) out.push({ offset: off, vin: decodeAscii(slice) });
  }
  return out;
}

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

// Return up to `cap` byte mismatches between two equal-length buffers, in
// ascending offset order. Used by the byte-equality round-trip test to
// surface a focused first-N diff in the failure message — exactly the
// "exact slot whose CRC differs" pointer Task #448 calls for.
function listDiffs(a, b, cap) {
  const out = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n && out.length < cap; i++) {
    if (a[i] !== b[i]) out.push({ offset: i, committed: a[i], helper: b[i] });
  }
  return out;
}
