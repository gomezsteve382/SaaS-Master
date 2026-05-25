import { describe, it, expect } from 'vitest';
import { scanEepromLayout, ROLES } from '../eepromLayoutScan.js';
import {
  makeBcm, makeRfhubGen2, makeRfhubGen1, makeGpec2a, make95640, VIN_DEFAULT,
} from '../__fixtures__/buildFixtures.js';
import { makeXc2268Fixture, XC2268_VIN_SLOTS } from '../xc2268Rfhub.js';
import { makeZf8hpFixture } from '../zf8hp.js';

function findRegions(regions, role) {
  return regions.filter(r => r.role === role);
}
function findByLabel(regions, substr) {
  return regions.filter(r => r.label.toLowerCase().includes(substr.toLowerCase()));
}
function hasOffset(regions, offset) {
  return regions.some(r => r.offset === offset);
}
function coversOffset(region, offset) {
  return offset >= region.offset && offset < region.offset + region.length;
}

describe('scanEepromLayout — return shape', () => {
  it('returns an object with moduleType, confidence, regions', () => {
    const result = scanEepromLayout(makeGpec2a());
    expect(result).toHaveProperty('moduleType');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('regions');
    expect(Array.isArray(result.regions)).toBe(true);
  });

  it('every region has offset/length/label/role/preview', () => {
    const { regions } = scanEepromLayout(makeGpec2a());
    for (const r of regions) {
      expect(typeof r.offset).toBe('number');
      expect(typeof r.length).toBe('number');
      expect(typeof r.label).toBe('string');
      expect(ROLES).toContain(r.role);
      expect(typeof r.preview).toBe('string');
    }
  });

  it('regions are sorted by offset ascending', () => {
    const { regions } = scanEepromLayout(makeBcm());
    for (let i = 1; i < regions.length; i++) {
      expect(regions[i].offset).toBeGreaterThanOrEqual(regions[i - 1].offset);
    }
  });
});

describe('scanEepromLayout — GPEC2A', () => {
  it('identifies GPEC2A with high confidence when VINs are present', () => {
    const { moduleType, confidence } = scanEepromLayout(makeGpec2a());
    expect(moduleType).toBe('GPEC2A');
    expect(confidence).toBe('high');
  });

  it('emits VIN regions at canonical offsets (0x0000, 0x01F0, 0x0224, 0x0CE0)', () => {
    const { regions } = scanEepromLayout(makeGpec2a({ vin: VIN_DEFAULT }));
    const vinRegions = findRegions(regions, 'vin');
    expect(vinRegions.length).toBeGreaterThanOrEqual(4);
    for (const off of [0x0000, 0x01F0, 0x0224, 0x0CE0]) {
      expect(hasOffset(vinRegions, off)).toBe(true);
    }
  });

  it('VIN preview contains VIN characters', () => {
    const { regions } = scanEepromLayout(makeGpec2a({ vin: VIN_DEFAULT }));
    const firstVin = regions.find(r => r.role === 'vin' && r.offset === 0x0000);
    expect(firstVin).toBeDefined();
    expect(firstVin.preview).toContain('2');
  });

  it('emits seed_key region at 0x0203 (secret key)', () => {
    const { regions } = scanEepromLayout(makeGpec2a());
    const sk = findRegions(regions, 'seed_key');
    expect(hasOffset(sk, 0x0203)).toBe(true);
  });

  it('emits seed_key mirror at 0x0361', () => {
    const { regions } = scanEepromLayout(makeGpec2a());
    const sk = findRegions(regions, 'seed_key');
    expect(hasOffset(sk, 0x0361)).toBe(true);
  });

  it('emits skim_pair region at 0x0011', () => {
    const { regions } = scanEepromLayout(makeGpec2a());
    const skim = findRegions(regions, 'skim_pair');
    expect(skim.length).toBeGreaterThan(0);
    expect(skim[0].offset).toBe(0x0011);
  });

  it('emits immo region covering transponder keys @ 0x0888', () => {
    const { regions } = scanEepromLayout(makeGpec2a());
    const immo = findRegions(regions, 'immo');
    expect(immo.some(r => coversOffset(r, 0x0888))).toBe(true);
  });

  it('emits flash_flag region at 0x0C8C (ZZZZ tamper)', () => {
    const { regions } = scanEepromLayout(makeGpec2a({ zzzzIntact: true }));
    const ff = findRegions(regions, 'flash_flag');
    expect(hasOffset(ff, 0x0C8C)).toBe(true);
  });

  it('emits seed_key region at 0x3C8 (PCM SEC6)', () => {
    const { regions } = scanEepromLayout(makeGpec2a());
    const sk = findRegions(regions, 'seed_key');
    expect(hasOffset(sk, 0x3C8)).toBe(true);
  });
});

