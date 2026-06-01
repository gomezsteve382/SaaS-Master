// @vitest-environment jsdom
import {describe, it, expect, beforeEach} from 'vitest';
import {
  PIN_ENCODINGS,
  PIN_ENCODING_ORDER,
  encodePin,
  resolveRfhubGeneration,
  resolvePinEncoding,
  RFHUB_PIN_GENERATIONS,
  pinAttemptStorageKey,
  readPinAttempts,
  writePinAttempts,
  incrementPinAttempts,
  resetPinAttempts,
  pinAttemptGate,
  planPinSends,
  MAX_PIN_ATTEMPTS,
  BLIND_MULTITRY_LIMIT,
} from '../rfhubPin.js';

const ALL_IDS = ['raw', 'bcd', 'ascii', 'none'];

describe('PIN encodings', () => {
  it('raw → one byte per digit', () => {
    expect(encodePin('1234', '1234')).toBeNull(); // wrong arg order guard
    expect(encodePin('raw', '1234')).toEqual([1, 2, 3, 4]);
    expect(encodePin('raw', '0009')).toEqual([0, 0, 0, 9]);
  });
  it('bcd → two packed nibble-pair bytes', () => {
    expect(encodePin('bcd', '1234')).toEqual([0x12, 0x34]);
    expect(encodePin('bcd', '9087')).toEqual([0x90, 0x87]);
  });
  it('ascii → one ASCII byte per digit', () => {
    expect(encodePin('ascii', '1234')).toEqual([0x31, 0x32, 0x33, 0x34]);
    expect(encodePin('ascii', '0000')).toEqual([0x30, 0x30, 0x30, 0x30]);
  });
  it('none → empty option record', () => {
    expect(encodePin('none', '1234')).toEqual([]);
  });
  it('unknown encoding id → null', () => {
    expect(encodePin('nope', '1234')).toBeNull();
  });
  it('exposes the four encodings and a stable try order', () => {
    expect(Object.keys(PIN_ENCODINGS).sort()).toEqual(['ascii', 'bcd', 'none', 'raw']);
    expect(PIN_ENCODING_ORDER).toEqual(['raw', 'bcd', 'ascii', 'none']);
  });
});

describe('resolveRfhubGeneration', () => {
  it('maps XC2268_RFHUB → XC2268 regardless of size', () => {
    expect(resolveRfhubGeneration({type: 'XC2268_RFHUB', size: 65536})).toBe('XC2268');
  });
  it('maps 2 KB RFHUB EEPROM → GEN1', () => {
    expect(resolveRfhubGeneration({type: 'RFHUB', size: 2048})).toBe('GEN1');
  });
  it('maps 4 KB / 8 KB RFHUB EEPROM → GEN2', () => {
    expect(resolveRfhubGeneration({type: 'RFHUB', size: 4096})).toBe('GEN2');
    expect(resolveRfhubGeneration({type: 'RFHUB', size: 8192})).toBe('GEN2');
  });
  it('falls back to data.length when size is absent', () => {
    expect(resolveRfhubGeneration({type: 'RFHUB', data: new Uint8Array(2048)})).toBe('GEN1');
  });
  it('returns null for an unrecognised RFHUB image size', () => {
    expect(resolveRfhubGeneration({type: 'RFHUB', size: 1024})).toBeNull();
  });
  it('returns null for a non-RFHUB module or empty input', () => {
    expect(resolveRfhubGeneration({type: 'BCM', size: 2048})).toBeNull();
    expect(resolveRfhubGeneration(null)).toBeNull();
    expect(resolveRfhubGeneration({})).toBeNull();
  });
});

