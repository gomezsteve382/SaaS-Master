import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  build0x29Probe,
  classify0x29Response,
  detect0x29,
  shouldProbe0x29ForNrc,
  auth29RefusalMessage,
  auth29UnlockedMessage,
  AUTH29,
  buildRequestChallenge,
  buildVerifyProof,
  parseChallengeResponse,
  parseVerifyProofResponse,
  runAuth29Handshake,
  attemptAuth29Unlock,
  registerAuth29Strategy,
  getAuth29Strategy,
  clearAuth29Strategies,
  makeHmacSha256Strategy,
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

describe('auth29UnlockedMessage', () => {
  it('returns the canonical success string', () => {
    expect(auth29UnlockedMessage()).toBe('module unlocked via Authentication (0x29) handshake');
  });
});

// ---------------------------------------------------------------------------
// Task #572 — challenge/response handshake helpers.
// ---------------------------------------------------------------------------

describe('buildRequestChallenge / buildVerifyProof', () => {
  it('emits 0x29 0x05 with default communicationConfiguration=0x00', () => {
    expect(buildRequestChallenge()).toEqual([0x29, 0x05, 0x00]);
  });
  it('appends caller-supplied extras after the configuration byte', () => {
    expect(buildRequestChallenge(0x01, [0xAA, 0xBB])).toEqual([0x29, 0x05, 0x01, 0xAA, 0xBB]);
  });
  it('emits 0x29 0x06 (unidirectional) by default for verify proof', () => {
    expect(buildVerifyProof([0x11, 0x22, 0x33])).toEqual([0x29, 0x06, 0x11, 0x22, 0x33]);
  });
  it('honours sub=0x07 (bidirectional) when requested', () => {
    expect(buildVerifyProof([0xDE, 0xAD], 0x07)).toEqual([0x29, 0x07, 0xDE, 0xAD]);
  });
});

describe('parseChallengeResponse', () => {
  it('parses a positive 0x69 0x05 frame without length prefix', () => {
    const r = parseChallengeResponse(u8(0x69, 0x05, 0x00, 0xCA, 0xFE, 0xBA, 0xBE));
    expect(r.ok).toBe(true);
    expect(r.statusInfo).toBe(0x00);
    expect(r.challenge).toEqual([0xCA, 0xFE, 0xBA, 0xBE]);
  });
  it('strips a 2-byte length prefix when it matches the remainder', () => {
    const r = parseChallengeResponse(u8(0x69, 0x05, 0x00, 0x00, 0x04, 0x01, 0x02, 0x03, 0x04));
    expect(r.ok).toBe(true);
    expect(r.challenge).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
  it('treats a 0x7F NRC reply as a failure with the NRC populated', () => {
    const r = parseChallengeResponse(u8(0x7F, 0x29, 0x33));
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x33);
  });
  it('rejects anything that is not 0x69 0x05 or a 0x7F NRC', () => {
    expect(parseChallengeResponse(u8(0x69, 0x06, 0x10)).ok).toBe(false);
    expect(parseChallengeResponse(u8()).ok).toBe(false);
  });
});

describe('parseVerifyProofResponse', () => {
  it('accepts 0x69 0x06 with statusInfo=0x00 (requestAccepted)', () => {
    const r = parseVerifyProofResponse(u8(0x69, 0x06, 0x00));
    expect(r.ok).toBe(true);
    expect(r.statusInfo).toBe(0x00);
  });
  it('accepts statusInfo=0x10 (ownershipVerified) and 0x11 (cert+ownership)', () => {
    expect(parseVerifyProofResponse(u8(0x69, 0x06, 0x10)).ok).toBe(true);
    expect(parseVerifyProofResponse(u8(0x69, 0x07, 0x11)).ok).toBe(true);
  });
  it('rejects unknown statusInfo even on positive 0x69 echo', () => {
    const r = parseVerifyProofResponse(u8(0x69, 0x06, 0x20));
    expect(r.ok).toBe(false);
    expect(r.statusInfo).toBe(0x20);
  });
  it('captures NRC on 0x7F reply', () => {
    const r = parseVerifyProofResponse(u8(0x7F, 0x29, 0x35));
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x35);
  });
});

