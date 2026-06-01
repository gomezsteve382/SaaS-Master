import { describe, it, expect } from 'vitest';

import {
  crc16,
  crc8_42,
  crc8rf,
  crc8_65,
  rfhSec16Cs,
  rfhGen2VinCs,
  rfhGen2DetectMagic,
} from '../crc.js';
import { parseModule } from '../parseModule.js';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #1023 — checksum-primitive golden vectors pinned to REAL bench files.
//
// crc.golden.test.js pins the primitives against reference strings and one
// anonymized hand-entered slot. THIS file pins them against the on-disk
// checksum bytes of the committed real-bench dumps: it reads the actual stored
// CRC/CS bytes out of the binaries and asserts the crc.js primitives reproduce
// them exactly. If a polynomial / init / magic constant ever drifts, the value
// the primitive computes will no longer match what a real ECU actually wrote,
// and these assertions fail loudly.
//
// Fixtures load via the shared loader; if the dumps are not committed the loader
// returns null and the suite is describe.skip'd so the build stays green.
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = loadRealDumpFixtures();
const haveAny = fixtures !== null;
const enc = new TextEncoder();

describe.skipIf(!haveAny)('checksum primitives ↔ real on-disk bench checksums', () => {
  it.skipIf(!fixtures?.rfhub)('rfhSec16Cs / crc8_65 reproduce the RFHUB Gen2 SEC16 stored CS', () => {
    const ri = parseModule(fixtures.rfhub.after, 'RFH.bin');
    const populated = (ri.sec16s || []).filter((s) => s && !s.blank);
    expect(populated.length).toBeGreaterThan(0);
    for (const s of populated) {
      const raw = new Uint8Array(s.raw);
      // The CS the ECU actually stored on disk.
      expect(rfhSec16Cs(raw)).toBe(s.cs);
      // CS is (crc8_65 << 8) | 0x00 big-endian.
      expect(crc8_65(raw)).toBe(s.cs >> 8);
      expect(s.cs & 0xff).toBe(0x00);
      // parseModule's own recompute must agree (defense in depth).
      expect(s.csCalc).toBe(s.cs);
      expect(s.csOk).toBe(true);
    }
  });

  it.skipIf(!fixtures?.rfhub)('rfhGen2VinCs / rfhGen2DetectMagic reproduce the RFHUB Gen2 VIN CS', () => {
    const ri = parseModule(fixtures.rfhub.after, 'RFH.bin');
    const vins = (ri.vins || []).filter((v) => typeof v.sc === 'number' && typeof v.magic === 'number');
    expect(vins.length).toBeGreaterThan(0);
    for (const v of vins) {
      const vinBytes = enc.encode(v.vin);
      // Stored VIN CS on disk == XOR-all-17 ⊕ magic.
      expect(rfhGen2VinCs(vinBytes, v.magic)).toBe(v.sc);
      // The magic byte is recoverable from the stored CS + VIN.
      expect(rfhGen2DetectMagic(vinBytes, v.sc)).toBe(v.magic);
    }
  });

  it.skipIf(!fixtures?.extraBcms?.length)('crc16 reproduces the BCM full-VIN CRC16 stored on disk', () => {
    let checked = 0;
    for (const bcmPair of fixtures.extraBcms) {
      const bytes = bcmPair.after;
      const bi = parseModule(bytes, 'BCM.bin');
      for (const v of bi.vins || []) {
        if (v.crcOk !== true) continue; // only pin slots the parser confirmed valid
        const off = v.offset;
        const stored = (bytes[off + 17] << 8) | bytes[off + 18]; // BE16 @ vinOff+17/+18
        expect(crc16(enc.encode(v.vin))).toBe(stored);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  // crc8_42 (FCA 8-bit) and crc8rf (RFHUB Gen1 VIN CS) are not stored at the
  // SEC16 offset in the Gen2 fixtures, so we pin them over a byte sequence that
  // genuinely exists on disk (the real RFHUB Gen2 SEC16 record). This ties the
  // golden value to real-file bytes; any constant drift trips it.
  it.skipIf(!fixtures?.rfhub)('crc8_42 / crc8rf are pinned over a real on-disk SEC16 byte sequence', () => {
    const ri = parseModule(fixtures.rfhub.after, 'RFH.bin');
    const s = (ri.sec16s || []).find((x) => x && !x.blank);
    expect(s).toBeTruthy();
    const raw = new Uint8Array(s.raw);
    expect(s.hex).toBe('816531F7CDE32E33C25A415C8440C72A'); // anchor the input bytes
    expect(crc8_42(raw)).toBe(0xe4);
    expect(crc8rf(raw)).toBe(0x26);
    // crc16 over the same real slice (full-width 16-bit primitive, real input).
    expect(crc16(raw)).toBe(0xfe51);
  });
});
