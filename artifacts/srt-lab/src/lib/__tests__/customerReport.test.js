import { describe, it, expect } from 'vitest';
import { redactModuleReport, redactJobReport, isCustomerSafeField, plainEnglishStep } from '../customerReport.js';

const HEX16 = /[0-9A-Fa-f]{16}/;

const moduleReport = {
  kind: 'module', vin: '1C4HJXEN5MW123456',
  fields: [
    { category: 'VIN 1', value: '1C4HJXEN5MW123456' },
    { category: 'FOBIK KEYS', value: '2' },
    { category: 'FOBIK SLOTS', value: '8' },
    { category: 'SECRET KEY', value: 'A1B2C3D4E5F60718' },
    { category: 'VEHICLE SECRET', value: 'DEADBEEFCAFEBABE' },
    { category: 'FOBIK 0', value: '0011223344556677' },
    { category: 'IMMO 1', value: 'FFEEDDCCBBAA9988' },
  ],
  hasSecrets: true,
};

describe('customerReport redaction', () => {
  it('keeps customer-safe fields, drops every secret-category field', () => {
    const r = redactModuleReport(moduleReport);
    const cats = r.fields.map(f => f.category);
    expect(cats).toContain('VIN 1');
    expect(cats).toContain('FOBIK KEYS');
    expect(cats).not.toContain('SECRET KEY');
    expect(cats).not.toContain('VEHICLE SECRET');
    expect(cats).not.toContain('FOBIK 0');
    expect(r.hasSecrets).toBe(false);
  });

  it('NO 16-hex-char run survives in the customer module report (the whole point)', () => {
    const r = redactModuleReport(moduleReport);
    expect(HEX16.test(JSON.stringify(r.fields))).toBe(false);
  });

  it('drops a "safe" category whose value still carries a hex secret (scrub)', () => {
    expect(isCustomerSafeField({ category: 'PART NUMBER', value: '0011223344556677' })).toBe(false);
    expect(isCustomerSafeField({ category: 'PART NUMBER', value: '68402051AA' })).toBe(true);
    expect(isCustomerSafeField({ category: 'SECRET KEY', value: '2' })).toBe(false);
  });

  it('job report: drops audit log + census secrets, keeps plain-English work', () => {
    const jobReport = {
      kind: 'job', vin: '1C4HJXEN5MW123456', status: 'done', title: 'Job',
      signOff: { ready: true },
      steps: [
        { action: 'vinWrite', status: 'ok' },
        { action: 'sec16Patch', status: 'ok' },
        { action: 'verify', status: 'skipped' },
      ],
      events: [{ kind: 'note', payload: { note: 'secret A1B2C3D4E5F60718 typed by tech' } }],
      censusRows: [{ secretKey: 'DEADBEEFCAFEBABE' }],
    };
    const c = redactJobReport(jobReport, { keyCount: 2, keyIds: ['Fob 1', 'Fob 2'] });
    expect(c.events).toBeUndefined();
    expect(c.censusRows).toBeUndefined();
    expect(c.plainEnglishWork).toEqual(['Programmed the vehicle VIN', 'Synchronized module security data']);
    expect(c.keySummary).toEqual({ count: 2, ids: ['Fob 1', 'Fob 2'] });
    expect(HEX16.test(JSON.stringify(c))).toBe(false);
  });

  it('plainEnglishStep maps actions to customer language', () => {
    expect(plainEnglishStep({ action: 'vinWrite' })).toMatch(/VIN/i);
    expect(plainEnglishStep({ action: 'pairing' })).toMatch(/pair/i);
  });
});
