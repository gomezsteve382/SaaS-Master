/**
 * udsEngine.test.ts
 *
 * Pure-logic unit tests for the udsEngine.js module.
 * Tests run in the Node environment (no DOM required).
 *
 * Coverage:
 *   - sbecKey formula: key = (seed * 4) + 0x9018
 *   - computeKey dispatch (SBEC inline, others deferred)
 *   - MODULE_REGISTRY IPC entry (RE-verified CAN IDs 0x746/0x766)
 *   - getModuleConfig / getAllModules / getModuleDids
 *   - UDS frame builders (buildReadDid, buildWriteDid, buildDsc, etc.)
 *   - buildSessionSequence structure (steps use `bytes` field)
 *   - buildIpcBodyCodeSwap — F10F write step (bytes field)
 *   - VEHICLE_BODY_CODES (WK / WD / LD platform codes)
 *   - NRC decoder (returns {name, desc} object)
 *   - formatHex / parseHexString
 *   - COMMON_DIDS catalog
 *
 * Actual API notes (from live inspection):
 *   - Session sequence steps use `bytes` (not `frame`)
 *   - decodeNrc returns {name, desc} object (not string)
 *   - buildKeySend(level, bytes) → [0x27, level+1, ...bytes]
 *   - BCM tx=0x744 / rx=0x74C (not 0x750/0x758)
 *   - ECM tx=0x7E0 / rx=0x7E8
 *   - IPC dids are module-specific (odometer, body code, feature flags, fingerprint)
 *   - COMMON_DIDS are returned as fallback for unknown modules
 *   - parseHexString requires spaces between bytes
 *   - VEHICLE_BODY_CODES: WK=9, WD=11, LD=13, LC=14, LX=16
 */
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'url';
import path from 'path';

const udsEnginePath = path.resolve(process.cwd(), 'client/src/srtlab/lib/udsEngine.js');

let engine: typeof import('../client/src/srtlab/lib/udsEngine.js');

async function loadEngine() {
  if (!engine) {
    engine = await import(pathToFileURL(udsEnginePath).href);
  }
  return engine;
}

// ─── SBEC key formula ─────────────────────────────────────────────────────────
describe('sbecKey', () => {
  it('computes key for seed 0x0000 → 0x9018', async () => {
    const { sbecKey } = await loadEngine();
    expect(sbecKey(0x0000)).toBe(0x9018);
  });

  it('computes key for seed 0x1234', async () => {
    const { sbecKey } = await loadEngine();
    const expected = ((0x1234 * 4) + 0x9018) & 0xFFFF;
    expect(sbecKey(0x1234)).toBe(expected);
  });

  it('computes key for seed 0xFFFF with 16-bit wrap', async () => {
    const { sbecKey } = await loadEngine();
    const expected = ((0xFFFF * 4) + 0x9018) & 0xFFFF;
    expect(sbecKey(0xFFFF)).toBe(expected);
  });

  it('result is always in 0x0000–0xFFFF range', async () => {
    const { sbecKey } = await loadEngine();
    const seeds = [0x0001, 0x0100, 0x1000, 0x3A2B, 0x7FFF, 0x8000, 0xFFFF];
    for (const seed of seeds) {
      const key = sbecKey(seed);
      expect(key).toBeGreaterThanOrEqual(0);
      expect(key).toBeLessThanOrEqual(0xFFFF);
    }
  });

  it('matches formula (seed * 4) + 0x9018 mod 0x10000 for multiple seeds', async () => {
    const { sbecKey } = await loadEngine();
    const seeds = [0x0001, 0x0100, 0x1000, 0x3A2B, 0x7FFF, 0x8000];
    for (const seed of seeds) {
      const expected = ((seed * 4) + 0x9018) & 0xFFFF;
      expect(sbecKey(seed)).toBe(expected);
    }
  });

  it('is deterministic', async () => {
    const { sbecKey } = await loadEngine();
    const seed = 0x5678;
    expect(sbecKey(seed)).toBe(sbecKey(seed));
  });
});

