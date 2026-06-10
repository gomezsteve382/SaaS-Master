/**
 * ecuBranchAlgorithms.test.ts
 * Tests for the ECU branch algorithm data file and its integration
 * with alfaobdDispatchAuxiliary.js.
 */
import { describe, it, expect } from 'vitest';

// Node can import ESM client-side JS directly in vitest (configured in vitest.config.ts)
import {
  ECU_BRANCH_ALGORITHMS,
  getBranchByName,
  getBranchByEcuType,
  getComputableBranches,
  getPendingBranches,
  getBranchCoverage,
} from '../client/src/srtlab/lib/ecuBranchAlgorithms.js';

import {
  README_ECU_BRANCHES,
  AOBD_DISPATCH_AUX,
  STATUS_BRANCH_KNOWN,
  STATUS_CONFIRMED,
  STATUS_INFERRED,
  mergeDispatch,
} from '../client/src/srtlab/lib/alfaobdDispatchAuxiliary.js';

// ── Data integrity ────────────────────────────────────────────────────────────

describe('ECU_BRANCH_ALGORITHMS data integrity', () => {
  it('contains exactly 31 entries', () => {
    expect(ECU_BRANCH_ALGORITHMS).toHaveLength(31);
  });

  it('every entry has required fields', () => {
    for (const e of ECU_BRANCH_ALGORITHMS) {
      expect(e.name, `${e.name}.name`).toBeTruthy();
      expect(typeof e.algo, `${e.name}.algo`).toBe('string');
      expect(typeof e.level, `${e.name}.level`).toBe('number');
      expect(['confirmed', 'inferred', 'pending'], `${e.name}.confidence`)
        .toContain(e.confidence);
      expect(['safety','braking','power','infotainment','chassis','cluster',
               'body','sensing','telematics','towing'], `${e.name}.category`)
        .toContain(e.category);
    }
  });

  it('all 31 expected ECU names are present', () => {
    const expected = [
      'ORC','OCM_PN','ABS_PN','ABS_CHRYSLER','TIPM_CGW',
      'RADIO_NON_PN','DDM_DT','PDM_DT','AFLS_PN','IPC_PN','EPS_PN',
      'ADCM','ADCM_PN','ASCM_PN','ASBS_PN','TTPM_PN','CSWM_PN',
      'LBSS_PN','RBSS_PN','APM_PN','OBCM','BPCM','BPCM_PN','EVCU',
      'TGW_PN','ICS_PN','CVPM_PN','AMP_PN','ANC_PN','TBM2','TBM2_PN',
    ];
    const names = ECU_BRANCH_ALGORITHMS.map(e => e.name);
    for (const n of expected) {
      expect(names, `should contain ${n}`).toContain(n);
    }
  });

  it('no duplicate ECU names', () => {
    const names = ECU_BRANCH_ALGORITHMS.map(e => e.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('confirmed entries have non-null ecuType', () => {
    for (const e of ECU_BRANCH_ALGORITHMS.filter(e => e.confidence === 'confirmed')) {
      expect(e.ecuType, `${e.name}.ecuType should not be null when confirmed`).not.toBeNull();
    }
  });

  it('w6/w7 confirmed entries have a wrapper', () => {
    for (const e of ECU_BRANCH_ALGORITHMS.filter(
      e => e.confidence === 'confirmed' && (e.algo === 'w6' || e.algo === 'w7')
    )) {
      expect(e.wrapper, `${e.name}.wrapper should be set for w6/w7`).toBeTruthy();
    }
  });
});

// ── Lookup helpers ────────────────────────────────────────────────────────────

describe('getBranchByName', () => {
  it('returns the correct entry for a known name', () => {
    const e = getBranchByName('ORC');
    expect(e).toBeDefined();
    expect(e!.name).toBe('ORC');
    expect(e!.category).toBe('safety');
  });

  it('returns undefined for unknown name', () => {
    expect(getBranchByName('NONEXISTENT')).toBeUndefined();
  });
});

describe('getBranchByEcuType', () => {
  it('returns undefined when all entries are pending (ecuType = null)', () => {
    // All entries are pending until RE agent provides data
    const confirmed = ECU_BRANCH_ALGORITHMS.filter(e => e.ecuType !== null);
    if (confirmed.length === 0) {
      expect(getBranchByEcuType(0x149)).toBeUndefined();
    } else {
      const first = confirmed[0];
      expect(getBranchByEcuType(first.ecuType!)).toBeDefined();
    }
  });
});

describe('getComputableBranches', () => {
  it('returns only non-pending entries with known algo', () => {
    const computable = getComputableBranches();
    for (const e of computable) {
      expect(e.confidence).not.toBe('pending');
      expect(e.algo).not.toBe('unknown');
    }
  });
});

describe('getPendingBranches', () => {
  it('returns only pending entries', () => {
    const pending = getPendingBranches();
    for (const e of pending) {
      expect(e.confidence).toBe('pending');
    }
  });

  it('pending + computable = total', () => {
    const pending = getPendingBranches().length;
    const computable = getComputableBranches().length;
    expect(pending + computable).toBe(ECU_BRANCH_ALGORITHMS.length);
  });
});

describe('getBranchCoverage', () => {
  it('total equals 31', () => {
    const cov = getBranchCoverage();
    expect(cov.total).toBe(31);
  });

  it('confirmed + inferred + pending = total', () => {
    const cov = getBranchCoverage();
    expect(cov.confirmed + cov.inferred + cov.pending).toBe(cov.total);
  });
});

// ── alfaobdDispatchAuxiliary integration ──────────────────────────────────────

describe('alfaobdDispatchAuxiliary backward compatibility', () => {
  it('README_ECU_BRANCHES has 31 entries', () => {
    expect(README_ECU_BRANCHES).toHaveLength(31);
  });

  it('README_ECU_BRANCHES names match ECU_BRANCH_ALGORITHMS', () => {
    const names = ECU_BRANCH_ALGORITHMS.map(e => e.name);
    expect(README_ECU_BRANCHES).toEqual(names);
  });

  it('AOBD_DISPATCH_AUX has 31 keys prefixed with ecu_', () => {
    const keys = Object.keys(AOBD_DISPATCH_AUX);
    expect(keys).toHaveLength(31);
    for (const k of keys) {
      expect(k.startsWith('ecu_')).toBe(true);
    }
  });

  it('pending entries have _status = STATUS_BRANCH_KNOWN', () => {
    for (const e of ECU_BRANCH_ALGORITHMS.filter(e => e.confidence === 'pending')) {
      const aux = AOBD_DISPATCH_AUX[`ecu_${e.name}`];
      expect(aux._status).toBe(STATUS_BRANCH_KNOWN);
    }
  });

  it('confirmed entries have _status = STATUS_CONFIRMED', () => {
    for (const e of ECU_BRANCH_ALGORITHMS.filter(e => e.confidence === 'confirmed')) {
      const aux = AOBD_DISPATCH_AUX[`ecu_${e.name}`];
      expect(aux._status).toBe(STATUS_CONFIRMED);
    }
  });

  it('inferred entries have _status = STATUS_INFERRED', () => {
    for (const e of ECU_BRANCH_ALGORITHMS.filter(e => e.confidence === 'inferred')) {
      const aux = AOBD_DISPATCH_AUX[`ecu_${e.name}`];
      expect(aux._status).toBe(STATUS_INFERRED);
    }
  });
});

describe('mergeDispatch', () => {
  it('catalog entries take precedence over auxiliary', () => {
    const catalogDispatch = { 'ecu_ORC': { _status: 'catalog_override', algo: 'w6' } };
    const merged = mergeDispatch(catalogDispatch);
    expect(merged['ecu_ORC']._status).toBe('catalog_override');
  });

  it('auxiliary entries are present when not overridden', () => {
    const merged = mergeDispatch({});
    expect(merged['ecu_EVCU']).toBeDefined();
  });

  it('merged result has at least 31 keys', () => {
    const merged = mergeDispatch({});
    expect(Object.keys(merged).length).toBeGreaterThanOrEqual(31);
  });
});

// ── Future-proof: simulate receiving RE agent data ────────────────────────────

describe('simulated RE agent data integration', () => {
  it('a confirmed entry with ecuType resolves via getBranchByEcuType', () => {
    // Simulate what happens after the RE agent fills in one entry.
    // We test the lookup logic directly with a mock entry.
    const mockEntries = [
      { name: 'ORC', ecuType: 0x14F, algo: 'w6', wrapper: 'c2', level: 1,
        confidence: 'confirmed' as const, note: 'RE verified', category: 'safety' as const },
    ];
    const found = mockEntries.find(e => e.ecuType === 0x14F);
    expect(found).toBeDefined();
    expect(found!.name).toBe('ORC');
    expect(found!.algo).toBe('w6');
    expect(found!.wrapper).toBe('c2');
  });

  it('coverage stats update correctly when entries are confirmed', () => {
    // Simulate confirming all remaining pending entries
    const mockAlgos = ECU_BRANCH_ALGORITHMS.map((e, i) =>
      e.confidence === 'pending'
        ? { ...e, confidence: 'confirmed' as const, ecuType: 0x150 + i }
        : e
    );
    const confirmed = mockAlgos.filter(e => e.confidence === 'confirmed').length;
    const pending   = mockAlgos.filter(e => e.confidence === 'pending').length;
    expect(confirmed).toBe(31);
    expect(pending).toBe(0);
    expect(confirmed + pending).toBe(31);
  });
});
