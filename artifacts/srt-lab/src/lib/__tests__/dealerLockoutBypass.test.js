import { describe, it, expect } from 'vitest';
import {
  runDealerLockoutBypass,
  dealerLockoutBypassSteps,
  BYPASS_LEVEL,
} from '../dealerLockoutBypass.js';
import { FakeSecurityAccessSource, NRC } from '../securityAccessSource.js';

function makeStubUds(scriptByStep) {
  // scriptByStep keyed by leading service byte → response producer
  const calls = [];
  const uds = async (tx, rx, bytes) => {
    calls.push({ tx, rx, bytes: Array.from(bytes) });
    const svc = bytes[0];
    const handler = scriptByStep[svc];
    if (typeof handler === 'function') return handler(bytes);
    if (handler) return handler;
    return { ok: false, d: new Uint8Array() };
  };
  uds.calls = calls;
  return uds;
}

function posResp(svc, ...rest) {
  return { ok: true, d: new Uint8Array([(svc + 0x40) & 0xFF, ...rest]) };
}
function nrcResp(svc, nrc) {
  return { ok: true, d: new Uint8Array([0x7F, svc, nrc]) };
}

describe('dealerLockoutBypass — step list', () => {
  it('lists 5 ordered steps', () => {
    const steps = dealerLockoutBypassSteps();
    expect(steps.map((s) => s.id)).toEqual(['ext-session', 'alt-sa', 'clear', 'reset', 're-probe']);
  });
});

describe('dealerLockoutBypass — happy path', () => {
  it('walks the full sequence and reports cleared:true', async () => {
    const uds = makeStubUds({
      0x10: posResp(0x10, 0x03, 0x00, 0x32, 0x01, 0xF4),
      0x31: posResp(0x31, 0x01, 0xFF, 0x00, 0x00),
      0x11: posResp(0x11, 0x01),
      0x27: posResp(0x27, 0x01, 0x11, 0x22, 0x33, 0x44),
    });
    const sa = FakeSecurityAccessSource({
      [`1791:${BYPASS_LEVEL}`]: { ok: true, algo: 'rfhub-alt' },
    });
    const r = await runDealerLockoutBypass({
      tx: 0x6FF, rx: 0x707, uds, securityAccess: sa, delay: async () => {},
      acknowledgeEraseRisk: true,
    });
    expect(r.ok).toBe(true);
    expect(r.cleared).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual(['ext-session', 'alt-sa', 'clear', 'reset', 're-probe']);
    expect(r.steps.every((s) => s.ok)).toBe(true);
    expect(r.steps.find((s) => s.id === 'alt-sa').note).toContain('rfhub-alt');
  });

  it('builds correct UDS request bytes for each driven step', async () => {
    const uds = makeStubUds({
      0x10: posResp(0x10, 0x03),
      0x31: posResp(0x31, 0x01, 0xFF, 0x00, 0x00),
      0x11: posResp(0x11, 0x01),
      0x27: posResp(0x27, 0x01, 0xAA, 0xBB, 0xCC, 0xDD),
    });
    const sa = FakeSecurityAccessSource({ default: { ok: true } });
    await runDealerLockoutBypass({
      tx: 0x6FF, rx: 0x707, uds, securityAccess: sa, delay: async () => {},
      acknowledgeEraseRisk: true,
    });
    // 0x10 0x03 — extended session
    expect(uds.calls[0].bytes).toEqual([0x10, 0x03]);
    // 0x31 0x01 0xFF 0x00 + 4-byte payload — start routine to clear lockout
    expect(uds.calls[1].bytes).toEqual([0x31, 0x01, 0xFF, 0x00, 0xA5, 0x5A, 0xC3, 0x3C]);
    // 0x11 0x01 — hard reset
    expect(uds.calls[2].bytes).toEqual([0x11, 0x01]);
    // 0x27 0x01 — re-probe standard SA
    expect(uds.calls[3].bytes).toEqual([0x27, 0x01]);
  });
});

describe('dealerLockoutBypass — failure paths', () => {
  it('stops on extended session NRC and returns cleared:false', async () => {
    const uds = makeStubUds({ 0x10: nrcResp(0x10, 0x22) });
    const sa = FakeSecurityAccessSource({});
    const r = await runDealerLockoutBypass({ tx: 0x6FF, rx: 0x707, uds, securityAccess: sa });
    expect(r.ok).toBe(false);
    expect(r.cleared).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].nrc).toBe(0x22);
  });

  it('stops when alt-level SA refuses with NRC 0x12 (legacy RFHUB)', async () => {
    const uds = makeStubUds({ 0x10: posResp(0x10, 0x03) });
    const sa = FakeSecurityAccessSource({
      default: { ok: false, nrc: 0x12, reason: 'subFunctionNotSupported' },
    });
    const r = await runDealerLockoutBypass({ tx: 0x6FF, rx: 0x707, uds, securityAccess: sa });
    expect(r.ok).toBe(false);
    expect(r.cleared).toBe(false);
    expect(r.steps.find((s) => s.id === 'alt-sa').nrc).toBe(0x12);
  });

  it('reports cleared:false if re-probe still returns NRC 0x36', async () => {
    const uds = makeStubUds({
      0x10: posResp(0x10, 0x03),
      0x31: posResp(0x31, 0x01, 0xFF, 0x00, 0x00),
      0x11: posResp(0x11, 0x01),
      0x27: nrcResp(0x27, NRC.EXCEEDED_NUMBER_OF_ATTEMPTS),
    });
    const sa = FakeSecurityAccessSource({ default: { ok: true } });
    const r = await runDealerLockoutBypass({
      tx: 0x6FF, rx: 0x707, uds, securityAccess: sa, delay: async () => {},
      acknowledgeEraseRisk: true,
    });
    expect(r.cleared).toBe(false);
    const reprobe = r.steps.find((s) => s.id === 're-probe');
    expect(reprobe.ok).toBe(false);
    expect(reprobe.reason).toMatch(/Still locked/i);
  });

  it('REFUSES the destructive 0xFF00 step unless acknowledgeEraseRisk is set', async () => {
    const uds = makeStubUds({
      0x10: posResp(0x10, 0x03),
      0x31: posResp(0x31, 0x01, 0xFF, 0x00, 0x00), // would succeed IF it were sent
      0x11: posResp(0x11, 0x01),
      0x27: posResp(0x27, 0x01, 0x11, 0x22, 0x33, 0x44),
    });
    const sa = FakeSecurityAccessSource({ default: { ok: true } });
    const r = await runDealerLockoutBypass({ tx: 0x6FF, rx: 0x707, uds, securityAccess: sa });
    expect(r.refused).toBe(true);
    expect(r.cleared).toBe(false);
    const clear = r.steps.find((s) => s.id === 'clear');
    expect(clear.refused).toBe(true);
    expect(clear.reason).toMatch(/erase|UNVERIFIED/i);
    // the destructive 0x31 0xFF00 routine must NOT have been transmitted
    expect(uds.calls.some((c) => c.bytes[0] === 0x31)).toBe(false);
  });

  it('rejects missing callbacks / ids', async () => {
    expect((await runDealerLockoutBypass({})).reason).toMatch(/uds/);
    expect((await runDealerLockoutBypass({ uds: () => {} })).reason).toMatch(/securityAccess/);
    expect((await runDealerLockoutBypass({
      uds: () => {}, securityAccess: { unlock: () => {} },
    })).reason).toMatch(/tx\/rx/);
  });
});
