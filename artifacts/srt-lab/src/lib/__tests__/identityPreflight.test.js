import { describe, it, expect } from 'vitest';
import { readPartNumber, readVin, readModuleIdentity, verifyIdentity } from '../identityPreflight.js';

// mock uds keyed by the lowercase hex of the request bytes
function mkUds(map) {
  return async (_tx, _rx, bytes) => {
    const key = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    return map[key] ? { ok: true, d: map[key] } : { ok: false, raw: 'no data' };
  };
}
function r62(did, ascii) {
  return new Uint8Array([0x62, (did >> 8) & 0xFF, did & 0xFF, ...Array.from(ascii).map(c => c.charCodeAt(0))]);
}

describe('identityPreflight', () => {
  it('reads the first part-number DID that answers (F18C)', async () => {
    const uds = mkUds({ '22f18c': r62(0xF18C, '68402051AA') });
    expect(await readPartNumber(uds, 0x620, 0x504)).toEqual({ did: 0xF18C, value: '68402051AA' });
  });

  it('falls through to F187 when F18C is silent', async () => {
    const uds = mkUds({ '22f187': r62(0xF187, '12345678') });
    const p = await readPartNumber(uds, 0x620, 0x504);
    expect(p.did).toBe(0xF187);
    expect(p.value).toBe('12345678');
  });

  it('reads + trims the VIN from F190', async () => {
    const uds = mkUds({ '22f190': r62(0xF190, '1C4HJXEN5MW123456') });
    expect(await readVin(uds, 0x620, 0x504)).toBe('1C4HJXEN5MW123456');
  });

  it('responded=false when nothing answers (refuse-to-write gate)', async () => {
    const id = await readModuleIdentity(mkUds({}), 0x620, 0x504);
    expect(id.responded).toBe(false);
    expect(id.partNumber).toBeNull();
    expect(id.vin).toBeNull();
  });

  it('verifyIdentity flags a part-number mismatch', async () => {
    const uds = mkUds({ '22f18c': r62(0xF18C, 'WRONGPART') });
    const v = await verifyIdentity(uds, 0x620, 0x504, { expectPartContains: '68402051' });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('part-mismatch');
  });

  it('verifyIdentity passes when the part number contains the expected substring', async () => {
    const uds = mkUds({ '22f18c': r62(0xF18C, '68402051AA') });
    const v = await verifyIdentity(uds, 0x620, 0x504, { expectPartContains: '68402051' });
    expect(v.ok).toBe(true);
    expect(v.partNumber).toBe('68402051AA');
  });
});
