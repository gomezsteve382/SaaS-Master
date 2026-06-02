import { describe, it, expect } from 'vitest';
import {
  isXc2268Rfhub,
  parseXc2268Image,
  patchXc2268Vin,
  makeXc2268Fixture,
  xc2268ImageChecksum,
  XC2268_SUPPORTED_SIZE,
  XC2268_VIN_SLOTS,
  XC2268_SEC16_SLOTS,
  XC2268_SEC16_LEN,
} from '../xc2268Rfhub.js';

const VIN_A = '1C6RR7LT5KS123456';
const VIN_B = '1C6RR7LT5LS654321';

const hex = (a) =>
  Array.from(a)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');

// Canonical SEC16 used for slot round-trip tests. Chosen to be non-trivial
// (not all-FF / all-00) so blank-detection doesn't accidentally fire.
const SEC16_FIXTURE = new Uint8Array([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
  0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00,
]);

describe('xc2268Rfhub — detection', () => {
  it('isXc2268Rfhub returns false for empty / random buffers', () => {
    expect(isXc2268Rfhub(null)).toBe(false);
    expect(isXc2268Rfhub(new Uint8Array(0))).toBe(false);
    expect(isXc2268Rfhub(new Uint8Array(32).fill(0xAA))).toBe(false);
  });

  it('isXc2268Rfhub returns true for a fixture image', () => {
    expect(isXc2268Rfhub(makeXc2268Fixture({ vin: VIN_A }))).toBe(true);
  });
});

describe('xc2268Rfhub — parse', () => {
  it('parses a Ram 2019 fixture cleanly and reports writeSafe:true', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, variant: 0x01 });
    const r = parseXc2268Image(buf);
    expect(r.ok).toBe(true);
    expect(r.size).toBe(XC2268_SUPPORTED_SIZE);
    expect(r.variantLabel).toMatch(/Ram 2019/);
    expect(r.vin).toBe(VIN_A);
    expect(r.vinAllSlotsMatch).toBe(true);
    expect(r.vinSlots).toHaveLength(3);
    expect(r.vinSlots.every((s) => s.csOk)).toBe(true);
    expect(r.imageChecksum.ok).toBe(true);
    expect(r.writeSafe).toBe(true);
    expect(r.banners).toEqual([]);
  });

  it('flags an unknown variant tag and refuses writeSafe', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, variant: 0xFF });
    const r = parseXc2268Image(buf);
    expect(r.ok).toBe(true);
    expect(r.variantSupported).toBe(false);
    expect(r.writeSafe).toBe(false);
    expect(r.banners.some((b) => /variant tag/i.test(b.message))).toBe(true);
  });

  it('parses a Ram HD (0x03) 64 KB fixture cleanly and reports writeSafe:true', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, variant: 0x03 });
    const r = parseXc2268Image(buf);
    expect(r.ok).toBe(true);
    expect(r.variantByte).toBe(0x03);
    expect(r.variantLabel).toMatch(/Ram HD/);
    expect(r.variantSupported).toBe(true);
    expect(r.sizeSupported).toBe(true);
    expect(r.vin).toBe(VIN_A);
    expect(r.vinAllSlotsMatch).toBe(true);
    expect(r.imageChecksum.ok).toBe(true);
    expect(r.writeSafe).toBe(true);
    expect(r.banners).toEqual([]);
  });

  it('Ram HD (0x03) VIN patch round-trips correctly', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, variant: 0x03 });
    const r = patchXc2268Vin(buf, VIN_B);
    expect(r.ok).toBe(true);
    const re = parseXc2268Image(r.bytes);
    expect(re.vin).toBe(VIN_B);
    expect(re.variantLabel).toMatch(/Ram HD/);
    expect(re.writeSafe).toBe(true);
  });

  it('32 KB sub-variant surfaces a send-dump-request warn banner (not hard error) and refuses writeSafe', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, size: 0x8000 });
    const r = parseXc2268Image(buf);
    expect(r.ok).toBe(true);
    expect(r.sizeKnown).toBe(true);
    expect(r.sizeSupported).toBe(false);
    expect(r.writeSafe).toBe(false);
    const banner = r.banners.find((b) => b.kind === 'send-dump-request');
    expect(banner).toBeDefined();
    expect(banner.level).toBe('warn');
    expect(banner.message).toMatch(/32 KB/);
    expect(banner.message).toMatch(/share it/i);
  });

  it('128 KB sub-variant surfaces a send-dump-request warn banner (not hard error) and refuses writeSafe', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, size: 0x20000 });
    const r = parseXc2268Image(buf);
    expect(r.ok).toBe(true);
    expect(r.sizeKnown).toBe(true);
    expect(r.sizeSupported).toBe(false);
    expect(r.writeSafe).toBe(false);
    const banner = r.banners.find((b) => b.kind === 'send-dump-request');
    expect(banner).toBeDefined();
    expect(banner.level).toBe('warn');
    expect(banner.message).toMatch(/128 KB/);
    expect(banner.message).toMatch(/share it/i);
  });

  it('flags an unsupported size and refuses writeSafe (legacy check)', () => {
    const small = makeXc2268Fixture({ vin: VIN_A });
    // Truncate to 32 KB → known sub-variant size but not the covered 64 KB.
    const r = parseXc2268Image(small.slice(0, 0x8000));
    expect(r.ok).toBe(true);
    expect(r.sizeSupported).toBe(false);
    expect(r.writeSafe).toBe(false);
    expect(r.banners.some((b) => b.kind === 'send-dump-request')).toBe(true);
  });

  it('detects a mismatched per-slot CRC', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A });
    buf[XC2268_VIN_SLOTS[1] + 17] ^= 0xFF;  // corrupt stored CRC byte
    const r = parseXc2268Image(buf);
    expect(r.vinSlots[1].csOk).toBe(false);
    expect(r.writeSafe).toBe(false);
  });

  it('detects an image-wide checksum mismatch', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A });
    buf[buf.length - 1] ^= 0x01;
    const r = parseXc2268Image(buf);
    expect(r.imageChecksum.ok).toBe(false);
    expect(r.banners.some((b) => /image-wide CRC/i.test(b.message))).toBe(true);
  });
});

