import { describe, it, expect } from 'vitest';

import { writeXc2268Sec16 } from '../securityBytes.js';
import {
  makeXc2268Fixture,
  parseXc2268Image,
  XC2268_SEC16_SLOTS,
  XC2268_SEC16_LEN,
} from '../xc2268Rfhub.js';
import { parseModule } from '../parseModule.js';

// Task #934 — writeXc2268Sec16: BCM secret → XC2268-class RFHUB SEC16.
//
// Convention (shared with the Gen2 writer): the BCM stores reverse(RFHUB
// SEC16), so RFHUB SEC16 = reverse(BCM SEC16). Both mirror slots
// (XC2268_SEC16_SLOTS) get the 16 SEC16 bytes + BE16 CRC-16/CCITT, and the
// trailing image-wide checksum is refreshed because the slots live inside the
// checksum window.

const TARGET_VIN = '1C4BJWFG3JL901234';

const BCM_SEC16 = new Uint8Array([
  0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44,
  0x55, 0x66, 0x77, 0x88, 0x99, 0x00, 0xFF, 0xEE,
]);
const RFH_SEC16_EXPECTED = new Uint8Array(Array.from(BCM_SEC16).reverse());
const hex = (a) => Array.from(a).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

describe('writeXc2268Sec16', () => {
  it('writes reverse(BCM SEC16) into both mirror slots with valid CRCs', () => {
    const img = makeXc2268Fixture({ vin: TARGET_VIN }); // blank SEC16 (virgin)
    const r = writeXc2268Sec16(img, BCM_SEC16);

    expect(r.patched).toBe(2);
    expect(r.rfhSec16Hex.toUpperCase()).toBe(hex(RFH_SEC16_EXPECTED));

    const p = parseXc2268Image(r.bytes);
    expect(p.ok).toBe(true);
    expect(p.sec16Slots).toHaveLength(2);
    for (const slot of p.sec16Slots) {
      expect(hex(slot.raw)).toBe(hex(RFH_SEC16_EXPECTED));
      expect(slot.csOk).toBe(true);
      expect(slot.blank).toBe(false);
    }
    expect(p.sec16Match).toBe(true);
    expect(p.sec16Blank).toBe(false);
    // Image-wide checksum refreshed → reparse round-trips clean.
    expect(p.imageChecksum.ok).toBe(true);
  });

  it('round-trips through parseModule sec16s in BCM-endian view', () => {
    const img = makeXc2268Fixture({ vin: TARGET_VIN });
    const r = writeXc2268Sec16(img, BCM_SEC16);

    const info = parseModule(r.bytes, 'rfh_xc2268.bin');
    expect(info.type).toBe('XC2268_RFHUB');
    expect(info.sec16s).toHaveLength(2);
    expect(info.sec16s[0].hex.toUpperCase()).toBe(hex(RFH_SEC16_EXPECTED));
    expect(info.sec16s[0].bcmHex.toUpperCase()).toBe(hex(BCM_SEC16));
    expect(info.sec16s[0].csOk).toBe(true);
    expect(info.sec16valid).toBe(true);
  });

  it('does not touch the source buffer (returns a copy)', () => {
    const img = makeXc2268Fixture({ vin: TARGET_VIN });
    const before = Uint8Array.from(img);
    writeXc2268Sec16(img, BCM_SEC16);
    expect(hex(img)).toBe(hex(before));
  });

  it('refuses a blank (all-FF) BCM secret', () => {
    const img = makeXc2268Fixture({ vin: TARGET_VIN });
    const blank = new Uint8Array(XC2268_SEC16_LEN).fill(0xFF);
    expect(() => writeXc2268Sec16(img, blank)).toThrow(/blank/i);
  });

  it('refuses a blank (all-00) BCM secret', () => {
    const img = makeXc2268Fixture({ vin: TARGET_VIN });
    const blank = new Uint8Array(XC2268_SEC16_LEN).fill(0x00);
    expect(() => writeXc2268Sec16(img, blank)).toThrow(/blank/i);
  });

  it('rejects a wrong-length BCM secret', () => {
    const img = makeXc2268Fixture({ vin: TARGET_VIN });
    expect(() => writeXc2268Sec16(img, BCM_SEC16.slice(0, 8))).toThrow(/16 bytes/);
  });

  it('targets the documented slot offsets', () => {
    expect(XC2268_SEC16_SLOTS).toEqual([0x1100, 0x1120]);
    expect(XC2268_SEC16_LEN).toBe(16);
  });
});
