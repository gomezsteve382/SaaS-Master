import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHAR_KEYTABLE_BASE,
  CHAR_KEYTABLE_STRIDE,
  CHAR_KEY_DEFAULT_INDEX,
  CHAR_KEY_FLAG_ALT,
  keyIdToRevUid,
  revUidToKeyId,
  isCharRfhubKeyTable,
  parseCharKeyTable,
  firstFreeCharSlot,
  lastFreeCharSlot,
  addCharKey,
  deriveCharKeyIndex,
  CHAR_KEY_INDEX_CHECK,
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

// Faithful slot-8 boundary: on real dumps the next structure (4-byte trailer + aux table)
// abuts the last key slot, so slot 8's trailing two bytes are NOT FF FF —
// reference car has 00 6C at 0xCDC-0xCDD. Reproducing that here means a
// regression of the slot-8 over-strict gate would fail a test instead of being
// masked by FF FF padding (which never occurs on a real car).
const SLOT8_TRAILING = [0x00, 0x6C];

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
  // Overwrite the FF FF that writeSlot stamped after slot 8's mirror with the
  // real next-table boundary bytes.
  const slot8 = CHAR_KEYTABLE_BASE + 7 * CHAR_KEYTABLE_STRIDE;
  buf[slot8 + 14] = SLOT8_TRAILING[0];
  buf[slot8 + 15] = SLOT8_TRAILING[1];
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

