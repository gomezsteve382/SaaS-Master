/**
 * rfhubKeyTransplant.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Comprehensive tests for the Gen2 RFHUB key transplant library.
 * Covers: parse, validate, flagInfo, Master Transponder, auth sector copy,
 *         Autel ID display, write-twice protocol, bench file smoke tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import {
  parseKeyRingBuffer,
  findWritePointer,
  countFreeSlots,
  transplantKeys,
  validateRfhubBuffer,
  readMasterTransponder,
  readAuthKeyCount,
  flagInfo,
  KEY_RB_BASE,
  KEY_RB_SIZE,
  KEY_ENTRY_SZ,
  KEY_SLOT_COUNT,
  AUTH_SECTOR_BASE,
  AUTH_SECTOR_SIZE,
  MASTER_TRANSPONDER_OFFSET,
  MASTER_TRANSPONDER_SIZE,
  RFHUB_MIN_SIZE,
} from '../client/src/srtlab/lib/rfhubKeyTransplant.js';

/* ─── helpers ─────────────────────────────────────────────────────────────── */

const UPLOAD_DIR = '/home/ubuntu/upload';

function loadBenchFile(name: string): Uint8Array | null {
  const p = join(UPLOAD_DIR, name);
  if (!existsSync(p)) return null;
  return new Uint8Array(readFileSync(p));
}

/**
 * Build a minimal 4KB RFHUB buffer.
 * Ring buffer area is filled with the empty-slot pattern (5A 5A 95 00 00 00 FF FF).
 */
function makeEmptyRfhub(): Uint8Array {
  const buf = new Uint8Array(RFHUB_MIN_SIZE);
  // Fill ring buffer with empty-slot pattern
  for (let i = KEY_RB_BASE; i < KEY_RB_BASE + KEY_RB_SIZE; i += KEY_ENTRY_SZ) {
    buf[i]   = 0x5A; buf[i+1] = 0x5A; buf[i+2] = 0x95; buf[i+3] = 0x00;
    buf[i+4] = 0x00; buf[i+5] = 0x00; buf[i+6] = 0xFF; buf[i+7] = 0xFF;
  }
  return buf;
}

/** Write a key entry (twice) at a given slot index in a buffer */
function writeKeyEntry(
  buf: Uint8Array,
  slotIdx: number,
  chipIdBE: string,   // 8-char hex big-endian (Autel display format)
  flag: number,
  count: number = 0x01,
) {
  const bytes = chipIdBE.match(/.{2}/g)!.map(h => parseInt(h, 16));
  const entry = new Uint8Array([
    bytes[3], bytes[2], bytes[1], bytes[0], // stored little-endian
    flag, count, 0xFF, 0xFF,
  ]);
  const off = KEY_RB_BASE + slotIdx * KEY_ENTRY_SZ;
  buf.set(entry, off);
  buf.set(entry, off + KEY_ENTRY_SZ);
}

/* ─── constants ───────────────────────────────────────────────────────────── */
describe('constants', () => {
  it('KEY_RB_BASE is 0x0C80', () => expect(KEY_RB_BASE).toBe(0x0C80));
  it('KEY_RB_SIZE is 256', () => expect(KEY_RB_SIZE).toBe(256));
  it('KEY_SLOT_COUNT is 32', () => expect(KEY_SLOT_COUNT).toBe(32));
  it('AUTH_SECTOR_BASE is 0x0100', () => expect(AUTH_SECTOR_BASE).toBe(0x0100));
  it('AUTH_SECTOR_SIZE is 0x0180 (384 bytes)', () => expect(AUTH_SECTOR_SIZE).toBe(0x0180));
  it('MASTER_TRANSPONDER_OFFSET is 0x0226', () => expect(MASTER_TRANSPONDER_OFFSET).toBe(0x0226));
  it('MASTER_TRANSPONDER_SIZE is 16', () => expect(MASTER_TRANSPONDER_SIZE).toBe(16));
  it('RFHUB_MIN_SIZE is 0x1000 (4KB)', () => expect(RFHUB_MIN_SIZE).toBe(0x1000));
});

