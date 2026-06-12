import { describe, it, expect } from 'vitest';
import { marryModule } from '../marryModule.js';
import { parseModule, resolveBcmSec16 } from '../parseModule.js';
import { writeRfhSec16FromBcm } from '../securityBytes.js';
import { rekeyVirginBcmFromRfhub } from '../mpc5606bBcm.js';
import { reverse16 } from '../immoSecret.js';

const ROOT = Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + 7) & 0xff); // RFH-form root
const BCMROOT = reverse16(ROOT);
const arr = (x) => (x ? Array.from(x) : x);

// GPEC2A 4096 target: VIN at offset 0 so parseModule auto-detects GPEC2A.
function gpec2a() {
  const b = new Uint8Array(4096).fill(0x00);
  const vin = '2C3CDXBG1KH100001';
  for (let i = 0; i < 17; i++) b[i] = vin.charCodeAt(i);
  return b;
}
// RFHUB Gen2 4096 target: AA 55 31 01 header @0x500.
function rfhGen2() {
  const b = new Uint8Array(4096).fill(0x00);
  b[0x500] = 0xAA; b[0x501] = 0x55; b[0x502] = 0x31; b[0x503] = 0x01;
  return b;
}
// An RFHUB carrying ROOT, used as a "source of truth" module.
const rfhSrc = () => writeRfhSec16FromBcm(rfhGen2(), BCMROOT).bytes;

describe('marryModule — derive → write → verify', () => {
  it('marries a GPEC2A PCM from an RFHUB source (SEC6 = root[0:6])', () => {
    const r = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: gpec2a() } });
    expect(r.ok).toBe(true);
    expect(r.op).toBe('pcm-sec6');
    expect(r.verified).toBe(true);
    expect(r.grounding.level).toBe('bench-verified');
    const re = parseModule(r.bytes, 're');
    expect(arr(re.pcmSec6.raw).slice(0, 6)).toEqual(arr(ROOT).slice(0, 6));
    expect(re.pcmSec6.markerOk).toBe(true);
  });

  it('marries an RFHUB Gen2 from a source (slot1 = root)', () => {
    const r = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: rfhGen2() } });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    expect(arr(parseModule(r.bytes, 're').sec16s[0].raw).slice(0, 16)).toEqual(arr(ROOT));
  });

  it('marries a GPEC2A from a BCM source (the bench BCM-as-truth case)', () => {
    const bcmSrc = rekeyVirginBcmFromRfhub(new Uint8Array(65536).fill(0xFF), ROOT).bytes;
    expect(arr(resolveBcmSec16(bcmSrc).bytes)).toEqual(arr(BCMROOT));
    const r = marryModule({ source: { bytes: bcmSrc }, target: { bytes: gpec2a() } });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
  });
});

describe('marryModule — refuse on doubt', () => {
  it('refuses a blank/virgin source secret', () => {
    const r = marryModule({ source: { bytes: rfhGen2() }, target: { bytes: gpec2a() } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blank|virgin|absent|usable/i);
  });

  it('refuses an UNVERIFIED target writer (Gen1) without allowUnverifiedTarget', () => {
    const gen1 = new Uint8Array(2048).fill(0x00);
    const r = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: gen1, info: { type: 'RFHUB' } } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unverified|allowUnverifiedTarget/i);
  });

  it('proceeds to the Gen1 writer once the risk is explicitly acknowledged', () => {
    const gen1 = new Uint8Array(2048).fill(0x00);
    const r = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: gen1, info: { type: 'RFHUB' } }, allowUnverifiedTarget: true });
    expect(r.op).toBe('rfh-gen1-sec16');
    expect(r.writer).toBe('writeRfhSec16Gen1');
  });

  it('rejects missing source/target bytes', () => {
    expect(marryModule({}).reason).toMatch(/source/i);
    expect(marryModule({ source: { bytes: rfhSrc() } }).reason).toMatch(/target/i);
  });
});
