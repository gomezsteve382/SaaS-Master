/* Task #407 — pure-function unit tests for the dual-file RFHub Key Manager
 * helpers. Drives the four mutation primitives plus the master-SEC16 copy
 * across both Gen2 (4 KB) and Gen1 (2 KB) fixtures and asserts the refusal
 * paths return ok:false so the UI can mirror the Task #399 "writer refused
 * → skip download" pattern. */
import { describe, it, expect } from 'vitest';
import {
  parseKeySlots, transferSlot, deleteSlot, addSlot,
  copyMasterSec16, firstFreeSlot, detectGen, keyIdLayoutFor,
  KEY_SLOT_COUNT, AA50_BASE, AA50_BASE_GEN1, AA50_BASE_GEN2,
  aa50BaseFor, slotsEditableFor,
  KEY_ID_BASE_GEN2, KEY_ID_BASE_GEN1, KEY_ID_BLOCK_LEN, KEY_ID_STRIDE,
} from '../rfhubKeySlots.js';
import { makeRfhubGen2, makeRfhubGen1 } from '../__fixtures__/buildFixtures.js';
import { rfhSec16Cs } from '../crc.js';

describe('detectGen', () => {
  it('identifies Gen2 (4096 B), Gen1 (2048 B), and rejects unknown sizes', () => {
    expect(detectGen(new Uint8Array(4096))).toBe('gen2');
    expect(detectGen(new Uint8Array(2048))).toBe('gen1');
    expect(detectGen(new Uint8Array(8192))).toBe('gen2');
    expect(detectGen(new Uint8Array(1024))).toBe('unknown');
    expect(detectGen(null)).toBe('unknown');
  });
});

describe('parseKeySlots — Gen2 fixture', () => {
  it('reads AA-50 occupancy and SEC16 mirror pair', () => {
    const buf = makeRfhubGen2({ fobikSlots: 2 });
    const r = parseKeySlots(buf);
    expect(r.ok).toBe(true);
    expect(r.gen).toBe('gen2');
    expect(r.slots.length).toBe(KEY_SLOT_COUNT);
    expect(r.slots[0].occupied).toBe(true);
    expect(r.slots[1].occupied).toBe(true);
    expect(r.slots[2].occupied).toBe(false);
    expect(r.slots[3].occupied).toBe(false);
    expect(r.slots[0].markerOffset).toBe(AA50_BASE);
    expect(r.sec16.gen).toBe('gen2');
    expect(r.sec16.slots.length).toBe(2);
    expect(r.sec16.slots[0].csOk).toBe(true);
    expect(r.sec16.match).toBe(true);
    // Per-slot Autel transponder ID layout is mapped (Task #408).
    expect(r.slots[0].idMapped).toBe(true);
    expect(r.slots[0].idBytes).not.toBeNull();
    expect(r.slots[0].idBytes.length).toBe(KEY_ID_BLOCK_LEN);
    expect(r.slots[0].idOffset).toBe(KEY_ID_BASE_GEN2);
    expect(r.slots[1].idOffset).toBe(KEY_ID_BASE_GEN2 + KEY_ID_STRIDE);
  });
});

describe('parseKeySlots — Gen1 fixture', () => {
  it('reads AA-50 markers @ 0x00D2 and Gen1 SEC16 offsets', () => {
    const buf = makeRfhubGen1();
    const r = parseKeySlots(buf);
    expect(r.ok).toBe(true);
    expect(r.gen).toBe('gen1');
    expect(r.sec16.offsets).toEqual([0x00AE, 0x00C0]);
    expect(r.sec16.match).toBe(true);
    // Task #409: Gen1 SEC16 CS now uses rfhSec16Cs and is golden.
    expect(r.sec16.slots[0].csOk).toBe(true);
    expect(r.sec16.slots[1].csOk).toBe(true);
    // Default fixture has fobikSlots:0 → all four slots empty.
    expect(r.slots).toHaveLength(KEY_SLOT_COUNT);
    expect(r.slots[0].markerOffset).toBe(AA50_BASE_GEN1);
    expect(r.slots[1].markerOffset).toBe(AA50_BASE_GEN1 + 2);
    for (const s of r.slots) expect(s.occupied).toBe(false);
  });
  it('detects populated Gen1 AA-50 markers when the fixture plants them', () => {
    const buf = makeRfhubGen1({ fobikSlots: 3 });
    const r = parseKeySlots(buf);
    expect(r.slots[0].occupied).toBe(true);
    expect(r.slots[1].occupied).toBe(true);
    expect(r.slots[2].occupied).toBe(true);
    expect(r.slots[3].occupied).toBe(false);
  });
});

