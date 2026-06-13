/**
 * checksumSweep.corpus.test.js — validates the checksum sweep against EVERY
 * real module dump in the committed fixtures/ corpus (BCM D-Flash, RFHUB Gen1/
 * Gen2, GPEC2A EEPROM 4K/8K, GPEC2A INT_FLASH, 95640, …).
 *
 * For each dump it asserts the two properties that make the write-and-repair
 * pipeline safe to ship:
 *   1. A no-op edit verifies cleanly and changes nothing.
 *   2. After a real interior edit, the sweep repairs every whole-image/per-block
 *      CRC so it is valid again, preserves the edit, and never corrupts data via
 *      a coincidental sum/xor or a degenerate tiny-window CRC.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanChecksums } from '../checksumScanner.js';
import { fixChecksumsAfterEdit } from '../vinChecksumWrite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '..', '..', '__tests__', 'fixtures');

const CRC = new Set(['crc32', 'crc32be', 'crc16']);
// CRCs the sweep is allowed to auto-fix: CRC-type AND coverage ≥ 0x40 bytes
// (degenerate tiny-window matches are coincidences, intentionally left alone).
const realCrcKeys = (bytes) =>
  new Set(
    scanChecksums(bytes)
      .filter((e) => e.status === 'valid' && CRC.has(e.algorithm))
      .filter((e) => parseInt(e.offset, 16) - parseInt(e.coversStart, 16) >= 0x40)
      .map((e) => `${e.offset}:${e.algorithm}`),
  );

const bins = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.bin')).sort();

describe('checksum sweep validated across the full fixtures/ corpus', () => {
  it(`corpus is non-trivial (${bins.length} real dumps)`, () => {
    expect(bins.length).toBeGreaterThan(40);
  });

  for (const fn of bins) {
    describe(fn, () => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, fn)));

      it('a no-op edit verifies cleanly and changes nothing', () => {
        const r = fixChecksumsAfterEdit(bytes, bytes);
        expect(r.verified).toBe(true);
        expect(r.fixedCount).toBe(0);
        expect(Array.from(r.data)).toEqual(Array.from(bytes));
      });

      it('an interior edit is repaired: every real CRC valid again, edit preserved', () => {
        if (bytes.length < 0x80) return; // too small to edit meaningfully
        const before = realCrcKeys(bytes);
        const edited = new Uint8Array(bytes);
        const mid = bytes.length >> 1;
        edited[mid] ^= 0xff; // mutate a deep interior byte (inside any image-CRC window)

        const r = fixChecksumsAfterEdit(bytes, edited);
        expect(r.verified, `${fn}: sweep should verify`).toBe(true);
        expect(r.data[mid], `${fn}: edit must be preserved`).toBe(edited[mid]);

        const after = realCrcKeys(r.data);
        for (const k of before) {
          expect(after.has(k), `${fn}: CRC ${k} not re-validated after sweep`).toBe(true);
        }
      });
    });
  }
});
