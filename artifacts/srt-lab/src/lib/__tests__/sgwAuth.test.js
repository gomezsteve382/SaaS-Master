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
import {partitionForVin} from '../moduleRegistry.js';

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

/* These tests exercise the EXACT predicate ProgramAllTab evaluates when it
   decides whether to dispatch a batch and the predicate every bench tab
   evaluates inside executeWriteVin. Replicating the full React component
   here would require pulling in jsdom + react-testing-library, which the
   project doesn't use. Instead we compose the same building blocks the
   tab composes — partitionForVin to discover SGW-required rows and
   isSgwAuthenticated to honor the gate — and assert the same behavior
   the task plan calls out: 2018+ VIN blocked until the writer is called,
   2015 VIN unaffected. */
describe('SGW gate composition (mirrors ProgramAllTab.runBatch + bench tabs)', () => {
  beforeEach(() => { _resetSgwAuthForTests(); });

  // The same expression both ProgramAllTab.runBatch and the four bench
  // tabs use: needs SGW => must be authenticated for THIS VIN.
  function gateAllowsWrite(vin){
    const partition = partitionForVin(vin);
    const needsSgw = partition.blockedBySgw.length > 0
      || partition.writable.some(r => r.sgwRequired);
    if (!needsSgw) return true; // Non-SGW VINs are unaffected.
    return isSgwAuthenticated(vin);
  }

  it('2018+ VIN: gate is CLOSED until setSgwAuthenticated is called', () => {
    expect(gateAllowsWrite(SGW_VIN_2018)).toBe(false);
    setSgwAuthenticated(SGW_VIN_2018);
    expect(gateAllowsWrite(SGW_VIN_2018)).toBe(true);
    clearSgwAuth();
    expect(gateAllowsWrite(SGW_VIN_2018)).toBe(false);
  });

  it('2015 VIN: gate is OPEN regardless of auth state', () => {
    expect(gateAllowsWrite(NO_SGW_VIN)).toBe(true);
    setSgwAuthenticated(SGW_VIN_2018);
    expect(gateAllowsWrite(NO_SGW_VIN)).toBe(true); // unrelated auth doesn't matter
    clearSgwAuth();
    expect(gateAllowsWrite(NO_SGW_VIN)).toBe(true);
  });

  it('VIN-bound: authenticating one 2018+ VIN does NOT open the gate for a different 2018+ VIN', () => {
    setSgwAuthenticated(SGW_VIN_2018);
    expect(gateAllowsWrite(SGW_VIN_2018)).toBe(true);
    expect(gateAllowsWrite(SGW_VIN_2019)).toBe(false);
  });

  it('partitionForVin actually surfaces SGW-blocked rows for a 2018+ VIN', () => {
    const sgw = partitionForVin(SGW_VIN_2018);
    const noSgw = partitionForVin(NO_SGW_VIN);
    // Sanity: a 2018+ VIN must produce at least one SGW-required row,
    // otherwise the gate composition tests above would be vacuous.
    const sgwRows = sgw.blockedBySgw.length
      + sgw.writable.filter(r => r.sgwRequired).length;
    expect(sgwRows).toBeGreaterThan(0);
    expect(noSgw.blockedBySgw.length).toBe(0);
    expect(noSgw.writable.every(r => !r.sgwRequired)).toBe(true);
  });
});