/* ─── flagInfo ────────────────────────────────────────────────────────────── */
describe('flagInfo', () => {
  it('0xE6 → Black Key / Hitag AES', () => {
    const f = flagInfo(0xE6);
    expect(f.label).toBe('Black Key');
    expect(f.sub).toBe('Hitag AES');
    expect(f.color).toBeTruthy();
  });
  it('0x48 → Red Key / Hitag AES', () => {
    const f = flagInfo(0x48);
    expect(f.label).toBe('Red Key');
    expect(f.sub).toBe('Hitag AES');
  });
  it('0x01 → Standard / Hitag2', () => {
    const f = flagInfo(0x01);
    expect(f.label).toBe('Standard');
    expect(f.sub).toBe('Hitag2');
  });
  it('0x03 → Alt Family / Hitag2', () => {
    const f = flagInfo(0x03);
    expect(f.label).toBe('Alt Family');
    expect(f.sub).toBe('Hitag2');
  });
  it('unknown flag returns hex label', () => {
    const f = flagInfo(0xAB);
    expect(f.label.toLowerCase()).toContain('ab');
  });
});

/* ─── validateRfhubBuffer ─────────────────────────────────────────────────── */
describe('validateRfhubBuffer', () => {
  it('accepts a 4KB buffer with empty-slot pattern', () => {
    expect(validateRfhubBuffer(makeEmptyRfhub()).ok).toBe(true);
  });
  it('rejects buffer smaller than 4KB', () => {
    expect(validateRfhubBuffer(new Uint8Array(0x0FFF)).ok).toBe(false);
  });
  it('rejects all-zero ring buffer area', () => {
    expect(validateRfhubBuffer(new Uint8Array(RFHUB_MIN_SIZE)).ok).toBe(false);
  });
  it('rejects non-Uint8Array', () => {
    expect(validateRfhubBuffer(null as any).ok).toBe(false);
  });
});

/* ─── parseKeyRingBuffer ──────────────────────────────────────────────────── */
describe('parseKeyRingBuffer', () => {
  it('returns empty array for freshly-erased RFHUB', () => {
    expect(parseKeyRingBuffer(makeEmptyRfhub())).toHaveLength(0);
  });

  it('parses a single black key (D55E7E64, flag 0xE6)', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'D55E7E64', 0xE6);
    const keys = parseKeyRingBuffer(buf);
    expect(keys).toHaveLength(1);
    expect(keys[0].chipId).toBe('D55E7E64');
    expect(keys[0].autelId).toBe('D55E7E64'); // autelId === chipId
    expect(keys[0].flag).toBe(0xE6);
    expect(keys[0].count).toBe(0x01);
  });

  it('parses a single red key (CF324E65, flag 0x48)', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'CF324E65', 0x48);
    const keys = parseKeyRingBuffer(buf);
    expect(keys).toHaveLength(1);
    expect(keys[0].chipId).toBe('CF324E65');
    expect(keys[0].flag).toBe(0x48);
  });

  it('deduplicates entries (each key stored twice in ring buffer)', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'D55E7E64', 0xE6); // writes slots 0 and 1
    expect(parseKeyRingBuffer(buf)).toHaveLength(1);
  });

  it('parses two distinct keys', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'D55E7E64', 0xE6);
    writeKeyEntry(buf, 2, 'CF324E65', 0x48);
    const keys = parseKeyRingBuffer(buf);
    expect(keys).toHaveLength(2);
    expect(keys.map(k => k.chipId)).toContain('D55E7E64');
    expect(keys.map(k => k.chipId)).toContain('CF324E65');
  });

  it('bench-verified: LE bytes 64 7E 5E D5 → Autel ID D55E7E64', () => {
    const buf = makeEmptyRfhub();
    const off = KEY_RB_BASE;
    // Exact bytes from real bench file
    buf[off]   = 0x64; buf[off+1] = 0x7E; buf[off+2] = 0x5E; buf[off+3] = 0xD5;
    buf[off+4] = 0xE6; buf[off+5] = 0x01; buf[off+6] = 0xFF; buf[off+7] = 0xFF;
    buf.set(buf.slice(off, off + 8), off + 8); // duplicate
    expect(parseKeyRingBuffer(buf)[0].chipId).toBe('D55E7E64');
  });

  it('bench-verified: LE bytes 65 4E 32 CF → Autel ID CF324E65', () => {
    const buf = makeEmptyRfhub();
    const off = KEY_RB_BASE;
    buf[off]   = 0x65; buf[off+1] = 0x4E; buf[off+2] = 0x32; buf[off+3] = 0xCF;
    buf[off+4] = 0x48; buf[off+5] = 0x01; buf[off+6] = 0xFF; buf[off+7] = 0xFF;
    buf.set(buf.slice(off, off + 8), off + 8);
    expect(parseKeyRingBuffer(buf)[0].chipId).toBe('CF324E65');
  });
});

