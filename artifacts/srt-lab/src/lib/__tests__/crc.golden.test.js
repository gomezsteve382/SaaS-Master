import { describe, it, expect } from 'vitest';

import {
  crc16,
  crc16ccitt,
  crc16generic,
  crc8_42,
  crc8rf,
  crc8_65,
  rfhSec16Cs,
  rfhGen2VinCs,
  rfhGen2DetectMagic,
  RFHUB_KNOWN_ALGOS,
} from '../crc.js';

// ─────────────────────────────────────────────────────────────────────────────
// Golden CRC vectors — locked-in expected outputs for each helper in crc.js.
//
// The fuzz suite (crc.fuzz.test.js) only verifies that the helpers never throw
// and stay inside their numeric range. That would silently pass even if the
// polynomial or init constant in crc.js were changed. These golden vectors pin
// down exact (input -> output) pairs so any drift in a CRC constant trips a
// loud, specific failure here.
//
// Wherever possible the expected values are cross-checked against published
// reference vectors (e.g. CRC-16/CCITT-FALSE check value 0x29B1 for the ASCII
// string "123456789"). Other vectors are derived from a known good build of
// crc.js and represent the values currently produced for real patched files.
// ─────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

// VIN-sized inputs (17 bytes, the canonical patch-target length)
const VIN_ASCII = enc.encode('1C4HJXEN5MW123456'); // representative SRT VIN
const VIN_ZERO_17 = new Uint8Array(17).fill(0x00);
const VIN_FF_17 = new Uint8Array(17).fill(0xFF);

// 16-byte slot pulled from a real RFHUB Gen2 SEC16 dump (anonymized but
// byte-exact from the field-recovered sample used to derive the SEC16 algo).
// Stored CS for this slot in the dump is 0xE2 0x00 → rfhSec16Cs == 0xE200.
const RFH_SEC16_REAL_SLOT = new Uint8Array([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
  0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10,
]);

// Standard CRC reference input — the universal "check" string.
const CHECK_STRING = enc.encode('123456789');

// Short fixed pattern for an extra non-VIN spot check.
const DEAD_BEEF = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);

describe('crc16 (CRC-16/CCITT-FALSE — poly 0x1021, init 0xFFFF)', () => {
  it('matches the published CRC-16/CCITT-FALSE check value for "123456789"', () => {
    // Reference: https://reveng.sourceforge.io/crc-catalogue/16.htm
    expect(crc16(CHECK_STRING)).toBe(0x29B1);
  });

  it('returns the init constant for an empty buffer', () => {
    // With init=0xFFFF and no data, the register is never updated.
    expect(crc16(new Uint8Array(0))).toBe(0xFFFF);
  });

  it('produces the locked-in value for an ASCII VIN', () => {
    expect(crc16(VIN_ASCII)).toBe(0x451C);
  });

  it('produces the locked-in value for an all-zero VIN-sized buffer', () => {
    expect(crc16(VIN_ZERO_17)).toBe(0xC7EC);
  });

  it('produces the locked-in value for an all-0xFF VIN-sized buffer', () => {
    expect(crc16(VIN_FF_17)).toBe(0x981C);
  });

  it('produces the locked-in value for a real ECU 16-byte slot', () => {
    expect(crc16(RFH_SEC16_REAL_SLOT)).toBe(0x296E);
  });

  it('produces the locked-in value for the DEADBEEF spot-check pattern', () => {
    expect(crc16(DEAD_BEEF)).toBe(0x4097);
  });
});

describe('crc16ccitt (production_vin_patcher.py port)', () => {
  it('matches CRC-16/CCITT-FALSE check value for "123456789"', () => {
    expect(crc16ccitt(CHECK_STRING)).toBe(0x29B1);
  });

  it('agrees with crc16 on the ASCII VIN (both implement the same algorithm)', () => {
    expect(crc16ccitt(VIN_ASCII)).toBe(0x451C);
    expect(crc16ccitt(VIN_ASCII)).toBe(crc16(VIN_ASCII));
  });
});

describe('crc8_42 (poly 0x42, init 0x2E — Chrysler/FCA 8-bit)', () => {
  it('returns the init constant for an empty buffer', () => {
    expect(crc8_42(new Uint8Array(0))).toBe(0x2E);
  });

  it('produces the locked-in value for "123456789"', () => {
    expect(crc8_42(CHECK_STRING)).toBe(0x44);
  });

  it('produces the locked-in value for an ASCII VIN', () => {
    expect(crc8_42(VIN_ASCII)).toBe(0xC6);
  });

  it('produces the locked-in value for an all-zero VIN-sized buffer', () => {
    expect(crc8_42(VIN_ZERO_17)).toBe(0x98);
  });

  it('produces the locked-in value for an all-0xFF VIN-sized buffer', () => {
    expect(crc8_42(VIN_FF_17)).toBe(0x26);
  });

  it('produces the locked-in value for a real ECU 16-byte slot', () => {
    expect(crc8_42(RFH_SEC16_REAL_SLOT)).toBe(0x74);
  });
});

