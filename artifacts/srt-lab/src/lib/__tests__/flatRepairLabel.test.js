import { describe, it, expect } from 'vitest';
import {
  classifyFlatRepairFilename,
  FLAT_REPAIR_KINDS,
} from '../flatRepairLabel.js';

describe('classifyFlatRepairFilename', () => {
  it('recognizes the canonical double-emit output', () => {
    const r = classifyFlatRepairFilename(
      'BCM_FLAT40C9_REPAIRED_CANONICAL_20260525_120000.bin',
    );
    expect(r).toBe(FLAT_REPAIR_KINDS.CANONICAL);
    expect(r.kind).toBe('canonical');
    expect(r.fullLabel).toBe('Canonical (modern tools + SRT Lab)');
  });

  it('recognizes the legacy-flat double-emit output', () => {
    const r = classifyFlatRepairFilename(
      'BCM_FLAT40C9_REPAIRED_LEGACYFLAT_20260525_120000.bin',
    );
    expect(r).toBe(FLAT_REPAIR_KINDS.LEGACY_FLAT);
    expect(r.kind).toBe('legacy-flat');
    expect(r.fullLabel).toBe(
      'Legacy-flat (CGDI / Autel / AlfaOBD / SINCRO)',
    );
  });

  it('is case-insensitive', () => {
    expect(
      classifyFlatRepairFilename('bcm_flat40c9_repaired_canonical_1.bin'),
    ).toBe(FLAT_REPAIR_KINDS.CANONICAL);
    expect(
      classifyFlatRepairFilename('Bcm_Flat40C9_Repaired_LegacyFlat_1.bin'),
    ).toBe(FLAT_REPAIR_KINDS.LEGACY_FLAT);
  });

  it('strips path prefixes before classifying', () => {
    expect(
      classifyFlatRepairFilename(
        '/home/tech/Downloads/BCM_FLAT40C9_REPAIRED_CANONICAL_1.bin',
      ),
    ).toBe(FLAT_REPAIR_KINDS.CANONICAL);
    expect(
      classifyFlatRepairFilename(
        'C:\\Users\\tech\\BCM_FLAT40C9_REPAIRED_LEGACYFLAT_1.bin',
      ),
    ).toBe(FLAT_REPAIR_KINDS.LEGACY_FLAT);
  });

  it('returns null for the single-mode pre-double-emit filename without a kind suffix', () => {
    expect(
      classifyFlatRepairFilename('BCM_FLAT40C9_REPAIRED_20260525_120000.bin'),
    ).toBeNull();
  });

  it('returns null for unrelated filenames', () => {
    expect(classifyFlatRepairFilename('BCM_SYNCED_VIN_1.bin')).toBeNull();
    expect(classifyFlatRepairFilename('RFH_VIRGIN_VIN_1.bin')).toBeNull();
    expect(classifyFlatRepairFilename('BCM_ORIGINAL_1.bin')).toBeNull();
    expect(classifyFlatRepairFilename('')).toBeNull();
    expect(classifyFlatRepairFilename(null)).toBeNull();
    expect(classifyFlatRepairFilename(undefined)).toBeNull();
    expect(classifyFlatRepairFilename(42)).toBeNull();
  });

  it('requires the suffix to be a delimited token, not a substring', () => {
    expect(
      classifyFlatRepairFilename(
        'BCM_FLAT40C9_REPAIRED_CANONICALISH_1.bin',
      ),
    ).toBeNull();
    expect(
      classifyFlatRepairFilename(
        'BCM_FLAT40C9_REPAIRED_LEGACYFLATTERED_1.bin',
      ),
    ).toBeNull();
  });

  it('accepts the suffix as the final token (no trailing timestamp)', () => {
    expect(
      classifyFlatRepairFilename('BCM_FLAT40C9_REPAIRED_CANONICAL.bin'),
    ).toBe(FLAT_REPAIR_KINDS.CANONICAL);
    expect(
      classifyFlatRepairFilename('BCM_FLAT40C9_REPAIRED_LEGACYFLAT'),
    ).toBe(FLAT_REPAIR_KINDS.LEGACY_FLAT);
  });

  it('exposes stable styling fields for both kinds', () => {
    for (const k of [FLAT_REPAIR_KINDS.CANONICAL, FLAT_REPAIR_KINDS.LEGACY_FLAT]) {
      expect(typeof k.shortLabel).toBe('string');
      expect(typeof k.audience).toBe('string');
      expect(typeof k.color).toBe('string');
      expect(typeof k.background).toBe('string');
      expect(k.suffix.startsWith('_')).toBe(true);
    }
  });
});
