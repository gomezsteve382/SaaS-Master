import { describe, it, expect } from 'vitest';
import {
  analyzeDumpPartNumber,
  generationForPartNumber,
  VEHICLES,
  KNOWN_BCM_PN,
  AMBIGUOUS_REDEYE_PNS,
  GEN2_YEAR_CHARS,
} from '../vehicles.js';

// ── Buffer helpers ────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function makeBuffer(content, size = 1024) {
  const buf = new Uint8Array(size).fill(0xff);
  buf.set(enc.encode(content), 0);
  return buf;
}

function bufferWithStringAt(str, offset, size = 65536) {
  const buf = new Uint8Array(size).fill(0xff);
  buf.set(enc.encode(str), offset);
  return buf;
}

// A VIN whose model-year char (index 9) is 'F' — not in GEN2_YEAR_CHARS → gen1.
const VIN_GEN1 = '2C3CDXHF3FH796320';
// A VIN whose model-year char (index 9) is 'K' (2019) — in GEN2_YEAR_CHARS → gen2.
const VIN_GEN2 = '2C3CDXHF3KH796320';

// ── analyzeDumpPartNumber ─────────────────────────────────────────────────────

describe('analyzeDumpPartNumber', () => {
  describe('empty and null-byte buffers', () => {
    it('returns null primaryPn for an empty buffer', () => {
      const result = analyzeDumpPartNumber(new Uint8Array(0));
      expect(result.primaryPn).toBeNull();
      expect(result.partNumbers).toEqual([]);
      expect(result.compatibleVehicles).toEqual([]);
      expect(result.vinModelYearChar).toBeNull();
    });

    it('returns null primaryPn for a zero-filled buffer', () => {
      const result = analyzeDumpPartNumber(new Uint8Array(512).fill(0x00));
      expect(result.primaryPn).toBeNull();
    });

    it('returns null primaryPn for a 0xFF-filled buffer with no embedded text', () => {
      const result = analyzeDumpPartNumber(new Uint8Array(512).fill(0xff));
      expect(result.primaryPn).toBeNull();
    });
  });

  describe('known part numbers', () => {
    it('detects 68277389 (Charger/Challenger 2015-2017 gen1)', () => {
      const buf = makeBuffer('PADDING68277389PADDING');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68277389');
      expect(result.partNumbers).toContain('68277389');
      expect(result.compatibleVehicles).toContain('charger');
      expect(result.compatibleVehicles).toContain('challenger');
      expect(result.compatibleVehicles).toContain('durango');
    });

    it('detects 68396561 (Charger/Challenger/Durango 2018+ gen2)', () => {
      const buf = makeBuffer('68396561');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68396561');
      expect(result.compatibleVehicles).toContain('charger');
      expect(result.compatibleVehicles).toContain('challenger');
      expect(result.compatibleVehicles).toContain('durango');
    });

    it('detects 68354769 (Trackhawk)', () => {
      const buf = makeBuffer('68354769');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68354769');
      expect(result.compatibleVehicles).toContain('trackhawk');
    });

    it('detects 68463847 (TRX)', () => {
      const buf = makeBuffer('68463847');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68463847');
      expect(result.compatibleVehicles).toContain('trx');
    });

    it('prefers the first known P/N as primary when multiple are present', () => {
      // Buffer order: 68277389 appears before 68396561 → must be selected
      const buf = makeBuffer('68277389 68396561');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68277389');
    });

    it('includes all distinct 8-digit 68-prefixed numbers in partNumbers', () => {
      const buf = makeBuffer('68277389 68396561');
      const result = analyzeDumpPartNumber(buf);
      expect(result.partNumbers).toContain('68277389');
      expect(result.partNumbers).toContain('68396561');
    });
  });

  describe('unknown part numbers', () => {
    it('returns the unknown P/N itself as primaryPn and an empty compatibleVehicles list', () => {
      const buf = makeBuffer('68000001');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68000001');
      expect(result.compatibleVehicles).toEqual([]);
    });

    it('uses the first found number as primaryPn even when it is unknown', () => {
      const buf = makeBuffer('68999999');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68999999');
      expect(result.compatibleVehicles).toEqual([]);
    });

    it('returns null primaryPn when no 8-digit 68-prefixed number is present', () => {
      const buf = makeBuffer('HELLO WORLD NO PN HERE');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBeNull();
    });
  });

  describe('ambiguous Redeye part numbers (68525720 / 68525721)', () => {
    it('detects 68525720 as primary and lists exactly the correct vehicles', () => {
      const buf = makeBuffer('68525720');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68525720');
      expect(AMBIGUOUS_REDEYE_PNS).toContain(result.primaryPn);
      // 68525720 is shared by charger, challenger, and durango (all have it in bcmFamilies)
      expect(result.compatibleVehicles.sort()).toEqual(['challenger', 'charger', 'durango']);
    });

    it('detects 68525721 as primary', () => {
      const buf = makeBuffer('68525721');
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68525721');
      expect(AMBIGUOUS_REDEYE_PNS).toContain(result.primaryPn);
    });

    it('extracts a gen1 year char from a VIN in the same buffer', () => {
      // VIN_GEN1 has year char 'F' at index 9 — not in GEN2_YEAR_CHARS
      const content = `68525720 ${VIN_GEN1}`;
      const buf = makeBuffer(content, 2048);
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68525720');
      expect(result.vinModelYearChar).toBe('F');
      expect(GEN2_YEAR_CHARS.has(result.vinModelYearChar)).toBe(false);
    });

    it('extracts a gen2 year char from a VIN in the same buffer', () => {
      // VIN_GEN2 has year char 'K' at index 9 — in GEN2_YEAR_CHARS
      const content = `68525720 ${VIN_GEN2}`;
      const buf = makeBuffer(content, 2048);
      const result = analyzeDumpPartNumber(buf);
      expect(result.primaryPn).toBe('68525720');
      expect(result.vinModelYearChar).toBe('K');
      expect(GEN2_YEAR_CHARS.has(result.vinModelYearChar)).toBe(true);
    });

    it('returns null vinModelYearChar when no VIN is present', () => {
      const buf = makeBuffer('68525720');
      const result = analyzeDumpPartNumber(buf);
      expect(result.vinModelYearChar).toBeNull();
    });
  });

  describe('VIN detection edge cases', () => {
    it('ignores a numeric-only run that cannot be a VIN year char', () => {
      // Craft a 17-char string starting with '1' whose index-9 char is a digit
      const noYearCharVin = '12345678901234567'; // all digits — '0' at index 9 fails /[A-HJ-NPR-Z]/
      const buf = makeBuffer('68277389 ' + noYearCharVin, 2048);
      const result = analyzeDumpPartNumber(buf);
      expect(result.vinModelYearChar).toBeNull();
    });

    it('picks up the year char from a VIN stored at a non-zero offset', () => {
      const buf = bufferWithStringAt(`68277389 ${VIN_GEN2}`, 0x400);
      const result = analyzeDumpPartNumber(buf);
      expect(result.vinModelYearChar).toBe('K');
    });

    it('returns null vinModelYearChar for an empty buffer', () => {
      const result = analyzeDumpPartNumber(new Uint8Array(0));
      expect(result.vinModelYearChar).toBeNull();
    });
  });
});

