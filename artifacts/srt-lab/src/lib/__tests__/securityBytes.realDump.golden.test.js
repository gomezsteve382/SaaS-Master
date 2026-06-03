import { describe, it, expect } from 'vitest';

import {
  writeBcmSec16Gen2,
  writePcmSec6,
  writeRfhSec16FromBcm,
  writeRfhSec16Gen1,
} from '../securityBytes.js';
import { parseModule } from '../parseModule.js';
import { crc8_65 } from '../crc.js';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Real-dump golden vectors for the three security-byte writers.
//
// Companion to securityBytes.golden.test.js: that file pins the writers
// against SYNTHETIC, hand-built buffers (proves internal consistency).
// THIS file pins the writers against an anonymized BEFORE/AFTER triple
// captured from a known-good real-bench Module Sync run. If the writers
// drift from what an actual SINCRO/ArmandoQS-flashed ECU would produce,
// these assertions fail.
//
// The fixture loader returns null when the dumps have not yet been
// committed — in that case every suite below is `describe.skip`'d so the
// build stays green. As soon as the binaries land in
// src/lib/__fixtures__/realDumps/ alongside a manifest.json, the suites
// switch on automatically.
//
// See ../__fixtures__/realDumps/README.md for the manifest schema and the
// anonymization checklist.
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = loadRealDumpFixtures();
const haveAny = fixtures !== null;

/* Compare two Uint8Arrays byte-for-byte. On mismatch produce a focused
 * diff message that points at the first ~10 differing offsets so a
 * regression is debuggable without dumping 64 KiB of hex. */
