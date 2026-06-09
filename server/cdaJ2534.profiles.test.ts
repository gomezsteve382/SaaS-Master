/**
 * CDA J2534 — Profile DB and Module Map tests
 * Verifies profile lookup, corrected BCM TX/RX IDs, and service catalog completeness.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load the JS modules directly (they are plain ES modules with named exports)
// We use dynamic import via require workaround for .js files in vitest
let CDA_PROFILES: any[];
let getProfileByEcu: (name: string) => any;
let CDA_MODULES: any[];
let getModuleByName: (name: string) => any;

// Load profiles
try {
  const mod = require('../client/src/srtlab/lib/cdaProfiles.js');
  CDA_PROFILES = mod.CDA_PROFILES;
  getProfileByEcu = mod.getProfileByEcu;
} catch {
  CDA_PROFILES = [];
  getProfileByEcu = () => null;
}

// Load module map
try {
  const mod = require('../client/src/srtlab/lib/cdaModuleMap.js');
  CDA_MODULES = mod.CDA_MODULES;
  getModuleByName = mod.getModuleByName;
} catch {
  CDA_MODULES = [];
  getModuleByName = () => null;
}

describe('CDA J2534 — Profile DB', () => {
  it('exports CDA_PROFILES array with at least 8 entries', () => {
    expect(Array.isArray(CDA_PROFILES)).toBe(true);
    expect(CDA_PROFILES.length).toBeGreaterThanOrEqual(8);
  });

  it('BCM profile has corrected TX/RX IDs (0x750/0x758)', () => {
    const bcm = getProfileByEcu('BCM');
    expect(bcm).not.toBeNull();
    expect(bcm.connection.tx_id).toBe('0x750');
    expect(bcm.connection.rx_id).toBe('0x758');
  });

  it('BCM profile has VIN read and write services', () => {
    const bcm = getProfileByEcu('BCM');
    const services = bcm?.services || [];
    const vinRead = services.find((s: any) => s.did === 'F1B0' || s.did === 'F190');
    const vinWrite = services.find((s: any) => s.type === 'write_did');
    expect(vinRead).toBeDefined();
    expect(vinWrite).toBeDefined();
  });

  it('BCM profile has DTC read and clear services', () => {
    const bcm = getProfileByEcu('BCM');
    const services = bcm?.services || [];
    const dtcRead = services.find((s: any) => s.request?.startsWith('19'));
    const dtcClear = services.find((s: any) => s.request?.startsWith('14'));
    expect(dtcRead).toBeDefined();
    expect(dtcClear).toBeDefined();
  });

  it('ECM profile has correct TX/RX IDs (0x7E0/0x7E8)', () => {
    const ecm = getProfileByEcu('ECM');
    expect(ecm).not.toBeNull();
    expect(ecm.connection.tx_id).toBe('0x7E0');
    expect(ecm.connection.rx_id).toBe('0x7E8');
  });

  it('RFHUB profile exists with correct TX/RX IDs', () => {
    const rfhub = getProfileByEcu('RFHUB');
    expect(rfhub).not.toBeNull();
    expect(rfhub.connection.tx_id).toBe('0x75F');
    expect(rfhub.connection.rx_id).toBe('0x767');
  });

  it('all profiles have required fields', () => {
    for (const p of CDA_PROFILES) {
      expect(p.profile_name).toBeTruthy();
      expect(p.ecu_name).toBeTruthy();
      expect(p.connection).toBeDefined();
      expect(p.connection.tx_id).toBeTruthy();
      expect(p.connection.rx_id).toBeTruthy();
      expect(Array.isArray(p.services)).toBe(true);
    }
  });

  it('all profiles have at least one service', () => {
    for (const p of CDA_PROFILES) {
      expect(p.services.length).toBeGreaterThan(0);
    }
  });

  it('getProfileByEcu returns null for unknown ECU', () => {
    const result = getProfileByEcu('UNKNOWN_ECU_XYZ');
    expect(result).toBeNull();
  });
});

describe('CDA J2534 — Module Map', () => {
  it('exports CDA_MODULES array with at least 20 entries', () => {
    expect(Array.isArray(CDA_MODULES)).toBe(true);
    expect(CDA_MODULES.length).toBeGreaterThanOrEqual(20);
  });

  it('BCM has corrected TX/RX IDs (0x750/0x758)', () => {
    const bcm = getModuleByName('BCM');
    expect(bcm).not.toBeNull();
    expect(bcm.tx).toBe(0x750);
    expect(bcm.rx).toBe(0x758);
  });

  it('IPC has corrected TX/RX IDs (0x746/0x766)', () => {
    const ipc = getModuleByName('IPC');
    expect(ipc).not.toBeNull();
    expect(ipc.tx).toBe(0x746);
    expect(ipc.rx).toBe(0x766);
  });

  it('ECM has correct TX/RX IDs (0x7E0/0x7E8)', () => {
    const ecm = getModuleByName('ECM');
    expect(ecm).not.toBeNull();
    expect(ecm.tx).toBe(0x7E0);
    expect(ecm.rx).toBe(0x7E8);
  });

  it('all modules have required fields', () => {
    for (const m of CDA_MODULES) {
      expect(m.name).toBeTruthy();
      expect(m.display).toBeTruthy();
      expect(typeof m.tx).toBe('number');
      expect(typeof m.rx).toBe('number');
      expect(m.baud).toBe(500000);
      expect(m.algo).toBeTruthy();
    }
  });

  it('no two modules share the same TX ID', () => {
    const txIds = CDA_MODULES.map((m: any) => m.tx);
    const unique = new Set(txIds);
    expect(unique.size).toBe(txIds.length);
  });

  it('getModuleByName returns null for unknown module', () => {
    const result = getModuleByName('UNKNOWN_MODULE_XYZ');
    expect(result).toBeNull();
  });
});
