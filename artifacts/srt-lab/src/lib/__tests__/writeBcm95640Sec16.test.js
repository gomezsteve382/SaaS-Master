/**
 * writeBcm95640Sec16.test.js — the previously-missing 95640 SEC16 writer.
 * The 95640 BCM-backup EEPROM stores SEC16 byte-reversed vs the RFHUB at
 * 0x838..0x847 with a CRC-16/CCITT-FALSE big-endian at 0x848/0x849. Validated
 * against a real 95640 bench dump.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeBcm95640Sec16 } from '../securityBytes.js';
import { crc16 } from '../crc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '..', '..', '__tests__', 'fixtures');
const FILE = 'SAMPLE_95640_EXT_EEPROM_FCA_DK_OG.bin';

describe('writeBcm95640Sec16', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, FILE)));

  it('round-trips reverse(RFH) @ 0x838 + CRC16 BE @ 0x848 on a real 95640 dump', () => {
    // On-disk SEC16 is already in 95640 (reversed) form; reverse it to RFH form,
    // feed it back, and the writer must reproduce the same 16 bytes + a CRC16.
    const onDisk = bytes.slice(0x838, 0x848);
    const rfhForm = new Uint8Array([...onDisk].reverse());

    const w = writeBcm95640Sec16(bytes, rfhForm);
    expect(w.ok).toBe(true);
    expect(w.patched).toBe(1);
    expect(Array.from(w.bytes.slice(0x838, 0x848))).toEqual(Array.from(onDisk));
    expect((w.bytes[0x848] << 8) | w.bytes[0x849]).toBe(crc16(onDisk));
    expect(w.bytes.length).toBe(bytes.length);
    // nothing outside the slot/CRC moved
    expect(Array.from(w.bytes.slice(0, 0x838))).toEqual(Array.from(bytes.slice(0, 0x838)));
    expect(Array.from(w.bytes.slice(0x84a))).toEqual(Array.from(bytes.slice(0x84a)));
  });

  it('writes a fresh secret and tags a valid CRC16', () => {
    const rfh = new Uint8Array(Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff));
    const w = writeBcm95640Sec16(bytes, rfh);
    const rev = new Uint8Array([...rfh].reverse());
    expect(Array.from(w.bytes.slice(0x838, 0x848))).toEqual(Array.from(rev));
    expect((w.bytes[0x848] << 8) | w.bytes[0x849]).toBe(crc16(rev));
  });

  it('refuses a buffer too small for the slot (no throw)', () => {
    // 0x848+2 = 0x84A bytes are needed; a 2 KB buffer is too small.
    const w = writeBcm95640Sec16(new Uint8Array(0x800), new Uint8Array(16));
    expect(w.ok).toBe(false);
    expect(w.patched).toBe(0);
  });

  it('throws on a non-16-byte secret', () => {
    expect(() => writeBcm95640Sec16(bytes, new Uint8Array(8))).toThrow();
  });
});