describe('charRfhubKeyTable — deriveCharKeyIndex', () => {
  it('reproduces all six known Charger 6.2 key/index pairs', () => {
    REF_KEYS.forEach(({ keyId, idx }) => {
      expect(deriveCharKeyIndex(keyId)).toBe(idx);
    });
  });

  it('is byte-order independent (Key ID and reversed UID give the same index)', () => {
    REF_KEYS.forEach(({ keyId }) => {
      expect(deriveCharKeyIndex(Array.from(keyIdToRevUid(keyId)))).toBe(deriveCharKeyIndex(keyId));
    });
  });

  it('satisfies the mod-255 checksum invariant (sum(keyId)+index ≡ CHECK)', () => {
    REF_KEYS.forEach(({ keyId, idx }) => {
      const sum = (keyId.match(/../g)).reduce((a, h) => a + parseInt(h, 16), 0);
      expect((sum + idx) % 255).toBe(CHAR_KEY_INDEX_CHECK % 255);
    });
  });

  it('returns a byte in 0x00–0xFE (never the 0xFF separator) and is deterministic', () => {
    const v = deriveCharKeyIndex('BCD2EB9B');
    expect(v).toBe(0xE6);
    expect(v).toBeGreaterThanOrEqual(0x00);
    expect(v).toBeLessThanOrEqual(0xFE);
    expect(deriveCharKeyIndex('BCD2EB9B')).toBe(v);
  });

  it('rejects malformed Key IDs', () => {
    expect(() => deriveCharKeyIndex('BCD2EB9')).toThrow();
    expect(() => deriveCharKeyIndex('ZZZZZZZZ')).toThrow();
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
  it('lastFreeCharSlot returns the highest empty (0-based) — the hole below the key block', () => {
    // Reference layout: slots 1-2 empty (idx 0,1), keys 3-8. Highest empty = slot 2 (idx 1).
    expect(lastFreeCharSlot(buildRef())).toBe(1);
  });

  it('accepts a faithful dump whose LAST slot trailing separator is NOT FF FF (real boundary)', () => {
    const buf = buildRef();
    const slot8 = CHAR_KEYTABLE_BASE + 7 * CHAR_KEYTABLE_STRIDE;
    // Guard: the fixture must reproduce the real boundary, not pad it with FF FF.
    expect([buf[slot8 + 14], buf[slot8 + 15]]).toEqual([0x00, 0x6C]);
    // The defect this regresses: requiring FF FF on the last slot rejected
    // every real 4 KB Charger RFHUB dump, including the reference car.
    expect(isCharRfhubKeyTable(buf)).toBe(true);
    const p = parseCharKeyTable(buf);
    expect(p.ok).toBe(true);
    expect(p.keyCount).toBe(6);
    expect(p.slots[7].keyId).toBe('C47D6C9E'); // slot 8 still parses as a key
    expect(p.slots[7].mirrorOk).toBe(true);
  });

  it('still enforces the mirror on the last slot (gate not over-loosened)', () => {
    const buf = buildRef();
    const slot8 = CHAR_KEYTABLE_BASE + 7 * CHAR_KEYTABLE_STRIDE;
    buf[slot8 + 8] ^= 0xFF; // break the first byte of slot 8's mirror copy
    expect(isCharRfhubKeyTable(buf)).toBe(false);
  });
});

describe('charRfhubKeyTable — addCharKey', () => {
  it('adds a new key into the HIGHEST free slot (corpus-aligned), both mirrors, deriving the index byte', () => {
    const src = buildRef();
    const r = addCharKey(src, { keyId: 'BCD2EB9B' });
    expect(r.ok).toBe(true);
    // Reference layout has slots 1-2 empty; the new key fills the HIGHEST empty
    // slot (slot 2), the hole directly below the key block — not slot 1. This
    // keeps the keys contiguous and ending at slot 8, matching every real dump.
    expect(r.slot).toBe(2);
    // Index is now derived from the Key ID (mod-255 checksum), not the 0x95 placeholder.
    expect(r.indexLow).toBe(deriveCharKeyIndex('BCD2EB9B'));
    expect(r.indexLow).toBe(0xE6);
    expect(r.indexLow).not.toBe(CHAR_KEY_DEFAULT_INDEX);
    expect(r.indexDerived).toBe(true);
    expect(r.keyCountAfter).toBe(7);

    // original untouched
    expect(src).toEqual(buildRef());

    // exactly the record + mirror bytes that differ from the empty template.
    // The derived index 0xE6 differs from the template low byte 0x95, so all
    // 6 bytes/record change (vs 5 when the old placeholder matched), x2 mirrors.
    let diffs = 0;
    for (let i = 0; i < src.length; i++) if (src[i] !== r.bytes[i]) diffs++;
    expect(diffs).toBe(12);

    const p = parseCharKeyTable(r.bytes);
    expect(p.keyCount).toBe(7);
    const added = p.slots.find(s => s.keyId === 'BCD2EB9B');
    expect(added.slot).toBe(2);
    expect(added.flag).toBe(0x01);
    expect(added.indexLow).toBe(0xE6);
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

/* ─────────────────────── flag 0x03 (alternate family) ─────────────────────
 * Real OG dumps from VIN 2C3CDXCT1HH652640 (2020 6.2 Redeye) carry key records
 * in slots 6-8 with flag 0x03 (a different transponder family — see the FLAG
 * 0x03 box in charRfhubKeyTable.js). These were previously lumped into the
 * catch-all 'unknown' state and so excluded from the known-good registry. The
 * parser now recognizes them as real keys (state 'key', keyKind 'alt') WITHOUT
 * widening the refuse-on-doubt write gate. This block pins both halves of that. */
const FIXTURE_652640 = resolve(
  __dirname,
  '../../__tests__/fixtures/SAMPLE_RFHUB_EEE_OG_2C3CDXCT1HH652640.bin',
);
const FIXTURE_652640_PF = resolve(
  __dirname,
  '../../__tests__/fixtures/SAMPLE_RFHUB_PFLASH_OG_2C3CDXCT1HH652640.bin',
);
function load652640() {
  return new Uint8Array(readFileSync(FIXTURE_652640));
}

describe('charRfhubKeyTable — flag 0x03 alternate-family keys (real 652640 dump)', () => {
  it('parses the EEE OG dump as a valid 8-slot table', () => {
    const buf = load652640();
    expect(buf.length).toBe(4096);
    expect(isCharRfhubKeyTable(buf)).toBe(true);
  });

  it('recognizes the three 0x03 records as real keys, not unknown', () => {
    const p = parseCharKeyTable(load652640());
    expect(p.ok).toBe(true);
    // 3 keys (slots 6-8), 5 empty (slots 1-5), 0 unknown.
    expect(p.keyCount).toBe(3);
    expect(p.unknownCount).toBe(0);
    expect(p.slots.filter((s) => s.empty).map((s) => s.slot)).toEqual([1, 2, 3, 4, 5]);

    const altSlots = p.slots.filter((s) => s.state === 'key');
    expect(altSlots.map((s) => s.slot)).toEqual([6, 7, 8]);
    // Every recognized key here is the alternate family, flag 0x03, mirror-verified.
    for (const s of altSlots) {
      expect(s.flag).toBe(CHAR_KEY_FLAG_ALT);
      expect(s.keyKind).toBe('alt');
      expect(s.empty).toBe(false);
      expect(s.mirrorOk).toBe(true);
      expect(s.keyId).toMatch(/^[0-9A-F]{8}$/);
    }
    // The 0x03 Key IDs are NOT Hitag2 (they do not end in 9B/9F/9E) — that is
    // exactly why they are a distinct family, not 0x01 keys.
    expect(altSlots.map((s) => s.keyId)).toEqual(['BFA40065', '2369DA69', '1248C964']);
  });

  it('EEE and P-FLASH dumps of the same car parse identically', () => {
    const a = parseCharKeyTable(new Uint8Array(readFileSync(FIXTURE_652640)));
    const b = parseCharKeyTable(new Uint8Array(readFileSync(FIXTURE_652640_PF)));
    expect(b.keyCount).toBe(a.keyCount);
    expect(b.slots.map((s) => s.keyId)).toEqual(a.slots.map((s) => s.keyId));
    expect(b.slots.map((s) => s.keyKind)).toEqual(a.slots.map((s) => s.keyKind));
  });

  it('keeps the write gate fail-closed over an 0x03 (alt) key — no overwrite, dup by UID', () => {
    const buf = load652640();
    // Slot 6 (idx 5) holds an alt key; an explicit add there must refuse.
    const occupied = addCharKey(buf, { keyId: 'BCD2EB9B', slotIdx: 5 });
    expect(occupied.ok).toBe(false);
    expect(occupied.slotOccupied).toBe(true);

    // Adding a key whose UID already exists as an 0x03 record is a duplicate.
    const p = parseCharKeyTable(buf);
    const existingAltKeyId = p.slots.find((s) => s.keyKind === 'alt').keyId;
    const dup = addCharKey(buf, { keyId: existingAltKeyId });
    expect(dup.ok).toBe(false);
    expect(dup.duplicate).toBe(true);

    // firstFree still lands on a genuine empty slot (1), never on an alt key.
    expect(firstFreeCharSlot(buf)).toBe(0);
  });

  it('still writes flag 0x01 Hitag2 records (alt family is never synthesized)', () => {
    // Real dump: slots 1-5 empty, alt keys in 6-8. The default lands in the
    // HIGHEST empty slot (slot 5, idx 4) — the hole directly below the block —
    // so the result keeps the keys contiguous (slots 5-8), exactly like a real
    // car. firstFree would have dropped it into slot 1 with a 4-slot gap.
    const r = addCharKey(load652640(), { keyId: 'BCD2EB9B', indexLow: 0x22 });
    expect(r.ok).toBe(true);
    expect(r.slot).toBe(5);
    const p = parseCharKeyTable(r.bytes);
    const added = p.slots.find((s) => s.keyId === 'BCD2EB9B');
    expect(added.flag).toBe(0x01);
    expect(added.keyKind).toBe('hitag2');
    // Keys are now a contiguous block ending at slot 8 (slots 5,6,7,8).
    expect(p.slots.filter((s) => s.state === 'key').map((s) => s.slot)).toEqual([5, 6, 7, 8]);
    // The pre-existing alt keys are untouched and still recognized.
    expect(p.slots.filter((s) => s.keyKind === 'alt').length).toBe(3);
    expect(p.keyCount).toBe(4);
  });

  it('an unrecognized flag (not 0x01/0x03) is still unknown — gate not widened', () => {
    const buf = load652640();
    // Corrupt slot 6's flag byte (both record + mirror) to a never-seen value.
    const off = CHAR_KEYTABLE_BASE + 5 * CHAR_KEYTABLE_STRIDE;
    buf[off + 5] = 0x07;
    buf[off + 8 + 5] = 0x07;
    const p = parseCharKeyTable(buf);
    expect(p.slots[5].state).toBe('unknown');
    expect(p.slots[5].keyKind).toBe(null);
    expect(p.unknownCount).toBe(1);
    expect(p.keyCount).toBe(2); // the other two 0x03 keys still count
  });
});
