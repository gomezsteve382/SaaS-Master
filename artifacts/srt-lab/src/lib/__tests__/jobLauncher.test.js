import { describe, it, expect } from 'vitest';
import { JOB_KINDS, jobKind, startJob } from '../jobLauncher.js';

// tab ids the launcher routes to (must exist in App.jsx WORKSPACE_TABS)
const VALID_TABS = new Set(['keyxfer', 'akl', 'bcm', 'modsync', 'topology', 'obd', 'livekey', 'vinprog']);

describe('jobLauncher', () => {
  it('every job kind routes to a known tab id', () => {
    expect(JOB_KINDS.length).toBeGreaterThanOrEqual(4);
    for (const k of JOB_KINDS) expect(VALID_TABS.has(k.targetTab)).toBe(true);
  });

  it('blocks a VIN-required job without a 17-char VIN', async () => {
    const r = await startJob({ kind: 'add-key', vin: 'SHORT', setTab: () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/VIN/i);
  });

  it('AKL needs no VIN and routes to the akl tab', async () => {
    let routed = null;
    const r = await startJob({ kind: 'akl', setTab: (t) => { routed = t; } });
    expect(r.ok).toBe(true);
    expect(routed).toBe('akl');
  });

  it('creates a job with the right kind, pre-stages context, and routes', async () => {
    let routed = null; const calls = []; const ctxCalls = {};
    const createJob = async (j) => { calls.push(j); return { id: 'job_1', ...j }; };
    const ctx = {
      setJobId: (id) => { ctxCalls.jobId = id; },
      hydrateFromJob: (j) => { ctxCalls.hydrated = j.id; },
      setVin: (v) => { ctxCalls.vin = v; },
    };
    const r = await startJob({ kind: 'bcm-swap', vin: '1C4HJXEN5MW123456', ctx, setTab: t => routed = t, createJob, newJobId: () => 'job_1' });
    expect(r.ok).toBe(true);
    expect(calls[0].kind).toBe('bcm-swap');
    expect(calls[0].status).toBe('in-progress');
    expect(routed).toBe('bcm');
    expect(ctxCalls.jobId).toBe('job_1');
    expect(ctxCalls.vin).toBe('1C4HJXEN5MW123456');
    expect(r.jobId).toBe('job_1');
  });

  it('unknown kind returns an error', async () => {
    const r = await startJob({ kind: 'nope', setTab: () => {} });
    expect(r.ok).toBe(false);
  });
});
