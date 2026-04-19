import { describe, it, expect } from 'vitest';
import {
  REGISTRY,
  getRegistry,
  getRow,
  getRowByTx,
  vinWritableRows,
  noVinRows,
  unsupportedRows,
  sgwRequiredFor,
  partitionForVin,
} from '../moduleRegistry.js';

describe('moduleRegistry', () => {
  it('exposes the four primary bench modules used by the per-tab UIs', () => {
    for (const code of ['BCM', 'RFHUB', 'ECM', 'ADCM']) {
      const r = getRow(code);
      expect(r).not.toBeNull();
      expect(r.kind).toBe('vin-writable');
    }
    expect(getRow('BCM').tx).toBe(0x750);
    expect(getRow('RFHUB').tx).toBe(0x75F);
    expect(getRow('ECM').tx).toBe(0x7E0);
    expect(getRow('ADCM').tx).toBe(0x7A8);
  });

  it('marks SGW (0x74F) as unsupported — never written to directly', () => {
    const sgw = getRow('SGW');
    expect(sgw.kind).toBe('unsupported');
    expect(sgw.tx).toBe(0x74F);
  });

  it('exposes a populated no-vin bucket of passive sensor modules', () => {
    const noVin = noVinRows();
    expect(noVin.length).toBeGreaterThan(0);
    // BSM_RDR is the canonical AlfaOBD example — passive radar w/ no VIN slot.
    const r = getRow('BSM_RDR');
    expect(r).toBeTruthy();
    expect(r.kind).toBe('no-vin');
  });

  it('exposes a populated pending-w7 bucket flagged with accessLevel 0x03', () => {
    const w7 = REGISTRY.filter(r => r.unlockStatus === 'pending-w7');
    expect(w7.length).toBeGreaterThanOrEqual(2);
    for (const r of w7) {
      expect(r.kind).toBe('vin-writable');     // they WOULD be writable…
      expect(r.accessLevel).toBe(0x03);         // …at security access level 3,
      expect(r.unlockId).toMatch(/^w7_/);       // using a W7 cipher mapping.
    }
  });

  it('partitionForVin lists pending-w7 rows in BOTH writable and pendingW7 buckets', () => {
    // The batch runner attempts pending-w7 rows so they fail-soft with
    // an explicit "W7 cipher pending" reason instead of being silently
    // skipped — the pendingW7 bucket exists for the reference panel
    // that explains WHY the row will fail.
    const part = partitionForVin('1C4HJXEN5MW123456'); // non-SGW VIN
    const inWritable = part.writable.find(r => r.unlockStatus === 'pending-w7');
    expect(inWritable).toBeTruthy();
    expect(part.pendingW7.length).toBeGreaterThan(0);
    // And the same rows appear in BOTH buckets (referential overlap).
    const w7Codes = new Set(part.pendingW7.map(r => r.code));
    const writableW7 = part.writable.filter(r => w7Codes.has(r.code));
    expect(writableW7.length).toBe(part.pendingW7.length);
  });

  it('dedupes addresses by tx:rx (no two rows share a bus address)', () => {
    const seen = new Set();
    for (const r of REGISTRY) {
      const k = r.tx + ':' + r.rx;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it('every row carries the schema fields the engine needs', () => {
    for (const r of REGISTRY) {
      expect(typeof r.code).toBe('string');
      expect(typeof r.name).toBe('string');
      expect(typeof r.tx).toBe('number');
      expect(typeof r.rx).toBe('number');
      expect(['vin-writable', 'no-vin', 'unsupported']).toContain(r.kind);
      expect(['ready', 'pending-w7']).toContain(r.unlockStatus);
      expect(typeof r.accessLevel).toBe('number');
    }
  });

  it('vinWritableRows() and unsupportedRows() partition cleanly', () => {
    const w = vinWritableRows();
    const u = unsupportedRows();
    for (const r of w) expect(r.kind).toBe('vin-writable');
    for (const r of u) expect(r.kind).toBe('unsupported');
    expect(w.length).toBeGreaterThan(20); // we listed ~35
  });

  it('getRowByTx returns the canonical row for a known address', () => {
    expect(getRowByTx(0x750).code).toBe('BCM');
    expect(getRowByTx(0x7E0).code).toBe('ECM');
    expect(getRowByTx(0xDEAD)).toBeNull();
  });

  it('getRegistry returns a fresh array (caller mutation is safe)', () => {
    const a = getRegistry();
    const b = getRegistry();
    expect(a).not.toBe(b);
    a.push({ junk: true });
    expect(getRegistry().some(r => r.junk)).toBe(false);
  });
});

describe('sgwRequiredFor', () => {
  // A 2019 Charger VIN (model-year char position 10 = 'K' = 2019) and a
  // 2015 Challenger VIN (model-year char 'F' = 2015) — see vin.js / YR.
  const VIN_2019 = '2C3CDXGJ5KH123456';
  const VIN_2015 = '2C3CDZAG5FH123456';

  it('returns true for body-bus modules on a 2018+ VIN', () => {
    expect(sgwRequiredFor(getRow('BCM'),   VIN_2019)).toBe(true);
    expect(sgwRequiredFor(getRow('ECM'),   VIN_2019)).toBe(true);
    expect(sgwRequiredFor(getRow('RFHUB'), VIN_2019)).toBe(true);
  });

  it('returns false for SGW itself even on a 2018+ VIN', () => {
    expect(sgwRequiredFor(getRow('SGW'), VIN_2019)).toBe(false);
  });

  it('returns false for any module on a pre-2018 VIN', () => {
    for (const code of ['BCM', 'ECM', 'RFHUB', 'ADCM']) {
      expect(sgwRequiredFor(getRow(code), VIN_2015)).toBe(false);
    }
  });

  it('returns false for invalid VINs', () => {
    expect(sgwRequiredFor(getRow('BCM'), '')).toBe(false);
    expect(sgwRequiredFor(getRow('BCM'), 'NOT17CHARS')).toBe(false);
    expect(sgwRequiredFor(getRow('BCM'), null)).toBe(false);
  });
});

describe('partitionForVin', () => {
  const VIN_2019 = '2C3CDXGJ5KH123456';
  const VIN_2015 = '2C3CDZAG5FH123456';

  it('separates writable / blockedBySgw / unsupported / pendingW7 / noVin', () => {
    const p = partitionForVin(VIN_2019);
    expect(Array.isArray(p.writable)).toBe(true);
    expect(Array.isArray(p.blockedBySgw)).toBe(true);
    expect(Array.isArray(p.pendingW7)).toBe(true);
    expect(Array.isArray(p.noVin)).toBe(true);
    expect(Array.isArray(p.unsupported)).toBe(true);
    // SGW must always land in unsupported, never in writable.
    expect(p.unsupported.find(r => r.code === 'SGW')).toBeDefined();
    expect(p.writable.find(r => r.code === 'SGW')).toBeUndefined();
  });

  it('on a 2018+ VIN every writable row also appears in blockedBySgw', () => {
    const p = partitionForVin(VIN_2019);
    expect(p.blockedBySgw.length).toBe(p.writable.length);
    for (const r of p.writable) expect(r.sgwRequired).toBe(true);
  });

  it('on a pre-2018 VIN no row is sgw-blocked', () => {
    const p = partitionForVin(VIN_2015);
    expect(p.blockedBySgw.length).toBe(0);
    for (const r of p.writable) expect(r.sgwRequired).toBe(false);
  });
});
