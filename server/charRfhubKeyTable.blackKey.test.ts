/**
 * charRfhubKeyTable.blackKey.test.ts
 *
 * Pure-logic regression tests for the black-key (flag 0x03) write path.
 *
 * Root cause of the original bug: key 8748C092 was written to RFHUB.bin with
 * flag 0x01 (HITAG 2 / red key) instead of flag 0x03 (AES/Alt / black key).
 * The car rejected the key because the flag doesn't match the PCF7953 chip family.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const libPath = resolve(ROOT, 'client/src/srtlab/lib/charRfhubKeyTable.js');
const knownKeysPath = resolve(ROOT, 'client/src/srtlab/lib/keyWriter/knownWorkingKeys.js');

const CHAR_KEYTABLE_BASE    = 0x0C5E;
const CHAR_KEYTABLE_STRIDE  = 16;
const CHAR_KEY_RECLEN       = 6;
const CHAR_KEY_MIRROR_OFFSET = 8;
const EMPTY_TEMPLATE        = [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00];

function slotOffset(i: number): number {
  return CHAR_KEYTABLE_BASE + i * CHAR_KEYTABLE_STRIDE;
}

function makeVirginRfhub(): Uint8Array {
  const buf = new Uint8Array(4096).fill(0xFF);
  for (let i = 0; i < 7; i++) {
    const off = slotOffset(i);
    for (let k = 0; k < CHAR_KEY_RECLEN; k++) buf[off + k] = EMPTY_TEMPLATE[k];
    buf[off + 6] = 0xFF; buf[off + 7] = 0xFF;
    for (let k = 0; k < CHAR_KEY_RECLEN; k++) buf[off + CHAR_KEY_MIRROR_OFFSET + k] = EMPTY_TEMPLATE[k];
    buf[off + 14] = 0xFF; buf[off + 15] = 0xFF;
  }
  const off8 = slotOffset(7);
  buf[off8] = 0xFE; buf[off8 + 1] = 0x00; buf[off8 + 2] = 0xFF;
  buf[off8 + 3] = 0x00; buf[off8 + 4] = 0xFE; buf[off8 + 5] = 0x00;
  buf[off8 + 6] = 0xFF; buf[off8 + 7] = 0xFF;
  return buf;
}

describe('charRfhubKeyTable — black key (flag 0x03) regression', () => {
  it('deriveCharKeyIndex: 8748C092 with flag 0x03 → index 0xD8', async () => {
    const { deriveCharKeyIndex, CHAR_KEY_FLAG_ALT } = await import(libPath);
    expect(deriveCharKeyIndex('8748C092', CHAR_KEY_FLAG_ALT)).toBe(0xD8);
  });

  it('deriveCharKeyIndex: 8748C092 with flag 0x01 → index 0xDA (wrong for black key)', async () => {
    const { deriveCharKeyIndex, CHAR_KEY_FLAG_PRESENT } = await import(libPath);
    expect(deriveCharKeyIndex('8748C092', CHAR_KEY_FLAG_PRESENT)).toBe(0xDA);
  });

  it('isCharRfhubKeyTable: accepts the virgin RFHUB (all slots empty/uninit)', async () => {
    const { isCharRfhubKeyTable } = await import(libPath);
    const buf = makeVirginRfhub();
    expect(isCharRfhubKeyTable(buf)).toBe(true);
  });

  it('addCharKey with flag 0x03: writes correct record to slot 8 primary', async () => {
    const { addCharKey, CHAR_KEY_FLAG_ALT } = await import(libPath);
    const buf = makeVirginRfhub();
    const r = addCharKey(buf, { keyId: '8748C092', flag: CHAR_KEY_FLAG_ALT });
    expect(r.ok).toBe(true);
    expect(r.flag).toBe(0x03);
    expect(r.indexLow).toBe(0xD8);
    expect(r.slot).toBe(8);
    const off = slotOffset(7);
    expect(r.bytes[off + 0]).toBe(0x92);
    expect(r.bytes[off + 1]).toBe(0xC0);
    expect(r.bytes[off + 2]).toBe(0x48);
    expect(r.bytes[off + 3]).toBe(0x87);
    expect(r.bytes[off + 4]).toBe(0xD8);
    expect(r.bytes[off + 5]).toBe(0x03);
  });

  it('addCharKey with flag 0x03: writes correct record to slot 8 mirror', async () => {
    const { addCharKey, CHAR_KEY_FLAG_ALT } = await import(libPath);
    const buf = makeVirginRfhub();
    const r = addCharKey(buf, { keyId: '8748C092', flag: CHAR_KEY_FLAG_ALT });
    expect(r.ok).toBe(true);
    const moff = slotOffset(7) + CHAR_KEY_MIRROR_OFFSET;
    expect(r.bytes[moff + 0]).toBe(0x92);
    expect(r.bytes[moff + 1]).toBe(0xC0);
    expect(r.bytes[moff + 2]).toBe(0x48);
    expect(r.bytes[moff + 3]).toBe(0x87);
    expect(r.bytes[moff + 4]).toBe(0xD8);
    expect(r.bytes[moff + 5]).toBe(0x03);
  });

  it('addCharKey with flag 0x03: exactly 12 bytes changed vs virgin', async () => {
    const { addCharKey, CHAR_KEY_FLAG_ALT } = await import(libPath);
    const buf = makeVirginRfhub();
    const r = addCharKey(buf, { keyId: '8748C092', flag: CHAR_KEY_FLAG_ALT });
    expect(r.ok).toBe(true);
    let diffCount = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== r.bytes[i]) diffCount++;
    }
    expect(diffCount).toBe(12);
  });

  it('addCharKey with flag 0x01 (wrong): flag byte is 0x01, index is 0xDA', async () => {
    const { addCharKey, CHAR_KEY_FLAG_PRESENT } = await import(libPath);
    const buf = makeVirginRfhub();
    const r = addCharKey(buf, { keyId: '8748C092', flag: CHAR_KEY_FLAG_PRESENT });
    expect(r.ok).toBe(true);
    const off = slotOffset(7);
    expect(r.bytes[off + 5]).toBe(0x01);
    expect(r.bytes[off + 4]).toBe(0xDA);
  });

  it('addCharKey with flag 0x03: primary and mirror records are identical', async () => {
    const { addCharKey, CHAR_KEY_FLAG_ALT } = await import(libPath);
    const buf = makeVirginRfhub();
    const r = addCharKey(buf, { keyId: '8748C092', flag: CHAR_KEY_FLAG_ALT });
    expect(r.ok).toBe(true);
    const off = slotOffset(7);
    const primary = Array.from(r.bytes.slice(off, off + CHAR_KEY_RECLEN));
    const mirror  = Array.from(r.bytes.slice(off + CHAR_KEY_MIRROR_OFFSET, off + CHAR_KEY_MIRROR_OFFSET + CHAR_KEY_RECLEN));
    expect(primary).toEqual(mirror);
  });
});

describe('knownWorkingKeys — black key corpus lookup', () => {
  it('lookupChipReadByKeyId: 8748C092 → black key, PCF7945/53', async () => {
    const { lookupChipReadByKeyId } = await import(knownKeysPath);
    const result = lookupChipReadByKeyId('8748C092');
    expect(result).not.toBeNull();
    expect(result?.keyColor).toBe('black');
    expect(result?.chipFamily).toBe('PCF7945/53');
  });

  it('lookupChipReadByKeyId: 0077A29B → red key, PCF7945/53', async () => {
    const { lookupChipReadByKeyId } = await import(knownKeysPath);
    const result = lookupChipReadByKeyId('0077A29B');
    expect(result).not.toBeNull();
    expect(result?.keyColor).toBe('red');
    expect(result?.chipFamily).toBe('PCF7945/53');
  });

  it('lookupChipReadByKeyId: DEADBEEF → null (unknown key)', async () => {
    const { lookupChipReadByKeyId } = await import(knownKeysPath);
    const result = lookupChipReadByKeyId('DEADBEEF');
    expect(result).toBeNull();
  });

  it('lookupChipReadByKeyId: A0CC096F → black key, HITAG AES', async () => {
    const { lookupChipReadByKeyId } = await import(knownKeysPath);
    const result = lookupChipReadByKeyId('A0CC096F');
    expect(result).not.toBeNull();
    expect(result?.keyColor).toBe('black');
    expect(result?.chipFamily).toBe('HITAG AES');
  });
});

describe('charRfhubKeyTable — virgin RFHUB.bin file regression', () => {
  const RFHUB_PATH = resolve(ROOT, 'upload/RFHUB.bin');
  const FIXED_PATH = resolve(ROOT, 'upload/RFHUB_KEY_8748C092_FIXED.bin');

  it('RFHUB.bin: isCharRfhubKeyTable returns true for the real virgin dump', async () => {
    if (!existsSync(RFHUB_PATH)) {
      console.warn('Skipping: RFHUB.bin not found');
      return;
    }
    const { isCharRfhubKeyTable } = await import(libPath);
    const data = new Uint8Array(readFileSync(RFHUB_PATH));
    expect(isCharRfhubKeyTable(data)).toBe(true);
  });

  it('RFHUB.bin: addCharKey with flag 0x03 produces byte-identical output to RFHUB_KEY_8748C092_FIXED.bin', async () => {
    if (!existsSync(RFHUB_PATH) || !existsSync(FIXED_PATH)) {
      console.warn('Skipping: binary files not found');
      return;
    }
    const { addCharKey, CHAR_KEY_FLAG_ALT } = await import(libPath);
    const before   = new Uint8Array(readFileSync(RFHUB_PATH));
    const expected = new Uint8Array(readFileSync(FIXED_PATH));
    const r = addCharKey(before, { keyId: '8748C092', flag: CHAR_KEY_FLAG_ALT });
    expect(r.ok).toBe(true);
    expect(r.bytes).toEqual(expected);
  });

  it('RFHUB_KEY_8748C092_FIXED.bin: slot 8 has flag 0x03 in both primary and mirror', async () => {
    if (!existsSync(FIXED_PATH)) {
      console.warn('Skipping: RFHUB_KEY_8748C092_FIXED.bin not found');
      return;
    }
    const data = new Uint8Array(readFileSync(FIXED_PATH));
    const off = slotOffset(7);
    expect(data[off + 5]).toBe(0x03);
    expect(data[off + CHAR_KEY_MIRROR_OFFSET + 5]).toBe(0x03);
  });
});

describe('charRfhubKeyTable — virginizeCharKeyTable', () => {
  it('virginizeCharKeyTable: erases all 6 keys from RFHUB_EEE.bin', async () => {
    const { virginizeCharKeyTable, parseCharKeyTable } = await import(libPath);
    const eeeFile = resolve(ROOT, 'upload/RFHUB_EEE.bin');
    if (!existsSync(eeeFile)) {
      console.warn('Skipping: RFHUB_EEE.bin not found');
      return;
    }
    const before = new Uint8Array(readFileSync(eeeFile));
    const r = virginizeCharKeyTable(before);
    expect(r.ok).toBe(true);
    expect(r.keyCountBefore).toBe(6);
    expect(r.erasedKeys).toHaveLength(6);
    // Re-parse the output — should have 0 keys and 8 free slots
    const after = parseCharKeyTable(r.bytes);
    expect(after.ok).toBe(true);
    expect(after.keyCount).toBe(0);
    expect(after.slots.every((s: any) => s.empty)).toBe(true);
  });

  it('virginizeCharKeyTable: all 8 slots set to EMPTY_TEMPLATE in primary and mirror', async () => {
    const { virginizeCharKeyTable } = await import(libPath);
    const buf = makeVirginRfhub();
    // Put one key in slot 8 (already done by makeVirginRfhub's uninit, but let's use a real key)
    const { addCharKey, CHAR_KEY_FLAG_ALT } = await import(libPath);
    const withKey = addCharKey(buf, { keyId: '8748C092', flag: CHAR_KEY_FLAG_ALT });
    expect(withKey.ok).toBe(true);
    const r = virginizeCharKeyTable(withKey.bytes);
    expect(r.ok).toBe(true);
    for (let i = 0; i < 8; i++) {
      const off = slotOffset(i);
      const primary = Array.from(r.bytes.slice(off, off + CHAR_KEY_RECLEN));
      const mirror  = Array.from(r.bytes.slice(off + CHAR_KEY_MIRROR_OFFSET, off + CHAR_KEY_MIRROR_OFFSET + CHAR_KEY_RECLEN));
      expect(primary).toEqual(EMPTY_TEMPLATE);
      expect(mirror).toEqual(EMPTY_TEMPLATE);
    }
  });

  it('virginizeCharKeyTable: bytes outside key table are unchanged', async () => {
    const { virginizeCharKeyTable } = await import(libPath);
    const eeeFile = resolve(ROOT, 'upload/RFHUB_EEE.bin');
    if (!existsSync(eeeFile)) {
      console.warn('Skipping: RFHUB_EEE.bin not found');
      return;
    }
    const before = new Uint8Array(readFileSync(eeeFile));
    const r = virginizeCharKeyTable(before);
    expect(r.ok).toBe(true);
    // Bytes before key table should be identical
    const TABLE_START = CHAR_KEYTABLE_BASE;
    const TABLE_END   = CHAR_KEYTABLE_BASE + 8 * CHAR_KEYTABLE_STRIDE;
    for (let i = 0; i < TABLE_START; i++) {
      expect(r.bytes[i]).toBe(before[i]);
    }
    // Bytes after key table should be identical
    for (let i = TABLE_END; i < before.length; i++) {
      expect(r.bytes[i]).toBe(before[i]);
    }
  });

  it('virginizeCharKeyTable: rejects non-RFHUB buffer', async () => {
    const { virginizeCharKeyTable } = await import(libPath);
    const junk = new Uint8Array(4096).fill(0xAA);
    const r = virginizeCharKeyTable(junk);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a recognized/i);
  });
});

describe('charRfhubKeyTable — post-write verification logic', () => {
  it('parseCharKeyTable on addCharKey output: slot matches expected flag and index', async () => {
    const { addCharKey, parseCharKeyTable, CHAR_KEY_FLAG_ALT } = await import(libPath);
    const buf = makeVirginRfhub();
    const r = addCharKey(buf, { keyId: '8748C092', flag: CHAR_KEY_FLAG_ALT });
    expect(r.ok).toBe(true);
    const verify = parseCharKeyTable(r.bytes);
    expect(verify.ok).toBe(true);
    const writtenSlot = verify.slots.find((s: any) => s.slot === r.slot);
    expect(writtenSlot).toBeDefined();
    expect(writtenSlot.keyId).toBe('8748C092');
    expect(writtenSlot.flag).toBe(0x03);
    expect(writtenSlot.indexLow).toBe(0xD8);
    expect(writtenSlot.mirrorOk).toBe(true);
  });

  it('parseCharKeyTable on addCharKey output: wrong flag (0x01) produces wrong index', async () => {
    const { addCharKey, parseCharKeyTable, CHAR_KEY_FLAG_PRESENT } = await import(libPath);
    const buf = makeVirginRfhub();
    const r = addCharKey(buf, { keyId: '8748C092', flag: CHAR_KEY_FLAG_PRESENT });
    expect(r.ok).toBe(true);
    const verify = parseCharKeyTable(r.bytes);
    expect(verify.ok).toBe(true);
    const writtenSlot = verify.slots.find((s: any) => s.slot === r.slot);
    expect(writtenSlot).toBeDefined();
    expect(writtenSlot.flag).toBe(0x01);
    expect(writtenSlot.indexLow).toBe(0xDA); // wrong index for black key
    // Verify that flag 0x01 ≠ CHAR_KEY_FLAG_ALT (0x03)
    expect(writtenSlot.flag).not.toBe(0x03);
  });
});
