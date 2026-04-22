import { describe, test, expect } from 'vitest';
import { detectCommonScenario } from '../lib/plainEnglish.jsx';

const stepActions = [
  { id: 'full-sync',        label: 'Full', enabled: true,  description: '' },
  { id: 'sec16-only',       label: 'S16',  enabled: true,  description: '' },
  { id: 'bcm-sec16-to-rfh', label: 'B>R',  enabled: true,  description: '' },
  { id: 'rfh-to-bcm',       label: 'R>B',  enabled: true,  description: '' },
  { id: 'bcm-to-rfh',       label: 'B>R',  enabled: true,  description: '' },
];

describe('detectCommonScenario', () => {
  test('returns null when nothing is wrong', () => {
    expect(detectCommonScenario({
      issues: [], warnings: [], stepActions, modules: ['BCM', 'RFHUB'],
    })).toBeNull();
  });

  test('returns null when no actions are enabled', () => {
    expect(detectCommonScenario({
      issues: ['VIN MISMATCH between BCM and RFHUB'],
      stepActions: stepActions.map(a => ({ ...a, enabled: false })),
      modules: ['BCM', 'RFHUB'],
    })).toBeNull();
  });

  test('BCM+RFHUB VIN mismatch → "Pair RFHUB to BCM" via full-sync', () => {
    const got = detectCommonScenario({
      issues: ['VIN MISMATCH between BCM and RFHUB'],
      stepActions, modules: ['BCM', 'RFHUB'],
      hexSnippets: ['RFHUB VIN @0x5320: 2C3CDXBT0LH123456'],
    });
    expect(got.key).toBe('pair-rfhub-to-bcm');
    expect(got.actionId).toBe('full-sync');
    expect(got.name).toBe('Pair RFHUB to BCM');
    expect(got.modulesAffected).toEqual(['BCM', 'RFHUB']);
    expect(got.targetVin).toBe('2C3CDXBT0LH123456');
  });

  test('BCM has good token, RFHUB does not → BCM SEC16 → RFHUB', () => {
    const got = detectCommonScenario({
      issues: ['BCM SEC16 valid but RFHUB SEC16 invalid'],
      stepActions, modules: ['BCM', 'RFHUB'],
    });
    expect(got.key).toBe('bcm-sec16-to-rfhub');
    expect(got.actionId).toBe('bcm-sec16-to-rfh');
    expect(got.modulesAffected).toEqual(['RFHUB']);
  });

  test('all 3 modules + VIN mismatch → "Pair BCM + RFHUB + Engine computer"', () => {
    const got = detectCommonScenario({
      issues: ['VIN MISMATCH between BCM and RFHUB', 'PCM SEC6 damaged'],
      stepActions, modules: ['BCM', 'RFHUB', 'PCM'],
    });
    expect(got.key).toBe('pair-all-three');
    expect(got.actionId).toBe('full-sync');
    expect(got.modulesAffected).toEqual(['BCM', 'RFHUB', 'PCM']);
  });

  test('single BCM with VIN mismatch → "Re-stamp VIN into the BCM"', () => {
    const got = detectCommonScenario({
      issues: ['VIN MISMATCH'],
      stepActions, modules: ['BCM'],
    });
    expect(got.key).toBe('restamp-bcm-vin');
    expect(got.actionId).toBe('rfh-to-bcm');
    expect(got.modulesAffected).toEqual(['BCM']);
  });

  test('single RFHUB with VIN issue → "Re-stamp VIN into the key receiver"', () => {
    const got = detectCommonScenario({
      issues: ['VIN MISMATCH'],
      stepActions, modules: ['RFHUB'],
    });
    expect(got.key).toBe('restamp-rfhub-vin');
    expect(got.actionId).toBe('bcm-to-rfh');
    expect(got.modulesAffected).toEqual(['RFHUB']);
  });

  test('GPEC2A + 95640 with IMMO issue → "Pair GPEC2A engine computer to 95640 backup chip"', () => {
    const got = detectCommonScenario({
      issues: ['PCM SEC6 IMMO_DAMAGED'],
      stepActions: [
        { id: 'gpec2a-95640-pair', label: 'pair', enabled: true, description: '' },
      ],
      modules: ['GPEC2A', '95640'],
    });
    expect(got).not.toBeNull();
    expect(got.key).toBe('pair-gpec2a-95640');
    expect(got.actionId).toBe('gpec2a-95640-pair');
    expect(got.modulesAffected).toEqual(['PCM', '95640']);
  });

  test('PCM + 95640 falls back to full-sync when dedicated action is not enabled', () => {
    const got = detectCommonScenario({
      issues: ['PCM SEC6 IMMO_DAMAGED'],
      stepActions: [{ id: 'full-sync', label: 'full', enabled: true, description: '' }],
      modules: ['PCM', '95640'],
    });
    expect(got.key).toBe('pair-gpec2a-95640');
    expect(got.actionId).toBe('full-sync');
  });

  test('GPEC2A + 95640 with only a non-IMMO warning → null (no over-trigger)', () => {
    expect(detectCommonScenario({
      warnings: ['BCM PN MISMATCH'],
      stepActions: [{ id: 'full-sync', label: 'full', enabled: true, description: '' }],
      modules: ['GPEC2A', '95640'],
    })).toBeNull();
  });

  test('RFHUB + 95640 with BCM-SEC16 mismatch → "Re-key 95640 from RFHUB"', () => {
    const got = detectCommonScenario({
      issues: ['95640 BCM-SEC16 MISMATCH: 95640 token ≠ reverse(RFHUB SEC16)'],
      stepActions: [
        { id: 'rekey-95640-from-rfh', label: 're-key', enabled: true, description: '' },
      ],
      modules: ['RFHUB', '95640'],
    });
    expect(got).not.toBeNull();
    expect(got.key).toBe('rekey-95640-from-rfhub');
    expect(got.actionId).toBe('rekey-95640-from-rfh');
    expect(got.name).toBe('Re-key 95640 from RFHUB');
    expect(got.modulesAffected).toEqual(['95640']);
  });

  test('RFHUB + 95640 with BLANK 95640 SEC16 → "Re-key 95640 from RFHUB"', () => {
    const got = detectCommonScenario({
      issues: ['95640 BCM-SEC16 BLANK — backup chip needs re-keying from RFHUB'],
      stepActions: [
        { id: 'rekey-95640-from-rfh', label: 're-key', enabled: true, description: '' },
      ],
      modules: ['RFHUB', '95640'],
    });
    expect(got).not.toBeNull();
    expect(got.key).toBe('rekey-95640-from-rfhub');
    expect(got.actionId).toBe('rekey-95640-from-rfh');
  });

  test('RFHUB + 95640 with no issues → null (no over-trigger)', () => {
    expect(detectCommonScenario({
      stepActions: [
        { id: 'rekey-95640-from-rfh', label: 're-key', enabled: true, description: '' },
      ],
      modules: ['RFHUB', '95640'],
    })).toBeNull();
  });

  test('RFHUB + 95640 + BCM falls through to BCM/RFHUB scenario (not 95640 re-key)', () => {
    const got = detectCommonScenario({
      issues: ['VIN MISMATCH between BCM and RFHUB'],
      stepActions: [
        ...stepActions,
        { id: 'rekey-95640-from-rfh', label: 're-key', enabled: true, description: '' },
      ],
      modules: ['BCM', 'RFHUB', '95640'],
    });
    expect(got).not.toBeNull();
    expect(got.key).not.toBe('rekey-95640-from-rfhub');
  });

  test('uncommon shape (BCM+PCM only with random warning) → null fallback', () => {
    expect(detectCommonScenario({
      warnings: ['BCM PN MISMATCH'],
      stepActions, modules: ['BCM', 'PCM'],
    })).toBeNull();
  });
});
