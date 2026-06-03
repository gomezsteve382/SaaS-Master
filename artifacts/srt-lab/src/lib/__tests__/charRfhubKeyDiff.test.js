/* ============================================================================
 * charRfhubKeyDiff.test.js — before/after key-table diff harness (Task #1115).
 *
 * Validates diffCharKeyTables: the harness that confirms a REAL before/after
 * RFHUB capture added exactly ONE key, in the slot addCharKey would pick
 * (highest free slot), and reports any change OUTSIDE the key table as a
 * candidate companion table.
 *
 * NOTE on ground truth: an exhaustive pairwise scan of every dump bundled in
 * exports/RFHUB_INDEX_CRACK_KIT/dumps/ found NO genuine single-key-add pair —
 * every same-master pair is byte-identical in its key set, and every key-set
 * difference is a full cross-vehicle re-key (master secret changes). So this
 * suite drives the harness with synthetic-but-faithful tables built from the
 * same primitives the addCharKey suite uses; it is ready to validate a real
 * pair the moment one is bench-captured and committed. We do NOT fabricate a
 * "real" pair to make a green test — that would defeat the verification.
 * ========================================================================== */
import { describe, it, expect } from 'vitest';
import {
  CHAR_KEYTABLE_BASE,
  CHAR_KEYTABLE_STRIDE,
  CHAR_KEYTABLE_SLOTS,
  CHAR_MASTER_OFFSET,
  keyIdToRevUid,
  addCharKey,
  lastFreeCharSlot,
  diffCharKeyTables,
} from '../charRfhubKeyTable.js';

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
  // Distinct, non-zero master secret so the master-change tell can be exercised.
  for (let i = 0; i < 16; i++) buf[CHAR_MASTER_OFFSET + i] = 0xA0 + i;
  writeSlot(buf, 0, [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00]); // empty
  writeSlot(buf, 1, [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00]); // empty
  REF_KEYS.forEach((k, i) => {
    const rev = keyIdToRevUid(k.keyId);
    writeSlot(buf, 2 + i, [rev[0], rev[1], rev[2], rev[3], k.idx, 0x01]);
  });
  // Faithful slot-8 boundary (next table abuts; trailing bytes are not FF FF).
  const slot8 = CHAR_KEYTABLE_BASE + 7 * CHAR_KEYTABLE_STRIDE;
  buf[slot8 + 14] = 0x00; buf[slot8 + 15] = 0x6C;
  return buf;
}

describe('diffCharKeyTables — refuse-on-doubt input gate', () => {
  it('returns ok:false when before is not a Charger key table', () => {
    const r = diffCharKeyTables(new Uint8Array(4096), buildRef());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/before:/);
  });
  it('returns ok:false when after is not a Charger key table', () => {
    const r = diffCharKeyTables(buildRef(), new Uint8Array(2048));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/after:/);
  });
});

describe('diffCharKeyTables — single key-add (addCharKey self-consistency)', () => {
  it('detects exactly one added key in the highest free slot, no companion region, master unchanged', () => {
    const before = buildRef();
    const added = addCharKey(before, { keyId: 'BCD2EB9B' });
    expect(added.ok).toBe(true);
    const after = added.bytes;

    const d = diffCharKeyTables(before, after);
    expect(d.ok).toBe(true);
    expect(d.isSingleKeyAdd).toBe(true);
    expect(d.addedKeys.map(k => k.keyId)).toEqual(['BCD2EB9B']);
    expect(d.removedKeys).toEqual([]);
    expect(d.masterChanged).toBe(false);

    // Highest-free-slot rule: the inserted slot must equal lastFreeCharSlot(before).
    expect(d.expectedSlotIdx).toBe(lastFreeCharSlot(before));
    expect(d.addedKeys[0].slotIdx).toBe(d.expectedSlotIdx);
    expect(d.addedSlotMatchesRule).toBe(true);

    // The only changed bytes are inside the key table — no candidate companion table.
    expect(d.keyTableChanged).toBe(true);
    expect(d.companionRegions).toEqual([]);
    const tableEnd = CHAR_KEYTABLE_BASE + CHAR_KEYTABLE_SLOTS * CHAR_KEYTABLE_STRIDE;
    for (const run of d.changedRegions) {
      expect(run.start).toBeGreaterThanOrEqual(CHAR_KEYTABLE_BASE);
      expect(run.end).toBeLessThan(tableEnd);
    }

    expect(d.beforeKeyCount).toBe(6);
    expect(d.afterKeyCount).toBe(7);
  });
});

describe('diffCharKeyTables — companion-table candidate detection', () => {
  it('reports a changed run OUTSIDE the key table as a companion-table candidate', () => {
    const before = buildRef();
    const added = addCharKey(before, { keyId: 'BCD2EB9B' });
    const after = added.bytes.slice();
    // Simulate a second changed region far from the key table and the master
    // (e.g. a usage-counter / companion table an offline add would also touch).
    const companionOff = 0x0400;
    after[companionOff] ^= 0xFF;
    after[companionOff + 1] ^= 0xFF;

    const d = diffCharKeyTables(before, after);
    expect(d.ok).toBe(true);
    expect(d.companionRegions.length).toBe(1);
    expect(d.companionRegions[0].start).toBe(companionOff);
    // A clean single key-add still holds for the key delta itself…
    expect(d.addedKeys.map(k => k.keyId)).toEqual(['BCD2EB9B']);
    // …but the presence of an unexplained companion region is surfaced for review.
    expect(d.keyTableChanged).toBe(true);
  });
});

describe('diffCharKeyTables — full re-key / cross-vehicle pairing', () => {
  it('flags a master-secret change and refuses to call it a single key-add', () => {
    const before = buildRef();
    const added = addCharKey(before, { keyId: 'BCD2EB9B' });
    const after = added.bytes.slice();
    // Change the 16-byte vehicle master — the tell of a full re-sync.
    after[CHAR_MASTER_OFFSET] ^= 0xFF;

    const d = diffCharKeyTables(before, after);
    expect(d.ok).toBe(true);
    expect(d.masterChanged).toBe(true);
    expect(d.isSingleKeyAdd).toBe(false);
    // Slot-rule fields are only computed for a clean single add.
    expect(d.expectedSlotIdx).toBeNull();
    expect(d.addedSlotMatchesRule).toBeNull();
    // The master window is classified as such, never as a companion region.
    expect(d.companionRegions.every(r => r.start !== CHAR_MASTER_OFFSET)).toBe(true);
  });
});

describe('diffCharKeyTables — removed key detection', () => {
  it('reports a key present in before but missing in after', () => {
    const before = buildRef();
    // Build an "after" that drops the last key (slot 8) back to an empty record.
    const after = before.slice();
    writeSlot(after, 7, [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00]);
    // restore the real slot-8 boundary the empty template overwrote
    const slot8 = CHAR_KEYTABLE_BASE + 7 * CHAR_KEYTABLE_STRIDE;
    after[slot8 + 14] = 0x00; after[slot8 + 15] = 0x6C;

    const d = diffCharKeyTables(before, after);
    expect(d.ok).toBe(true);
    expect(d.removedKeys.map(k => k.keyId)).toEqual(['C47D6C9E']);
    expect(d.addedKeys).toEqual([]);
    expect(d.isSingleKeyAdd).toBe(false);
  });
});