describe('aa50BaseFor / per-gen constants', () => {
  it('returns the right base per generation', () => {
    expect(aa50BaseFor('gen2')).toBe(AA50_BASE_GEN2);
    expect(aa50BaseFor('gen1')).toBe(AA50_BASE_GEN1);
    expect(aa50BaseFor('unknown')).toBe(-1);
    // Back-compat: AA50_BASE alias still maps to Gen2.
    expect(AA50_BASE).toBe(AA50_BASE_GEN2);
  });
});

describe('parseKeySlots — refusal paths', () => {
  it('rejects non-RFHUB sizes', () => {
    const r = parseKeySlots(new Uint8Array(1024));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recognized RFHUB/i);
  });
  it('rejects missing buffer', () => {
    const r = parseKeySlots(null);
    expect(r.ok).toBe(false);
  });
});

describe('deleteSlot', () => {
  it('clears AA 50 → FF FF and reports patched=1', () => {
    const buf = makeRfhubGen2({ fobikSlots: 2 });
    const r = deleteSlot(buf, 0);
    expect(r.ok).toBe(true);
    expect(r.patched).toBe(1);
    expect(r.bytes[AA50_BASE]).toBe(0xFF);
    expect(r.bytes[AA50_BASE + 1]).toBe(0xFF);
    // Source untouched.
    expect(buf[AA50_BASE]).toBe(0xAA);
  });
  it('is idempotent on an empty slot (patched=0, ok=true)', () => {
    const buf = makeRfhubGen2({ fobikSlots: 0 });
    const r = deleteSlot(buf, 0);
    expect(r.ok).toBe(true);
    expect(r.patched).toBe(0);
  });
  it('refuses out-of-range slot indices', () => {
    const buf = makeRfhubGen2({});
    expect(deleteSlot(buf, -1).ok).toBe(false);
    expect(deleteSlot(buf, KEY_SLOT_COUNT).ok).toBe(false);
  });
  it('refuses non-RFHUB buffers', () => {
    const r = deleteSlot(new Uint8Array(512), 0);
    expect(r.ok).toBe(false);
  });
});

describe('addSlot', () => {
  it('writes AA 50 to a free slot', () => {
    const buf = makeRfhubGen2({ fobikSlots: 0 });
    const r = addSlot(buf, 2);
    expect(r.ok).toBe(true);
    expect(r.bytes[AA50_BASE + 2 * 2]).toBe(0xAA);
    expect(r.bytes[AA50_BASE + 2 * 2 + 1]).toBe(0x50);
  });
  it('refuses to overwrite an already-occupied slot', () => {
    const buf = makeRfhubGen2({ fobikSlots: 1 });
    const r = addSlot(buf, 0);
    expect(r.ok).toBe(false);
    expect(r.alreadyOccupied).toBe(true);
  });
});

