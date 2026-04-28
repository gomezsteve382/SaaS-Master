/**
 * Task #464 — Best Pick scoring helper.
 *
 * Pins the score for a known canonical PN candidate (`68331185AA`)
 * so future regex tweaks don't silently change candidate ordering on
 * the Module Sync OS / PN / Serial breakdown line.
 */
import { describe, it, expect } from 'vitest';
import {
  countPrintable,
  scoreCandidate,
  pickBest,
  fmtPick,
  CANONICAL_PATTERNS,
} from '../lib/bestPick.js';

describe('countPrintable', () => {
  it('counts all printable-ASCII chars in a string', () => {
    expect(countPrintable('68331185AA')).toBe(10);
    expect(countPrintable('')).toBe(0);
  });
  it('handles a Uint8Array slice', () => {
    expect(countPrintable(new Uint8Array([0x36, 0x38, 0x00, 0xFF]))).toBe(2);
  });
  it('returns 0 for null / undefined', () => {
    expect(countPrintable(null)).toBe(0);
    expect(countPrintable(undefined)).toBe(0);
  });
});

describe('scoreCandidate — canonical 68331185AA PN (locked)', () => {
  const matches = CANONICAL_PATTERNS.pcmBodyPn.test('68331185AA');
  const b = scoreCandidate({
    value: '68331185AA',
    precedenceRank: 1.0,
    matchesCanonical: matches,
  });

  it('matches the canonical PCM body-PN regex', () => {
    expect(matches).toBe(true);
  });
  it('useful = 10 (all printable)',           () => expect(b.useful).toBe(10));
  it('ratio = 1.00 (whole string printable)', () => expect(b.ratio).toBeCloseTo(1.0, 5));
  it('len = 10',                              () => expect(b.len).toBe(10));
  it('pr = 1.00 (canonical offset)',          () => expect(b.pr).toBe(1.0));
  it('bonus = 100 (regex match)',             () => expect(b.bonus).toBe(100));
  it('score = 120 (locked)',                  () => expect(b.score).toBe(120));
});

describe('scoreCandidate — fallback regex hit ranks below canonical', () => {
  const fallback = scoreCandidate({
    value: '68331185AA', precedenceRank: 0.5, matchesCanonical: true,
  });
  it('drops below the canonical-offset score', () => {
    expect(fallback.score).toBeLessThan(120);
    expect(fallback.score).toBe(115); /* 10 + 10·0.5 + 100 */
  });
});

describe('scoreCandidate — non-canonical garbage', () => {
  const trash = scoreCandidate({
    value: '\x00\x01XX', precedenceRank: 0.5, matchesCanonical: false,
  });
  it('useful counts only the printable bytes', () => expect(trash.useful).toBe(2));
  it('ratio reflects the garbage prefix',      () => expect(trash.ratio).toBeCloseTo(0.5, 5));
  it('no bonus is awarded',                    () => expect(trash.bonus).toBe(0));
});

describe('pickBest — canonical hit beats fallback regex hit', () => {
  const { winner, ranked } = pickBest([
    { value: '68331185AA', precedenceRank: 1.0, matchesCanonical: true,  kind: 'pn-canonical' },
    { value: '68331185AA', precedenceRank: 0.5, matchesCanonical: true,  kind: 'pn-regex' },
    { value: '\x00garbage', precedenceRank: 0.5, matchesCanonical: false, kind: 'pn-fallback' },
  ]);
  it('winner is the canonical-offset hit', () => {
    expect(winner.kind).toBe('pn-canonical');
    expect(winner.score).toBe(120);
  });
  it('returns the full ranked list', () => {
    expect(ranked).toHaveLength(3);
    expect(ranked[0].kind).toBe('pn-canonical');
    expect(ranked[1].kind).toBe('pn-regex');
    expect(ranked[2].kind).toBe('pn-fallback');
  });
});

describe('pickBest — empty / non-array input', () => {
  it('returns null winner for empty list', () => {
    expect(pickBest([]).winner).toBeNull();
    expect(pickBest(null).winner).toBeNull();
    expect(pickBest(undefined).winner).toBeNull();
  });
});

describe('fmtPick — exact wording locked', () => {
  it('matches the SINCRO-style breakdown line', () => {
    const b = scoreCandidate({
      value: '68331185AA', precedenceRank: 1.0, matchesCanonical: true,
    });
    expect(fmtPick(b)).toBe(
      'PICK score 120 — useful 10, ratio 1.00, len 10, pr 1.00',
    );
  });
  it('returns empty string for null breakdown', () => {
    expect(fmtPick(null)).toBe('');
  });
});
