import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { resolveExchange, resolveSession, resolveEcuName, resolveRoutine } from '../resolver.js';
import { parseTrace } from '../parser.js';
import { analyzeSession } from '../analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('udsSessionAnalyzer/resolver — ECU reverse lookup', () => {
  it('resolves 0x600 (Radio Frequency HUB CAN ID) to the descriptive ECU name', () => {
    const name = resolveEcuName(0x600);
    if (Array.isArray(name)) {
      expect(name).toContain('Radio Frequency HUB');
    } else {
      expect(name).toBe('Radio Frequency HUB');
    }
  });

  it('returns a single string for a CAN ID with one descriptive ECU mapping', () => {
    // 0x74C → "AEB - P" is the sole mapping.
    const name = resolveEcuName(0x74C);
    expect(typeof name).toBe('string');
    expect(name).toBe('AEB - P');
  });

  it('returns an array for a multi-ECU CAN ID', () => {
    // 0x149 (329) maps to many descriptive names: TIPM_CGW, Memory Seat
    // module, MSM_PN, Rear Right Door Module, Radio Navigator (EP), …
    const name = resolveEcuName(0x149);
    expect(Array.isArray(name)).toBe(true);
    expect(name.length).toBeGreaterThan(1);
  });

  it('returns null for an unknown CAN ID', () => {
    expect(resolveEcuName(0x7E0)).toBeNull();
    expect(resolveEcuName(0xABCDEF)).toBeNull();
  });
});

describe('udsSessionAnalyzer/resolver — routine resolution', () => {
  it('resolves a 2-byte SID prefix that exists in UDS_FRAME_TO_ROUTINES', () => {
    // "10 03" is a known dispatch frame in the catalog.
    const { routineLabel, routineCandidates } = resolveRoutine([0x10, 0x03]);
    expect(routineLabel).toBeTruthy();
    expect(routineCandidates).toBeTruthy();
    expect(routineCandidates.length).toBeGreaterThan(0);
    expect(routineCandidates[0]).toHaveProperty('rid');
  });

  it('resolves the longest matching prefix for a routine request', () => {
    // "31 01 02 0B" is a known multi-routine dispatch frame.
    const { routineLabel, routineCandidates } = resolveRoutine([0x31, 0x01, 0x02, 0x0B, 0x07]);
    expect(routineLabel).toBeTruthy();
    expect(routineCandidates).toBeTruthy();
    // The 5-byte prefix "31 01 02 0B 07" hits a more specific 1013 entry;
    // either way the resolver must produce at least one candidate RID.
    expect(routineCandidates.length).toBeGreaterThan(0);
    expect(routineLabel).toMatch(/^0x[0-9A-F]{4}/);
  });

  it('returns null routineLabel for an empty or unmatched request', () => {
    expect(resolveRoutine([]).routineLabel).toBeNull();
    // A SID that is not present in UDS_FRAME_TO_ROUTINES at all.
    expect(resolveRoutine([0xFE, 0xFE, 0xFE]).routineLabel).toBeNull();
  });
});

describe('udsSessionAnalyzer/resolver — resolveExchange', () => {
  it('resolves a parsed exchange with canId 0x600 + RoutineControl request', () => {
    const exchange = {
      request: { canId: 0x600, bytes: [0x31, 0x01, 0x02, 0x0B, 0x01] },
      response: null,
    };
    const r = resolveExchange(exchange);
    const ecu = r.ecuName;
    if (Array.isArray(ecu)) {
      expect(ecu).toContain('Radio Frequency HUB');
    } else {
      expect(ecu).toBe('Radio Frequency HUB');
    }
    expect(r.ecuSource).toBe('alfaobd-il');
    expect(r.routineLabel).toBeTruthy();
    expect(r.routineSource).toBe('alfaobd-il');
    expect(r.routineCandidates.length).toBeGreaterThan(0);
  });

  it('returns null fields and null sources for an unresolvable exchange', () => {
    const exchange = {
      request: { canId: 0x7E0, bytes: [0xFE, 0xFE] },
      response: null,
    };
    const r = resolveExchange(exchange);
    expect(r.ecuName).toBeNull();
    expect(r.ecuSource).toBeNull();
    expect(r.routineLabel).toBeNull();
    expect(r.routineSource).toBeNull();
  });
});

describe('udsSessionAnalyzer/resolver — resolveSession integration', () => {
  it('decorates exchanges from example_session.log without mutating the input', () => {
    const fixturePath = resolve(__dirname, '..', 'fixtures', 'example_session.log');
    const text = readFileSync(fixturePath, 'utf8');
    const parsed = parseTrace(text);
    expect(parsed.lines.length).toBeGreaterThan(0);

    const session = analyzeSession(parsed.lines);
    expect(session.exchanges.length).toBeGreaterThan(0);

    const before = session.exchanges.map(e => e.resolved);
    const enriched = resolveSession(session);

    // Input not mutated.
    expect(before.every(v => v === undefined)).toBe(true);
    expect(enriched).not.toBe(session);
    expect(enriched.exchanges).not.toBe(session.exchanges);

    // Every exchange gets a `.resolved` field with the expected shape.
    for (const ex of enriched.exchanges) {
      expect(ex.resolved).toBeTruthy();
      expect(ex.resolved).toHaveProperty('ecuName');
      expect(ex.resolved).toHaveProperty('ecuSource');
      expect(ex.resolved).toHaveProperty('routineLabel');
      expect(ex.resolved).toHaveProperty('routineCandidates');
      expect(ex.resolved).toHaveProperty('routineSource');
    }

    // At least one exchange in the fixture resolves to a routine label
    // (the "10 03" extended-session request hits UDS_FRAME_TO_ROUTINES).
    const anyRoutine = enriched.exchanges.some(e => e.resolved.routineLabel);
    expect(anyRoutine).toBe(true);
  });
});
