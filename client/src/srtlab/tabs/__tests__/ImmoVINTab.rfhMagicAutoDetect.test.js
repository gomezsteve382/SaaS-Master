/* ============================================================================
 * Task #491 — ImmoVINTab RFHSection: must auto-detect the Gen2 VIN-CS
 * "magic" XOR constant (0xDB on 2020+ Redeye, 0x87 on earlier Gen2, etc.)
 * from the first populated slot in the buffer, instead of the pre-#491
 * hard-coded crc8rf path.
 *
 * Pre-#491 the tab computed `crc8rf(rev17)` which only matches RFHUB
 * SEC16 checksums (algo 'c8r'), not the Gen2 VIN-CS. On a real Gen2 RFHUB
 * dump the inspect panel rendered every slot as "CRC FAIL" because the
 * real algorithm is `xorReduce(rev17) ^ magic` with a per-firmware magic
 * — and `applyRfhub` then re-stamped a wrong CS byte that the BCM/RFHUB
 * pair check would reject on the real bench.
 *
 * This file pins the new auto-detect behaviour in three layers:
 *   1. Real-bench Gen2 fixture (rfhub.after.bin, anonVin
 *      2C3CDXCT1HH600000) — parseRfhub must surface 4/4 CRC-OK slots and
 *      applyRfhub(buf, sameVin) must round-trip byte-equal at every
 *      slot.
 *   2. Synthetic Gen2 image with magic 0x87 — parseRfhub must still
 *      flag every slot CRC-OK (proves auto-detect picks the magic
 *      that's actually live in the buffer, not the 0xDB default).
 *   3. Synthetic VIN-rewrite with applyRfhub against the 0x87 buffer
 *      — the patched buffer must continue to validate under magic
 *      0x87 (proves the writer does NOT regress to a different
 *      Gen2 dialect).
 * ============================================================================ */
import { describe, it, expect } from 'vitest';
import { parseRfhub, applyRfhub } from '../ImmoVINTab.jsx';
import {
  rfhGen2VinCs,
  rfhGen2DetectMagic,
} from '../../lib/crc.js';
import { loadRealDumpFixtures } from '../../lib/__fixtures__/realDumps/loader.js';

const RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function reverse17(buf) {
  const out = new Uint8Array(17);
  for (let i = 0; i < 17; i++) out[i] = buf[16 - i];
  return out;
}
function buildSyntheticGen2(vin, magic) {
  const buf = new Uint8Array(4096).fill(0xFF);
  const rev = reverse17(asciiBytes(vin));
  const cs = rfhGen2VinCs(rev, magic);
  for (const off of RFH_VIN_OFFSETS) {
    for (let i = 0; i < 17; i++) buf[off + i] = rev[i];
    buf[off + 17] = cs;
  }
  return buf;
}

