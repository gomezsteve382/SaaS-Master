/**
 * vinChecksumWrite.test.js — proves the unified write-and-repair step makes
 * EVERY checksum in an edited image valid again, for both:
 *   (1) a synthetic whole-image CRC32 (the "flash calibration checksum" case)
 *   (2) a real BCM bench dump (the "EEPROM per-slot CRC" case, end-to-end)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanChecksums, fixChecksum } from '../checksumScanner.js';
import { parseModule } from '../parseModule.js';
import { writeVinAndFixChecksums, fixChecksumsAfterEdit } from '../vinChecksumWrite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '..', '..', '__tests__', 'fixtures');

describe('fixChecksumsAfterEdit — whole-image firmware checksum (flash case)', () => {
  // Build a 4 KB image with a deterministic body and a real CRC32 over
  // [0, 0xFF4) stored little-endian at 0xFF4 (a position the scanner probes).
  function seededImage() {
    let buf = new Uint8Array(4096);
    for (let i = 0; i < 0xff4; i++) buf[i] = (i * 7 + 3) & 0xff;
    const vin = '1C4RJFN9XJC100007';
    for (let i = 0; i < 17; i++) buf[0x40 + i] = vin.charCodeAt(i); // VIN inside coverage
    return fixChecksum(buf, 0xff4, 'crc32', 0); // seed a valid global CRC32
  }

  it('the seeded global CRC32 is detected as valid', () => {
    const buf = seededImage();
    const hit = scanChecksums(buf).find((e) => e.offset === '0xff4' && e.algorithm === 'crc32');
    expect(hit?.status).toBe('valid');
  });

  it('an edit breaks it, and fixChecksumsAfterEdit repairs + verifies it', () => {
    const original = seededImage();
    const edited = new Uint8Array(original);
    edited[0x40] ^= 0xff; // mutate a byte inside the checksum coverage (e.g. a VIN char)

    // sanity: the edit really broke the global checksum
    const brokenHit = scanChecksums(edited).find((e) => e.offset === '0xff4' && e.algorithm === 'crc32');
    expect(brokenHit?.status).not.toBe('valid');

    const r = fixChecksumsAfterEdit(original, edited);
    const slot = r.checksums.find((c) => c.offset === '0xff4' && c.algorithm === 'crc32');
    expect(slot, 'global crc32 slot present in report').toBeTruthy();
    expect(slot.changed, 'edit broke it → recomputed').toBe(true);
    expect(r.fixedCount).toBeGreaterThanOrEqual(1);
    expect(r.verified).toBe(true);
    expect(r.skipped).toHaveLength(0);

    // result: the global CRC32 is valid again
    const reval = scanChecksums(r.data).find((e) => e.offset === '0xff4' && e.algorithm === 'crc32');
    expect(reval?.status).toBe('valid');
    // and the edited byte is preserved (we fixed the checksum, not reverted the edit)
    expect(r.data[0x40]).toBe(edited[0x40]);
  });

  it('does NOT auto-rewrite a non-CRC (sum8) hit — flags it for manual review', () => {
    // Seed only a sum8 prefix checksum (coincidence-prone → must not auto-fix).
    let buf = new Uint8Array(512);
    for (let i = 0; i < 250; i++) buf[i] = (i * 11 + 5) & 0xff;
    buf = fixChecksum(buf, 250, 'sum8', 0); // valid sum8 over [0,250) at 250
    const seen = scanChecksums(buf).find((e) => e.offset === '0xfa' && e.algorithm === 'sum8');
    expect(seen?.status).toBe('valid');

    const edited = new Uint8Array(buf);
    edited[0x10] ^= 0xff; // break the sum8 coverage
    const r = fixChecksumsAfterEdit(buf, edited);

    // sum8 must be surfaced for manual review, NOT auto-recomputed
    expect(r.checksums.find((c) => c.algorithm === 'sum8')).toBeUndefined();
    expect(r.manualReview.some((m) => m.algorithm === 'sum8')).toBe(true);
    expect(r.allClear).toBe(false); // a non-CRC checksum still needs attention
    // the data byte at the sum8 offset was left untouched (no corruption)
    expect(r.data[0xfa]).toBe(edited[0xfa]);
  });

  it('ignores a degenerate tiny-window CRC (4 MB INT_FLASH false-positive class)', () => {
    // crc32 over only [0,8) that happens to match the stored bytes is a
    // coincidence, not a firmware checksum — must NOT be auto-recomputed.
    let buf = new Uint8Array(64);
    for (let i = 0; i < 8; i++) buf[i] = (i * 13 + 1) & 0xff;
    buf = fixChecksum(buf, 8, 'crc32', 0); // span 8 < minCoverage(0x40)
    const edited = new Uint8Array(buf);
    edited[2] ^= 0xff; // mutate inside the tiny window
    const r = fixChecksumsAfterEdit(buf, edited);
    expect(r.checksums.find((c) => c.offset === '0x8')).toBeUndefined();
    expect(r.ignoredDegenerate.some((d) => d.algorithm === 'crc32' && d.span === 8)).toBe(true);
    expect(r.data[8]).toBe(edited[8]); // the bytes at 0x8 were left untouched
  });

  it('reports no fixes when the edit is outside every checksum coverage', () => {
    const original = seededImage();
    const edited = new Uint8Array(original);
    edited[0xffc] = (edited[0xffc] + 1) & 0xff; // past 0xFF4+4 → outside the CRC32 window
    const r = fixChecksumsAfterEdit(original, edited);
    const slot = r.checksums.find((c) => c.offset === '0xff4' && c.algorithm === 'crc32');
    expect(slot.changed).toBe(false); // untouched coverage → recompute is a no-op
    expect(r.verified).toBe(true);
  });
});

describe('writeVinAndFixChecksums — real BCM bench dump, end-to-end', () => {
  const FILE = 'SAMPLE_BCM_DFLASH_18TH_DK0G_VIN_CRC_1C4RJFN9XJC100007.bin';
  const NEW_VIN = '1C4RJFN9XJC100099';

  it('writes the new VIN, keeps every per-slot CRC valid, and verifies checksums', () => {
    const data = new Uint8Array(fs.readFileSync(path.join(FIXTURES, FILE)));
    const info = parseModule(data, FILE);

    const r = writeVinAndFixChecksums(data, 'BCM', NEW_VIN, { existingVins: info.vins });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);

    const re = parseModule(r.data, FILE);
    expect(re.vins[0].vin).toBe(NEW_VIN);
    expect(re.vins.every((v) => v.crcOk !== false), 'all VIN-slot CRCs valid').toBe(true);
  });

  it('rejects a VIN that is not exactly 17 characters', () => {
    const data = new Uint8Array(fs.readFileSync(path.join(FIXTURES, FILE)));
    const r = writeVinAndFixChecksums(data, 'BCM', 'TOOSHORT', {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/17 characters/);
  });
});
