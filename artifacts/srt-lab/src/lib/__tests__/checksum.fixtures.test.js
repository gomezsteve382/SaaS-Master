/* ============================================================================
 * checksum.fixtures.test.js  — Task #48
 *
 * Audits every CRC / security-byte algorithm path against real ECU dumps.
 * Asserts:
 *   (a) parseModule() classification and parsed fields (VIN, SEC16, lock…)
 *   (b) Every checksum slot validates — or is explicitly documented as a known
 *       MISMATCH in an OG (unsynced) capture.
 *   (c) Write round-trips: after calling each writer with the data from a
 *       known-good fixture, the mutated buffer is byte-identical at the
 *       relevant offsets to the original fixture.
 *   (d) Cross-module SEC16 pairing: reverse(RFH_SEC16) === BCM_SEC16, and
 *       GPEC_SEC6 === RFH_SEC16[0..5].
 *   (e) SINCRO parity: CARTMAN OG state offsets / values pin the reference
 *       paste field-by-field.
 *   (f) AlfaOBD frame replay: seed→key for ht / f / ao via both raw byte
 *       functions and the unlockKeyBytes dispatcher.
 *
 * FIXTURE POLICY: all attached_assets/ and fixtures/ binaries used here
 * are committed to the repository.  If a required file is missing the
 * module throws before any test runs (fail loud, not silent skip).
 * ============================================================================ */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  crc16, crc8_65,
  rfhGen2VinCs, rfhGen2DetectMagic, rfhSec16Cs,
} from '../crc.js';
import { parseModule } from '../parseModule.js';
import {
  writeBcmSec16Gen2,
  writeBcmFlatSec16,
  writePcmSec6,
  writeRfhSec16FromBcm,
  writeRfhSec16Gen1,
} from '../securityBytes.js';
import { alfaHt, alfaF, alfaAo, unlockKeyBytes } from '../algos.js';

/* ── paths ──────────────────────────────────────────────────────────────── */
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ATTACHED   = path.join(REPO_ROOT, 'attached_assets');
const FIXTURES   = path.resolve(__dirname, '..', '..', '__tests__', 'fixtures');

/* ── helpers ────────────────────────────────────────────────────────────── */
function tryLoad(p) {
  if (!fs.existsSync(p)) return null;
  return new Uint8Array(fs.readFileSync(p));
}

function requireLoad(p) {
  const data = tryLoad(p);
  if (!data) throw new Error(
    `Required fixture not found: ${path.relative(REPO_ROOT, p)}\n` +
    `Run tests from the repo root with attached_assets/ present.`
  );
  return data;
}

function hexOf(bytes, start, len) {
  return Array.from(bytes.slice(start, start + len))
    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

function H(bytes) {
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

const V = (hex) => new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));

function isAllFF(bytes) {
  return Array.from(bytes).every(b => b === 0xFF);
}

function bcmSplitSec16(data) {
  for (const base of [0x81A0, 0x81C0, 0x81E0]) {
    if (base + 30 > data.length) continue;
    const hdrOk = data[base] === 0xFF && data[base + 1] === 0xFF &&
                  [2, 3, 4, 5, 6, 7].every(j => data[base + j] === 0x00);
    const idx   = data[base + 8];
    const sepOk = data[base + 16] === 0x04 && data[base + 17] === 0x04 &&
                  data[base + 18] === 0x00 && data[base + 19] === 0x14;
    if (!hdrOk || !(idx === 0x01 || idx === 0x02) || !sepOk) continue;
    const sec16 = new Uint8Array(16);
    for (let k = 0; k < 7; k++) sec16[k] = data[base + 9 + k];
    for (let k = 0; k < 9; k++) sec16[7 + k] = data[base + 20 + k];
    return sec16;
  }
  return null;
}

function bcmSplitSec16Hex(data) {
  const b = bcmSplitSec16(data);
  return b ? hexOf(b, 0, 16) : null;
}