describe('scanEepromLayout — RFHUB Gen2', () => {
  it('identifies RFHUB with high confidence', () => {
    const { moduleType, confidence } = scanEepromLayout(makeRfhubGen2());
    expect(moduleType).toBe('RFHUB');
    expect(confidence).toBe('high');
  });

  it('emits VIN regions at Gen2 offsets (0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1)', () => {
    const { regions } = scanEepromLayout(makeRfhubGen2());
    const vins = findRegions(regions, 'vin');
    for (const off of [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1]) {
      expect(hasOffset(vins, off)).toBe(true);
    }
  });

  it('emits seed_key region at 0x050E (vehicle secret / SEC16)', () => {
    const { regions } = scanEepromLayout(makeRfhubGen2());
    const sk = findRegions(regions, 'seed_key');
    expect(hasOffset(sk, 0x050E)).toBe(true);
  });

  it('emits SEC16 mirror at 0x0522', () => {
    const { regions } = scanEepromLayout(makeRfhubGen2());
    const sk = findRegions(regions, 'seed_key');
    expect(hasOffset(sk, 0x0522)).toBe(true);
  });

  it('emits immo region covering FOBIK occupancy markers @ 0x0880', () => {
    const { regions } = scanEepromLayout(makeRfhubGen2());
    const immo = findRegions(regions, 'immo');
    expect(immo.some(r => coversOffset(r, 0x0880))).toBe(true);
  });

  it('emits calibration_id regions for part numbers', () => {
    const { regions } = scanEepromLayout(makeRfhubGen2());
    const cal = findRegions(regions, 'calibration_id');
    expect(cal.length).toBeGreaterThan(0);
  });

  it('emits VIN @ 0x92 region', () => {
    const { regions } = scanEepromLayout(makeRfhubGen2({ withVin92: true }));
    const vins = findRegions(regions, 'vin');
    expect(hasOffset(vins, 0x92)).toBe(true);
  });
});

describe('scanEepromLayout — RFHUB Gen1 (2048 B)', () => {
  it('identifies RFHUB from 2048-byte Gen1 fixture', () => {
    const { moduleType } = scanEepromLayout(makeRfhubGen1());
    expect(moduleType).toBe('RFHUB');
  });

  it('emits VIN @ 0x92 for Gen1', () => {
    const { regions } = scanEepromLayout(makeRfhubGen1());
    const vins = findRegions(regions, 'vin');
    expect(hasOffset(vins, 0x92)).toBe(true);
  });

  it('emits SEC16 slot regions at 0x00AE and 0x00C0', () => {
    const { regions } = scanEepromLayout(makeRfhubGen1());
    const sk = findRegions(regions, 'seed_key');
    expect(hasOffset(sk, 0x00AE)).toBe(true);
    expect(hasOffset(sk, 0x00C0)).toBe(true);
  });
});

