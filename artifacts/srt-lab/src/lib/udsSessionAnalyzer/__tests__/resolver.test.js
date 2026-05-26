import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  resolveEcuName,
  resolveRoutine,
  resolveFrame,
  SOURCE_ALFAOBD,
} from '../resolver.js';
import { parseTrace } from '../parser.js';
import { analyzeSession } from '../analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('udsSessionAnalyzer/resolver — ECU reverse lookup', () => {
  it('resolves 0x600 (Radio Frequency HUB CAN ID) to the descriptive ECU name', () => {
    const r = resolveEcuName(0x600);
    expect(r).toBeTruthy();
    expect(r.source).toBe(SOURCE_ALFAOBD);
    expect(r.candidates).toContain('Radio Frequency HUB');
    expect(r.value).toContain('Radio Frequency HUB');
  });

  it('returns a single-candidate result for a CAN ID with one descriptive ECU mapping', () => {
    const r = resolveEcuName(0x74C);
    expect(r).toBeTruthy();
    expect(r.candidates).toEqual(['AEB - P']);
    expect(r.value).toBe('AEB - P');
  });

  it('returns multiple candidates for a multi-ECU CAN ID', () => {
    // 0x149 (329) maps to many descriptive names: TIPM_CGW, Memory Seat
    // module, MSM_PN, Rear Right Door Module, Radio Navigator (EP), …
    const r = resolveEcuName(0x149);
    expect(r).toBeTruthy();
    expect(Array.isArray(r.candidates)).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(1);
    // Composite value joins the candidates with ' / '.
    expect(r.value).toContain(' / ');
  });

  it('returns null for an unknown CAN ID', () => {
    expect(resolveEcuName(0x7E0)).toBeNull();
    expect(resolveEcuName(0xABCDEF)).toBeNull();
    expect(resolveEcuName(null)).toBeNull();
    expect(resolveEcuName(undefined)).toBeNull();
  });
});

describe('udsSessionAnalyzer/resolver — routine resolution', () => {
  it('resolves a known 4-byte RoutineControl dispatch frame', () => {
    // "31 01 02 0B" is a known dispatch frame in the catalog.
    const r = resolveRoutine([0x31, 0x01, 0x02, 0x0B]);
    expect(r).toBeTruthy();
    expect(r.source).toBe(SOURCE_ALFAOBD);
    expect(r.value).toBeTruthy();
    expect(r.ridLabel).toBe('0x020B');
    expect(Array.isArray(r.routineIds)).toBe(true);
    expect(r.routineIds.length).toBeGreaterThan(0);
  });

  it('resolves the longest matching prefix for a routine request', () => {
    // "31 01 02 0B 07" is a known more-specific dispatch frame that
    // resolves to routine 1013; a 5-byte request with an extra trailing
    // byte should still match against the 5-byte prefix.
    const r = resolveRoutine([0x31, 0x01, 0x02, 0x0B, 0x07]);
    expect(r).toBeTruthy();
    expect(r.matchedKey).toBe('31 01 02 0B 07');
    expect(r.routineIds).toContain(1013);
    expect(r.value).toMatch(/^0x[0-9A-F]{4}/);
  });

  it('returns null for empty, non-routine, or unmatched requests', () => {
    expect(resolveRoutine([])).toBeNull();
    // Non-0x31 SID — resolveRoutine is RoutineControl-only.
    expect(resolveRoutine([0x10, 0x03])).toBeNull();
    // A routine sub-function that is not present in UDS_FRAME_TO_ROUTINES.
    expect(resolveRoutine([0x31, 0xFE, 0xFE, 0xFE])).toBeNull();
  });
});

describe('udsSessionAnalyzer/resolver — resolveFrame aggregate', () => {
  it('resolves a parsed frame with canId 0x600 + RoutineControl request', () => {
    const r = resolveFrame({ canId: 0x600, bytes: [0x31, 0x01, 0x02, 0x0B, 0x01] });
    expect(r.ecuName).toBeTruthy();
    expect(r.ecuName.candidates).toContain('Radio Frequency HUB');
    expect(r.ecuName.source).toBe(SOURCE_ALFAOBD);
    expect(r.routineLabel).toBeTruthy();
    expect(r.routineLabel.source).toBe(SOURCE_ALFAOBD);
    expect(r.routineLabel.routineIds.length).toBeGreaterThan(0);
  });

  it('returns null fields for an unresolvable frame', () => {
    const r = resolveFrame({ canId: 0x7E0, bytes: [0xFE, 0xFE] });
    expect(r.ecuName).toBeNull();
    expect(r.routineLabel).toBeNull();
  });

  it('accepts a bare byte array (no canId) and still resolves the routine', () => {
    const r = resolveFrame([0x31, 0x01, 0x02, 0x0B]);
    expect(r.ecuName).toBeNull();
    expect(r.routineLabel).toBeTruthy();
  });
});

describe('udsSessionAnalyzer/resolver — fixture integration', () => {
  it('decorates every exchange from example_session.log via resolveFrame', () => {
    const fixturePath = resolve(__dirname, '..', 'fixtures', 'example_session.log');
    const text = readFileSync(fixturePath, 'utf8');
    const parsed = parseTrace(text);
    expect(parsed.lines.length).toBeGreaterThan(0);

    const session = analyzeSession(parsed.lines);
    expect(session.exchanges.length).toBeGreaterThan(0);

    // Decorate each exchange's request frame without mutating the input.
    const decorated = session.exchanges
      .filter(ex => ex.request)
      .map(ex => resolveFrame(ex.request));

    for (const r of decorated) {
      expect(r).toHaveProperty('ecuName');
      expect(r).toHaveProperty('serviceLabel');
      expect(r).toHaveProperty('routineLabel');
    }

    // The fixture contains "31 01 FF 00" (RoutineControl) — at least one
    // request resolves to a routineLabel, or — if that specific frame is
    // not in the dispatch catalog — at least one resolves to a service
    // label (e.g. 0x10 DiagnosticSessionControl).
    const anyServiceLabel = decorated.some(r => r.serviceLabel);
    expect(anyServiceLabel).toBe(true);
  });
});
