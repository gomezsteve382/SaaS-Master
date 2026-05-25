import { describe, test, expect } from 'vitest';
import { buildModuleReportData, buildJobReportData, fmtFilenameTs } from '../lib/reportData.js';

// ── fmtFilenameTs ─────────────────────────────────────────────────────────────

describe('fmtFilenameTs', () => {
  test('formats a known Date to YYYYMMDD-HHmm', () => {
    const d = new Date('2026-05-25T14:35:00.000Z');
    const result = fmtFilenameTs(d);
    expect(result).toMatch(/^\d{8}-\d{4}$/);
    expect(result).toContain('20260525');
  });

  test('formats an ISO string', () => {
    const result = fmtFilenameTs('2026-01-02T10:05:00.000Z');
    expect(result).toMatch(/^\d{8}-\d{4}$/);
    expect(result).toContain('20260102');
  });

  test('returns "unknown" for null', () => {
    expect(fmtFilenameTs(null)).toBe('unknown');
  });

  test('returns "unknown" for an invalid date string', () => {
    expect(fmtFilenameTs('not-a-date')).toBe('unknown');
  });
});

// ── buildModuleReportData ─────────────────────────────────────────────────────

const SAMPLE_MOD = {
  type: 'GPEC2A',
  name: 'GPEC2A',
  filename: 'gpec2a_backup.bin',
  size: 4096,
  color: '#00BFA5',
  vins: [{ offset: 0x0100, vin: '1C4RJFBT8KC123456' }],
  skimByte: 0x80,
  skimStatus: 'ENABLED',
  secretKey: { offset: 0x0203, hex: 'DEADBEEFCAFEBABE', },
  keyConsistent: true,
  zzzzTamper: { offset: 0x0888, hex: '5A5A5A5A', intact: true },
  data: new Uint8Array(4096),
};