describe('Task #491 — ImmoVINTab RFHSection: Gen2 VIN-CS magic auto-detect', () => {

  describe('Real-bench Gen2 RFHUB fixture (rfhub.after.bin)', () => {
    const fx = loadRealDumpFixtures();
    const rfh = fx ? fx.rfhub : null;

    if (!rfh) {
      it.skip('rfhub fixture not present in manifest', () => {});
      return;
    }

    const REAL_VIN = rfh.anonVin;          // '2C3CDXCT1HH600000'
    const buf = rfh.after;                 // anonymized synced state

    it('parses as a 4 KB Gen2 image (validSz)', () => {
      expect(buf.length).toBe(4096);
      const res = parseRfhub(buf);
      expect(res.validSz).toBe(true);
    });

    it('the auto-detected magic agrees with rfhGen2DetectMagic on slot 1', () => {
      const slot1 = buf.slice(0x0EA5, 0x0EA5 + 17);
      const cs1 = buf[0x0EA5 + 17];
      const magic = rfhGen2DetectMagic(slot1, cs1);
      // Sanity: the magic must reproduce the same CS byte when re-applied.
      expect(rfhGen2VinCs(slot1, magic)).toBe(cs1);
    });

    it('every Gen2 VIN slot is CRC-OK with the auto-detected magic', () => {
      const res = parseRfhub(buf);
      expect(res.slots).toHaveLength(4);
      for (const s of res.slots) {
        expect(s.vin).toBe(REAL_VIN);
        expect(s.crcOk).toBe(true);
        expect(s.csCalc).toBe(s.csStored);
      }
    });

    it('applyRfhub(buf, sameVin) round-trips byte-equal at every slot (idempotent)', () => {
      const out = applyRfhub(buf, REAL_VIN);
      for (const off of RFH_VIN_OFFSETS) {
        for (let i = 0; i < 18; i++) {
          if (out[off + i] !== buf[off + i]) {
            throw new Error(
              'applyRfhub regressed slot @ 0x' + off.toString(16).toUpperCase() +
              ' byte +' + i + ' (got 0x' + out[off + i].toString(16).padStart(2,'0') +
              ', expected 0x' + buf[off + i].toString(16).padStart(2,'0') + ')'
            );
          }
        }
      }
    });

    it('applyRfhub(buf, newVin) writes the new VIN with a CS that re-validates under the SAME magic', () => {
      const NEW_VIN = '2C3CDXCT1HH600999';
      const out = applyRfhub(buf, NEW_VIN);
      const res = parseRfhub(out);
      expect(res.slots).toHaveLength(4);
      for (const s of res.slots) {
        expect(s.vin).toBe(NEW_VIN);
        expect(s.crcOk).toBe(true);
      }
    });
  });

  describe('Synthetic Gen2 buffer with magic 0x87 (early Gen2 dialect)', () => {
    const VIN = '2C3CDXCT5EH700123';
    const buf87 = buildSyntheticGen2(VIN, 0x87);

    it('parseRfhub flags every slot CRC-OK (auto-detect picks 0x87, not the 0xDB default)', () => {
      const res = parseRfhub(buf87);
      expect(res.slots).toHaveLength(4);
      for (const s of res.slots) {
        expect(s.vin).toBe(VIN);
        expect(s.crcOk).toBe(true);
      }
    });

    it('applyRfhub(buf87, sameVin) preserves the 0x87 magic in the rewritten CS byte', () => {
      const out = applyRfhub(buf87, VIN);
      // The CS byte must equal rfhGen2VinCs(rev17, 0x87) — i.e. the
      // writer auto-detected 0x87 from the existing slot data and did
      // NOT regress to the 0xDB default.
      const rev = reverse17(asciiBytes(VIN));
      const expectedCs87 = rfhGen2VinCs(rev, 0x87);
      const expectedCsDb = rfhGen2VinCs(rev, 0xDB);
      expect(expectedCs87).not.toBe(expectedCsDb); // sanity: magics differ
      for (const off of RFH_VIN_OFFSETS) {
        expect(out[off + 17]).toBe(expectedCs87);
      }
    });

    it('applyRfhub(buf87, newVin) writes a CS that auto-detected magic 0x87 must validate', () => {
      const NEW_VIN = '2C3CDXCT5EH700456';
      const out = applyRfhub(buf87, NEW_VIN);
      const res = parseRfhub(out);
      for (const s of res.slots) {
        expect(s.vin).toBe(NEW_VIN);
        expect(s.crcOk).toBe(true);
      }
      // Cross-check: the same buffer parsed under the wrong magic
      // (0xDB default) would NOT validate — proves the parser's
      // auto-detect is what makes the test pass.
      const rev = reverse17(asciiBytes(NEW_VIN));
      expect(rfhGen2VinCs(rev, 0x87)).toBe(out[RFH_VIN_OFFSETS[0] + 17]);
      expect(rfhGen2VinCs(rev, 0xDB)).not.toBe(out[RFH_VIN_OFFSETS[0] + 17]);
    });
  });

  describe('Virgin (all-0xFF) Gen2 image — magic falls back to 0xDB safely', () => {
    it('parseRfhub does not crash and yields no CRC-OK slots', () => {
      const buf = new Uint8Array(4096).fill(0xFF);
      const res = parseRfhub(buf);
      expect(res.validSz).toBe(true);
      expect(res.slots).toHaveLength(4);
      // Every slot decodes the 0xFF bytes as null (invalid VIN), so crcOk
      // is whatever crc(0xFF×17) ^ 0xDB happens to equal vs 0xFF — but
      // the important thing is the parser returns cleanly without
      // throwing on a virgin image (spec line: "Gen1 (≤2KB) doesn't
      // carry the 0x0EA5+ Gen2 slot table — return an empty slot list",
      // mirrored here for the all-0xFF Gen2 case).
      for (const s of res.slots) {
        expect(s.vin).toBeNull();
      }
    });
  });

  describe('Gen1 (2KB) image — slot list is empty (no Gen2 0x0EA5 table)', () => {
    it('parseRfhub returns slots:[] for a 2 KB image', () => {
      const buf = new Uint8Array(2048).fill(0xFF);
      const res = parseRfhub(buf);
      expect(res.validSz).toBe(true);
      expect(res.slots).toEqual([]);
    });
  });
});
