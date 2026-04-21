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
  deleteDiffReport,
  clearDiffReports,
  exportDiffReportPDF,
  buildDiffReportText,
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