describe('resolvePinEncoding', () => {
  it('Gen1 resolves to its recommended encoding, unverified', () => {
    const r = resolvePinEncoding({type: 'RFHUB', size: 2048});
    expect(r.generation).toBe('GEN1');
    expect(r.encodingId).toBe(RFHUB_PIN_GENERATIONS.GEN1.recommended);
    expect(r.encoding).toBe(PIN_ENCODINGS[r.encodingId]);
    expect(r.confidence).toBe('unverified');
    expect(r.candidates.length).toBeGreaterThan(0);
  });
  it('Gen2 resolves to its recommended encoding, unverified', () => {
    const r = resolvePinEncoding({type: 'RFHUB', size: 4096});
    expect(r.generation).toBe('GEN2');
    expect(r.encodingId).toBe(RFHUB_PIN_GENERATIONS.GEN2.recommended);
    expect(r.confidence).toBe('unverified');
  });
  it('XC2268 resolves to its recommended encoding, unverified', () => {
    const r = resolvePinEncoding({type: 'XC2268_RFHUB', size: 65536});
    expect(r.generation).toBe('XC2268');
    expect(r.encodingId).toBe(RFHUB_PIN_GENERATIONS.XC2268.recommended);
    expect(r.confidence).toBe('unverified');
  });
  it('unknown generation → null encoding, unknown confidence, forces manual choice', () => {
    const r = resolvePinEncoding({type: 'RFHUB', size: 999});
    expect(r.generation).toBeNull();
    expect(r.encodingId).toBeNull();
    expect(r.encoding).toBeNull();
    expect(r.confidence).toBe('unknown');
    // The blind fallback list is still offered (behind the manual gate).
    expect(r.candidates).toEqual(PIN_ENCODING_ORDER);
  });
  it('no module loaded → unknown', () => {
    const r = resolvePinEncoding(null);
    expect(r.generation).toBeNull();
    expect(r.confidence).toBe('unknown');
  });
  it('every generation entry is unverified (no bench PIN-burn data)', () => {
    for (const g of Object.values(RFHUB_PIN_GENERATIONS)) {
      expect(g.confidence).toBe('unverified');
      expect(PIN_ENCODINGS[g.recommended]).toBeTruthy();
    }
  });
});

describe('pinAttemptStorageKey', () => {
  it('prefers serial, then PN, then address', () => {
    expect(pinAttemptStorageKey({serial: 'SN1', pn: 'PN1', tx: 0x6A0})).toContain('sn:SN1');
    expect(pinAttemptStorageKey({pn: 'PN1', tx: 0x6A0})).toContain('pn:PN1');
    expect(pinAttemptStorageKey({tx: 0x6A0})).toContain('addr:6A0');
    expect(pinAttemptStorageKey({})).toContain('unknown');
  });
  it('different RFHUBs get different keys', () => {
    expect(pinAttemptStorageKey({serial: 'A'})).not.toBe(pinAttemptStorageKey({serial: 'B'}));
  });
});

describe('cumulative attempt counter (sessionStorage)', () => {
  beforeEach(() => {
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });
  it('reads 0 for an unseen key', () => {
    expect(readPinAttempts('srtlab:test:none')).toBe(0);
  });
  it('increments and persists', () => {
    const k = pinAttemptStorageKey({serial: 'COUNT'});
    expect(incrementPinAttempts(k)).toBe(1);
    expect(incrementPinAttempts(k)).toBe(2);
    expect(readPinAttempts(k)).toBe(2);
  });
  it('writePinAttempts sets an explicit value, reset clears it', () => {
    const k = pinAttemptStorageKey({serial: 'WRITE'});
    writePinAttempts(k, 2);
    expect(readPinAttempts(k)).toBe(2);
    resetPinAttempts(k);
    expect(readPinAttempts(k)).toBe(0);
  });
  it('keeps separate budgets per RFHUB', () => {
    const a = pinAttemptStorageKey({serial: 'AAA'});
    const b = pinAttemptStorageKey({serial: 'BBB'});
    incrementPinAttempts(a);
    expect(readPinAttempts(a)).toBe(1);
    expect(readPinAttempts(b)).toBe(0);
  });
});

describe('pinAttemptGate', () => {
  it('0 attempts: blind allowed, not critical, not locked', () => {
    const g = pinAttemptGate(0);
    expect(g.blindAllowed).toBe(true);
    expect(g.singleAllowed).toBe(true);
    expect(g.critical).toBe(false);
    expect(g.locked).toBe(false);
    expect(g.remaining).toBe(MAX_PIN_ATTEMPTS);
  });
  it('at the blind limit: blind disabled, becomes critical, single still allowed', () => {
    const g = pinAttemptGate(BLIND_MULTITRY_LIMIT);
    expect(g.blindAllowed).toBe(false);
    expect(g.singleAllowed).toBe(true);
    expect(g.critical).toBe(true);
    expect(g.locked).toBe(false);
  });
  it('one before the blind limit still allows blind multi-try', () => {
    const g = pinAttemptGate(BLIND_MULTITRY_LIMIT - 1);
    expect(g.blindAllowed).toBe(true);
    expect(g.critical).toBe(false);
  });
  it('at the hard ceiling: locked, nothing allowed', () => {
    const g = pinAttemptGate(MAX_PIN_ATTEMPTS);
    expect(g.locked).toBe(true);
    expect(g.blindAllowed).toBe(false);
    expect(g.singleAllowed).toBe(false);
    expect(g.remaining).toBe(0);
  });
  it('beyond the ceiling stays locked and clamps remaining at 0', () => {
    const g = pinAttemptGate(MAX_PIN_ATTEMPTS + 5);
    expect(g.locked).toBe(true);
    expect(g.remaining).toBe(0);
  });
  it('negative / garbage input is clamped to 0', () => {
    const g = pinAttemptGate(-3);
    expect(g.attempts).toBe(0);
    expect(g.blindAllowed).toBe(true);
  });
});

