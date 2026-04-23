/* Task #407 — pure-function unit tests for the dual-file RFHub Key Manager
 * helpers. Drives the four mutation primitives plus the master-SEC16 copy
 * across both Gen2 (4 KB) and Gen1 (2 KB) fixtures and asserts the refusal
 * paths return ok:false so the UI can mirror the Task #399 "writer refused
 * → skip download" pattern. */
import { describe, it, expect } from 'vitest';
import {
  parseKeySlots, transferSlot, deleteSlot, addSlot,
  copyMasterSec16, firstFreeSlot, detectGen,
  KEY_SLOT_COUNT, AA50_BASE,
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
    // Per-slot transponder ID layout is intentionally unmapped.
    expect(r.slots[0].idMapped).toBe(false);
    expect(r.slots[0].idBytes).toBeNull();
  });
});

describe('parseKeySlots — Gen1 fixture', () => {
  it('reads AA-50 markers and Gen1 SEC16 offsets', () => {
    const buf = makeRfhubGen1();
    const r = parseKeySlots(buf);
    expect(r.ok).toBe(true);
    expect(r.gen).toBe('gen1');
    expect(r.sec16.offsets).toEqual([0x00AE, 0x00C0]);
    expect(r.sec16.match).toBe(true);
    // Gen1 fixture has no AA-50 markers populated → all four slots empty.
    for (const s of r.slots) expect(s.occupied).toBe(false);
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
    expect(r.idTransferred).toBe(false);
    expect(r.bytes[AA50_BASE + 2]).toBe(0xAA);
    expect(r.bytes[AA50_BASE + 3]).toBe(0x50);
    // dst untouched at other slots
    expect(r.bytes[AA50_BASE]).toBe(dst[AA50_BASE]);
  });
  it('copies an empty marker A→B (used to "clear" via transfer)', () => {
    const src = makeRfhubGen2({ fobikSlots: 0 });
    const dst = makeRfhubGen2({ fobikSlots: 4 });
    const r = transferSlot(src, dst, 0, 0);
    expect(r.ok).toBe(true);
    expect(r.occupiedAfter).toBe(false);
    expect(r.bytes[AA50_BASE]).toBe(0xFF);
  });
  it('refuses Gen1 ↔ Gen2 mixing (Gen1 slot edit gate trips first)', () => {
    const src = makeRfhubGen1();
    const dst = makeRfhubGen2({});
    const r = transferSlot(src, dst, 0, 0);
    expect(r.ok).toBe(false);
    // Gen1 trips the slot-edit gate before the gen-mismatch check; Gen2→Gen1
    // would surface the explicit mismatch error. Either way: refused.
    expect(r.error).toMatch(/not supported for gen1|generation mismatch/i);
    const r2 = transferSlot(makeRfhubGen2({}), makeRfhubGen1(), 0, 0);
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/not supported for gen1/i);
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
  it('copies SEC16 raw and preserves source CS bytes (formula unverified)', () => {
    const sec = new Uint8Array(16).map((_, i) => 0xA0 + i);
    const src = makeRfhubGen1({ sec16Bytes: sec });
    const dst = makeRfhubGen1({});
    const r = copyMasterSec16(src, dst);
    expect(r.ok).toBe(true);
    expect(r.patched).toBe(2);
    for (const off of [0x00AE, 0x00C0]) {
      for (let k = 0; k < 16; k++) expect(r.bytes[off + k]).toBe(sec[k]);
      // Source CS bytes preserved (whatever the fixture wrote — both
      // slots share the same raw, so the CS is identical too).
      expect(r.bytes[off + 16]).toBe(src[0x00AE + 16]);
      expect(r.bytes[off + 17]).toBe(src[0x00AE + 17]);
    }
  });
});

describe('firstFreeSlot', () => {
  it('returns the lowest-index empty slot or -1', () => {
    expect(firstFreeSlot(makeRfhubGen2({ fobikSlots: 0 }))).toBe(0);
    expect(firstFreeSlot(makeRfhubGen2({ fobikSlots: 2 }))).toBe(2);
    expect(firstFreeSlot(makeRfhubGen2({ fobikSlots: 4 }))).toBe(-1);
  });
});

describe('Gen1 slot-edit gate (Architect review #1)', () => {
  it('refuses addSlot / deleteSlot / transferSlot on Gen1 with a clear reason', () => {
    const g1 = makeRfhubGen1();
    const a = addSlot(g1, 0);
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/not supported for gen1/i);
    const d = deleteSlot(g1, 0);
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/not supported for gen1/i);
  });
  it('still permits master-SEC16 copy on Gen1 (offsets confirmed)', () => {
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
