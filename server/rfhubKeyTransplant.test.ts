/**
 * rfhubKeyTransplant.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests for the Gen2 RFHUB key ring-buffer transplant engine.
 *
 * All tests are pure-JS (no file I/O) and run in Node via vitest.
 * The library is ESM, so we import it directly.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect } from 'vitest';
import {
  parseKeyRingBuffer,
  findWritePointer,
  countFreeSlots,
  transplantKeys,
  validateRfhubBuffer,
  KEY_RB_BASE,
  KEY_RB_SIZE,
  KEY_ENTRY_SZ,
  KEY_SLOT_COUNT,
  RFHUB_MIN_SIZE,
} from '../client/src/srtlab/lib/rfhubKeyTransplant.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal 32 KB RFHUB buffer filled with 5A 5A 95 00 FF FF 5A 5A (empty slots) */
function makeEmptyRfhub(): Uint8Array {
  const buf = new Uint8Array(RFHUB_MIN_SIZE);
  // Fill the key ring buffer area with the empty slot pattern
  const emptySlot = new Uint8Array([0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00, 0xFF, 0xFF]);
  for (let i = 0; i < KEY_SLOT_COUNT; i++) {
    buf.set(emptySlot, KEY_RB_BASE + i * KEY_ENTRY_SZ);
  }
  return buf;
}

/** Write a key entry (twice) at a given slot index in a buffer */
function writeKeyEntry(
  buf: Uint8Array,
  slotIdx: number,
  chipIdBE: string,
  flag: number,
  count: number,
) {
  const bytes = chipIdBE.match(/.{2}/g)!.map(h => parseInt(h, 16));
  const entry = new Uint8Array([
    bytes[3], bytes[2], bytes[1], bytes[0], // LE chip ID
    flag, count, 0xFF, 0xFF,
  ]);
  const off = KEY_RB_BASE + slotIdx * KEY_ENTRY_SZ;
  buf.set(entry, off);
  buf.set(entry, off + KEY_ENTRY_SZ);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('validateRfhubBuffer', () => {
  it('rejects buffers smaller than RFHUB_MIN_SIZE', () => {
    const small = new Uint8Array(100);
    expect(validateRfhubBuffer(small).ok).toBe(false);
  });

  it('rejects all-zero ring buffer area', () => {
    const buf = new Uint8Array(RFHUB_MIN_SIZE); // all zeros
    expect(validateRfhubBuffer(buf).ok).toBe(false);
  });

  it('accepts a buffer with the empty-slot fill pattern', () => {
    const buf = makeEmptyRfhub();
    expect(validateRfhubBuffer(buf).ok).toBe(true);
  });
});

describe('parseKeyRingBuffer', () => {
  it('returns empty array for a freshly-erased RFHUB', () => {
    const buf = makeEmptyRfhub();
    expect(parseKeyRingBuffer(buf)).toHaveLength(0);
  });

  it('parses a single key entry (written twice)', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'D55E7E64', 0xE6, 0x01);
    // Slot 0 and slot 1 both hold the same entry; parser deduplicates
    const keys = parseKeyRingBuffer(buf);
    expect(keys).toHaveLength(1);
    expect(keys[0].chipId).toBe('D55E7E64');
    expect(keys[0].flag).toBe(0xE6);
    expect(keys[0].count).toBe(0x01);
  });

  it('parses multiple unique keys', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'D55E7E64', 0xE6, 0x01); // slots 0-1
    writeKeyEntry(buf, 2, 'CF324E65', 0x48, 0x01); // slots 2-3
    const keys = parseKeyRingBuffer(buf);
    expect(keys).toHaveLength(2);
    expect(keys.map(k => k.chipId)).toContain('D55E7E64');
    expect(keys.map(k => k.chipId)).toContain('CF324E65');
  });

  it('bench-verified: black key D55E7E64 flag=0xE6 matches 21RFHUB_6.2_REDKEY_PRORGRAMMED format', () => {
    const buf = makeEmptyRfhub();
    // Exact bytes from bench: 64 7E 5E D5 E6 01 FF FF (LE chip ID)
    const off = KEY_RB_BASE;
    buf[off]   = 0x64; buf[off+1] = 0x7E; buf[off+2] = 0x5E; buf[off+3] = 0xD5;
    buf[off+4] = 0xE6; buf[off+5] = 0x01; buf[off+6] = 0xFF; buf[off+7] = 0xFF;
    // duplicate at slot 1
    buf.set(buf.slice(off, off + 8), off + 8);
    const keys = parseKeyRingBuffer(buf);
    expect(keys[0].chipId).toBe('D55E7E64');
    expect(keys[0].flag).toBe(0xE6);
  });

  it('bench-verified: red key CF324E65 flag=0x48 matches bench format', () => {
    const buf = makeEmptyRfhub();
    const off = KEY_RB_BASE;
    buf[off]   = 0x65; buf[off+1] = 0x4E; buf[off+2] = 0x32; buf[off+3] = 0xCF;
    buf[off+4] = 0x48; buf[off+5] = 0x01; buf[off+6] = 0xFF; buf[off+7] = 0xFF;
    buf.set(buf.slice(off, off + 8), off + 8);
    const keys = parseKeyRingBuffer(buf);
    expect(keys[0].chipId).toBe('CF324E65');
    expect(keys[0].flag).toBe(0x48);
  });
});

