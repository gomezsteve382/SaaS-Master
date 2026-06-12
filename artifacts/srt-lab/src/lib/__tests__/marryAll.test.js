import { describe, it, expect } from 'vitest';
import { marryAll } from '../marryModule.js';
import { parseModule } from '../parseModule.js';
import { rekeyVirginBcmFromRfhub } from '../mpc5606bBcm.js';

const ROOT = Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + 7) & 0xff);
const arr = (x) => (x ? Array.from(x) : x);
const gpec2a = () => { const b = new Uint8Array(4096); const v = '2C3CDXBG1KH100001'; for (let i = 0; i < 17; i++) b[i] = v.charCodeAt(i); return b; };
const rfhGen2 = () => { const b = new Uint8Array(4096); b[0x500] = 0xAA; b[0x501] = 0x55; b[0x502] = 0x31; b[0x503] = 0x01; return b; };
const bcmSrc = () => rekeyVirginBcmFromRfhub(new Uint8Array(65536).fill(0xFF), ROOT).bytes;

describe('marryAll — 3-module marry from a BCM source of truth', () => {
  it('marries RFHUB + PCM from the BCM and confirms all 3 in sync', () => {
    const r = marryAll({ bcm: { bytes: bcmSrc() }, rfhub: { bytes: rfhGen2() }, pcm: { bytes: gpec2a() }, vin: '2C3CDXBG1KH100001' });
    expect(r.ok).toBe(true);
    expect(r.crossSync).toBe(true);
    expect(r.source).toBe('BCM');
    expect(r.files.map((f) => f.name).sort()).toEqual(['PCM_MARRIED_2C3CDXBG1KH100001.bin', 'RFHUB_MARRIED_2C3CDXBG1KH100001.bin']);
    // both married outputs derive from the same BCM root
    const rfhSlot = parseModule(r.results.rfhub.bytes, 're').sec16s[0].raw;
    const pcmSec6 = parseModule(r.results.pcm.bytes, 're').pcmSec6.raw;
    expect(arr(rfhSlot).slice(0, 16)).toEqual(arr(ROOT));
    expect(arr(pcmSec6).slice(0, 6)).toEqual(arr(ROOT).slice(0, 6));
    expect(arr(rfhSlot).slice(0, 6)).toEqual(arr(pcmSec6).slice(0, 6)); // in sync
  });

  it('works with a single target (RFHUB only)', () => {
    const r = marryAll({ bcm: { bytes: bcmSrc() }, rfhub: { bytes: rfhGen2() } });
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(1);
  });

  it('refuses without a BCM, without targets, or from a virgin BCM', () => {
    expect(marryAll({ rfhub: { bytes: rfhGen2() } }).ok).toBe(false);
    expect(marryAll({ bcm: { bytes: bcmSrc() } }).ok).toBe(false);
    expect(marryAll({ bcm: { bytes: new Uint8Array(65536).fill(0xFF) }, pcm: { bytes: gpec2a() } }).ok).toBe(false);
  });
});
