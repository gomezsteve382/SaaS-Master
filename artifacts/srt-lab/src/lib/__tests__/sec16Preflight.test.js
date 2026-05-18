import { describe, it, expect } from 'vitest';
import { evaluateSec16Preflight } from '../sec16Preflight.js';

const LX_VIN = '2C3CDXL90MH582899';
const WK_VIN = '1C4RJFDJ7DC513874';
const RAM_VIN = '1C6RR7LT5KS123456';

const allLoaded = [
  { type: 'BCM' }, { type: 'RFHUB' }, { type: 'GPEC2A' },
];
const wkLoaded = [...allLoaded, { type: '95640' }];

describe('sec16Preflight — status transitions', () => {
  it('GO when no issues/warnings on LX/LD with full module set', () => {
    const v = evaluateSec16Preflight({
      vin: LX_VIN, modules: allLoaded,
      crossValidate: { issues: [], warnings: [], passed: ['VIN consistent: ' + LX_VIN] },
    });
    expect(v.status).toBe('GO');
    expect(v.canProgramKey).toBe(true);
    expect(v.actions).toEqual([]);
  });

  it('SYNC_REQUIRED when a fixable blocker fires', () => {
    const v = evaluateSec16Preflight({
      vin: LX_VIN, modules: allLoaded,
      crossValidate: {
        issues: ['RFHUB ↔ BCM vehicle secret: MISMATCH — BCM(split)=… RFH=…'],
        warnings: [], passed: [],
      },
    });
    expect(v.status).toBe('SYNC_REQUIRED');
    expect(v.canProgramKey).toBe(false);
    expect(v.actions.map(a => a.id)).toContain('rfh-bcm-sec16-sync');
    expect(v.blockers).toHaveLength(1);
    expect(v.blockers[0].ruleId).toBe('rfhub-bcm-sec16');
  });

  it('NO_GO when a non-fixable blocker fires (VIN mismatch)', () => {
    const v = evaluateSec16Preflight({
      vin: LX_VIN, modules: allLoaded,
      crossValidate: { issues: ['VIN MISMATCH: A, B'], warnings: [], passed: [] },
    });
    expect(v.status).toBe('NO_GO');
    expect(v.canProgramKey).toBe(false);
    expect(v.actions).toEqual([]);
  });

  it('NO_GO when 95640 secret key mismatches on WK2', () => {
    const v = evaluateSec16Preflight({
      vin: WK_VIN, modules: wkLoaded,
      crossValidate: {
        issues: ['95640 ↔ RFHUB secret key: MISMATCH!'],
        warnings: [], passed: [],
      },
    });
    expect(v.status).toBe('NO_GO');
  });

  it('INSUFFICIENT_DATA when WK2 lacks the 95640 dump', () => {
    const v = evaluateSec16Preflight({
      vin: WK_VIN, modules: allLoaded, // no 95640
      crossValidate: { issues: [], warnings: [], passed: [] },
    });
    expect(v.status).toBe('INSUFFICIENT_DATA');
    expect(v.missingModules).toContain('95640');
  });

  it('LIVE_ONLY for any Ram XC2268 platform regardless of cross-validate output', () => {
    const v = evaluateSec16Preflight({
      vin: RAM_VIN, modules: [{ type: 'XC2268_RFHUB' }],
      crossValidate: { issues: ['VIN MISMATCH: X, Y'], warnings: [], passed: [] },
    });
    expect(v.status).toBe('LIVE_ONLY');
    expect(v.classification.platform).toBe('dt-ram-2019plus');
  });

  it('warnings-only path stays GO and surfaces no actions for unmapped warnings', () => {
    const v = evaluateSec16Preflight({
      vin: LX_VIN, modules: allLoaded,
      crossValidate: { issues: [], warnings: ['GPEC2A SKIM: DISABLED (0x00) — bypassed'], passed: [] },
    });
    expect(v.status).toBe('GO');
    expect(v.canProgramKey).toBe(true);
  });

  it('flat 0x40C9 staleness is a warning + offers the repair action', () => {
    const v = evaluateSec16Preflight({
      vin: LX_VIN, modules: allLoaded,
      crossValidate: {
        issues: [],
        warnings: ['BCM legacy flat 0x40C9 STALE — live SEC16 …'],
        passed: [],
      },
    });
    expect(v.status).toBe('GO'); // warning only
    expect(v.actions.map(a => a.id)).toContain('flat-40c9-repair');
  });

  it('multiple fixable blockers collapse actions but keep all blockers', () => {
    const v = evaluateSec16Preflight({
      vin: WK_VIN, modules: wkLoaded,
      crossValidate: {
        issues: [
          'RFHUB ↔ BCM vehicle secret: MISMATCH …',
          'BCM SEC16 → SEC6 ↔ PCM SEC6: MISMATCH …',
        ],
        warnings: ['RFHUB SEC16 ↔ 95640 BCM-SEC16 (reversed): MISMATCH …'],
        passed: [],
      },
    });
    expect(v.status).toBe('SYNC_REQUIRED');
    /* WK2 lists `rfhub-95640-bcm-sec16` as a required rule, so the
     * matcher's default 'warning' severity is promoted to 'blocker' for
     * this platform — the three offline mismatches all become blockers. */
    expect(v.blockers).toHaveLength(3);
    expect(v.actions.map(a => a.id).sort()).toEqual([
      'bcm-pcm-sec6-sync', 'rfh-95640-bcm-sec16-sync', 'rfh-bcm-sec16-sync',
    ]);
  });
});