describe('crc8rf (reflected poly 0xA0, init 0x54 — RFHUB Gen1)', () => {
  it('returns the init constant for an empty buffer', () => {
    expect(crc8rf(new Uint8Array(0))).toBe(0x54);
  });

  it('produces the locked-in value for "123456789"', () => {
    expect(crc8rf(CHECK_STRING)).toBe(0xC6);
  });

  it('produces the locked-in value for an ASCII VIN', () => {
    expect(crc8rf(VIN_ASCII)).toBe(0x7E);
  });

  it('produces the locked-in value for an all-zero VIN-sized buffer', () => {
    expect(crc8rf(VIN_ZERO_17)).toBe(0x01);
  });

  it('produces the locked-in value for an all-0xFF VIN-sized buffer', () => {
    expect(crc8rf(VIN_FF_17)).toBe(0x0D);
  });

  it('produces the locked-in value for a real ECU 16-byte slot', () => {
    expect(crc8rf(RFH_SEC16_REAL_SLOT)).toBe(0xAA);
  });
});

describe('crc8_65 / rfhSec16Cs (RFHUB Gen2 SEC16 — poly 0x65, init 0xBF)', () => {
  it('produces the locked-in CRC8 for the real ECU 16-byte slot', () => {
    expect(crc8_65(RFH_SEC16_REAL_SLOT)).toBe(0xE2);
  });

  it('rfhSec16Cs packs the CRC8 into the high byte with 0x00 low byte', () => {
    // byte[0] (off+16) = CRC8, byte[1] (off+17) = 0x00 → big-endian uint16.
    expect(rfhSec16Cs(RFH_SEC16_REAL_SLOT)).toBe(0xE200);
  });

  it('produces the locked-in value for an all-zero 16-byte buffer', () => {
    expect(crc8_65(new Uint8Array(16).fill(0x00))).toBe(0x04);
  });

  it('produces the locked-in value for an all-0xFF 16-byte buffer', () => {
    expect(crc8_65(new Uint8Array(16).fill(0xFF))).toBe(0xAD);
  });
});

describe('rfhGen2VinCs (XOR-all-17 ⊕ magic)', () => {
  it('returns the magic byte for an all-zero VIN (XOR of zeros = 0)', () => {
    expect(rfhGen2VinCs(VIN_ZERO_17)).toBe(0xDB);
    expect(rfhGen2VinCs(VIN_ZERO_17, 0x87)).toBe(0x87);
  });

  it('produces the locked-in value for an ASCII VIN with 0xDB magic (2020+ Redeye)', () => {
    expect(rfhGen2VinCs(VIN_ASCII, 0xDB)).toBe(0xE4);
  });

  it('produces the locked-in value for an ASCII VIN with 0x87 magic (earlier Gen2)', () => {
    expect(rfhGen2VinCs(VIN_ASCII, 0x87)).toBe(0xB8);
  });

  it('produces the locked-in value for an all-0xFF VIN with default magic', () => {
    // 17 × 0xFF XORed = 0xFF (odd count); 0xFF ⊕ 0xDB = 0x24.
    expect(rfhGen2VinCs(VIN_FF_17)).toBe(0x24);
  });
});

describe('rfhGen2DetectMagic', () => {
  it('recovers the original magic from a stored-CS / VIN pair', () => {
    const storedCs = rfhGen2VinCs(VIN_ASCII, 0xDB);
    expect(storedCs).toBe(0xE4);
    expect(rfhGen2DetectMagic(VIN_ASCII, storedCs)).toBe(0xDB);
  });

  it('recovers the alternate 0x87 magic round-trip', () => {
    const storedCs = rfhGen2VinCs(VIN_ASCII, 0x87);
    expect(rfhGen2DetectMagic(VIN_ASCII, storedCs)).toBe(0x87);
  });
});

describe('crc16generic with RFHUB_KNOWN_ALGOS (per-VIN poly/init)', () => {
  // These vectors lock in that the registered poly/init pairs still produce
  // the checksum we observed for each known good RFHUB dump.
  const EXPECTED = {
    '2C3CDXKT3FH796320': 0xD193,
    '2B3CJ4DV6AH300549': 0xF4C6,
    '2B3CJ5DT2BH590794': 0x1E73,
    '2C3CDZFK3HH506737': 0xB444,
    '2C3CDZC99HH514330': 0xB27B,
    '2C3CDXGJ1MH539855': 0x6FB0,
  };

  for (const [vin, expected] of Object.entries(EXPECTED)) {
    it(`reproduces the locked-in checksum for ${vin}`, () => {
      const algo = RFHUB_KNOWN_ALGOS[vin];
      expect(algo, `RFHUB_KNOWN_ALGOS missing entry for ${vin}`).toBeDefined();
      const bytes = enc.encode(vin);
      expect(crc16generic(bytes, algo.poly, algo.init)).toBe(expected);
    });
  }
});
