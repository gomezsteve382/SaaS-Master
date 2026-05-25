import { describe, it, expect } from 'vitest';
import {
  PINNED_RFH_FIXTURES,
  getPinnedExpectation,
  pinnedStatus,
  formatRegistryEntry,
} from '../rfhPinnedRegistry.js';

const SCAT_NAME = 'RFH_SCAT_OG_1776883386715.bin';
const SCAT_IDENTITY = {
  os:     { value: 'AA30712804',     len: 10, offset: 0x808, matchesCanonical: true,  supplierBonus: 0  },
  pn:     { value: '30712804CA',     len: 10, offset: 0x80a, matchesCanonical: false, supplierBonus: 0  },
  serial: { value: '7161A9870IR00T', len: 14, offset: 0x82c, matchesCanonical: true,  supplierBonus: 20 },
};

describe('rfhPinnedRegistry', () => {
  it('SCAT fixture is pinned', () => {
    expect(getPinnedExpectation(SCAT_NAME)).toBeTruthy();
  });

  it('unknown filename returns null expectation', () => {
    expect(getPinnedExpectation('mystery_dump.bin')).toBeNull();
    expect(getPinnedExpectation('')).toBeNull();
    expect(getPinnedExpectation(null)).toBeNull();
  });

  it('pinnedStatus reports "unconfirmed" for unknown files', () => {
    const r = pinnedStatus('mystery.bin', SCAT_IDENTITY);
    expect(r.status).toBe('unconfirmed');
    expect(r.expected).toBeNull();
    expect(r.mismatches).toEqual([]);
  });

  it('pinnedStatus reports "pinned" when identity matches registry exactly', () => {
    const r = pinnedStatus(SCAT_NAME, SCAT_IDENTITY);
    expect(r.status).toBe('pinned');
    expect(r.mismatches).toEqual([]);
  });

  it('pinnedStatus reports "pinned" with no identity (treats pin as authoritative)', () => {
    const r = pinnedStatus(SCAT_NAME, null);
    expect(r.status).toBe('pinned');
    expect(r.expected).toBeTruthy();
  });

  it('pinnedStatus reports "pinned-mismatch" when extractor disagrees with pin', () => {
    const drifted = {
      ...SCAT_IDENTITY,
      pn: { ...SCAT_IDENTITY.pn, value: 'XXXXXXXXXX' },
    };
    const r = pinnedStatus(SCAT_NAME, drifted);
    expect(r.status).toBe('pinned-mismatch');
    expect(r.mismatches.length).toBeGreaterThan(0);
    expect(r.mismatches[0].field).toBe('pn');
    expect(r.mismatches[0].key).toBe('value');
  });

  it('formatRegistryEntry produces a paste-ready string', () => {
    const out = formatRegistryEntry(SCAT_NAME, SCAT_IDENTITY);
    expect(out).toContain(`'${SCAT_NAME}'`);
    expect(out).toContain("value: \"AA30712804\"");
    expect(out).toContain('offset: 0x808');
    expect(out).toContain('matchesCanonical: true');
    expect(out).toContain('supplierBonus: 20');
  });

  it('formatRegistryEntry handles missing field gracefully', () => {
    const partial = { os: SCAT_IDENTITY.os, pn: null, serial: SCAT_IDENTITY.serial };
    const out = formatRegistryEntry('new.bin', partial);
    expect(out).toContain('pn:     null');
  });

  it('every PINNED entry has os/pn/serial shape', () => {
    for (const [name, exp] of Object.entries(PINNED_RFH_FIXTURES)) {
      for (const field of ['os', 'pn', 'serial']) {
        expect(exp[field], `${name} ${field}`).toBeTruthy();
        expect(typeof exp[field].value).toBe('string');
        expect(typeof exp[field].offset).toBe('number');
      }
    }
  });
});
