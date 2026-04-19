import { describe, it, expect } from 'vitest';
import { programVin } from '../vinProgrammer.js';
import { getRow } from '../moduleRegistry.js';
import { encodeDid, vinWriteDids, unlockKey } from '../algos.js';

// Minimal scripted UDS mock — same pattern as unlockAndDids.test.js.
function mockUds(script) {
  const calls = [];
  return {
    calls,
    uds: async (tx, rx, data) => {
      calls.push({ tx, rx, data: Array.from(data) });
      const next = script.shift();
      if (!next) throw new Error('mockUds: ran out of script @ call ' + calls.length + ' req=' + JSON.stringify(Array.from(data)));
      if (next.req && JSON.stringify(next.req) !== JSON.stringify(Array.from(data))) {
        throw new Error('mockUds: expected ' + JSON.stringify(next.req) + ' got ' + JSON.stringify(Array.from(data)));
      }
      return next.resp;
    },
  };
}

const VIN = '1C4HJXEN5MW123456';

function vinReadResp(did, vinOrTail) {
  const dh = encodeDid(did);
  const a = new Uint8Array(1 + dh.length + vinOrTail.length);
  a[0] = 0x62;
  dh.forEach((b, i) => { a[1 + i] = b; });
  for (let i = 0; i < vinOrTail.length; i++) a[1 + dh.length + i] = vinOrTail.charCodeAt(i);
  return { ok: true, d: a };
}

function keyBytesFor(aid, seedU32) {
  const k = unlockKey(aid, seedU32);
  return [(k >>> 24) & 0xFF, (k >>> 16) & 0xFF, (k >>> 8) & 0xFF, k & 0xFF];
}

