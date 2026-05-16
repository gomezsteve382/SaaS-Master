import { describe, it, expect } from 'vitest';
import {
  isZf8hpImage,
  parseZf8hpImage,
  patchZf8hpVin,
  makeZf8hpFixture,
  zf8hpBlockChecksums,
  crc32zlib,
  ZF8HP_VARIANTS,
  ZF8HP_VARIANT_OFFSET,
} from '../zf8hp.js';

const VIN_A = '2C3CDXL90MH582899';
const VIN_B = '2C3CDXL90MH123456';

describe('zf8hp — CRC-32 primitive', () => {
  it('crc32zlib("123456789") === 0xCBF43926 (RFC reference vector)', () => {
    const bytes = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
    expect(crc32zlib(bytes) >>> 0).toBe(0xCBF43926);
  });
  it('crc32zlib("") === 0x00000000', () => {
    expect(crc32zlib(new Uint8Array())).toBe(0);
  });
});

describe('zf8hp — variants', () => {
  it('exposes the 3 covered variants', () => {
    expect(ZF8HP_VARIANTS.map((v) => v.key)).toEqual(['845RE', '8HP70', '8HP90']);
  });

  it.each(['845RE', '8HP70', '8HP90'])(
    'fixture for %s parses cleanly and is writeSafe',
    (variant) => {
      const buf = makeZf8hpFixture({ variant, vin: VIN_A });
      expect(isZf8hpImage(buf)).toBe(true);
      const r = parseZf8hpImage(buf);
      expect(r.ok).toBe(true);
      expect(r.variant).toBe(variant);
      expect(r.vin).toBe(VIN_A);
      expect(r.vinAllSlotsMatch).toBe(true);
      expect(r.blocks.length).toBeGreaterThan(0);
      expect(r.blocksOk).toBe(true);
      expect(r.writeSafe).toBe(true);
    },
  );
});

describe('zf8hp — refusal banners', () => {
  it('refuses an unknown variant tag', () => {
    const buf = makeZf8hpFixture({ variant: '8HP90', vin: VIN_A });
    buf[ZF8HP_VARIANT_OFFSET] = 0xAB;
    const r = parseZf8hpImage(buf);
    expect(r.ok).toBe(true);
    expect(r.variantSupported).toBe(false);
    expect(r.writeSafe).toBe(false);
    expect(r.banners.some((b) => /variant tag/i.test(b.message))).toBe(true);
  });

  it('refuses an off-size buffer for a covered variant', () => {
    const buf = makeZf8hpFixture({ variant: '845RE', vin: VIN_A });
    const truncated = buf.slice(0, buf.length - 0x10000); // drop one block
    const r = parseZf8hpImage(truncated);
    expect(r.sizeSupported).toBe(false);
    expect(r.writeSafe).toBe(false);
  });

  it('flags per-block CRC32 mismatches', () => {
    const buf = makeZf8hpFixture({ variant: '845RE', vin: VIN_A });
    buf[0x100] ^= 0x01; // dirty the first block
    const r = parseZf8hpImage(buf);
    expect(r.blocksOk).toBe(false);
    expect(r.banners.some((b) => /per-block CRC/i.test(b.message))).toBe(true);
  });
});

describe('zf8hp — patch VIN', () => {
  it('stamps target VIN into every slot AND refreshes every block CRC32', () => {
    const buf = makeZf8hpFixture({ variant: '8HP90', vin: VIN_A });
    const r = patchZf8hpVin(buf, VIN_B);
    expect(r.ok).toBe(true);
    const re = parseZf8hpImage(r.bytes);
    expect(re.vin).toBe(VIN_B);
    expect(re.vinAllSlotsMatch).toBe(true);
    expect(re.blocksOk).toBe(true);
    expect(re.writeSafe).toBe(true);
    expect(r.blocksTouched).toBeGreaterThanOrEqual(1);
    expect(r.log.some((l) => /VIN @/.test(l))).toBe(true);
    expect(r.log.some((l) => /block #/.test(l) || /CRCs unchanged/.test(l))).toBe(true);
  });

  it('refuses bad VINs and unsupported variants', () => {
    const buf = makeZf8hpFixture({ variant: '8HP90', vin: VIN_A });
    expect(patchZf8hpVin(buf, 'NOPE').ok).toBe(false);
    buf[ZF8HP_VARIANT_OFFSET] = 0xAB;
    expect(patchZf8hpVin(buf, VIN_B).ok).toBe(false);
  });

  it('zf8hpBlockChecksums returns one entry per 64 KB block', () => {
    const buf = makeZf8hpFixture({ variant: '8HP90', vin: VIN_A });
    const blocks = zf8hpBlockChecksums(buf);
    expect(blocks).toHaveLength(buf.length / 0x10000);
    expect(blocks.every((b) => b.ok)).toBe(true);
  });
});
