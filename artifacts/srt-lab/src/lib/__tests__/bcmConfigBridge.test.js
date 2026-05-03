import { describe, it, expect } from 'vitest';
import {
  readBcmConfigDid,
  readAllBcmConfigDids,
  writeBcmConfigDid,
  BCM_CONFIG_DIDS,
} from '../bcmConfigBridge.js';
import { didPayloadByteLength } from '../bcmConfigCodec.js';

/* Build a fake bridge engine that returns programmed responses for
 * each (cmd) tuple. The engine just looks at the first byte (service
 * id) plus, for 22/2E, the DID, and matches against an in-memory map
 * keyed as `${sid}:${didHi}${didLo}`. Anything not programmed returns
 * NRC 0x11 (Service Not Supported). */
function fakeEngine(programmed = {}) {
  const calls = [];
  return {
    calls,
    uds: async (tx, rx, frame) => {
      calls.push({ tx, rx, frame: Array.from(frame) });
      const sid = frame[0];
      let key = sid.toString(16).padStart(2, '0');
      if (sid === 0x22 || sid === 0x2E) {
        key += ':' + frame[1].toString(16).padStart(2, '0') + frame[2].toString(16).padStart(2, '0');
      }
      const resp = programmed[key];
      if (!resp) {
        return { ok: true, d: new Uint8Array([0x7F, sid, 0x11]) };
      }
      return { ok: true, d: new Uint8Array(typeof resp === 'function' ? resp(frame) : resp) };
    },
  };
}

describe('bcmConfigBridge.readBcmConfigDid', () => {
  it('issues 10 03 then 22 DEnn and returns the payload', async () => {
    const eng = fakeEngine({
      '10': [0x50, 0x03, 0, 0, 0, 0],
      '22:de0a': [0x62, 0xDE, 0x0A, 0xAA, 0xBB, 0xCC, 0xDD],
    });
    const r = await readBcmConfigDid({ engine: eng, did: 0xDE0A });
    expect(r.ok).toBe(true);
    expect(Array.from(r.payload)).toEqual([0xAA, 0xBB, 0xCC, 0xDD]);
    expect(eng.calls[0].frame).toEqual([0x10, 0x03]);
    expect(eng.calls[1].frame).toEqual([0x22, 0xDE, 0x0A]);
  });

  it('surfaces NRC on the read', async () => {
    const eng = fakeEngine({
      '10': [0x50, 0x03, 0, 0, 0, 0],
      // 22 DE00 not programmed → fake returns NRC 0x11
    });
    const r = await readBcmConfigDid({ engine: eng, did: 0xDE00 });
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x11);
    expect(r.error).toMatch(/NRC 0x11/);
  });

  it('skips 10 03 when enterSession=false', async () => {
    const eng = fakeEngine({
      '22:de0c': [0x62, 0xDE, 0x0C, 0x01, 0x02],
    });
    const r = await readBcmConfigDid({ engine: eng, did: 0xDE0C, enterSession: false });
    expect(r.ok).toBe(true);
    expect(eng.calls.length).toBe(1);
    expect(eng.calls[0].frame[0]).toBe(0x22);
  });
});

describe('bcmConfigBridge.readAllBcmConfigDids', () => {
  it('walks every DID and only enters extended session once', async () => {
    const programmed = { '10': [0x50, 0x03, 0, 0, 0, 0] };
    for (const did of BCM_CONFIG_DIDS) {
      const k = '22:de' + (did & 0xFF).toString(16).padStart(2, '0');
      programmed[k] = [0x62, 0xDE, did & 0xFF, 0x00];
    }
    const eng = fakeEngine(programmed);
    const r = await readAllBcmConfigDids({ engine: eng });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.results).length).toBe(BCM_CONFIG_DIDS.length);
    for (const did of BCM_CONFIG_DIDS) {
      expect(r.results[did].ok).toBe(true);
    }
    // 1 session control + 13 reads
    expect(eng.calls.filter((c) => c.frame[0] === 0x10).length).toBe(1);
    expect(eng.calls.filter((c) => c.frame[0] === 0x22).length).toBe(BCM_CONFIG_DIDS.length);
  });
});

describe('bcmConfigBridge.writeBcmConfigDid', () => {
  it('refuses payloads of the wrong length by default', async () => {
    const eng = fakeEngine({});
    const did = 0xDE0A;
    const wrong = new Uint8Array(didPayloadByteLength(did) - 1);
    const r = await writeBcmConfigDid(eng, did, wrong);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/length/);
    expect(eng.calls.length).toBe(0);
  });

  it('emits 2E DEnn and accepts 6E', async () => {
    const did = 0xDE0A;
    const len = didPayloadByteLength(did);
    const eng = fakeEngine({ '2e:de0a': [0x6E, 0xDE, 0x0A] });
    const payload = new Uint8Array(len).fill(0xA5);
    const r = await writeBcmConfigDid(eng, did, payload);
    expect(r.ok).toBe(true);
    expect(eng.calls[0].frame.slice(0, 3)).toEqual([0x2E, 0xDE, 0x0A]);
    expect(eng.calls[0].frame.slice(3)).toEqual(Array.from(payload));
  });

  it('reset=true triggers 11 01 and surfaces failure on bad reset reply', async () => {
    const did = 0xDE00;
    const len = didPayloadByteLength(did);
    const eng = fakeEngine({
      '2e:de00': [0x6E, 0xDE, 0x00],
      // 11 01 not programmed → NRC 0x11
    });
    const r = await writeBcmConfigDid(eng, did, new Uint8Array(len), { reset: true });
    expect(r.ok).toBe(false);
    expect(r.resetResult.ok).toBe(false);
    expect(r.resetResult.nrc).toBe(0x11);
  });

  it('reset=true with successful 51 01 marks resetResult ok', async () => {
    const did = 0xDE00;
    const len = didPayloadByteLength(did);
    const eng = fakeEngine({
      '2e:de00': [0x6E, 0xDE, 0x00],
      '11': [0x51, 0x01],
    });
    const r = await writeBcmConfigDid(eng, did, new Uint8Array(len), { reset: true });
    expect(r.ok).toBe(true);
    expect(r.resetResult.ok).toBe(true);
  });
});
