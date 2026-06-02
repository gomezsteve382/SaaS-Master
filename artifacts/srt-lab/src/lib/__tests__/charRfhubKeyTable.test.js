import { describe, it, expect } from 'vitest';
import {
  CHAR_KEYTABLE_BASE,
  CHAR_KEYTABLE_STRIDE,
  CHAR_KEY_DEFAULT_INDEX,
  keyIdToRevUid,
  revUidToKeyId,
  isCharRfhubKeyTable,
  parseCharKeyTable,
  firstFreeCharSlot,
  addCharKey,
} from '../charRfhubKeyTable.js';

// Build a synthetic-but-faithful 4 KB Charger RFHUB key-table buffer.
// 8 slots @0xC5E stride 16: each = [rec 6B] FF FF [rec 6B] FF FF.
// Reference layout: slots 1-2 empty (5A5A5A5A 9500), slots 3-8 = real keys.
const REF_KEYS = [
  { keyId: '0077A29B', idx: 0x48 },
  { keyId: 'CC62209F', idx: 0x0F },
  { keyId: '09A6629F', idx: 0x4C },
  { keyId: '91654F9E', idx: 0x19 },
  { keyId: '197E6C9E', idx: 0x5B },
  { keyId: 'C47D6C9E', idx: 0xB0 },
];

function writeSlot(buf, slotIdx, rec6) {
  const off = CHAR_KEYTABLE_BASE + slotIdx * CHAR_KEYTABLE_STRIDE;
  for (let k = 0; k < 6; k++) { buf[off + k] = rec6[k]; buf[off + 8 + k] = rec6[k]; }
  buf[off + 6] = 0xFF; buf[off + 7] = 0xFF;
  buf[off + 14] = 0xFF; buf[off + 15] = 0xFF;
}

function buildRef() {
  const buf = new Uint8Array(4096).fill(0x00);
  // empty slots 1-2
  writeSlot(buf, 0, [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00]);
  writeSlot(buf, 1, [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00]);
  // keys 3-8
  REF_KEYS.forEach((k, i) => {
    const rev = keyIdToRevUid(k.keyId);
    writeSlot(buf, 2 + i, [rev[0], rev[1], rev[2], rev[3], k.idx, 0x01]);
  });
  return buf;
}

describe('charRfhubKeyTable — UID conversion', () => {
  it('byte-reverses Autel Key ID to stored UID', () => {
    expect(Array.from(keyIdToRevUid('BCD2EB9B'))).toEqual([0x9B, 0xEB, 0xD2, 0xBC]);
    expect(Array.from(keyIdToRevUid('0077A29B'))).toEqual([0x9B, 0xA2, 0x77, 0x00]);
  });
  it('round-trips revUid back to Key ID', () => {
    expect(revUidToKeyId(keyIdToRevUid('BCD2EB9B'))).toBe('BCD2EB9B');
    expect(revUidToKeyId(keyIdToRevUid('C47D6C9E'))).toBe('C47D6C9E');
  });
  it('rejects malformed Key IDs', () => {
    expect(() => keyIdToRevUid('BCD2EB9')).toThrow();
    expect(() => keyIdToRevUid('ZZZZZZZZ')).toThrow();
  });
});

describe('charRfhubKeyTable — detection & parse', () => {
  it('accepts the reference table', () => {
    expect(isCharRfhubKeyTable(buildRef())).toBe(true);
  });
  it('rejects wrong sizes and unrelated buffers', () => {
    expect(isCharRfhubKeyTable(new Uint8Array(2048))).toBe(false);
    expect(isCharRfhubKeyTable(new Uint8Array(4096))).toBe(false); // all zero -> no FF separators
  });
  it('parses 6 keys and 2 empty slots', () => {
    const p = parseCharKeyTable(buildRef());
    expect(p.ok).toBe(true);
    expect(p.keyCount).toBe(6);
    expect(p.slots.filter(s => s.empty).map(s => s.slot)).toEqual([1, 2]);
    expect(p.slots[2].keyId).toBe('0077A29B');
    expect(p.slots[2].indexLow).toBe(0x48);
    expect(p.slots.every(s => s.mirrorOk)).toBe(true);
  });
  it('firstFreeCharSlot returns the first empty (0-based)', () => {
    expect(firstFreeCharSlot(buildRef())).toBe(0);
  });
});

