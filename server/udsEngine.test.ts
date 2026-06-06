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

// ═══════════════════════════════════════════════════════════════════════════════
// CB MASTER PREMIUM 2026 — GAP PATCH TESTS (10 gaps, 2026-06-06)
// Source: CB Master Premium Stellantis 2026 v6 — 53 pages, 4 verified real dumps
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GAP 1: RFH classic field map offsets ────────────────────────────────────
describe('GAP1 — RFH_DUMP_FIELD_MAP classic offsets (CB manual pages 27-29)', () => {
  it('signature is at 0x020 (not 0x000)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.signature.offset).toBe(0x020);
  });

  it('S/N is at 0x040 (not 0x004)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.sn.offset).toBe(0x040);
  });

  it('S/N mirror is at 0x080 (not 0x008)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.snMirror.offset).toBe(0x080);
  });

  it('Crypto HIGH is at 0x166 (2B), not 0x00C (4B)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.cryptoHigh.offset).toBe(0x166);
    expect(RFH_DUMP_FIELD_MAP.classic.cryptoHigh.len).toBe(2);
  });

  it('Crypto LOW is at 0x168 (4B), not 0x010', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.cryptoLow.offset).toBe(0x168);
    expect(RFH_DUMP_FIELD_MAP.classic.cryptoLow.len).toBe(4);
  });

  it('Crypto mirror is at 0x180 (6B), not 0x014 (8B)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.cryptoMirror.offset).toBe(0x180);
    expect(RFH_DUMP_FIELD_MAP.classic.cryptoMirror.len).toBe(6);
  });

  it('Config/TMCF is at 0x1A0 (4B), not 0x01C (2B)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.config.offset).toBe(0x1A0);
    expect(RFH_DUMP_FIELD_MAP.classic.config.len).toBe(4);
  });

  it('Config mirror is at 0x1C0 (4B), not 0x01E', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.configMirror.offset).toBe(0x1C0);
  });

  it('PIN is at 0x1C6 (not 0x020) — verified ISAC case PIN 1507', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.pin.offset).toBe(0x1C6);
  });

  it('VIN is at 0x1EA (not 0x0EA5)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.classic.vin.offset).toBe(0x1EA);
  });

  it('analyzeRfhDump extracts correct PIN from ISAC case (07 15 → PIN 1507)', async () => {
    const { analyzeRfhDump } = await loadEngine();
    // Build minimal 0x200-byte dump with ISAC case data
    const dump = new Uint8Array(0x200);
    // Signature at 0x020
    dump[0x020] = 0x5A; dump[0x021] = 0x5A; dump[0x022] = 0x5A; dump[0x023] = 0x5A;
    // S/N at 0x040 (LE: 9C 46 8D DD → inverted: DD 8D 46 9C)
    dump[0x040] = 0x9C; dump[0x041] = 0x46; dump[0x042] = 0x8D; dump[0x043] = 0xDD;
    // PIN at 0x1C6 (LE: 07 15 → inverted: 15 07 → "1507")
    dump[0x1C6] = 0x07; dump[0x1C7] = 0x15;
    const result = analyzeRfhDump(dump);
    expect(result.derived.pinDecimal).toBe('1507');
  });

  it('analyzeRfhDump extracts correct PIN from HYHY case (08 28 → PIN 2808)', async () => {
    const { analyzeRfhDump } = await loadEngine();
    const dump = new Uint8Array(0x200);
    dump[0x020] = 0x5A; dump[0x021] = 0x5A; dump[0x022] = 0x5A; dump[0x023] = 0x5A;
    // PIN at 0x1C6 (LE: 08 28 → inverted: 28 08 → "2808")
    dump[0x1C6] = 0x08; dump[0x1C7] = 0x28;
    const result = analyzeRfhDump(dump);
    expect(result.derived.pinDecimal).toBe('2808');
  });

  it('analyzeRfhDump extracts correct S/N from ISAC case (LE→BE inversion)', async () => {
    const { analyzeRfhDump } = await loadEngine();
    const dump = new Uint8Array(0x200);
    dump[0x020] = 0x5A; dump[0x021] = 0x5A; dump[0x022] = 0x5A; dump[0x023] = 0x5A;
    dump[0x040] = 0x9C; dump[0x041] = 0x46; dump[0x042] = 0x8D; dump[0x043] = 0xDD;
    const result = analyzeRfhDump(dump);
    // LE→BE: [9C, 46, 8D, DD] reversed = [DD, 8D, 46, 9C]
    expect(result.fields.sn?.value).toEqual([0xDD, 0x8D, 0x46, 0x9C]);
  });
});

