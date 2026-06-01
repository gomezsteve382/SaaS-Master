/* ============================================================================
 * keyDump.test.js — Task #985
 *
 * Standalone key-dump capture / clone / export:
 *   - validateKeyRecord refuse-on-doubt gates (good / blank / wrong-length /
 *     unknown family)
 *   - cloneKeyRecord ("Copy to new key") gets a fresh id + "(copy)" label
 *   - buildKeyDumpManifest JSON shape + SK-vs-SEC16 honesty note
 *   - buildKeyDumpBin / parseKeyDumpBin round-trip (incl. flags byte)
 *   - writeKeyRecordToSlot ("clone on bench") stamps UID into a free slot,
 *     sets the AA-50 marker, refuses occupied/blank, leaves payloadKnown false
 * ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  makeKeyRecord,
  cloneKeyRecord,
  validateKeyRecord,
} from '../keyWriter/keyRecord.js';
import {
  buildKeyDumpManifest,
  buildKeyDumpBin,
  parseKeyDumpBin,
  keyDumpBaseName,
} from '../keyWriter/autelExport.js';
import { writeKeyRecordToSlot, parseKeySlots } from '../rfhubKeySlots.js';
import { makeRfhubGen2 } from '../__fixtures__/buildFixtures.js';

/* Canonical reference read (an external Autel/VVDI dump of an ID46 chip). */
const REF = {
  chipId: 'id46',
  uidHex: '00 77 A2 9B',          // 4 bytes
  skHex: '4F 4E 4D 49 4B 52',     // 6 bytes
  label: 'spare fob #2',
};

function refRecord(over = {}) {
  return makeKeyRecord({ ...REF, ...over });
}

describe('validateKeyRecord — refuse-on-doubt', () => {
  it('accepts a well-formed ID46 read', () => {
    const v = validateKeyRecord(refRecord());
    expect(v.ok).toBe(true);
    expect([...v.uid]).toEqual([0x00, 0x77, 0xA2, 0x9B]);
    expect([...v.sk]).toEqual([0x4F, 0x4E, 0x4D, 0x49, 0x4B, 0x52]);
    expect(v.chipDef.id).toBe('id46');
  });

  it('refuses an unknown chip family', () => {
    const v = validateKeyRecord(refRecord({ chipId: 'not-a-chip' }));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/unknown chip family/i);
  });

  it('refuses a blank (all-FF) UID', () => {
    const v = validateKeyRecord(refRecord({ uidHex: 'FF FF FF FF' }));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/uid/i);
  });

  it('refuses a blank (all-00) SK', () => {
    const v = validateKeyRecord(refRecord({ skHex: '00 00 00 00 00 00' }));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/sk/i);
  });

  it('refuses a wrong-length UID for the family', () => {
    const v = validateKeyRecord(refRecord({ uidHex: '00 77 A2' })); // 3 B, expect 4
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/uid length/i);
  });

  it('refuses a wrong-length SK for the family', () => {
    const v = validateKeyRecord(refRecord({ skHex: '4F 4E 4D 49' })); // 4 B, expect 6
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/sk length/i);
  });

  it('refuses malformed hex (odd nibble count)', () => {
    const v = validateKeyRecord(refRecord({ uidHex: '00 77 A2 9' }));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/hex/i);
  });
});

describe('cloneKeyRecord — Copy to new key', () => {
  it('produces a fresh id and a "(copy)" label, carrying SK/UID over', () => {
    const orig = refRecord();
    const copy = cloneKeyRecord(orig);
    expect(copy.id).not.toBe(orig.id);
    expect(copy.label).toBe('spare fob #2 (copy)');
    expect(copy.uidHex).toBe(orig.uidHex);
    expect(copy.skHex).toBe(orig.skHex);
    expect(copy.chipId).toBe(orig.chipId);
    // flags are a separate object, not a shared reference
    expect(copy.flags).not.toBe(orig.flags);
    expect(copy.flags).toEqual(orig.flags);
  });
});

describe('buildKeyDumpManifest — JSON manifest', () => {
  it('serializes the record with an explicit SK-vs-SEC16 warning', () => {
    const rec = refRecord();
    const json = buildKeyDumpManifest(rec);
    const obj = JSON.parse(json);
    expect(obj.format).toBe('srt-lab-key-dump');
    expect(obj.chip_family).toBe('id46');
    expect(obj.transponder_uid_hex_compact).toBe('0077A29B');
    expect(obj.sk_hex_compact).toBe('4F4E4D494B52');
    expect(obj._sk_warning).toMatch(/SEC16/);
    expect(obj.flags).toMatchObject({ coding: 'manchester', encryption: true, cloneable: true });
  });

  it('throws on an invalid record rather than emitting garbage', () => {
    expect(() => buildKeyDumpManifest(refRecord({ uidHex: '' }))).toThrow();
  });
});