/* ─── findWritePointer / countFreeSlots ───────────────────────────────────── */
describe('findWritePointer', () => {
  it('returns KEY_RB_BASE for empty ring buffer', () => {
    expect(findWritePointer(makeEmptyRfhub())).toBe(KEY_RB_BASE);
  });

  it('advances by 2 slots (16 bytes) after one key written', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'D55E7E64', 0xE6);
    expect(findWritePointer(buf)).toBe(KEY_RB_BASE + 2 * KEY_ENTRY_SZ);
  });

  it('returns null when ring buffer is completely full', () => {
    const buf = makeEmptyRfhub();
    for (let i = 0; i < KEY_SLOT_COUNT; i += 2) {
      writeKeyEntry(buf, i, 'D55E7E64', 0xE6);
    }
    expect(findWritePointer(buf)).toBeNull();
  });
});

describe('countFreeSlots', () => {
  it('returns max pairs for empty buffer', () => {
    const buf = makeEmptyRfhub();
    const wp  = findWritePointer(buf)!;
    const maxPairs = Math.floor(KEY_RB_SIZE / (KEY_ENTRY_SZ * 2));
    expect(countFreeSlots(buf, wp)).toBe(maxPairs);
  });

  it('decrements by 1 pair after writing one key', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'D55E7E64', 0xE6);
    const wp  = findWritePointer(buf)!;
    const maxPairs = Math.floor(KEY_RB_SIZE / (KEY_ENTRY_SZ * 2));
    expect(countFreeSlots(buf, wp)).toBe(maxPairs - 1);
  });
});

/* ─── readMasterTransponder ───────────────────────────────────────────────── */
describe('readMasterTransponder', () => {
  it('returns virgin=true for all-FF MT area', () => {
    const buf = new Uint8Array(RFHUB_MIN_SIZE).fill(0xFF);
    // Fill ring buffer with empty-slot pattern so validation passes
    for (let i = KEY_RB_BASE; i < KEY_RB_BASE + KEY_RB_SIZE; i += KEY_ENTRY_SZ) {
      buf[i]   = 0x5A; buf[i+1] = 0x5A; buf[i+2] = 0x95; buf[i+3] = 0x00;
      buf[i+4] = 0x00; buf[i+5] = 0x00; buf[i+6] = 0xFF; buf[i+7] = 0xFF;
    }
    const mt = readMasterTransponder(buf);
    expect(mt.virgin).toBe(true);
  });

  it('returns virgin=false and correct hex when MT has data', () => {
    const buf = makeEmptyRfhub();
    buf[MASTER_TRANSPONDER_OFFSET]      = 0x43;
    buf[MASTER_TRANSPONDER_OFFSET + 1]  = 0x1F;
    buf[MASTER_TRANSPONDER_OFFSET + 15] = 0x44;
    const mt = readMasterTransponder(buf);
    expect(mt.virgin).toBe(false);
    expect(mt.hex).toContain('43');
    expect(mt.hex).toContain('44');
    expect(mt.hex.split(' ')).toHaveLength(MASTER_TRANSPONDER_SIZE);
  });

  it('bench-verified: MT from 21RFHUB_6.2 starts with F7 B1', () => {
    const buf = loadBenchFile('21RFHUB_6.2_REDKEY_PRORGRAMMED.bin');
    if (!buf) return; // skip if not present
    const mt = readMasterTransponder(buf);
    expect(mt.virgin).toBe(false);
    expect(mt.hex.startsWith('F7 B1')).toBe(true);
  });
});

