import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  build0x29Probe,
  classify0x29Response,
  detect0x29,
  shouldProbe0x29ForNrc,
  auth29RefusalMessage,
  AUTH29,
} from '../auth29.js';

const u8 = (...b) => new Uint8Array(b);

describe('UDS 0x29 probe builder', () => {
  it('build0x29Probe emits 0x29 0x00 (deauthenticate)', () => {
    expect(build0x29Probe()).toEqual([0x29, 0x00]);
  });
  it('AUTH29 constants are frozen and consistent', () => {
    expect(AUTH29.SID).toBe(0x29);
    expect(AUTH29.SUB_DEAUTHENTICATE).toBe(0x00);
    expect(AUTH29.PRC).toBe(0x69);
    expect(Object.isFrozen(AUTH29)).toBe(true);
  });
});

describe('classify0x29Response', () => {
  it('positive 0x69 echo → supports', () => {
    expect(classify0x29Response(u8(0x69, 0x00))).toBe('supports');
    expect(classify0x29Response([0x69, 0x00, 0x01, 0x02])).toBe('supports');
  });
  it('NRC 0x11 (serviceNotSupported) → rejects', () => {
    expect(classify0x29Response(u8(0x7F, 0x29, 0x11))).toBe('rejects');
  });
  it('NRC 0x12 (subFunctionNotSupported) → supports (service exists)', () => {
    expect(classify0x29Response(u8(0x7F, 0x29, 0x12))).toBe('supports');
  });
  it('NRC 0x7E and 0x7F (session-not-supported) → supports', () => {
    expect(classify0x29Response(u8(0x7F, 0x29, 0x7E))).toBe('supports');
    expect(classify0x29Response(u8(0x7F, 0x29, 0x7F))).toBe('supports');
  });
  it('other NRCs (0x22, 0x33) → unknown (do not flag)', () => {
    expect(classify0x29Response(u8(0x7F, 0x29, 0x22))).toBe('unknown');
    expect(classify0x29Response(u8(0x7F, 0x29, 0x33))).toBe('unknown');
  });
  it('null / empty / undefined → no-response', () => {
    expect(classify0x29Response(null)).toBe('no-response');
    expect(classify0x29Response(undefined)).toBe('no-response');
    expect(classify0x29Response(u8())).toBe('no-response');
    expect(classify0x29Response([])).toBe('no-response');
  });
  it('NRC for a different SID → no-response (bus echo)', () => {
    expect(classify0x29Response(u8(0x7F, 0x27, 0x11))).toBe('no-response');
  });
  it('truncated 0x7F frame → no-response', () => {
    expect(classify0x29Response(u8(0x7F, 0x29))).toBe('no-response');
  });
});

describe('shouldProbe0x29ForNrc', () => {
  it('returns true for 0x33 and 0x34', () => {
    expect(shouldProbe0x29ForNrc(0x33)).toBe(true);
    expect(shouldProbe0x29ForNrc(0x34)).toBe(true);
  });
  it('returns false for everything else', () => {
    for (const n of [0x10, 0x11, 0x22, 0x35, 0x36, 0x78, undefined, null]){
      expect(shouldProbe0x29ForNrc(n)).toBe(false);
    }
  });
});

describe('detect0x29 (engine driver)', () => {
  const makeEngine = (reply) => ({ uds: vi.fn(async () => reply) });
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns supports=true on positive echo', async () => {
    const engine = makeEngine({ ok: true, d: u8(0x69, 0x00) });
    const r = await detect0x29(engine, 0x7E0, 0x7E8);
    expect(r.classification).toBe('supports');
    expect(r.supports).toBe(true);
    expect(r.raw).toEqual([0x69, 0x00]);
    expect(r.nrc).toBeNull();
    expect(engine.uds).toHaveBeenCalledWith(0x7E0, 0x7E8, [0x29, 0x00]);
  });

  it('returns supports=true on NRC 0x12 with nrc populated', async () => {
    const engine = makeEngine({ ok: true, d: u8(0x7F, 0x29, 0x12) });
    const r = await detect0x29(engine, 0x7E0, 0x7E8);
    expect(r.classification).toBe('supports');
    expect(r.supports).toBe(true);
    expect(r.nrc).toBe(0x12);
  });

  it('returns rejects on NRC 0x11', async () => {
    const engine = makeEngine({ ok: true, d: u8(0x7F, 0x29, 0x11) });
    const r = await detect0x29(engine, 0x7E0, 0x7E8);
    expect(r.classification).toBe('rejects');
    expect(r.supports).toBe(false);
    expect(r.nrc).toBe(0x11);
  });

  it('returns no-response when transport fails', async () => {
    const engine = makeEngine({ ok: false, error: 'timeout' });
    const r = await detect0x29(engine, 0x7E0, 0x7E8);
    expect(r.classification).toBe('no-response');
    expect(r.supports).toBe(false);
    expect(r.error).toBe('timeout');
  });

  it('returns no-response when engine is missing', async () => {
    const r = await detect0x29(null, 0x7E0, 0x7E8);
    expect(r.classification).toBe('no-response');
    expect(r.error).toBe('no engine');
  });

  it('catches engine.uds throwing and reports as no-response', async () => {
    const engine = { uds: vi.fn(async () => { throw new Error('bus dropped'); }) };
    const r = await detect0x29(engine, 0x7E0, 0x7E8);
    expect(r.classification).toBe('no-response');
    expect(r.error).toBe('bus dropped');
  });
});

describe('auth29RefusalMessage', () => {
  it('returns the canonical refusal string', () => {
    expect(auth29RefusalMessage()).toBe('module requires Authentication (0x29) — not yet supported');
  });
});
