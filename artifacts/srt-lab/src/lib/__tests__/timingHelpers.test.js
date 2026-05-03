import { describe, it, expect, vi } from 'vitest';
import {
  buildReadTimingDefaults,
  buildReadTimingCurrent,
  buildSetTimingValues,
  parseTimingResponse,
  accessTimingParameter,
  TIMING_SUB,
} from '../timing.js';

const u8 = (...b) => new Uint8Array(b);

describe('UDS 0x83 request builders', () => {
  it('buildReadTimingDefaults emits 0x83 0x01', () => {
    expect(buildReadTimingDefaults()).toEqual([0x83, 0x01]);
  });

  it('buildReadTimingCurrent emits 0x83 0x02', () => {
    expect(buildReadTimingCurrent()).toEqual([0x83, 0x02]);
  });

  it('buildSetTimingValues encodes P2 and P2* as big-endian uint16 ms', () => {
    expect(buildSetTimingValues(50, 5000)).toEqual([0x83, 0x03, 0x00, 0x32, 0x13, 0x88]);
    expect(buildSetTimingValues(0x1234, 0xABCD)).toEqual([0x83, 0x03, 0x12, 0x34, 0xAB, 0xCD]);
  });

  it('buildSetTimingValues clamps out-of-range and non-integer inputs to uint16', () => {
    expect(buildSetTimingValues(-100, 0x1FFFF)).toEqual([0x83, 0x03, 0x00, 0x00, 0xFF, 0xFF]);
    expect(buildSetTimingValues(50.7, 5000.4)).toEqual([0x83, 0x03, 0x00, 0x33, 0x13, 0x88]);
  });
});

describe('parseTimingResponse', () => {
  it('decodes a read-defaults positive response', () => {
    const r = parseTimingResponse(u8(0xC3, 0x01, 0x00, 0x32, 0x01, 0xF4));
    expect(r).toEqual({ sub: TIMING_SUB.READ_DEFAULTS, p2Ms: 50, p2StarMs: 500, raw: [0x00, 0x32, 0x01, 0xF4] });
  });

  it('decodes a read-current positive response', () => {
    const r = parseTimingResponse(u8(0xC3, 0x02, 0x13, 0x88, 0x75, 0x30));
    expect(r).toEqual({ sub: TIMING_SUB.READ_CURRENT, p2Ms: 5000, p2StarMs: 30000, raw: [0x13, 0x88, 0x75, 0x30] });
  });

  it('decodes a set-values positive echo', () => {
    const r = parseTimingResponse(u8(0xC3, 0x03, 0x13, 0x88, 0x75, 0x30));
    expect(r).toEqual({ sub: TIMING_SUB.SET_VALUES, p2Ms: 5000, p2StarMs: 30000, raw: [0x13, 0x88, 0x75, 0x30] });
  });

  it('rejects a 0x7F NRC frame', () => {
    expect(parseTimingResponse(u8(0x7F, 0x83, 0x12))).toBeNull();
  });

  it('rejects a truncated body', () => {
    expect(parseTimingResponse(u8(0xC3, 0x01, 0x00))).toBeNull();
  });

  it('rejects an unknown sub-function in the echo', () => {
    expect(parseTimingResponse(u8(0xC3, 0x09, 0x00, 0x32, 0x01, 0xF4))).toBeNull();
  });
});

describe('accessTimingParameter (engine-driven)', () => {
  function makeEngine(scriptByReq){
    const calls = [];
    return {
      calls,
      uds: vi.fn(async (_tx, _rx, data) => {
        calls.push(Array.from(data));
        const key = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
        if (!(key in scriptByReq)) throw new Error('no script for ' + key);
        return scriptByReq[key];
      }),
    };
  }

  it('reads current timing and returns a parsed P2/P2* pair', async () => {
    const eng = makeEngine({ '83 02': { ok: true, d: u8(0xC3, 0x02, 0x00, 0x32, 0x01, 0xF4) } });
    const r = await accessTimingParameter(eng, 0x7E0, 0x7E8, 'current');
    expect(r.ok).toBe(true);
    expect(r.p2Ms).toBe(50);
    expect(r.p2StarMs).toBe(500);
  });

  it('reads defaults via sub 0x01', async () => {
    const eng = makeEngine({ '83 01': { ok: true, d: u8(0xC3, 0x01, 0x00, 0x32, 0x01, 0xF4) } });
    const r = await accessTimingParameter(eng, 0x7E0, 0x7E8, 'defaults');
    expect(r.ok).toBe(true);
    expect(r.sub).toBe(TIMING_SUB.READ_DEFAULTS);
  });

  it('writes new values via sub 0x03 and returns the echoed pair', async () => {
    const eng = makeEngine({ '83 03 13 88 75 30': { ok: true, d: u8(0xC3, 0x03, 0x13, 0x88, 0x75, 0x30) } });
    const r = await accessTimingParameter(eng, 0x7E0, 0x7E8, 'set', { p2Ms: 5000, p2StarMs: 30000 });
    expect(r.ok).toBe(true);
    expect(r.p2Ms).toBe(5000);
    expect(r.p2StarMs).toBe(30000);
    expect(eng.calls[0]).toEqual([0x83, 0x03, 0x13, 0x88, 0x75, 0x30]);
  });

  it('surfaces an NRC byte from a 0x7F response', async () => {
    const eng = makeEngine({ '83 02': { ok: true, d: u8(0x7F, 0x83, 0x12) } });
    const r = await accessTimingParameter(eng, 0x7E0, 0x7E8, 'current');
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x12);
  });

  it('surfaces a transport failure cleanly', async () => {
    const eng = makeEngine({ '83 02': { ok: false, error: 'timeout' } });
    const r = await accessTimingParameter(eng, 0x7E0, 0x7E8, 'current');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/);
  });

  it('returns an error for an unknown kind without calling the engine', async () => {
    const eng = makeEngine({});
    const r = await accessTimingParameter(eng, 0x7E0, 0x7E8, 'bogus');
    expect(r.ok).toBe(false);
    expect(eng.calls.length).toBe(0);
  });
});
