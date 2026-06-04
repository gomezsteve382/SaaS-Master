/* ============================================================================
 * Task #47 — Verify secondary and partial VIN offsets match real BCM dumps.
 *
 * Pre-task state in TwinTab.jsx:
 *   BCM_VIN_SECONDARY = [0x0698, 0x06B8, 0x06D8, 0x06F8, 0x0718, 0x0738]
 *   BCM_VIN_PARTIAL   = [0x4098, 0x40B0]
 *
 * Verified corrections:
 *   1. The six "secondary" full-VIN slots at 0x0698..0x0738 do NOT EXIST in
 *      any real BCM dump — they were fabricated offsets that caused
 *      applyBcmFromRfh to silently corrupt those BCM regions. Removed.
 *   2. Real alt-zone Charger BCMs carry partial-VIN slots at 0x0098/0x00B0 IN
 *      ADDITION TO the canonical 0x4098/0x40B0 pair (confirmed by the Task
 *      #491 manifest entry and the ImmoVINTab.bcmVinWrite golden pair test).
 *   3. parseBcm now auto-detects partial slots via findBcmPartialVinSlots so
 *      the UI shows CS OK badges for every confirmed slot.
 *   4. applyBcmFromRfh now auto-detects partial slots before writing, ensuring
 *      it covers 0x0098/0x00B0 and never writes to the removed secondary zone.
 *
 * Test strategy:
 *   A. Against the real alt-zone fixture (charger-bcm-vin-write/bcm.before.bin)
 *      — if the fixture is present, confirm the four partial slots are found,
 *      the secondary addresses carry no VIN data, parseBcm surfaces them
 *      with CS OK badges, and applyBcmFromRfh leaves the secondary range
 *      byte-for-byte identical.
 *   B. Synthetic 64 KB buffer — always runs; plants partial-VIN records at
 *      0x0098/0x00B0/0x4098/0x40B0 and sentinel bytes in the secondary range,
 *      then calls applyBcmFromRfh directly and asserts secondary range is
 *      untouched and every detected partial slot has the new tail.
 * ============================================================================ */

import { describe, it, expect } from 'vitest';
import { crc16 } from '../../lib/crc.js';
import { loadRealDumpFixtures } from '../../lib/__fixtures__/realDumps/loader.js';
import { findBcmPartialVinSlots, BCM_PARTIAL_VIN_OFFSETS, BCM_PARTIAL_VIN_LEN } from '../../lib/donorLeakScan.js';
// Import from the pure-logic helper (no React / @assets image imports) so
// this test runs in the vitest Node environment without alias issues.
import { parseBcm, applyBcmFromRfh } from '../../lib/twinBcmHelpers.js';

const SECONDARY_ADDRS = [0x0698, 0x06B8, 0x06D8, 0x06F8, 0x0718, 0x0738];
const SECONDARY_RANGE_START = 0x0698;
const SECONDARY_RANGE_END   = 0x0738 + 19; // 19 = 17 VIN bytes + 2 CRC bytes

const fixtures = loadRealDumpFixtures();

const vinWriteEntry = fixtures && Array.isArray(fixtures.extraBcms)
  ? fixtures.extraBcms.find(
      e => e && e.anonVin === '2C3CDXL90MH600142' && e.anonVinAfter === '2C3CDXHG5EH600538',
    )
  : null;

