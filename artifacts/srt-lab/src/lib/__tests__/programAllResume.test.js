import { describe, it, expect } from 'vitest';
import {
  reconstructBatchResults,
  selectedTxList,
  isJobResumable,
  computeResumeCounts,
} from '../programAllResume.js';

// Helper: build an append-only event log NEWEST-FIRST (as the API returns it).
function ev(kind, payload) {
  return { kind, payload };
}

describe('reconstructBatchResults', () => {
  it('returns {} for non-array / empty input', () => {
    expect(reconstructBatchResults(null)).toEqual({});
    expect(reconstructBatchResults(undefined)).toEqual({});
    expect(reconstructBatchResults([])).toEqual({});
  });

  it('ignores non-module.* events (e.g. batch.completed)', () => {
    const out = reconstructBatchResults([
      ev('batch.completed', { vin: 'X' }),
      ev('module.ok', { tx: 1810, status: 'ok' }),
    ]);
    expect(Object.keys(out)).toEqual(['1810']);
    expect(out[1810].status).toBe('ok');
  });

  it('newest event per tx wins (events arrive newest-first)', () => {
    // tx 1810 was 'fail' then later retried 'ok' — newest (ok) is listed first.
    const out = reconstructBatchResults([
      ev('module.ok', { tx: 1810, status: 'ok', unlockAlgo: 'cda6' }),
      ev('module.fail', { tx: 1810, status: 'fail', reason: 'NRC 0x35' }),
    ]);
    expect(out[1810].status).toBe('ok');
    expect(out[1810].unlockAlgo).toBe('cda6');
  });

  it('falls back to kind suffix when payload.status is missing', () => {
    const out = reconstructBatchResults([ev('module.skipped', { tx: 2023 })]);
    expect(out[2023].status).toBe('skipped');
  });

  it('drops events with no tx', () => {
    const out = reconstructBatchResults([ev('module.ok', { status: 'ok' })]);
    expect(out).toEqual({});
  });
});

describe('selectedTxList', () => {
  it('returns only truthy-selected tx keys', () => {
    // Numeric object keys iterate in ascending order, so 1809 precedes 1810.
    expect(selectedTxList({ 1810: true, 2023: false, 1809: true })).toEqual(['1809', '1810']);
  });
  it('handles missing / non-object selection', () => {
    expect(selectedTxList(null)).toEqual([]);
    expect(selectedTxList(undefined)).toEqual([]);
  });
});

describe('isJobResumable', () => {
  const selection = { 1810: true, 2023: true, 1809: true }; // 3 selected

  it('(a) partial SUCCESS-only interruption is resumable', () => {
    // Only 1 of 3 selected modules has been written ok; the rest were never
    // attempted, so prior has no non-ok rows at all. Must still resume.
    const prior = { 1810: { status: 'ok' } };
    expect(isJobResumable(prior, selection)).toBe(true);
    // and the count reflects the 2 never-attempted modules:
    expect(computeResumeCounts(prior, selection).toRetry).toBe(2);
  });

  it('(b) partial FAIL interruption is resumable', () => {
    const prior = { 1810: { status: 'ok' }, 2023: { status: 'fail' } };
    expect(isJobResumable(prior, selection)).toBe(true);
  });

  it('(c) all selected modules ok (not archived) is NOT resumable', () => {
    const prior = {
      1810: { status: 'ok' }, 2023: { status: 'ok' }, 1809: { status: 'ok' },
    };
    expect(isJobResumable(prior, selection)).toBe(false);
    expect(computeResumeCounts(prior, selection).toRetry).toBe(0);
  });

  it('legacy job without saved selection: resumable iff any prior events exist', () => {
    expect(isJobResumable({ 1810: { status: 'ok' } }, undefined)).toBe(true);
    expect(isJobResumable({}, undefined)).toBe(false);
  });
});

describe('computeResumeCounts', () => {
  it('tallies each status and derives toRetry from the selection', () => {
    const selection = { 1: true, 2: true, 3: true, 4: true };
    const prior = {
      1: { status: 'ok' },
      2: { status: 'fail' },
      3: { status: 'skipped' },
      // tx 4 never attempted
    };
    const c = computeResumeCounts(prior, selection);
    expect(c.ok).toBe(1);
    expect(c.fail).toBe(1);
    expect(c.skipped).toBe(1);
    // 4 selected - 1 ok = 3 still to do (fail + skipped + never-attempted)
    expect(c.toRetry).toBe(3);
  });

  it('falls back to recorded non-ok count without a selection', () => {
    const prior = { 1: { status: 'ok' }, 2: { status: 'fail' }, 3: { status: 'pending' } };
    const c = computeResumeCounts(prior, undefined);
    expect(c.toRetry).toBe(2);
  });

  it('buckets unknown statuses under other', () => {
    const c = computeResumeCounts({ 1: { status: 'weird' } }, undefined);
    expect(c.other).toBe(1);
    expect(c.toRetry).toBe(1);
  });
});
