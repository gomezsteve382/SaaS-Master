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
  isCharRfhubAuxTable,
  parseCharAuxTable,
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