describe('programVin', () => {
  it('refuses non-VIN-writable rows up front', async () => {
    const sgw = getRow('SGW');
    const m = mockUds([]);
    const r = await programVin({ eng: m, row: sgw, vin: VIN });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('preflight');
    expect(m.calls.length).toBe(0);
  });

  it('refuses a malformed VIN before any bus traffic', async () => {
    const r = await programVin({ eng: mockUds([]), row: getRow('BCM'), vin: 'TOO_SHORT' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('preflight');
  });

  it('aborts on preflight failure without sending any 0x2E', async () => {
    const dids = vinWriteDids('BCM');
    const m = mockUds([
      // 0x22 F190 preflight returns NO_DATA
      { req: [0x22, ...encodeDid(dids[0])], resp: { ok: false, raw: 'NO DATA' } },
    ]);
    const r = await programVin({ eng: m, row: getRow('BCM'), vin: VIN });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('preflight');
    expect(m.calls.some(c => c.data[0] === 0x2E)).toBe(false);
  });

  it('writes the BCM DID chain in the documented order and verifies each', async () => {
    const row = getRow('BCM');
    const dids = vinWriteDids('BCM'); // [F190, 7B90, 7B88, 0x6E2025]
    const seedBytes = [0x11, 0x22, 0x33, 0x44];
    const seedU32 = 0x11223344;
    const oldVin = '1C4HJXEN5MW000000';

    const script = [
      // preflight read F190 → old VIN
      { req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], oldVin) },
      // 0x10 0x03 extended session
      { req: [0x10, 0x03], resp: { ok: true, d: new Uint8Array([0x50, 0x03]) } },
      // tryUnlock: seed + key (cda6 succeeds first try)
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seedBytes]) } },
      { req: [0x27, 0x02, ...keyBytesFor('cda6', seedU32)], resp: { ok: true, d: new Uint8Array([0x67, 0x02]) } },
    ];
    // Per-DID write + readback. The 24-bit mirror returns only the trailing 8 chars.
    for (const did of dids) {
      const vb = Array.from(VIN).map(c => c.charCodeAt(0));
      script.push({ req: [0x2E, ...encodeDid(did), ...vb], resp: { ok: true, d: new Uint8Array([0x6E, ...encodeDid(did)]) } });
      script.push({ req: [0x22, ...encodeDid(did)], resp: vinReadResp(did, did === 0x6E2025 ? VIN.slice(-8) : VIN) });
    }
    // Final F190 summary read.
    script.push({ req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], VIN) });

    const m = mockUds(script);
    const r = await programVin({ eng: m, row, vin: VIN });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.beforeVin).toBe(oldVin);
    expect(r.afterVin).toBe(VIN);
    expect(r.unlockAlgo).toBe('cda6');
    expect(r.didResults.length).toBe(dids.length);
    for (const dr of r.didResults) {
      expect(dr.wrote).toBe(true);
      expect(dr.match).toBe(true);
    }
  });

  it('reports reason="unlock" when every algorithm in the chain fails', async () => {
    const row = getRow('BCM');
    const dids = vinWriteDids('BCM');
    const seedBytes = [0x11, 0x22, 0x33, 0x44];
    const seedU32 = 0x11223344;
    const script = [
      { req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], '1C4HJXEN5MW000000') },
      { req: [0x10, 0x03], resp: { ok: true, d: new Uint8Array([0x50, 0x03]) } },
    ];
    // tryUnlock walks the entire chain — every key is rejected with NRC 0x35.
    // pickUnlockChain('BCM',0x750) under the engine's MOD_UNLOCK override is
    // [cda6, alfa_ao, gpec2, gpec3, gpec2a, gpec15, alfa_w6_tt, alfa_w6_tu,
    //  alfa_w6_tv, alfa_w6_ez] — 10 attempts.
    const chainLen = 10;
    for (let i = 0; i < chainLen; i++) {
      script.push({ req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seedBytes]) } });
      // We don't validate the key bytes — the loop must just walk all of them.
      script.push({ resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x35]) } });
    }
    const m = mockUds(script);
    const r = await programVin({ eng: m, row, vin: VIN });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unlock');
    expect(r.unlockAlgo).toBe(false);
    // Crucially, no 0x2E was sent.
    expect(m.calls.some(c => c.data[0] === 0x2E)).toBe(false);
  });

  it('reports reason="verify" when a DID writes OK but reads back wrong', async () => {
    const row = getRow('ECM');
    const dids = vinWriteDids('ECM'); // default chain: F190, 7B90, 7B88
    const seedBytes = [0xAA, 0xBB, 0xCC, 0xDD];
    const seedU32 = 0xAABBCCDD;
    const wrong = '1C4HJXEN5MW999999';

    const script = [
      { req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], '1C4HJXEN5MW000000') },
      { req: [0x10, 0x03], resp: { ok: true, d: new Uint8Array([0x50, 0x03]) } },
      // ECM's preferred is gpec2 — first algo in the chain.
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seedBytes]) } },
      { req: [0x27, 0x02, ...keyBytesFor('gpec2', seedU32)], resp: { ok: true, d: new Uint8Array([0x67, 0x02]) } },
    ];
    for (const did of dids) {
      const vb = Array.from(VIN).map(c => c.charCodeAt(0));
      script.push({ req: [0x2E, ...encodeDid(did), ...vb], resp: { ok: true, d: new Uint8Array([0x6E, ...encodeDid(did)]) } });
      // F190 reads back wrong; the rest are fine.
      script.push({ req: [0x22, ...encodeDid(did)], resp: vinReadResp(did, did === 0xF190 ? wrong : VIN) });
    }
    script.push({ req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], wrong) });

    const m = mockUds(script);
    const r = await programVin({ eng: m, row, vin: VIN });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('verify');
    expect(r.didResults[0].match).toBe(false);
    expect(r.didResults[1].match).toBe(true);
  });

  it('attempts pending-w7 rows and fail-softs with an explicit W7 hint in errors', async () => {
    // The engine no longer hard-blocks pending-w7 — the bus traffic is
    // attempted, the unlock chain exhausts (because no w7_* algos are
    // registered yet), and the result carries a structured reason plus
    // an explicit "W7 cipher pending" annotation in errors.
    const row = getRow('ECM_W7');
    const dids = vinWriteDids(row.code);
    const seedBytes = [0x00, 0x00, 0x00, 0x01];
    const script = [
      // Preflight succeeds — module is on the bus.
      { req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], '1C4HJXEN5MW000000') },
      { req: [0x10, 0x03], resp: { ok: true, d: new Uint8Array([0x50, 0x03]) } },
    ];
    // tryUnlock walks the entire 10-algo MOD_UNLOCK chain — every key is
    // rejected with NRC 0x35 (no w7 algo exists yet, so every attempt is
    // structurally wrong).
    for (let i = 0; i < 10; i++) {
      script.push({ req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seedBytes]) } });
      script.push({ resp: { ok: true, d: new Uint8Array([0x7F, 0x27, 0x35]) } });
    }
    const m = mockUds(script);
    const r = await programVin({ eng: m, row, vin: VIN });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unlock');
    expect(r.errors.some(e => /W7 cipher/i.test(e))).toBe(true);
    expect(r.errors.some(e => /pending-w7/.test(e))).toBe(true);
    // Confirms the engine actually TRIED — bus calls were made.
    expect(m.calls.length).toBeGreaterThan(0);
  });

  it('threads accessLevel and crcStrategy from the registry row through to the result', async () => {
    const row = getRow('ECM_W7'); // accessLevel 0x03, crc 'module-computed', unlockStatus 'pending-w7'
    expect(row).toBeTruthy();
    expect(row.accessLevel).toBe(0x03);
    // The engine doesn't refuse the call up front (pending-w7 is a UI bucket,
    // not an engine gate), but the result MUST surface the row metadata.
    const dids = vinWriteDids(row.code);
    const m = mockUds([
      { req: [0x22, ...encodeDid(dids[0])], resp: { ok: false, raw: 'NO DATA' } },
    ]);
    const r = await programVin({ eng: m, row, vin: VIN });
    expect(r.accessLevel).toBe(0x03);
    expect(r.crcStrategy).toBe('module-computed');
    expect(r.crcValue).toBeNull(); // module-computed → no extra CRC
  });

  it('computes ccitt-tail8 CRC and surfaces it on the result', async () => {
    // Construct a synthetic row that asks for ccitt-tail8 (the BCM/RFHUB
    // payload-CRC strategy). The engine should compute crc16ccitt over the
    // last 8 ASCII bytes of the VIN and put it on result.crcValue, even on
    // a preflight-aborted run (CRC is computed before bus traffic so the
    // log line lands either way).
    const row = { ...getRow('BCM'), crc: 'ccitt-tail8' };
    const dids = vinWriteDids('BCM');
    // Drive a full success run so crcValue is computed at step 4b.
    const seedBytes = [0x11, 0x22, 0x33, 0x44];
    const seedU32 = 0x11223344;
    const script = [
      { req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], '1C4HJXEN5MW000000') },
      { req: [0x10, 0x03], resp: { ok: true, d: new Uint8Array([0x50, 0x03]) } },
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seedBytes]) } },
      { req: [0x27, 0x02, ...keyBytesFor('cda6', seedU32)], resp: { ok: true, d: new Uint8Array([0x67, 0x02]) } },
    ];
    for (const did of dids) {
      const vb = Array.from(VIN).map(c => c.charCodeAt(0));
      script.push({ req: [0x2E, ...encodeDid(did), ...vb], resp: { ok: true, d: new Uint8Array([0x6E, ...encodeDid(did)]) } });
      script.push({ req: [0x22, ...encodeDid(did)], resp: vinReadResp(did, did === 0x6E2025 ? VIN.slice(-8) : VIN) });
    }
    script.push({ req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], VIN) });

    const m = mockUds(script);
    const r = await programVin({ eng: m, row, vin: VIN });
    expect(r.ok).toBe(true);
    expect(r.crcStrategy).toBe('ccitt-tail8');
    // Independently compute the expected CRC so the test catches drift.
    const tail = VIN.slice(-8);
    const bytes = Array.from(tail).map(c => c.charCodeAt(0));
    let crc = 0xFFFF;
    for (const b of bytes) {
      crc ^= (b << 8);
      for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    expect(r.crcValue).toBe(crc);
  });

  it('treats unknown crc strategies as no-op (defensive)', async () => {
    const row = { ...getRow('SGW') }; // SGW returns at preflight regardless
    row.crc = 'totally-made-up-strategy';
    const r = await programVin({ eng: mockUds([]), row, vin: VIN });
    expect(r.crcStrategy).toBe('totally-made-up-strategy');
    expect(r.crcValue).toBeNull();
  });

  it('honors registry row.unlockId override (preferred algo runs first)', async () => {
    const row = { ...getRow('ABS'), unlockId: 'gpec3' }; // override default cda6
    const dids = vinWriteDids('ABS');
    const seedBytes = [0x01, 0x02, 0x03, 0x04];
    const seedU32 = 0x01020304;

    const script = [
      { req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], '1C4HJXEN5MW000000') },
      { req: [0x10, 0x03], resp: { ok: true, d: new Uint8Array([0x50, 0x03]) } },
      // First attempt MUST be gpec3 (the override), not cda6.
      { req: [0x27, 0x01], resp: { ok: true, d: new Uint8Array([0x67, 0x01, ...seedBytes]) } },
      { req: [0x27, 0x02, ...keyBytesFor('gpec3', seedU32)], resp: { ok: true, d: new Uint8Array([0x67, 0x02]) } },
    ];
    for (const did of dids) {
      const vb = Array.from(VIN).map(c => c.charCodeAt(0));
      script.push({ req: [0x2E, ...encodeDid(did), ...vb], resp: { ok: true, d: new Uint8Array([0x6E, ...encodeDid(did)]) } });
      script.push({ req: [0x22, ...encodeDid(did)], resp: vinReadResp(did, VIN) });
    }
    script.push({ req: [0x22, ...encodeDid(dids[0])], resp: vinReadResp(dids[0], VIN) });

    const m = mockUds(script);
    const r = await programVin({ eng: m, row, vin: VIN });
    expect(r.ok).toBe(true);
    expect(r.unlockAlgo).toBe('gpec3');
  });
});