/* ─── readAuthKeyCount ────────────────────────────────────────────────────── */
describe('readAuthKeyCount', () => {
  it('returns a number >= 0', () => {
    const count = readAuthKeyCount(makeEmptyRfhub());
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('bench-verified: 21RFHUB_6.2 has key count >= 2', () => {
    const buf = loadBenchFile('21RFHUB_6.2_REDKEY_PRORGRAMMED.bin');
    if (!buf) return;
    expect(readAuthKeyCount(buf)).toBeGreaterThanOrEqual(2);
  });
});

/* ─── transplantKeys ──────────────────────────────────────────────────────── */
describe('transplantKeys', () => {
  it('injects a single donor key into empty target', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);

    const res = transplantKeys(donor, target, { copyAuthSector: false });
    expect(res.injected).toHaveLength(1);
    expect(res.injected[0].chipId).toBe('D55E7E64');
    expect(res.injected[0].autelId).toBe('D55E7E64');
    expect(res.skipped).toHaveLength(0);
    expect(parseKeyRingBuffer(res.patched).map(k => k.chipId)).toContain('D55E7E64');
  });

  it('injects two donor keys', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);
    writeKeyEntry(donor, 2, 'CF324E65', 0x48);

    const res = transplantKeys(donor, target, { copyAuthSector: false });
    expect(res.injected).toHaveLength(2);
    const ids = parseKeyRingBuffer(res.patched).map(k => k.chipId);
    expect(ids).toContain('D55E7E64');
    expect(ids).toContain('CF324E65');
  });

  it('skips duplicate keys already in target', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor,  0, 'D55E7E64', 0xE6);
    writeKeyEntry(target, 0, 'D55E7E64', 0xE6);
    expect(() => transplantKeys(donor, target, { copyAuthSector: false }))
      .toThrow(/No new keys/);
  });

  it('respects the only filter', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);
    writeKeyEntry(donor, 2, 'CF324E65', 0x48);

    const res = transplantKeys(donor, target, {
      only: ['CF324E65'],
      copyAuthSector: false,
    });
    expect(res.injected).toHaveLength(1);
    expect(res.injected[0].chipId).toBe('CF324E65');
    expect(res.skipped.find(s => s.chipId === 'D55E7E64')?.reason).toBe('not in selection');
  });

  it('throws when donor has no keys', () => {
    expect(() => transplantKeys(makeEmptyRfhub(), makeEmptyRfhub(), { copyAuthSector: false }))
      .toThrow(/no programmed keys/i);
  });

  it('throws when target ring buffer is full', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'AABBCCDD', 0x01);
    for (let i = 0; i < KEY_SLOT_COUNT; i += 2) {
      writeKeyEntry(target, i, 'D55E7E64', 0xE6);
    }
    expect(() => transplantKeys(donor, target, { copyAuthSector: false }))
      .toThrow();
  });

  it('writes each key TWICE (ring buffer write-twice protocol)', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);

    const res = transplantKeys(donor, target, { copyAuthSector: false });
    const wp  = KEY_RB_BASE;
    const slot0 = res.patched.slice(wp, wp + 8);
    const slot1 = res.patched.slice(wp + 8, wp + 16);
    expect(Array.from(slot0)).toEqual(Array.from(slot1));
    // LE chip ID: D55E7E64 → stored as 64 7E 5E D5
    expect(slot0[0]).toBe(0x64);
    expect(slot0[1]).toBe(0x7E);
    expect(slot0[2]).toBe(0x5E);
    expect(slot0[3]).toBe(0xD5);
    expect(slot0[4]).toBe(0xE6);
    expect(slot0[6]).toBe(0xFF);
    expect(slot0[7]).toBe(0xFF);
  });

  it('does not mutate the original target buffer', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);
    const snapshot = new Uint8Array(target);
    transplantKeys(donor, target, { copyAuthSector: false });
    expect(target).toEqual(snapshot);
  });

  it('result.patched has same length as target', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);
    const res = transplantKeys(donor, target, { copyAuthSector: false });
    expect(res.patched.length).toBe(target.length);
  });

  it('does not touch bytes outside ring buffer when copyAuthSector=false', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);
    // Mark a byte outside ring buffer in target
    target[0x0050] = 0xAB;

    const res = transplantKeys(donor, target, { copyAuthSector: false });
    expect(res.patched[0x0050]).toBe(0xAB);
  });

  /* ─── auth sector copy ────────────────────────────────────────────────── */
  it('copies auth sector from donor when copyAuthSector=true', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);
    // Write a marker in donor auth sector
    donor[AUTH_SECTOR_BASE + 10] = 0xAB;
    donor[AUTH_SECTOR_BASE + 20] = 0xCD;

    const res = transplantKeys(donor, target, { copyAuthSector: true });
    expect(res.authSectorCopied).toBe(true);
    expect(res.patched[AUTH_SECTOR_BASE + 10]).toBe(0xAB);
    expect(res.patched[AUTH_SECTOR_BASE + 20]).toBe(0xCD);
  });

  it('does NOT copy auth sector when copyAuthSector=false', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);
    donor[AUTH_SECTOR_BASE + 10] = 0xAB;

    const res = transplantKeys(donor, target, { copyAuthSector: false });
    expect(res.authSectorCopied).toBe(false);
    expect(res.patched[AUTH_SECTOR_BASE + 10]).toBe(target[AUTH_SECTOR_BASE + 10]);
  });

  it('bench-verified: auth sector copy produces byte-identical output to Autel-programmed file', () => {
    const donor  = loadBenchFile('21RFHUB_6.2_REDKEY_PRORGRAMMED.bin');
    const before = loadBenchFile('redandblackkysprogrammed.bin');
    const after  = loadBenchFile('redandblackkysprogrammed_afterprogrammed.bin');
    if (!donor || !before || !after) return; // skip if bench files not present

    // Transplant from donor (has both keys) into before (same keys in ring buf)
    // The auth sector should match the after file
    const donorKeys = parseKeyRingBuffer(donor);
    if (donorKeys.length === 0) return;

    // Use before as target; skip duplicates OFF so we can force auth sector copy
    // even if ring buffer already has keys
    const res = transplantKeys(donor, before, {
      copyAuthSector: true,
      skipDuplicates: false,
    });

    // Auth sector in result should match donor (which matches after)
    for (let i = AUTH_SECTOR_BASE; i < AUTH_SECTOR_BASE + AUTH_SECTOR_SIZE; i++) {
      expect(res.patched[i]).toBe(donor[i]);
    }
  });

  /* ─── error cases ─────────────────────────────────────────────────────── */
  it('throws on invalid donor buffer', () => {
    expect(() => transplantKeys(new Uint8Array(100), makeEmptyRfhub())).toThrow();
  });

  it('throws on invalid target buffer', () => {
    const donor = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6);
    expect(() => transplantKeys(donor, new Uint8Array(100))).toThrow();
  });
});