describe('transferSlot', () => {
  it('copies an occupied marker A→B at the same index', () => {
    const src = makeRfhubGen2({ fobikSlots: 4 });
    const dst = makeRfhubGen2({ fobikSlots: 0 });
    const r = transferSlot(src, dst, 1, 1);
    expect(r.ok).toBe(true);
    expect(r.occupiedAfter).toBe(true);
    expect(r.idTransferred).toBe(true);
    expect(r.idLen).toBe(KEY_ID_BLOCK_LEN);
    expect(r.bytes[AA50_BASE + 2]).toBe(0xAA);
    expect(r.bytes[AA50_BASE + 3]).toBe(0x50);
    // dst untouched at other slots
    expect(r.bytes[AA50_BASE]).toBe(dst[AA50_BASE]);
    // Per-fob ID block at slot 1 now matches src byte-for-byte.
    const idOff = KEY_ID_BASE_GEN2 + 1 * KEY_ID_STRIDE;
    for (let k = 0; k < KEY_ID_BLOCK_LEN; k++) {
      expect(r.bytes[idOff + k]).toBe(src[idOff + k]);
    }
    // Other slots' ID blocks untouched.
    const otherOff = KEY_ID_BASE_GEN2 + 0 * KEY_ID_STRIDE;
    for (let k = 0; k < KEY_ID_BLOCK_LEN; k++) {
      expect(r.bytes[otherOff + k]).toBe(dst[otherOff + k]);
    }
  });
  it('copies an empty marker A→B (used to "clear" via transfer)', () => {
    const src = makeRfhubGen2({ fobikSlots: 0 });
    const dst = makeRfhubGen2({ fobikSlots: 4 });
    const r = transferSlot(src, dst, 0, 0);
    expect(r.ok).toBe(true);
    expect(r.occupiedAfter).toBe(false);
    expect(r.bytes[AA50_BASE]).toBe(0xFF);
  });
  it('refuses Gen1 ↔ Gen2 mixing with a generation-mismatch error', () => {
    // Task #409: Gen1 slot edits are now supported, so the gate no longer
    // trips first — both directions surface the explicit gen-mismatch.
    const r = transferSlot(makeRfhubGen1(), makeRfhubGen2({}), 0, 0);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/generation mismatch/i);
    const r2 = transferSlot(makeRfhubGen2({}), makeRfhubGen1(), 0, 0);
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/generation mismatch/i);
  });
  it('refuses out-of-range indices', () => {
    const src = makeRfhubGen2({});
    const dst = makeRfhubGen2({});
    expect(transferSlot(src, dst, -1, 0).ok).toBe(false);
    expect(transferSlot(src, dst, 0, KEY_SLOT_COUNT).ok).toBe(false);
  });
});

describe('copyMasterSec16 — Gen2', () => {
  it('copies SEC16 raw and recomputes both slot CRCs', () => {
    const customSecret = new Uint8Array(16).map((_, i) => 0xC0 + i);
    const src = makeRfhubGen2({ vehicleSecret: customSecret });
    const dst = makeRfhubGen2({}); // default different secret
    const r = copyMasterSec16(src, dst);
    expect(r.ok).toBe(true);
    expect(r.patched).toBe(2);
    // Both dst SEC16 slots now hold the src raw.
    for (const off of [0x050E, 0x0522]) {
      for (let k = 0; k < 16; k++) expect(r.bytes[off + k]).toBe(customSecret[k]);
      const calc = rfhSec16Cs(customSecret);
      expect(((r.bytes[off + 16] << 8) | r.bytes[off + 17])).toBe(calc);
    }
    // Round-trip parse → csOk:true on both slots.
    const re = parseKeySlots(r.bytes);
    expect(re.sec16.slots[0].csOk).toBe(true);
    expect(re.sec16.slots[1].csOk).toBe(true);
    expect(re.sec16.match).toBe(true);
  });
  it('refuses Gen1 ↔ Gen2 mixing', () => {
    const r = copyMasterSec16(makeRfhubGen1(), makeRfhubGen2({}));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/generation mismatch/i);
  });
});

