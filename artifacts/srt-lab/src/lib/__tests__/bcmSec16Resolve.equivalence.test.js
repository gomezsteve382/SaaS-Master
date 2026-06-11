import { describe, it, expect } from 'vitest';
import { engResolveBcmSec16 } from '../engBcmParse.js';
import { resolveBcmSec16 } from '../parseModule.js';
import { rekeyVirginBcmFromRfhub } from '../mpc5606bBcm.js';
import { crc16ccitt } from '../crc.js';

/* The engine's resolveBcmSec16 must remain a byte-for-byte SUPERSET of the
 * ModuleSync resolution (engResolveBcmSec16) so delegating the write path to
 * marryModule can never change the secret a working BCM produces. This test
 * locks that contract — including the legacy 2014 (0x00C8/0x00F0) mirror that
 * the engine originally missed. */

const hex = (b) => (b ? Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('') : null);
const eng = (bytes) => { const r = engResolveBcmSec16(bytes, 'bcm.bin'); return r ? hex(Uint8Array.from(r)) : null; };
const engine = (bytes) => { const r = resolveBcmSec16(bytes); return (r && r.bytes && !r.blank) ? hex(Uint8Array.from(r.bytes)) : null; };

const ROOT = Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + 7) & 0xff);

function placeLegacy(buf, off, idx, sec16) {
  buf[off] = idx;
  for (let k = 0; k < 16; k++) buf[off + 1 + k] = sec16[k];
  buf[off + 17] = 0x8F; buf[off + 18] = 0xFF; buf[off + 19] = 0xFF;
  const cin = new Uint8Array(20); cin[0] = idx;
  for (let k = 0; k < 16; k++) cin[1 + k] = sec16[k];
  cin[17] = 0x8F; cin[18] = 0xFF; cin[19] = 0xFF;
  const c = crc16ccitt(cin);
  buf[off + 20] = (c >> 8) & 0xFF; buf[off + 21] = c & 0xFF;
}

describe('resolveBcmSec16 ≡ engResolveBcmSec16 (delegation safety)', () => {
  it('agrees on a split-record BCM', () => {
    const bcm = rekeyVirginBcmFromRfhub(new Uint8Array(65536).fill(0xFF), ROOT).bytes;
    expect(engine(bcm)).toBe(eng(bcm));
    expect(engine(bcm)).not.toBeNull();
  });

  it('agrees on a legacy 2014 mirror BCM (0x00C8 / 0x00F0)', () => {
    const bcm = new Uint8Array(65536).fill(0xFF);
    const sec = Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff);
    placeLegacy(bcm, 0x00C8, 0x01, sec);
    placeLegacy(bcm, 0x00F0, 0x02, sec);
    expect(eng(bcm)).not.toBeNull();        // ModuleSync always found it
    expect(engine(bcm)).toBe(eng(bcm));     // engine now finds the SAME secret
  });

  it('agrees on a virgin BCM (both report nothing)', () => {
    const bcm = new Uint8Array(65536).fill(0xFF);
    expect(eng(bcm)).toBeNull();
    expect(engine(bcm)).toBeNull();
  });

  it('the legacy candidate cannot false-positive without a valid CRC', () => {
    const bcm = new Uint8Array(65536).fill(0xFF);
    const sec = Uint8Array.from({ length: 16 }, (_, i) => (i + 1) & 0xff);
    placeLegacy(bcm, 0x00C8, 0x01, sec);
    bcm[0x00C8 + 21] ^= 0xFF; // corrupt the stored CRC
    expect(engine(bcm)).toBeNull(); // rejected, not treated as a phantom secret
  });
});