describe('buildKeyDumpBin / parseKeyDumpBin — round-trip', () => {
  it('round-trips uid, sk, chip family and flags', () => {
    const rec = refRecord({ flags: { locked: true, coding: 'fsk', encryption: false, cloneable: true } });
    const v = validateKeyRecord(rec);
    expect(v.ok).toBe(true);
    const bin = buildKeyDumpBin({ uid: v.uid, sk: v.sk, flags: rec.flags, chipId: rec.chipId });

    // magic "KDMP"
    expect([...bin.slice(0, 4)]).toEqual([0x4B, 0x44, 0x4D, 0x50]);

    const back = parseKeyDumpBin(bin);
    expect(back.ok).toBe(true);
    expect(back.chipId).toBe('id46');
    expect([...back.uid]).toEqual([...v.uid]);
    expect([...back.sk]).toEqual([...v.sk]);
    expect(back.flags).toMatchObject({ locked: true, coding: 'fsk', encryption: false, cloneable: true });
  });

  it('rejects a buffer with the wrong magic', () => {
    const bad = new Uint8Array([0x41, 0x55, 0x54, 0x4C, 0x01, 0x00, 0x00, 0x00, 0x00]);
    const r = parseKeyDumpBin(bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/magic/i);
  });

  it('rejects a truncated payload', () => {
    const rec = refRecord();
    const v = validateKeyRecord(rec);
    const bin = buildKeyDumpBin({ uid: v.uid, sk: v.sk, flags: rec.flags, chipId: rec.chipId });
    const r = parseKeyDumpBin(bin.slice(0, bin.length - 3));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/truncated/i);
  });
});

describe('keyDumpBaseName', () => {
  it('sanitizes the label into a safe stem', () => {
    expect(keyDumpBaseName(refRecord())).toBe('spare_fob__2_keydump');
  });
  it('falls back to the chip family when unlabeled', () => {
    expect(keyDumpBaseName(makeKeyRecord({ chipId: 'id46' }))).toBe('keydump_id46_keydump');
  });
});

describe('writeKeyRecordToSlot — clone on bench (UID into a free RFHUB slot)', () => {
  it('stamps the captured UID into a free slot and sets AA-50', () => {
    const rfh = makeRfhubGen2({ fobikSlots: 1 }); // slot 0 occupied, 1-3 free
    const v = validateKeyRecord(refRecord());
    const r = writeKeyRecordToSlot(rfh, 1, { uid: v.uid });
    expect(r.ok).toBe(true);
    expect(r.slotIdx).toBe(1);
    expect(r.payloadKnown).toBe(false);

    // AA-50 marker set at the Gen2 base (0x0880 + idx*2)
    expect(r.bytes[0x0880 + 1 * 2]).toBe(0xAA);
    expect(r.bytes[0x0880 + 1 * 2 + 1]).toBe(0x50);

    // UID written into the ID block (0x0888 + idx*8); trailing payload zeroed
    const idOff = 0x0888 + 1 * 8;
    expect([...r.bytes.slice(idOff, idOff + 4)]).toEqual([0x00, 0x77, 0xA2, 0x9B]);
    expect([...r.bytes.slice(idOff + 4, idOff + 8)]).toEqual([0, 0, 0, 0]);

    // The patched dump re-parses with the slot now occupied
    const p = parseKeySlots(r.bytes);
    expect(p.ok).toBe(true);
    expect(p.slots[1].occupied).toBe(true);

    // Source buffer is untouched
    expect(rfh[0x0880 + 1 * 2]).toBe(0xFF);
  });

  it('writes the optional payload when supplied (payloadKnown true)', () => {
    const rfh = makeRfhubGen2({ fobikSlots: 1 });
    const v = validateKeyRecord(refRecord());
    const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const r = writeKeyRecordToSlot(rfh, 2, { uid: v.uid, payload });
    expect(r.ok).toBe(true);
    expect(r.payloadKnown).toBe(true);
    const idOff = 0x0888 + 2 * 8;
    expect([...r.bytes.slice(idOff, idOff + 8)]).toEqual([0x00, 0x77, 0xA2, 0x9B, 0xDE, 0xAD, 0xBE, 0xEF]);
  });

  it('refuses an already-occupied slot unless overwrite is set', () => {
    const rfh = makeRfhubGen2({ fobikSlots: 1 }); // slot 0 occupied
    const v = validateKeyRecord(refRecord());
    const refused = writeKeyRecordToSlot(rfh, 0, { uid: v.uid });
    expect(refused.ok).toBe(false);
    expect(refused.alreadyOccupied).toBe(true);

    const forced = writeKeyRecordToSlot(rfh, 0, { uid: v.uid, overwrite: true });
    expect(forced.ok).toBe(true);
  });

  it('refuses a missing/empty UID', () => {
    const rfh = makeRfhubGen2({ fobikSlots: 1 });
    expect(writeKeyRecordToSlot(rfh, 1, { uid: new Uint8Array(0) }).ok).toBe(false);
    expect(writeKeyRecordToSlot(rfh, 1, {}).ok).toBe(false);
  });

  it('refuses a buffer that is not a recognized RFHUB image', () => {
    const fake = new Uint8Array(4096).fill(0xFF); // no AA 55 31 01 header
    const v = validateKeyRecord(refRecord());
    expect(writeKeyRecordToSlot(fake, 1, { uid: v.uid }).ok).toBe(false);
  });

  it('refuses an out-of-range slot index', () => {
    const rfh = makeRfhubGen2({ fobikSlots: 1 });
    const v = validateKeyRecord(refRecord());
    expect(writeKeyRecordToSlot(rfh, 9, { uid: v.uid }).ok).toBe(false);
  });
});
