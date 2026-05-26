// @vitest-environment node
//
// Unit tests for the AlfaOBD ECU → CAN reverse-index helpers.
//
// Covers BOTH surfaces:
//   1. Direct lookup helpers (canIdsForEcu, ecusForCanId, listFriendlyEcus,
//      canIdHex) used by AlfaObdIntelTab.
//   2. UDS / J2534 picker rows (buildEcuToCanIndex, ECU_PICKER_ROWS,
//      findEcuPickerRow) used by UdsTab — single-ID default RX offset,
//      explicit-pair shortcut, legacy multi-bus expansion (Radio Frequency
//      HUB → 0x600,0x620), numeric-label sort-last, dedupe, and round-trip
//      against the documented Tier-1 mappings.

import { describe, it, expect } from 'vitest';
import {
  canIdsForEcu,
  ecusForCanId,
  listFriendlyEcus,
  canIdHex,
  buildEcuToCanIndex,
  findEcuPickerRow,
  ECU_PICKER_ROWS,
  ECU_PICKER_SOURCE,
  CAN11_RESPONSE_OFFSET,
} from '../ecuToCanIndex.js';

describe('ecuToCanIndex — direct lookup helpers', () => {
  describe('canIdsForEcu', () => {
    it('returns [0x600, 0x620] for "Radio Frequency HUB"', () => {
      expect(canIdsForEcu('Radio Frequency HUB')).toEqual([0x600, 0x620]);
    });

    it('matches acronym "RFHUB" → same multi-bus list', () => {
      expect(canIdsForEcu('RFHUB')).toEqual([0x600, 0x620]);
    });

    it('is case-insensitive', () => {
      expect(canIdsForEcu('radio frequency hub')).toEqual([0x600, 0x620]);
    });

    it('returns [] for unknown names', () => {
      expect(canIdsForEcu('nonsense')).toEqual([]);
    });

    it('returns [] for empty/invalid input', () => {
      expect(canIdsForEcu('')).toEqual([]);
      expect(canIdsForEcu(null)).toEqual([]);
      expect(canIdsForEcu(undefined)).toEqual([]);
    });

    it('returns deduped sorted ascending', () => {
      const out = canIdsForEcu('TIPM_CGW');
      expect(out).toEqual([...new Set(out)].sort((a, b) => a - b));
    });
  });

  describe('ecusForCanId', () => {
    it('includes "Radio Frequency HUB" for 0x600', () => {
      expect(ecusForCanId(0x600)).toContain('Radio Frequency HUB');
    });

    it('excludes numeric-only keys', () => {
      const out = ecusForCanId(0x600);
      expect(out.every((k) => !/^\d+$/.test(k))).toBe(true);
    });

    it('excludes MY20xx platform strings', () => {
      const out = ecusForCanId(0x600);
      expect(out.every((k) => !k.startsWith('MY20'))).toBe(true);
    });

    it('excludes RAM family entry', () => {
      const out = ecusForCanId(0x504);
      expect(out.every((k) => !k.startsWith('RAM 1500/'))).toBe(true);
    });

    it('returns sorted alphabetically', () => {
      const out = ecusForCanId(0x600);
      expect(out).toEqual([...out].sort((a, b) => a.localeCompare(b)));
    });
  });

  describe('listFriendlyEcus', () => {
    it('excludes platform/numeric/RAM entries', () => {
      const all = listFriendlyEcus();
      expect(all.every(({ name }) => !/^\d+$/.test(name))).toBe(true);
      expect(all.every(({ name }) => !name.startsWith('MY20'))).toBe(true);
      expect(all.every(({ name }) => !name.startsWith('RAM 1500/'))).toBe(true);
    });

    it('is sorted alphabetically by name', () => {
      const all = listFriendlyEcus();
      const names = all.map((e) => e.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it('includes Radio Frequency HUB with both CAN IDs', () => {
      const all = listFriendlyEcus();
      const rfhub = all.find((e) => e.name === 'Radio Frequency HUB');
      expect(rfhub).toBeDefined();
      expect(rfhub.canIds).toEqual([0x600, 0x620]);
    });

    it('returns objects with name and canIds[]', () => {
      const all = listFriendlyEcus();
      expect(all.length).toBeGreaterThan(0);
      for (const entry of all) {
        expect(typeof entry.name).toBe('string');
        expect(Array.isArray(entry.canIds)).toBe(true);
      }
    });
  });

  describe('canIdHex', () => {
    it('formats 0x600 as "0x600"', () => {
      expect(canIdHex(0x600)).toBe('0x600');
    });

    it('formats 0x14E as "0x14E"', () => {
      expect(canIdHex(0x14e)).toBe('0x14E');
    });

    it('pads small values to 3 digits', () => {
      expect(canIdHex(0x7)).toBe('0x007');
    });

    it('uppercase hex', () => {
      expect(canIdHex(0xabc)).toBe('0xABC');
    });
  });
});

describe('buildEcuToCanIndex — UDS picker rows', () => {
  it('single-ID entry → one row with response = request + 0x8', () => {
    const rows = buildEcuToCanIndex({ FOO: [0x750] });
    expect(rows).toEqual([{
      label: 'FOO',
      requestId: 0x750,
      responseId: 0x758,
      source: ECU_PICKER_SOURCE,
      isLegacyMultiBus: false,
      isNumericInternalId: false,
    }]);
  });

  it('two-ID entry forming an explicit request/response pair stays as one row', () => {
    const rows = buildEcuToCanIndex({ BCM_PAIR: [0x700, 0x708] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: 'BCM_PAIR',
      requestId: 0x700,
      responseId: 0x708,
      isLegacyMultiBus: false,
    });
  });

  it('multi-ID entry that is NOT an explicit pair expands to per-bus rows', () => {
    const rows = buildEcuToCanIndex({ 'Radio Frequency HUB': [0x600, 0x620] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      label: 'Radio Frequency HUB (legacy bus 1)',
      requestId: 0x600,
      responseId: 0x608,
      isLegacyMultiBus: true,
    });
    expect(rows[1]).toMatchObject({
      label: 'Radio Frequency HUB (legacy bus 2)',
      requestId: 0x620,
      responseId: 0x628,
      isLegacyMultiBus: true,
    });
  });

  it('three-ID entries expand to three legacy-bus rows', () => {
    const rows = buildEcuToCanIndex({ TRIPLE: [0x100, 0x200, 0x300] });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.label)).toEqual([
      'TRIPLE (legacy bus 1)',
      'TRIPLE (legacy bus 2)',
      'TRIPLE (legacy bus 3)',
    ]);
    expect(rows.every((r) => r.isLegacyMultiBus)).toBe(true);
    expect(rows.map((r) => r.responseId - r.requestId))
      .toEqual([CAN11_RESPONSE_OFFSET, CAN11_RESPONSE_OFFSET, CAN11_RESPONSE_OFFSET]);
  });

  it('dedupes identical (label, requestId, responseId) tuples', () => {
    const rows = buildEcuToCanIndex({ FOO: [0x750], BAR: [0x750] });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label).sort()).toEqual(['BAR', 'FOO']);
  });

  it('sorts numeric-only internal IDs after human-readable labels', () => {
    const rows = buildEcuToCanIndex({
      '79': [0x149],
      'AHBM': [0x500],
      '10': [0x149],
      'TIPM_CGW': [0x149, 0x14E],
    });
    const labels = rows.map((r) => r.label);
    const firstNumericIdx = labels.findIndex((l) => /^\d/.test(l));
    const lastHumanIdx = labels.findIndex((l) => l.startsWith('TIPM') || l.startsWith('AHBM'));
    expect(firstNumericIdx).toBeGreaterThan(lastHumanIdx);
    expect(rows.find((r) => r.label === '10').isNumericInternalId).toBe(true);
    expect(rows.find((r) => r.label === 'AHBM').isNumericInternalId).toBe(false);
  });

  it('disambiguates a platform vs a module that share a CAN ID', () => {
    const rows = buildEcuToCanIndex({
      'TIPM_CGW': [0x149, 0x14E],
      'MY2008-14 Non-PowerNet': [0x149],
    });
    const reqs = rows.filter((r) => r.requestId === 0x149);
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    expect(reqs.some((r) => r.label.startsWith('TIPM_CGW'))).toBe(true);
    expect(reqs.some((r) => r.label === 'MY2008-14 Non-PowerNet')).toBe(true);
  });

  it('skips entries with empty or non-array values', () => {
    const rows = buildEcuToCanIndex({ FOO: [], BAR: null, BAZ: undefined, OK: [0x100] });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('OK');
  });
});