describe('scanEepromLayout — BCM', () => {
  it('identifies BCM with high confidence', () => {
    const { moduleType, confidence } = scanEepromLayout(makeBcm());
    expect(moduleType).toBe('BCM');
    expect(confidence).toBe('high');
  });

  it('emits VIN regions at canonical BCM bases (0x5320, 0x5340, 0x5360, 0x5380)', () => {
    const { regions } = scanEepromLayout(makeBcm({ vin: VIN_DEFAULT }));
    const vins = findRegions(regions, 'vin');
    for (const off of [0x5320, 0x5340, 0x5360, 0x5380]) {
      expect(hasOffset(vins, off)).toBe(true);
    }
  });

  it('BCM VIN preview contains VIN characters', () => {
    const { regions } = scanEepromLayout(makeBcm({ vin: VIN_DEFAULT }));
    const v = regions.find(r => r.role === 'vin' && r.offset === 0x5320);
    expect(v).toBeDefined();
    expect(v.preview).toContain('2');
  });

  it('emits partial VIN regions at 0x4098 and 0x40B0', () => {
    const { regions } = scanEepromLayout(makeBcm());
    const vins = findRegions(regions, 'vin');
    expect(hasOffset(vins, 0x4098)).toBe(true);
    expect(hasOffset(vins, 0x40B0)).toBe(true);
  });

  it('emits seed_key region at 0x40C9 (SEC16 flat slice)', () => {
    const { regions } = scanEepromLayout(makeBcm());
    const sk = findRegions(regions, 'seed_key');
    expect(hasOffset(sk, 0x40C9)).toBe(true);
  });

  it('emits split SEC16 record regions at 0x81A0 / 0x81C0 / 0x81E0', () => {
    const { regions } = scanEepromLayout(makeBcm());
    const sk = findRegions(regions, 'seed_key');
    for (const off of [0x81A0, 0x81C0, 0x81E0]) {
      expect(hasOffset(sk, off)).toBe(true);
    }
  });

  it('emits immo regions covering 0x40C0 and 0x2000', () => {
    const { regions } = scanEepromLayout(makeBcm());
    const immo = findRegions(regions, 'immo');
    expect(immo.some(r => coversOffset(r, 0x40C0))).toBe(true);
    expect(immo.some(r => coversOffset(r, 0x2000))).toBe(true);
  });

  it('emits immo key records at 0x81A4 / 0x81C4 / 0x81E4', () => {
    const { regions } = scanEepromLayout(makeBcm());
    const immo = findRegions(regions, 'immo');
    for (const off of [0x81A4, 0x81C4, 0x81E4]) {
      expect(hasOffset(immo, off)).toBe(true);
    }
  });

  it('emits flash_flag at 0x8028 (security lock)', () => {
    const { regions } = scanEepromLayout(makeBcm());
    const ff = findRegions(regions, 'flash_flag');
    expect(hasOffset(ff, 0x8028)).toBe(true);
  });
});

describe('scanEepromLayout — 95640', () => {
  it('identifies 95640 with medium or high confidence', () => {
    const { moduleType, confidence } = scanEepromLayout(make95640());
    expect(moduleType).toBe('95640');
    expect(['medium', 'high']).toContain(confidence);
  });

  it('emits VIN regions at canonical 95640 offsets (0x275, 0x288, 0x1B82)', () => {
    const { regions } = scanEepromLayout(make95640({ vin: VIN_DEFAULT }));
    const vins = findRegions(regions, 'vin');
    for (const off of [0x275, 0x288, 0x1B82]) {
      expect(hasOffset(vins, off)).toBe(true);
    }
  });

  it('emits seed_key at 0x40 (skey)', () => {
    const { regions } = scanEepromLayout(make95640());
    const sk = findRegions(regions, 'seed_key');
    expect(hasOffset(sk, 0x40)).toBe(true);
  });

  it('emits seed_key at 0x838 (BCM SEC16)', () => {
    const { regions } = scanEepromLayout(make95640());
    const sk = findRegions(regions, 'seed_key');
    expect(hasOffset(sk, 0x838)).toBe(true);
  });
});

describe('scanEepromLayout — XC2268_RFHUB', () => {
  const VIN_XC = '1C6RR7LT5KS123456';

  it('identifies XC2268_RFHUB with high confidence', () => {
    const { moduleType, confidence } = scanEepromLayout(makeXc2268Fixture({ vin: VIN_XC }));
    expect(moduleType).toBe('XC2268_RFHUB');
    expect(confidence).toBe('high');
  });

  it('emits boot region at 0x0000 (XC22 signature)', () => {
    const { regions } = scanEepromLayout(makeXc2268Fixture({ vin: VIN_XC }));
    const boot = findRegions(regions, 'boot');
    expect(hasOffset(boot, 0x0000)).toBe(true);
  });

  it('emits flash_flag region at variant offset 0x0020', () => {
    const { regions } = scanEepromLayout(makeXc2268Fixture({ vin: VIN_XC }));
    const ff = findRegions(regions, 'flash_flag');
    expect(hasOffset(ff, 0x0020)).toBe(true);
  });

  it('emits VIN regions at XC2268 VIN slots (0x1000, 0x1020, 0x1040)', () => {
    const { regions } = scanEepromLayout(makeXc2268Fixture({ vin: VIN_XC }));
    const vins = findRegions(regions, 'vin');
    for (const off of XC2268_VIN_SLOTS) {
      expect(hasOffset(vins, off)).toBe(true);
    }
  });

  it('XC2268 VIN preview shows VIN ASCII', () => {
    const { regions } = scanEepromLayout(makeXc2268Fixture({ vin: VIN_XC }));
    const v = regions.find(r => r.role === 'vin' && r.offset === XC2268_VIN_SLOTS[0]);
    expect(v).toBeDefined();
    expect(v.preview).toContain('1');
  });

  it('emits flash_flag at trailing 4 bytes (image checksum)', () => {
    const buf = makeXc2268Fixture({ vin: VIN_XC });
    const { regions } = scanEepromLayout(buf);
    const ff = findRegions(regions, 'flash_flag');
    expect(hasOffset(ff, buf.length - 4)).toBe(true);
  });
});