describe('copyMasterSec16 — Gen1', () => {
  it('copies SEC16 raw and recomputes both slot CRCs (Task #409)', () => {
    const sec = new Uint8Array(16).map((_, i) => 0xA0 + i);
    const src = makeRfhubGen1({ sec16Bytes: sec });
    const dst = makeRfhubGen1({});
    const r = copyMasterSec16(src, dst);
    expect(r.ok).toBe(true);
    expect(r.patched).toBe(2);
    const calc = rfhSec16Cs(sec);
    for (const off of [0x00AE, 0x00C0]) {
      for (let k = 0; k < 16; k++) expect(r.bytes[off + k]).toBe(sec[k]);
      expect(((r.bytes[off + 16] << 8) | r.bytes[off + 17])).toBe(calc);
    }
    // Round-trip parse → csOk:true on both slots.
    const re = parseKeySlots(r.bytes);
    expect(re.sec16.slots[0].csOk).toBe(true);
    expect(re.sec16.slots[1].csOk).toBe(true);
    expect(re.sec16.match).toBe(true);
  });
});

describe('firstFreeSlot', () => {
  it('returns the lowest-index empty slot or -1', () => {
    expect(firstFreeSlot(makeRfhubGen2({ fobikSlots: 0 }))).toBe(0);
    expect(firstFreeSlot(makeRfhubGen2({ fobikSlots: 2 }))).toBe(2);
    expect(firstFreeSlot(makeRfhubGen2({ fobikSlots: 4 }))).toBe(-1);
  });
});

describe('Gen1 slot editing (Task #409 — AA-50 base 0x00D2 confirmed)', () => {
  it('slotsEditableFor("gen1") is true', () => {
    expect(slotsEditableFor('gen1')).toBe(true);
    expect(slotsEditableFor('gen2')).toBe(true);
    expect(slotsEditableFor('unknown')).toBe(false);
  });
  it('addSlot writes AA 50 into a free Gen1 slot at the per-gen base', () => {
    const buf = makeRfhubGen1({ fobikSlots: 0 });
    const r = addSlot(buf, 1);
    expect(r.ok).toBe(true);
    expect(r.markerOffset).toBe(AA50_BASE_GEN1 + 2);
    expect(r.bytes[AA50_BASE_GEN1 + 2]).toBe(0xAA);
    expect(r.bytes[AA50_BASE_GEN1 + 3]).toBe(0x50);
  });
  it('deleteSlot clears AA 50 → FF FF on a populated Gen1 slot', () => {
    const buf = makeRfhubGen1({ fobikSlots: 2 });
    const r = deleteSlot(buf, 0);
    expect(r.ok).toBe(true);
    expect(r.patched).toBe(1);
    expect(r.bytes[AA50_BASE_GEN1]).toBe(0xFF);
    expect(r.bytes[AA50_BASE_GEN1 + 1]).toBe(0xFF);
  });
  it('transferSlot copies a Gen1 → Gen1 marker', () => {
    const src = makeRfhubGen1({ fobikSlots: 4 });
    const dst = makeRfhubGen1({ fobikSlots: 0 });
    const r = transferSlot(src, dst, 2, 2);
    expect(r.ok).toBe(true);
    expect(r.occupiedAfter).toBe(true);
    expect(r.bytes[AA50_BASE_GEN1 + 4]).toBe(0xAA);
    expect(r.bytes[AA50_BASE_GEN1 + 5]).toBe(0x50);
  });
  it('Gen1 add → delete returns the buffer byte-identical (full round-trip)', () => {
    const buf = makeRfhubGen1({ fobikSlots: 0 });
    for (let i = 0; i < KEY_SLOT_COUNT; i++) {
      const a = addSlot(buf, i);
      expect(a.ok, `add gen1 slot ${i}`).toBe(true);
      const d = deleteSlot(a.bytes, i);
      expect(d.ok, `delete gen1 slot ${i}`).toBe(true);
      expect(d.bytes.length).toBe(buf.length);
      for (let off = 0; off < buf.length; off++) {
        if (d.bytes[off] !== buf[off]) {
          throw new Error(`gen1 round-trip mismatch at slot=${i} off=0x${off.toString(16)}: got ${d.bytes[off]}, want ${buf[off]}`);
        }
      }
    }
  });
  it('Gen1 delete → add on a populated fixture restores byte-identical', () => {
    const buf = makeRfhubGen1({ fobikSlots: 2 });
    // slot 0 is occupied — delete it then re-add → buffer restored.
    const d = deleteSlot(buf, 0);
    expect(d.ok).toBe(true);
    expect(d.patched).toBe(1);
    const a = addSlot(d.bytes, 0);
    expect(a.ok).toBe(true);
    for (let off = 0; off < buf.length; off++) {
      expect(a.bytes[off]).toBe(buf[off]);
    }
  });
  it('still permits master-SEC16 copy on Gen1 (offsets + CS formula confirmed)', () => {
    const r = copyMasterSec16(makeRfhubGen1(), makeRfhubGen1());
    expect(r.ok).toBe(true);
  });
});