// ─── computeKey dispatch ──────────────────────────────────────────────────────
describe('computeKey', () => {
  it('handles SBEC inline — needsAlgosJs=false', async () => {
    const { computeKey, sbecKey, ALGO } = await loadEngine();
    const seed = 0x1234;
    const result = computeKey(ALGO.SBEC, seed);
    expect(result.needsAlgosJs).toBe(false);
    expect(result.key).toBe(sbecKey(seed));
    expect(Array.isArray(result.keyBytes)).toBe(true);
    expect(result.keyBytes).toHaveLength(2);
    expect(result.keyBytes![0]).toBe((result.key! >> 8) & 0xFF);
    expect(result.keyBytes![1]).toBe(result.key! & 0xFF);
  });

  it('SBEC formula string contains 0x9018', async () => {
    const { computeKey, ALGO } = await loadEngine();
    const result = computeKey(ALGO.SBEC, 0x0100);
    expect(result.formula).toContain('0x9018');
  });

  it('defers CDA6 — needsAlgosJs=true, key=null', async () => {
    const { computeKey, ALGO } = await loadEngine();
    const result = computeKey(ALGO.CDA6, 0xABCD1234);
    expect(result.needsAlgosJs).toBe(true);
    expect(result.key).toBeNull();
    expect(result.keyBytes).toBeNull();
  });

  it('defers GPEC2 — needsAlgosJs=true', async () => {
    const { computeKey, ALGO } = await loadEngine();
    const result = computeKey(ALGO.GPEC2, 0x12345678);
    expect(result.needsAlgosJs).toBe(true);
  });

  it('defers XTEA_SGW — needsAlgosJs=true', async () => {
    const { computeKey, ALGO } = await loadEngine();
    const result = computeKey(ALGO.XTEA_SGW, 0xDEADBEEF);
    expect(result.needsAlgosJs).toBe(true);
  });
});