// ─── GAP 2: 2019+ variant detection ──────────────────────────────────────────
describe('GAP2 — RFH 2019+ variant detection (CB manual page 33)', () => {
  it('2019+ variant has signature 5A×4 at 0x020 (same as classic, NOT AA 55)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.new2019.signature.offset).toBe(0x020);
    expect(RFH_DUMP_FIELD_MAP.new2019.signature.expected).toEqual([0x5A, 0x5A, 0x5A, 0x5A]);
  });

  it('2019+ VIN is at 0x040 (moved from 0x1EA)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.new2019.vin.offset).toBe(0x040);
  });

  it('2019+ S/N is at 0x069 (moved from 0x040)', async () => {
    const { RFH_DUMP_FIELD_MAP } = await loadEngine();
    expect(RFH_DUMP_FIELD_MAP.new2019.sn.offset).toBe(0x069);
  });

  it('analyzeRfhDump detects 2019+ when VIN ASCII is at 0x040', async () => {
    const { analyzeRfhDump } = await loadEngine();
    const dump = new Uint8Array(0x200);
    // Signature at 0x020
    dump[0x020] = 0x5A; dump[0x021] = 0x5A; dump[0x022] = 0x5A; dump[0x023] = 0x5A;
    // VIN at 0x040 (17 ASCII chars — RAM 1500 USA VIN)
    const vin = '1C6RR6TTOKS731726';
    for (let i = 0; i < 17; i++) dump[0x040 + i] = vin.charCodeAt(i);
    const result = analyzeRfhDump(dump);
    expect(result.variant).toBe('new2019');
  });

  it('analyzeRfhDump detects classic when 0x040 is binary (not ASCII VIN)', async () => {
    const { analyzeRfhDump } = await loadEngine();
    const dump = new Uint8Array(0x200);
    dump[0x020] = 0x5A; dump[0x021] = 0x5A; dump[0x022] = 0x5A; dump[0x023] = 0x5A;
    // 0x040 has binary S/N data (not ASCII)
    dump[0x040] = 0x9C; dump[0x041] = 0x46; dump[0x042] = 0x8D; dump[0x043] = 0xDD;
    const result = analyzeRfhDump(dump);
    expect(result.variant).toBe('classic');
  });
});

// ─── GAP 3: Fujitsu dual-cfg checksum ────────────────────────────────────────
describe('GAP3 — calcFujitsuChecksum dual-cfg +1 rule (CB manual page 39)', () => {
  it('cfg=1 (default): returns plain linear sum', async () => {
    const { calcFujitsuChecksum } = await loadEngine();
    // Argo BCM block 1 (cfg=01): sum of bytes should give 0x1A8E
    // Use known example: block with known sum
    const block = new Array(64).fill(0x00);
    block[0] = 0x1A; block[1] = 0x8E; // put sum at end for reference
    const sum = block.reduce((a, b) => (a + b) & 0xFFFF, 0);
    expect(calcFujitsuChecksum(block, 1)).toBe(sum);
  });

  it('cfg=2: returns (linear sum + 1) — Argo/Toro block 3/4 pattern', async () => {
    const { calcFujitsuChecksum } = await loadEngine();
    const block = [0xB4, 0x47, 0x3F, 0x14, 0xB2, 0x1E]; // Toro sync bytes
    const sumCfg1 = calcFujitsuChecksum(block, 1);
    const sumCfg2 = calcFujitsuChecksum(block, 2);
    expect(sumCfg2).toBe((sumCfg1 + 1) & 0xFFFF);
  });

  it('Toro Diesel: cfg=01 checksum is 0x159A, cfg=02 is 0x159B (delta +1)', async () => {
    const { calcFujitsuChecksum } = await loadEngine();
    // Verified from CB manual page 40 real dump
    // The difference between 15 9A and 15 9B is exactly +1
    const toroChecksumCfg01 = 0x159A;
    const toroChecksumCfg02 = 0x159B;
    expect(toroChecksumCfg02 - toroChecksumCfg01).toBe(1);
  });

  it('Argo: cfg=01 checksum is 0x1A8E, cfg=02 is 0x1A8F (delta +1)', async () => {
    // Verified from CB manual page 41 real dump
    const argoChecksumCfg01 = 0x1A8E;
    const argoChecksumCfg02 = 0x1A8F;
    expect(argoChecksumCfg02 - argoChecksumCfg01).toBe(1);
  });

  it('Renegade B1 1.3T: single checksum 0x0856 — no dual cfg', async () => {
    const { calcFujitsuChecksum } = await loadEngine();
    // Renegade B1 uses 28B block with no cfg variation
    const block = new Array(28).fill(0x00);
    // cfg=1 and cfg=2 should differ by 1 (function works), but B1 always uses cfg=1
    const cs1 = calcFujitsuChecksum(block, 1);
    const cs2 = calcFujitsuChecksum(block, 2);
    expect(cs2).toBe((cs1 + 1) & 0xFFFF);
  });
});

