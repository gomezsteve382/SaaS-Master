import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { crc16 } from '../crc.js';
import {
  parseMpc5606bBcm,
  applyMpc5606bBcm,
  findMpc5606bVinSlots,
  resolveMpc5606bSec16,
  MPC5606B_CANONICAL_BASES,
} from '../mpc5606bBcm.js';

const FIX = path.resolve(__dirname, '../../__tests__/fixtures');
const load = name => new Uint8Array(fs.readFileSync(path.join(FIX, name)));

describe('mpc5606bBcm — parser + classifier', () => {
  it('classifies the 18TH OG BCM as VIN_ONLY with 4 verified slots', () => {
    const buf = load('SAMPLE_BCM_DFLASH_18TH_OG.bin');
    const r = parseMpc5606bBcm(buf);
    expect(r.ok).toBe(true);
    expect(r.sizeOk).toBe(true);
    expect(r.mode).toBe('VIN_ONLY');
    expect(r.validSlots.length).toBe(4);
    expect(r.dominantVin).toBe('1C4RJFN9XJC309165');
    expect(r.sec16.blank).toBe(true);
  });

  it('classifies the synced 2C3CDXL90 BCM as FULL', () => {
    const buf = load('SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin');
    const r = parseMpc5606bBcm(buf);
    expect(r.mode).toBe('FULL');
    expect(r.dominantVin).toBe('2C3CDXL90MH582899');
    expect(r.sec16.bytes).not.toBeNull();
    expect(r.sec16.blank).toBe(false);
    expect(r.validSlots.length).toBeGreaterThanOrEqual(3);
    expect(r.validSlots.every(s => s.layout === 'base+8')).toBe(true);
  });

  it('classifies a buffer with no recognisable VIN as LOCKED', () => {
    const buf = new Uint8Array(65536); buf.fill(0xA5);
    const r = parseMpc5606bBcm(buf);
    expect(r.mode).toBe('LOCKED');
    expect(r.validSlots.length).toBe(0);
    expect(r.reasons[0]).toMatch(/No printable VIN/);
  });

  it('flags unexpected file size in reasons but still tries to classify', () => {
    const buf = new Uint8Array(32768);
    const r = parseMpc5606bBcm(buf);
    expect(r.sizeOk).toBe(false);
    expect(r.reasons.some(x => /Unexpected file size/.test(x))).toBe(true);
  });

  it('detects slots in both canonical and alternate zones', () => {
    const oldVin = '1C4RJFN9XJC309165';
    const slotsOld = findMpc5606bVinSlots(load('SAMPLE_BCM_DFLASH_18TH_OG.bin'));
    expect(slotsOld.every(s => s.zone === 'alternate')).toBe(true);
    expect(slotsOld.length).toBe(4);
    expect(slotsOld.every(s => s.vin === oldVin && s.crcOk)).toBe(true);

    const slotsNew = findMpc5606bVinSlots(load('SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin'));
    expect(slotsNew.every(s => s.zone === 'canonical')).toBe(true);
  });
});

describe('mpc5606bBcm — apply (file-in / file-out round-trip)', () => {
  it('rewrites every verified VIN slot and re-computes CRC (VIN_ONLY)', () => {
    const buf = load('SAMPLE_BCM_DFLASH_18TH_OG.bin');
    const parsed = parseMpc5606bBcm(buf);
    const newVin = '1C4RJFDJ7DC513874';
    const r = applyMpc5606bBcm(buf, parsed, { newVin });
    expect(r.bytes.length).toBe(buf.length);
    expect(r.updatedSlots.length).toBe(4);
    // Round-trip: re-parse the output and confirm the new VIN sticks.
    const re = parseMpc5606bBcm(r.bytes);
    expect(re.mode).toBe('VIN_ONLY');
    expect(re.dominantVin).toBe(newVin);
    expect(re.validSlots.length).toBe(4);
    // CRC sanity for every rewritten slot.
    const expected = crc16(new TextEncoder().encode(newVin));
    for (const s of re.validSlots) {
      expect(s.storedCrc).toBe(expected);
      expect(s.crcOk).toBe(true);
    }
  });

  it('refuses to write on a LOCKED dump', () => {
    const buf = new Uint8Array(65536); buf.fill(0x00);
    const parsed = parseMpc5606bBcm(buf);
    expect(() => applyMpc5606bBcm(buf, parsed, { newVin: '1C4RJFDJ7DC513874' }))
      .toThrow(/LOCKED/);
  });

  it('refuses an invalid VIN', () => {
    const buf = load('SAMPLE_BCM_DFLASH_18TH_OG.bin');
    const parsed = parseMpc5606bBcm(buf);
    expect(() => applyMpc5606bBcm(buf, parsed, { newVin: 'INVALID-VIN' }))
      .toThrow(/VIN must be 17/);
  });

  it('refuses to write SEC16 unless mode is FULL', () => {
    const buf = load('SAMPLE_BCM_DFLASH_18TH_OG.bin');
    const parsed = parseMpc5606bBcm(buf);
    expect(() => applyMpc5606bBcm(buf, parsed, {
      newVin: '1C4RJFDJ7DC513874',
      newSec16Hex: '00112233445566778899AABBCCDDEEFF',
    })).toThrow(/SEC16/);
  });

  it('refuses malformed SEC16 hex on FULL dumps', () => {
    const buf = load('SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin');
    const parsed = parseMpc5606bBcm(buf);
    expect(() => applyMpc5606bBcm(buf, parsed, {
      newVin: parsed.dominantVin,
      newSec16Hex: 'NOTHEX',
    })).toThrow(/32 hex/);
  });

  it('writes both VIN and SEC16 on a FULL dump and round-trips cleanly', () => {
    const buf = load('SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin');
    const parsed = parseMpc5606bBcm(buf);
    const newVin = '2C3CDXCT1HH652640';
    const newSec16Hex = '0102030405060708090A0B0C0D0E0F10';
    const r = applyMpc5606bBcm(buf, parsed, { newVin, newSec16Hex });
    expect(r.sec16).not.toBeNull();
    expect(r.sec16.splitPatched + r.sec16.mirrorPatched).toBeGreaterThan(0);
    const re = parseMpc5606bBcm(r.bytes);
    expect(re.mode).toBe('FULL');
    expect(re.dominantVin).toBe(newVin);
    // Resolved SEC16 should match what we asked for (BCM display order).
    const got = Array.from(re.sec16.bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    expect(got).toBe(newSec16Hex.toUpperCase());
  });
});

describe('mpc5606bBcm — exposed constants', () => {
  it('canonical bases match the documented 0x5320..0x5380 stride', () => {
    expect(MPC5606B_CANONICAL_BASES).toEqual([0x5320, 0x5340, 0x5360, 0x5380]);
  });

  it('resolveMpc5606bSec16 reports blank for a freshly zeroed buffer', () => {
    const buf = new Uint8Array(65536);
    const r = resolveMpc5606bSec16(buf);
    expect(r.blank).toBe(true);
  });
});
