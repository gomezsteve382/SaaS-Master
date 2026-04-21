import { describe, it, expect, beforeEach, vi } from 'vitest';

// vitest is configured for the node environment, which has no localStorage.
// Provide a tiny in-memory shim before the SUT module is imported.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i) => Array.from(store.keys())[i] || null,
    get length() { return store.size; },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

// Stub out the PDF builder so we don't need jspdf in unit tests; we still
// assert it's invoked with the right arguments when re-rendering a report.
const buildOnePagerPDFMock = vi.fn(async () => {});
vi.mock('../buildOnePagerPDF.js', () => ({
  buildOnePagerPDF: (...args) => buildOnePagerPDFMock(...args),
}));

import {
  saveDiffReport,
  listDiffReports,
  getDiffReport,
  getDiffReportAsync,
  deleteDiffReport,
  clearDiffReports,
  refreshDiffReportsFromServer,
  exportDiffReportPDF,
  buildDiffReportText,
  reassignDiffReportAuthor,
  reassignUnknownDiffReports,
} from '../diffReports.js';

const sampleBaseline = () => ({
  label: 'My RO 12345',
  ts: 1700000000000,
  modules: [
    { code: 'BCM', name: 'Body Control', tx: 0x750, rx: 0x758, vin: '1ABCD23EFGH456789' },
    { code: 'ECM', name: 'Engine', tx: 0x7e0, rx: 0x7e8, vin: '1ABCD23EFGH456789' },
  ],
});
const sampleCurrent = () => ({
  ts: 1700000900000,
  modules: [
    { code: 'BCM', name: 'Body Control', tx: 0x750, rx: 0x758, vin: 'NEWVINXYZ12345678' },
    { code: 'RFHUB', name: 'RF Hub', tx: 0x7a0, rx: 0x7a8, vin: 'NEWVINXYZ12345678' },
  ],
});
const sampleDiff = () => ({
  added: [{ code: 'RFHUB', name: 'RF Hub', tx: 0x7a0, rx: 0x7a8, vin: 'NEWVINXYZ12345678' }],
  removed: [{ code: 'ECM', name: 'Engine', tx: 0x7e0, rx: 0x7e8, vin: '1ABCD23EFGH456789' }],
  changed: [{
    baseline: { code: 'BCM', name: 'Body Control', tx: 0x750, rx: 0x758, vin: '1ABCD23EFGH456789' },
    current:  { code: 'BCM', name: 'Body Control', tx: 0x750, rx: 0x758, vin: 'NEWVINXYZ12345678' },
  }],
  same: [],
});

beforeEach(() => {
  localStorage.clear();
  buildOnePagerPDFMock.mockClear();
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
});

