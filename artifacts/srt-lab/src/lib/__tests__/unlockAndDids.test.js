import { describe, it, expect } from 'vitest';
import {
  encodeDid,
  vinWriteDids,
  VIN_WRITE_DIDS,
  pickUnlockChain,
  MOD_UNLOCK,
  UNLOCK_FALLBACK,
  tryUnlock,
  unlockKey,
} from '../algos.js';

describe('encodeDid', () => {
  it('encodes 16-bit DIDs as 2 bytes', () => {
    expect(encodeDid(0xF190)).toEqual([0xF1, 0x90]);
    expect(encodeDid(0x7B90)).toEqual([0x7B, 0x90]);
    expect(encodeDid(0x0000)).toEqual([0x00, 0x00]);
    expect(encodeDid(0xFFFF)).toEqual([0xFF, 0xFF]);
  });
  it('encodes 24-bit DIDs as 3 bytes (no truncation)', () => {
    expect(encodeDid(0x6E2025)).toEqual([0x6E, 0x20, 0x25]);
    expect(encodeDid(0x6E2027)).toEqual([0x6E, 0x20, 0x27]);
    expect(encodeDid(0x6EF190)).toEqual([0x6E, 0xF1, 0x90]);
    expect(encodeDid(0x010000)).toEqual([0x01, 0x00, 0x00]);
  });
  it('rejects negative / non-integer / oversize', () => {
    expect(() => encodeDid(-1)).toThrow();
    expect(() => encodeDid(1.5)).toThrow();
    expect(() => encodeDid(0x1000000)).toThrow();
  });
});

describe('vinWriteDids', () => {
  it('returns BCM chain with 24-bit 0x6E2025', () => {
    const d = vinWriteDids('BCM');
    expect(d).toContain(0xF190);
    expect(d).toContain(0x7B90);
    expect(d).toContain(0x7B88);
    expect(d).toContain(0x6E2025);
  });
  it('returns RFHUB chain with 24-bit 0x6E2027', () => {
    expect(vinWriteDids('RFHUB')).toContain(0x6E2027);
  });
  it('returns EPS chain F190 + 0x6EF190', () => {
    expect(vinWriteDids('EPS')).toEqual([0xF190, 0x6EF190]);
  });
  it('returns default ISO chain for unknown / generic modules', () => {
    expect(vinWriteDids('TCM')).toEqual([0xF190, 0x7B90, 0x7B88]);
    expect(vinWriteDids('ECM')).toEqual([0xF190, 0x7B90, 0x7B88]);
    expect(vinWriteDids('UNKNOWN')).toBe(VIN_WRITE_DIDS.default);
  });
});

describe('pickUnlockChain', () => {
  it('forces XTEA-only for SGW tx 0x74F (no fallback)', () => {
    expect(pickUnlockChain(0x74F, 'SGW')).toEqual(['xtea_sgw']);
    expect(pickUnlockChain(0x74F, null)).toEqual(['xtea_sgw']);
  });
  it('uses MOD_UNLOCK preference and appends UNLOCK_FALLBACK', () => {
    const chain = pickUnlockChain(0x7E0, 'ECM');
    expect(chain[0]).toBe('gpec2');
    // UNLOCK_FALLBACK has cda6, gpec2, gpec3, gpec2a, gpec15.
    // gpec2 is the preferred so it's not duplicated; cda6/gpec3/... follow.
    for (const id of UNLOCK_FALLBACK) expect(chain).toContain(id);
    // No duplicates.
    expect(new Set(chain).size).toBe(chain.length);
  });
  it('BCM picks cda6 first', () => {
    expect(pickUnlockChain(0x750, 'BCM')[0]).toBe('cda6');
  });
  it('falls through to unlockIdForTx when module code unknown', () => {
    const chain = pickUnlockChain(0x7E0, 'XYZ');
    expect(chain[0]).toBe('cda6'); // unlockIdForTx returns cda6 for non-0x74F
  });
  it('TIPM picks t80 first', () => {
    expect(MOD_UNLOCK.TIPM).toBe('t80');
    expect(pickUnlockChain(0x74C, 'TIPM')[0]).toBe('t80');
  });
});