describe('ECU_PICKER_ROWS (live generated data)', () => {
  it('has the documented Tier-1 mappings from the generated header', () => {
    const byLabel = (label) =>
      ECU_PICKER_ROWS.filter((r) =>
        r.label === label || r.label.startsWith(label + ' (legacy bus'));

    const tipm = byLabel('TIPM_CGW');
    expect(tipm.length).toBe(2);
    expect(tipm.map((r) => r.requestId).sort((a, b) => a - b)).toEqual([0x149, 0x14E]);
    expect(tipm.every((r) => r.isLegacyMultiBus)).toBe(true);

    const ahbm = byLabel('AHBM');
    expect(ahbm).toHaveLength(1);
    expect(ahbm[0].requestId).toBe(0x500);
    expect(ahbm[0].responseId).toBe(0x508);

    const marelli = byLabel('MARELLI_DASH');
    expect(marelli).toHaveLength(1);
    expect(marelli[0].requestId).toBe(0x514);

    const rfhub = byLabel('Radio Frequency HUB');
    expect(rfhub).toHaveLength(2);
    expect(rfhub.map((r) => r.requestId).sort((a, b) => a - b)).toEqual([0x600, 0x620]);
    expect(rfhub.every((r) => r.isLegacyMultiBus)).toBe(true);

    const pnet = byLabel('MY2011+ PowerNet');
    expect(pnet).toHaveLength(1);
    expect(pnet[0].requestId).toBe(0x620);
  });

  it('every row tags itself with the alfaobd-il provenance source', () => {
    expect(ECU_PICKER_ROWS.length).toBeGreaterThan(50);
    expect(ECU_PICKER_ROWS.every((r) => r.source === ECU_PICKER_SOURCE)).toBe(true);
  });
});

describe('findEcuPickerRow', () => {
  it('returns null for empty queries', () => {
    expect(findEcuPickerRow('')).toBeNull();
    expect(findEcuPickerRow(null)).toBeNull();
  });

  it('matches exact label first', () => {
    const row = findEcuPickerRow('AHBM');
    expect(row).not.toBeNull();
    expect(row.requestId).toBe(0x500);
  });

  it('falls back to case-insensitive substring match', () => {
    const row = findEcuPickerRow('marelli_dash');
    expect(row).not.toBeNull();
    expect(row.requestId).toBe(0x514);
  });
});
