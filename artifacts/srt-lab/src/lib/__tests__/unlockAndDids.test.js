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
  vinFromReadResponse,
  vinReadbackOk,
  VIN_TAIL8_DIDS,
} from '../algos.js';
import { unlockKeyBytesByModule } from '@workspace/uds';

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
  it('prefers verified algorithms, then MOD_UNLOCK pref, then UNLOCK_FALLBACK', () => {
    const chain = pickUnlockChain(0x7E0, 'ECM');
    // Factory-verified PCM algorithms are tried first (prefer-verified-by-code).
    expect(chain[0]).toBe('verified:ngc_engine');
    expect(chain).toContain('verified:gpec');
    // MOD_UNLOCK preference (gpec2) and every UNLOCK_FALLBACK id still present.
    expect(chain).toContain('gpec2');
    for (const id of UNLOCK_FALLBACK) expect(chain).toContain(id);
    // No duplicates.
    expect(new Set(chain).size).toBe(chain.length);
  });
  it('BCM picks verified:huntsville_bcm first, cda6 still in the chain', () => {
    const chain = pickUnlockChain(0x750, 'BCM');
    expect(chain[0]).toBe('verified:huntsville_bcm');
    expect(chain).toContain('cda6');
  });
  it('falls through to unlockIdForTx when module code unknown', () => {
    const chain = pickUnlockChain(0x7E0, 'XYZ');
    expect(chain[0]).toBe('cda6'); // unlockIdForTx returns cda6 for non-0x74F
  });
  it('TIPM picks verified:motorola_tipm7 first, t80 still in the chain', () => {
    expect(MOD_UNLOCK.TIPM).toBe('t80');
    const chain = pickUnlockChain(0x74C, 'TIPM');
    expect(chain[0]).toBe('verified:motorola_tipm7');
    expect(chain).toContain('t80');
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

  it('walks fallback chain on NRC 0x35, succeeds with later algo (alfa_ao now between cda6 and gpec2)', async () => {
    // BCM (preferred cda6) — but pretend the ECU is actually a gpec2 module
    // mis-labeled as BCM. cda6 + alfa_ao both rejected, gpec2 accepted.
    // alfa_ao is now in slot 2 of UNLOCK_FALLBACK so we explicitly script
    // its rejection to prove the loop walks past it before reaching gpec2.
    const keyBytesFor = (aid) => {
      // alfa_* algorithms are byte-native; route through unlockKeyBytes for
      // those, u32 for the rest. The script doesn't need to care, but the
      // mock does — so derive the exact bytes the loop will send.
      const k = unlockKey(aid, seedU32);
      return [(k >>> 24) & 0xFF, (k >>> 16) & 0xFF, (k >>> 8) & 0xFF, k & 0xFF];
    };
    const m = mockUds([
      // attempt 1: cda6
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed]) } },
      { req: [0x27, 0x02, ...keyBytesFor('cda6')], resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x35]) } },
      // attempt 2: alfa_ao (NEW — directly after cda6)
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed]) } },
      { req: [0x27, 0x02, ...keyBytesFor('alfa_ao')], resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x35]) } },
      // attempt 3: gpec2 (next in fallback) — accepted
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed]) } },
      { req: [0x27, 0x02, ...keyBytesFor('gpec2')], resp: { ok: true, d: new Uint8Array([0x67, 0x02]) } },
    ]);

    const result = await tryUnlock(m.uds, 0x750, 0x758, 'IPC', null, 'IPC');
    expect(result).toBe('gpec2');
  });

  it('unlocks a BCM with the factory-verified huntsville_bcm key on the first try', async () => {
    // The prefer-verified-by-code wiring puts verified:huntsville_bcm first. The
    // wire carries a 4-byte seed (low 16 bits = the DLL seed 0x1234 → key 0x526C);
    // the adapter zero-extends the 16-bit key to the seed width, big-endian.
    const seed4 = [0x00, 0x00, 0x12, 0x34];
    const key4 = unlockKeyBytesByModule('huntsville_bcm', seed4); // [0x00,0x00,0x52,0x6C]
    expect(key4).toEqual([0x00, 0x00, 0x52, 0x6c]);
    const m = mockUds([
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed4]) } },
      { req: [0x27, 0x02, ...key4], resp: { ok: true, d: new Uint8Array([0x67, 0x02]) } },
    ]);
    const result = await tryUnlock(m.uds, 0x750, 0x758, 'BCM', null, 'BCM');
    expect(result).toBe('verified:huntsville_bcm'); // unlocked via the verified algo
    expect(m.calls.length).toBe(2); // first (verified) algo succeeded — no wasted attempts
  });

  it('returns true on already-unlocked (zero seed) without sending key', async () => {
    const m = mockUds([
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, 0, 0, 0, 0]) } },
    ]);
    const result = await tryUnlock(m.uds, 0x750, 0x758, 'BCM', null, 'BCM');
    expect(result).toBe(true);
    expect(m.calls.length).toBe(1);
  });

  it('continues fallback chain on chain-continuing NRCs, hard-fails only after exhaustion', async () => {
    // BCM chain: cda6 → gpec2 → gpec3 → gpec2a → gpec15 (5 algos).
    // Every key is rejected with chain-continuing NRCs (0x35 invalidKey,
    // 0x33 securityAccessDenied, 0x31 outOfRange, 0x12 subFunctionNotSupported)
    // and the loop must walk every algo before giving up. We script 10
    // calls (seed + key per algo) and expect all of them consumed.
    //
    // Task #501 added two terminating NRCs:
    //   0x36 (exceededNumberOfAttempts) → abort chain immediately
    //   0x37 (requiredTimeDelayNotExpired) → sleep + retry SAME algo once
    // Those paths are exercised in nrc36_37.test.mjs and intentionally
    // excluded here so this test still asserts the "walk the whole chain"
    // contract for the conventional NRCs.
    const keyBytesFor = (aid) => {
      const k = unlockKey(aid, seedU32);
      return [(k >>> 24) & 0xFF, (k >>> 16) & 0xFF, (k >>> 8) & 0xFF, k & 0xFF];
    };
    const chain = pickUnlockChain(0x750, 'IPC');
    const nrcs  = [0x35, 0x33, 0x31, 0x12, 0x35];
    const script = [];
    chain.forEach((aid, i) => {
      script.push({ req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed]) } });
      script.push({ req: [0x27, 0x02, ...keyBytesFor(aid)], resp: { ok: true, d: new Uint8Array([0x7F, 0x27, nrcs[i % nrcs.length]]) } });
    });
    // Task #567 — a 0x33 in the chain triggers ONE post-exhaustion 0x29
    // Authentication probe. Reply with NRC 0x11 (serviceNotSupported) so
    // the loop falls through to the regular "exhausted" failure.
    script.push({ req: [0x29, 0x00], resp: { ok: true, d: new Uint8Array([0x7F, 0x29, 0x11]) } });
    const m = mockUds(script);
    const result = await tryUnlock(m.uds, 0x750, 0x758, 'IPC', null, 'IPC');
    expect(result).toBe(false);
    // chain.length * 2 (seed+key per algo) + 1 post-exhaustion 0x29 probe.
    expect(m.calls.length).toBe(chain.length * 2 + 1);
  });

  it('writer pattern: when tryUnlock returns false, no 0x2E is issued', async () => {
    // Simulates the OBDTab/BenchTab gating contract: if tryUnlock returns
    // false the caller must skip writes entirely. We exercise the real
    // writer-side branch by inlining the same conditional and verifying
    // zero writes occur after an exhausted unlock chain.
    const cda6Key = unlockKey('cda6', seedU32);
    const cda6Bytes = [(cda6Key >>> 24) & 0xFF, (cda6Key >>> 16) & 0xFF, (cda6Key >>> 8) & 0xFF, cda6Key & 0xFF];
    const m = mockUds([
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed]) } },
      { req: [0x27, 0x02, ...cda6Bytes], resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x35]) } },
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x36]) } },
    ]);
    const ur = await tryUnlock(m.uds, 0x750, 0x758, 'IPC', null, 'IPC');
    expect(ur).toBe(false);
    let wroteAnything = false;
    if (ur !== false) {
      // would-be writes — must NOT execute
      await m.uds(0x750, 0x758, [0x2E, 0xF1, 0x90, 0x41]);
      wroteAnything = true;
    }
    expect(wroteAnything).toBe(false);
    // confirm no 0x2E ever hit the bus
    expect(m.calls.some(c => c.data[0] === 0x2E)).toBe(false);
  });

  it('Task #567 — 0x29 detection returns plain false so writers stay gated', async () => {
    // Walk the BCM chain (5 algos) and reject every key with NRC 0x33
    // (securityAccessDenied → triggers the post-exhaustion 0x29 probe).
    // Probe answers with a positive 0x69 echo → module supports 0x29.
    // Contract: tryUnlock must return strict `false` (NOT an object), so
    // every existing writer-side `=== false` gate skips its 0x2E writes.
    const keyBytesFor = (aid) => {
      const k = unlockKey(aid, seedU32);
      return [(k >>> 24) & 0xFF, (k >>> 16) & 0xFF, (k >>> 8) & 0xFF, k & 0xFF];
    };
    const chain = pickUnlockChain(0x750, 'IPC');
    const script = [];
    chain.forEach((aid) => {
      script.push({ req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seed]) } });
      script.push({ req: [0x27, 0x02, ...keyBytesFor(aid)], resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x33]) } });
    });
    // Module supports 0x29 (positive echo).
    script.push({ req: [0x29, 0x00], resp: { ok: true, d: new Uint8Array([0x69, 0x00]) } });
    const m = mockUds(script);
    const ur = await tryUnlock(m.uds, 0x750, 0x758, 'IPC', null, 'IPC');
    expect(ur).toBe(false);              // STRICT — not an object
    expect(ur).not.toBe(true);
    // Mirror the writer-side gating — `if (ur !== false)` MUST skip writes.
    let wroteAnything = false;
    if (ur !== false) {
      await m.uds(0x750, 0x758, [0x2E, 0xF1, 0x90, 0x41]);
      wroteAnything = true;
    }
    expect(wroteAnything).toBe(false);
    expect(m.calls.some(c => c.data[0] === 0x2E)).toBe(false);
  });

  it('vinReadbackOk accepts 17-char full match for every DID', () => {
    const nv = '1C4HJXEN5MW123456';
    for (const did of [0xF190, 0x7B90, 0x7B88, 0x6E2025, 0x6E2027, 0x6EF190]) {
      expect(vinReadbackOk(did, nv, nv)).toBe(true);
    }
    expect(vinReadbackOk(0xF190, '1C4HJXEN5MW999999', nv)).toBe(false);
  });

  it('vinReadbackOk accepts the 8-char tail ONLY for 0x6E2025 / 0x6E2027', () => {
    const nv   = '1C4HJXEN5MW123456';
    const tail = nv.slice(-8); // 'MW123456'
    expect(VIN_TAIL8_DIDS.has(0x6E2025)).toBe(true);
    expect(VIN_TAIL8_DIDS.has(0x6E2027)).toBe(true);
    expect(vinReadbackOk(0x6E2025, tail, nv)).toBe(true);
    expect(vinReadbackOk(0x6E2027, tail, nv)).toBe(true);
    // Full-VIN DIDs must NOT accept an 8-char string as a match.
    expect(vinReadbackOk(0xF190, tail, nv)).toBe(false);
    expect(vinReadbackOk(0x7B90, tail, nv)).toBe(false);
    expect(vinReadbackOk(0x7B88, tail, nv)).toBe(false);
    expect(vinReadbackOk(0x6EF190, tail, nv)).toBe(false);
    // Wrong tail must still fail on the mirror DIDs.
    expect(vinReadbackOk(0x6E2025, 'XX999999', nv)).toBe(false);
  });

  it('vinFromReadResponse extracts an 8-char mirror payload', () => {
    const dh = encodeDid(0x6E2025); // [0x6E, 0x20, 0x25]
    const tail = 'MW123456';
    const d = new Uint8Array([0x62, ...dh, ...Array.from(tail).map(c => c.charCodeAt(0))]);
    expect(vinFromReadResponse(d, 0x6E2025)).toBe(tail);
  });

  it('per-DID read-back loop accepts an 8-char mirror as MATCH', async () => {
    // BCM writes F190+7B90+7B88+0x6E2025. The 24-bit mirror returns only
    // the trailing 8 chars; the full DIDs return the full 17. The loop
    // must declare every DID OK.
    const newVin = '1C4HJXEN5MW123456';
    const make = (did, payload) => {
      const dh = encodeDid(did);
      const a = new Uint8Array(1 + dh.length + payload.length);
      a[0] = 0x62; dh.forEach((b, i) => { a[1 + i] = b; });
      for (let i = 0; i < payload.length; i++) a[1 + dh.length + i] = payload.charCodeAt(i);
      return { ok: true, d: a };
    };
    const dids = vinWriteDids('BCM');
    const m = mockUds(dids.map(d => ({
      req: [0x22, ...encodeDid(d)],
      resp: d === 0x6E2025 ? make(d, newVin.slice(-8)) : make(d, newVin),
    })));
    let allOk = true;
    for (const did of dids) {
      const rb = await m.uds(0x750, 0x758, [0x22, ...encodeDid(did)]);
      const tail = vinFromReadResponse(rb.d, did);
      if (!vinReadbackOk(did, tail, newVin)) allOk = false;
    }
    expect(allOk).toBe(true);
  });

  it('per-DID read-back loop detects MISMATCH on a 24-bit mirror DID', async () => {
    // Simulates writing F190+7B90+7B88+0x6E2025 to BCM, then reading every
    // DID back. F190/7B90/7B88 echo the new VIN; the 24-bit 0x6E2025
    // mirror still holds the OLD VIN (write silently rejected). The
    // read-back loop must flag exactly that DID as mismatched.
    const newVin  = '1C4HJXEN5MW123456';
    const oldVin  = '1C4HJXEN5MW000000';
    const okFor = (didBytes, vin) => {
      const a = new Uint8Array(1 + didBytes.length + 17);
      a[0] = 0x62;
      didBytes.forEach((b, i) => { a[1 + i] = b; });
      for (let i = 0; i < 17; i++) a[1 + didBytes.length + i] = vin.charCodeAt(i);
      return { ok: true, d: a };
    };
    const dids = vinWriteDids('BCM'); // [F190,7B90,7B88,0x6E2025]
    const responses = dids.map(d => {
      const dh = encodeDid(d);
      return d === 0x6E2025
        ? okFor(dh, oldVin)   // mismatch
        : okFor(dh, newVin);  // match
    });
    const m = mockUds(responses.map((r, i) => ({
      req: [0x22, ...encodeDid(dids[i])], resp: r,
    })));
    const results = {};
    let allOk = true;
    for (const did of dids) {
      const rb = await m.uds(0x750, 0x758, [0x22, ...encodeDid(did)]);
      const tail = vinFromReadResponse(rb.d, did);
      const ok = tail === newVin;
      results[did] = { tail, ok };
      if (!ok) allOk = false;
    }
    expect(allOk).toBe(false);
    expect(results[0xF190].ok).toBe(true);
    expect(results[0x7B90].ok).toBe(true);
    expect(results[0x7B88].ok).toBe(true);
    expect(results[0x6E2025].ok).toBe(false);
    expect(results[0x6E2025].tail).toBe(oldVin);
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
