/* ============================================================================
 * knownWorkingKeys.test.js — registry data + lookup/classify/prefill helpers
 * for the known-good working-key registry (Task #1096).
 * ========================================================================== */
import { describe, it, expect } from 'vitest';
import {
  KNOWN_WORKING_KEYS,
  EMPTY_SLOT_MARKER,
  getKnownWorkingKeys,
  getKnownWorkingKeyById,
  classifyAgainstRegistry,
  knownKeyToRecord,
  knownKeyLabel,
  isEmptySlotMarker,
} from '../keyWriter/knownWorkingKeys.js';
import { validateKeyRecord } from '../keyWriter/keyRecord.js';

const SEED = KNOWN_WORKING_KEYS[0];

describe('knownWorkingKeys — seed ground truth', () => {
  it('seeds the confirmed 2019 Charger 6.2 working key', () => {
    expect(SEED.keyId).toBe('0077A29B');
    expect(SEED.revUid).toBe('9BA27700');
    expect(SEED.chipId).toBe('id46');
    expect(SEED.sk).toBe('502077550100');
    expect(SEED.tableIndex).toBe(0x48);
    expect(SEED.tableFlag).toBe(0x01);
    expect(SEED.tableAddr).toBe(0x0C7E);
  });

  it('revUid is the byte-reversed keyId', () => {
    const rev = SEED.keyId.match(/../g).reverse().join('');
    expect(SEED.revUid).toBe(rev);
  });

  it('SK is the per-chip secret recovered from the Autel read, NOT the universal default', () => {
    // SK is 6 bytes (12 hex chars) for an id46 transponder — never SEC16 (16 B).
    expect(SEED.sk.length).toBe(12);
    // Per-chip read confirmed: SK is recovered straight from this fob's own
    // Autel page read — page1 ∥ the high word of page2 — so it can never drift
    // from the documented `profile`.
    expect(SEED.sk).toBe((SEED.profile.page1 + SEED.profile.page2.slice(0, 4)).toUpperCase());
    // It must differ from the universal MIKRON default the other entries carry,
    // otherwise a wrong secret could never be told apart from the real one.
    expect(SEED.sk).not.toBe('4F4E4D494B52');
  });

  it('every entry is frozen and carries a stable id + provenance', () => {
    expect(Object.isFrozen(KNOWN_WORKING_KEYS)).toBe(true);
    for (const e of KNOWN_WORKING_KEYS) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(typeof e.id).toBe('string');
      expect(e.id.length).toBeGreaterThan(0);
      expect(typeof e.provenance).toBe('string');
    }
  });

  it('no entry reuses the empty-slot sentinel index 0x95', () => {
    for (const e of KNOWN_WORKING_KEYS) {
      expect(e.tableIndex).not.toBe(EMPTY_SLOT_MARKER.index);
    }
  });
});

describe('knownWorkingKeys — lookup helpers', () => {
  it('getKnownWorkingKeyById finds by id, null otherwise', () => {
    expect(getKnownWorkingKeyById(SEED.id)).toBe(SEED);
    expect(getKnownWorkingKeyById('nope')).toBeNull();
    expect(getKnownWorkingKeyById('')).toBeNull();
  });

  it('getKnownWorkingKeys returns globals regardless of VIN', () => {
    // seed is a global (vin: null) → always present
    expect(getKnownWorkingKeys(null).map((e) => e.id)).toContain(SEED.id);
    expect(getKnownWorkingKeys('2C3CDXCT1HH652640').map((e) => e.id)).toContain(SEED.id);
    expect(getKnownWorkingKeys('').map((e) => e.id)).toContain(SEED.id);
  });

  it('getKnownWorkingKeys returns a fresh array (no caller mutation)', () => {
    const a = getKnownWorkingKeys();
    const b = getKnownWorkingKeys();
    expect(a).not.toBe(b);
  });

  it('knownKeyLabel composes vehicle + keyId', () => {
    expect(knownKeyLabel(SEED)).toContain('0077A29B');
    expect(knownKeyLabel(SEED)).toContain(SEED.vehicle);
    expect(knownKeyLabel(null)).toBe('');
  });
});

describe('knownWorkingKeys — empty-slot sentinel', () => {
  it('records the 0x95 / 5A5A5A5A empty-slot marker', () => {
    expect(EMPTY_SLOT_MARKER.index).toBe(0x95);
    expect(EMPTY_SLOT_MARKER.revUid).toBe('5A5A5A5A');
  });

  it('isEmptySlotMarker recognizes index, revUid, and spaced hex', () => {
    expect(isEmptySlotMarker({ index: 0x95 })).toBe(true);
    expect(isEmptySlotMarker({ revUid: '5A5A5A5A' })).toBe(true);
    expect(isEmptySlotMarker({ keyId: '5a 5a 5a 5a' })).toBe(true);
    expect(isEmptySlotMarker({ index: 0x48 })).toBe(false);
    expect(isEmptySlotMarker({ keyId: '0077A29B' })).toBe(false);
    expect(isEmptySlotMarker({})).toBe(false);
  });
});

