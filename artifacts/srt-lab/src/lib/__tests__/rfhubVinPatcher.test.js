import {describe, it, expect} from 'vitest';
import {analyzeRfhubVin, patchRfhubVin, validateVin} from '../rfhubVinPatcher.js';
import {crc16, rfhGen2VinCs, crc16ccitt} from '../crc.js';
import {RFH_GEN2_VIN_OFFSETS, RFH_GEN1_VIN_OFFSET} from '../parseModule.js';
import {XC2268_VIN_SLOTS, XC2268_VIN_LEN} from '../xc2268Rfhub.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const GEN1_VIN = '2B3CJ4DV6AH300549';
const GEN2_VIN = '2C3CDXKT3FH796320';
const GEN2_MAGIC = 0xDB;

/** Build a minimal Gen1 (2048 B) RFHUB buffer with a VIN at 0x92 and valid CRC-16. */
function makeGen1(vin = GEN1_VIN, magic = null, corrupt = false) {
  const buf = new Uint8Array(2048).fill(0xFF);
  const raw17 = new Uint8Array(17);
  for (let j = 0; j < 17; j++) raw17[j] = vin.charCodeAt(j);
  buf.set(raw17, RFH_GEN1_VIN_OFFSET);
  const cs = corrupt ? 0x0000 : crc16(raw17);
  buf[RFH_GEN1_VIN_OFFSET + 17] = (cs >> 8) & 0xFF;
  buf[RFH_GEN1_VIN_OFFSET + 18] = cs & 0xFF;
  return buf;
}