describe('runAuth29Handshake', () => {
  function scriptedEngine(replies){
    let i = 0;
    const sent = [];
    return {
      sent,
      uds: vi.fn(async (_tx, _rx, frame) => {
        const arr = frame instanceof Uint8Array ? Array.from(frame) : [...frame];
        sent.push(arr);
        const next = replies[i++];
        if (typeof next === 'function') return next(arr);
        return next;
      }),
    };
  }

  it('sends RequestChallenge → strategy → VerifyProof and returns ok on 0x69 0x06 0x00', async () => {
    const engine = scriptedEngine([
      { ok: true, d: u8(0x69, 0x05, 0x00, 0x01, 0x02, 0x03, 0x04) },
      { ok: true, d: u8(0x69, 0x06, 0x10) },
    ]);
    const strategy = vi.fn(async (challenge) => challenge.map((b) => b ^ 0xFF));
    const r = await runAuth29Handshake(engine, 0x7E0, 0x7E8, strategy);
    expect(r.ok).toBe(true);
    expect(r.statusInfo).toBe(0x10);
    expect(strategy).toHaveBeenCalledWith([0x01, 0x02, 0x03, 0x04], expect.objectContaining({ tx: 0x7E0, rx: 0x7E8 }));
    expect(engine.sent[0]).toEqual([0x29, 0x05, 0x00]);
    expect(engine.sent[1]).toEqual([0x29, 0x06, 0xFE, 0xFD, 0xFC, 0xFB]);
  });

  it('reports phase=request on a NRC reply to RequestChallenge', async () => {
    const engine = scriptedEngine([{ ok: true, d: u8(0x7F, 0x29, 0x33) }]);
    const r = await runAuth29Handshake(engine, 0x7E0, 0x7E8, async () => [0]);
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('request');
    expect(r.nrc).toBe(0x33);
  });

  it('reports phase=strategy when the strategy throws', async () => {
    const engine = scriptedEngine([{ ok: true, d: u8(0x69, 0x05, 0x00, 0xAA) }]);
    const r = await runAuth29Handshake(engine, 0x7E0, 0x7E8, async () => { throw new Error('no key'); });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('strategy');
    expect(r.error).toMatch(/no key/);
  });

  it('reports phase=verify on a NRC reply to VerifyProof', async () => {
    const engine = scriptedEngine([
      { ok: true, d: u8(0x69, 0x05, 0x00, 0xAA) },
      { ok: true, d: u8(0x7F, 0x29, 0x35) },
    ]);
    const r = await runAuth29Handshake(engine, 0x7E0, 0x7E8, async () => [0xCC]);
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('verify');
    expect(r.nrc).toBe(0x35);
  });

  it('refuses on unknown statusInfo from the module on VerifyProof', async () => {
    const engine = scriptedEngine([
      { ok: true, d: u8(0x69, 0x05, 0x00, 0xAA) },
      { ok: true, d: u8(0x69, 0x06, 0x42) },
    ]);
    const r = await runAuth29Handshake(engine, 0x7E0, 0x7E8, async () => [0xCC]);
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('verify');
    expect(r.statusInfo).toBe(0x42);
  });

  it('returns no-engine / no-strategy errors without throwing', async () => {
    const r1 = await runAuth29Handshake(null, 0, 0, async () => [0]);
    expect(r1.ok).toBe(false);
    expect(r1.phase).toBe('request');
    const r2 = await runAuth29Handshake({ uds: async () => ({ ok: true, d: u8() }) }, 0, 0, null);
    expect(r2.ok).toBe(false);
    expect(r2.phase).toBe('strategy');
  });
});

describe('strategy registry', () => {
  beforeEach(() => clearAuth29Strategies());

  it('register/get/clear round-trip', () => {
    expect(getAuth29Strategy(0x7E0)).toBeNull();
    const fn = async () => [0];
    registerAuth29Strategy(0x7E0, fn);
    expect(getAuth29Strategy(0x7E0)).toBe(fn);
    registerAuth29Strategy(0x7E0, null);
    expect(getAuth29Strategy(0x7E0)).toBeNull();
  });

  it('attemptAuth29Unlock falls back to registry when no inline strategy is given', async () => {
    const engine = {
      uds: vi.fn(async (_tx, _rx, frame) => {
        const arr = Array.from(frame);
        if (arr[0] === 0x29 && arr[1] === 0x00) return { ok: true, d: u8(0x69, 0x00) };
        if (arr[0] === 0x29 && arr[1] === 0x05) return { ok: true, d: u8(0x69, 0x05, 0x00, 0x01, 0x02) };
        if (arr[0] === 0x29 && arr[1] === 0x06) return { ok: true, d: u8(0x69, 0x06, 0x00) };
        return { ok: false, error: 'unexpected' };
      }),
    };
    registerAuth29Strategy(0x7E0, async (ch) => ch.map((b) => b + 1));
    const r = await attemptAuth29Unlock(engine, 0x7E0, 0x7E8);
    expect(r.authenticated).toBe(true);
    expect(r.via).toBe('handshake');
  });

  it('attemptAuth29Unlock returns no-strategy when nothing is registered', async () => {
    const engine = { uds: vi.fn(async () => ({ ok: true, d: u8(0x69, 0x00) })) };
    const r = await attemptAuth29Unlock(engine, 0x7E0, 0x7E8);
    expect(r.authenticated).toBe(false);
    expect(r.via).toBe('no-strategy');
  });
});

describe('makeHmacSha256Strategy', () => {
  it('produces a deterministic HMAC-SHA256 over the challenge', async () => {
    // RFC 4231 test vector #2: key=Jefe, data="what do ya want for nothing?"
    // → HMAC-SHA256 = 5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843
    const key = new TextEncoder().encode('Jefe');
    const data = new TextEncoder().encode('what do ya want for nothing?');
    const strategy = makeHmacSha256Strategy(key);
    const proof = await strategy(Array.from(data), {});
    const hex = proof.map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('truncates to proofLen and supports a fixed prefix', async () => {
    const strategy = makeHmacSha256Strategy(new Uint8Array([1, 2, 3]), { proofLen: 8, prefix: [0xAA] });
    const proof = await strategy([0x01, 0x02], {});
    expect(proof).toHaveLength(8);
  });
});