describe('xc2268Rfhub — patch VIN', () => {
  it('stamps target VIN into every slot, refreshes CRCs and image checksum', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A });
    const r = patchXc2268Vin(buf, VIN_B);
    expect(r.ok).toBe(true);
    expect(r.bytes).toBeInstanceOf(Uint8Array);
    const re = parseXc2268Image(r.bytes);
    expect(re.vin).toBe(VIN_B);
    expect(re.vinAllSlotsMatch).toBe(true);
    expect(re.writeSafe).toBe(true);
    // Three slot logs + one image-CRC log.
    expect(r.log).toHaveLength(4);
  });

  it('refuses unknown variants and rejects bad VINs', () => {
    const bad = makeXc2268Fixture({ vin: VIN_A, variant: 0xFF });
    expect(patchXc2268Vin(bad, VIN_B).ok).toBe(false);
    const good = makeXc2268Fixture({ vin: VIN_A });
    expect(patchXc2268Vin(good, 'NOT_A_VIN').ok).toBe(false);
    expect(patchXc2268Vin(good, '').ok).toBe(false);
  });

  it('round-trip is deterministic across builds (golden checksum on default fixture)', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, variant: 0x01 });
    // Pin the image-wide checksum for the canonical fixture so a future
    // change to CRC constants or layout trips loudly.
    expect(xc2268ImageChecksum(buf).toString(16).toUpperCase()).toMatchInlineSnapshot(`"24C4DB3B"`);
  });
});

// ---------------------------------------------------------------------------
// SEC16 slot tests — verifies the 0x1100/0x1120 offset contract and the
// round-trip write→parse path. The slot offsets are locked by the golden-byte
// assertions below. On-vehicle verification procedure: load a real 64 KB
// 2019+ Ram RFHUB dump in SRT Lab; the "SEC16 MIRROR SLOTS / VERDICTS" panel
// in the inspector shows offset, raw bytes, and CRC verdict for each slot.
// "CRC OK" on both rows = offsets confirmed. See the verification checklist
// in xc2268Rfhub.js for the full 5-step procedure.
// ---------------------------------------------------------------------------

