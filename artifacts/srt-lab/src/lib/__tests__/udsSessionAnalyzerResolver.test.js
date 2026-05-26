import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseTrace } from '../udsSessionAnalyzer/parser.js';
import { analyzeSession } from '../udsSessionAnalyzer/analyze.js';
import {
  resolveEcuName,
  resolveService,
  resolveRoutine,
  resolveFrame,
  formatResolved,
  SOURCE_ISO14229,
  SOURCE_ALFAOBD,
} from '../udsSessionAnalyzer/resolver.js';
import { ECU_TO_CAN_FROM_EXE } from '../ecuToCanFromExe.generated.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  resolve(__dirname, '../udsSessionAnalyzer/fixtures/example_session.log'),
  'utf-8'
);

// Find a CAN-ID that maps to a single named ECU in the generated catalog.
// This avoids brittle hard-coded ids: if the upstream catalog shifts, the
// test simply re-derives a valid id from the data it actually has.
function pickNamedCanId() {
  for (const [name, ids] of Object.entries(ECU_TO_CAN_FROM_EXE)) {
    if (/^\d+$/.test(name)) continue;
    if (!Array.isArray(ids) || ids.length === 0) continue;
    return { name, canId: ids[0] };
  }
  throw new Error('no named ECU found in ECU_TO_CAN_FROM_EXE');
}

describe('resolver — resolveService (ISO 14229)', () => {
  it('resolves a known SID + sub-function to "Service / SubFunction"', () => {
    // 0x10 0x03 → DiagnosticSessionControl / extendedDiagnosticSession
    const r = resolveService([0x10, 0x03]);
    expect(r).not.toBeNull();
    expect(r.serviceName).toBe('DiagnosticSessionControl');
    expect(r.subFunctionName).toBeTruthy();
    expect(r.value).toBe(`${r.serviceName} / ${r.subFunctionName}`);
    expect(r.source).toBe(SOURCE_ISO14229);
  });

  it('masks the suppress-positive-response bit (0x80) on the sub-function', () => {
    // TesterPresent 0x3E with sub-function 0x80 (suppress) → "zeroSubFunction"
    const r = resolveService([0x3E, 0x80]);
    expect(r).not.toBeNull();
    expect(r.serviceName).toBe('TesterPresent');
    expect(r.subFunctionName).toBeTruthy();
  });

  it('resolves a SID with no sub-function decode (only service name)', () => {
    // 0x22 ReadDataByIdentifier — no enumerated sub-functions
    const r = resolveService([0x22, 0xF1, 0x90]);
    expect(r).not.toBeNull();
    expect(r.serviceName).toBe('ReadDataByIdentifier');
    expect(r.value).toBe('ReadDataByIdentifier');
  });

  it('returns null for an unknown SID', () => {
    expect(resolveService([0xA5, 0x00])).toBeNull();
  });

  it('returns null for negative responses (0x7F)', () => {
    expect(resolveService([0x7F, 0x27, 0x33])).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveService([])).toBeNull();
    expect(resolveService(null)).toBeNull();
  });
});

describe('resolver — resolveEcuName (AlfaOBD intel)', () => {
  it('resolves a known CAN-ID from the generated index', () => {
    const { name, canId } = pickNamedCanId();
    const r = resolveEcuName(canId);
    expect(r).not.toBeNull();
    expect(r.source).toBe(SOURCE_ALFAOBD);
    expect(r.candidates).toContain(name);
  });

  it('returns null for an unknown CAN-ID', () => {
    // 0xFFFFF is outside the 11-bit / 29-bit catalog and not present.
    expect(resolveEcuName(0xFFFFF)).toBeNull();
  });

  it('returns null when canId is null/undefined (bare-hex traces)', () => {
    expect(resolveEcuName(null)).toBeNull();
    expect(resolveEcuName(undefined)).toBeNull();
  });
});

describe('resolver — resolveRoutine (RoutineControl)', () => {
  it('resolves "31 01 02 0B …" via the dispatch+catalog', () => {
    // Known multi-routine dispatch key from the generated UDS_FRAME_TO_ROUTINES.
    const r = resolveRoutine([0x31, 0x01, 0x02, 0x0B]);
    expect(r).not.toBeNull();
    expect(r.ridLabel).toBe('0x020B');
    expect(r.source).toBe(SOURCE_ALFAOBD);
    expect(r.routineIds.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.value).toContain('0x020B');
  });

  it('falls back to a shorter dispatch prefix when the full key has no entry', () => {
    // "31 01 FF 00" is not a direct dispatch key, but "31 01" is.
    const r = resolveRoutine([0x31, 0x01, 0xFF, 0x00]);
    expect(r).not.toBeNull();
    expect(r.ridLabel).toBe('0xFF00');
    expect(r.matchedKey.startsWith('31 01')).toBe(true);
  });

  it('returns null for non-0x31 frames', () => {
    expect(resolveRoutine([0x22, 0xF1, 0x90])).toBeNull();
  });

  it('returns null when the RID bytes are missing (frame too short)', () => {
    expect(resolveRoutine([0x31, 0x01])).toBeNull();
  });
});