describe('diffReports persistence', () => {
  it('saveDiffReport writes a payload + index entry with denormalized counts', () => {
    const meta = saveDiffReport({
      baseline: sampleBaseline(),
      current: sampleCurrent(),
      diff: sampleDiff(),
    });
    expect(meta).toBeTruthy();
    expect(meta.id).toMatch(/^d_/);
    expect(meta.baselineLabel).toBe('My RO 12345');
    expect(meta.baselineModuleCount).toBe(2);
    expect(meta.currentModuleCount).toBe(2);
    expect(meta.addedCount).toBe(1);
    expect(meta.removedCount).toBe(1);
    expect(meta.changedCount).toBe(1);
    expect(meta.sameCount).toBe(0);

    const list = listDiffReports();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(meta.id);

    const full = getDiffReport(meta.id);
    expect(full).toBeTruthy();
    expect(full.baseline.modules).toHaveLength(2);
    expect(full.current.modules).toHaveLength(2);
    expect(full.diff.added[0].code).toBe('RFHUB');
    expect(full.diff.removed[0].code).toBe('ECM');
    expect(full.diff.changed[0].current.vin).toBe('NEWVINXYZ12345678');
  });

  it('newest report appears first in the list', async () => {
    const a = saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    await new Promise(r => setTimeout(r, 5));
    const b = saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    const list = listDiffReports();
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it('deleteDiffReport removes both meta and payload', () => {
    const meta = saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    deleteDiffReport(meta.id);
    expect(listDiffReports()).toHaveLength(0);
    expect(getDiffReport(meta.id)).toBeNull();
  });

  it('clearDiffReports drops every saved report', () => {
    saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    expect(listDiffReports()).toHaveLength(2);
    clearDiffReports();
    expect(listDiffReports()).toHaveLength(0);
  });
});

describe('diffReports rendering', () => {
  it('exportDiffReportPDF invokes the PDF builder with intro + sections', async () => {
    await exportDiffReportPDF(sampleBaseline(), sampleCurrent(), sampleDiff());
    expect(buildOnePagerPDFMock).toHaveBeenCalledTimes(1);
    const cfg = buildOnePagerPDFMock.mock.calls[0][0];
    expect(cfg.title).toMatch(/DIFF/);
    expect(cfg.filename).toMatch(/SRT_Lab_Diff_Report_/);
    const labels = cfg.sections.map((s) => s.label);
    expect(labels.some((l) => l.startsWith('+ ADDED'))).toBe(true);
    expect(labels.some((l) => l.startsWith('- REMOVED'))).toBe(true);
    expect(labels.some((l) => l.startsWith('+/- CHANGED'))).toBe(true);
  });

  it('buildDiffReportText reports a no-diff message when nothing changed', () => {
    const txt = buildDiffReportText(
      sampleBaseline(), sampleCurrent(),
      { added: [], removed: [], changed: [], same: [{ code: 'BCM' }, { code: 'ECM' }] },
    );
    expect(txt).toMatch(/No differences/);
    expect(txt).toMatch(/2 modules unchanged/);
  });

  it('saveDiffReport tags the report with the configured tech from localStorage', () => {
    localStorage.setItem('srtlab_tech', 'Jordan M.');
    const meta = saveDiffReport({
      baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff(),
    });
    expect(meta.author).toBe('Jordan M.');
    expect(listDiffReports()[0].author).toBe('Jordan M.');
    const full = getDiffReport(meta.id);
    expect(full.author).toBe('Jordan M.');
  });

  it('saveDiffReport accepts an explicit author that overrides the stored tech', () => {
    localStorage.setItem('srtlab_tech', 'Jordan M.');
    const meta = saveDiffReport({
      baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff(),
      author: '  Alex Bench  ',
    });
    expect(meta.author).toBe('Alex Bench');
  });

  it('saveDiffReport leaves author null when no tech is configured', () => {
    const meta = saveDiffReport({
      baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff(),
    });
    expect(meta.author).toBeNull();
  });

  it('saveDiffReport mirrors the report to /api/diff-reports', async () => {
    localStorage.setItem('srtlab_tech', 'Jordan M.');
    saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    // Microtask flush so the fire-and-forget fetch is observed.
    await new Promise((r) => setTimeout(r, 0));
    const calls = globalThis.fetch.mock.calls.filter(([url]) => url === '/api/diff-reports');
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(calls[0][1].body);
    expect(body.id).toMatch(/^d_/);
    expect(body.baselineLabel).toBe('My RO 12345');
    expect(body.addedCount).toBe(1);
    expect(body.payload.diff.removed[0].code).toBe('ECM');
    expect(body.author).toBe('Jordan M.');
  });

  it('refreshDiffReportsFromServer overwrites the local index with the server list', async () => {
    const serverRow = {
      id: 'd_server_xyz',
      generatedAt: 1700001000000,
      baselineLabel: 'Other Tech',
      baselineTs: 1700000000000,
      baselineModuleCount: 3,
      currentTs: 1700000900000,
      currentModuleCount: 4,
      addedCount: 1, removedCount: 0, changedCount: 2, sameCount: 2,
    };
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/diff-reports') {
        return { ok: true, json: async () => ({ reports: [serverRow] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    const list = await refreshDiffReportsFromServer();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('d_server_xyz');
    expect(listDiffReports()[0].baselineLabel).toBe('Other Tech');
  });

  it('getDiffReportAsync falls back to a server fetch when the local cache is empty', async () => {
    const payload = {
      id: 'd_remote_1',
      generatedAt: 1700002000000,
      baseline: { label: 'remote', ts: 1700000000000, modules: [] },
      current: { ts: 1700001000000, modules: [] },
      diff: { added: [], removed: [], changed: [], same: [] },
    };
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/diff-reports/d_remote_1') {
        return { ok: true, status: 200, json: async () => ({ id: 'd_remote_1', payload }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    expect(getDiffReport('d_remote_1')).toBeNull();
    const fetched = await getDiffReportAsync('d_remote_1');
    expect(fetched.status).toBe('found');
    expect(fetched.payload.baseline.label).toBe('remote');
    // Should now be cached locally.
    expect(getDiffReport('d_remote_1')).toBeTruthy();
  });

  it('getDiffReportAsync reports "missing" only on a confirmed 404, "unknown" on transient failures', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const gone = await getDiffReportAsync('d_gone');
    expect(gone.status).toBe('missing');

    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    const offline = await getDiffReportAsync('d_offline');
    expect(offline.status).toBe('unknown');

    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const flaky = await getDiffReportAsync('d_flaky');
    expect(flaky.status).toBe('unknown');
  });

  it('refreshDiffReportsFromServer leaves the migration marker unset when a POST fails so it retries next time', async () => {
    // Pre-seed a local-only report.
    saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    // Server returns empty list AND fails every migration POST.
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (url === '/api/diff-reports' && (!opts || opts.method !== 'POST')) {
        return { ok: true, status: 200, json: async () => ({ reports: [] }) };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    });
    await refreshDiffReportsFromServer();
    expect(localStorage.getItem('srtlab_diff_reports_migrated_v1')).toBeNull();
  });

  it('deleteDiffReport sends a DELETE to the API', async () => {
    const meta = saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    globalThis.fetch.mockClear();
    deleteDiffReport(meta.id);
    const delCall = globalThis.fetch.mock.calls.find(
      ([url, opts]) => url === '/api/diff-reports/' + encodeURIComponent(meta.id) && opts?.method === 'DELETE',
    );
    expect(delCall).toBeTruthy();
  });

  it('reassignDiffReportAuthor updates a report tagged unknown to the given name', async () => {
    const meta = saveDiffReport({
      baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff(),
    });
    expect(meta.author).toBeNull();

    globalThis.fetch.mockClear();
    const r = await reassignDiffReportAuthor(meta.id, '  Jordan M.  ');
    expect(r.ok).toBe(true);
    expect(r.status).toBe('updated');

    const list = listDiffReports();
    expect(list[0].author).toBe('Jordan M.');
    expect(getDiffReport(meta.id).author).toBe('Jordan M.');

    const postCall = globalThis.fetch.mock.calls.find(
      ([url, opts]) => url === '/api/diff-reports' && opts?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall[1].body);
    expect(body.id).toBe(meta.id);
    expect(body.author).toBe('Jordan M.');
    expect(body.payload.author).toBe('Jordan M.');
  });

  it('reassignDiffReportAuthor rejects empty/whitespace names', async () => {
    const meta = saveDiffReport({
      baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff(),
    });
    const r = await reassignDiffReportAuthor(meta.id, '   ');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('empty-name');
    expect(listDiffReports()[0].author).toBeNull();
  });

  it('reassignUnknownDiffReports only touches rows tagged unknown', async () => {
    const a = saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    localStorage.setItem('srtlab_tech', 'Already Set');
    const b = saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });
    localStorage.removeItem('srtlab_tech');
    const c = saveDiffReport({ baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff() });

    expect(listDiffReports().filter((m) => !m.author)).toHaveLength(2);

    const result = await reassignUnknownDiffReports('Alex Bench');
    expect(result.updatedCount).toBe(2);
    expect(result.failed).toEqual([]);

    const byId = Object.fromEntries(listDiffReports().map((m) => [m.id, m.author]));
    expect(byId[a.id]).toBe('Alex Bench');
    expect(byId[b.id]).toBe('Already Set');
    expect(byId[c.id]).toBe('Alex Bench');
  });

  it('saved reports survive a round-trip through the PDF rebuilder', async () => {
    const meta = saveDiffReport({
      baseline: sampleBaseline(), current: sampleCurrent(), diff: sampleDiff(),
    });
    const full = getDiffReport(meta.id);
    await exportDiffReportPDF(full.baseline, full.current, full.diff);
    expect(buildOnePagerPDFMock).toHaveBeenCalledTimes(1);
    const cfg = buildOnePagerPDFMock.mock.calls[0][0];
    // Intro lines should preserve module counts from the snapshot.
    expect(cfg.intro.join(' ')).toMatch(/2 modules.*2 modules/);
  });
});
