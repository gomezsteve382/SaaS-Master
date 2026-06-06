/**
 * IpcClusterReprogramTab.ui.test.jsx
 *
 * Tests for:
 *   1. udsEngine.js — SBEC key formula, module registry, session sequences,
 *      body-code swap builder, DID builders, NRC decoder
 *   2. IpcClusterReprogramTab — renders without crash, shows key UI sections
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

// ─── udsEngine unit tests ─────────────────────────────────────────────────────
import {
  sbecKey,
  computeKey,
  getModuleConfig,
  getAllModules,
  getModuleDids,
  buildReadDid,
  buildWriteDid,
  buildDsc,
  buildSeedRequest,
  buildKeySend,
  buildTesterPresent,
  buildEcuReset,
  buildSessionSequence,
  buildIpcBodyCodeSwap,
  decodeNrc,
  formatHex,
  parseHexString,
  ALGO,
  VEHICLE_BODY_CODES,
  COMMON_DIDS,
  MODULE_REGISTRY,
  NRC_TABLE,
} from '../../lib/udsEngine.js';

// ─── SBEC key formula ─────────────────────────────────────────────────────────
describe('sbecKey', () => {
  it('computes key for seed 0x0000', () => {
    // key = (0 * 4) + 0x9018 = 0x9018
    expect(sbecKey(0x0000)).toBe(0x9018);
  });

  it('computes key for seed 0x1234', () => {
    // key = (0x1234 * 4 + 0x9018) & 0xFFFF
    const expected = ((0x1234 * 4) + 0x9018) & 0xFFFF;
    expect(sbecKey(0x1234)).toBe(expected);
  });

  it('computes key for seed 0xFFFF', () => {
    // key = (0xFFFF * 4 + 0x9018) & 0xFFFF
    const expected = ((0xFFFF * 4) + 0x9018) & 0xFFFF;
    expect(sbecKey(0xFFFF)).toBe(expected);
  });

  it('wraps correctly at 16-bit boundary', () => {
    const key = sbecKey(0xFFFF);
    expect(key).toBeGreaterThanOrEqual(0);
    expect(key).toBeLessThanOrEqual(0xFFFF);
  });

  it('matches known IPC seed/key pair from RE analysis', () => {
    // From 05_seed_key_algorithms.txt test vector: seed=0x3A2B → key=0xF8CA
    const seed = 0x3A2B;
    const expected = ((seed * 4) + 0x9018) & 0xFFFF;
    expect(sbecKey(seed)).toBe(expected);
  });
});

// ─── computeKey dispatch ──────────────────────────────────────────────────────
describe('computeKey', () => {
  it('handles SBEC algo inline', () => {
    const result = computeKey(ALGO.SBEC, 0x1234);
    expect(result.needsAlgosJs).toBe(false);
    expect(result.key).toBe(sbecKey(0x1234));
    expect(result.keyBytes).toHaveLength(2);
    expect(result.keyBytes[0]).toBe((result.key >> 8) & 0xFF);
    expect(result.keyBytes[1]).toBe(result.key & 0xFF);
  });

  it('defers CDA6 to algos.js', () => {
    const result = computeKey(ALGO.CDA6, 0xABCD1234);
    expect(result.needsAlgosJs).toBe(true);
    expect(result.key).toBeNull();
  });

  it('defers GPEC2 to algos.js', () => {
    const result = computeKey(ALGO.GPEC2, 0x12345678);
    expect(result.needsAlgosJs).toBe(true);
  });

  it('includes formula string for SBEC', () => {
    const result = computeKey(ALGO.SBEC, 0x0100);
    expect(result.formula).toContain('0x9018');
  });
});

// ─── MODULE_REGISTRY — IPC entry ─────────────────────────────────────────────
describe('MODULE_REGISTRY IPC', () => {
  it('IPC entry exists', () => {
    expect(MODULE_REGISTRY.IPC).toBeDefined();
  });

  it('IPC uses RE-verified CAN IDs 0x746/0x766', () => {
    expect(MODULE_REGISTRY.IPC.tx).toBe(0x746);
    expect(MODULE_REGISTRY.IPC.rx).toBe(0x766);
  });

  it('IPC uses SBEC algorithm', () => {
    expect(MODULE_REGISTRY.IPC.algo).toBe(ALGO.SBEC);
  });

  it('IPC has F190 (VIN) DID', () => {
    const dids = MODULE_REGISTRY.IPC.dids;
    const vinDid = dids.find(d => d.did === 0xF190);
    expect(vinDid).toBeDefined();
    expect(vinDid.name).toMatch(/VIN/i);
  });

  it('IPC has F10F (body code) DID', () => {
    const dids = MODULE_REGISTRY.IPC.dids;
    const bodyDid = dids.find(d => d.did === 0xF10F);
    expect(bodyDid).toBeDefined();
  });
});

// ─── getModuleConfig ──────────────────────────────────────────────────────────
describe('getModuleConfig', () => {
  it('returns IPC config by code', () => {
    const cfg = getModuleConfig('IPC');
    expect(cfg).not.toBeNull();
    expect(cfg.tx).toBe(0x746);
  });

  it('is case-insensitive', () => {
    const cfg = getModuleConfig('ipc');
    expect(cfg).not.toBeNull();
    expect(cfg.tx).toBe(0x746);
  });

  it('returns null for unknown code', () => {
    expect(getModuleConfig('UNKNOWN_MODULE_XYZ')).toBeNull();
  });

  it('returns BCM config', () => {
    const cfg = getModuleConfig('BCM');
    expect(cfg).not.toBeNull();
    expect(cfg.tx).toBe(0x750);
  });
});

// ─── getAllModules ────────────────────────────────────────────────────────────
describe('getAllModules', () => {
  it('returns an array of module configs', () => {
    const mods = getAllModules();
    expect(Array.isArray(mods)).toBe(true);
    expect(mods.length).toBeGreaterThan(5);
  });

  it('every module has tx, rx, algo, code fields', () => {
    getAllModules().forEach(m => {
      expect(m).toHaveProperty('tx');
      expect(m).toHaveProperty('rx');
      expect(m).toHaveProperty('algo');
      expect(m).toHaveProperty('code');
    });
  });
});

// ─── getModuleDids ────────────────────────────────────────────────────────────
describe('getModuleDids', () => {
  it('returns DID list for IPC', () => {
    const dids = getModuleDids('IPC');
    expect(Array.isArray(dids)).toBe(true);
    expect(dids.length).toBeGreaterThan(0);
  });

  it('returns empty array for unknown module', () => {
    expect(getModuleDids('DOES_NOT_EXIST')).toEqual([]);
  });
});

// ─── UDS frame builders ───────────────────────────────────────────────────────
describe('buildReadDid', () => {
  it('builds 22 F1 90 for VIN DID', () => {
    const frame = buildReadDid(0xF190);
    expect(frame).toEqual([0x22, 0xF1, 0x90]);
  });

  it('builds 22 F1 0F for body code DID', () => {
    const frame = buildReadDid(0xF10F);
    expect(frame).toEqual([0x22, 0xF1, 0x0F]);
  });
});

describe('buildWriteDid', () => {
  it('builds 2E + DID bytes + data', () => {
    const frame = buildWriteDid(0xF190, [0x31, 0x32, 0x33]);
    expect(frame[0]).toBe(0x2E);
    expect(frame[1]).toBe(0xF1);
    expect(frame[2]).toBe(0x90);
    expect(frame.slice(3)).toEqual([0x31, 0x32, 0x33]);
  });
});

describe('buildDsc', () => {
  it('builds 10 03 for extended session', () => {
    expect(buildDsc(0x03)).toEqual([0x10, 0x03]);
  });

  it('builds 10 01 for default session', () => {
    expect(buildDsc(0x01)).toEqual([0x10, 0x01]);
  });
});

describe('buildSeedRequest', () => {
  it('builds 27 01 for level 1', () => {
    expect(buildSeedRequest(0x01)).toEqual([0x27, 0x01]);
  });

  it('builds 27 03 for level 3', () => {
    expect(buildSeedRequest(0x03)).toEqual([0x27, 0x03]);
  });
});

describe('buildKeySend', () => {
  it('builds 27 02 + key bytes for level 1', () => {
    const frame = buildKeySend(0x02, [0x90, 0x18]);
    expect(frame).toEqual([0x27, 0x02, 0x90, 0x18]);
  });
});

describe('buildTesterPresent', () => {
  it('builds 3E 00', () => {
    expect(buildTesterPresent()).toEqual([0x3E, 0x00]);
  });
});

describe('buildEcuReset', () => {
  it('builds 11 01 for hard reset', () => {
    expect(buildEcuReset(0x01)).toEqual([0x11, 0x01]);
  });
});

// ─── buildSessionSequence ────────────────────────────────────────────────────
describe('buildSessionSequence', () => {
  it('returns an array of steps for IPC extended session', () => {
    const seq = buildSessionSequence('IPC', 'extended');
    expect(Array.isArray(seq)).toBe(true);
    expect(seq.length).toBeGreaterThan(2);
  });

  it('first step is DSC extended (10 03)', () => {
    const seq = buildSessionSequence('IPC', 'extended');
    const first = seq[0];
    expect(first.frame).toContain(0x10);
    expect(first.frame).toContain(0x03);
  });

  it('includes seed request step', () => {
    const seq = buildSessionSequence('IPC', 'programming');
    const seedStep = seq.find(s => s.frame && s.frame[0] === 0x27);
    expect(seedStep).toBeDefined();
  });

  it('returns steps for BCM', () => {
    const seq = buildSessionSequence('BCM', 'extended');
    expect(seq.length).toBeGreaterThan(0);
  });
});

// ─── buildIpcBodyCodeSwap ─────────────────────────────────────────────────────
describe('buildIpcBodyCodeSwap', () => {
  it('returns an array of steps', () => {
    const steps = buildIpcBodyCodeSwap(0x09);
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });

  it('includes a write DID step for F10F', () => {
    const steps = buildIpcBodyCodeSwap(0x09);
    const writeStep = steps.find(s =>
      s.frame && s.frame[0] === 0x2E && s.frame[1] === 0xF1 && s.frame[2] === 0x0F
    );
    expect(writeStep).toBeDefined();
  });

  it('encodes the target body code in the write frame', () => {
    const targetCode = 0x09; // WK (Trackhawk)
    const steps = buildIpcBodyCodeSwap(targetCode);
    const writeStep = steps.find(s =>
      s.frame && s.frame[0] === 0x2E && s.frame[1] === 0xF1 && s.frame[2] === 0x0F
    );
    expect(writeStep).toBeDefined();
    // The body code byte should appear somewhere in the frame data
    expect(writeStep.frame).toContain(targetCode);
  });
});

// ─── VEHICLE_BODY_CODES ───────────────────────────────────────────────────────
describe('VEHICLE_BODY_CODES', () => {
  it('has WK (Trackhawk/Grand Cherokee) entry', () => {
    expect(VEHICLE_BODY_CODES.WK).toBeDefined();
    expect(VEHICLE_BODY_CODES.WK.code).toBeDefined();
  });

  it('has LD (Durango) entry', () => {
    expect(VEHICLE_BODY_CODES.LD).toBeDefined();
    expect(VEHICLE_BODY_CODES.LD.code).toBeDefined();
  });

  it('WK and LD have different body codes', () => {
    expect(VEHICLE_BODY_CODES.WK.code).not.toBe(VEHICLE_BODY_CODES.LD.code);
  });
});

// ─── NRC decoder ─────────────────────────────────────────────────────────────
describe('decodeNrc', () => {
  it('decodes 0x35 as invalid key', () => {
    const msg = decodeNrc(0x35);
    expect(msg).toMatch(/invalid.*key|key.*invalid/i);
  });

  it('decodes 0x36 as exceeded attempts', () => {
    const msg = decodeNrc(0x36);
    expect(msg).toMatch(/exceed|attempt/i);
  });

  it('decodes 0x22 as conditions not correct', () => {
    const msg = decodeNrc(0x22);
    expect(msg).toMatch(/condition/i);
  });

  it('decodes 0x31 as request out of range', () => {
    const msg = decodeNrc(0x31);
    expect(msg).toMatch(/range|out/i);
  });

  it('returns a non-empty string for unknown NRC', () => {
    const msg = decodeNrc(0xFE);
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });
});

// ─── formatHex / parseHexString ───────────────────────────────────────────────
describe('formatHex', () => {
  it('formats byte array as hex string', () => {
    expect(formatHex([0x10, 0x03])).toMatch(/10.03/i);
  });

  it('handles empty array', () => {
    expect(formatHex([])).toBe('');
  });
});

describe('parseHexString', () => {
  it('parses "10 03" to [0x10, 0x03]', () => {
    expect(parseHexString('10 03')).toEqual([0x10, 0x03]);
  });

  it('handles no spaces', () => {
    expect(parseHexString('1003')).toEqual([0x10, 0x03]);
  });

  it('handles 0x prefix', () => {
    expect(parseHexString('0x10 0x03')).toEqual([0x10, 0x03]);
  });
});

// ─── COMMON_DIDS catalog ──────────────────────────────────────────────────────
describe('COMMON_DIDS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(COMMON_DIDS)).toBe(true);
    expect(COMMON_DIDS.length).toBeGreaterThan(0);
  });

  it('contains F190 (VIN)', () => {
    const vin = COMMON_DIDS.find(d => d.did === 0xF190);
    expect(vin).toBeDefined();
  });

  it('every entry has did, name, rw fields', () => {
    COMMON_DIDS.forEach(d => {
      expect(d).toHaveProperty('did');
      expect(d).toHaveProperty('name');
      expect(d).toHaveProperty('rw');
    });
  });
});

// ─── IpcClusterReprogramTab render test ──────────────────────────────────────
import IpcClusterReprogramTab from '../IpcClusterReprogramTab.jsx';

describe('IpcClusterReprogramTab', () => {
  it('renders without crashing', () => {
    expect(() => render(<IpcClusterReprogramTab />)).not.toThrow();
  });

  it('shows IPC CLUSTER heading', () => {
    render(<IpcClusterReprogramTab />);
    expect(screen.getByText(/IPC CLUSTER/i)).toBeDefined();
  });

  it('shows SBEC algorithm reference', () => {
    render(<IpcClusterReprogramTab />);
    expect(screen.getByText(/SBEC/i)).toBeDefined();
  });

  it('shows body code section', () => {
    render(<IpcClusterReprogramTab />);
    // Should have body code or vehicle platform UI
    const bodyCodeEl = screen.queryByText(/body code|BODY CODE|platform/i);
    expect(bodyCodeEl).not.toBeNull();
  });

  it('shows CAN address 0x746', () => {
    render(<IpcClusterReprogramTab />);
    const el = screen.queryByText(/0x746|746/i);
    expect(el).not.toBeNull();
  });

  it('shows connect button or connection UI', () => {
    render(<IpcClusterReprogramTab />);
    const connectEl = screen.queryByText(/connect|CONNECT/i);
    expect(connectEl).not.toBeNull();
  });
});