function expectBytesEqual(actual, expected, label) {
  expect(actual.length, `${label}: length mismatch`).toBe(expected.length);
  const diffs = [];
  for (let i = 0; i < expected.length && diffs.length < 10; i++) {
    if (actual[i] !== expected[i]) {
      diffs.push(
        `0x${i.toString(16).padStart(4, '0')}: ` +
        `got 0x${actual[i].toString(16).padStart(2, '0')}, ` +
        `expected 0x${expected[i].toString(16).padStart(2, '0')}`,
      );
    }
  }
  // Count total diffs for the failure message (cheap second pass — only
  // walked when we already know there's at least one diff).
  if (diffs.length > 0) {
    let total = 0;
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) total++;
    }
    throw new Error(
      `${label}: ${total} byte(s) differ. First mismatches:\n  ${diffs.join('\n  ')}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level skip when the manifest itself is missing — surfaces a single,
// non-noisy skipped describe instead of one per writer.
// ─────────────────────────────────────────────────────────────────────────────

(haveAny ? describe : describe.skip)('securityBytes — real-dump golden vectors', () => {
  if (!haveAny) {
    it.skip('no real-dump fixtures committed yet (see __fixtures__/realDumps/README.md)', () => {});
    return;
  }

  // Per-module suites — each independently skipped if its before/after
  // pair is missing from the manifest. That way a partial commit (e.g.
  // BCM triple only) still validates what's there.

  // Each pair carries its own effective `rfhSec16` (per-pair override in
  // the manifest, or the top-level default). That lets the manifest mix
  // pairs from different captured vehicles (e.g. the primary BCM is from
  // VIN A while the rfhub/pcm/secondary-BCM triple is from VIN B) without
  // forcing a shared SEC16.

  const bcmDescribe = fixtures.bcm ? describe : describe.skip;
  bcmDescribe('writeBcmSec16Gen2 — real BCM dump (primary)', () => {
    if (!fixtures.bcm) {
      it.skip('no BCM before/after pair in manifest', () => {});
      return;
    }
    it('produces the captured "after" BCM bytes from the captured "before" BCM bytes', () => {
      const r = writeBcmSec16Gen2(fixtures.bcm.before, fixtures.bcm.rfhSec16);
      expectBytesEqual(r.bytes, fixtures.bcm.after, 'BCM');
      // Sanity: the writer must have actually patched something — a no-op
      // would also satisfy bytewise equality only if before === after, in
      // which case the fixture is useless and we want a loud failure.
      expect(
        r.splitPatched + r.mirrorPatched,
        'writer reported zero patches — fixture before/after look identical',
      ).toBeGreaterThan(0);
    });
  });

  // Secondary BCM pairs (different VIN than the primary). Each entry gets
  // its own suite so a regression points at the specific pair.
  const extraBcms = Array.isArray(fixtures.extraBcms) ? fixtures.extraBcms : [];
  (extraBcms.length > 0 ? describe : describe.skip)(
    'writeBcmSec16Gen2 — real BCM dump (secondary VINs)',
    () => {
      if (extraBcms.length === 0) {
        it.skip('no secondary BCM pairs in manifest', () => {});
        return;
      }
      extraBcms.forEach((pair, idx) => {
        const skip = pair.skipSec16RoundTrip;
        const itFn = skip ? it.skip : it;
        itFn(`extraBcm[${idx}]: round-trips byte-for-byte` + (skip ? ' (skipped: skipSec16RoundTrip — VIN-write fixture)' : ''), () => {
          const r = writeBcmSec16Gen2(pair.before, pair.rfhSec16);
          expectBytesEqual(r.bytes, pair.after, `BCM[${idx}]`);
          expect(
            r.splitPatched + r.mirrorPatched,
            `extraBcm[${idx}] writer reported zero patches — fixture identical`,
          ).toBeGreaterThan(0);
        });
      });
    },
  );

  const rfhubDescribe = fixtures.rfhub ? describe : describe.skip;
  rfhubDescribe('writeRfhSec16FromBcm — real RFHUB dump', () => {
    if (!fixtures.rfhub) {
      it.skip('no RFHUB before/after pair in manifest', () => {});
      return;
    }
    it('produces the captured "after" RFHUB bytes from the captured "before" RFHUB bytes', () => {
      // BCM SEC16 = reverse(RFH SEC16). The writer expects the BCM-form
      // input (it reverses internally to recover the RFH form).
      const bcmSec16 = new Uint8Array(16);
      for (let i = 0; i < 16; i++) bcmSec16[i] = fixtures.rfhub.rfhSec16[15 - i];
      const r = writeRfhSec16FromBcm(fixtures.rfhub.before, bcmSec16);
      expectBytesEqual(r.bytes, fixtures.rfhub.after, 'RFHUB');
      expect(
        r.patched,
        'writer reported zero patches — fixture before/after look identical',
      ).toBeGreaterThan(0);
    });
  });

  const pcmDescribe = fixtures.pcm ? describe : describe.skip;
  pcmDescribe('writePcmSec6 — real PCM dump', () => {
    if (!fixtures.pcm) {
      it.skip('no PCM before/after pair in manifest', () => {});
      return;
    }
    it('produces the captured "after" PCM bytes from the captured "before" PCM bytes', () => {
      const r = writePcmSec6(fixtures.pcm.before, fixtures.pcm.rfhSec16);
      expectBytesEqual(r.bytes, fixtures.pcm.after, 'PCM');
      expect(
        r.patched,
        'writer reported zero patches — fixture before/after look identical',
      ).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Gen1 RFHUB (Yazaki 24C16, 2 KB) — writeRfhSec16Gen1 round-trip
  //
  // ⚠️  FORMULA_UNVERIFIED_ON_REAL_HW
  //
  // The manifest entry `rfhubg1` was derived from the donor-style synthetic
  // golden fixture `lx_charger_2014_fullhouse.bin` (a hand-built layout
  // conformance fixture, NOT a physical EEPROM capture).  This means the
  // round-trip below confirms that writeRfhSec16Gen1 is internally consistent
  // with the fixture's own crc8_65 checksum — it does NOT confirm that a
  // real Yazaki 24C16 chip stores its SEC16 CS with the same polynomial.
  //
  // HOW TO UPGRADE when a real 24C16 dump surfaces:
  //   1. Sanitize the physical dump (scrub the VIN at 0x92, recompute CRC16
  //      BE at +17/+18 from crc16(vinAscii) — see __golden__/README.md).
  //   2. Erase both SEC16 slots (0x00AE and 0x00C0, each 18 B) to 0xFF to
  //      produce `rfhubg1.before.bin`.
  //   3. Keep the original dump as `rfhubg1.after.bin` (the paired state).
  //   4. Update the manifest `rfhubg1` entry with the donor VIN, anon VIN,
  //      the real rfhSec16Hex, and set source = 'real-sanitized'.
  //   5. Run this test.  If it fails, the real chip uses a different CS
  //      formula — inspect parseModule(dump,'x.bin').sec16s[*].csOk and
  //      correct both writeRfhSec16Gen1 AND the !sec16IsGen2 branch in
  //      parseModule.js, then rebuild the fixture pair and re-run.
  // ─────────────────────────────────────────────────────────────────────────
  const rfhubg1Describe = fixtures.rfhubg1 ? describe : describe.skip;
  rfhubg1Describe('writeRfhSec16Gen1 — Gen1 RFHUB dump (FORMULA_UNVERIFIED_ON_REAL_HW)', () => {
    if (!fixtures.rfhubg1) {
      it.skip('no rfhubg1 before/after pair in manifest', () => {});
      return;
    }
    it('produces the captured "after" Gen1 RFHUB bytes from the captured "before" bytes', () => {
      // manifest rfhSec16 is in RFHUB form; writeRfhSec16Gen1 expects BCM
      // form (it reverses internally), so reverse here before passing in.
      const rfhSec16 = fixtures.rfhubg1.rfhSec16;
      const bcmSec16 = new Uint8Array(16);
      for (let i = 0; i < 16; i++) bcmSec16[i] = rfhSec16[15 - i];

      const r = writeRfhSec16Gen1(fixtures.rfhubg1.before, bcmSec16);
      expectBytesEqual(r.bytes, fixtures.rfhubg1.after, 'Gen1-RFHUB');
      expect(
        r.patched,
        'writer reported zero patches — fixture before/after look identical',
      ).toBeGreaterThan(0);
    });

    it('both SEC16 slots in the "after" buffer have csOk=true under parseModule', () => {
      const info = parseModule(fixtures.rfhubg1.after, 'rfhubg1.after.bin');
      expect(info.type).toBe('RFHUB');
      expect(info.rfhGen).toBe('Gen1 (24C16)');
      expect(info.sec16s.length).toBeGreaterThanOrEqual(2);
      for (const s of info.sec16s) {
        expect(s.csOk, `slot @ 0x${s.offset.toString(16)}: csOk`).toBe(true);
      }
      expect(info.sec16match).toBe(true);
      expect(info.sec16valid).toBe(true);
    });

    it('source metadata documents provenance (synthetic or real-sanitized)', () => {
      expect(typeof fixtures.rfhubg1.source).toBe('string');
      expect(fixtures.rfhubg1.source.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EEE+ Gen2 RFHUB twinning — VERIFIED-PART-ONLY pin
  //
  // Fixture `rfhubEeePlus` is an anonymized real FCA SINCRO twinning of a
  // 2019+ "EEE+" Charger RFHUB (donor VIN 2C3CDXL92KH674464), independently
  // confirmed against the competitor SINCRO tool. Unlike the classic Gen2
  // `rfhub` pair above, this image does NOT carry the AA 55 31 01 Gen2
  // header at 0x0500 (it reads FF FF 00 00) and its SEC16 slots store a
  // DIFFERENT trailing checksum byte (0x05) than our crc8_65 writer emits
  // (0xFD).
  //
  // Per the task decision we pin ONLY the part that is independently
  // verified: the 16-byte SEC16 PAYLOAD at both slots == reverse(BCM SEC16).
  // The checksum byte, the AA5531 marker, and the VIN/CRC stamping are
  // KNOWN EEE+ limitations that are asserted-as-DIFFERENT here (so a future
  // writer change that starts matching them surfaces loudly and the pin can
  // be graduated) — they are NOT pinned as writer output, and writer logic
  // is intentionally unchanged.
  // ─────────────────────────────────────────────────────────────────────────
  const eeePlusDescribe = fixtures.rfhubEeePlus ? describe : describe.skip;
  eeePlusDescribe('writeRfhSec16FromBcm — EEE+ RFHUB twinning (verified SEC16 payload only)', () => {
    if (!fixtures.rfhubEeePlus) {
      it.skip('no rfhubEeePlus before/after pair in manifest', () => {});
      return;
    }
    const SLOTS = [0x050E, 0x0522];
    const eee = fixtures.rfhubEeePlus;
    // BCM SEC16 = reverse(RFH SEC16); the writer reverses internally.
    const bcmSec16 = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bcmSec16[i] = eee.rfhSec16[15 - i];

    it('captured SINCRO "after" stores SEC16 payload = reverse(BCM) at both slots', () => {
      for (const off of SLOTS) {
        expectBytesEqual(eee.after.slice(off, off + 16), eee.rfhSec16, `EEE+ after @0x${off.toString(16)}`);
      }
    });

    it('our writer reproduces the SAME 16-byte SEC16 payload (checksum byte excluded)', () => {
      // The EEE+ image lacks the AA 55 31 01 Gen2 header the writer gates
      // on, so stamp it onto a throwaway copy purely to clear the gate — we
      // assert ONLY the SEC16 payload the writer produces, never the header.
      const stamped = new Uint8Array(eee.before);
      stamped[0x0500] = 0xAA; stamped[0x0501] = 0x55; stamped[0x0502] = 0x31; stamped[0x0503] = 0x01;
      const r = writeRfhSec16FromBcm(stamped, bcmSec16);
      expect(r.patched).toBe(2);
      expect(r.rfhSec16Hex).toBe('f0b61be3c75bc294b624783af0aa5a55');
      for (const off of SLOTS) {
        expectBytesEqual(r.bytes.slice(off, off + 16), eee.rfhSec16, `EEE+ writer @0x${off.toString(16)}`);
      }
    });

    it('documents KNOWN EEE+ gaps: checksum byte and Gen2 marker differ from writer output', () => {
      // (1) Checksum byte: SINCRO stores 0x05 at slot+16; our crc8_65 writer
      //     emits 0xFD. UNSOLVABLE EEE+ checksum variant (NOT a quick writer
      //     tweak): only two real EEE+ SEC16 vectors exist in the whole corpus
      //     (this one f0b6…→0x05 and 5902…→0x2e) and they leave the CRC8
      //     underdetermined — 1280 candidate fits across 5 polys, the classic
      //     Gen2 poly 0x65 gives ZERO solutions, and no simple sum/xor or
      //     crc8_65^const fits both. Asserted-as-different so the day a real
      //     formula is derived (after more captures land) this fails loudly.
      const ourChk = crc8_65(eee.rfhSec16);
      expect(ourChk).toBe(0xFD);
      for (const off of SLOTS) {
        expect(eee.after[off + 16], `EEE+ stored chk @0x${(off + 16).toString(16)}`).toBe(0x05);
        expect(eee.after[off + 16]).not.toBe(ourChk);
      }
      // (2) Gen2 banner: classic Gen2 reads AA 55 31 01 @0x0500; EEE+ carries
      //     FF FF 00 00, and SINCRO LEAVES IT UNCHANGED through the twin (the
      //     captured before AND after both read FF FF 00 00). Our sync writer
      //     (runRfhBcmSync BCM_TO_RFH) instead auto-stamps AA 55 31 01 to clear
      //     the Gen2 writer gate and emits a SELF-CONSISTENT crc8_65 twin — a
      //     deliberately-pinned behavior (see charger62bench.realfiles.test.js)
      //     that is NOT byte-for-byte SINCRO. Graduating it to byte-for-byte is
      //     blocked on the unsolved checksum above.
      const hdrBefore = Array.from(eee.before.slice(0x0500, 0x0504));
      const hdrAfter = Array.from(eee.after.slice(0x0500, 0x0504));
      expect(hdrBefore).toEqual([0xFF, 0xFF, 0x00, 0x00]);
      expect(hdrAfter).toEqual([0xFF, 0xFF, 0x00, 0x00]);
      expect(hdrAfter).not.toEqual([0xAA, 0x55, 0x31, 0x01]);
    });
  });
});