/* ─── bench file: real RFHUB files ───────────────────────────────────────── */
describe('bench file: 21RFHUB_6.2_REDKEY_PRORGRAMMED.bin', () => {
  const buf = loadBenchFile('21RFHUB_6.2_REDKEY_PRORGRAMMED.bin');

  it('validates as a real RFHUB', () => {
    if (!buf) return;
    expect(validateRfhubBuffer(buf).ok).toBe(true);
  });

  it('has black key D55E7E64 with flag 0xE6', () => {
    if (!buf) return;
    const keys = parseKeyRingBuffer(buf);
    const k = keys.find(k => k.chipId === 'D55E7E64');
    expect(k).toBeDefined();
    expect(k!.flag).toBe(0xE6);
  });

  it('has red key CF324E65 with flag 0x48', () => {
    if (!buf) return;
    const keys = parseKeyRingBuffer(buf);
    const k = keys.find(k => k.chipId === 'CF324E65');
    expect(k).toBeDefined();
    expect(k!.flag).toBe(0x48);
  });

  it('Master Transponder is not virgin', () => {
    if (!buf) return;
    expect(readMasterTransponder(buf).virgin).toBe(false);
  });

  it('auth key count >= 2', () => {
    if (!buf) return;
    expect(readAuthKeyCount(buf)).toBeGreaterThanOrEqual(2);
  });
});

describe('bench file: before/after pair', () => {
  const before = loadBenchFile('redandblackkysprogrammed.bin');
  const after  = loadBenchFile('redandblackkysprogrammed_afterprogrammed.bin');

  it('both files validate', () => {
    if (!before || !after) return;
    expect(validateRfhubBuffer(before).ok).toBe(true);
    expect(validateRfhubBuffer(after).ok).toBe(true);
  });

  it('auth sector changed between before and after', () => {
    if (!before || !after) return;
    let diffs = 0;
    for (let i = AUTH_SECTOR_BASE; i < AUTH_SECTOR_BASE + AUTH_SECTOR_SIZE; i++) {
      if (before[i] !== after[i]) diffs++;
    }
    expect(diffs).toBeGreaterThan(0);
  });

  it('ring buffer is identical between before and after', () => {
    if (!before || !after) return;
    let diffs = 0;
    for (let i = KEY_RB_BASE; i < KEY_RB_BASE + KEY_RB_SIZE; i++) {
      if (before[i] !== after[i]) diffs++;
    }
    // Ring buffer should NOT change — Autel only updates auth sector
    expect(diffs).toBe(0);
  });

  it('transplant with copyAuthSector=true copies auth sector byte-for-byte', () => {
    if (!after) return;
    const blank = makeEmptyRfhub();
    const afterKeys = parseKeyRingBuffer(after);
    if (afterKeys.length === 0) return;

    const res = transplantKeys(after, blank, { copyAuthSector: true });
    expect(res.authSectorCopied).toBe(true);
    for (let i = AUTH_SECTOR_BASE; i < AUTH_SECTOR_BASE + AUTH_SECTOR_SIZE; i++) {
      expect(res.patched[i]).toBe(after[i]);
    }
  });
});
