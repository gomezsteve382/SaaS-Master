import { describe, it, expect } from 'vitest';
import { deriveMoparRadioCode, moparRadioFamilies } from '../moparRadioCode.js';

describe('moparRadioCode — family detection', () => {
  it('refuses an unknown family prefix with a clear reason', () => {
    const r = deriveMoparRadioCode('XYZ12345');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not in the covered set/i);
    expect(r.family).toBe('XYZ');
  });

  it('refuses a malformed serial', () => {
    expect(deriveMoparRadioCode('').ok).toBe(false);
    expect(deriveMoparRadioCode('RBZ').ok).toBe(false);   // no numeric block
    expect(deriveMoparRadioCode('1234').ok).toBe(false);  // no alpha prefix
  });

  it('prefers longest matching prefix (RA4 beats RA)', () => {
    const r = deriveMoparRadioCode('RA412345');
    expect(r.ok).toBe(true);
    expect(r.family).toBe('RA4');
  });

  it('exposes the supported family list', () => {
    const fams = moparRadioFamilies();
    expect(fams.length).toBeGreaterThanOrEqual(8);
    expect(fams.map((f) => f.key)).toEqual(
      expect.arrayContaining(['RBZ', 'RHB', 'REJ', 'REC', 'RAQ', 'RA2', 'RA3', 'RA4']),
    );
  });
});

describe('moparRadioCode — pinned vectors', () => {
  // Pinned outputs of the current deterministic algorithm. They lock the
  // mul/add constants in moparRadioCode.js so an accidental tweak trips
  // a loud failure — bench validation happens off-platform.
  const vectors = [
    ['RBZ12345',  '7176'],
    ['RHB10000',  '1331'],
    ['REJ00077',  '1592'],
    ['REC00001',  '2002'],
    ['RAQ54321',  '2342'],
    ['RA200000',  '2459'],
    ['RA399999',  '2896'],
    ['RA412345',  '5662'],
  ];
  for (const [serial, pin] of vectors) {
    it(`${serial} → ${pin}`, () => {
      const r = deriveMoparRadioCode(serial);
      expect(r.ok).toBe(true);
      expect(r.pin).toBe(pin);
      expect(r.pin).toMatch(/^\d{4}$/);
    });
  }

  it('is stable across whitespace and dashes in the printed label', () => {
    const a = deriveMoparRadioCode('RBZ12345');
    const b = deriveMoparRadioCode(' rbz-12345 ');
    expect(b.ok).toBe(true);
    expect(b.pin).toBe(a.pin);
  });

  it('always returns a 4-digit PIN (zero-padded)', () => {
    for (let i = 0; i < 16; i++) {
      const r = deriveMoparRadioCode(`RBZ${i.toString().padStart(5, '0')}`);
      expect(r.ok).toBe(true);
      expect(r.pin).toMatch(/^\d{4}$/);
    }
  });
});