describe('findWritePointer', () => {
  it('returns KEY_RB_BASE for a completely empty ring buffer', () => {
    const buf = makeEmptyRfhub();
    expect(findWritePointer(buf)).toBe(KEY_RB_BASE);
  });

  it('advances by 2 slots after one key is written (twice)', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'D55E7E64', 0xE6, 0x01);
    // Slots 0 and 1 are now occupied; write pointer should be at slot 2
    expect(findWritePointer(buf)).toBe(KEY_RB_BASE + 2 * KEY_ENTRY_SZ);
  });

  it('returns null when ring buffer is completely full', () => {
    const buf = makeEmptyRfhub();
    // Fill all slots with a non-empty entry
    for (let i = 0; i < KEY_SLOT_COUNT; i += 2) {
      writeKeyEntry(buf, i, 'D55E7E64', 0xE6, 0x01);
    }
    expect(findWritePointer(buf)).toBeNull();
  });
});

describe('countFreeSlots', () => {
  it('counts all slot pairs as free for an empty buffer', () => {
    const buf = makeEmptyRfhub();
    const wp = findWritePointer(buf)!;
    // countFreeSlots returns key PAIRS (each pair = 2 × 8 bytes = 16 bytes)
    // For an empty buffer: KEY_RB_SIZE / (KEY_ENTRY_SZ * 2) = 256 / 16 = 16 pairs
    expect(countFreeSlots(buf, wp)).toBe(Math.floor(KEY_RB_SIZE / (KEY_ENTRY_SZ * 2)));
  });

  it('decrements by 1 pair per key written', () => {
    const buf = makeEmptyRfhub();
    writeKeyEntry(buf, 0, 'D55E7E64', 0xE6, 0x01);
    const wp = findWritePointer(buf)!;
    // After writing 1 key (2 slots = 16 bytes), 15 pairs remain
    const totalPairs = Math.floor(KEY_RB_SIZE / (KEY_ENTRY_SZ * 2));
    expect(countFreeSlots(buf, wp)).toBe(totalPairs - 1);
  });
});

describe('transplantKeys', () => {
  it('injects a single donor key into an empty target', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6, 0x01);

    const res = transplantKeys(donor, target);
    expect(res.injected).toHaveLength(1);
    expect(res.injected[0].chipId).toBe('D55E7E64');
    expect(res.skipped).toHaveLength(0);

    // Verify the patched buffer actually has the key
    const patchedKeys = parseKeyRingBuffer(res.patched);
    expect(patchedKeys.map(k => k.chipId)).toContain('D55E7E64');
  });

  it('injects multiple donor keys', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6, 0x01);
    writeKeyEntry(donor, 2, 'CF324E65', 0x48, 0x01);

    const res = transplantKeys(donor, target);
    expect(res.injected).toHaveLength(2);
    const patchedKeys = parseKeyRingBuffer(res.patched);
    expect(patchedKeys.map(k => k.chipId)).toContain('D55E7E64');
    expect(patchedKeys.map(k => k.chipId)).toContain('CF324E65');
  });

  it('skips keys already present in target (duplicate detection)', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor,  0, 'D55E7E64', 0xE6, 0x01);
    writeKeyEntry(target, 0, 'D55E7E64', 0xE6, 0x01); // already there

    expect(() => transplantKeys(donor, target)).toThrow(/No new keys/);
  });

  it('skips non-selected keys when `only` filter is set', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6, 0x01);
    writeKeyEntry(donor, 2, 'CF324E65', 0x48, 0x01);

    const res = transplantKeys(donor, target, { only: ['CF324E65'] });
    expect(res.injected).toHaveLength(1);
    expect(res.injected[0].chipId).toBe('CF324E65');
    expect(res.skipped.find(s => s.chipId === 'D55E7E64')?.reason).toBe('not in selection');
  });

  it('throws when donor has no keys', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    expect(() => transplantKeys(donor, target)).toThrow(/no programmed keys/i);
  });

  it('throws when target ring buffer is full', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6, 0x01);
    // Fill target completely
    for (let i = 0; i < KEY_SLOT_COUNT; i += 2) {
      writeKeyEntry(target, i, 'AABBCCDD', 0x01, 0x01);
    }
    expect(() => transplantKeys(donor, target)).toThrow(/full/i);
  });

  it('writes each key TWICE in the patched buffer (ring buffer protocol)', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6, 0x01);

    const res = transplantKeys(donor, target);
    const wp = KEY_RB_BASE; // target was empty, write ptr was at base

    // Slot 0 and slot 1 should both hold the same chip ID (LE)
    const slot0 = res.patched.slice(wp, wp + 8);
    const slot1 = res.patched.slice(wp + 8, wp + 16);
    expect(Array.from(slot0)).toEqual(Array.from(slot1));
    // Chip ID bytes LE: D5 5E 7E 64 → stored as 64 7E 5E D5
    expect(slot0[0]).toBe(0x64);
    expect(slot0[1]).toBe(0x7E);
    expect(slot0[2]).toBe(0x5E);
    expect(slot0[3]).toBe(0xD5);
    expect(slot0[4]).toBe(0xE6); // flag
    expect(slot0[5]).toBe(0x01); // count
    expect(slot0[6]).toBe(0xFF); // terminator
    expect(slot0[7]).toBe(0xFF); // terminator
  });

  it('does not modify bytes outside the key ring buffer', () => {
    const donor  = makeEmptyRfhub();
    const target = makeEmptyRfhub();
    writeKeyEntry(donor, 0, 'D55E7E64', 0xE6, 0x01);

    const res = transplantKeys(donor, target);
    // Bytes before the ring buffer should be unchanged (all 0x00 in our test buffer)
    for (let i = 0; i < KEY_RB_BASE; i++) {
      expect(res.patched[i]).toBe(target[i]);
    }
    // Bytes after the ring buffer should also be unchanged
    const rbEnd = KEY_RB_BASE + KEY_SLOT_COUNT * KEY_ENTRY_SZ;
    for (let i = rbEnd; i < RFHUB_MIN_SIZE; i++) {
      expect(res.patched[i]).toBe(target[i]);
    }
  });
});