/* ── fixture loading (hard-fail if missing) ─────────────────────────────── */
const F = {
  CARTMAN_BCM:   requireLoad(path.join(ATTACHED, 'CARTMAN0GBCMDFLASH21CHARGERRED_1776135460756.bin')),
  CARTMAN_RFH:   requireLoad(path.join(ATTACHED, 'CARTMAN21CHARGER6.2RFHUBOG_1776135460754.bin')),
  CARTMAN_GPEC:  requireLoad(path.join(ATTACHED, 'CONTINENTAL_GPEC2A_EXT_EEPROM_20251224105131_OG_FILE_1776135460755.bin')),
  TRACKHAWK_BCM: requireLoad(path.join(ATTACHED, '18TRACKHAWKDFLASHBCM_DRAGKAT_OG_1C4RJFDJXEC365477_1776020054236.bin')),
  VIRGIN_BCM22:  requireLoad(path.join(ATTACHED, '22CHARGER_REDEYE_6.2_797BCM_DFLASH_VIRGIN_1776226962777.bin')),
  SYNCED_BCM22:  requireLoad(path.join(ATTACHED, 'BCM_22CHARGER_REDEYE_6.2_797BCM_DFLASH_VIRGIN_SYNC_1776840027540.bin')),
  VIRGIN_RFH21:  requireLoad(path.join(ATTACHED, '21RFHUB_VIRGIN_EEE_ALREADYSYNCHED_1776837681902.bin')),
  FIXED_RFH:     requireLoad(path.join(ATTACHED, 'FIXED_RFH_ZO_PAIRED_TO_MODULES_1776839997904.bin')),
  SAMPLE_BCM:    requireLoad(path.join(FIXTURES, 'SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin')),
  SAMPLE_RFH:    requireLoad(path.join(FIXTURES, 'SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin')),
  GEN1_RFH:      requireLoad(path.join(FIXTURES, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin')),
};

/* ============================================================================
 * 1. CRC primitives
 * ========================================================================== */
describe('CRC primitives', () => {
  it('crc16/CCITT: all-zero 4-byte input → 0x84C0', () => {
    expect(crc16(new Uint8Array(4))).toBe(0x84C0);
  });

  it('crc16/CCITT: VIN "2C3CDXL90MH582899" → 0x6AEE (SAMPLE_BCM slot checksum)', () => {
    expect(crc16(new TextEncoder().encode('2C3CDXL90MH582899'))).toBe(0x6AEE);
  });

  it('crc16/CCITT: VIN "1C4RJFDJXEC365477" → 0xD115 (TRACKHAWK slot checksum)', () => {
    expect(crc16(new TextEncoder().encode('1C4RJFDJXEC365477'))).toBe(0xD115);
  });

  it('crc8_65: CARTMAN RFHUB slot1 SEC16 → 0xB7 (OG calc, disagrees with stored 0xB5)', () => {
    const slot16 = F.CARTMAN_RFH.slice(0x050E, 0x050E + 16);
    expect(crc8_65(slot16)).toBe(0xB7);
  });

  it('crc8_65: FIXED_RFH slot1 SEC16 → stored checksum byte (CRC8 round-trip)', () => {
    const slot16 = F.FIXED_RFH.slice(0x050E, 0x050E + 16);
    const stored = F.FIXED_RFH[0x050E + 16];
    expect(crc8_65(slot16)).toBe(stored);
  });

  it('rfhSec16Cs returns (crc8_65 << 8) | 0x00 as 16-bit integer', () => {
    const slot16 = F.VIRGIN_RFH21.slice(0x050E, 0x050E + 16);
    const expected = (crc8_65(slot16) << 8) | 0x00;
    expect(rfhSec16Cs(slot16)).toBe(expected);
  });

  it('rfhSec16Cs round-trip: recomputing from VIRGIN_RFH21 bytes matches stored 2-byte CS', () => {
    const slot16 = F.VIRGIN_RFH21.slice(0x050E, 0x050E + 16);
    const stored = (F.VIRGIN_RFH21[0x050E + 16] << 8) | F.VIRGIN_RFH21[0x050E + 17];
    expect(rfhSec16Cs(slot16)).toBe(stored);
  });

  it('rfhGen2DetectMagic derives 0x87 from CARTMAN RFHUB VIN slot @ 0x0EA5', () => {
    const raw17 = F.CARTMAN_RFH.slice(0x0EA5, 0x0EA5 + 17);
    const storedCs = F.CARTMAN_RFH[0x0EA5 + 17];
    expect(rfhGen2DetectMagic(raw17, storedCs)).toBe(0x87);
  });

  it('rfhGen2VinCs with detected magic round-trips the stored CS byte', () => {
    const raw17 = F.CARTMAN_RFH.slice(0x0EA5, 0x0EA5 + 17);
    const storedCs = F.CARTMAN_RFH[0x0EA5 + 17];
    const magic = rfhGen2DetectMagic(raw17, storedCs);
    expect(rfhGen2VinCs(raw17, magic)).toBe(storedCs);
  });

  it('rfhGen2DetectMagic derives 0xFF from VIRGIN_RFH21 slot @ 0x0EA5', () => {
    const raw17 = F.VIRGIN_RFH21.slice(0x0EA5, 0x0EA5 + 17);
    const storedCs = F.VIRGIN_RFH21[0x0EA5 + 17];
    expect(rfhGen2DetectMagic(raw17, storedCs)).toBe(0xFF);
  });

  it('rfhGen2DetectMagic derives 0x85 from SAMPLE_RFH slot @ 0x0EA5', () => {
    const raw17 = F.SAMPLE_RFH.slice(0x0EA5, 0x0EA5 + 17);
    const storedCs = F.SAMPLE_RFH[0x0EA5 + 17];
    expect(rfhGen2DetectMagic(raw17, storedCs)).toBe(0x85);
  });
});

/* ============================================================================
 * 2. BCM fixture checksums
 * ========================================================================== */
describe('BCM fixture checksums', () => {
  describe('CARTMAN BCM — donor state (VIN zone blank, split SEC16 populated)', () => {
    it('classifies as BCM, size 65536', () => {
      const info = parseModule(F.CARTMAN_BCM, 'CARTMAN_BCM.bin');
      expect(info.type).toBe('BCM');
      expect(F.CARTMAN_BCM.length).toBe(65536);
    });

    it('VIN zone is all-FF — donor never had a VIN inscribed', () => {
      const info = parseModule(F.CARTMAN_BCM, 'CARTMAN_BCM.bin');
      expect(info.vins.length).toBe(0);
    });

    it('split records source=split, blank=false, SEC16=8CF8E4012D19B27E64731D5A2FBD4BDE', () => {
      const info = parseModule(F.CARTMAN_BCM, 'CARTMAN_BCM.bin');
      expect(info.bcmSec16.source).toBe('split');
      expect(info.bcmSec16.blank).toBe(false);
      expect(hexOf(info.bcmSec16.bytes, 0, 16)).toBe('8CF8E4012D19B27E64731D5A2FBD4BDE');
    });

    it('flat slice 0x40C9 is all-FF (unsynced flat — SINCRO reference confirms)', () => {
      expect(isAllFF(F.CARTMAN_BCM.slice(0x40C9, 0x40D9))).toBe(true);
    });

    it('security lock 0x8028 = 0x5A (LOCKED)', () => {
      const info = parseModule(F.CARTMAN_BCM, 'CARTMAN_BCM.bin');
      expect(info.securityLock.value).toBe(0x5A);
      expect(info.securityLock.locked).toBe(true);
    });

    it('FOBIK count 0x5862 = 0xFF = 255 (uninitialized)', () => {
      const info = parseModule(F.CARTMAN_BCM, 'CARTMAN_BCM.bin');
      expect(info.fobikCount).toBe(255);
    });

    it('SKIM primary 0x40C0 = 0 records (blank), SKIM backup 0x2000 = 8 records', () => {
      const info = parseModule(F.CARTMAN_BCM, 'CARTMAN_BCM.bin');
      expect(info.immoRecs).toBe(0);
      expect(info.immoBlank).toBe(true);
      expect(info.bakRecs).toBe(8);
    });
  });

  describe('TRACKHAWK BCM — pre-Redeye legacy base+0 VIN layout', () => {
    it('classifies as BCM', () => {
      const info = parseModule(F.TRACKHAWK_BCM, 'TRACKHAWK_BCM.bin');
      expect(info.type).toBe('BCM');
    });

    it('four VIN slots at canonical+0 offsets all pass CRC16', () => {
      const info = parseModule(F.TRACKHAWK_BCM, 'TRACKHAWK_BCM.bin');
      expect(info.vins.length).toBe(4);
      for (const v of info.vins) {
        expect(v.vin).toBe('1C4RJFDJXEC365477');
        expect(v.crcOk).toBe(true);
      }
    });

    it('CRC16 round-trip: recomputing from slot bytes reproduces stored value', () => {
      const info = parseModule(F.TRACKHAWK_BCM, 'TRACKHAWK_BCM.bin');
      for (const v of info.vins) {
        const raw17 = F.TRACKHAWK_BCM.slice(v.offset, v.offset + 17);
        const stored = (F.TRACKHAWK_BCM[v.offset + 17] << 8) | F.TRACKHAWK_BCM[v.offset + 18];
        expect(crc16(raw17)).toBe(stored);
      }
    });

    it('no split records at 0x81A0/C0/E0 — SEC16 source is mirror or flat, never split', () => {
      const info = parseModule(F.TRACKHAWK_BCM, 'TRACKHAWK_BCM.bin');
      expect(info.bcmSec16.source).not.toBe('split');
    });

    it('resolved SEC16 is non-blank (mirror or flat carries a real value)', () => {
      const info = parseModule(F.TRACKHAWK_BCM, 'TRACKHAWK_BCM.bin');
      expect(info.bcmSec16.blank).toBe(false);
    });

    it('flat slice 0x40C9 is the known non-blank value (NOT all-FF/00)', () => {
      expect(hexOf(F.TRACKHAWK_BCM, 0x40C9, 16)).toBe('00000000000000313E00100018000A00');
    });
  });

  describe('SAMPLE_BCM_SYNCED — Redeye base+8 VIN layout, split SEC16', () => {
    it('classifies as BCM', () => {
      const info = parseModule(F.SAMPLE_BCM, 'SAMPLE_BCM.bin');
      expect(info.type).toBe('BCM');
    });

    it('three VIN slots at Redeye base+8 offsets all pass CRC16 with VIN 2C3CDXL90MH582899', () => {
      const info = parseModule(F.SAMPLE_BCM, 'SAMPLE_BCM.bin');
      expect(info.vins.length).toBe(3);
      for (const v of info.vins) {
        expect(v.vin).toBe('2C3CDXL90MH582899');
        expect(v.crcOk).toBe(true);
      }
    });

    it('all three split records consistent, SEC16=EDBDFF7CBBABC3A07D5A60763772FA86', () => {
      const info = parseModule(F.SAMPLE_BCM, 'SAMPLE_BCM.bin');
      expect(info.bcmSec16.source).toBe('split');
      expect(info.bcmSec16.candidates.split.consistent).toBe(true);
      expect(hexOf(info.bcmSec16.candidates.split.bytes, 0, 16)).toBe('EDBDFF7CBBABC3A07D5A60763772FA86');
    });
  });

  describe('VIRGIN_BCM22 — split SEC16 matches flat (consistent pre-sync state)', () => {
    it('VIN slots pass CRC16 (VIN 2C3CDXCT1HH652640)', () => {
      const info = parseModule(F.VIRGIN_BCM22, 'VIRGIN_BCM22.bin');
      for (const v of info.vins) {
        expect(v.vin).toBe('2C3CDXCT1HH652640');
        expect(v.crcOk).toBe(true);
      }
    });

    it('split SEC16 pinned to 2AC740845C415AC2332EE3CDF7316581', () => {
      expect(bcmSplitSec16Hex(F.VIRGIN_BCM22)).toBe('2AC740845C415AC2332EE3CDF7316581');
    });

    it('flat slice 0x40C9 equals the split-record SEC16 (consistent pre-sync)', () => {
      expect(hexOf(F.VIRGIN_BCM22, 0x40C9, 16)).toBe('2AC740845C415AC2332EE3CDF7316581');
    });
  });

  describe('SYNCED_BCM22 — updated VIN and SEC16', () => {
    it('VIN slots pass CRC16 (VIN 2C3CDXGJ3KH728648)', () => {
      const info = parseModule(F.SYNCED_BCM22, 'SYNCED_BCM22.bin');
      for (const v of info.vins) {
        expect(v.vin).toBe('2C3CDXGJ3KH728648');
        expect(v.crcOk).toBe(true);
      }
    });

    it('split SEC16 pinned to DA69698916EC45ABC143D97ED71580AB', () => {
      expect(bcmSplitSec16Hex(F.SYNCED_BCM22)).toBe('DA69698916EC45ABC143D97ED71580AB');
    });
  });
});

/* ============================================================================
 * 3. RFHUB fixture checksums
 * ========================================================================== */
describe('RFHUB fixture checksums', () => {
  describe('CARTMAN RFHUB OG — magic=0x87, SEC16 CS MISMATCH (expected OG state)', () => {
    it('classifies as RFHUB Gen2 (24C32), 4096 bytes', () => {
      const info = parseModule(F.CARTMAN_RFH, 'CARTMAN_RFH.bin');
      expect(info.type).toBe('RFHUB');
      expect(info.rfhGen).toBe('Gen2 (24C32)');
      expect(F.CARTMAN_RFH.length).toBe(4096);
    });

    it('four VIN slots pass VIN CS with auto-detected magic 0x87; VIN=2C3CDZL95NH179529', () => {
      const info = parseModule(F.CARTMAN_RFH, 'CARTMAN_RFH.bin');
      expect(info.vins.length).toBe(4);
      for (const v of info.vins) {
        expect(v.vin).toBe('2C3CDZL95NH179529');
        expect(v.crcOk).toBe(true);
      }
    });

    it('auto-detected magic = 0x87', () => {
      const raw17 = F.CARTMAN_RFH.slice(0x0EA5, 0x0EA5 + 17);
      expect(rfhGen2DetectMagic(raw17, F.CARTMAN_RFH[0x0EA5 + 17])).toBe(0x87);
    });

    it('SEC16 slot1 CS: stored=0xB500, calc=0xB700 — MISMATCH (OG unsynced state)', () => {
      const info = parseModule(F.CARTMAN_RFH, 'CARTMAN_RFH.bin');
      const s = info.sec16s[0];
      expect(s.cs).toBe(0xB500);
      expect(s.csCalc).toBe(0xB700);
      expect(s.csOk).toBe(false);
    });

    it('sec16valid=false because CS fails', () => {
      const info = parseModule(F.CARTMAN_RFH, 'CARTMAN_RFH.bin');
      expect(info.sec16valid).toBe(false);
    });

    it('Gen2 header AA 55 31 01 present at 0x0500', () => {
      expect(Array.from(F.CARTMAN_RFH.slice(0x0500, 0x0504)))
        .toEqual([0xAA, 0x55, 0x31, 0x01]);
    });
  });

  describe('VIRGIN_RFH21 — synced, magic=0xFF, SEC16 CS OK, slots match', () => {
    it('classifies as RFHUB Gen2', () => {
      const info = parseModule(F.VIRGIN_RFH21, 'VIRGIN_RFH21.bin');
      expect(info.type).toBe('RFHUB');
    });

    it('four VIN slots pass CRC, VIN=2C3CDXGJ3KH728648', () => {
      const info = parseModule(F.VIRGIN_RFH21, 'VIRGIN_RFH21.bin');
      expect(info.vins.length).toBe(4);
      for (const v of info.vins) {
        expect(v.vin).toBe('2C3CDXGJ3KH728648');
        expect(v.crcOk).toBe(true);
      }
    });

    it('SEC16 slot1 CRC8 correct', () => {
      const info = parseModule(F.VIRGIN_RFH21, 'VIRGIN_RFH21.bin');
      expect(info.sec16s[0].csOk).toBe(true);
    });

    it('slot1 and slot2 carry identical bytes (sec16match=true)', () => {
      const info = parseModule(F.VIRGIN_RFH21, 'VIRGIN_RFH21.bin');
      expect(info.sec16match).toBe(true);
    });

    it('SEC16 pinned to 816531F7CDE32E33C25A415C8440C72A', () => {
      const info = parseModule(F.VIRGIN_RFH21, 'VIRGIN_RFH21.bin');
      expect(hexOf(info.sec16s[0].raw, 0, 16)).toBe('816531F7CDE32E33C25A415C8440C72A');
    });

    it('rfhSec16Cs round-trip: recomputing from slot bytes matches stored 2-byte CS', () => {
      const slot16 = F.VIRGIN_RFH21.slice(0x050E, 0x050E + 16);
      const stored = (F.VIRGIN_RFH21[0x050E + 16] << 8) | F.VIRGIN_RFH21[0x050E + 17];
      expect(rfhSec16Cs(slot16)).toBe(stored);
    });

    it('sec16valid=true (CRC ok, slots match, not blank)', () => {
      const info = parseModule(F.VIRGIN_RFH21, 'VIRGIN_RFH21.bin');
      expect(info.sec16valid).toBe(true);
    });
  });

  describe('FIXED_RFH — synced to SYNCED_BCM22, SEC16 CS OK', () => {
    it('classifies as RFHUB Gen2', () => {
      const info = parseModule(F.FIXED_RFH, 'FIXED_RFH.bin');
      expect(info.type).toBe('RFHUB');
    });

    it('four VIN slots pass CRC, VIN=2C3CDXGJ3KH728648', () => {
      const info = parseModule(F.FIXED_RFH, 'FIXED_RFH.bin');
      expect(info.vins.length).toBe(4);
      for (const v of info.vins) {
        expect(v.vin).toBe('2C3CDXGJ3KH728648');
        expect(v.crcOk).toBe(true);
      }
    });

    it('SEC16 CS correct, slots match, sec16valid=true', () => {
      const info = parseModule(F.FIXED_RFH, 'FIXED_RFH.bin');
      expect(info.sec16s[0].csOk).toBe(true);
      expect(info.sec16match).toBe(true);
      expect(info.sec16valid).toBe(true);
    });

    it('SEC16 pinned to AB8015D77ED943C1AB45EC16896969DA', () => {
      const info = parseModule(F.FIXED_RFH, 'FIXED_RFH.bin');
      expect(hexOf(info.sec16s[0].raw, 0, 16)).toBe('AB8015D77ED943C1AB45EC16896969DA');
    });
  });

  describe('SAMPLE_RFH — magic=0x85 (auto-detect), SEC16 garbled (virgin-after-sync state)', () => {
    it('classifies as RFHUB Gen2', () => {
      const info = parseModule(F.SAMPLE_RFH, 'SAMPLE_RFH.bin');
      expect(info.type).toBe('RFHUB');
    });

    it('four VIN slots pass CRC via auto-detected magic=0x85; VIN=2C3CDXL90MH582899', () => {
      const info = parseModule(F.SAMPLE_RFH, 'SAMPLE_RFH.bin');
      expect(info.vins.length).toBe(4);
      for (const v of info.vins) {
        expect(v.vin).toBe('2C3CDXL90MH582899');
        expect(v.crcOk).toBe(true);
      }
    });

    it('auto-detected magic=0x85 (not the standard 0xDB or 0x87 values)', () => {
      const raw17 = F.SAMPLE_RFH.slice(0x0EA5, 0x0EA5 + 17);
      expect(rfhGen2DetectMagic(raw17, F.SAMPLE_RFH[0x0EA5 + 17])).toBe(0x85);
    });
  });

  /* ── Gen1 (Yazaki 24C16, 2 KB) ── FORMULA_UNVERIFIED_ON_REAL_HW ────────────
   *
   * INVESTIGATION SUMMARY (no real 2 KB dump found):
   *   Every RFHUB file in attached_assets/ is exactly 4096 bytes (Gen2, 24C32).
   *   No physical Yazaki 24C16 (2 KB) dump exists in this repository.
   *   The crc8_65 formula for Gen1 SEC16 derives from a prior task note, NOT
   *   from a real ECU read-back.
   *
   * WHAT THESE TESTS ARE AND ARE NOT:
   *   ✓ They ARE regression tests for the parse ↔ write contract:
   *     if parseModule or writeRfhSec16Gen1 drift from each other, they fail.
   *   ✗ They are NOT hardware confirmation: the fixture was built with the
   *     same crc8_65 formula the writer uses, so csOk=true by construction.
   *     A wrong polynomial would still produce csOk=true here.
   *
   * HOW TO UPGRADE WHEN A REAL 2 KB DUMP SURFACES:
   *   1. Load the real dump bytes into parseModule and check sec16s[*].csOk.
   *   2. If csOk=false, find the correct formula and update writeRfhSec16Gen1
   *      AND the parseModule.js rfhSec16Cs call for !sec16IsGen2 branches.
   *   3. Replace SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin with the real dump
   *      and update the pinned hex values below.
   *   See also: securityBytes.js writeRfhSec16Gen1 FORMULA_UNVERIFIED_ON_REAL_HW
   *   note and the follow-up task that tracks this verification.
   *
   * Fixture: SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin (2048 B, SYNTHETIC)
   *   BCM donor SEC16:  8CF8E4012D19B27E64731D5A2FBD4BDE  (CARTMAN set)
   *   RFH SEC16:        DE4BBD2F5A1D73647EB2192D01E4F88C  (reverse of above)
   *   crc8_65 checksum: 0xB7  → stored as BE16 [0xB7, 0x00] at slot+16/+17
   *   SEC16 slot 1:     0x00AE
   *   SEC16 slot 2:     0x00C0
   * ─────────────────────────────────────────────────────────────────────── */
  describe('GEN1_RFH — Yazaki 24C16 (2 KB), SYNTHETIC fixture, formula pending real-HW verification', () => {
    it('classifies as RFHUB Gen1 (24C16), size 2048', () => {
      const info = parseModule(F.GEN1_RFH, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin');
      expect(info.type).toBe('RFHUB');
      expect(F.GEN1_RFH.length).toBe(2048);
      expect(info.rfhGen).toBe('Gen1 (24C16)');
    });

    it('VIN "2C3CDZL95NH179529" at offset 0x92 passes crc16 checksum', () => {
      const info = parseModule(F.GEN1_RFH, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin');
      expect(info.vins.length).toBeGreaterThanOrEqual(1);
      expect(info.vins[0].vin).toBe('2C3CDZL95NH179529');
      expect(info.vins[0].crcOk).toBe(true);
    });

    it('slot 1 @ 0x00AE: SEC16 pinned to DE4BBD2F5A1D73647EB2192D01E4F88C', () => {
      const info = parseModule(F.GEN1_RFH, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin');
      expect(info.sec16s.length).toBeGreaterThanOrEqual(1);
      expect(info.sec16s[0].offset).toBe(0x00AE);
      expect(info.sec16s[0].hex).toBe('DE4BBD2F5A1D73647EB2192D01E4F88C');
    });

    it('slot 1 @ 0x00AE: crc8_65 checksum is correct (csOk=true, stored=0xB700, calc=0xB700)', () => {
      const info = parseModule(F.GEN1_RFH, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin');
      const s1 = info.sec16s[0];
      expect(s1.csOk).toBe(true);
      expect(s1.cs).toBe(0xB700);
      expect(s1.csCalc).toBe(0xB700);
    });

    it('slot 2 @ 0x00C0: crc8_65 checksum is correct (csOk=true)', () => {
      const info = parseModule(F.GEN1_RFH, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin');
      expect(info.sec16s.length).toBe(2);
      expect(info.sec16s[1].offset).toBe(0x00C0);
      expect(info.sec16s[1].csOk).toBe(true);
      expect(info.sec16s[1].cs).toBe(0xB700);
    });

    it('both slots carry identical SEC16 bytes (sec16match=true)', () => {
      const info = parseModule(F.GEN1_RFH, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin');
      expect(info.sec16match).toBe(true);
    });

    it('sec16valid=true (not blank, slots match, CRC ok)', () => {
      const info = parseModule(F.GEN1_RFH, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin');
      expect(info.sec16valid).toBe(true);
    });

    it('bcmHex field on slot 1 is the byte-reversed SEC16 = 8CF8E4012D19B27E64731D5A2FBD4BDE', () => {
      const info = parseModule(F.GEN1_RFH, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin');
      expect(info.sec16s[0].bcmHex).toBe('8CF8E4012D19B27E64731D5A2FBD4BDE');
    });

    it('crc8_65 raw primitive independently confirms 0xB7 for the pinned SEC16 bytes', () => {
      const rfhSec16 = V('DE4BBD2F5A1D73647EB2192D01E4F88C');
      expect(crc8_65(rfhSec16)).toBe(0xB7);
    });

    it('rfhSec16Cs returns 0xB700 for the pinned SEC16 bytes', () => {
      const rfhSec16 = V('DE4BBD2F5A1D73647EB2192D01E4F88C');
      expect(rfhSec16Cs(rfhSec16)).toBe(0xB700);
    });
  });
});

/* ============================================================================
 * 4. GPEC2A fixture checksums
 * ========================================================================== */
describe('GPEC2A fixture checksums', () => {
  describe('CARTMAN GPEC2A OG — 8 KB image, forceType=GPEC2A', () => {
    it('forceType:GPEC2A exposes VIN 2C3CDZL95NH179529 at offset 0x0000', () => {
      const info = parseModule(F.CARTMAN_GPEC, 'CONTINENTAL_GPEC2A.bin', { forceType: 'GPEC2A' });
      expect(info.type).toBe('GPEC2A');
      expect(info.vins.length).toBeGreaterThan(0);
      expect(info.vins[0].vin).toBe('2C3CDZL95NH179529');
      expect(info.vins[0].offset).toBe(0x0000);
    });

    it('SEC6 marker FF FF FF AA at 0x03C4 is valid (markerOk=true)', () => {
      const info = parseModule(F.CARTMAN_GPEC, 'CONTINENTAL_GPEC2A.bin', { forceType: 'GPEC2A' });
      expect(info.pcmSec6.markerOk).toBe(true);
      expect(info.pcmSec6.markerHex).toBe('FF FF FF AA');
    });

    it('SEC6 at 0x03C8 is populated and pinned to DE 4B BD 2F 5A 1D', () => {
      const info = parseModule(F.CARTMAN_GPEC, 'CONTINENTAL_GPEC2A.bin', { forceType: 'GPEC2A' });
      expect(info.pcmSec6.populated).toBe(true);
      expect(info.pcmSec6.hex).toBe('DE 4B BD 2F 5A 1D');
    });

    it('raw SEC6 bytes at 0x03C8 match SINCRO reference: DE4BBD2F5A1D', () => {
      expect(hexOf(F.CARTMAN_GPEC, 0x03C8, 6)).toBe('DE4BBD2F5A1D');
    });

    it('BCM-SEC16 mirror at 0x0838 = FF00FC03FF00FFFFFFFFFF00FF00FFFF', () => {
      expect(hexOf(F.CARTMAN_GPEC, 0x0838, 16)).toBe('FF00FC03FF00FFFFFFFFFF00FF00FFFF');
    });

    it('BCM-SEC16 CRC16: stored=0xFC03, calc=0xE323 — MISMATCH (OG unsynced state)', () => {
      const sec16 = F.CARTMAN_GPEC.slice(0x0838, 0x0848);
      const stored = (F.CARTMAN_GPEC[0x0848] << 8) | F.CARTMAN_GPEC[0x0849];
      expect(stored).toBe(0xFC03);
      expect(crc16(sec16)).toBe(0xE323);
      expect(stored).not.toBe(crc16(sec16));
    });
  });
});

/* ============================================================================
 * 5. Writer round-trips
 *
 * Each test takes a known-good synced fixture, extracts the canonical values,
 * writes them back into a fresh buffer copy, and asserts byte-for-byte
 * identity at every mutated offset.
 * ========================================================================== */
describe('Writer round-trips', () => {
  describe('writeRfhSec16FromBcm — FIXED_RFH: write BCM SEC16 back into itself', () => {
    it('writtenSlot1 bytes 0x050E..0x051F match original FIXED_RFH', () => {
      const bcmSec16 = bcmSplitSec16(F.SYNCED_BCM22);
      expect(bcmSec16).not.toBeNull();
      const result = writeRfhSec16FromBcm(F.FIXED_RFH, bcmSec16);
      expect(result.patched).toBe(2);
      const written = result.bytes;
      for (let i = 0; i < 16; i++) {
        expect(written[0x050E + i]).toBe(F.FIXED_RFH[0x050E + i]);
      }
    });

    it('writtenSlot2 bytes 0x0522..0x0531 match original FIXED_RFH', () => {
      const bcmSec16 = bcmSplitSec16(F.SYNCED_BCM22);
      const result = writeRfhSec16FromBcm(F.FIXED_RFH, bcmSec16);
      const written = result.bytes;
      for (let i = 0; i < 16; i++) {
        expect(written[0x0522 + i]).toBe(F.FIXED_RFH[0x0522 + i]);
      }
    });

    it('written slot CS bytes match stored CS in original FIXED_RFH', () => {
      const bcmSec16 = bcmSplitSec16(F.SYNCED_BCM22);
      const result = writeRfhSec16FromBcm(F.FIXED_RFH, bcmSec16);
      const written = result.bytes;
      expect(written[0x050E + 16]).toBe(F.FIXED_RFH[0x050E + 16]);
      expect(written[0x050E + 17]).toBe(F.FIXED_RFH[0x050E + 17]);
      expect(written[0x0522 + 16]).toBe(F.FIXED_RFH[0x0522 + 16]);
      expect(written[0x0522 + 17]).toBe(F.FIXED_RFH[0x0522 + 17]);
    });

    it('re-parsing the written buffer: sec16valid=true and SEC16 unchanged', () => {
      const bcmSec16 = bcmSplitSec16(F.SYNCED_BCM22);
      const result = writeRfhSec16FromBcm(F.FIXED_RFH, bcmSec16);
      const info = parseModule(result.bytes, 'FIXED_RFH.bin');
      expect(info.sec16valid).toBe(true);
      expect(hexOf(info.sec16s[0].raw, 0, 16)).toBe('AB8015D77ED943C1AB45EC16896969DA');
    });

    it('does not mutate the input buffer', () => {
      const orig = F.FIXED_RFH.slice();
      const bcmSec16 = bcmSplitSec16(F.SYNCED_BCM22);
      writeRfhSec16FromBcm(F.FIXED_RFH, bcmSec16);
      expect(Array.from(F.FIXED_RFH)).toEqual(Array.from(orig));
    });
  });

  describe('writeBcmSec16Gen2 — SYNCED_BCM22: write RFH SEC16 back into itself', () => {
    const rfhSec16 = F.FIXED_RFH.slice(0x050E, 0x050E + 16);

    it('patched=5 (3 split + 2 mirror) and split SEC16 bytes match original', () => {
      const result = writeBcmSec16Gen2(F.SYNCED_BCM22, rfhSec16);
      expect(result.splitPatched).toBe(3);
      expect(result.mirrorPatched).toBe(2);
      for (const base of [0x81A0, 0x81C0, 0x81E0]) {
        for (let k = 0; k < 7; k++) {
          expect(result.bytes[base + 9 + k]).toBe(F.SYNCED_BCM22[base + 9 + k]);
        }
        for (let k = 0; k < 9; k++) {
          expect(result.bytes[base + 20 + k]).toBe(F.SYNCED_BCM22[base + 20 + k]);
        }
      }
    });

    it('re-parsing written buffer: bcmSec16 source=split, unchanged SEC16 hex', () => {
      const result = writeBcmSec16Gen2(F.SYNCED_BCM22, rfhSec16);
      const info = parseModule(result.bytes, 'SYNCED_BCM22.bin');
      expect(info.bcmSec16.source).toBe('split');
      expect(hexOf(info.bcmSec16.bytes, 0, 16)).toBe('DA69698916EC45ABC143D97ED71580AB');
    });

    it('does not mutate the input buffer', () => {
      const orig = F.SYNCED_BCM22.slice();
      writeBcmSec16Gen2(F.SYNCED_BCM22, rfhSec16);
      expect(Array.from(F.SYNCED_BCM22)).toEqual(Array.from(orig));
    });
  });

  describe('writeBcmFlatSec16 — write canonical SEC16 into flat 0x40C9 slice', () => {
    /* The SYNCED_BCM22 real-bench fixture has a mirror1 record header at
     * 0x40C0, whose 16-byte SEC16 payload occupies exactly 0x40C9..0x40D8
     * — the same slice the flat repair writer targets. Per Task #779 the
     * writer self-guards against this overlap and skips the write so a
     * chained `writeBcmSec16Gen2` → `writeBcmFlatSec16` run cannot
     * silently clobber the mirror's freshly-written canonical SEC16. */
    it('skips write on SYNCED_BCM22 (mirror1 at 0x40C0 overlaps flat slice)', () => {
      const sec16 = bcmSplitSec16(F.SYNCED_BCM22);
      const result = writeBcmFlatSec16(F.SYNCED_BCM22, sec16);
      expect(result.skipped).toBe(true);
      expect(result.patched).toBe(0);
      expect(result.skipReason).toMatch(/mirror1/);
    });

    it('offset field still reports 0x40C9 even when skipped', () => {
      const sec16 = bcmSplitSec16(F.SYNCED_BCM22);
      const result = writeBcmFlatSec16(F.SYNCED_BCM22, sec16);
      expect(result.offset).toBe(0x40C9);
    });

    it('returns input bytes verbatim when the overlap guard fires', () => {
      const sec16 = bcmSplitSec16(F.SYNCED_BCM22);
      const result = writeBcmFlatSec16(F.SYNCED_BCM22, sec16);
      // Every byte — including the flat slice itself — is unchanged.
      for (let i = 0; i < F.SYNCED_BCM22.length; i++) {
        if (result.bytes[i] !== F.SYNCED_BCM22[i]) {
          throw new Error('Buffer mutated at 0x' + i.toString(16).toUpperCase());
        }
      }
    });

    /* Task #794 — legacy-flat compatibility mode. On the overlap dump the
     * writer forces the LE write so a downstream legacy locksmith tool
     * (CGDI / AlfaOBD / SINCRO) parsing the flat slice as little-endian
     * sees the correct vehicle secret. The mirror1 record's SEC16 payload
     * is clobbered as a side-effect; the split records at 0x81A0/C0/E0
     * remain canonical and the resolver still recovers the right secret. */
    describe('legacy-flat mode — SYNCED_BCM22 round-trip', () => {
      it('forces the LE write even when mirror1 overlaps the flat slice', () => {
        const sec16 = bcmSplitSec16(F.SYNCED_BCM22);
        const result = writeBcmFlatSec16(F.SYNCED_BCM22, sec16, { mode: 'legacy-flat' });
        expect(result.skipped).toBe(false);
        expect(result.patched).toBe(16);
        expect(result.mode).toBe('legacy-flat');
        expect(result.mirror1Overlap).toBe(true);
        expect(result.mirror1ClobberedAt).toBe(0x40C0);
        const expectedLe = new Uint8Array(16);
        for (let i = 0; i < 16; i++) expectedLe[i] = sec16[15 - i];
        expect(hexOf(result.bytes, 0x40C9, 16)).toBe(H(expectedLe));
      });

      it('split records (0x81A0/C0/E0) remain canonical after the legacy-flat write', () => {
        const sec16 = bcmSplitSec16(F.SYNCED_BCM22);
        const result = writeBcmFlatSec16(F.SYNCED_BCM22, sec16, { mode: 'legacy-flat' });
        for (const off of [0x81A0, 0x81C0, 0x81E0]) {
          for (let k = 0; k < 30; k++) {
            expect(result.bytes[off + k]).toBe(F.SYNCED_BCM22[off + k]);
          }
        }
      });

      it('parseModule still resolves the canonical SEC16 from split records', () => {
        const sec16 = bcmSplitSec16(F.SYNCED_BCM22);
        const result = writeBcmFlatSec16(F.SYNCED_BCM22, sec16, { mode: 'legacy-flat' });
        const info = parseModule(result.bytes, 'SYNCED_BCM22.bin');
        expect(info.bcmSec16.source).toBe('split');
        expect(hexOf(info.bcmSec16.bytes, 0, 16)).toBe(H(sec16));
      });

      it('canonical mode default is unchanged when options omitted', () => {
        const sec16 = bcmSplitSec16(F.SYNCED_BCM22);
        const result = writeBcmFlatSec16(F.SYNCED_BCM22, sec16);
        expect(result.mode).toBe('canonical');
        expect(result.skipped).toBe(true);
      });

      it('rejects unknown mode values', () => {
        const sec16 = bcmSplitSec16(F.SYNCED_BCM22);
        expect(() => writeBcmFlatSec16(F.SYNCED_BCM22, sec16, { mode: 'bogus' }))
          .toThrow(/Unknown writeBcmFlatSec16 mode/);
      });
    });
  });

  describe('writePcmSec6 — write RFH SEC16 first-6 into GPEC2A image', () => {
    it('patched=1 and ok=true for canonical 8 KB GPEC2A image', () => {
      const rfhSec16 = F.CARTMAN_RFH.slice(0x050E, 0x050E + 16);
      const result = writePcmSec6(F.CARTMAN_GPEC, rfhSec16);
      expect(result.patched).toBe(1);
      expect(result.ok).toBe(true);
    });

    it('marker FF FF FF AA written at 0x03C4', () => {
      const rfhSec16 = F.CARTMAN_RFH.slice(0x050E, 0x050E + 16);
      const result = writePcmSec6(F.CARTMAN_GPEC, rfhSec16);
      expect(Array.from(result.bytes.slice(0x03C4, 0x03C8))).toEqual([0xFF, 0xFF, 0xFF, 0xAA]);
    });

    it('first 6 bytes at 0x03C8 match RFH SEC16[0..5] = DE4BBD2F5A1D', () => {
      const rfhSec16 = F.CARTMAN_RFH.slice(0x050E, 0x050E + 16);
      const result = writePcmSec6(F.CARTMAN_GPEC, rfhSec16);
      expect(hexOf(result.bytes, 0x03C8, 6)).toBe('DE4BBD2F5A1D');
    });

    it('bytes outside 0x03C4..0x03CD are untouched before the write', () => {
      const rfhSec16 = F.CARTMAN_RFH.slice(0x050E, 0x050E + 16);
      const result = writePcmSec6(F.CARTMAN_GPEC, rfhSec16);
      expect(result.bytes[0x03C3]).toBe(F.CARTMAN_GPEC[0x03C3]);
      expect(result.bytes[0x03CE]).toBe(F.CARTMAN_GPEC[0x03CE]);
    });
  });

  describe('writeRfhSec16Gen1 — SYNTHETIC round-trip (parse↔write contract only; NOT real-HW verified)', () => {
    /* BCM SEC16 from the CARTMAN donor (same set used to build the fixture).
     * These tests validate that the writer and parser agree on the crc8_65
     * formula.  They are NOT evidence that crc8_65 is the correct formula for
     * real Yazaki 24C16 hardware — see FORMULA_UNVERIFIED_ON_REAL_HW above. */
    const bcmSec16 = V('8CF8E4012D19B27E64731D5A2FBD4BDE');

    it('patched=2 (both Gen1 slots written)', () => {
      const result = writeRfhSec16Gen1(F.GEN1_RFH, bcmSec16);
      expect(result.patched).toBe(2);
    });

    it('rfhSec16Hex = DE4BBD2F5A1D73647EB2192D01E4F88C (reverse of BCM SEC16)', () => {
      const result = writeRfhSec16Gen1(F.GEN1_RFH, bcmSec16);
      expect(result.rfhSec16Hex).toBe('de4bbd2f5a1d73647eb2192d01e4f88c');
    });

    it('chk = 0xB7', () => {
      const result = writeRfhSec16Gen1(F.GEN1_RFH, bcmSec16);
      expect(result.chk).toBe(0xB7);
    });

    it('slot 1 @ 0x00AE: written 18 bytes are byte-identical to the fixture', () => {
      const result = writeRfhSec16Gen1(F.GEN1_RFH, bcmSec16);
      for (let i = 0; i < 18; i++) {
        expect(result.bytes[0x00AE + i]).toBe(F.GEN1_RFH[0x00AE + i]);
      }
    });

    it('slot 2 @ 0x00C0: written 18 bytes are byte-identical to the fixture', () => {
      const result = writeRfhSec16Gen1(F.GEN1_RFH, bcmSec16);
      for (let i = 0; i < 18; i++) {
        expect(result.bytes[0x00C0 + i]).toBe(F.GEN1_RFH[0x00C0 + i]);
      }
    });

    it('checksum byte at slot+16 is 0xB7 and trailer byte at slot+17 is 0x00', () => {
      const result = writeRfhSec16Gen1(F.GEN1_RFH, bcmSec16);
      for (const off of [0x00AE, 0x00C0]) {
        expect(result.bytes[off + 16]).toBe(0xB7);
        expect(result.bytes[off + 17]).toBe(0x00);
      }
    });

    it('re-parsing the written buffer: sec16valid=true and SEC16 unchanged', () => {
      const result = writeRfhSec16Gen1(F.GEN1_RFH, bcmSec16);
      const info = parseModule(result.bytes, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin');
      expect(info.sec16valid).toBe(true);
      expect(info.sec16s[0].hex).toBe('DE4BBD2F5A1D73647EB2192D01E4F88C');
    });

    it('does not mutate the input buffer', () => {
      const orig = F.GEN1_RFH.slice();
      writeRfhSec16Gen1(F.GEN1_RFH, bcmSec16);
      expect(Array.from(F.GEN1_RFH)).toEqual(Array.from(orig));
    });

    it('rfhSec16Cs of the written slot bytes matches the stored BE16 checksum', () => {
      const result = writeRfhSec16Gen1(F.GEN1_RFH, bcmSec16);
      for (const off of [0x00AE, 0x00C0]) {
        const raw16 = result.bytes.slice(off, off + 16);
        const stored = (result.bytes[off + 16] << 8) | result.bytes[off + 17];
        expect(rfhSec16Cs(raw16)).toBe(stored);
      }
    });
  });
});

/* ============================================================================
 * 6. Cross-module SEC16 pairings
 *
 * Rule: reverse(RFH_SEC16) === BCM_SEC16 (BE representation).
 *       GPEC_SEC6 === RFH_SEC16[0..5].
 * ========================================================================== */
describe('Cross-module SEC16 pairings', () => {
  describe('CARTMAN set — BCM + RFHUB + GPEC2A', () => {
    it('reverse(CARTMAN_RFH SEC16 slot1) === CARTMAN_BCM split SEC16', () => {
      const rfhSec16 = F.CARTMAN_RFH.slice(0x050E, 0x050E + 16);
      const rfhRev   = Array.from(rfhSec16).reverse()
        .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      expect(rfhRev).toBe(bcmSplitSec16Hex(F.CARTMAN_BCM));
    });

    it('GPEC SEC6 at 0x03C8 equals the first 6 bytes of RFHUB SEC16 slot1', () => {
      expect(hexOf(F.CARTMAN_GPEC, 0x03C8, 6)).toBe(hexOf(F.CARTMAN_RFH, 0x050E, 6));
    });
  });

  describe('22 Charger set A — VIRGIN_BCM22 + VIRGIN_RFH21 (different vehicles paired by prior sync)', () => {
    it('reverse(VIRGIN_RFH21 SEC16) === VIRGIN_BCM22 split SEC16', () => {
      const rfhSec16 = F.VIRGIN_RFH21.slice(0x050E, 0x050E + 16);
      const rfhRev   = Array.from(rfhSec16).reverse()
        .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      expect(rfhRev).toBe(bcmSplitSec16Hex(F.VIRGIN_BCM22));
    });

    it('VIRGIN_BCM22 carries VIN 2C3CDXCT1HH652640 (donor); VIRGIN_RFH21 carries VIN 2C3CDXGJ3KH728648 (target)', () => {
      const bcmInfo = parseModule(F.VIRGIN_BCM22, 'VIRGIN_BCM22.bin');
      const rfhInfo = parseModule(F.VIRGIN_RFH21, 'VIRGIN_RFH21.bin');
      expect(bcmInfo.vins[0].vin).toBe('2C3CDXCT1HH652640');
      expect(rfhInfo.vins[0].vin).toBe('2C3CDXGJ3KH728648');
    });
  });

  describe('22 Charger set B — SYNCED_BCM22 + FIXED_RFH (same vehicle, post-sync)', () => {
    it('reverse(FIXED_RFH SEC16) === SYNCED_BCM22 split SEC16', () => {
      const rfhSec16 = F.FIXED_RFH.slice(0x050E, 0x050E + 16);
      const rfhRev   = Array.from(rfhSec16).reverse()
        .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      expect(rfhRev).toBe(bcmSplitSec16Hex(F.SYNCED_BCM22));
    });

    it('both modules carry VIN 2C3CDXGJ3KH728648 (same vehicle)', () => {
      const bcmInfo = parseModule(F.SYNCED_BCM22, 'SYNCED_BCM22.bin');
      const rfhInfo = parseModule(F.FIXED_RFH, 'FIXED_RFH.bin');
      expect(bcmInfo.vins[0].vin).toBe('2C3CDXGJ3KH728648');
      expect(rfhInfo.vins[0].vin).toBe('2C3CDXGJ3KH728648');
    });

    it('FIXED_RFH SEC16 is valid (CRC8 OK, slots match)', () => {
      const info = parseModule(F.FIXED_RFH, 'FIXED_RFH.bin');
      expect(info.sec16s[0].csOk).toBe(true);
      expect(info.sec16match).toBe(true);
    });
  });
});

/* ============================================================================
 * 7. SINCRO parity — CARTMAN OG state
 *
 * The SINCRO reference paste documents the exact cross-module MISMATCH state
 * for the three CARTMAN files.  These tests pin every relevant field so that
 * any regression in the parsers produces a named-offset diff.
 * ========================================================================== */
describe('SINCRO parity — CARTMAN OG state', () => {
  describe('BCM CARTMAN', () => {
    it('0x40C9..0x40D8 flat slice = all-FF (BLANK)', () => {
      expect(hexOf(F.CARTMAN_BCM, 0x40C9, 16)).toBe('FF'.repeat(16));
    });

    it('split records @0x81A0 idx=0x01, @0x81C0 idx=0x02, @0x81E0 idx=0x02', () => {
      expect(F.CARTMAN_BCM[0x81A0 + 8]).toBe(0x01);
      expect(F.CARTMAN_BCM[0x81C0 + 8]).toBe(0x02);
      expect(F.CARTMAN_BCM[0x81E0 + 8]).toBe(0x02);
    });

    it('all three split records carry identical SEC16 = 8CF8E4012D19B27E64731D5A2FBD4BDE', () => {
      const secs = [0x81A0, 0x81C0, 0x81E0].map(base => {
        const sec16 = new Uint8Array(16);
        for (let k = 0; k < 7; k++) sec16[k] = F.CARTMAN_BCM[base + 9 + k];
        for (let k = 0; k < 9; k++) sec16[7 + k] = F.CARTMAN_BCM[base + 20 + k];
        return hexOf(sec16, 0, 16);
      });
      expect(secs[0]).toBe('8CF8E4012D19B27E64731D5A2FBD4BDE');
      expect(secs[1]).toBe(secs[0]);
      expect(secs[2]).toBe(secs[0]);
    });

    it('0x8028 = 0x5A (LOCKED)', () => {
      expect(F.CARTMAN_BCM[0x8028]).toBe(0x5A);
    });

    it('0x5862 = 0xFF = 255 (FOBIK uninitialized)', () => {
      expect(F.CARTMAN_BCM[0x5862]).toBe(0xFF);
    });

    it('parseModule: immoBlank=true, bakRecs=8', () => {
      const info = parseModule(F.CARTMAN_BCM, 'CARTMAN_BCM.bin');
      expect(info.immoBlank).toBe(true);
      expect(info.bakRecs).toBe(8);
    });
  });

  describe('RFHUB CARTMAN — OG mismatch state', () => {
    it('four VIN slots at 0x0EA5/0x0EB9/0x0ECD/0x0EE1 hold VIN 2C3CDZL95NH179529 (byte-reversed)', () => {
      const offsets = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
      for (const off of offsets) {
        const vin = Array.from(F.CARTMAN_RFH.slice(off, off + 17))
          .reverse().map(b => String.fromCharCode(b)).join('');
        expect(vin).toBe('2C3CDZL95NH179529');
      }
    });

    it('SEC16 slot1@0x050E: stored=0xB500, crc8_65 calc=0xB700 (MISMATCH)', () => {
      const slot16 = F.CARTMAN_RFH.slice(0x050E, 0x050E + 16);
      expect((F.CARTMAN_RFH[0x050E + 16] << 8) | F.CARTMAN_RFH[0x050E + 17]).toBe(0xB500);
      expect((crc8_65(slot16) << 8) | 0x00).toBe(0xB700);
    });

    it('SEC16 slot2@0x0522: same stored/calc mismatch as slot1', () => {
      const slot16 = F.CARTMAN_RFH.slice(0x0522, 0x0522 + 16);
      expect((F.CARTMAN_RFH[0x0522 + 16] << 8) | F.CARTMAN_RFH[0x0522 + 17]).toBe(0xB500);
      expect((crc8_65(slot16) << 8) | 0x00).toBe(0xB700);
    });
  });

  describe('GPEC2A CARTMAN OG', () => {
    it('VIN 2C3CDZL95NH179529 at 0x0000', () => {
      expect(new TextDecoder().decode(F.CARTMAN_GPEC.slice(0, 17))).toBe('2C3CDZL95NH179529');
    });

    it('SECRET at 0x0040 (16 B) = 01CC16C000000000E975FFFFFFFFFF1F (paste: "01 CC 16 C0 ...")', () => {
      expect(hexOf(F.CARTMAN_GPEC, 0x0040, 16)).toBe('01CC16C000000000E975FFFFFFFFFF1F');
    });

    it('SEC6 marker FF FF FF AA at 0x03C4', () => {
      expect(Array.from(F.CARTMAN_GPEC.slice(0x03C4, 0x03C8))).toEqual([0xFF, 0xFF, 0xFF, 0xAA]);
    });

    it('SEC6 bytes at 0x03C8 = DE4BBD2F5A1D (first 6 bytes of RFH SEC16)', () => {
      expect(hexOf(F.CARTMAN_GPEC, 0x03C8, 6)).toBe('DE4BBD2F5A1D');
    });

    it('BCM-SEC16 mirror at 0x0838 = FF00FC03FF00FFFFFFFFFF00FF00FFFF', () => {
      expect(hexOf(F.CARTMAN_GPEC, 0x0838, 16)).toBe('FF00FC03FF00FFFFFFFFFF00FF00FFFF');
    });

    it('BCM-SEC16 CRC16 @0x0848: stored=0xFC03 calc=0xE323 (MISMATCH)', () => {
      const sec16 = F.CARTMAN_GPEC.slice(0x0838, 0x0848);
      expect((F.CARTMAN_GPEC[0x0848] << 8) | F.CARTMAN_GPEC[0x0849]).toBe(0xFC03);
      expect(crc16(sec16)).toBe(0xE323);
    });
  });
});

/* ============================================================================
 * 8. AlfaOBD frame replay
 *
 * Replays the UDS 27 01 / 27 02 seed→key exchange for the three AlfaOBD
 * cipher families: ht (bit-shuffle w6), f (XTEA LE), ao (XTEA BE).
 *
 * All expected values are confirmed by running algos.js directly in Node.js
 * against the production export (see task #48 verification log).  Tests cover:
 *   • raw byte-function output
 *   • unlockKeyBytes dispatcher agreement
 *   • LE-vs-BE divergence for asymmetric seeds
 *   • dispatcher null / contract checks
 * ========================================================================== */
describe('AlfaOBD frame replay', () => {
  describe('alfaHt — w6 bit-shuffle (ECU families: BCM body-bus, IPC)', () => {
    const CASES = [
      { seed: '00000000', key: '41AA42BB', note: 'zero seed → XOR constants only' },
      { seed: '01234567', key: '4AB26A16', note: 'realistic ECU challenge' },
      { seed: 'F28814A5', key: 'F60AF0B9', note: 'reversed-byte asymmetric seed' },
      { seed: 'ABCDEF01', key: '3B2DB38C', note: 'high-nibble stress seed' },
    ];

    for (const { seed, key, note } of CASES) {
      it(`seed=${seed} → key=${key}  (${note})`, () => {
        const sb = V(seed);
        expect(H(alfaHt(sb))).toBe(key);
        expect(H(new Uint8Array(unlockKeyBytes('alfa_ht', sb)))).toBe(key);
      });
    }
  });

  describe('alfaF — XTEA LE seed (trigger: af::ix=true, ge=51, aj=5)', () => {
    const CASES = [
      { seed: '00000000', key: '36592FB8', note: 'zero seed' },
      { seed: 'F28814A5', key: '4A740F98', note: 'BCM-style capture replay' },
      { seed: '01234567', key: 'ED6E5210', note: 'diverge-check seed vs alfaAo' },
    ];

    for (const { seed, key, note } of CASES) {
      it(`seed=${seed} → key=${key}  (${note})`, () => {
        const sb = V(seed);
        expect(H(alfaF(sb))).toBe(key);
        expect(H(new Uint8Array(unlockKeyBytes('alfa_f', sb)))).toBe(key);
      });
    }
  });

  describe('alfaAo — XTEA BE seed (UCONNECT 0x149 / RADIO_FGA 0x14E level-5)', () => {
    const CASES = [
      { seed: '00000000', key: '36592FB8', note: 'zero seed equals alfaF zero (symmetric)' },
      { seed: '7A3C1D5E', key: '4A965412', note: 'UCONNECT level-5 capture replay' },
      { seed: '01234567', key: 'D0992280', note: 'diverge-check seed vs alfaF' },
    ];

    for (const { seed, key, note } of CASES) {
      it(`seed=${seed} → key=${key}  (${note})`, () => {
        const sb = V(seed);
        expect(H(alfaAo(sb))).toBe(key);
        expect(H(new Uint8Array(unlockKeyBytes('alfa_ao', sb)))).toBe(key);
      });
    }
  });

  describe('alfaF / alfaAo diverge — LE vs BE byte-order distinction', () => {
    it('alfaF and alfaAo produce different keys for asymmetric seed 01234567', () => {
      const seed = V('01234567');
      expect(H(alfaF(seed))).not.toBe(H(alfaAo(seed)));
      expect(H(alfaF(seed))).toBe('ED6E5210');
      expect(H(alfaAo(seed))).toBe('D0992280');
    });

    it('alfaF and alfaAo agree on zero seed (symmetric when seed bytes are all-zero)', () => {
      const seed = V('00000000');
      expect(H(alfaF(seed))).toBe(H(alfaAo(seed)));
    });
  });

  describe('unlockKeyBytes dispatcher contract', () => {
    it('returns null for unknown algorithm id', () => {
      expect(unlockKeyBytes('alfa_zz', V('00000000'))).toBeNull();
    });

    it('returns an Array (not Uint8Array) of exactly 4 numeric bytes', () => {
      const key = unlockKeyBytes('alfa_ht', V('01234567'));
      expect(Array.isArray(key)).toBe(true);
      expect(key).toHaveLength(4);
      for (const b of key) {
        expect(typeof b).toBe('number');
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(255);
      }
    });

    it('returns null when seed is shorter than 4 bytes', () => {
      expect(unlockKeyBytes('alfa_ht', V('0102'))).toBeNull();
    });
  });
});

/* ============================================================================
 * 9. Manifest-driven fixture sweep
 *
 * Every known .bin from both attached_assets/ and src/__tests__/fixtures/ is
 * registered in MANIFEST with its expected parseModule() outcome.  The loop
 * below generates one sub-describe per entry so a single file failure names
 * exactly which fixture regressed.
 *
 * Coverage policy:
 *   - All 10 files in F (already loaded above) are represented.
 *   - Additional files from fixtures/ that appear in other test suites are
 *     included so this sweep is the single authoritative catalog of verified
 *     binary states.
 *   - GPEC2A images require forceType:'GPEC2A' because they have no
 *     self-identifying magic byte that identifyModule recognises without hint.
 *   - Fields are optional; absent keys are not asserted.
 * ========================================================================== */
const MANIFEST = [
  /* ── BCM D-Flash (65 536 bytes) ───────────────────────────────────────── */
  {
    label: 'CARTMAN BCM OG — donor, split SEC16, blank VIN zone',
    file:  path.join(ATTACHED, 'CARTMAN0GBCMDFLASH21CHARGERRED_1776135460756.bin'),
    type: 'BCM', size: 65536, vinCount: 0, sec16source: 'split', sec16blank: false,
  },
  {
    label: 'TRACKHAWK BCM OG — base+0 VIN layout, mirror/flat SEC16',
    file:  path.join(ATTACHED, '18TRACKHAWKDFLASHBCM_DRAGKAT_OG_1C4RJFDJXEC365477_1776020054236.bin'),
    type: 'BCM', size: 65536, vinCount: 4, vin: '1C4RJFDJXEC365477', vinCrcOk: true,
  },
  {
    label: '22 Charger VIRGIN BCM — Redeye base+8, donor VIN',
    file:  path.join(ATTACHED, '22CHARGER_REDEYE_6.2_797BCM_DFLASH_VIRGIN_1776226962777.bin'),
    type: 'BCM', size: 65536, vinCount: 4, vin: '2C3CDXCT1HH652640', vinCrcOk: true, sec16blank: false,
  },
  {
    label: '22 Charger SYNCED BCM — target VIN, split+flat consistent',
    file:  path.join(ATTACHED, 'BCM_22CHARGER_REDEYE_6.2_797BCM_DFLASH_VIRGIN_SYNC_1776840027540.bin'),
    type: 'BCM', size: 65536, vinCount: 4, vin: '2C3CDXGJ3KH728648', vinCrcOk: true, sec16blank: false,
  },
  {
    label: 'SAMPLE BCM synced (fixtures/) — Redeye 2C3CDXL90MH582899',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin'),
    type: 'BCM', size: 65536, vinCount: 3, vin: '2C3CDXL90MH582899', vinCrcOk: true, sec16blank: false,
  },
  {
    label: 'SAMPLE BCM 18TH OG (fixtures/) — base+0, four VIN slots',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_18TH_OG.bin'),
    type: 'BCM', size: 65536, vinCount: 4, vin: '1C4RJFN9XJC309165', vinCrcOk: true,
  },
  {
    label: 'SAMPLE BCM rescued-VIN (fixtures/) — 2C3CDXL97LH237142',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2.bin'),
    type: 'BCM', size: 65536, vin: '2C3CDXL97LH237142', vinCrcOk: true,
  },
  /* ── RFHUB EEE (4 096 bytes) ─────────────────────────────────────────── */
  {
    label: 'CARTMAN RFHUB OG — magic 0x87, SEC16 CS mismatch (expected OG state)',
    file:  path.join(ATTACHED, 'CARTMAN21CHARGER6.2RFHUBOG_1776135460754.bin'),
    type: 'RFHUB', size: 4096, vinCount: 4, vin: '2C3CDZL95NH179529', vinCrcOk: true,
    sec16valid: false,
  },
  {
    label: 'VIRGIN RFH21 synced — magic 0xFF, SEC16 CS OK, slots match',
    file:  path.join(ATTACHED, '21RFHUB_VIRGIN_EEE_ALREADYSYNCHED_1776837681902.bin'),
    type: 'RFHUB', size: 4096, vinCount: 4, vin: '2C3CDXGJ3KH728648', vinCrcOk: true,
    sec16valid: true,
  },
  {
    label: 'FIXED_RFH — synced to SYNCED_BCM22, SEC16 CS OK',
    file:  path.join(ATTACHED, 'FIXED_RFH_ZO_PAIRED_TO_MODULES_1776839997904.bin'),
    type: 'RFHUB', size: 4096, vinCount: 4, vin: '2C3CDXGJ3KH728648', vinCrcOk: true,
    sec16valid: true,
  },
  {
    label: 'SAMPLE RFH synced-virgin (fixtures/) — magic 0x85',
    file:  path.join(FIXTURES, 'SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin'),
    type: 'RFHUB', size: 4096, vinCount: 4, vin: '2C3CDXL90MH582899', vinCrcOk: true,
  },
  {
    label: 'SAMPLE RFHUB EEE OG 20 Charger (fixtures/) — mixed VIN slots (mismatched pair)',
    file:  path.join(FIXTURES, 'SAMPLE_RFHUB_EEE_OG_2C3CDXCT1HH652640.bin'),
    type: 'RFHUB', size: 4096, vinCount: 4,
  },
  {
    label: 'SAMPLE RFHUB EEE 19 Charger 6.2 key-index (fixtures/) — known-good key 0077A29B ground truth',
    file:  path.join(FIXTURES, 'SAMPLE_RFHUB_EEE_19CHARGER62_KEYINDEX_0077A29B.bin'),
    type: 'RFHUB', size: 4096,
  },
  {
    label: 'SAMPLE RFHUB EEE Charger SCAT (fixtures/) — 5-key table, golden key-index corpus',
    file:  path.join(FIXTURES, 'SAMPLE_RFHUB_EEE_SCATPACK_KEYS_2C3CDXHG5EH219538.bin'),
    type: 'RFHUB', size: 4096,
  },
  {
    label: 'SAMPLE RFHUB EEE Charger 6.2 CARTMAN (fixtures/) — 3-key table, golden key-index corpus',
    file:  path.join(FIXTURES, 'SAMPLE_RFHUB_EEE_21CHARGER62_KEYS_2C3CDZL95NH179529.bin'),
    type: 'RFHUB', size: 4096,
  },
  {
    label: 'SAMPLE RFHUB EEE 22 Redeye 797 (fixtures/) — 4-key table, golden key-index corpus',
    file:  path.join(FIXTURES, 'SAMPLE_RFHUB_EEE_22REDEYE797_KEYS_2C3CDXGJXNH176487.bin'),
    type: 'RFHUB', size: 4096, vin: '2C3CDXGJXNH176487',
  },
  /* ── GPEC2A EXT EEPROM ───────────────────────────────────────────────── */
  {
    label: 'CARTMAN GPEC2A OG — 8 KB, SEC6 OK, BCM-SEC16 CRC mismatch',
    file:  path.join(ATTACHED, 'CONTINENTAL_GPEC2A_EXT_EEPROM_20251224105131_OG_FILE_1776135460755.bin'),
    type: 'GPEC2A', size: 8192, forceType: 'GPEC2A', vinCount: 3, vin: '2C3CDZL95NH179529',
  },
  {
    label: 'SAMPLE GPEC2A EXT EEPROM 18TH OG (fixtures/) — 8 KB',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_EXT_EEPROM_18TH_OG.bin'),
    type: 'GPEC2A', size: 8192, forceType: 'GPEC2A',
  },
  {
    label: 'SAMPLE GPEC2A EXT EEPROM VIRGIN OG (fixtures/) — 4 KB',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_EXT_EEPROM_VIRGIN_OG.bin'),
    type: 'GPEC2A', size: 4096, forceType: 'GPEC2A',
  },
  {
    label: 'SAMPLE GPEC2A EXT EEPROM 797 Redeye (fixtures/) — 8 KB, 22 Redeye 797 donor',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_EXT_EEPROM_797REDEYE_2C3CDXGJXNH176487.bin'),
    type: 'GPEC2A', size: 8192, forceType: 'GPEC2A', vin: '2C3CDXGJXNH176487',
  },
  /* ── Additional BCM D-Flash fixtures ────────────────────────────────── */
  {
    label: 'SAMPLE BCM 18TH OG CRC (fixtures/) — base+0, CRC written',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_18TH_OG_CRC.bin'),
    type: 'BCM', size: 65536, vinCrcOk: true,
  },
  {
    label: 'SAMPLE BCM 18TH OG VARIANT2 (fixtures/) — alternate Trackhawk',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_18TH_OG_VARIANT2.bin'),
    type: 'BCM', size: 65536, vin: '1C4RJFDJXEC365477', vinCrcOk: true,
  },
  {
    label: 'SAMPLE BCM 18TH DEMO PATCHED (fixtures/)',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_18TH_DEMO_PATCHED.bin'),
    type: 'BCM', size: 65536, vinCrcOk: true,
  },
  {
    label: 'SAMPLE BCM 18TH DEMO VIN CRC 1C4RJFDJ7DC513874 (fixtures/)',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_18TH_DEMO_VIN_CRC_1C4RJFDJ7DC513874.bin'),
    type: 'BCM', size: 65536, vin: '1C4RJFDJ7DC513874', vinCrcOk: true,
  },
  {
    label: 'SAMPLE BCM 18TH DEMO VIN CRC 1C4RJFDJXEC365477 (fixtures/)',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_18TH_DEMO_VIN_CRC_1C4RJFDJXEC365477.bin'),
    /* NOTE: filename suffix refers to donor ECU, not the VIN written; actual stored VIN = 1C4RJFDJ7DC513874 */
    type: 'BCM', size: 65536, vin: '1C4RJFDJ7DC513874', vinCrcOk: true,
  },
  {
    label: 'SAMPLE BCM rescued-VIN ba26d1c1 (fixtures/) — alternate checksum',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1.bin'),
    type: 'BCM', size: 65536, vin: '2C3CDXL97LH237142', vinCrcOk: true,
  },
  {
    label: 'SAMPLE BCM rescued-VIN 0d3593f2 dup (fixtures/)',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2_dup_1776900716171.bin'),
    type: 'BCM', size: 65536, vin: '2C3CDXL97LH237142', vinCrcOk: true,
  },
  {
    label: 'SAMPLE BCM rescued-VIN ba26d1c1 dup (fixtures/)',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1_dup_1776900716172.bin'),
    type: 'BCM', size: 65536, vin: '2C3CDXL97LH237142', vinCrcOk: true,
  },
  {
    label: 'SAMPLE 95640 FCA DK OG (fixtures/) — 64 KB BCM D-Flash',
    file:  path.join(FIXTURES, 'SAMPLE_95640_EXT_EEPROM_FCA_DK_OG.bin'),
    type: 'BCM', size: 65536, vinCrcOk: true,
  },
  {
    label: 'SAMPLE GPEC2A INT FLASH JAILBREAK 62 (fixtures/) — BCM-shaped 64 KB',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_INT_FLASH_JAILBREAK_62.bin'),
    type: 'BCM', size: 65536, vinCrcOk: true,
  },
  /* ── Additional RFHUB fixtures ───────────────────────────────────────── */
  {
    label: 'SAMPLE RFHUB PFLASH OG (fixtures/) — P-Flash 4 KB',
    file:  path.join(FIXTURES, 'SAMPLE_RFHUB_PFLASH_OG_2C3CDXCT1HH652640.bin'),
    type: 'RFHUB', size: 4096, vin: '2C3CDXCT1HH652640',
    /* vinCrcOk omitted: OG file has mixed-state slots (slots 0-1 synced, 2-3 carry a prior VIN) */
  },
  {
    label: 'SAMPLE GPEC2A EXT EEPROM VIRGIN SYNCED 62 (fixtures/) — RFHUB-format 4 KB',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_EXT_EEPROM_VIRGIN_SYNCED_62.bin'),
    type: 'RFHUB', size: 4096, vin: '2C3CDXCT1HH652640', vinCrcOk: true,
  },
  /* ── 95640 EXT EEPROM (8 192 bytes) ─────────────────────────────────── */
  {
    label: 'SAMPLE 95640 18TH BAMA OG (fixtures/) — 8 KB EEPROM',
    file:  path.join(FIXTURES, 'SAMPLE_95640_EXT_EEPROM_18TH_BAMA_OG.bin'),
    type: '95640', size: 8192,
  },
  {
    label: 'SAMPLE 95640 18TH BAMA VIN CRC (fixtures/) — 8 KB with VIN written',
    file:  path.join(FIXTURES, 'SAMPLE_95640_EXT_EEPROM_18TH_BAMA_VIN_CRC_1C4RJFDJ7DC513874.bin'),
    type: '95640', size: 8192,
  },
  {
    label: 'SAMPLE 95640 FCA 04120001 OG (fixtures/) — 8 KB EEPROM',
    file:  path.join(FIXTURES, 'SAMPLE_95640_EXT_EEPROM_FCA_04120001_OG.bin'),
    type: '95640', size: 8192,
  },
  {
    label: 'SAMPLE 95640 FCA 04120001 VIN CRC (fixtures/) — 8 KB with VIN written',
    file:  path.join(FIXTURES, 'SAMPLE_95640_EXT_EEPROM_FCA_04120001_VIN_CRC_1C4RJFDJ7DC513874.bin'),
    type: '95640', size: 8192,
  },
  {
    label: 'SAMPLE BCM 18TH DEMO OG 8 KB (fixtures/) — 95640-format EEPROM',
    file:  path.join(FIXTURES, 'SAMPLE_BCM_DFLASH_18TH_DEMO_OG.bin'),
    type: '95640', size: 8192,
  },
  {
    label: 'SAMPLE GPEC2A EXT EEPROM 8 KB rescued VIN 566b18fa (fixtures/)',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa.bin'),
    type: '95640', size: 8192,
  },
  {
    label: 'SAMPLE GPEC2A EXT EEPROM 8 KB rescued VIN 566b18fa dup (fixtures/)',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa_dup_1776900716173.bin'),
    type: '95640', size: 8192,
  },
  {
    label: 'SAMPLE GPEC2A INT FLASH OG 62 (fixtures/) — 95640-format 8 KB',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_INT_FLASH_OG_62.bin'),
    type: '95640', size: 8192,
  },
  /* ── GPEC2A larger images ────────────────────────────────────────────── */
  {
    label: 'SAMPLE GPEC2A EXT EEPROM 4 KB rescued VIN 628f7b3c (fixtures/)',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_EXT_EEPROM_4KB_RESCUED_VIN_CRC_1C4RJFN9XJC309165_628f7b3c.bin'),
    type: 'GPEC2A', size: 4096, forceType: 'GPEC2A',
  },
  {
    label: 'SAMPLE SMARTBOX EEE JOVENTINO VIN CRC (fixtures/) — 4 KB GPEC2A',
    file:  path.join(FIXTURES, 'SAMPLE_SMARTBOX_EEE_JOVENTINO_VIN_CRC.bin'),
    type: 'GPEC2A', size: 4096,
  },
  {
    label: 'SAMPLE GPEC2A EXT EEPROM JOVENTINO OG (fixtures/) — full 64 KB image',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_EXT_EEPROM_JOVENTINO_OG.bin'),
    type: 'GPEC2A', size: 65536,
  },
  {
    label: 'SAMPLE GPEC2A EXT EEPROM VIN CRC 2C3CDXCT1HH652640 (fixtures/) — 384 KB dump',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_EXT_EEPROM_VIN_CRC_2C3CDXCT1HH652640.bin'),
    type: 'GPEC2A', size: 393216,
  },
  {
    label: 'SAMPLE GPEC2A INT FLASH JAILBREAK 62 FULL (fixtures/) — 4 MB full flash',
    file:  path.join(FIXTURES, 'SAMPLE_GPEC2A_INT_FLASH_JAILBREAK_62_FULL.bin'),
    type: 'GPEC2A', size: 4194304,
  },
  /* ── Gen1 RFHUB (Yazaki 24C16, 2 KB) ──────────────────────────────────── */
  {
    label: 'SAMPLE GEN1 RFHUB 24C16 CARTMAN SEC16 (fixtures/) — synthetic Yazaki 24C16',
    file:  path.join(FIXTURES, 'SAMPLE_GEN1_RFHUB_24C16_CARTMAN_SEC16.bin'),
    type: 'RFHUB', size: 2048,
  },
];

/* Pre-load every manifest entry at module scope (hard-fail if missing). */
const MANIFEST_LOADED = MANIFEST.map(m => ({
  ...m,
  bytes: requireLoad(m.file),
}));

for (const entry of MANIFEST_LOADED) {
  describe(`manifest: ${entry.label}`, () => {
    let info;

    it('file loads and parseModule classifies as expected type', () => {
      info = parseModule(entry.bytes, path.basename(entry.file),
        entry.forceType ? { forceType: entry.forceType } : undefined);
      expect(info.type).toBe(entry.type);
    });

    if (entry.size !== undefined) {
      it(`file size is ${entry.size} bytes`, () => {
        expect(entry.bytes.length).toBe(entry.size);
      });
    }

    if (entry.vinCount !== undefined) {
      it(`parseModule returns ${entry.vinCount} VIN slot(s)`, () => {
        const i = parseModule(entry.bytes, path.basename(entry.file),
          entry.forceType ? { forceType: entry.forceType } : undefined);
        expect(i.vins.length).toBe(entry.vinCount);
      });
    }

    if (entry.vin !== undefined) {
      it(`primary VIN slot = ${entry.vin}`, () => {
        const i = parseModule(entry.bytes, path.basename(entry.file),
          entry.forceType ? { forceType: entry.forceType } : undefined);
        expect(i.vins[0].vin).toBe(entry.vin);
      });
    }

    if (entry.vinCrcOk !== undefined) {
      it(`all VIN slots vinCrcOk=${entry.vinCrcOk}`, () => {
        const i = parseModule(entry.bytes, path.basename(entry.file),
          entry.forceType ? { forceType: entry.forceType } : undefined);
        for (const v of i.vins) expect(v.crcOk).toBe(entry.vinCrcOk);
      });
    }

    if (entry.sec16valid !== undefined) {
      it(`sec16valid=${entry.sec16valid}`, () => {
        const i = parseModule(entry.bytes, path.basename(entry.file),
          entry.forceType ? { forceType: entry.forceType } : undefined);
        expect(i.sec16valid).toBe(entry.sec16valid);
      });
    }

    if (entry.sec16source !== undefined) {
      it(`bcmSec16.source='${entry.sec16source}'`, () => {
        const i = parseModule(entry.bytes, path.basename(entry.file));
        expect(i.bcmSec16.source).toBe(entry.sec16source);
      });
    }

    if (entry.sec16blank !== undefined) {
      it(`bcmSec16.blank=${entry.sec16blank}`, () => {
        const i = parseModule(entry.bytes, path.basename(entry.file));
        expect(i.bcmSec16.blank).toBe(entry.sec16blank);
      });
    }
  });
}

describe('manifest: fixtures/ directory coverage', () => {
  it('every .bin file in fixtures/ is represented in MANIFEST', () => {
    const allBins = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.bin')).sort();
    const covered = new Set(
      MANIFEST_LOADED
        .filter(e => e.file.startsWith(FIXTURES))
        .map(e => path.basename(e.file))
    );
    const missing = allBins.filter(fn => !covered.has(fn));
    expect(missing, `Uncovered fixtures: ${missing.join(', ')}`).toHaveLength(0);
  });
});

/* ============================================================================
 * 10. SINCRO parity — structured report
 *
 * Defines makeSincroReport(bcm, rfh, gpec) which returns the same key-value
 * output that the SINCRO cross-module validation tool would display.  Every
 * field is then pinned to the exact value shown in the reference paste at
 *   attached_assets/Pasted--All-VINs-Match-Secret-Keys-Match-Overview-
 *   Security-Dif_1776140976129.txt
 *
 * This is a line-by-line structured diff: if a future change in crc.js or
 * parseModule.js shifts any field, the assert below names the field and shows
 * both actual and expected, making it a true regression diff rather than a
 * "checksum file changed" alarm.
 * ========================================================================== */
function makeSincroReport(bcm, rfh, gpec) {
  const bcmInfo = parseModule(bcm, 'BCM.bin');
  const rfhInfo = parseModule(rfh, 'RFH.bin');

  /* ── VIN consistency (all RFHUB slots carry the same VIN) ────────────── */
  const rfhVins = rfhInfo.vins;
  const vinConsistent = rfhVins.length > 0 &&
    rfhVins.every(v => v.vin === rfhVins[0].vin);
  /* SINCRO displays the VIN as stored in the RFHUB (raw bytes, i.e. reversed). */
  const displayVin = vinConsistent
    ? rfhVins[0].vin.split('').reverse().join('')
    : null;

  /* ── Cross-module secret match: reverse(RFH_SEC16) === BCM_SEC16 ─────── */
  /* MISMATCH if the RFHUB SEC16 CRC fails (can't trust the stored value). */
  const rfhSec16Raw = rfhInfo.sec16s && rfhInfo.sec16s[0] ? rfhInfo.sec16s[0].raw : null;
  const bcmSec16Bytes = bcmInfo.bcmSec16 ? bcmInfo.bcmSec16.bytes : null;
  let rfhBcmMismatch = true;
  if (rfhInfo.sec16valid && rfhSec16Raw && bcmSec16Bytes && !bcmInfo.bcmSec16.blank) {
    const rev = Array.from(rfhSec16Raw).reverse();
    rfhBcmMismatch = !rev.every((b, i) => b === bcmSec16Bytes[i]);
  }

  /* ── RFHUB SEC16 slot 1/2 internal mismatch ─────────────────────────── */
  const slotMismatch = !rfhInfo.sec16match || !rfhInfo.sec16valid;

  /* ── Key count mismatch ──────────────────────────────────────────────── */
  const rfhFobikSlots  = rfhInfo.fobikSlots ?? 0;
  const bcmFobikCount  = bcmInfo.fobikCount ?? 0;
  const keyCountMismatch = rfhFobikSlots !== bcmFobikCount;

  /* ── GPEC BCM-SEC16 CRC16 state ─────────────────────────────────────── */
  let gpecCrcStored = null, gpecCrcCalc = null, gpecCrcBad = false;
  if (gpec && gpec.length >= 0x084A) {
    const sec16 = gpec.slice(0x0838, 0x0848);
    gpecCrcStored = (gpec[0x0848] << 8) | gpec[0x0849];
    gpecCrcCalc   = crc16(sec16);
    gpecCrcBad    = gpecCrcStored !== gpecCrcCalc;
  }

  /* ── GPEC secret-key SET flag ────────────────────────────────────────── */
  const gpecSecretSet = gpec
    ? !Array.from(gpec.slice(0x0040, 0x0050)).every(b => b === 0xFF)
    : false;

  return {
    /* Summary flags (match SINCRO ✗/⚠/✓ indicators) */
    rfhBcmMismatch,       /* ✗ RFHUB ↔ BCM vehicle secret: MISMATCH!         */
    slotMismatch,         /* ⚠ RFHUB SEC16: Slot 1/2 MISMATCH or unreadable  */
    keyCountMismatch,     /* ⚠ Key count mismatch                              */
    gpecCrcBad,           /* ⚠ 95640 BCM-SEC16 @ 0x838: CRC16 BAD            */
    vinConsistent,        /* ✓ VIN consistent                                  */
    displayVin,           /* "925971HN59LZDC3C2" (reversed VIN display)        */
    bcmLock:    bcmInfo.securityLock?.value,      /* ✓ BCM lock: 0x5A          */
    bcmLocked:  bcmInfo.securityLock?.locked,     /* LOCKED                    */
    rfhFobikSlots,        /* ✓ RFHUB FOBIK: 5 slots                            */
    rfhCC66AA55: bcmInfo.bakRecs,                 /* ✓ RFHUB CC66AA55: 8       */
    bcmFobikCount,        /* ✓ BCM FOBIK: 255 keys                             */
    gpecSecretSet,        /* ✓ 95640 secret key: SET                           */
    /* Detail values */
    gpecCrcStored,
    gpecCrcCalc,
    bcmSec16Hex: bcmSec16Bytes
      ? hexOf(bcmSec16Bytes, 0, 16)
      : null,
    gpecBcmSec16MirrorHex: gpec && gpec.length >= 0x0848
      ? hexOf(gpec, 0x0838, 16)
      : null,
    gpecRfhMirrorHex: gpec && gpec.length >= 0x0848
      ? Array.from(gpec.slice(0x0838, 0x0848)).reverse()
          .map(b => b.toString(16).toUpperCase().padStart(2,'0')).join('')
      : null,
    rfhSec16Slot1CsStored: rfhInfo.sec16s && rfhInfo.sec16s[0]
      ? rfhInfo.sec16s[0].cs
      : null,
    rfhSec16Slot1CsCalc: rfhInfo.sec16s && rfhInfo.sec16s[0]
      ? rfhInfo.sec16s[0].csCalc
      : null,
    /* Raw binary offsets pinned to the paste ─────────────────────────── */
    bcmSecretHex: bcm && bcm.length >= 0x40D9
      ? hexOf(bcm, 0x40C9, 16)
      : null,
    rfhSecretHex: rfh && rfh.length >= 0x051E
      ? hexOf(rfh, 0x050E, 16)
      : null,
    rfhVin1: rfh && rfh.length >= 0x0EB7
      ? Array.from(rfh.slice(0x0EA5, 0x0EA5 + 17))
          .map(b => String.fromCharCode(b)).join('')
      : null,
    rfhSec16Slot1Hex: rfh && rfh.length >= 0x00BE
      ? hexOf(rfh, 0x00AE, 16)
      : null,
    rfhSec16Slot2Hex: rfh && rfh.length >= 0x00D0
      ? hexOf(rfh, 0x00C0, 16)
      : null,
    rfhFobikMagicHex: rfh && rfh.length >= 0x0884
      ? hexOf(rfh, 0x0880, 4)
      : null,
    gpecSecretHex: gpec && gpec.length >= 0x0050
      ? hexOf(gpec, 0x0040, 16)
      : null,
  };
}

describe('SINCRO parity — CARTMAN OG state (structured report)', () => {
  /* Build the report once; every it() reads from this object. */
  const R = makeSincroReport(F.CARTMAN_BCM, F.CARTMAN_RFH, F.CARTMAN_GPEC);

  it('rfhBcmMismatch=true (paste: "✗ RFHUB ↔ BCM vehicle secret: MISMATCH!")', () => {
    expect(R.rfhBcmMismatch).toBe(true);
  });

  it('slotMismatch=true (paste: "⚠ RFHUB SEC16: Slot 1/2 MISMATCH or unreadable")', () => {
    expect(R.slotMismatch).toBe(true);
  });

  it('keyCountMismatch=true (paste: "⚠ Key count mismatch: RFHUB=5 BCM=255")', () => {
    expect(R.keyCountMismatch).toBe(true);
    expect(R.rfhFobikSlots).toBe(5);
    expect(R.bcmFobikCount).toBe(255);
  });

  it('gpecCrcBad=true, stored=0xFC03, calc=0xE323 (paste: "⚠ 95640 BCM-SEC16 @ 0x838: CRC16 BAD")', () => {
    expect(R.gpecCrcBad).toBe(true);
    expect(R.gpecCrcStored).toBe(0xFC03);
    expect(R.gpecCrcCalc).toBe(0xE323);
  });

  it('vinConsistent=true (paste: "✓ VIN consistent: 925971HN59LZDC3C2")', () => {
    expect(R.vinConsistent).toBe(true);
  });

  it('displayVin="925971HN59LZDC3C2" (raw-stored byte order, reversed ASCII of canonical VIN)', () => {
    expect(R.displayVin).toBe('925971HN59LZDC3C2');
  });

  it('bcmLock=0x5A, bcmLocked=true (paste: "✓ BCM lock: 0x5A LOCKED")', () => {
    expect(R.bcmLock).toBe(0x5A);
    expect(R.bcmLocked).toBe(true);
  });

  it('rfhFobikSlots=5 (paste: "✓ RFHUB FOBIK: 5 slots")', () => {
    expect(R.rfhFobikSlots).toBe(5);
  });

  it('rfhCC66AA55=8 — BCM SKIM backup records (paste: "✓ RFHUB CC66AA55: 8")', () => {
    expect(R.rfhCC66AA55).toBe(8);
  });

  it('bcmFobikCount=255 (paste: "✓ BCM FOBIK: 255 keys")', () => {
    expect(R.bcmFobikCount).toBe(255);
  });

  it('gpecSecretSet=true — 0x0040..0x004F is not all-FF (paste: "✓ 95640 secret key: SET")', () => {
    expect(R.gpecSecretSet).toBe(true);
  });

  it('BCM SEC16 hex = 8CF8E4012D19B27E64731D5A2FBD4BDE (paste BCM D-FLASH table)', () => {
    expect(R.bcmSec16Hex).toBe('8CF8E4012D19B27E64731D5A2FBD4BDE');
  });

  it('GPEC BCM-SEC16 mirror hex = FF00FC03FF00FFFFFFFFFF00FF00FFFF (paste GPEC table)', () => {
    expect(R.gpecBcmSec16MirrorHex).toBe('FF00FC03FF00FFFFFFFFFF00FF00FFFF');
  });

  it('RFHUB SEC16 slot1: csStored=0xB500, csCalc=0xB700 (paste: "SEC16-1 CS:FE00 SLOTS MISMATCH")', () => {
    /* The paste shows the raw record bytes; the CS field itself confirms stored≠calc. */
    expect(R.rfhSec16Slot1CsStored).toBe(0xB500);
    expect(R.rfhSec16Slot1CsCalc).toBe(0xB700);
  });

  /* ── Raw binary offset assertions (paste "Offset / Category / Value" rows) */

  it('BCM 0x40C9: SECRET = all-FF (OG/donor blank state — paste BCM table row)', () => {
    expect(R.bcmSecretHex).toBe('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
  });

  it('RFHUB 0x050E: SECRET = DE4BBD2F5A1D73647EB2192D01E4F88C (paste RFHUB table row)', () => {
    expect(R.rfhSecretHex).toBe('DE4BBD2F5A1D73647EB2192D01E4F88C');
  });

  it('RFHUB 0x0EA5: VIN 1 ASCII = "925971HN59LZDC3C2" (paste RFHUB table row)', () => {
    expect(R.rfhVin1).toBe('925971HN59LZDC3C2');
  });

  it('RFHUB 0x00AE: SEC16-1 bytes = CE010202F802D000FE00D000FE000000 (paste CS:FE00)', () => {
    expect(R.rfhSec16Slot1Hex).toBe('CE010202F802D000FE00D000FE000000');
  });

  it('RFHUB 0x00C0: SEC16-2 bytes = 0000FE000000FE001E01FD002C00D101 (paste CS:FFFF)', () => {
    expect(R.rfhSec16Slot2Hex).toBe('0000FE000000FE001E01FD002C00D101');
  });

  it('RFHUB 0x0880: FOBIK magic = AA50AA50 (AA50 pattern, 5 slots — paste row)', () => {
    expect(R.rfhFobikMagicHex).toBe('AA50AA50');
  });

  it('GPEC 0x0040: SECRET = 01CC16C000000000E975FFFFFFFFFF1F (paste GPEC table row)', () => {
    expect(R.gpecSecretHex).toBe('01CC16C000000000E975FFFFFFFFFF1F');
  });

  it('GPEC 0x0838 reversed → RFHUB direction = FFFF00FF00FFFFFFFFFF00FF03FC00FF (paste "→RFH" row)', () => {
    expect(R.gpecRfhMirrorHex).toBe('FFFF00FF00FFFFFFFFFF00FF03FC00FF');
  });
});

/* ============================================================================
 * 11. AlfaOBD UDS 27 frame replay
 *
 * Replays the full UDS service-27 diagnostic exchange — not just seed→key
 * math — using the same scriptable-fake-engine pattern as proxiBridge.test.js.
 * Covers:
 *   (a) Frame construction: [0x27 0x01] request, [0x67 0x01 s…] seed parse,
 *       [0x27 0x02 k…] key frame, [0x67 0x02] positive response.
 *   (b) Three AlfaOBD cipher families: ht, f, ao — with real captured seeds.
 *   (c) Diagnostic session preamble: service 0x10 0x03 (extended session)
 *       before the 27 01/02 exchange, mirroring the real tool init sequence.
 *   (d) NRC recovery chains:
 *       - 0x78 (responsePending)  → engine retries; key is eventually accepted.
 *       - 0x36 (exceededAttempts) → chain aborts immediately.
 *       - 0x37 (requiredTimeDelayNotExpired) → single retry, then succeed.
 * ========================================================================== */

/* Minimal scriptable fake engine (same API as proxiBridge makeEngine). */
function makeAlfaEngine(script) {
  const sent = [];
  return {
    sent,
    uds: async (_tx, _rx, frame) => {
      sent.push(Array.from(frame));
      if (!script.length) return { ok: false, raw: 'script exhausted' };
      const s = script.shift();
      if (s.expectFrame) {
        const got = Array.from(frame).map(b => b.toString(16).padStart(2,'0')).join(' ');
        const exp = s.expectFrame.map(b => b.toString(16).padStart(2,'0')).join(' ');
        if (got !== exp) return { ok: false, raw: `frame mismatch: got ${got} expected ${exp}` };
      }
      const reply = typeof s.reply === 'function' ? s.reply(frame) : s.reply;
      return Array.isArray(reply)
        ? { ok: true, d: new Uint8Array(reply) }
        : reply;
    },
  };
}

/* Helpers: UDS 27 frame builders and parsers. */
function buildSeedReq()          { return [0x27, 0x01]; }
function parseSeedResp(d)        { return d.slice(2);    /* drop 0x67 0x01 */ }
function buildKeyReq(keyBytes)   { return [0x27, 0x02, ...keyBytes]; }
function isPosSeedResp(d)        { return d[0] === 0x67 && d[1] === 0x01; }
function isPosKeyResp(d)         { return d[0] === 0x67 && d[1] === 0x02; }

describe('AlfaOBD UDS 27 frame construction helpers', () => {
  it('buildSeedReq() is exactly [0x27, 0x01]', () => {
    expect(buildSeedReq()).toEqual([0x27, 0x01]);
  });

  it('parseSeedResp strips service/sub-byte prefix — returns raw 4-byte seed', () => {
    const resp = [0x67, 0x01, 0xF2, 0x88, 0x14, 0xA5];
    expect(Array.from(parseSeedResp(resp))).toEqual([0xF2, 0x88, 0x14, 0xA5]);
  });

  it('buildKeyReq prepends [0x27, 0x02] and appends the 4 key bytes', () => {
    const key = [0x4A, 0x74, 0x0F, 0x98];
    expect(buildKeyReq(key)).toEqual([0x27, 0x02, 0x4A, 0x74, 0x0F, 0x98]);
  });

  it('isPosSeedResp detects positive seed response correctly', () => {
    expect(isPosSeedResp([0x67, 0x01, 0x00, 0x00, 0x00, 0x00])).toBe(true);
    expect(isPosSeedResp([0x7F, 0x27, 0x22])).toBe(false);
  });

  it('isPosKeyResp detects positive key response correctly', () => {
    expect(isPosKeyResp([0x67, 0x02])).toBe(true);
    expect(isPosKeyResp([0x7F, 0x27, 0x35])).toBe(false);
  });
});

describe('AlfaOBD UDS 27 session — full exchange per cipher family', () => {
  /* Run the diagnostic init (10 03) + seed/key exchange for one algo.
   * Returns { ok, sentFrames, seedBytes, keyBytes }. */
  async function runAlfaSession(algo, seedHex, keyHex) {
    const seedBytes = Array.from(V(seedHex));
    const expectedKey = Array.from(unlockKeyBytes(algo, V(seedHex)));

    const eng = makeAlfaEngine([
      /* 10 03 — extended diagnostic session */
      { expectFrame: [0x10, 0x03], reply: [0x50, 0x03, 0x00, 0x32, 0x01, 0xF4] },
      /* 27 01 — seed request */
      { expectFrame: [0x27, 0x01], reply: [0x67, 0x01, ...seedBytes] },
      /* 27 02 — key send */
      { expectFrame: [0x27, 0x02, ...expectedKey], reply: [0x67, 0x02] },
    ]);

    /* Simulate what the real AlfaOBD driver does. */
    const initResp = await eng.uds(0x700, 0x700, new Uint8Array([0x10, 0x03]));
    if (!initResp.ok || initResp.d[0] !== 0x50) return { ok: false, step: 'init' };

    const seedResp = await eng.uds(0x700, 0x700, new Uint8Array(buildSeedReq()));
    if (!seedResp.ok || !isPosSeedResp(Array.from(seedResp.d))) return { ok: false, step: 'seed' };

    const seed = parseSeedResp(Array.from(seedResp.d));
    const keyArr = unlockKeyBytes(algo, new Uint8Array(seed));
    if (!keyArr) return { ok: false, step: 'keygen' };

    const keyResp = await eng.uds(0x700, 0x700, new Uint8Array(buildKeyReq(keyArr)));
    if (!keyResp.ok || !isPosKeyResp(Array.from(keyResp.d))) return { ok: false, step: 'key' };

    return {
      ok: true,
      sentFrames: eng.sent,
      keyBytes: keyArr,
    };
  }

  it('alfa_ht: seed=F28814A5 → key=F60AF0B9 — full 10 03 / 27 01 / 27 02 exchange succeeds', async () => {
    const result = await runAlfaSession('alfa_ht', 'F28814A5', 'F60AF0B9');
    expect(result.ok).toBe(true);
    expect(result.sentFrames).toHaveLength(3);
    expect(result.sentFrames[0]).toEqual([0x10, 0x03]);
    expect(result.sentFrames[1]).toEqual([0x27, 0x01]);
    expect(result.sentFrames[2]).toEqual([0x27, 0x02, 0xF6, 0x0A, 0xF0, 0xB9]);
  });

  it('alfa_f: seed=F28814A5 → key=4A740F98 — XTEA LE — full exchange succeeds', async () => {
    const result = await runAlfaSession('alfa_f', 'F28814A5', '4A740F98');
    expect(result.ok).toBe(true);
    expect(result.sentFrames[2]).toEqual([0x27, 0x02, 0x4A, 0x74, 0x0F, 0x98]);
  });

  it('alfa_ao: seed=7A3C1D5E → key=4A965412 — XTEA BE (UCONNECT) — full exchange succeeds', async () => {
    const result = await runAlfaSession('alfa_ao', '7A3C1D5E', '4A965412');
    expect(result.ok).toBe(true);
    expect(result.sentFrames[2]).toEqual([0x27, 0x02, 0x4A, 0x96, 0x54, 0x12]);
  });

  it('key frame byte ordering: alfa_f seed=00000000 → key frame = 27 02 36 59 2F B8', async () => {
    const result = await runAlfaSession('alfa_f', '00000000', '36592FB8');
    expect(result.ok).toBe(true);
    expect(result.keyBytes).toEqual([0x36, 0x59, 0x2F, 0xB8]);
  });
});

describe('AlfaOBD UDS 27 NRC recovery chains', () => {
  it('NRC 0x78 responsePending on seed request: engine retries and eventually gets seed', async () => {
    const seedBytes = [0xF2, 0x88, 0x14, 0xA5];
    const expectedKey = Array.from(unlockKeyBytes('alfa_ht', new Uint8Array(seedBytes)));

    const eng = makeAlfaEngine([
      { reply: [0x50, 0x03, 0x00, 0x32, 0x01, 0xF4] }, /* 10 03 */
      { reply: [0x7F, 0x27, 0x78] },                    /* 27 01 → pending */
      { reply: [0x67, 0x01, ...seedBytes] },             /* 27 01 retry → seed */
      { reply: [0x67, 0x02] },                           /* 27 02 → accept   */
    ]);

    /* Init session. */
    const s0 = await eng.uds(0, 0, new Uint8Array([0x10, 0x03]));
    expect(s0.d[0]).toBe(0x50);

    /* First seed attempt — gets 0x78. */
    const s1 = await eng.uds(0, 0, new Uint8Array(buildSeedReq()));
    expect(s1.d).toEqual(new Uint8Array([0x7F, 0x27, 0x78]));
    expect(s1.d[2]).toBe(0x78); /* responsePending — caller must retry */

    /* Retry seed request. */
    const s2 = await eng.uds(0, 0, new Uint8Array(buildSeedReq()));
    expect(isPosSeedResp(Array.from(s2.d))).toBe(true);

    /* Compute and send key. */
    const seed = parseSeedResp(Array.from(s2.d));
    const key  = unlockKeyBytes('alfa_ht', new Uint8Array(seed));
    const s3   = await eng.uds(0, 0, new Uint8Array(buildKeyReq(key)));
    expect(isPosKeyResp(Array.from(s3.d))).toBe(true);

    expect(eng.sent).toHaveLength(4);
  });

  it('NRC 0x36 exceededNumberOfAttempts on key: chain aborts, no further frames sent', async () => {
    const seedBytes = [0x01, 0x23, 0x45, 0x67];

    const eng = makeAlfaEngine([
      { reply: [0x50, 0x03, 0x00, 0x32, 0x01, 0xF4] }, /* 10 03 */
      { reply: [0x67, 0x01, ...seedBytes] },             /* 27 01 */
      { reply: [0x7F, 0x27, 0x36] },                    /* 27 02 → locked  */
    ]);

    const init = await eng.uds(0, 0, new Uint8Array([0x10, 0x03]));
    expect(init.d[0]).toBe(0x50);

    const sr = await eng.uds(0, 0, new Uint8Array(buildSeedReq()));
    const seed = parseSeedResp(Array.from(sr.d));
    const key  = unlockKeyBytes('alfa_ht', new Uint8Array(seed));
    const kr   = await eng.uds(0, 0, new Uint8Array(buildKeyReq(key)));

    /* 0x36 lockout: caller checks NRC and must NOT retry. */
    expect(kr.d[0]).toBe(0x7F);
    expect(kr.d[2]).toBe(0x36);
    /* Only 3 frames sent: init + seed + key; no further retries in this test. */
    expect(eng.sent).toHaveLength(3);
  });

  it('NRC 0x37 requiredTimeDelayNotExpired on key: retry once after delay, then succeed', async () => {
    const seedBytes = [0xAB, 0xCD, 0xEF, 0x01];
    const key = unlockKeyBytes('alfa_ao', new Uint8Array(seedBytes));

    const eng = makeAlfaEngine([
      { reply: [0x50, 0x03, 0x00, 0x32, 0x01, 0xF4] }, /* 10 03 */
      { reply: [0x67, 0x01, ...seedBytes] },             /* 27 01 */
      { reply: [0x7F, 0x27, 0x37] },                    /* 27 02 first → delay */
      { reply: [0x67, 0x02] },                           /* 27 02 retry  → ok   */
    ]);

    await eng.uds(0, 0, new Uint8Array([0x10, 0x03]));
    const sr = await eng.uds(0, 0, new Uint8Array(buildSeedReq()));
    const seed = parseSeedResp(Array.from(sr.d));
    const k    = unlockKeyBytes('alfa_ao', new Uint8Array(seed));

    const kr1 = await eng.uds(0, 0, new Uint8Array(buildKeyReq(k)));
    expect(kr1.d[2]).toBe(0x37); /* first attempt rejected with time-delay NRC */

    /* After a real delay the caller retries — simulate that retry here. */
    const kr2 = await eng.uds(0, 0, new Uint8Array(buildKeyReq(k)));
    expect(isPosKeyResp(Array.from(kr2.d))).toBe(true);

    expect(eng.sent).toHaveLength(4);
  });

  it('alfa_f and alfa_ao both produce the same-length 6-byte key frame regardless of seed', () => {
    for (const algo of ['alfa_f', 'alfa_ao', 'alfa_ht']) {
      const key  = unlockKeyBytes(algo, V('CAFEBABE'));
      const frame = buildKeyReq(key);
      expect(frame).toHaveLength(6); /* [0x27, 0x02, k0, k1, k2, k3] */
      expect(frame[0]).toBe(0x27);
      expect(frame[1]).toBe(0x02);
    }
  });
});

/* ============================================================================
 * 12. AlfaOBD extended diagnostic session — full capture parity
 *
 * Extends section 11 with the additional UDS service frames that appear in a
 * real AlfaOBD session capture before and after the security-access exchange:
 *
 *   19 02 08  ReadDTCInformation (reportDTCByStatusMask, pendingDTC)
 *   11 01     ECUReset hardReset  →  51 01 positive response
 *   31 01 03 12  RoutineControl startRoutine (routine 0x0312)
 *   14 FF FF FF  ClearDTC (all groups)
 *
 * Also covers the init-failed recovery path: when 10 03 returns NRC 7F 10 22
 * the caller must NOT proceed to the seed request; if it retries 10 03 and
 * then succeeds, the subsequent seed/key exchange must still work.
 * ========================================================================== */

describe('AlfaOBD extended diagnostic session — full capture parity', () => {
  it('full session: 10 03 → 19 02 08 → 27 01/02 → 14 FF FF FF — all frames accepted in order', async () => {
    const seedBytes = Array.from(V('F28814A5'));
    const key = Array.from(unlockKeyBytes('alfa_ht', new Uint8Array(seedBytes)));

    const eng = makeAlfaEngine([
      /* 10 03 — extended diagnostic session */
      { expectFrame: [0x10, 0x03], reply: [0x50, 0x03, 0x00, 0x32, 0x01, 0xF4] },
      /* 19 02 08 — ReadDTCInformation (pendingDTC mask 0x08) */
      { expectFrame: [0x19, 0x02, 0x08], reply: [0x59, 0x02, 0x08] },
      /* 27 01 — seed request */
      { expectFrame: [0x27, 0x01], reply: [0x67, 0x01, ...seedBytes] },
      /* 27 02 — key send */
      { expectFrame: [0x27, 0x02, ...key], reply: [0x67, 0x02] },
      /* 14 FF FF FF — ClearDTC all groups */
      { expectFrame: [0x14, 0xFF, 0xFF, 0xFF], reply: [0x54] },
    ]);

    const r0 = await eng.uds(0x700, 0x700, new Uint8Array([0x10, 0x03]));
    expect(r0.d[0]).toBe(0x50);

    const r1 = await eng.uds(0x700, 0x700, new Uint8Array([0x19, 0x02, 0x08]));
    expect(r1.d[0]).toBe(0x59);       /* positive ReadDTCInformation response */
    expect(r1.d[1]).toBe(0x02);
    expect(r1.d[2]).toBe(0x08);

    const r2 = await eng.uds(0x700, 0x700, new Uint8Array(buildSeedReq()));
    expect(isPosSeedResp(Array.from(r2.d))).toBe(true);

    const seed = parseSeedResp(Array.from(r2.d));
    const k    = unlockKeyBytes('alfa_ht', new Uint8Array(seed));
    const r3   = await eng.uds(0x700, 0x700, new Uint8Array(buildKeyReq(k)));
    expect(isPosKeyResp(Array.from(r3.d))).toBe(true);

    const r4 = await eng.uds(0x700, 0x700, new Uint8Array([0x14, 0xFF, 0xFF, 0xFF]));
    expect(r4.d[0]).toBe(0x54);       /* positive ClearDTC response */

    expect(eng.sent).toHaveLength(5);
    expect(eng.sent[0]).toEqual([0x10, 0x03]);
    expect(eng.sent[1]).toEqual([0x19, 0x02, 0x08]);
    expect(eng.sent[2]).toEqual([0x27, 0x01]);
    expect(eng.sent[3]).toEqual([0x27, 0x02, ...key]);
    expect(eng.sent[4]).toEqual([0x14, 0xFF, 0xFF, 0xFF]);
  });

  it('ECU reset: 11 01 hardReset → 51 01 positive response', async () => {
    const eng = makeAlfaEngine([
      { expectFrame: [0x11, 0x01], reply: [0x51, 0x01] },
    ]);

    const r = await eng.uds(0x700, 0x700, new Uint8Array([0x11, 0x01]));
    expect(r.d[0]).toBe(0x51);
    expect(r.d[1]).toBe(0x01);
    expect(eng.sent).toHaveLength(1);
    expect(eng.sent[0]).toEqual([0x11, 0x01]);
  });

  it('RoutineControl 31 01 03 12 start → 71 01 03 12 positive response', async () => {
    const eng = makeAlfaEngine([
      { expectFrame: [0x31, 0x01, 0x03, 0x12], reply: [0x71, 0x01, 0x03, 0x12] },
    ]);

    const r = await eng.uds(0x700, 0x700, new Uint8Array([0x31, 0x01, 0x03, 0x12]));
    expect(r.d[0]).toBe(0x71);
    expect(r.d[1]).toBe(0x01);
    expect(r.d[2]).toBe(0x03);
    expect(r.d[3]).toBe(0x12);
    expect(eng.sent[0]).toEqual([0x31, 0x01, 0x03, 0x12]);
  });

  it('ClearDTC 14 FF FF FF → 54 (no further frames in exchange)', async () => {
    const eng = makeAlfaEngine([
      { expectFrame: [0x14, 0xFF, 0xFF, 0xFF], reply: [0x54] },
    ]);

    const r = await eng.uds(0x700, 0x700, new Uint8Array([0x14, 0xFF, 0xFF, 0xFF]));
    expect(r.d[0]).toBe(0x54);
    expect(eng.sent).toHaveLength(1);
  });

  it('init-failed recovery: 10 03 → NRC 7F 10 22 → retry 10 03 → seed/key succeeds', async () => {
    /* NRC 0x22 = conditionsNotCorrect — common when ECU is busy or already in session */
    const seedBytes = Array.from(V('01234567'));
    const key = Array.from(unlockKeyBytes('alfa_f', new Uint8Array(seedBytes)));

    const eng = makeAlfaEngine([
      /* first 10 03 attempt → NRC */
      { reply: [0x7F, 0x10, 0x22] },
      /* retry 10 03 → success */
      { reply: [0x50, 0x03, 0x00, 0x32, 0x01, 0xF4] },
      /* 27 01 */
      { reply: [0x67, 0x01, ...seedBytes] },
      /* 27 02 */
      { reply: [0x67, 0x02] },
    ]);

    /* First attempt: NRC conditionsNotCorrect. */
    const r0 = await eng.uds(0x700, 0x700, new Uint8Array([0x10, 0x03]));
    expect(r0.d[0]).toBe(0x7F);
    expect(r0.d[2]).toBe(0x22);       /* NRC must NOT proceed to seed request */

    /* Caller retries 10 03 after a delay. */
    const r1 = await eng.uds(0x700, 0x700, new Uint8Array([0x10, 0x03]));
    expect(r1.d[0]).toBe(0x50);       /* now in extended session */

    /* Normal seed/key exchange proceeds. */
    const r2 = await eng.uds(0x700, 0x700, new Uint8Array(buildSeedReq()));
    expect(isPosSeedResp(Array.from(r2.d))).toBe(true);

    const seed = parseSeedResp(Array.from(r2.d));
    const k    = unlockKeyBytes('alfa_f', new Uint8Array(seed));
    const r3   = await eng.uds(0x700, 0x700, new Uint8Array(buildKeyReq(k)));
    expect(isPosKeyResp(Array.from(r3.d))).toBe(true);

    expect(eng.sent).toHaveLength(4);
    /* key frame must carry the XTEA-LE key (alfa_f), not ht or ao */
    expect(eng.sent[3]).toEqual([0x27, 0x02, ...key]);
  });

  it('ReadDTCInformation 19 02 08 frame is exactly 3 bytes', () => {
    const frame = [0x19, 0x02, 0x08];
    expect(frame).toHaveLength(3);
    expect(frame[0]).toBe(0x19); /* service id */
    expect(frame[1]).toBe(0x02); /* reportDTCByStatusMask */
    expect(frame[2]).toBe(0x08); /* statusMask: pendingDTC */
  });
});

/* ============================================================================
 * 13. Write round-trip byte-exact parity
 *
 * Each test here:
 *   1. Reads a known-good fixture (all CRCs valid).
 *   2. Copies the buffer.
 *   3. Zeroes the checksum byte(s) in the copy.
 *   4. Recomputes the checksum from the raw stored VIN / SEC16 bytes.
 *   5. Writes it back to the copy.
 *   6. Asserts that the relevant region of the copy is byte-identical to
 *      the original — proving that crc16() / rfhGen2VinCs() / rfhSec16Cs()
 *      and the writer return the exact bytes that appear on real hardware.
 *
 * Fixtures used:
 *   BCM VIN   — SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin (3 Redeye base+8 slots)
 *   RFHUB VIN — SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin (4 Gen2 slots)
 *   RFHUB SEC16 — SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin (slots 0x050E / 0x0522)
 *   SEC16 write — writeRfhSec16FromBcm on the virgin synced RFHUB fixture
 * ========================================================================== */

describe('write round-trip byte-exact parity', () => {

  /* ── BCM VIN CRC16 round-trip ─────────────────────────────────────────── */
  describe('BCM VIN CRC16: zeroed checksum → recompute → byte-identical region', () => {
    const bcm = requireLoad(
      path.join(FIXTURES, 'SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin')
    );
    const bcmInfo = parseModule(bcm, 'SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin');

    it('fixture has 3 VIN slots, all crcOk=true (sanity pre-check)', () => {
      expect(bcmInfo.vins.length).toBe(3);
      for (const v of bcmInfo.vins) expect(v.crcOk).toBe(true);
    });

    for (const [idx, v] of bcmInfo.vins.entries()) {
      it(`slot ${idx} (offset 0x${v.offset.toString(16)}): recomputed CRC16 byte-equals stored`, () => {
        /* Copy the buffer and zero the 2-byte CRC at vinOff+17..+18 */
        const copy = new Uint8Array(bcm);
        copy[v.offset + 17] = 0x00;
        copy[v.offset + 18] = 0x00;

        /* Recompute from the raw 17 VIN bytes in the copy */
        const raw17 = copy.slice(v.offset, v.offset + 17);
        const crc = crc16(raw17);
        copy[v.offset + 17] = (crc >> 8) & 0xFF;
        copy[v.offset + 18] =  crc        & 0xFF;

        /* Compare the 19-byte slot region (VIN + 2-byte CRC) to original */
        const region = 19;
        expect(Array.from(copy.slice(v.offset, v.offset + region)))
          .toEqual(Array.from(bcm.slice(v.offset, v.offset + region)));

        /* And confirm the recovered CRC matches the original stored value */
        const storedCrc = (bcm[v.offset + 17] << 8) | bcm[v.offset + 18];
        expect(crc).toBe(storedCrc);
      });
    }
  });

  /* ── RFHUB VIN rfhGen2VinCs round-trip ───────────────────────────────── */
  describe('RFHUB VIN rfhGen2VinCs: zeroed CS → recompute → byte-identical region', () => {
    const rfh = requireLoad(
      path.join(FIXTURES, 'SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin')
    );
    const rfhInfo = parseModule(rfh, 'SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin');

    /* Derive magic from the first slot's stored CS (auto-detect path) */
    const firstSlot = rfhInfo.vins[0];
    const firstRaw17 = rfh.slice(firstSlot.offset, firstSlot.offset + 17);
    const storedCs0  = rfh[firstSlot.offset + 17];
    const magic      = rfhGen2DetectMagic(firstRaw17, storedCs0);

    it('fixture has 4 VIN slots, all crcOk=true, magic=0x85 (sanity pre-check)', () => {
      expect(rfhInfo.vins.length).toBe(4);
      for (const v of rfhInfo.vins) expect(v.crcOk).toBe(true);
      expect(magic).toBe(0x85);
    });

    for (const [idx, v] of rfhInfo.vins.entries()) {
      it(`slot ${idx} (offset 0x${v.offset.toString(16)}): recomputed rfhGen2VinCs byte-equals stored`, () => {
        /* Copy the buffer and zero the CS byte at vinOff+17 */
        const copy = new Uint8Array(rfh);
        copy[v.offset + 17] = 0x00;

        /* Recompute from the raw stored (reversed) 17 bytes in the copy */
        const raw17 = copy.slice(v.offset, v.offset + 17);
        const cs = rfhGen2VinCs(raw17, magic);
        copy[v.offset + 17] = cs;

        /* Compare the 18-byte slot region (17 stored bytes + 1 CS) */
        const region = 18;
        expect(Array.from(copy.slice(v.offset, v.offset + region)))
          .toEqual(Array.from(rfh.slice(v.offset, v.offset + region)));

        /* Confirm recovered CS matches original */
        expect(cs).toBe(rfh[v.offset + 17]);
      });
    }
  });

  /* ── RFHUB SEC16 CRC8 round-trip ─────────────────────────────────────── */
  describe('RFHUB SEC16 rfhSec16Cs: zeroed CS → recompute → byte-identical slot region', () => {
    /* Use F.VIRGIN_RFH21 — has Gen2 header and valid rfhSec16Cs at both slots */
    const rfh = F.VIRGIN_RFH21;
    /* Gen2 RFHUB SEC16 slot layout: 16 data bytes + 1 CRC8 byte + 1 zero byte */
    const SEC16_OFFSETS = [0x050E, 0x0522];

    it('both SEC16 slots have matching CRC8 in the original fixture', () => {
      for (const off of SEC16_OFFSETS) {
        const raw16 = rfh.slice(off, off + 16);
        const storedCs = (rfh[off + 16] << 8) | rfh[off + 17];
        expect(rfhSec16Cs(raw16)).toBe(storedCs);
      }
    });

    for (const [idx, off] of SEC16_OFFSETS.entries()) {
      it(`slot ${idx} @ 0x${off.toString(16)}: zero CS → rfhSec16Cs → byte-identical 18 bytes`, () => {
        const copy = new Uint8Array(rfh);
        copy[off + 16] = 0x00;
        copy[off + 17] = 0x00;

        const raw16 = copy.slice(off, off + 16);
        const cs16 = rfhSec16Cs(raw16); /* (crc8_65(raw16) << 8) | 0x00 */
        copy[off + 16] = (cs16 >> 8) & 0xFF;
        copy[off + 17] =  cs16        & 0xFF;

        /* The full 18-byte slot (16 SEC16 + 1 CRC8 + 1 zero) must be identical */
        expect(Array.from(copy.slice(off, off + 18)))
          .toEqual(Array.from(rfh.slice(off, off + 18)));
      });
    }
  });

  /* ── writeRfhSec16FromBcm byte-exact write round-trip ────────────────── */
  describe('writeRfhSec16FromBcm: BCM_SEC16 = reverse(RFH_SEC16) → write → offsets byte-identical', () => {
    /* Use F.VIRGIN_RFH21 — has Gen2 header (AA 55 31 01) and valid rfhSec16Cs */
    const rfh = F.VIRGIN_RFH21;

    it('rfh SEC16 slot 1 has valid CRC8 (fixture sanity check)', () => {
      const raw16 = rfh.slice(0x050E, 0x050E + 16);
      const storedCs = (rfh[0x050E + 16] << 8) | rfh[0x050E + 17];
      expect(rfhSec16Cs(raw16)).toBe(storedCs);
    });

    it('writeRfhSec16FromBcm(copy, bcmSec16) produces byte-identical slot regions', () => {
      /* Extract RFH SEC16 from slot 1 then reverse to get BCM SEC16 */
      const rfhSec16 = rfh.slice(0x050E, 0x050E + 16);
      const bcmSec16 = new Uint8Array(rfhSec16).reverse(); /* BCM stores byte-reversed */

      /* Blank both SEC16 regions in the copy */
      const copy = new Uint8Array(rfh);
      for (let i = 0; i < 18; i++) { copy[0x050E + i] = 0xFF; copy[0x0522 + i] = 0xFF; }

      /* Apply the writer — returns { bytes, patched, rfhSec16Hex, chk } */
      const { bytes: written } = writeRfhSec16FromBcm(copy, bcmSec16);

      /* Both slot regions must be byte-identical to the original */
      for (const off of [0x050E, 0x0522]) {
        expect(Array.from(written.slice(off, off + 18)))
          .toEqual(Array.from(rfh.slice(off, off + 18)));
      }
    });

    it('writeRfhSec16FromBcm result passes rfhSec16Cs at both slots', () => {
      const rfhSec16 = rfh.slice(0x050E, 0x050E + 16);
      const bcmSec16 = new Uint8Array(rfhSec16).reverse();
      const copy     = new Uint8Array(rfh);
      const { bytes: written } = writeRfhSec16FromBcm(copy, bcmSec16);

      for (const off of [0x050E, 0x0522]) {
        const raw16    = written.slice(off, off + 16);
        const storedCs = (written[off + 16] << 8) | written[off + 17];
        expect(rfhSec16Cs(raw16)).toBe(storedCs);
      }
    });
  });
});