/** Build a minimal Gen2 (4096 B) RFHUB buffer with the VIN in all 4 slots. */
function makeGen2(vin = GEN2_VIN, magic = GEN2_MAGIC, corruptSlot = -1) {
  const buf = new Uint8Array(4096).fill(0xFF);
  const raw17 = new Uint8Array(17);
  for (let j = 0; j < 17; j++) raw17[j] = vin.charCodeAt(16 - j); // byte-reversed
  const cs = rfhGen2VinCs(raw17, magic);
  for (let i = 0; i < RFH_GEN2_VIN_OFFSETS.length; i++) {
    const o = RFH_GEN2_VIN_OFFSETS[i];
    buf.set(raw17, o);
    buf[o + 17] = i === corruptSlot ? (cs ^ 0xFF) : cs;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// validateVin
// ---------------------------------------------------------------------------

describe('validateVin', () => {
  it('accepts a valid VIN', () => {
    expect(() => validateVin(GEN2_VIN)).not.toThrow();
  });
  it('accepts lower-case (normalises internally)', () => {
    expect(() => validateVin(GEN2_VIN.toLowerCase())).not.toThrow();
  });
  it('rejects VIN shorter than 17', () => {
    expect(() => validateVin('2C3CDXKT3FH79632')).toThrow('17');
  });
  it('rejects VIN longer than 17', () => {
    expect(() => validateVin('2C3CDXKT3FH7963200')).toThrow('17');
  });
  it('rejects VIN containing I', () => {
    expect(() => validateVin('IC3CDXKT3FH796320')).toThrow(/I.*O.*Q|I, O/);
  });
  it('rejects VIN containing O', () => {
    expect(() => validateVin('2C3OДXKT3FH79632')).toThrow(); // non-ASCII in replacement
    expect(() => validateVin('2COCDXKT3FH796320')).toThrow();
  });
  it('rejects null / undefined', () => {
    expect(() => validateVin(null)).toThrow();
    expect(() => validateVin(undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// analyzeRfhubVin — Gen1
// ---------------------------------------------------------------------------

describe('analyzeRfhubVin Gen1', () => {
  it('detects generation gen1 for 2048-byte buffer', () => {
    const r = analyzeRfhubVin(makeGen1());
    expect(r.generation).toBe('gen1');
  });

  it('extracts VIN correctly', () => {
    const r = analyzeRfhubVin(makeGen1());
    expect(r.slots).toHaveLength(1);
    expect(r.slots[0].vin).toBe(GEN1_VIN);
  });

  it('reports crcOk=true for valid checksum', () => {
    const r = analyzeRfhubVin(makeGen1());
    expect(r.slots[0].crcOk).toBe(true);
  });

  it('reports crcOk=false for corrupted checksum', () => {
    const r = analyzeRfhubVin(makeGen1(GEN1_VIN, null, true));
    expect(r.slots[0].crcOk).toBe(false);
  });

  it('reports blank=true and crcOk=null for all-FF VIN slot', () => {
    const buf = new Uint8Array(2048).fill(0xFF);
    const r = analyzeRfhubVin(buf);
    expect(r.slots[0].blank).toBe(true);
    expect(r.slots[0].crcOk).toBeNull();
    expect(r.slots[0].vin).toBeNull();
  });

  it('exposes correct offset hex', () => {
    const r = analyzeRfhubVin(makeGen1());
    expect(r.slots[0].offsetHex).toBe('0x0092');
  });
});

// ---------------------------------------------------------------------------
// analyzeRfhubVin — Gen2
// ---------------------------------------------------------------------------

describe('analyzeRfhubVin Gen2', () => {
  it('detects generation gen2 for 4096-byte buffer', () => {
    const r = analyzeRfhubVin(makeGen2());
    expect(r.generation).toBe('gen2');
  });

  it('extracts VIN correctly from all 4 slots', () => {
    const r = analyzeRfhubVin(makeGen2());
    expect(r.slots).toHaveLength(4);
    r.slots.forEach(s => expect(s.vin).toBe(GEN2_VIN));
  });

  it('reports crcOk=true for all valid slots', () => {
    const r = analyzeRfhubVin(makeGen2());
    r.slots.forEach(s => expect(s.crcOk).toBe(true));
  });

  it('reports crcOk=false for a corrupted slot', () => {
    const r = analyzeRfhubVin(makeGen2(GEN2_VIN, GEN2_MAGIC, 2));
    expect(r.slots[2].crcOk).toBe(false);
    // Other slots should still pass
    expect(r.slots[0].crcOk).toBe(true);
    expect(r.slots[1].crcOk).toBe(true);
    expect(r.slots[3].crcOk).toBe(true);
  });

  it('auto-detects magic from first non-blank slot', () => {
    const r = analyzeRfhubVin(makeGen2(GEN2_VIN, GEN2_MAGIC));
    expect(r.magic).toBe(GEN2_MAGIC);
  });

  it('reports blank slots correctly when only slot 0 is populated', () => {
    const buf = new Uint8Array(4096).fill(0xFF);
    const raw17 = new Uint8Array(17);
    for (let j = 0; j < 17; j++) raw17[j] = GEN2_VIN.charCodeAt(16 - j);
    const cs = rfhGen2VinCs(raw17, GEN2_MAGIC);
    const o = RFH_GEN2_VIN_OFFSETS[0];
    buf.set(raw17, o);
    buf[o + 17] = cs;

    const r = analyzeRfhubVin(buf);
    expect(r.slots[0].blank).toBe(false);
    expect(r.slots[0].crcOk).toBe(true);
    expect(r.slots[1].blank).toBe(true);
    expect(r.slots[2].blank).toBe(true);
    expect(r.slots[3].blank).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// analyzeRfhubVin — edge cases
// ---------------------------------------------------------------------------

describe('analyzeRfhubVin edge cases', () => {
  it('returns error for non-canonical size', () => {
    const r = analyzeRfhubVin(new Uint8Array(1024));
    expect(r.generation).toBeNull();
    expect(r.error).toMatch(/non-canonical/i);
  });

  it('returns error for empty buffer', () => {
    const r = analyzeRfhubVin(new Uint8Array(0));
    expect(r.error).toBeTruthy();
  });

  it('returns error for null', () => {
    const r = analyzeRfhubVin(null);
    expect(r.error).toBeTruthy();
  });

  it('sets xc2268=true for XC2268 buffer', () => {
    // XC2268 signature: "XC22" at offset 0 and "RFHUB" at offset 0x10, canonical size 0x10000
    const buf = new Uint8Array(0x10000).fill(0xFF);
    buf[0] = 0x58; buf[1] = 0x43; buf[2] = 0x32; buf[3] = 0x32; // "XC22"
    buf[0x10] = 0x52; buf[0x11] = 0x46; buf[0x12] = 0x48; buf[0x13] = 0x55; buf[0x14] = 0x42; // "RFHUB"
    const r = analyzeRfhubVin(buf);
    expect(r.xc2268).toBe(true);
    expect(r.generation).toBe('xc2268');
  });
});

// ---------------------------------------------------------------------------
// patchRfhubVin — Gen1 round-trip
// ---------------------------------------------------------------------------

describe('patchRfhubVin Gen1', () => {
  const NEW_VIN = '1C6RR7LT5KS123456';

  it('does not mutate the original buffer', () => {
    const orig = makeGen1();
    const copy = new Uint8Array(orig);
    patchRfhubVin(orig, NEW_VIN);
    expect(orig).toEqual(copy);
  });

  it('writes the new VIN at offset 0x92 (plain, not reversed)', () => {
    const patched = patchRfhubVin(makeGen1(), NEW_VIN);
    let s = '';
    for (let j = 0; j < 17; j++) s += String.fromCharCode(patched[RFH_GEN1_VIN_OFFSET + j]);
    expect(s).toBe(NEW_VIN);
  });

  it('writes a valid CRC-16 after patching', () => {
    const patched = patchRfhubVin(makeGen1(), NEW_VIN);
    const raw17 = patched.slice(RFH_GEN1_VIN_OFFSET, RFH_GEN1_VIN_OFFSET + 17);
    const stored = (patched[RFH_GEN1_VIN_OFFSET + 17] << 8) | patched[RFH_GEN1_VIN_OFFSET + 18];
    expect(stored).toBe(crc16(raw17));
  });

  it('re-analyze after patch shows crcOk=true and new VIN', () => {
    const patched = patchRfhubVin(makeGen1(), NEW_VIN);
    const r = analyzeRfhubVin(patched);
    expect(r.slots[0].vin).toBe(NEW_VIN);
    expect(r.slots[0].crcOk).toBe(true);
  });

  it('round-trip: patch with old VIN restores byte-identical buffer', () => {
    const orig = makeGen1(GEN1_VIN);
    const patched = patchRfhubVin(orig, GEN1_VIN);
    expect(patched).toEqual(orig);
  });
});

// ---------------------------------------------------------------------------
// patchRfhubVin — Gen2 round-trip
// ---------------------------------------------------------------------------

describe('patchRfhubVin Gen2', () => {
  const NEW_VIN = '1C6RR7LT5KS123456';

  it('does not mutate the original buffer', () => {
    const orig = makeGen2();
    const copy = new Uint8Array(orig);
    patchRfhubVin(orig, NEW_VIN);
    expect(orig).toEqual(copy);
  });

  it('updates all 4 slots with byte-reversed new VIN', () => {
    const patched = patchRfhubVin(makeGen2(), NEW_VIN);
    for (const o of RFH_GEN2_VIN_OFFSETS) {
      const st = patched.slice(o, o + 17);
      const rev = new Uint8Array(17);
      for (let j = 0; j < 17; j++) rev[j] = st[16 - j];
      let s = '';
      for (let j = 0; j < 17; j++) s += String.fromCharCode(rev[j]);
      expect(s).toBe(NEW_VIN);
    }
  });

  it('writes a valid CS byte for each slot after patching', () => {
    const patched = patchRfhubVin(makeGen2(), NEW_VIN);
    const r = analyzeRfhubVin(patched);
    r.slots.forEach(slot => {
      expect(slot.blank).toBe(false);
      expect(slot.crcOk).toBe(true);
    });
  });

  it('re-analyze after patch shows new VIN in all 4 slots', () => {
    const patched = patchRfhubVin(makeGen2(), NEW_VIN);
    const r = analyzeRfhubVin(patched);
    r.slots.forEach(s => expect(s.vin).toBe(NEW_VIN));
  });

  it('round-trip: patch with same VIN produces byte-identical buffer', () => {
    const orig = makeGen2(GEN2_VIN, GEN2_MAGIC);
    const patched = patchRfhubVin(orig, GEN2_VIN);
    expect(patched).toEqual(orig);
  });

  it('preserves magic from original image when patching', () => {
    const ALT_MAGIC = 0x87;
    const orig = makeGen2(GEN2_VIN, ALT_MAGIC);
    const patched = patchRfhubVin(orig, NEW_VIN);
    const r = analyzeRfhubVin(patched);
    expect(r.magic).toBe(ALT_MAGIC);
    r.slots.forEach(s => expect(s.crcOk).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// patchRfhubVin — guard rails
// ---------------------------------------------------------------------------

describe('patchRfhubVin guard rails', () => {
  it('throws on null bytes', () => {
    expect(() => patchRfhubVin(null, GEN2_VIN)).toThrow();
  });
  it('throws on non-canonical buffer size', () => {
    expect(() => patchRfhubVin(new Uint8Array(1024), GEN2_VIN)).toThrow(/non-canonical/i);
  });
  it('throws on invalid VIN', () => {
    expect(() => patchRfhubVin(makeGen1(), 'TOO-SHORT')).toThrow();
  });
  it('throws on XC2268 buffer', () => {
    const buf = makeXc2268();
    expect(() => patchRfhubVin(buf, GEN2_VIN)).toThrow(/XC2268/i);
  });
});

// ---------------------------------------------------------------------------
// XC2268 fixture builder
// ---------------------------------------------------------------------------

/** "XC22" at 0x0000, "RFHUB" at 0x0010, canonical 0x10000 bytes. */
function makeXc2268(vin = GEN2_VIN) {
  const buf = new Uint8Array(0x10000).fill(0xFF);
  // Header
  buf[0x00] = 0x58; buf[0x01] = 0x43; buf[0x02] = 0x32; buf[0x03] = 0x32; // "XC22"
  buf[0x10] = 0x52; buf[0x11] = 0x46; buf[0x12] = 0x48; buf[0x13] = 0x55; buf[0x14] = 0x42; // "RFHUB"
  if (vin) {
    // Write VIN + CRC-16/CCITT at each of the 3 VIN slots
    const vinBytes = new Uint8Array(XC2268_VIN_LEN);
    for (let i = 0; i < XC2268_VIN_LEN; i++) vinBytes[i] = vin.charCodeAt(i);
    const cs = crc16ccitt(vinBytes);
    for (const off of XC2268_VIN_SLOTS) {
      buf.set(vinBytes, off);
      buf[off + XC2268_VIN_LEN]     = (cs >> 8) & 0xFF;
      buf[off + XC2268_VIN_LEN + 1] = cs & 0xFF;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// analyzeRfhubVin — XC2268 inspect mode
// ---------------------------------------------------------------------------

describe('analyzeRfhubVin XC2268 inspect', () => {
  it('detects generation xc2268', () => {
    const r = analyzeRfhubVin(makeXc2268());
    expect(r.generation).toBe('xc2268');
    expect(r.xc2268).toBe(true);
  });

  it('populates 3 VIN slots (not empty)', () => {
    const r = analyzeRfhubVin(makeXc2268());
    expect(r.slots).toHaveLength(3);
  });

  it('reads correct VIN from each slot', () => {
    const r = analyzeRfhubVin(makeXc2268(GEN2_VIN));
    r.slots.forEach(s => expect(s.vin).toBe(GEN2_VIN));
  });

  it('reports crcOk=true for all valid slots', () => {
    const r = analyzeRfhubVin(makeXc2268(GEN2_VIN));
    r.slots.forEach(s => expect(s.crcOk).toBe(true));
  });

  it('reports crcOk=false for corrupted CS', () => {
    const buf = makeXc2268(GEN2_VIN);
    // Corrupt the CS of the second slot
    buf[XC2268_VIN_SLOTS[1] + XC2268_VIN_LEN] ^= 0xFF;
    const r = analyzeRfhubVin(buf);
    expect(r.slots[1].crcOk).toBe(false);
    expect(r.slots[0].crcOk).toBe(true);
    expect(r.slots[2].crcOk).toBe(true);
  });

  it('reports blank=true for all-FF slot', () => {
    const buf = makeXc2268(null); // no VIN written → all FF
    const r = analyzeRfhubVin(buf);
    r.slots.forEach(s => {
      expect(s.blank).toBe(true);
      expect(s.vin).toBeNull();
      expect(s.crcOk).toBeNull();
    });
  });

  it('exposes correct offsets for XC2268 VIN slots', () => {
    const r = analyzeRfhubVin(makeXc2268());
    expect(r.slots[0].offset).toBe(XC2268_VIN_SLOTS[0]);
    expect(r.slots[1].offset).toBe(XC2268_VIN_SLOTS[1]);
    expect(r.slots[2].offset).toBe(XC2268_VIN_SLOTS[2]);
  });

  it('uses CRC-16/CCITT BE CS format label', () => {
    const r = analyzeRfhubVin(makeXc2268());
    r.slots.forEach(s => expect(s.csFormat).toBe('CRC-16/CCITT BE'));
  });
});

// ---------------------------------------------------------------------------
// analyzeRfhubVin — Gen2 content validation
// ---------------------------------------------------------------------------

describe('analyzeRfhubVin Gen2 content warn', () => {
  it('sets contentWarn when a blank 4 KB buffer has no RFHUB markers', () => {
    // All-FF with no VIN/header/sec16/aa50 — passes size check but fails content
    const buf = new Uint8Array(4096).fill(0xFF);
    const r = analyzeRfhubVin(buf);
    expect(r.generation).toBe('gen2');
    expect(r.contentWarn).toBeTruthy();
    expect(r.contentWarn.message).toMatch(/RFHUB/i);
  });

  it('does not set contentWarn when VIN-shaped content is present in slots', () => {
    // makeGen2 writes byte-reversed VIN, which buildRfhubContentWarn can detect
    const r = analyzeRfhubVin(makeGen2(GEN2_VIN));
    expect(r.contentWarn).toBeFalsy();
  });

  it('contentWarn carries a causes array', () => {
    const buf = new Uint8Array(4096).fill(0xFF);
    const r = analyzeRfhubVin(buf);
    expect(Array.isArray(r.contentWarn.causes)).toBe(true);
    expect(r.contentWarn.causes.length).toBeGreaterThan(0);
  });
});
