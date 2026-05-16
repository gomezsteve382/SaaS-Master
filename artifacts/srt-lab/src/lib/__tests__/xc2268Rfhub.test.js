import { describe, it, expect } from 'vitest';
import {
  isXc2268Rfhub,
  parseXc2268Image,
  patchXc2268Vin,
  makeXc2268Fixture,
  xc2268ImageChecksum,
  XC2268_SUPPORTED_SIZE,
  XC2268_VIN_SLOTS,
} from '../xc2268Rfhub.js';

const VIN_A = '1C6RR7LT5KS123456';
const VIN_B = '1C6RR7LT5LS654321';

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

  it('flags an unsupported size and refuses writeSafe', () => {
    const small = makeXc2268Fixture({ vin: VIN_A });
    // Truncate to 32 KB → known sub-variant size but not the covered 64 KB.
    const r = parseXc2268Image(small.slice(0, 0x8000));
    expect(r.ok).toBe(true);
    expect(r.sizeSupported).toBe(false);
    expect(r.writeSafe).toBe(false);
    expect(r.banners.some((b) => /size/i.test(b.message))).toBe(true);
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