/* Helper: build a minimal rfhInfo struct accepted by applyBcmFromRfh. */
function makeRfhInfo(vin, sec16 = Array(16).fill(0xAA)) {
  return {
    vins: [{ vin }],
    sec16Slots: [{ raw: sec16 }],
  };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Part A — real alt-zone fixture (skipped when fixture is absent)            */
/* ─────────────────────────────────────────────────────────────────────────── */
(vinWriteEntry ? describe : describe.skip)(
  'Task #47 Part A — real alt-zone Charger BCM fixture (charger-bcm-vin-write)',
  () => {
    const before = vinWriteEntry?.before;
    const VIN_BEFORE = '2C3CDXL90MH600142';
    const VIN_AFTER  = '2C3CDXHG5EH600538';
    const TAIL_AFTER = VIN_AFTER.slice(9); // 'EH600538'

    it('fixture is a 64 KB BCM DFLASH image', () => {
      expect(before.length).toBe(65536);
    });

    it('secondary addresses (0x0698..0x0738) do NOT contain valid VIN characters — they are not VIN slots', () => {
      for (const off of SECONDARY_ADDRS) {
        let hasVinRun = true;
        for (let i = 0; i < 17; i++) {
          const b = before[off + i];
          if (b < 0x30 || b > 0x5A || (b > 0x39 && b < 0x41) || b === 0x49 || b === 0x4F || b === 0x51) {
            hasVinRun = false;
            break;
          }
        }
        expect(hasVinRun, `Unexpected VIN-like run at removed secondary offset 0x${off.toString(16)}`).toBe(false);
      }
    });

    it('findBcmPartialVinSlots finds >= 4 partial-VIN slots (0x0098/0x00B0/0x4098/0x40B0)', () => {
      const slots = findBcmPartialVinSlots(before);
      const offsets = slots.map(s => s.offset);
      expect(offsets).toEqual(expect.arrayContaining([0x0098, 0x00B0, 0x4098, 0x40B0]));
      expect(slots.length).toBeGreaterThanOrEqual(4);
    });

    it('all detected partial-VIN slots have CRC OK', () => {
      for (const s of findBcmPartialVinSlots(before)) {
        expect(s.crcOk, `Partial VIN at 0x${s.offset.toString(16)} has bad CRC`).toBe(true);
      }
    });

    it('parseBcm surfaces >= 4 partial VIN slots all with csOk=true on the fixture', () => {
      const info = parseBcm(before, 'bcm.before.bin');
      expect(info).not.toBeNull();
      expect(info.partialVins.length).toBeGreaterThanOrEqual(4);
      const offs = info.partialVins.map(p => p.offset);
      expect(offs).toEqual(expect.arrayContaining([0x0098, 0x00B0, 0x4098, 0x40B0]));
      for (const p of info.partialVins) {
        expect(p.csOk, `parseBcm partial VIN at 0x${p.offset.toString(16)} CS FAIL`).toBe(true);
      }
    });

    describe('applyBcmFromRfh non-mutation of removed secondary range (real fixture)', () => {
      const rfhInfo = makeRfhInfo(VIN_AFTER, Array.from(vinWriteEntry?.rfhSec16 ?? Array(16).fill(0)));
      const output = applyBcmFromRfh(before, rfhInfo);

      it('output is 65536 bytes', () => {
        expect(output.length).toBe(65536);
      });

      it('secondary range (0x0698..0x0749) is byte-for-byte identical in output vs input', () => {
        for (let off = SECONDARY_RANGE_START; off < SECONDARY_RANGE_END; off++) {
          expect(output[off], `secondary byte 0x${off.toString(16)} changed`).toBe(before[off]);
        }
      });

      it('every detected partial-VIN slot in output carries VIN_AFTER tail with correct CRC', () => {
        const detectedAfter = findBcmPartialVinSlots(output);
        expect(detectedAfter.length).toBeGreaterThanOrEqual(4);
        const tailEnc = Array.from(TAIL_AFTER).map(c => c.charCodeAt(0));
        const tailCrc = crc16(tailEnc);
        for (const s of detectedAfter) {
          expect(s.tail, `partial at 0x${s.offset.toString(16)} has wrong tail`).toBe(TAIL_AFTER);
          expect(s.calcCrc, `CRC mismatch at 0x${s.offset.toString(16)}`).toBe(tailCrc);
          expect(s.crcOk).toBe(true);
        }
      });

      it('input buffer is not mutated by applyBcmFromRfh (returns a new Uint8Array)', () => {
        const tail_before = Array.from(before.slice(0x4098, 0x4098 + 8))
          .map(b => String.fromCharCode(b)).join('');
        expect(tail_before).toBe(VIN_BEFORE.slice(9));
      });
    });
  },
);

/* ─────────────────────────────────────────────────────────────────────────── */
/* Part B — synthetic buffer (always runs; directly calls applyBcmFromRfh)   */
/* ─────────────────────────────────────────────────────────────────────────── */
describe('Task #47 Part B — synthetic buffer + direct applyBcmFromRfh call', () => {
  const VIN_OLD = '2C3CDXCT1HH600099';
  const VIN_NEW = '2C3CDXCT1HH600077';
  const TAIL_OLD = VIN_OLD.slice(9); // 'HH600099'
  const TAIL_NEW = VIN_NEW.slice(9); // 'HH600077'
  const tailOldBytes = Array.from(TAIL_OLD).map(c => c.charCodeAt(0));
  const tailNewBytes = Array.from(TAIL_NEW).map(c => c.charCodeAt(0));
  const tailOldCrc = crc16(tailOldBytes);
  const tailNewCrc = crc16(tailNewBytes);

  function buildSyntheticBcm() {
    const buf = new Uint8Array(65536).fill(0xFF);
    // Plant partial-VIN records at the four confirmed real addresses
    for (const off of [0x0098, 0x00B0, 0x4098, 0x40B0]) {
      for (let i = 0; i < 8; i++) buf[off + i] = tailOldBytes[i];
      buf[off + 8] = (tailOldCrc >> 8) & 0xFF;
      buf[off + 9] = tailOldCrc & 0xFF;
    }
    // Plant recognizable sentinel bytes in the secondary range to detect writes
    for (let off = SECONDARY_RANGE_START; off < SECONDARY_RANGE_END; off++) {
      buf[off] = 0xAB;
    }
    return buf;
  }

  it('findBcmPartialVinSlots detects all four planted partial-VIN slots', () => {
    const slots = findBcmPartialVinSlots(buildSyntheticBcm());
    const offs = slots.map(s => s.offset);
    expect(offs).toEqual(expect.arrayContaining([0x0098, 0x00B0, 0x4098, 0x40B0]));
    for (const s of slots) expect(s.crcOk).toBe(true);
  });

  it('parseBcm surfaces all four partial slots with csOk=true on the synthetic buffer', () => {
    const buf = buildSyntheticBcm();
    const info = parseBcm(buf, 'synthetic.bin');
    expect(info).not.toBeNull();
    const offs = info.partialVins.map(p => p.offset);
    expect(offs).toEqual(expect.arrayContaining([0x0098, 0x00B0, 0x4098, 0x40B0]));
    for (const p of info.partialVins) {
      expect(p.csOk, `parseBcm partial at 0x${p.offset.toString(16)} CS FAIL`).toBe(true);
    }
  });

  describe('applyBcmFromRfh direct invocation (secondary-range non-mutation + partial update)', () => {
    const before = buildSyntheticBcm();
    const rfhInfo = makeRfhInfo(VIN_NEW);
    const output = applyBcmFromRfh(before, rfhInfo);

    it('output is 65536 bytes and is a new Uint8Array (does not mutate input)', () => {
      expect(output.length).toBe(65536);
      // sentinel bytes at secondary range should still be 0xAB in the original
      expect(before[SECONDARY_RANGE_START]).toBe(0xAB);
    });

    it('secondary range (0x0698..0x0749) bytes are UNCHANGED in the output', () => {
      for (let off = SECONDARY_RANGE_START; off < SECONDARY_RANGE_END; off++) {
        expect(output[off], `secondary byte 0x${off.toString(16)} was clobbered`).toBe(0xAB);
      }
    });

    it('secondary addresses are NOT present in the auto-detected partial-slot list', () => {
      const detectedOffs = findBcmPartialVinSlots(before).map(s => s.offset);
      for (const addr of SECONDARY_ADDRS) {
        expect(detectedOffs, `secondary 0x${addr.toString(16)} must not appear in detected partials`).not.toContain(addr);
      }
    });

    it('all four partial-VIN slots are updated with VIN_NEW tail and correct CRC', () => {
      for (const off of [0x0098, 0x00B0, 0x4098, 0x40B0]) {
        const tail = Array.from(output.slice(off, off + 8)).map(b => String.fromCharCode(b)).join('');
        expect(tail, `partial tail at 0x${off.toString(16)} not updated`).toBe(TAIL_NEW);
        const stored = (output[off + 8] << 8) | output[off + 9];
        expect(stored, `CRC at 0x${off.toString(16)} incorrect`).toBe(tailNewCrc);
      }
    });

    it('BCM_PARTIAL_VIN_OFFSETS seeds ([0x4098, 0x40B0]) are covered even on a virgin buffer with no existing tails', () => {
      const virgin = new Uint8Array(65536).fill(0xFF);
      const rfhInfoVirgin = makeRfhInfo(VIN_NEW);
      const out = applyBcmFromRfh(virgin, rfhInfoVirgin);
      for (const off of BCM_PARTIAL_VIN_OFFSETS) {
        const tail = Array.from(out.slice(off, off + BCM_PARTIAL_VIN_LEN)).map(b => String.fromCharCode(b)).join('');
        expect(tail, `seed offset 0x${off.toString(16)} not written on virgin buffer`).toBe(TAIL_NEW);
        const stored = (out[off + BCM_PARTIAL_VIN_LEN] << 8) | out[off + BCM_PARTIAL_VIN_LEN + 1];
        expect(stored).toBe(tailNewCrc);
      }
    });
  });
});