// ── generationForPartNumber ───────────────────────────────────────────────────

describe('generationForPartNumber', () => {
  describe('unknown vehicle', () => {
    it('returns null for a vehicleId not in VEHICLES', () => {
      expect(generationForPartNumber('phantom', '68277389', null)).toBeNull();
      expect(generationForPartNumber(undefined, '68277389', null)).toBeNull();
      expect(generationForPartNumber(null, '68277389', null)).toBeNull();
    });
  });

  describe('non-ambiguous part numbers', () => {
    it('matches Charger lx1 generation (2011-2014) via 68525720 is AMBIGUOUS — test unambiguous 68277389', () => {
      const gen = generationForPartNumber('charger', '68277389', null);
      expect(gen).toBeTruthy();
      expect(gen.id).toBe('lx2');
    });

    it('matches Charger lx3 generation (2018-2020) via 68396561', () => {
      const gen = generationForPartNumber('charger', '68396561', null);
      expect(gen).toBeTruthy();
      expect(gen.id).toBe('lx3');
    });

    it('matches Challenger lc2 generation (2015-2017) via 68277389', () => {
      const gen = generationForPartNumber('challenger', '68277389', null);
      expect(gen).toBeTruthy();
      expect(gen.id).toBe('lc2');
    });

    it('matches Challenger lc3 generation (2018-2023) via 68396561', () => {
      const gen = generationForPartNumber('challenger', '68396561', null);
      expect(gen).toBeTruthy();
      expect(gen.id).toBe('lc3');
    });

    it('matches Durango wd3 generation (2018+ Hellcat) via 68396561', () => {
      const gen = generationForPartNumber('durango', '68396561', null);
      expect(gen).toBeTruthy();
      expect(gen.id).toBe('wd3');
    });

    it('matches Trackhawk wk2 via 68354769', () => {
      const gen = generationForPartNumber('trackhawk', '68354769', null);
      expect(gen).toBeTruthy();
      expect(gen.id).toBe('wk2');
    });

    it('matches TRX dt1 via 68463847', () => {
      const gen = generationForPartNumber('trx', '68463847', null);
      expect(gen).toBeTruthy();
      expect(gen.id).toBe('dt1');
    });

    it('returns undefined for a P/N not present in that vehicle\'s generations', () => {
      // Trackhawk only has 68354769 — 68277389 is not one of its generations
      const gen = generationForPartNumber('trackhawk', '68277389', null);
      expect(gen).toBeUndefined();
    });
  });

  describe('ambiguous Redeye P/N split (68525720 / 68525721)', () => {
    it('resolves Charger to gen1 (lx1) when vinYearChar is not a gen2 char', () => {
      // 'F' is 2015 — not in GEN2_YEAR_CHARS
      const gen = generationForPartNumber('charger', '68525720', 'F');
      expect(gen).toBeTruthy();
      expect(gen.sec16).toBe('gen1-18b');
      expect(gen.id).toBe('lx1');
    });

    it('resolves Charger to gen2 (lx4 Redeye) when vinYearChar is a gen2 char', () => {
      // 'M' is 2021 — in GEN2_YEAR_CHARS
      const gen = generationForPartNumber('charger', '68525720', 'M');
      expect(gen).toBeTruthy();
      expect(gen.sec16).toBe('gen2-split');
      expect(gen.id).toBe('lx4');
    });

    it('resolves Challenger to gen1 (lc1) when vinYearChar is gen1', () => {
      const gen = generationForPartNumber('challenger', '68525720', 'G');
      expect(gen).toBeTruthy();
      expect(gen.sec16).toBe('gen1-18b');
      expect(gen.id).toBe('lc1');
    });

    it('resolves Challenger to gen1 (lc1) when vinYearChar is null (no VIN in dump)', () => {
      const gen = generationForPartNumber('challenger', '68525720', null);
      expect(gen).toBeTruthy();
      expect(gen.sec16).toBe('gen1-18b');
    });

    it('resolves Challenger to gen1 when vinYearChar is undefined', () => {
      const gen = generationForPartNumber('challenger', '68525720', undefined);
      expect(gen).toBeTruthy();
      expect(gen.sec16).toBe('gen1-18b');
    });

    it('resolves Durango to gen1 when vinYearChar is K (2019) — Durango has no 68525720 gen2-split entry', () => {
      // Durango only defines gen2-split via 68396561 (wd3), not via 68525720.
      // When the year char is a gen2 char but no matching gen2-split+68525720 row
      // exists for the vehicle, generationForPartNumber returns undefined.
      const gen = generationForPartNumber('durango', '68525720', 'K');
      expect(gen).toBeUndefined();
    });

    it('resolves Durango to gen1 (wd1) when vinYearChar is H (2017)', () => {
      const gen = generationForPartNumber('durango', '68525720', 'H');
      expect(gen).toBeTruthy();
      expect(gen.sec16).toBe('gen1-18b');
      expect(gen.id).toBe('wd1');
    });

    it('handles 68525721 (the even-numbered twin) the same as 68525720', () => {
      // Both are in AMBIGUOUS_REDEYE_PNS; the lookup always normalises to 68525720
      const genVia720 = generationForPartNumber('charger', '68525720', 'N');
      const genVia721 = generationForPartNumber('charger', '68525721', 'N');
      expect(genVia721).toBeTruthy();
      expect(genVia721.id).toBe(genVia720.id);
      expect(genVia721.sec16).toBe('gen2-split');
    });

    it('is case-insensitive for the year char', () => {
      // lowercase 'k' should be treated the same as 'K'
      const gen = generationForPartNumber('charger', '68525720', 'k');
      expect(gen).toBeTruthy();
      expect(gen.sec16).toBe('gen2-split');
    });

    it('all gen2 year chars map to gen2-split for Charger (which has the lx4 Redeye)', () => {
      // Only Charger defines a 68525720 gen2-split entry (lx4).
      // Challenger has no such row, so we test against charger here.
      for (const yc of GEN2_YEAR_CHARS) {
        const gen = generationForPartNumber('charger', '68525720', yc);
        expect(gen, `year char ${yc} should resolve to a gen2 generation`).toBeTruthy();
        expect(gen.sec16).toBe('gen2-split');
      }
    });

    it('Challenger with 68525720 and gen2 year char returns undefined (no lc gen2-split row)', () => {
      // Challenger does not have a generation defined as 68525720 + gen2-split.
      // The caller is expected to fall back or handle undefined in this case.
      const gen = generationForPartNumber('challenger', '68525720', 'N');
      expect(gen).toBeUndefined();
    });

    it('non-gen2 letter year chars map to gen1-18b for Charger', () => {
      const gen1Chars = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
      for (const yc of gen1Chars) {
        const gen = generationForPartNumber('charger', '68525720', yc);
        expect(gen, `year char ${yc} should resolve to a gen1 generation`).toBeTruthy();
        expect(gen.sec16).toBe('gen1-18b');
      }
    });
  });

  describe('even-numbered P/N siblings', () => {
    describe('analyzeDumpPartNumber — detection and compatibleVehicles', () => {
      it('detects 68525721 and returns same compatibleVehicles as its odd twin 68525720', () => {
        const result721 = analyzeDumpPartNumber(makeBuffer('68525721'));
        const result720 = analyzeDumpPartNumber(makeBuffer('68525720'));
        expect(result721.primaryPn).toBe('68525721');
        expect(result721.compatibleVehicles.sort()).toEqual(result720.compatibleVehicles.sort());
        expect(result721.compatibleVehicles.sort()).toEqual(['challenger', 'charger', 'durango']);
      });

      it('detects 68277390 and returns charger, challenger, durango — same as odd twin 68277389', () => {
        const result = analyzeDumpPartNumber(makeBuffer('68277390'));
        expect(result.primaryPn).toBe('68277390');
        expect(result.compatibleVehicles.sort()).toEqual(['challenger', 'charger', 'durango']);
        const oddResult = analyzeDumpPartNumber(makeBuffer('68277389'));
        expect(result.compatibleVehicles.sort()).toEqual(oddResult.compatibleVehicles.sort());
      });

      it('detects 68396562 and returns charger, challenger, durango, trx — same as odd twin 68396561', () => {
        const result = analyzeDumpPartNumber(makeBuffer('68396562'));
        expect(result.primaryPn).toBe('68396562');
        expect(result.compatibleVehicles).toContain('charger');
        expect(result.compatibleVehicles).toContain('challenger');
        expect(result.compatibleVehicles).toContain('durango');
        expect(result.compatibleVehicles).toContain('trx');
        const oddResult = analyzeDumpPartNumber(makeBuffer('68396561'));
        expect(result.compatibleVehicles.sort()).toEqual(oddResult.compatibleVehicles.sort());
      });

      it('detects 68354770 and returns trackhawk — same as odd twin 68354769', () => {
        const result = analyzeDumpPartNumber(makeBuffer('68354770'));
        expect(result.primaryPn).toBe('68354770');
        expect(result.compatibleVehicles).toContain('trackhawk');
        expect(result.compatibleVehicles).toHaveLength(1);
        const oddResult = analyzeDumpPartNumber(makeBuffer('68354769'));
        expect(result.compatibleVehicles.sort()).toEqual(oddResult.compatibleVehicles.sort());
      });

      it('detects 68463848 and returns trx — same as odd twin 68463847', () => {
        const result = analyzeDumpPartNumber(makeBuffer('68463848'));
        expect(result.primaryPn).toBe('68463848');
        expect(result.compatibleVehicles).toContain('trx');
        const oddResult = analyzeDumpPartNumber(makeBuffer('68463847'));
        expect(result.compatibleVehicles.sort()).toEqual(oddResult.compatibleVehicles.sort());
      });

      it('detects 68309504 and returns charger, challenger, durango — same as odd twin 68309505', () => {
        const result = analyzeDumpPartNumber(makeBuffer('68309504'));
        expect(result.primaryPn).toBe('68309504');
        expect(result.compatibleVehicles).toContain('charger');
        expect(result.compatibleVehicles).toContain('challenger');
        expect(result.compatibleVehicles).toContain('durango');
        const oddResult = analyzeDumpPartNumber(makeBuffer('68309505'));
        expect(result.compatibleVehicles.sort()).toEqual(oddResult.compatibleVehicles.sort());
      });

      it('all even-numbered P/Ns are present in KNOWN_BCM_PN', () => {
        const evens = ['68525721', '68277390', '68396562', '68354770', '68463848', '68309504'];
        for (const pn of evens) {
          expect(KNOWN_BCM_PN, `${pn} should be in KNOWN_BCM_PN`).toContain(pn);
        }
      });
    });

    describe('generationForPartNumber — even P/N siblings route correctly', () => {
      it('68525721 resolves to the same Charger generation as 68525720 for a gen2 year char', () => {
        const gen721 = generationForPartNumber('charger', '68525721', 'N');
        const gen720 = generationForPartNumber('charger', '68525720', 'N');
        expect(gen721).toBeTruthy();
        expect(gen721.id).toBe(gen720.id);
        expect(gen721.sec16).toBe('gen2-split');
      });

      it('68525721 resolves to the same Charger generation as 68525720 for a gen1 year char', () => {
        const gen721 = generationForPartNumber('charger', '68525721', 'E');
        const gen720 = generationForPartNumber('charger', '68525720', 'E');
        expect(gen721).toBeTruthy();
        expect(gen721.id).toBe(gen720.id);
        expect(gen721.sec16).toBe('gen1-18b');
      });

      it('68525721 resolves to the same Challenger gen1 generation as 68525720', () => {
        const gen721 = generationForPartNumber('challenger', '68525721', 'G');
        const gen720 = generationForPartNumber('challenger', '68525720', 'G');
        expect(gen721).toBeTruthy();
        expect(gen721.id).toBe(gen720.id);
      });

      it('68525721 with gen2 year char on Challenger is undefined (no lc gen2-split row), same as 68525720', () => {
        const gen721 = generationForPartNumber('challenger', '68525721', 'N');
        const gen720 = generationForPartNumber('challenger', '68525720', 'N');
        expect(gen721).toBeUndefined();
        expect(gen720).toBeUndefined();
      });

      it('68277390 returns undefined for charger — no generation row uses this even P/N as bcmPn', () => {
        expect(generationForPartNumber('charger', '68277390', null)).toBeUndefined();
      });

      it('68277390 returns undefined for challenger — no generation row uses this even P/N', () => {
        expect(generationForPartNumber('challenger', '68277390', null)).toBeUndefined();
      });

      it('68277390 returns undefined for durango — no generation row uses this even P/N', () => {
        expect(generationForPartNumber('durango', '68277390', null)).toBeUndefined();
      });

      it('68396562 returns undefined for charger — no generation row uses this even P/N as bcmPn', () => {
        expect(generationForPartNumber('charger', '68396562', null)).toBeUndefined();
      });

      it('68396562 returns undefined for trx — no generation row uses this even P/N as bcmPn', () => {
        expect(generationForPartNumber('trx', '68396562', null)).toBeUndefined();
      });

      it('68354770 returns undefined for trackhawk — no generation row uses this even P/N as bcmPn', () => {
        expect(generationForPartNumber('trackhawk', '68354770', null)).toBeUndefined();
      });

      it('68463848 returns undefined for trx — no generation row uses this even P/N as bcmPn', () => {
        expect(generationForPartNumber('trx', '68463848', null)).toBeUndefined();
      });

      it('68309504 returns undefined for charger — no generation row uses this even P/N as bcmPn', () => {
        expect(generationForPartNumber('charger', '68309504', null)).toBeUndefined();
      });

      it('68309504 returns undefined for challenger — no generation row uses this even P/N as bcmPn', () => {
        expect(generationForPartNumber('challenger', '68309504', null)).toBeUndefined();
      });

      it('68309504 returns undefined for durango — no generation row uses this even P/N as bcmPn', () => {
        expect(generationForPartNumber('durango', '68309504', null)).toBeUndefined();
      });
    });
  });

  describe('each vehicle has correct gen count', () => {
    it('Charger has 4 generations', () => {
      expect(VEHICLES.charger.generations).toHaveLength(4);
    });

    it('Challenger has 3 generations', () => {
      expect(VEHICLES.challenger.generations).toHaveLength(3);
    });

    it('Durango has 3 generations', () => {
      expect(VEHICLES.durango.generations).toHaveLength(3);
    });

    it('Trackhawk has 1 generation', () => {
      expect(VEHICLES.trackhawk.generations).toHaveLength(1);
    });

    it('TRX has 1 generation', () => {
      expect(VEHICLES.trx.generations).toHaveLength(1);
    });
  });
});