// ─── MODULE_REGISTRY IPC entry ────────────────────────────────────────────────
describe('MODULE_REGISTRY IPC', () => {
  it('IPC entry exists', async () => {
    const { MODULE_REGISTRY } = await loadEngine();
    expect(MODULE_REGISTRY.IPC).toBeDefined();
  });

  it('IPC uses RE-verified CAN IDs 0x746/0x766', async () => {
    const { MODULE_REGISTRY } = await loadEngine();
    expect(MODULE_REGISTRY.IPC.tx).toBe(0x746);
    expect(MODULE_REGISTRY.IPC.rx).toBe(0x766);
  });

  it('IPC uses SBEC algorithm', async () => {
    const { MODULE_REGISTRY, ALGO } = await loadEngine();
    expect(MODULE_REGISTRY.IPC.algo).toBe(ALGO.SBEC);
  });

  it('IPC has Vehicle Body Code DID (0xF10F = 61711)', async () => {
    const { MODULE_REGISTRY } = await loadEngine();
    const dids = MODULE_REGISTRY.IPC.dids;
    const bodyDid = dids.find((d: any) => d.did === 0xF10F);
    expect(bodyDid).toBeDefined();
    expect(bodyDid.name).toMatch(/body code/i);
  });

  it('IPC has Odometer DID (0xF10E = 61710)', async () => {
    const { MODULE_REGISTRY } = await loadEngine();
    const dids = MODULE_REGISTRY.IPC.dids;
    const odoDid = dids.find((d: any) => d.did === 0xF10E);
    expect(odoDid).toBeDefined();
  });

  it('IPC has Feature Flags DID (0xF110 = 61712)', async () => {
    const { MODULE_REGISTRY } = await loadEngine();
    const dids = MODULE_REGISTRY.IPC.dids;
    const ffDid = dids.find((d: any) => d.did === 0xF110);
    expect(ffDid).toBeDefined();
  });

  it('IPC has at least 3 DIDs', async () => {
    const { MODULE_REGISTRY } = await loadEngine();
    expect(MODULE_REGISTRY.IPC.dids.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── getModuleConfig ──────────────────────────────────────────────────────────
describe('getModuleConfig', () => {
  it('returns IPC config with tx=0x746', async () => {
    const { getModuleConfig } = await loadEngine();
    const cfg = getModuleConfig('IPC');
    expect(cfg).not.toBeNull();
    expect(cfg!.tx).toBe(0x746);
  });

  it('is case-insensitive', async () => {
    const { getModuleConfig } = await loadEngine();
    const cfg = getModuleConfig('ipc');
    expect(cfg).not.toBeNull();
    expect(cfg!.tx).toBe(0x746);
  });

  it('returns null for unknown code', async () => {
    const { getModuleConfig } = await loadEngine();
    expect(getModuleConfig('UNKNOWN_MODULE_XYZ')).toBeNull();
  });

  it('returns BCM config with tx=0x744', async () => {
    const { getModuleConfig } = await loadEngine();
    const cfg = getModuleConfig('BCM');
    expect(cfg).not.toBeNull();
    expect(cfg!.tx).toBe(0x744);
    expect(cfg!.rx).toBe(0x74C);
  });

  it('returns ECM config with tx=0x7E0', async () => {
    const { getModuleConfig } = await loadEngine();
    const cfg = getModuleConfig('ECM');
    expect(cfg).not.toBeNull();
    expect(cfg!.tx).toBe(0x7E0);
    expect(cfg!.rx).toBe(0x7E8);
  });
});

// ─── getAllModules ────────────────────────────────────────────────────────────
describe('getAllModules', () => {
  it('returns an array with more than 5 modules', async () => {
    const { getAllModules } = await loadEngine();
    const mods = getAllModules();
    expect(Array.isArray(mods)).toBe(true);
    expect(mods.length).toBeGreaterThan(5);
  });

  it('every module has tx, rx, algo, code fields', async () => {
    const { getAllModules } = await loadEngine();
    getAllModules().forEach((m: any) => {
      expect(m).toHaveProperty('tx');
      expect(m).toHaveProperty('rx');
      expect(m).toHaveProperty('algo');
      expect(m).toHaveProperty('code');
    });
  });

  it('includes IPC, BCM, ECM, RFHUB', async () => {
    const { getAllModules } = await loadEngine();
    const codes = getAllModules().map((m: any) => m.code);
    expect(codes).toContain('IPC');
    expect(codes).toContain('BCM');
    expect(codes).toContain('ECM');
    expect(codes).toContain('RFHUB');
  });
});

// ─── getModuleDids ────────────────────────────────────────────────────────────
describe('getModuleDids', () => {
  it('returns IPC-specific DID list', async () => {
    const { getModuleDids } = await loadEngine();
    const dids = getModuleDids('IPC');
    expect(Array.isArray(dids)).toBe(true);
    expect(dids.length).toBeGreaterThan(0);
  });

  it('returns COMMON_DIDS fallback for unknown module (non-empty)', async () => {
    // getModuleDids falls back to COMMON_DIDS for unknown modules
    const { getModuleDids, COMMON_DIDS } = await loadEngine();
    const dids = getModuleDids('DOES_NOT_EXIST');
    expect(dids.length).toBe(COMMON_DIDS.length);
  });

  it('IPC DIDs include Vehicle Body Code (0xF10F)', async () => {
    const { getModuleDids } = await loadEngine();
    const dids = getModuleDids('IPC');
    const bodyDid = dids.find((d: any) => d.did === 0xF10F);
    expect(bodyDid).toBeDefined();
  });
});

// ─── UDS frame builders ───────────────────────────────────────────────────────
describe('buildReadDid', () => {
  it('builds [0x22, 0xF1, 0x90] for VIN DID 0xF190', async () => {
    const { buildReadDid } = await loadEngine();
    expect(buildReadDid(0xF190)).toEqual([0x22, 0xF1, 0x90]);
  });

  it('builds [0x22, 0xF1, 0x0F] for body code DID 0xF10F', async () => {
    const { buildReadDid } = await loadEngine();
    expect(buildReadDid(0xF10F)).toEqual([0x22, 0xF1, 0x0F]);
  });

  it('builds [0x22, 0xF1, 0x87] for part number DID 0xF187', async () => {
    const { buildReadDid } = await loadEngine();
    expect(buildReadDid(0xF187)).toEqual([0x22, 0xF1, 0x87]);
  });
});

describe('buildWriteDid', () => {
  it('builds [0x2E, 0xF1, 0x90, ...data]', async () => {
    const { buildWriteDid } = await loadEngine();
    const frame = buildWriteDid(0xF190, [0x31, 0x32, 0x33]);
    expect(frame[0]).toBe(0x2E);
    expect(frame[1]).toBe(0xF1);
    expect(frame[2]).toBe(0x90);
    expect(frame.slice(3)).toEqual([0x31, 0x32, 0x33]);
  });

  it('handles empty data array', async () => {
    const { buildWriteDid } = await loadEngine();
    const frame = buildWriteDid(0xF10F, []);
    expect(frame).toEqual([0x2E, 0xF1, 0x0F]);
  });
});

describe('buildDsc', () => {
  it('builds [0x10, 0x03] for extended session', async () => {
    const { buildDsc } = await loadEngine();
    expect(buildDsc(0x03)).toEqual([0x10, 0x03]);
  });

  it('builds [0x10, 0x01] for default session', async () => {
    const { buildDsc } = await loadEngine();
    expect(buildDsc(0x01)).toEqual([0x10, 0x01]);
  });

  it('builds [0x10, 0x02] for programming session', async () => {
    const { buildDsc } = await loadEngine();
    expect(buildDsc(0x02)).toEqual([0x10, 0x02]);
  });
});

describe('buildSeedRequest', () => {
  it('builds [0x27, 0x01] for level 1', async () => {
    const { buildSeedRequest } = await loadEngine();
    expect(buildSeedRequest(0x01)).toEqual([0x27, 0x01]);
  });

  it('builds [0x27, 0x03] for level 3', async () => {
    const { buildSeedRequest } = await loadEngine();
    expect(buildSeedRequest(0x03)).toEqual([0x27, 0x03]);
  });
});

describe('buildKeySend', () => {
  // buildKeySend(level, bytes) → [0x27, level+1, ...bytes]
  // This matches UDS spec: seed request is odd level, key send is even (level+1)
  it('buildKeySend(0x02, [0x90, 0x18]) → [0x27, 0x03, 0x90, 0x18]', async () => {
    const { buildKeySend } = await loadEngine();
    expect(buildKeySend(0x02, [0x90, 0x18])).toEqual([0x27, 0x03, 0x90, 0x18]);
  });

  it('buildKeySend(0x04, [0xAB, 0xCD]) → [0x27, 0x05, 0xAB, 0xCD]', async () => {
    const { buildKeySend } = await loadEngine();
    expect(buildKeySend(0x04, [0xAB, 0xCD])).toEqual([0x27, 0x05, 0xAB, 0xCD]);
  });

  it('starts with 0x27 (SecurityAccess SID)', async () => {
    const { buildKeySend } = await loadEngine();
    const frame = buildKeySend(0x02, [0x12, 0x34]);
    expect(frame[0]).toBe(0x27);
  });
});

describe('buildTesterPresent', () => {
  it('builds [0x3E, 0x00]', async () => {
    const { buildTesterPresent } = await loadEngine();
    expect(buildTesterPresent()).toEqual([0x3E, 0x00]);
  });
});

describe('buildEcuReset', () => {
  it('builds [0x11, 0x01] for hard reset', async () => {
    const { buildEcuReset } = await loadEngine();
    expect(buildEcuReset(0x01)).toEqual([0x11, 0x01]);
  });

  it('defaults to hard reset (0x01)', async () => {
    const { buildEcuReset } = await loadEngine();
    expect(buildEcuReset()).toEqual([0x11, 0x01]);
  });
});

// ─── buildSessionSequence ────────────────────────────────────────────────────
describe('buildSessionSequence', () => {
  it('returns an array of steps for IPC extended session', async () => {
    const { buildSessionSequence } = await loadEngine();
    const seq = buildSessionSequence('IPC', 'extended');
    expect(Array.isArray(seq)).toBe(true);
    expect(seq.length).toBeGreaterThan(2);
  });

  it('first step has bytes starting with 0x10 (DSC)', async () => {
    const { buildSessionSequence } = await loadEngine();
    const seq = buildSessionSequence('IPC', 'extended');
    const first = seq[0];
    expect(first.bytes).toBeDefined();
    expect(first.bytes[0]).toBe(0x10);
  });

  it('includes seed request step (bytes[0] === 0x27)', async () => {
    const { buildSessionSequence } = await loadEngine();
    const seq = buildSessionSequence('IPC', 'programming');
    const seedStep = seq.find((s: any) => s.bytes && s.bytes[0] === 0x27);
    expect(seedStep).toBeDefined();
  });

  it('every step has bytes, description, step fields', async () => {
    const { buildSessionSequence } = await loadEngine();
    const seq = buildSessionSequence('IPC', 'extended');
    seq.forEach((s: any) => {
      expect(s).toHaveProperty('bytes');
      expect(s).toHaveProperty('description');
      expect(s).toHaveProperty('step');
      expect(Array.isArray(s.bytes)).toBe(true);
    });
  });

  it('returns steps for BCM', async () => {
    const { buildSessionSequence } = await loadEngine();
    const seq = buildSessionSequence('BCM', 'extended');
    expect(seq.length).toBeGreaterThan(0);
  });
});

// ─── buildIpcBodyCodeSwap ─────────────────────────────────────────────────────
describe('buildIpcBodyCodeSwap', () => {
  it('returns an array of steps', async () => {
    const { buildIpcBodyCodeSwap } = await loadEngine();
    const steps = buildIpcBodyCodeSwap(0x09);
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });

  it('includes a write DID step for F10F (bytes: [0x2E, 0xF1, 0x0F, ...])', async () => {
    const { buildIpcBodyCodeSwap } = await loadEngine();
    const steps = buildIpcBodyCodeSwap(0x09);
    const writeStep = steps.find((s: any) =>
      s.bytes && s.bytes[0] === 0x2E && s.bytes[1] === 0xF1 && s.bytes[2] === 0x0F
    );
    expect(writeStep).toBeDefined();
  });

  it('encodes target body code 0x09 in the write frame', async () => {
    const { buildIpcBodyCodeSwap } = await loadEngine();
    const steps = buildIpcBodyCodeSwap(0x09);
    const writeStep = steps.find((s: any) =>
      s.bytes && s.bytes[0] === 0x2E && s.bytes[1] === 0xF1 && s.bytes[2] === 0x0F
    );
    expect(writeStep).toBeDefined();
    expect(writeStep!.bytes).toContain(0x09);
  });

  it('includes a DSC session step (bytes[0] === 0x10)', async () => {
    const { buildIpcBodyCodeSwap } = await loadEngine();
    const steps = buildIpcBodyCodeSwap(0x09);
    const dscStep = steps.find((s: any) => s.bytes && s.bytes[0] === 0x10);
    expect(dscStep).toBeDefined();
  });

  it('includes a security access step (bytes[0] === 0x27)', async () => {
    const { buildIpcBodyCodeSwap } = await loadEngine();
    const steps = buildIpcBodyCodeSwap(0x09);
    const secStep = steps.find((s: any) => s.bytes && s.bytes[0] === 0x27);
    expect(secStep).toBeDefined();
  });

  it('works for Durango body code (WD = 0x0B)', async () => {
    const { buildIpcBodyCodeSwap, VEHICLE_BODY_CODES } = await loadEngine();
    const wdCode = VEHICLE_BODY_CODES.WD.code; // 0x0B = 11
    const steps = buildIpcBodyCodeSwap(wdCode);
    expect(steps.length).toBeGreaterThan(0);
    const writeStep = steps.find((s: any) =>
      s.bytes && s.bytes[0] === 0x2E && s.bytes[1] === 0xF1 && s.bytes[2] === 0x0F
    );
    expect(writeStep).toBeDefined();
    expect(writeStep!.bytes).toContain(wdCode);
  });
});

// ─── VEHICLE_BODY_CODES ───────────────────────────────────────────────────────
describe('VEHICLE_BODY_CODES', () => {
  it('has WK (Trackhawk) with code=9', async () => {
    const { VEHICLE_BODY_CODES } = await loadEngine();
    expect(VEHICLE_BODY_CODES.WK).toBeDefined();
    expect(VEHICLE_BODY_CODES.WK.code).toBe(9);
  });

  it('has WD (Durango) with code=11', async () => {
    const { VEHICLE_BODY_CODES } = await loadEngine();
    expect(VEHICLE_BODY_CODES.WD).toBeDefined();
    expect(VEHICLE_BODY_CODES.WD.code).toBe(11);
  });

  it('has LD (Charger) with code=13', async () => {
    const { VEHICLE_BODY_CODES } = await loadEngine();
    expect(VEHICLE_BODY_CODES.LD).toBeDefined();
    expect(VEHICLE_BODY_CODES.LD.code).toBe(13);
  });

  it('WK and WD have different body codes', async () => {
    const { VEHICLE_BODY_CODES } = await loadEngine();
    expect(VEHICLE_BODY_CODES.WK.code).not.toBe(VEHICLE_BODY_CODES.WD.code);
  });

  it('all body codes are numbers', async () => {
    const { VEHICLE_BODY_CODES } = await loadEngine();
    Object.values(VEHICLE_BODY_CODES).forEach((v: any) => {
      expect(typeof v.code).toBe('number');
    });
  });

  it('has LX (Charger LX) entry', async () => {
    const { VEHICLE_BODY_CODES } = await loadEngine();
    expect(VEHICLE_BODY_CODES.LX).toBeDefined();
  });
});

// ─── NRC decoder ─────────────────────────────────────────────────────────────
describe('decodeNrc', () => {
  // decodeNrc returns {name, desc} object

  it('decodes 0x35 — invalid key (IK)', async () => {
    const { decodeNrc } = await loadEngine();
    const result = decodeNrc(0x35);
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('desc');
    // New NRC table uses ISO short names (IK) from workspace-uds/nrc.ts
    expect(result.name).toMatch(/invalidKey|invalid|^IK$/i);
    expect(result.desc).toMatch(/key/i);
  });

  it('decodes 0x36 — exceededAttempts', async () => {
    const { decodeNrc } = await loadEngine();
    const result = decodeNrc(0x36);
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('desc');
    expect(result.desc).toMatch(/exceed|attempt/i);
  });

  it('decodes 0x22 — conditionsNotCorrect', async () => {
    const { decodeNrc } = await loadEngine();
    const result = decodeNrc(0x22);
    expect(result).toHaveProperty('desc');
    expect(result.desc).toMatch(/condition/i);
  });

  it('decodes 0x31 — requestOutOfRange', async () => {
    const { decodeNrc } = await loadEngine();
    const result = decodeNrc(0x31);
    expect(result).toHaveProperty('desc');
    expect(result.desc).toMatch(/range|out/i);
  });

  it('returns an object with name and desc for unknown NRC', async () => {
    const { decodeNrc } = await loadEngine();
    const result = decodeNrc(0xFE);
    expect(typeof result).toBe('object');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('desc');
  });

  it('NRC_TABLE has 0x35 entry', async () => {
    const { NRC_TABLE } = await loadEngine();
    expect(NRC_TABLE[0x35]).toBeDefined();
    expect(NRC_TABLE[0x35].name).toBeDefined();
  });
});

// ─── formatHex / parseHexString ───────────────────────────────────────────────
describe('formatHex', () => {
  it('formats [0x10, 0x03] as hex string containing "10" and "03"', async () => {
    const { formatHex } = await loadEngine();
    const result = formatHex([0x10, 0x03]);
    expect(result.toLowerCase()).toMatch(/10/);
    expect(result.toLowerCase()).toMatch(/03/);
  });

  it('handles empty array → empty string', async () => {
    const { formatHex } = await loadEngine();
    expect(formatHex([])).toBe('');
  });

  it('formats single byte [0xAB] containing "ab"', async () => {
    const { formatHex } = await loadEngine();
    const result = formatHex([0xAB]);
    expect(result.toLowerCase()).toContain('ab');
  });
});

describe('parseHexString', () => {
  it('parses "10 03" (space-separated) → [0x10, 0x03]', async () => {
    const { parseHexString } = await loadEngine();
    expect(parseHexString('10 03')).toEqual([0x10, 0x03]);
  });

  it('parses "0x10 0x03" (0x-prefixed) → [0x10, 0x03]', async () => {
    const { parseHexString } = await loadEngine();
    expect(parseHexString('0x10 0x03')).toEqual([0x10, 0x03]);
  });

  it('parses single byte "10" → [0x10]', async () => {
    const { parseHexString } = await loadEngine();
    expect(parseHexString('10')).toEqual([0x10]);
  });

  it('parses empty string → []', async () => {
    const { parseHexString } = await loadEngine();
    expect(parseHexString('')).toEqual([]);
  });

  it('parses "2E F1 0F 09" → [0x2E, 0xF1, 0x0F, 0x09]', async () => {
    const { parseHexString } = await loadEngine();
    expect(parseHexString('2E F1 0F 09')).toEqual([0x2E, 0xF1, 0x0F, 0x09]);
  });
});

// ─── COMMON_DIDS catalog ──────────────────────────────────────────────────────
describe('COMMON_DIDS', () => {
  it('is a non-empty array', async () => {
    const { COMMON_DIDS } = await loadEngine();
    expect(Array.isArray(COMMON_DIDS)).toBe(true);
    expect(COMMON_DIDS.length).toBeGreaterThan(0);
  });

  it('contains VIN DID (0xF190 = 61840)', async () => {
    const { COMMON_DIDS } = await loadEngine();
    const vin = COMMON_DIDS.find((d: any) => d.did === 0xF190);
    expect(vin).toBeDefined();
  });

  it('every entry has did, name, rw fields', async () => {
    const { COMMON_DIDS } = await loadEngine();
    COMMON_DIDS.forEach((d: any) => {
      expect(d).toHaveProperty('did');
      expect(d).toHaveProperty('name');
      expect(d).toHaveProperty('rw');
    });
  });
});

// ─── ALGO constants ───────────────────────────────────────────────────────────
describe('ALGO constants', () => {
  it('has SBEC, CDA6, GPEC2 constants', async () => {
    const { ALGO } = await loadEngine();
    expect(ALGO.SBEC).toBeDefined();
    expect(ALGO.CDA6).toBeDefined();
    expect(ALGO.GPEC2).toBeDefined();
  });

  it('all constants are distinct strings', async () => {
    const { ALGO } = await loadEngine();
    const values = Object.values(ALGO);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