describe('Gen2 RFHUB header signature gate (Architect review #1)', () => {
  it('refuses a 4 KB buffer that lacks AA 55 31 01 @ 0x0500', () => {
    const fake = new Uint8Array(4096).fill(0xFF);
    // Plant AA-50 markers so a naïve writer would happily mutate them.
    fake[0x0880] = 0xAA; fake[0x0881] = 0x50;
    expect(deleteSlot(fake, 0).ok).toBe(false);
    expect(addSlot(fake, 1).ok).toBe(false);
    expect(transferSlot(fake, fake, 0, 0).ok).toBe(false);
    expect(copyMasterSec16(fake, fake).ok).toBe(false);
  });
  it('accepts a 4 KB buffer once the header signature is present', () => {
    const buf = makeRfhubGen2({ fobikSlots: 1 });
    // Sanity check: fixture writes the header.
    expect(buf[0x0500]).toBe(0xAA);
    expect(buf[0x0501]).toBe(0x55);
    expect(buf[0x0502]).toBe(0x31);
    expect(buf[0x0503]).toBe(0x01);
    expect(deleteSlot(buf, 0).ok).toBe(true);
  });
});

describe('Task #408 — per-fob ID block transfer (FreshAuto-style donor pair)', () => {
  it('transfers slot byte-identically (AA-50 marker + 8-byte Autel ID block)', () => {
    // FreshAuto-style donor pair: distinct VINs, distinct fob populations,
    // distinct per-slot Autel transponder IDs. Modeled after the donor /
    // recipient files a locksmith would actually drop into the pane.
    const donorIds = [
      new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]), // donor's slot 0 fob
      new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE, 0xDE, 0xAD, 0xBE, 0xEF]), // donor's slot 1 fob
      null, null,
    ];
    const recipIds = [
      new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]),
      null, null, null,
    ];
    const donor = makeRfhubGen2({
      vin: '2C3CDXKT3FH123456',
      fobikSlots: 2,
      fobIds: donorIds,
    });
    const recipient = makeRfhubGen2({
      vin: '2C3CDXKT3FH987654',
      fobikSlots: 1,
      fobIds: recipIds,
    });
    // Take donor slot 1 (CAFEBABE…) into recipient's empty slot 2.
    const r = transferSlot(donor, recipient, 1, 2);
    expect(r.ok).toBe(true);
    expect(r.idTransferred).toBe(true);
    expect(r.occupiedAfter).toBe(true);
    // AA-50 marker + 8-byte ID block at the receiving offset matches the
    // donor's source slot byte-for-byte.
    const dstMarker = AA50_BASE + 2 * 2;
    expect(r.bytes[dstMarker]).toBe(0xAA);
    expect(r.bytes[dstMarker + 1]).toBe(0x50);
    const srcIdOff = KEY_ID_BASE_GEN2 + 1 * KEY_ID_STRIDE;
    const dstIdOff = KEY_ID_BASE_GEN2 + 2 * KEY_ID_STRIDE;
    for (let k = 0; k < KEY_ID_BLOCK_LEN; k++) {
      expect(r.bytes[dstIdOff + k]).toBe(donor[srcIdOff + k]);
    }
    // Recipient's pre-existing slot 0 is untouched (donor IDs not bled in).
    const slot0Off = KEY_ID_BASE_GEN2;
    for (let k = 0; k < KEY_ID_BLOCK_LEN; k++) {
      expect(r.bytes[slot0Off + k]).toBe(recipient[slot0Off + k]);
    }
    // Donor buffer never mutated.
    for (let off = 0; off < donor.length; off++) {
      // (skip nothing — transferSlot must not touch src)
      // Recreate donor and compare to be sure nothing bled back.
    }
    const donorReplay = makeRfhubGen2({
      vin: '2C3CDXKT3FH123456',
      fobikSlots: 2,
      fobIds: donorIds,
    });
    for (let off = 0; off < donor.length; off++) {
      expect(donor[off]).toBe(donorReplay[off]);
    }
    // Round-trip: parse the patched recipient and confirm slot 2's idBytes
    // exactly equals the donor's slot 1 idBytes.
    const re = parseKeySlots(r.bytes);
    expect(re.ok).toBe(true);
    expect(re.slots[2].occupied).toBe(true);
    expect(re.slots[2].idMapped).toBe(true);
    for (let k = 0; k < KEY_ID_BLOCK_LEN; k++) {
      expect(re.slots[2].idBytes[k]).toBe(donorIds[1][k]);
    }
  });

  it('exposes a stable layout descriptor via keyIdLayoutFor', () => {
    expect(keyIdLayoutFor('gen2')).toEqual({ base: 0x0888, stride: 8, len: 8 });
    // Task #409 rebase: Gen1 ID block relocated from 0x00D2 to 0x00DA so it
    // doesn't overlap the now-confirmed AA-50 marker block at 0x00D2.
    expect(keyIdLayoutFor('gen1')).toEqual({ base: 0x00DA, stride: 8, len: 8 });
    expect(keyIdLayoutFor('unknown')).toBeNull();
  });
});

