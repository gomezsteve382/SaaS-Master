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

// Module-scoped helper — zero out the split-record band, both possible
// inactive banks, and the flat-fallback slot, then re-stamp VIN slots.
// Synthesises a guaranteed-VIN_ONLY dump from the 18TH fixture (the
// fixture itself carries stale SEC16 in its inactive-bank mirrors, so
// the unmodified file classifies as FULL).
function blankSec16(buf) {
  const out = new Uint8Array(buf);
  for (let i = 0x81A0; i < 0x8200; i++) out[i] = 0xFF;
  for (let i = 0x0000; i < 0x4000; i++) out[i] = 0xFF;
  for (let i = 0x4000; i < 0x8000; i++) out[i] = 0xFF;
  for (let i = 0x40C9; i < 0x40D9; i++) out[i] = 0xFF;
  const vin = '1C4RJFN9XJC309165';
  const vinBytes = new TextEncoder().encode(vin);
  const vinCrc = crc16(vinBytes);
  for (const base of [0x1320, 0x1340, 0x1360, 0x1380]) {
    out.set(vinBytes, base);
    out[base + 17] = (vinCrc >> 8) & 0xFF;
    out[base + 18] = vinCrc & 0xFF;
  }
  return out;
}

describe('mpc5606bBcm — parser + classifier', () => {
  it('classifies the 18TH OG BCM (mirror-stripped) as VIN_ONLY with 4 verified slots', () => {
    const buf = blankSec16(load('SAMPLE_BCM_DFLASH_18TH_OG.bin'));
    const r = parseMpc5606bBcm(buf);
    expect(r.ok).toBe(true);
    expect(r.sizeOk).toBe(true);
    expect(r.mode).toBe('VIN_ONLY');
    expect(r.validSlots.length).toBe(4);
    expect(r.dominantVin).toBe('1C4RJFN9XJC309165');
    expect(r.sec16.blank).toBe(true);
  });

  it('classifies the 18TH OG BCM as FULL because inactive-bank mirrors carry SEC16', () => {
    // The raw 18TH fixture has stale-but-non-blank SEC16 in its inactive
    // bank mirrors. The thorough resolver (split + mirror1 + mirror2 +
    // flat) catches this and the classifier promotes the dump to FULL —
    // matching parseModule.js#resolveBcmSec16 behaviour.
    const r = parseMpc5606bBcm(load('SAMPLE_BCM_DFLASH_18TH_OG.bin'));
    expect(r.mode).toBe('FULL');
    expect(r.sec16.bytes).not.toBeNull();
    expect(r.sec16.blank).toBe(false);
    expect(['split', 'mirror1', 'mirror2', 'flat']).toContain(r.sec16.source);
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

  it('classifies inconsistent VIN copies as LOCKED', () => {
    const buf = blankSec16(load('SAMPLE_BCM_DFLASH_18TH_OG.bin'));
    // Overwrite one verified slot's VIN with a different valid VIN +
    // recompute its CRC so the slot still verifies on its own.
    const target = 0x1340;
    const otherVin = '1C4RJFDJ7DC513874';
    for (let i = 0; i < 17; i++) buf[target + i] = otherVin.charCodeAt(i);
    const otherCrc = crc16(new TextEncoder().encode(otherVin));
    buf[target + 17] = (otherCrc >> 8) & 0xFF;
    buf[target + 18] = otherCrc & 0xFF;
    const r = parseMpc5606bBcm(buf);
    expect(r.mode).toBe('LOCKED');
    expect(r.reasons.some(x => /inconsistent/i.test(x))).toBe(true);
  });

  it('classifies a populated-but-CRC-failing slot as LOCKED', () => {
    const buf = blankSec16(load('SAMPLE_BCM_DFLASH_18TH_OG.bin'));
    // Corrupt the CRC of one slot — slot stays printable VIN, but the
    // trailing CRC no longer matches.
    buf[0x1340 + 17] ^= 0xFF;
    buf[0x1340 + 18] ^= 0xFF;
    const r = parseMpc5606bBcm(buf);
    expect(r.mode).toBe('LOCKED');
    expect(r.reasons.some(x => /fails CRC|failed CRC/i.test(x))).toBe(true);
  });

  it('resolves SEC16 across split + mirror1 + mirror2 + flat candidates', () => {
    const r = parseMpc5606bBcm(load('SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin'));
    expect(r.sec16.candidates).toBeDefined();
    // The synced fixture must surface at least the split candidate
    // (records at 0x81A0..0x81E0 are populated in the fixture).
    expect(r.sec16.candidates.split).not.toBeNull();
    expect(r.sec16.candidates.split.blank).toBe(false);
    expect(r.sec16.candidates.split.recordCount).toBeGreaterThan(0);
    expect(r.sec16.source).toBe('split');
    // flat candidate is always probed when sz >= 0x40D9.
    expect(r.sec16.candidates.flat).not.toBeNull();
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
    const buf = blankSec16(load('SAMPLE_BCM_DFLASH_18TH_OG.bin'));
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
    const buf = blankSec16(load('SAMPLE_BCM_DFLASH_18TH_OG.bin'));
    const parsed = parseMpc5606bBcm(buf);
    expect(() => applyMpc5606bBcm(buf, parsed, { newVin: 'INVALID-VIN' }))
      .toThrow(/VIN must be 17/);
  });

  it('refuses to write SEC16 unless mode is FULL', () => {
    const buf = blankSec16(load('SAMPLE_BCM_DFLASH_18TH_OG.bin'));
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