// ─── tryUnlock NRC-aware fallback loop ─────────────────────────────────────
// Build a fake uds() that returns whatever the script dictates. The script
// is an array of {req, resp} pairs — every uds call shifts and verifies.
function mockUds(script) {
  const calls = [];
  return {
    calls,
    uds: async (tx, rx, data) => {
      calls.push({ tx, rx, data: Array.from(data) });
      const next = script.shift();
      if (!next) throw new Error('mockUds: ran out of script @ call ' + calls.length);
      if (next.req && JSON.stringify(next.req) !== JSON.stringify(Array.from(data))) {
        throw new Error('mockUds: expected ' + JSON.stringify(next.req) + ' got ' + JSON.stringify(Array.from(data)));
      }
      return next.resp;
    },
  };
}

describe('tryUnlock', () => {
  const seed = [0x11, 0x22, 0x33, 0x44];
  const seedU32 = 0x11223344;

  it('walks fallback chain on NRC 0x35, succeeds with second algo', async () => {
    // BCM (preferred cda6) — but pretend the ECU is actually a gpec2 module
    // mis-labeled as BCM. cda6 key rejected, gpec2 key accepted.
    const cda6Key = unlockKey('cda6', seedU32);
    const cda6Bytes = [(cda6Key >>> 24) & 0xFF, (cda6Key >>> 16) & 0xFF, (cda6Key >>> 8) & 0xFF, cda6Key & 0xFF];
    const gpec2Key = unlockKey('gpec2', seedU32);
    const gpec2Bytes = [(gpec2Key >>> 24) & 0xFF, (gpec2Key >>> 16) & 0xFF, (gpec2Key >>> 8) & 0xFF, gpec2Key & 0xFF];

    const m = mockUds([
      // attempt 1: cda6
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed]) } },
      { req: [0x27, 0x02, ...cda6Bytes], resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x35]) } },
      // attempt 2: gpec2 (next in fallback) — fresh seed
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed]) } },
      { req: [0x27, 0x02, ...gpec2Bytes], resp: { ok: true, d: new Uint8Array([0x67, 0x02]) } },
    ]);

    const result = await tryUnlock(m.uds, 0x750, 0x758, 'BCM', null, 'BCM');
    expect(result).toBe('gpec2');
  });

  it('returns true on already-unlocked (zero seed) without sending key', async () => {
    const m = mockUds([
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, 0, 0, 0, 0]) } },
    ]);
    const result = await tryUnlock(m.uds, 0x750, 0x758, 'BCM', null, 'BCM');
    expect(result).toBe(true);
    expect(m.calls.length).toBe(1);
  });

  it('bails on non-0x35 NRC without trying next algo', async () => {
    const cda6Key = unlockKey('cda6', seedU32);
    const cda6Bytes = [(cda6Key >>> 24) & 0xFF, (cda6Key >>> 16) & 0xFF, (cda6Key >>> 8) & 0xFF, cda6Key & 0xFF];
    const m = mockUds([
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed]) } },
      { req: [0x27, 0x02, ...cda6Bytes], resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x36]) } }, // attempts exceeded
    ]);
    const result = await tryUnlock(m.uds, 0x750, 0x758, 'BCM', null, 'BCM');
    expect(result).toBe(false);
    expect(m.calls.length).toBe(2);
  });

  it('SGW @ 0x74F never falls back to non-XTEA', async () => {
    // After XTEA rejection, must NOT issue any further requests.
    const xteaSeed = [0, 0, 0, 1, 0, 0, 0, 2];
    const m = mockUds([
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...xteaSeed]) } },
      // We don't know the key bytes here; just stub a rejection regardless.
      { resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x35]) } },
    ]);
    const result = await tryUnlock(m.uds, 0x74F, 0x76F, 'SGW', null, 'SGW');
    expect(result).toBe(false);
    expect(m.calls.length).toBe(2);
  });
});