describe('scanEepromLayout — ZF_8HP_TCU', () => {
  it('identifies ZF_8HP_TCU with high confidence', () => {
    const buf = makeZf8hpFixture({ variant: '8HP90', vin: '2C3CDXL90MH582899' });
    const { moduleType, confidence } = scanEepromLayout(buf);
    expect(moduleType).toBe('ZF_8HP_TCU');
    expect(confidence).toBe('high');
  });

  it('emits boot region at 0x0000 (ZF8HP signature)', () => {
    const buf = makeZf8hpFixture({ variant: '8HP90' });
    const { regions } = scanEepromLayout(buf);
    const boot = findRegions(regions, 'boot');
    expect(hasOffset(boot, 0x0000)).toBe(true);
  });

  it('emits VIN regions at 8HP90 VIN slot offsets (0x020000, 0x040000)', () => {
    const buf = makeZf8hpFixture({ variant: '8HP90', vin: '2C3CDXL90MH582899' });
    const { regions } = scanEepromLayout(buf);
    const vins = findRegions(regions, 'vin');
    for (const off of [0x020000, 0x040000]) {
      expect(hasOffset(vins, off)).toBe(true);
    }
  });

  it('emits flash_flag regions for per-block CRCs', () => {
    const buf = makeZf8hpFixture({ variant: '8HP90' });
    const { regions } = scanEepromLayout(buf);
    const ff = findRegions(regions, 'flash_flag');
    expect(ff.length).toBeGreaterThan(0);
    expect(ff.some(r => r.label.includes('CRC32'))).toBe(true);
  });
});

describe('scanEepromLayout — UNKNOWN fallback', () => {
  it('returns moduleType UNKNOWN for a random-ish buffer', () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + 13) & 0xff;
    const { moduleType } = scanEepromLayout(buf);
    expect(['UNKNOWN', 'RFHUB', 'GPEC2A', 'TCM', 'TIPM']).toContain(moduleType);
  });

  it('returns low confidence for UNKNOWN type', () => {
    const buf = new Uint8Array(512).fill(0xAB);
    const { confidence } = scanEepromLayout(buf);
    expect(confidence).toBe('low');
  });

  it('flags 0xFF-filled regions as unknown erased', () => {
    const buf = new Uint8Array(512).fill(0xFF);
    const { regions } = scanEepromLayout(buf);
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.some(r => r.label.includes('0xFF'))).toBe(true);
  });

  it('flags ASCII clusters in UNKNOWN buffers', () => {
    const buf = new Uint8Array(256);
    const text = 'CALIBRATION DATA 2024-01-15 ECU_ID=12345678 SW_VER=1.23.456 ';
    for (let i = 0; i < buf.length; i++) buf[i] = text.charCodeAt(i % text.length) & 0xff;
    const { regions } = scanEepromLayout(buf);
    expect(regions.some(r => r.label.toLowerCase().includes('ascii'))).toBe(true);
  });
});

describe('scanEepromLayout — role set is exhaustive', () => {
  it('all emitted roles are in ROLES constant', () => {
    const fixtures = [
      makeBcm(), makeRfhubGen2(), makeGpec2a(), make95640(),
      makeXc2268Fixture(), makeZf8hpFixture({ variant: '8HP90' }),
    ];
    for (const buf of fixtures) {
      const { regions } = scanEepromLayout(buf);
      for (const r of regions) {
        expect(ROLES).toContain(r.role);
      }
    }
  });
});