describe('buildModuleReportData', () => {
  test('throws when mod is null', () => {
    expect(() => buildModuleReportData(null)).toThrow('mod is required');
  });

  test('returns kind=module', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    expect(r.kind).toBe('module');
  });

  test('filename follows srtlab-{vin}-{YYYYMMDD-HHmm}.pdf pattern', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    expect(r.filename).toMatch(/^srtlab-1C4RJFBT8KC123456-\d{8}-\d{4}\.pdf$/);
  });

  test('extracts VIN from vins array', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    expect(r.vin).toBe('1C4RJFBT8KC123456');
    expect(r.vins).toEqual(['1C4RJFBT8KC123456']);
  });

  test('title is human-readable type name', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    expect(r.title).toBe('GPEC2A');
  });

  test('fields includes VIN row', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    const vinRow = r.fields.find(f => f.category === 'VIN 1');
    expect(vinRow).toBeDefined();
    expect(vinRow.value).toBe('1C4RJFBT8KC123456');
    expect(vinRow.offset).toBe('0x0100');
  });

  test('fields includes SKIM row', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    const skimRow = r.fields.find(f => f.category === 'SKIM');
    expect(skimRow).toBeDefined();
    expect(skimRow.offset).toBe('0x0011');
    expect(skimRow.value).toContain('0x80');
    expect(skimRow.value).toContain('ENABLED');
  });

  test('fields includes SECRET KEY row', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    const secRow = r.fields.find(f => f.category === 'SECRET KEY');
    expect(secRow).toBeDefined();
    expect(secRow.value).toBe('DEADBEEFCAFEBABE');
    expect(secRow.detail).toContain('consistent');
  });

  test('fields includes TAMPER row', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    const t = r.fields.find(f => f.category === 'TAMPER');
    expect(t).toBeDefined();
    expect(t.value).toContain('INTACT');
  });

  test('hasSecrets is true when secretKey present', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    expect(r.hasSecrets).toBe(true);
  });

  test('hasSecrets is false when no secret fields', () => {
    const minimal = {
      type: 'BCM',
      filename: 'bcm.bin',
      size: 65536,
      vins: [],
      data: new Uint8Array(65536),
    };
    const r = buildModuleReportData(minimal);
    expect(r.hasSecrets).toBe(false);
  });

  test('warnings is empty when no sizeWarn or contentWarn', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    expect(r.warnings).toEqual([]);
  });

  test('warnings includes sizeWarn message', () => {
    const mod = { ...SAMPLE_MOD, sizeWarn: { msg: 'Padded capture: only first 4096 bytes are real' } };
    const r = buildModuleReportData(mod);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('Padded capture');
  });

  test('warnings includes contentWarn message', () => {
    const mod = { ...SAMPLE_MOD, contentWarn: { msg: 'No BCM VINs found — may not be a real BCM dump' } };
    const r = buildModuleReportData(mod);
    expect(r.warnings[0]).toContain('BCM VINs');
  });

  test('handles module with no VINs (filename used for filename token)', () => {
    const mod = { type: 'RFHUB', filename: 'rfhub_blank.bin', size: 4096, vins: [], data: new Uint8Array(4096) };
    const r = buildModuleReportData(mod);
    expect(r.vin).toBeNull();
    expect(r.filename).toMatch(/^srtlab-rfhub_blank-\d{8}-\d{4}\.pdf$/);
  });

  test('source is forwarded from entry', () => {
    const entry = { source: 'RfhubTab' };
    const r = buildModuleReportData(SAMPLE_MOD, entry);
    expect(r.source).toBe('RfhubTab');
  });

  test('source is null when no entry', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    expect(r.source).toBeNull();
  });

  test('generatedAt is a valid ISO string', () => {
    const r = buildModuleReportData(SAMPLE_MOD);
    expect(() => new Date(r.generatedAt)).not.toThrow();
    expect(new Date(r.generatedAt).toISOString()).toBe(r.generatedAt);
  });

  test('includes partNumberStr field', () => {
    const mod = { ...SAMPLE_MOD, partNumberStr: 'FCA-GPEC2A-001-00' };
    const r = buildModuleReportData(mod);
    const pn = r.fields.find(f => f.category === 'SW RELEASE');
    expect(pn).toBeDefined();
    expect(pn.value).toBe('FCA-GPEC2A-001-00');
  });

  test('includes fobikSlots field', () => {
    const mod = { ...SAMPLE_MOD, fobikSlots: 4, securityMarkers: 2, zzzzBlocks: 1 };
    const r = buildModuleReportData(mod);
    const fs = r.fields.find(f => f.category === 'FOBIK SLOTS');
    expect(fs).toBeDefined();
    expect(fs.value).toBe('4');
  });

  test('includes BCM securityLock field', () => {
    const mod = { ...SAMPLE_MOD, securityLock: { value: 0x5A, locked: true } };
    const r = buildModuleReportData(mod);
    const lock = r.fields.find(f => f.category === 'LOCK');
    expect(lock).toBeDefined();
    expect(lock.value).toContain('LOCKED');
  });
});

// ── buildJobReportData ────────────────────────────────────────────────────────

const SAMPLE_JOB = {
  id: 'job-abc-123',
  vin: '1C4RJFBT8KC123456',
  title: 'Job for 1C4RJFBT8KC123456',
  status: 'in-progress',
  createdAt: '2026-05-25T10:00:00.000Z',
  updatedAt: '2026-05-25T11:30:00.000Z',
  census: {
    rows: [
      { code: 'BCM', name: 'Body Control Module', kind: 'ok', dump: null },
      { code: 'RFHUB', name: 'RF Hub', kind: 'mismatch', dump: null },
      { code: 'ECM', name: 'Engine Control Module', kind: 'missing', dump: null },
    ],
  },
  fixPlan: {
    steps: [
      { id: 'step-1', label: 'Write VIN to BCM', action: 'vinWrite', module: 'BCM' },
      { id: 'step-2', label: 'Write VIN to RFHUB', action: 'vinWrite', module: 'RFHUB' },
    ],
    blockers: [],
  },
  signOff: { ready: true, totals: { completed: 2, total: 2, failed: 0, skipped: 0 } },
  events: [
    { ts: '2026-05-25T11:00:00.000Z', kind: 'step.ok', module: 'BCM', payload: { stepId: 'step-1' } },
    { ts: '2026-05-25T10:00:00.000Z', kind: 'job.created', module: null, payload: {} },
  ],
};