describe('charRfhubKeyTable — addCharKey', () => {
  it('adds a new key into the first free slot, both mirrors, only 10 bytes change', () => {
    const src = buildRef();
    const r = addCharKey(src, { keyId: 'BCD2EB9B' });
    expect(r.ok).toBe(true);
    expect(r.slot).toBe(1);
    expect(r.indexLow).toBe(CHAR_KEY_DEFAULT_INDEX);
    expect(r.keyCountAfter).toBe(7);

    // original untouched
    expect(src).toEqual(buildRef());

    // exactly the record + mirror bytes that differ from the empty template
    let diffs = 0;
    for (let i = 0; i < src.length; i++) if (src[i] !== r.bytes[i]) diffs++;
    expect(diffs).toBe(10); // 5 bytes/record (low byte 0x95 unchanged) x2 mirrors

    const p = parseCharKeyTable(r.bytes);
    expect(p.keyCount).toBe(7);
    const added = p.slots.find(s => s.keyId === 'BCD2EB9B');
    expect(added.slot).toBe(1);
    expect(added.flag).toBe(0x01);
    expect(added.mirrorOk).toBe(true);
  });

  it('refuses a duplicate key', () => {
    const r = addCharKey(buildRef(), { keyId: '0077A29B' });
    expect(r.ok).toBe(false);
    expect(r.duplicate).toBe(true);
  });

  it('refuses an index that collides with an existing key', () => {
    const r = addCharKey(buildRef(), { keyId: 'BCD2EB9B', indexLow: 0x48 });
    expect(r.ok).toBe(false);
    expect(r.indexClash).toBe(true);
  });

  it('refuses when the table is full', () => {
    // fill the 2 empty slots first
    let buf = addCharKey(buildRef(), { keyId: 'BCD2EB9B', indexLow: 0x95 }).bytes;
    buf = addCharKey(buf, { keyId: 'AABBCC9E', indexLow: 0x22 }).bytes;
    const r = addCharKey(buf, { keyId: 'DDEEFF9F', indexLow: 0x33 });
    expect(r.ok).toBe(false);
    expect(r.tableFull).toBe(true);
  });

  it('refuses an unrecognized buffer', () => {
    const r = addCharKey(new Uint8Array(4096), { keyId: 'BCD2EB9B' });
    expect(r.ok).toBe(false);
  });

  it('treats a non-template / non-0x01 record as unknown, never free, never overwritten', () => {
    const buf = buildRef();
    // Corrupt slot 1 into a non-canonical, non-key record (flag 0x7F, no 5A filler).
    writeSlot(buf, 0, [0x11, 0x22, 0x33, 0x44, 0x55, 0x7F]);
    const p = parseCharKeyTable(buf);
    expect(p.slots[0].state).toBe('unknown');
    expect(p.slots[0].empty).toBe(false);
    expect(p.unknownCount).toBe(1);
    // firstFree must skip the unknown slot and land on the genuine empty slot 2 (idx 1)
    expect(firstFreeCharSlot(buf)).toBe(1);
    // explicit add to the unknown slot must refuse (fail-closed, no overwrite)
    const r = addCharKey(buf, { keyId: 'BCD2EB9B', slotIdx: 0 });
    expect(r.ok).toBe(false);
    expect(r.slotOccupied).toBe(true);
  });

  it('refuses a duplicate UID even when the existing record is in an unknown state', () => {
    const buf = buildRef();
    // Put BCD2EB9B's reversed UID into slot 1 but with an unknown flag.
    const rev = keyIdToRevUid('BCD2EB9B');
    writeSlot(buf, 0, [rev[0], rev[1], rev[2], rev[3], 0x95, 0x7F]);
    const r = addCharKey(buf, { keyId: 'BCD2EB9B' });
    expect(r.ok).toBe(false);
    expect(r.duplicate).toBe(true);
  });

  it('rejects a non-integer / out-of-range explicit slotIdx', () => {
    expect(addCharKey(buildRef(), { keyId: 'BCD2EB9B', slotIdx: 9 }).ok).toBe(false);
    expect(addCharKey(buildRef(), { keyId: 'BCD2EB9B', slotIdx: 1.5 }).ok).toBe(false);
  });

  it('honors an explicit free slotIdx', () => {
    const r = addCharKey(buildRef(), { keyId: 'BCD2EB9B', slotIdx: 1 });
    expect(r.ok).toBe(true);
    expect(r.slot).toBe(2);
  });
});