describe('planPinSends — the brick-prevention chokepoint', () => {
  it('single (deliberate) mode never plans more than one frame', () => {
    for (let a = 0; a < MAX_PIN_ATTEMPTS; a++) {
      const plan = planPinSends({ blind: false, currentAttempts: a, candidateIds: ['raw'] });
      expect(plan.length).toBeLessThanOrEqual(1);
    }
  });

  it('single mode plans the one chosen encoding while not locked', () => {
    expect(planPinSends({ blind: false, currentAttempts: 0, candidateIds: ['bcd'] })).toEqual(['bcd']);
    expect(planPinSends({ blind: false, currentAttempts: MAX_PIN_ATTEMPTS - 1, candidateIds: ['bcd'] })).toEqual(['bcd']);
  });

  it('single mode plans nothing once the hard ceiling is reached', () => {
    expect(planPinSends({ blind: false, currentAttempts: MAX_PIN_ATTEMPTS, candidateIds: ['raw'] })).toEqual([]);
    expect(planPinSends({ blind: false, currentAttempts: MAX_PIN_ATTEMPTS + 9, candidateIds: ['raw'] })).toEqual([]);
  });

  it('blind mode from zero is capped at the blind limit, NOT the full candidate list', () => {
    const plan = planPinSends({ blind: true, currentAttempts: 0, candidateIds: ALL_IDS });
    expect(plan.length).toBe(BLIND_MULTITRY_LIMIT);
    expect(plan).toEqual(ALL_IDS.slice(0, BLIND_MULTITRY_LIMIT));
  });

  it('blind mode shrinks as attempts accrue and stops at the blind limit', () => {
    expect(planPinSends({ blind: true, currentAttempts: BLIND_MULTITRY_LIMIT - 1, candidateIds: ALL_IDS }).length).toBe(1);
    expect(planPinSends({ blind: true, currentAttempts: BLIND_MULTITRY_LIMIT, candidateIds: ALL_IDS })).toEqual([]);
    expect(planPinSends({ blind: true, currentAttempts: MAX_PIN_ATTEMPTS, candidateIds: ALL_IDS })).toEqual([]);
  });

  it('INVARIANT: a plan can never push cumulative attempts to the brick ceiling', () => {
    for (let a = 0; a <= MAX_PIN_ATTEMPTS + 2; a++) {
      for (const blind of [false, true]) {
        const plan = planPinSends({ blind, currentAttempts: a, candidateIds: ALL_IDS });
        // every planned frame is a real attempt; the planner must never add
        // more frames than the remaining budget allows (so it can never reach
        // the brick ceiling, regardless of how high the starting count is)
        expect(plan.length).toBeLessThanOrEqual(Math.max(0, MAX_PIN_ATTEMPTS - a));
        if (blind) {
          // blind must never send more than the remaining blind budget, so it
          // always leaves room for a final deliberate single attempt
          expect(plan.length).toBeLessThanOrEqual(Math.max(0, BLIND_MULTITRY_LIMIT - a));
        }
      }
    }
  });

  it('filters out unknown / invalid encoding ids before planning', () => {
    const plan = planPinSends({ blind: true, currentAttempts: 0, candidateIds: ['bogus', 'raw', 'nope', 'bcd'] });
    expect(plan).toEqual(['raw', 'bcd']);
  });

  it('handles missing / malformed input without throwing', () => {
    expect(planPinSends()).toEqual([]);
    expect(planPinSends({ blind: false, currentAttempts: 0, candidateIds: null })).toEqual([]);
    expect(planPinSends({ blind: false, currentAttempts: -5, candidateIds: ['raw'] })).toEqual(['raw']);
  });
});