describe('resolver — resolveFrame + formatResolved', () => {
  it('aggregates all three fields and accepts either a line or a byte array', () => {
    const r = resolveFrame([0x10, 0x03]);
    expect(r.ecuName).toBeNull();
    expect(r.serviceLabel).not.toBeNull();
    expect(r.routineLabel).toBeNull();
    expect(formatResolved(r)).toContain('DiagnosticSessionControl');
  });

  it('returns empty string from formatResolved when nothing resolved', () => {
    const r = resolveFrame([0xA5, 0x00]); // unknown SID
    expect(r.serviceLabel).toBeNull();
    expect(formatResolved(r)).toBe('');
  });
});

describe('analyzeSession — resolved fields are attached to every exchange', () => {
  function analyze(lines) {
    const { lines: parsed } = parseTrace(lines.join('\n'));
    return analyzeSession(parsed);
  }

  it('decorates a Req/Resp fixture exchange with the ISO 14229 service label', () => {
    const { exchanges } = analyze(['[Req] 10 03', '[Resp] 50 03 00 19 01 F4']);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.resolved).toBeDefined();
    expect(ex.resolved.serviceLabel?.serviceName).toBe('DiagnosticSessionControl');
    expect(ex.resolved.serviceLabel?.source).toBe(SOURCE_ISO14229);
    // Req/Resp traces have no CAN-ID — ECU resolution is intentionally null.
    expect(ex.resolved.ecuName).toBeNull();
    expect(ex.resolvedText).toContain('DiagnosticSessionControl');
  });

  it('resolves ECU name + service from a candump line that carries a CAN-ID', () => {
    const { canId } = pickNamedCanId();
    const reqHex = canId.toString(16).toUpperCase().padStart(3, '0');
    // Build a SF request "10 03" on the picked CAN-ID. Use a matching resp id
    // (canId | 8) so the analyzer still gets a complete exchange to decorate.
    const respHex = (canId | 0x008).toString(16).toUpperCase().padStart(3, '0');
    const { exchanges } = analyze([
      `(0.000) can0 ${reqHex}#0210030000000000`,
      `(0.010) can0 ${respHex}#0250030019CCCCCC`,
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.resolved.ecuName).not.toBeNull();
    expect(ex.resolved.ecuName.source).toBe(SOURCE_ALFAOBD);
    expect(ex.resolved.serviceLabel?.serviceName).toBe('DiagnosticSessionControl');
  });

  it('resolves a RoutineControl exchange to a routine name with provenance', () => {
    const { exchanges } = analyze([
      '[Req] 31 01 02 0B',
      '[Resp] 71 01 02 0B 00',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.resolved.routineLabel).not.toBeNull();
    expect(ex.resolved.routineLabel.source).toBe(SOURCE_ALFAOBD);
    expect(ex.resolved.routineLabel.value).toContain('0x020B');
    expect(ex.resolvedText).toContain('0x020B');
  });

  it('gracefully marks unknown SID frames as fully unresolved', () => {
    const { exchanges } = analyze(['[Req] A5 00', '[Resp] E5 00']);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.resolved.ecuName).toBeNull();
    expect(ex.resolved.serviceLabel).toBeNull();
    expect(ex.resolved.routineLabel).toBeNull();
    expect(ex.resolvedText).toBe('');
  });

  it('attaches resolved fields to every exchange parsed from the bundled fixture', () => {
    const { lines } = parseTrace(FIXTURE);
    const { exchanges } = analyzeSession(lines);
    expect(exchanges.length).toBeGreaterThan(0);
    for (const ex of exchanges) {
      expect(ex).toHaveProperty('resolved');
      expect(ex).toHaveProperty('resolvedText');
      // Provenance tag invariant: every non-null field carries a known source.
      const allowed = new Set([SOURCE_ISO14229, SOURCE_ALFAOBD]);
      for (const key of ['ecuName', 'serviceLabel', 'routineLabel']) {
        const f = ex.resolved[key];
        if (f) expect(allowed.has(f.source)).toBe(true);
      }
    }
    // Fixture is Req/Resp, so at least one exchange must have an ISO service label.
    const withService = exchanges.find(e => e.resolved.serviceLabel);
    expect(withService).toBeDefined();
  });
});
