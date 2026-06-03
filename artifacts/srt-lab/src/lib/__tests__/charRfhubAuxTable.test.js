import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHAR_AUX_BASE,
  CHAR_AUX_COUNT,
  CHAR_AUX_RECLEN,
  CHAR_AUX_STRIDE,
  CHAR_AUX_MIRROR_OFFSET,
  CHAR_AUX_END,
  CHAR_AUX_CHECKSUM_INDEX,
  CHAR_AUX_CHECKSUM_TARGET,
  isCharRfhubAuxTable,
  parseCharAuxTable,
  auxRecordChecksum,
  auxRecordChecksumOk,
  expectedAuxChecksumByte,
} from '../charRfhubAuxTable.js';

// Real 4 KB MPC Charger RFHUB dumps from 4 DISTINCT vehicles (distinct VINs /
// RFHUB masters / transponder-key counts). Synthetic buffers won't reproduce
// the real boundary, so the corpus is the source of truth (same pattern as
// charRfhubKeyTable.test.js).
const FIX = (n) => resolve(__dirname, '../../__tests__/fixtures', n);
const FILES = {
  og: 'SAMPLE_RFHUB_EEE_OG_2C3CDXCT1HH652640.bin',
  ch19: 'SAMPLE_RFHUB_EEE_19CHARGER62_KEYINDEX_0077A29B.bin',
  ch21: 'SAMPLE_RFHUB_EEE_21CHARGER62_KEYS_2C3CDZL95NH179529.bin',
  scat: 'SAMPLE_RFHUB_EEE_SCATPACK_KEYS_2C3CDXHG5EH219538.bin',
};
const load = (k) => new Uint8Array(readFileSync(FIX(FILES[k])));

describe('charRfhubAuxTable — constants', () => {
  it('table spans 0xCE6..0xE7E with 17 records of stride 24', () => {
    expect(CHAR_AUX_BASE).toBe(0x0CE6);
    expect(CHAR_AUX_COUNT).toBe(17);
    expect(CHAR_AUX_RECLEN).toBe(10);
    expect(CHAR_AUX_STRIDE).toBe(24);
    expect(CHAR_AUX_MIRROR_OFFSET).toBe(12);
    expect(CHAR_AUX_END).toBe(0x0E7E);
  });
});

describe('charRfhubAuxTable — structural gate', () => {
  for (const k of Object.keys(FILES)) {
    it(`accepts the real aux table in ${k}`, () => {
      expect(isCharRfhubAuxTable(load(k))).toBe(true);
    });
  }

  it('rejects a wrong-size buffer', () => {
    expect(isCharRfhubAuxTable(new Uint8Array(2048))).toBe(false);
    expect(isCharRfhubAuxTable(new Uint8Array(8192))).toBe(false);
  });

  it('rejects a non-Uint8Array / missing buffer', () => {
    expect(isCharRfhubAuxTable(null)).toBe(false);
    expect(isCharRfhubAuxTable(new ArrayBuffer(4096))).toBe(false);
  });

  it('rejects an all-zero 4 KB image (no mirror/separator structure)', () => {
    expect(isCharRfhubAuxTable(new Uint8Array(4096))).toBe(false);
  });

  it('refuses when a separator is corrupted', () => {
    const b = load('og');
    b[CHAR_AUX_BASE + CHAR_AUX_RECLEN] = 0x00; // break first inner FF FF
    expect(isCharRfhubAuxTable(b)).toBe(false);
    expect(parseCharAuxTable(b).ok).toBe(false);
  });

  it('refuses when a mirror does not match its record', () => {
    const b = load('og');
    b[CHAR_AUX_BASE + CHAR_AUX_MIRROR_OFFSET] ^= 0xFF; // flip a mirror byte
    expect(isCharRfhubAuxTable(b)).toBe(false);
    expect(parseCharAuxTable(b).ok).toBe(false);
  });
});