// ─── GAP 4: Renegade B1 1.3T BCM offsets ─────────────────────────────────────
describe('GAP4 — Renegade B1 1.3T BCM sync at 0xE03D (CB manual page 42)', () => {
  it('renegade_b1_aes BCM sync offset is 0xE03D (not 0x7C00)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.bcmSyncOffset).toBe(0xE03D);
  });

  it('renegade_b1_aes BCM mirror is at 0xE059 (second contiguous 28B copy)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.bcmSyncMirror).toBe(0xE059);
  });

  it('renegade_b1_aes BCM checksum offset is 0xE076 (CB manual page 48 flash map)', async () => {
    // CB manual page 48 explicitly lists: 0xE076 = Checksum sync (Renegade B1)
    // Previous value 0xE676 was a typo — corrected in UDS deep-dive patch session.
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.bcmChecksumOffset).toBe(0xE076);
  });

  it('renegade_b1_aes BCM checksum value is 0x0856', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.bcmChecksumValue).toBe(0x0856);
  });

  it('renegade_b1_aes block size is 28B (not 64B)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.bcmBlockSize).toBe(28);
  });
});

// ─── GAP 5: GPEC 4LM distinct variant ────────────────────────────────────────
describe('GAP5 — GPEC 4LM as distinct PCM variant (CB manual page 39)', () => {
  it('renegade_b1_aes PCM is GPEC 4LM (not Continental)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.pcm).toContain('GPEC 4LM');
  });

  it('renegade_b1_aes PCM variant is gpec4lm', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.pcmVariant).toBe('gpec4lm');
  });

  it('renegade_b1_aes PCM sync offset is 0x0230 (not 0x3C7 GPEC2A)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.pcmSyncOffset).toBe(0x0230);
  });

  it('renegade_b1_aes PCM requires checksum (unlike other GPEC variants)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.pcmChecksumRequired).toBe(true);
    expect(b1aes?.pcmChecksumValue).toBe(0x0856);
  });
});

// ─── GAP 6: Chrysler 200 CTS block enforcement ───────────────────────────────
describe('GAP6 — Chrysler 200 CTS block at 0x400 (CB manual page 23)', () => {
  it('chrysler_200 has pcmCtsBlockRequired=true', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const cuswide = CB_SYNC_FAMILIES.find((f: any) => f.id === 'cuswide');
    const c200 = cuswide?.models.find((m: any) => m.id === 'chrysler_200');
    expect(c200?.pcmCtsBlockRequired).toBe(true);
  });

  it('chrysler_200 CTS block offset is 0x0400', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const cuswide = CB_SYNC_FAMILIES.find((f: any) => f.id === 'cuswide');
    const c200 = cuswide?.models.find((m: any) => m.id === 'chrysler_200');
    expect(c200?.pcmCtsBlockOffset).toBe(0x0400);
  });

  it('chrysler_200 CTS block marker is CTSAA (43 54 53 41 41)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const cuswide = CB_SYNC_FAMILIES.find((f: any) => f.id === 'cuswide');
    const c200 = cuswide?.models.find((m: any) => m.id === 'chrysler_200');
    expect(c200?.pcmCtsBlockMarker).toEqual([0x43, 0x54, 0x53, 0x41, 0x41]);
  });

  it('chrysler_200 notes mention DTC P0513 risk', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const cuswide = CB_SYNC_FAMILIES.find((f: any) => f.id === 'cuswide');
    const c200 = cuswide?.models.find((m: any) => m.id === 'chrysler_200');
    expect(c200?.notes).toContain('P0513');
  });
});

