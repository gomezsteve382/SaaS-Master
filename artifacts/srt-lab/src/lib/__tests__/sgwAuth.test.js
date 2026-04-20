/* sgwAuth.test — covers the gate logic that ProgramAllTab + the four
   bench tabs rely on. The hook itself is exercised indirectly: we only
   assert the synchronous gate (isSgwAuthenticated) here, which is what
   every write site actually calls. The React hook is a thin reflection
   of the same state. */

import {describe, it, expect, beforeEach} from 'vitest';
import {
  setSgwAuthenticated,
  clearSgwAuth,
  isSgwAuthenticated,
  getSgwAuthState,
  SGW_AUTH_TTL_MS,
  _resetSgwAuthForTests,
} from '../sgwAuth.js';

const SGW_VIN_2018 = '1C4HJXEN5JW123456'; // 2018 model year (J=2018)
const SGW_VIN_2019 = '1C4HJXEN5KW999111'; // 2019 model year (K=2019)
const NO_SGW_VIN   = '1C4HJWEG3FL777888'; // 2015 model year (F=2015)

describe('sgwAuth gate', () => {
  beforeEach(() => { _resetSgwAuthForTests(); });

  it('starts un-authenticated', () => {
    expect(isSgwAuthenticated()).toBe(false);
    expect(isSgwAuthenticated(SGW_VIN_2018)).toBe(false);
    expect(getSgwAuthState().vin).toBe(null);
  });

  it('marks the supplied VIN authenticated', () => {
    expect(setSgwAuthenticated(SGW_VIN_2018)).toBe(true);
    expect(isSgwAuthenticated()).toBe(true);
    expect(isSgwAuthenticated(SGW_VIN_2018)).toBe(true);
    const s = getSgwAuthState();
    expect(s.vin).toBe(SGW_VIN_2018);
    expect(s.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refuses non-17-char VINs', () => {
    expect(setSgwAuthenticated('SHORT')).toBe(false);
    expect(setSgwAuthenticated(null)).toBe(false);
    expect(setSgwAuthenticated(undefined)).toBe(false);
    expect(isSgwAuthenticated()).toBe(false);
  });

  it('rejects a different VIN once authenticated for one VIN', () => {
    setSgwAuthenticated(SGW_VIN_2018);
    // Auth is bound to the VIN it was issued for. The bench tabs pass
    // their masterVin in — the gate must NOT pretend a 2019 truck is
    // unlocked because we authenticated against a 2018 truck earlier.
    expect(isSgwAuthenticated(SGW_VIN_2019)).toBe(false);
    expect(isSgwAuthenticated(SGW_VIN_2018)).toBe(true);
  });

  it('clearSgwAuth flips the gate back to closed', () => {
    setSgwAuthenticated(SGW_VIN_2018);
    expect(isSgwAuthenticated(SGW_VIN_2018)).toBe(true);
    clearSgwAuth();
    expect(isSgwAuthenticated()).toBe(false);
    expect(isSgwAuthenticated(SGW_VIN_2018)).toBe(false);
    expect(getSgwAuthState().vin).toBe(null);
  });

  it('expires after the TTL', async () => {
    setSgwAuthenticated(SGW_VIN_2018, 5);
    expect(isSgwAuthenticated(SGW_VIN_2018)).toBe(true);
    await new Promise(r => setTimeout(r, 20));
    expect(isSgwAuthenticated(SGW_VIN_2018)).toBe(false);
  });

  it('default TTL is the documented 10 minutes', () => {
    setSgwAuthenticated(SGW_VIN_2018);
    const remaining = getSgwAuthState().expiresAt - Date.now();
    // Allow a small slack for clock jitter between set + read.
    expect(remaining).toBeGreaterThan(SGW_AUTH_TTL_MS - 1000);
    expect(remaining).toBeLessThanOrEqual(SGW_AUTH_TTL_MS);
  });

  it('non-SGW VINs are unaffected — gate only matters for SGW-required VINs', () => {
    // A 2015 VIN doesn't exercise the gate at the call site (vinHasSGW
    // returns false), but the gate API itself still answers honestly:
    // no auth has been issued, so isSgwAuthenticated is false. The four
    // bench tabs only call this AFTER vinHasSGW(masterVin), which is
    // the contract we want to preserve.
    expect(isSgwAuthenticated(NO_SGW_VIN)).toBe(false);
    setSgwAuthenticated(SGW_VIN_2018);
    expect(isSgwAuthenticated(NO_SGW_VIN)).toBe(false);
  });

  it('upper-cases the stored VIN so the gate matches case-insensitively', () => {
    setSgwAuthenticated(SGW_VIN_2018.toLowerCase());
    expect(isSgwAuthenticated(SGW_VIN_2018)).toBe(true);
    expect(isSgwAuthenticated(SGW_VIN_2018.toLowerCase())).toBe(true);
    expect(getSgwAuthState().vin).toBe(SGW_VIN_2018);
  });
});