describe('knownWorkingKeys — classifyAgainstRegistry', () => {
  it('known-good: chipId + UID + SK all match (operator types BE keyId)', () => {
    const r = classifyAgainstRegistry({ chipId: 'id46', uidHex: '00 77 A2 9B', skHex: '50 20 77 55 01 00' });
    expect(r.status).toBe('known-good');
    expect(r.entry.id).toBe(SEED.id);
    expect(r.mismatchedFields).toEqual([]);
  });

  it('known-good is case/separator insensitive', () => {
    const r = classifyAgainstRegistry({ chipId: 'ID46', uidHex: '0077a29b', skHex: '0x502077550100' });
    expect(r.status).toBe('known-good');
  });

  it('mismatch: UID matches but SK differs', () => {
    const r = classifyAgainstRegistry({ chipId: 'id46', uidHex: '0077A29B', skHex: 'DEADBEEFCAFE' });
    expect(r.status).toBe('mismatch');
    expect(r.entry.id).toBe(SEED.id);
    expect(r.mismatchedFields).toContain('sk');
  });

  it('mismatch: the old universal-MIKRON default no longer matches the seed UID', () => {
    // Before per-chip capture, every entry carried 4F4E4D494B52, so this would
    // have read as known-good. Now the seed holds its real per-chip secret, so
    // presenting the universal default against 0077A29B is a `sk` mismatch.
    const r = classifyAgainstRegistry({ chipId: 'id46', uidHex: '0077A29B', skHex: '4F4E4D494B52' });
    expect(r.status).toBe('mismatch');
    expect(r.entry.id).toBe(SEED.id);
    expect(r.mismatchedFields).toContain('sk');
  });

  it('mismatch: UID matches but chip family differs', () => {
    const r = classifyAgainstRegistry({ chipId: 'id48', uidHex: '0077A29B', skHex: '502077550100' });
    expect(r.status).toBe('mismatch');
    expect(r.mismatchedFields).toContain('chipId');
  });

  it('unknown: UID not in registry', () => {
    const r = classifyAgainstRegistry({ chipId: 'id46', uidHex: 'CC62209F', skHex: '4F4E4D494B52' });
    expect(r.status).toBe('unknown');
    expect(r.entry).toBeNull();
  });

  it('unknown (refuse-on-doubt): blank / all-FF / all-00 / empty input', () => {
    expect(classifyAgainstRegistry({ chipId: 'id46', uidHex: '', skHex: '4F4E4D494B52' }).status).toBe('unknown');
    expect(classifyAgainstRegistry({ chipId: 'id46', uidHex: 'FFFFFFFF', skHex: '4F4E4D494B52' }).status).toBe('unknown');
    expect(classifyAgainstRegistry({ chipId: 'id46', uidHex: '00000000', skHex: '4F4E4D494B52' }).status).toBe('unknown');
    expect(classifyAgainstRegistry(null).status).toBe('unknown');
    expect(classifyAgainstRegistry({}).status).toBe('unknown');
  });

  it('unknown: the empty-slot sentinel is never known-good', () => {
    const r = classifyAgainstRegistry({ chipId: 'id46', uidHex: '5A5A5A5A', skHex: '4F4E4D494B52' });
    expect(r.status).toBe('unknown');
  });

  it('unknown (refuse-on-doubt): malformed hex never falls through to mismatch', () => {
    // SK has non-hex chars — must NOT become a UID-only 'mismatch'.
    expect(classifyAgainstRegistry({ chipId: 'id46', uidHex: '0077A29B', skHex: 'NOTHEXVALUE!' }).status).toBe('unknown');
    // Odd-length SK nibble count is malformed.
    expect(classifyAgainstRegistry({ chipId: 'id46', uidHex: '0077A29B', skHex: '4F4E4D494B5' }).status).toBe('unknown');
    // Malformed UID is rejected too.
    expect(classifyAgainstRegistry({ chipId: 'id46', uidHex: '00ZZ29B', skHex: '4F4E4D494B52' }).status).toBe('unknown');
  });
});

describe('knownWorkingKeys — knownKeyToRecord (prefill builder)', () => {
  it('builds a valid, exportable record from the seed', () => {
    const rec = knownKeyToRecord(SEED);
    expect(rec).toBeTruthy();
    expect(rec.chipId).toBe('id46');
    const v = validateKeyRecord(rec);
    expect(v.ok).toBe(true);
    // UID is the BE keyId; SK is the per-chip secret from the read — never SEC16.
    expect(Buffer.from(v.uid).toString('hex').toUpperCase()).toBe('0077A29B');
    expect(Buffer.from(v.sk).toString('hex').toUpperCase()).toBe('502077550100');
  });

  it('a record built from the seed classifies back as known-good', () => {
    const rec = knownKeyToRecord(SEED);
    expect(classifyAgainstRegistry(rec).status).toBe('known-good');
  });

  it('returns null for a null entry or unknown chip family', () => {
    expect(knownKeyToRecord(null)).toBeNull();
    expect(knownKeyToRecord({ ...SEED, chipId: 'totally-unknown-chip' })).toBeNull();
  });
});
