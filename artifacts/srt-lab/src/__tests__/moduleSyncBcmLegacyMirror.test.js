/**
 * Legacy BCM SEC16 mirror detection (2014-era family — e.g. 68396563AC on
 * a 2014 LX Charger).
 *
 * The standard `findMirrorsInBank` scan looks for the gen2-split signature
 * (00 00 00 sizeByte 00 46 slotType 00) inside bank 0/1, which works for
 * 2019+ BCMs (68525720) where mirrors live at 0x82xx. Older 2014 BCMs put
 * their two SEC16 mirrors at fixed early-flash offsets 0x00C8 and 0x00F0
 * with a different layout:
 *
 *   +0       idx  (1 byte)
 *   +1..+16  SEC16 (16 bytes)
 *   +17      tag 0x8F
 *   +18..+19 padding 0xFF 0xFF
 *   +20..+21 stored CRC-16/CCITT (big-endian) over the first 20 bytes
 *
 * Before this fix the wizard reported "Security token issues detected" on
 * this family because the bank scan came back empty even though both
 * mirrors validate cleanly. This test pins the new behaviour: the parser
 * surfaces both mirrors with crcOk=true and feeds them into sec16MirrorHex
 * / mirrorsPopulated so downstream UI shows them as healthy.
 */
import { describe, it, expect } from 'vitest';
import { engParseBcm } from '../tabs/ModuleSync.jsx';

/* CRC-16/CCITT — same parameters the parser uses internally. Re-implemented
 * here so the test doesn't reach into private module helpers. */
function crc16Ccitt(data, init = 0xFFFF, poly = 0x1021) {
  let c = init;
  for (const b of data) {
    c ^= b << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? (((c << 1) ^ poly) & 0xFFFF) : ((c << 1) & 0xFFFF);
  }
  return c & 0xFFFF;
}

function writeLegacyMirror(bytes, off, idx, sec16) {
  bytes[off] = idx;
  for (let k = 0; k < 16; k++) bytes[off + 1 + k] = sec16[k];
  bytes[off + 17] = 0x8F;
  bytes[off + 18] = 0xFF;
  bytes[off + 19] = 0xFF;
  const crcInput = new Uint8Array(20);
  crcInput[0] = idx;
  for (let k = 0; k < 16; k++) crcInput[1 + k] = sec16[k];
  crcInput[17] = 0x8F; crcInput[18] = 0xFF; crcInput[19] = 0xFF;
  const crc = crc16Ccitt(crcInput);
  bytes[off + 20] = (crc >> 8) & 0xFF;
  bytes[off + 21] = crc & 0xFF;
  return crc;
}

/* The user's analysis of EH219538 reports SEC16 = the reverse of the RFH
 * SEC16. We just need any 16-byte token to test the detector — using the
 * EH219538 BCM-side token verbatim makes the test mirror the field case. */
const EH_BCM_SEC16 = new Uint8Array([
  0xC4, 0x2F, 0x3C, 0x79, 0x94, 0x15, 0x82, 0xC3,
  0x82, 0x35, 0x30, 0xBA, 0xE7, 0xC5, 0xA1, 0x08,
]);

describe('engParseBcm — legacy mirror detection at 0x00C8 / 0x00F0', () => {
  it('finds both populated mirrors with valid CRC-16/CCITT', () => {
    const bytes = new Uint8Array(65536);
    const crcA = writeLegacyMirror(bytes, 0x00C8, 0x01, EH_BCM_SEC16);
    const crcB = writeLegacyMirror(bytes, 0x00F0, 0x02, EH_BCM_SEC16);

    const parsed = engParseBcm(bytes, 'eh219538.bin');

    /* The standard bank scan finds nothing here (none of the bank
     * signatures are present in this synthetic buffer) — only the new
     * legacy scan should populate the mirror list. */
    expect(parsed.sec16Mirrors).toHaveLength(2);

    const [first, second] = parsed.sec16Mirrors.sort((a, b) => a.offset - b.offset);
    expect(first.offset).toBe(0x00C8);
    expect(first.kind).toBe('mirror_legacy');
    expect(first.idx).toBe(0x01);
    expect(first.crcOk).toBe(true);
    expect(first.populated).toBe(true);
    expect(first.storedCrc).toBe(crcA);
    expect([...first.sec16]).toEqual([...EH_BCM_SEC16]);

    expect(second.offset).toBe(0x00F0);
    expect(second.kind).toBe('mirror_legacy');
    expect(second.idx).toBe(0x02);
    expect(second.crcOk).toBe(true);
    expect(second.storedCrc).toBe(crcB);
  });

  it('feeds the legacy mirror into mirrorsPopulated + sec16MirrorHex', () => {
    const bytes = new Uint8Array(65536);
    writeLegacyMirror(bytes, 0x00C8, 0x01, EH_BCM_SEC16);
    writeLegacyMirror(bytes, 0x00F0, 0x02, EH_BCM_SEC16);

    const parsed = engParseBcm(bytes, 'eh219538.bin');

    expect(parsed.mirrorsPopulated).toBe(2);
    /* sec16MirrorHex uses the first populated+crcOk mirror, which after
     * the legacy scan runs is one of the two we just wrote. */
    const expectedHex = [...EH_BCM_SEC16].map(b => b.toString(16).padStart(2, '0')).join('');
    expect(parsed.sec16MirrorHex).toBe(expectedHex);
    /* No split records were written, so sec16Hex falls back to the mirror
     * value rather than going undefined. This is the wizard's path for
     * "2014 family with no 0x81xx records but valid mirrors". */
    expect(parsed.sec16Hex).toBe(expectedHex);
  });

  it('refuses spurious mirrors when the 0x8F/0xFF/0xFF tail is absent', () => {
    /* All-zero buffer at the minimum size — no 0x8F at offset+17, so the
     * legacy detector must not fire. */
    const allZero = new Uint8Array(65536);
    expect(engParseBcm(allZero, 'zero.bin').sec16Mirrors).toEqual([]);

    /* All-FF buffer — same reason (offset+17 is 0xFF, not 0x8F). */
    const allFf = new Uint8Array(65536).fill(0xFF);
    expect(engParseBcm(allFf, 'ff.bin').sec16Mirrors).toEqual([]);
  });

  it('refuses mirrors with a tampered CRC (rejects forged tokens)', () => {
    const bytes = new Uint8Array(65536);
    writeLegacyMirror(bytes, 0x00C8, 0x01, EH_BCM_SEC16);
    writeLegacyMirror(bytes, 0x00F0, 0x02, EH_BCM_SEC16);
    /* Corrupt the second mirror's stored CRC — the detector should drop
     * just that one and keep the first. */
    bytes[0x00F0 + 21] ^= 0xFF;

    const parsed = engParseBcm(bytes, 'tampered.bin');
    expect(parsed.sec16Mirrors).toHaveLength(1);
    expect(parsed.sec16Mirrors[0].offset).toBe(0x00C8);
  });
});
