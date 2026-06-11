import { describe, it, expect } from 'vitest';
import { engParseRfh } from '../../tabs/ModuleSync.jsx';
import { parseModule } from '../parseModule.js';

/* ModuleSync's RFH master secret (engParseRfh.sec16.slot1) must match the
 * engine's RFHUB resolution (parseModule sec16s[0].raw) so the RFH-source sync
 * actions resolve the SAME secret the canonical writer (writeRfhSec16Gen1/Gen2)
 * writes. Locks the fix for the Gen1 0x0226→0x00AE offset bug, where the master
 * was read from the key-table region instead of the SEC16 slot. */

const arr = (x) => (x ? Array.from(x) : x);
const SECRET = Uint8Array.from({ length: 16 }, (_, i) => (i * 13 + 5) & 0xff);

const engSlot1 = (b) => engParseRfh(b, 'rfh.bin')?.sec16?.slot1;
const engineSlot1 = (b) => parseModule(b, 'rfh')?.sec16s?.[0]?.raw;

describe('engParseRfh.sec16.slot1 ≡ parseModule RFHUB sec16s[0] (writer-aligned)', () => {
  it('Gen2 (canonical banner, secret @0x050E)', () => {
    const b = new Uint8Array(4096);
    b[0x500] = 0xAA; b[0x501] = 0x55; b[0x502] = 0x31; b[0x503] = 0x01;
    b.set(SECRET, 0x050E); b.set(SECRET, 0x0522);
    expect(arr(engSlot1(b)).slice(0, 16)).toEqual(arr(engineSlot1(b)).slice(0, 16));
    expect(arr(engSlot1(b)).slice(0, 16)).toEqual(arr(SECRET));
  });

  it('Gen2-EEE (non-canonical banner, secret @0x050E by SIZE)', () => {
    const b = new Uint8Array(4096);
    b[0x500] = 0xFF; b[0x501] = 0xFF; b[0x502] = 0x00; b[0x503] = 0x00;
    b.set(SECRET, 0x050E); b.set(SECRET, 0x0522);
    expect(arr(engSlot1(b)).slice(0, 16)).toEqual(arr(engineSlot1(b)).slice(0, 16));
  });

  it('Gen1 24C16 — reads SEC16 from 0x00AE (writer offset), not 0x0226', () => {
    const b = new Uint8Array(2048);
    b.set(SECRET, 0x00AE); b.set(SECRET, 0x00C0);
    expect(arr(engSlot1(b)).slice(0, 16)).toEqual(arr(SECRET));          // reads the right place
    expect(arr(engSlot1(b)).slice(0, 16)).toEqual(arr(engineSlot1(b)).slice(0, 16));
  });

  it('Gen1 — a secret at the OLD 0x0226 region is NOT mistaken for SEC16', () => {
    const b = new Uint8Array(2048);
    b.set(SECRET, 0x0226); // key-table region, not SEC16
    const slot = engSlot1(b);
    expect(slot.every((x) => x === 0x00)).toBe(true); // 0x00AE is blank → no phantom secret
  });
});