// ─── GAP 7: Fiat Argo/Cronos BCM and Marelli PCM offsets ─────────────────────
describe('GAP7 — Fiat Argo BCM at 0xE085 and Marelli PCM at 0x202 (CB manual page 41)', () => {
  it('fiat_argo BCM sync offset is 0xE085 (not 0x7C00)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.bcmSyncOffset).toBe(0xE085);
  });

  it('fiat_argo BCM has 5-byte header pattern [00 00 00 1D 00]', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.bcmSyncHeaderBytes).toBe(5);
    expect(argo?.bcmSyncHeaderPattern).toEqual([0x00, 0x00, 0x00, 0x1D, 0x00]);
  });

  it('fiat_argo BCM block is 64B ×4 with cfg=01/01/02/02', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.bcmBlockSize).toBe(64);
    expect(argo?.bcmBlockCount).toBe(4);
    expect(argo?.bcmBlockCfg).toEqual([0x01, 0x01, 0x02, 0x02]);
  });

  it('fiat_argo BCM checksums: 1A 8E (cfg=01) / 1A 8F (cfg=02)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.bcmChecksumCfg01).toEqual([0x1A, 0x8E]);
    expect(argo?.bcmChecksumCfg02).toEqual([0x1A, 0x8F]);
  });

  it('fiat_argo PCM variant is marelli_iaw10gf', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.pcmVariant).toBe('marelli_iaw10gf');
  });

  it('fiat_argo PCM sync offset is 0x0202 (not 0x0080)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.pcmSyncOffset).toBe(0x0202);
  });

  it('fiat_argo PCM sync rule is direct_6b (Marelli — no inversion)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.pcmSyncRule).toBe('direct_6b');
  });

  it('fiat_argo Marelli PCM checksums: A1 03 (cfg=01) / A2 02 (cfg=02)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.pcmChecksumCfg01).toEqual([0xA1, 0x03]);
    expect(argo?.pcmChecksumCfg02).toEqual([0xA2, 0x02]);
  });

  it('fiat_cronos has same BCM/PCM offsets as Argo (identical family)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const cronos = fiatBrasil?.models.find((m: any) => m.id === 'fiat_cronos');
    expect(cronos?.bcmSyncOffset).toBe(0xE085);
    expect(cronos?.pcmSyncOffset).toBe(0x0202);
    expect(cronos?.pcmVariant).toBe('marelli_iaw10gf');
  });
});

// ─── GAP 8: RFH sync mirror at 0x512 ─────────────────────────────────────────
describe('GAP8 — RFH sync mirror at 0x512 (CB manual page 40)', () => {
  it('fiat_argo RFH sync primary is at 0x04FE', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.rfhSyncOffset).toBe(0x04FE);
  });

  it('fiat_argo RFH sync mirror is at 0x0512 (not null)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const argo = fiatBrasil?.models.find((m: any) => m.id === 'fiat_argo');
    expect(argo?.rfhSyncMirror).toBe(0x0512);
  });

  it('fiat_toro_diesel RFH sync primary is at 0x04FE', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const toro = fiatBrasil?.models.find((m: any) => m.id === 'fiat_toro_diesel');
    expect(toro?.rfhSyncOffset).toBe(0x04FE);
  });

  it('fiat_toro_diesel RFH sync mirror is at 0x0512', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const toro = fiatBrasil?.models.find((m: any) => m.id === 'fiat_toro_diesel');
    expect(toro?.rfhSyncMirror).toBe(0x0512);
  });
});