describe('xc2268Rfhub — SEC16 slot offsets and layout', () => {
  it('exports the expected slot addresses and byte length', () => {
    // These values are the single source of truth; the writer in
    // securityBytes.writeXc2268Sec16 imports XC2268_SEC16_SLOTS directly, so
    // any offset change here automatically propagates.
    expect(XC2268_SEC16_SLOTS).toEqual([0x1100, 0x1120]);
    expect(XC2268_SEC16_LEN).toBe(16);
    // Stride between slots = 0x20 (32 bytes: 16 data + 2 CRC + 14 padding).
    expect(XC2268_SEC16_SLOTS[1] - XC2268_SEC16_SLOTS[0]).toBe(0x20);
    // Both slots sit well inside the 64 KB image and below the image-checksum
    // window at (len-4) = 0xFFFC.
    expect(XC2268_SEC16_SLOTS.every((off) => off + XC2268_SEC16_LEN + 2 <= 0xFFFC)).toBe(true);
  });

  it('virgin fixture has blank SEC16 slots (all-FF)', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A });
    const r = parseXc2268Image(buf);
    expect(r.sec16Slots).toHaveLength(2);
    expect(r.sec16Blank).toBe(true);
    for (const slot of r.sec16Slots) {
      expect(slot.blank).toBe(true);
      expect(slot.present).toBe(true);
      expect(slot.csOk).toBe(false); // blank → csOk is intentionally false
      // Raw bytes are all 0xFF (virgin state).
      expect(slot.raw.every((b) => b === 0xFF)).toBe(true);
    }
  });

  it('populated fixture round-trips: makeXc2268Fixture sec16 → parseXc2268Image', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, sec16: SEC16_FIXTURE });
    const r = parseXc2268Image(buf);
    expect(r.ok).toBe(true);
    expect(r.sec16Blank).toBe(false);
    expect(r.sec16Match).toBe(true);
    expect(r.sec16Slots).toHaveLength(2);
    for (const slot of r.sec16Slots) {
      expect(slot.present).toBe(true);
      expect(slot.blank).toBe(false);
      expect(slot.csOk).toBe(true);
      expect(hex(slot.raw)).toBe(hex(SEC16_FIXTURE));
    }
    // Image-wide checksum is still valid after SEC16 population.
    expect(r.imageChecksum.ok).toBe(true);
  });

  it('SEC16 bytes land at the documented raw offsets in the image buffer', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, sec16: SEC16_FIXTURE });
    // Directly inspect the raw buffer bytes at the documented offsets so that
    // any offset drift in makeXc2268Fixture or parseXc2268Image is caught
    // independently by this assertion.
    for (const slotOff of XC2268_SEC16_SLOTS) {
      for (let i = 0; i < XC2268_SEC16_LEN; i++) {
        expect(buf[slotOff + i]).toBe(SEC16_FIXTURE[i]);
      }
    }
  });

  it('SEC16 CRC is stored BE16 at slot+16/+17 (spot-check both slots)', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, sec16: SEC16_FIXTURE });
    const r = parseXc2268Image(buf);
    for (const slot of r.sec16Slots) {
      const crcHi = buf[slot.offset + XC2268_SEC16_LEN];
      const crcLo = buf[slot.offset + XC2268_SEC16_LEN + 1];
      const stored = ((crcHi << 8) | crcLo) & 0xFFFF;
      expect(stored).toBe(slot.csStored);
      expect(stored).toBe(slot.csCalc);
    }
  });

  it('golden-byte pin: SEC16 fixture image-wide checksum is deterministic', () => {
    // Pinning this checksum ensures that any future change to XC2268_SEC16_SLOTS,
    // XC2268_SEC16_LEN, the CRC primitive, or the fixture builder trips loudly.
    const buf = makeXc2268Fixture({ vin: VIN_A, variant: 0x01, sec16: SEC16_FIXTURE });
    expect(xc2268ImageChecksum(buf).toString(16).toUpperCase()).toMatchInlineSnapshot(`"366BC994"`);
  });

  it('corrupt SEC16 slot CRC is detected (csOk:false, blank stays false)', () => {
    const buf = makeXc2268Fixture({ vin: VIN_A, sec16: SEC16_FIXTURE });
    // Flip one byte of the stored CRC in slot 0 (offset + 16).
    buf[XC2268_SEC16_SLOTS[0] + XC2268_SEC16_LEN] ^= 0xFF;
    const r = parseXc2268Image(buf);
    expect(r.sec16Slots[0].csOk).toBe(false);
    expect(r.sec16Slots[0].blank).toBe(false);
    // Slot 1 is still intact.
    expect(r.sec16Slots[1].csOk).toBe(true);
  });

  it('SEC16 slots do not overlap VIN slots (layout sanity)', () => {
    // VIN slots end at 0x1040 + 17 + 2 = 0x1053; SEC16 starts at 0x1100.
    const lastVinEnd = Math.max(...XC2268_VIN_SLOTS) + 17 + 2;
    expect(Math.min(...XC2268_SEC16_SLOTS)).toBeGreaterThan(lastVinEnd);
  });
});