describe('round-trip: add → delete → parse', () => {
  it('add then delete restores byte-identical buffer at the touched slot', () => {
    const buf = makeRfhubGen2({ fobikSlots: 0 });
    const a = addSlot(buf, 3);
    expect(a.ok).toBe(true);
    const d = deleteSlot(a.bytes, 3);
    expect(d.ok).toBe(true);
    // Touched bytes restored to FF FF; rest of buffer matches original.
    expect(d.bytes[AA50_BASE + 6]).toBe(buf[AA50_BASE + 6]);
    expect(d.bytes[AA50_BASE + 7]).toBe(buf[AA50_BASE + 7]);
  });

  it('whole-buffer byte-identity: add(i)→delete(i) returns to original buffer', () => {
    const buf = makeRfhubGen2({ fobikSlots: 0 });
    for (let i = 0; i < KEY_SLOT_COUNT; i++) {
      const a = addSlot(buf, i);
      expect(a.ok, `add slot ${i}`).toBe(true);
      const d = deleteSlot(a.bytes, i);
      expect(d.ok, `delete slot ${i}`).toBe(true);
      expect(d.bytes.length).toBe(buf.length);
      // Every byte must round-trip — a leaky writer that touched a stray
      // offset would fail this whole-buffer comparison.
      for (let off = 0; off < buf.length; off++) {
        if (d.bytes[off] !== buf[off]) {
          throw new Error(`round-trip mismatch at slot=${i} off=0x${off.toString(16)}: got ${d.bytes[off]}, want ${buf[off]}`);
        }
      }
    }
  });

  it('parseKeySlots → noop → serialize is byte-identical (no hidden mutation in the read path)', () => {
    const buf = makeRfhubGen2({ fobikSlots: 2 });
    const original = new Uint8Array(buf);
    const parsed = parseKeySlots(buf);
    expect(parsed.ok).toBe(true);
    // Parsing must not mutate the source buffer (Uint8Array views share memory).
    for (let off = 0; off < original.length; off++) {
      expect(buf[off]).toBe(original[off]);
    }
  });
});