describe('charRfhubAuxTable — parse', () => {
  it('returns 17 mirror-verified records on every real dump', () => {
    for (const k of Object.keys(FILES)) {
      const p = parseCharAuxTable(load(k));
      expect(p.ok).toBe(true);
      expect(p.count).toBe(17);
      expect(p.records).toHaveLength(17);
      for (const r of p.records) {
        expect(r.mirrorOk).toBe(true);
        expect(r.raw).toHaveLength(10);
        expect(r.hex).toMatch(/^([0-9A-F]{2} ){9}[0-9A-F]{2}$/);
      }
      // first record starts at the table base
      expect(p.records[0].offset).toBe(CHAR_AUX_BASE);
      // records are contiguous at the documented stride
      expect(p.records[1].offset - p.records[0].offset).toBe(CHAR_AUX_STRIDE);
      // last record's trailing separator lands exactly at the table end
      const last = p.records[16];
      expect(last.offset + CHAR_AUX_STRIDE).toBe(CHAR_AUX_END);
    }
  });

  it('record 0 of the 19CHARGER62 dump matches the documented bytes', () => {
    const p = parseCharAuxTable(load('ch19'));
    expect(p.records[0].hex).toBe('00 00 00 00 09 10 0C FD DA 01');
  });

  it('count is fixed at 17 regardless of transponder-key count (NOT a per-fob table)', () => {
    // OG / 21CHARGER have far fewer transponder keys than 19CHARGER, yet all
    // produce exactly 17 aux records — the count does not track paired remotes.
    const counts = Object.keys(FILES).map((k) => parseCharAuxTable(load(k)).count);
    expect(new Set(counts)).toEqual(new Set([17]));
  });

  it('some records are byte-identical across distinct vehicles (not unique fob IDs)', () => {
    const recsByVin = Object.keys(FILES).map((k) => parseCharAuxTable(load(k)).records.map((r) => r.hex));
    // rec 4 and rec 7 are invariant across all 4 distinct VINs/masters.
    for (const idx of [4, 7]) {
      const vals = recsByVin.map((rs) => rs[idx]);
      expect(new Set(vals).size).toBe(1);
    }
  });

  it('refuses with an error message instead of throwing on a bad buffer', () => {
    expect(parseCharAuxTable(null)).toEqual({ ok: false, error: 'no buffer', records: [], count: 0 });
    const small = parseCharAuxTable(new Uint8Array(100));
    expect(small.ok).toBe(false);
    expect(small.error).toMatch(/4 KB/);
  });
});

describe('charRfhubAuxTable — byte 8 checksum (SOLVED & VERIFIED)', () => {
  it('exposes the cracked constants', () => {
    expect(CHAR_AUX_CHECKSUM_INDEX).toBe(8);
    expect(CHAR_AUX_CHECKSUM_TARGET).toBe(0xFE);
  });

  it('every record on every real dump has a valid ones-complement checksum', () => {
    let n = 0;
    for (const k of Object.keys(FILES)) {
      const p = parseCharAuxTable(load(k));
      expect(p.ok).toBe(true);
      for (const r of p.records) {
        // folded sum of all ten bytes lands on the fixed 0xFE target
        expect(auxRecordChecksum(r.raw)).toBe(CHAR_AUX_CHECKSUM_TARGET);
        expect(auxRecordChecksumOk(r.raw)).toBe(true);
        expect(r.checksumOk).toBe(true);
        expect(r.checksum).toBe(r.raw[CHAR_AUX_CHECKSUM_INDEX]);
        n++;
      }
    }
    // 17 records × 4 distinct vehicles
    expect(n).toBe(68);
  });

  it('recomputes byte 8 byte-exact from the other nine payload bytes', () => {
    for (const k of Object.keys(FILES)) {
      for (const r of parseCharAuxTable(load(k)).records) {
        expect(expectedAuxChecksumByte(r.raw)).toBe(r.raw[CHAR_AUX_CHECKSUM_INDEX]);
      }
    }
  });

  it('detects a corrupted payload byte via the checksum (byte 9 is covered too)', () => {
    const p = parseCharAuxTable(load('og'));
    const r = p.records[0];
    const bad = Uint8Array.from(r.raw);
    bad[0] = (bad[0] + 1) & 0xFF; // bump a payload byte, leave byte 8 stale
    expect(auxRecordChecksumOk(bad)).toBe(false);
    const bad9 = Uint8Array.from(r.raw);
    bad9[9] = (bad9[9] + 1) & 0xFF; // byte 9 is part of the checksummed payload
    expect(auxRecordChecksumOk(bad9)).toBe(false);
  });

  it('a plain mod-256 sum does NOT reproduce a single target (carry fold is required)', () => {
    // This is why the field was long believed unsolvable: dropping the high-byte
    // carries makes the target drift; folding them back makes it the constant 0xFE.
    const plainTargets = new Set();
    for (const k of Object.keys(FILES)) {
      for (const r of parseCharAuxTable(load(k)).records) {
        let s = 0;
        for (const b of r.raw) s += b;
        plainTargets.add(s & 0xFF);
      }
    }
    expect(plainTargets.size).toBeGreaterThan(1); // not constant without folding
  });
});