describe('buildJobReportData', () => {
  test('throws when job is null', () => {
    expect(() => buildJobReportData(null)).toThrow('job is required');
  });

  test('returns kind=job', () => {
    const r = buildJobReportData(SAMPLE_JOB);
    expect(r.kind).toBe('job');
  });

  test('filename follows srtlab-{vin}-{YYYYMMDD-HHmm}.pdf pattern', () => {
    const r = buildJobReportData(SAMPLE_JOB);
    expect(r.filename).toMatch(/^srtlab-1C4RJFBT8KC123456-\d{8}-\d{4}\.pdf$/);
  });

  test('title is forwarded from job', () => {
    const r = buildJobReportData(SAMPLE_JOB);
    expect(r.title).toBe('Job for 1C4RJFBT8KC123456');
  });

  test('vin is forwarded', () => {
    const r = buildJobReportData(SAMPLE_JOB);
    expect(r.vin).toBe('1C4RJFBT8KC123456');
  });

  test('censusRows are mapped correctly', () => {
    const r = buildJobReportData(SAMPLE_JOB);
    expect(r.censusRows).toHaveLength(3);
    expect(r.censusRows[0]).toMatchObject({ code: 'BCM', kind: 'ok' });
    expect(r.censusRows[1]).toMatchObject({ code: 'RFHUB', kind: 'mismatch' });
    expect(r.censusRows[2]).toMatchObject({ code: 'ECM', kind: 'missing' });
  });

  test('steps are mapped with default pending status', () => {
    const r = buildJobReportData(SAMPLE_JOB);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].id).toBe('step-1');
    expect(r.steps[0].status).toBe('pending');
  });

  test('in-memory results override step status', () => {
    const results = { 'step-1': { status: 'ok', note: 'Done', finishedAt: '2026-05-25T11:00:00.000Z' } };
    const r = buildJobReportData(SAMPLE_JOB, { results });
    expect(r.steps[0].status).toBe('ok');
    expect(r.steps[0].note).toBe('Done');
    expect(r.steps[1].status).toBe('pending');
  });

  test('totals are calculated from steps', () => {
    const results = {
      'step-1': { status: 'ok', note: '' },
      'step-2': { status: 'fail', note: 'NRC 0x35' },
    };
    const r = buildJobReportData(SAMPLE_JOB, { results });
    expect(r.totals.total).toBe(2);
    expect(r.totals.completed).toBe(1);
    expect(r.totals.failed).toBe(1);
    expect(r.totals.skipped).toBe(0);
    expect(r.totals.pending).toBe(0);
  });

  test('signOff is forwarded', () => {
    const r = buildJobReportData(SAMPLE_JOB);
    expect(r.signOff).not.toBeNull();
    expect(r.signOff.ready).toBe(true);
  });

  test('events are ordered chronologically (oldest first)', () => {
    const r = buildJobReportData(SAMPLE_JOB);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].kind).toBe('job.created');
    expect(r.events[1].kind).toBe('step.ok');
  });

  test('handles empty job (no census, plan, events)', () => {
    const empty = { id: 'j1', vin: null, title: null, status: 'draft', createdAt: null, updatedAt: null };
    const r = buildJobReportData(empty);
    expect(r.kind).toBe('job');
    expect(r.censusRows).toEqual([]);
    expect(r.steps).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.totals.total).toBe(0);
    expect(r.signOff).toBeNull();
  });

  test('filename falls back to jobId when vin is null', () => {
    const job = { ...SAMPLE_JOB, vin: null };
    const r = buildJobReportData(job);
    expect(r.filename).toContain('job-abc-123');
  });

  test('generatedAt is a valid ISO string', () => {
    const r = buildJobReportData(SAMPLE_JOB);
    expect(new Date(r.generatedAt).toISOString()).toBe(r.generatedAt);
  });

  test('blockers are forwarded', () => {
    const job = {
      ...SAMPLE_JOB,
      fixPlan: { ...SAMPLE_JOB.fixPlan, blockers: ['No target VIN set'] },
    };
    const r = buildJobReportData(job);
    expect(r.blockers).toEqual(['No target VIN set']);
  });
});
