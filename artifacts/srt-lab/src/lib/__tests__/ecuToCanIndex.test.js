import { describe, it, expect } from 'vitest';
import {
  canIdsForEcu,
  ecusForCanId,
  listFriendlyEcus,
  canIdHex,
} from '../ecuToCanIndex.js';

describe('ecuToCanIndex', () => {
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