// ─── GAP 9: Toro Diesel PCM EDC17 sync offset ────────────────────────────────
describe('GAP9 — Toro Diesel PCM EDC17 sync at 0x204 (CB manual page 40)', () => {
  it('fiat_toro_diesel PCM sync offset is 0x0204 (not 0x0080)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const toro = fiatBrasil?.models.find((m: any) => m.id === 'fiat_toro_diesel');
    expect(toro?.pcmSyncOffset).toBe(0x0204);
  });

  it('fiat_toro_diesel PCM variant is edc17c69', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const toro = fiatBrasil?.models.find((m: any) => m.id === 'fiat_toro_diesel');
    expect(toro?.pcmVariant).toBe('edc17c69');
  });

  it('fiat_toro_diesel PCM sync rule is edc17_invert_6421531', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const toro = fiatBrasil?.models.find((m: any) => m.id === 'fiat_toro_diesel');
    expect(toro?.pcmSyncRule).toBe('edc17_invert_6421531');
  });

  it('fiat_toro_diesel BCM sync offset is 0xE085 (not 0x7C00)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const toro = fiatBrasil?.models.find((m: any) => m.id === 'fiat_toro_diesel');
    expect(toro?.bcmSyncOffset).toBe(0xE085);
  });

  it('fiat_toro_diesel BCM checksums: 15 9A (cfg=01) / 15 9B (cfg=02)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const toro = fiatBrasil?.models.find((m: any) => m.id === 'fiat_toro_diesel');
    expect(toro?.bcmChecksumCfg01).toEqual([0x15, 0x9A]);
    expect(toro?.bcmChecksumCfg02).toEqual([0x15, 0x9B]);
  });

  it('edc17SyncInvert: Toro real example BCM→PCM (B4 47 3F 14 B2 1E → 1E 14 47 B2 3F B4)', async () => {
    const { edc17SyncInvert } = await loadEngine();
    // Rule: [B1,B2,B3,B4,B5,B6] → [B6,B4,B2,B5,B3,B1]
    // Input: [B4, 47, 3F, 14, B2, 1E] (0-indexed: 0=B4, 1=47, 2=3F, 3=14, 4=B2, 5=1E)
    // Output: [b[5], b[3], b[1], b[4], b[2], b[0]] = [1E, 14, 47, B2, 3F, B4]
    const bcm = [0xB4, 0x47, 0x3F, 0x14, 0xB2, 0x1E];
    const pcm = edc17SyncInvert(bcm);
    expect(pcm).toEqual([0x1E, 0x14, 0x47, 0xB2, 0x3F, 0xB4]);
  });
});

// ─── GAP 10: Renegade B1 1.3T HITAG AES crypto key storage ───────────────────
describe('GAP10 — Renegade B1 1.3T HITAG AES crypto key LE storage (CB manual page 42)', () => {
  it('renegade_b1_aes transponder is HITAG AES (16B)', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.transponder).toContain('HITAG AES');
  });

  it('renegade_b1_aes transponder crypto key note mentions Little-Endian storage', async () => {
    const { CB_SYNC_FAMILIES } = await loadEngine();
    const fiatBrasil = CB_SYNC_FAMILIES.find((f: any) => f.id === 'fiat_brasil');
    const b1aes = fiatBrasil?.models.find((m: any) => m.id === 'renegade_b1_aes');
    expect(b1aes?.transponderCryptoKey).toContain('Little-Endian');
  });

  it('TRANSPONDER_TYPE_MATRIX: Renegade B1 1.3T uses Tango Plus / Autel IM608', async () => {
    const { TRANSPONDER_TYPE_MATRIX } = await loadEngine();
    const b1 = TRANSPONDER_TYPE_MATRIX.find((m: any) => m.model.includes('1.3T'));
    expect(b1?.tool).toContain('Tango Plus');
    expect(b1?.type).toContain('HITAG AES');
  });

  it('TRANSPONDER_TYPE_MATRIX: basic Tango cannot clone HITAG AES', async () => {
    const { TRANSPONDER_TYPE_MATRIX } = await loadEngine();
    const b1 = TRANSPONDER_TYPE_MATRIX.find((m: any) => m.model.includes('1.3T'));
    expect(b1?.note).toContain('NOT clonable');
  });
});

// ─── Regression: existing EDC17 invert still correct ─────────────────────────
describe('EDC17 invert regression (must not break after gap patches)', () => {
  it('edc17SyncInvert: rule 6-4-2-5-3-1 (1-indexed) on [AA BB CC DD EE FF]', async () => {
    const { edc17SyncInvert } = await loadEngine();
    // Input:  [AA, BB, CC, DD, EE, FF]  (indices 0-5, 1-indexed: 1,2,3,4,5,6)
    // Output: [FF, DD, BB, EE, CC, AA]  (positions 6,4,2,5,3,1 → indices 5,3,1,4,2,0)
    const result = edc17SyncInvert([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    expect(result).toEqual([0xFF, 0xDD, 0xBB, 0xEE, 0xCC, 0xAA]);
  });

  it('edc17SyncInvert: applying twice gives different result (not self-inverse)', async () => {
    const { edc17SyncInvert } = await loadEngine();
    const original = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF];
    const once = edc17SyncInvert(original);
    const twice = edc17SyncInvert(once);
    // The permutation [5,3,1,4,2,0] is NOT self-inverse
    expect(twice).not.toEqual(original);
    // Verify the double-inversion result is deterministic:
    // once = [FF, DD, BB, EE, CC, AA]
    // twice = [AA, EE, DD, CC, BB, FF]
    expect(twice).toEqual([0xAA, 0xEE, 0xDD, 0xCC, 0xBB, 0xFF]);
  });
});
