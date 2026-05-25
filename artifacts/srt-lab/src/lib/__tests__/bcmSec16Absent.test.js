/**
 * Task #815 — BCM SEC16 absent (ALERT_NO_SECURITY / VIN-only edition).
 *
 * Regression tests for the phantom-SEC16 fix. `resolveBcmSec16` now sets
 * `sec16Absent = true` (and `bytes = null`) only when EVERY candidate is
 * structurally blank (all-FF / all-00) — i.e. a fully virgin factory module.
 *
 * IMPORTANT: low-entropy but non-blank flat slices (e.g. the 6.2 Charger
 * bench set's `00 00 00 00 00 00 00 31 3E 00 10 00 18 00 0A 00` with only
 * 5 non-zero/non-FF bytes) ARE authoritative vehicle secrets confirmed by
 * FCA SINCRO and must NOT trigger sec16Absent.
 *
 * The true virgin case is a BCM whose flat slice (and all split/mirror
 * records) are entirely 0xFF or entirely 0x00.
 */
import { describe, it, expect } from 'vitest';
import { parseModule, resolveBcmSec16 } from '../parseModule.js';
import { crossValidate } from '../crossValidate.js';
import { engParseBcm } from '../../tabs/ModuleSync.jsx';
import { makeBcm } from '../__fixtures__/buildFixtures.js';

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}
function hexToBytes(s) {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/* Bench BCM flat slice — 9 zeros + 5 non-zero/non-FF bytes + 2 zeros.
 * This is the real SEC16 from the 6.2 Charger bench set, confirmed by
 * FCA SINCRO. It is NOT blank and must NOT trigger sec16Absent. */
const BENCH_FLAT_NOISE = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x31,
  0x3E, 0x00, 0x10, 0x00, 0x18, 0x00, 0x0A, 0x00,
]);

/* A real 128-bit vehicle secret (high-entropy, ≥ 6 distinct bytes). */
const REAL_SEC16 = hexToBytes('C42F3C79941582C3823530BAE7C5A108');

/* Build a 65 KB BCM with no split records, no mirror records, and the given
 * flat slice. Used for both the "bench low-entropy real SEC16" and "blank" cases. */
function makeBcmBufWithFlat({ flatSlice = BENCH_FLAT_NOISE } = {}) {
  const buf = makeBcm({ vehicleSecret: null });
  for (let j = 0x81A0; j < 0x8200; j++) buf[j] = 0xFF;
  for (let k = 0; k < 16; k++) buf[0x40C9 + k] = flatSlice[k];
  return buf;
}

/* A truly blank BCM — flat slice all-FF, no split/mirror records. */
function makeBlankBcmBuf() {
  return makeBcmBufWithFlat({ flatSlice: new Uint8Array(16).fill(0xFF) });
}

/* Build a 65 KB BCM with a real paired high-entropy flat SEC16. */
function makePairedBcmBuf({ sec16 = REAL_SEC16 } = {}) {
  const le = new Uint8Array(16);
  for (let k = 0; k < 16; k++) le[k] = sec16[15 - k];
  return makeBcmBufWithFlat({ flatSlice: le });
}

/* -----------------------------------------------------------------------
 * 1. resolveBcmSec16 — blank gate (Task #815)
 * --------------------------------------------------------------------- */

describe('resolveBcmSec16 — blank gate (Task #815)', () => {
  it('returns sec16Absent=false for bench flat noise (non-blank, 5 real bytes)', () => {
    /* The 6.2 Charger bench flat slice is NOT blank — blank check passes
     * and the flat candidate is chosen as the authoritative SEC16. */
    const buf = makeBcmBufWithFlat({ flatSlice: BENCH_FLAT_NOISE });
    const r = resolveBcmSec16(buf);
    expect(r.sec16Absent).toBe(false);
    expect(r.bytes).not.toBeNull();
    expect(r.source).toBe('flat');
    expect(hex(r.bytes)).toBe('00000000000000313E00100018000A00');
    expect(r.blank).toBe(false);
  });

  it('returns sec16Absent=true for a fully blank flat slice (all-FF)', () => {
    const buf = makeBlankBcmBuf();
    const r = resolveBcmSec16(buf);
    expect(r.sec16Absent).toBe(true);
    expect(r.bytes).toBeNull();
    expect(r.source).toBeNull();
    expect(r.blank).toBe(true);
  });

  it('returns sec16Absent=true for a fully blank flat slice (all-00)', () => {
    const buf = makeBcmBufWithFlat({ flatSlice: new Uint8Array(16).fill(0x00) });
    const r = resolveBcmSec16(buf);
    expect(r.sec16Absent).toBe(true);
    expect(r.bytes).toBeNull();
    expect(r.blank).toBe(true);
  });

  it('returns sec16Absent=false for a real high-entropy flat SEC16', () => {
    const buf = makePairedBcmBuf({ sec16: REAL_SEC16 });
    const r = resolveBcmSec16(buf);
    expect(r.sec16Absent).toBe(false);
    expect(r.bytes).not.toBeNull();
    expect(r.source).toBe('flat');
  });
});

/* -----------------------------------------------------------------------
 * 2. parseModule BCM branch — sec16Absent propagation
 * --------------------------------------------------------------------- */

describe('parseModule BCM — sec16Absent propagation (Task #815)', () => {
  it('sets sec16Absent=true and vehicleSecret=null for a truly blank BCM (all-FF)', () => {
    const buf = makeBlankBcmBuf();
    const info = parseModule(buf, 'blank.bin');
    expect(info.sec16Absent).toBe(true);
    expect(info.vehicleSecret).toBeNull();
    expect(info.bcmSec16.sec16Absent).toBe(true);
    expect(info.bcmSec16.bytes).toBeNull();
  });

  it('does NOT set sec16Absent for a BCM with a low-entropy but non-blank flat SEC16', () => {
    /* The bench flat noise IS an authoritative SEC16 — must not be phantom-gated. */
    const buf = makeBcmBufWithFlat({ flatSlice: BENCH_FLAT_NOISE });
    const info = parseModule(buf, 'bench.bin');
    expect(info.sec16Absent).toBe(false);
    expect(info.vehicleSecret).not.toBeNull();
    expect(info.vehicleSecret.bytes).not.toBeNull();
    expect(hex(info.vehicleSecret.bytes)).toBe('00000000000000313E00100018000A00');
  });

  it('does NOT set sec16Absent for a BCM with a real high-entropy flat SEC16', () => {
    const buf = makePairedBcmBuf({ sec16: REAL_SEC16 });
    const info = parseModule(buf, 'paired.bin');
    expect(info.sec16Absent).toBe(false);
    expect(info.vehicleSecret).not.toBeNull();
    expect(info.vehicleSecret.bytes).not.toBeNull();
  });
});

/* -----------------------------------------------------------------------
 * 3. crossValidate — no phantom MISMATCH for sec16Absent BCM
 * --------------------------------------------------------------------- */

describe('crossValidate — sec16Absent BCM (Task #815)', () => {
  function makeRfhubModule(sec16 = REAL_SEC16) {
    return {
      type: 'RFHUB',
      vins: [{ vin: 'TEST1234567890123' }],
      vehicleSecret: {
        offset: 0x050E,
        bytes: sec16,
        hex: hex(sec16),
        source: 'gen2-slot1',
      },
      sec16s: [{
        raw: sec16,
        hex: hex(sec16),
        blank: false,
      }],
      sec16valid: true,
      fobikSlots: 4,
      securityMarkers: 3,
      rfhVin92: null,
      skb: false,
      skey: new Uint8Array(16),
    };
  }

  it('emits absent note (not MISMATCH) when BCM is truly blank (sec16Absent=true)', () => {
    const bcmMod = parseModule(makeBlankBcmBuf(), 'blank.bin');
    const rfhMod = makeRfhubModule(REAL_SEC16);

    const { issues, warnings, passed } = crossValidate([bcmMod, rfhMod]);

    const hasMismatch = [...issues, ...warnings].some(m =>
      /RFHUB.*BCM.*MISMATCH|BCM.*RFHUB.*MISMATCH|vehicle secret.*MISMATCH/i.test(m)
    );
    expect(hasMismatch).toBe(false);

    const hasAbsentNote = [...issues, ...warnings, ...passed].some(m =>
      /absent/i.test(m) && /not evaluable|ALERT_NO_SECURITY/i.test(m)
    );
    expect(hasAbsentNote).toBe(true);
  });

  it('does NOT emit phantom BCM SEC16 → PCM SEC6 issue for sec16Absent BCM', () => {
    const bcmMod = parseModule(makeBlankBcmBuf(), 'blank.bin');
    const pcmMod = {
      type: 'GPEC2A',
      vins: [],
      pcmSec6: {
        offset: 0x3C8,
        raw: new Uint8Array(6).fill(0xFF),
        hex: 'FF FF FF FF FF FF',
        populated: false,
        damaged: true,
        immoState: 'IMMO_DAMAGED',
      },
      skb: true, zzzzTamper: null, keyConsistent: true, skimByte: 0x80,
      secretKey: { bytes: new Uint8Array(8).fill(0xFF) },
    };

    const { issues } = crossValidate([bcmMod, pcmMod]);

    const hasPhantomIssue = issues.some(m =>
      /BCM SEC16.*SEC6.*PCM.*paired|PCM never paired/i.test(m)
    );
    expect(hasPhantomIssue).toBe(false);
  });

  it('emits real MISMATCH for a paired BCM that genuinely disagrees with the RFHUB', () => {
    const bcmBuf = makePairedBcmBuf({ sec16: REAL_SEC16 });
    const bcmMod = parseModule(bcmBuf, 'paired.bin');

    const differentSec = hexToBytes('DEADBEEF12345678AABBCCDDEEFF0011');
    const rfhMod = makeRfhubModule(differentSec);

    const { issues } = crossValidate([bcmMod, rfhMod]);

    const hasMismatch = issues.some(m =>
      /RFHUB.*BCM vehicle secret.*MISMATCH|BCM.*vehicle secret.*MISMATCH/i.test(m)
    );
    expect(hasMismatch).toBe(true);
  });

  it('does NOT emit MISMATCH for a low-entropy non-blank BCM vs a different RFHUB', () => {
    /* bench flat noise is a valid SEC16 and should produce a real MISMATCH
     * (not be silenced as phantom) when it disagrees with the RFHUB. */
    const bcmBuf = makeBcmBufWithFlat({ flatSlice: BENCH_FLAT_NOISE });
    const bcmMod = parseModule(bcmBuf, 'bench.bin');
    const rfhMod = makeRfhubModule(REAL_SEC16);

    const { issues } = crossValidate([bcmMod, rfhMod]);

    /* The flat slice stored in LE; reverse() gives BE for comparison.
     * Since BENCH_FLAT_NOISE reversed ≠ REAL_SEC16, a real MISMATCH is expected. */
    const hasMismatch = issues.some(m => /MISMATCH/i.test(m));
    expect(hasMismatch).toBe(true);
  });
});

/* -----------------------------------------------------------------------
 * 4. engParseBcm — sec16Absent flag
 * --------------------------------------------------------------------- */

describe('engParseBcm — sec16Absent flag (Task #815)', () => {
  it('sets sec16Absent=true for a truly blank BCM (all-FF flat, no split, no mirrors)', () => {
    const buf = makeBlankBcmBuf();
    const parsed = engParseBcm(buf, 'blank.bin');
    expect(parsed.sec16Absent).toBe(true);
    expect(parsed.sec16Records).toHaveLength(0);
    expect(parsed.mirrorsPopulated ?? 0).toBe(0);
  });

  it('sets sec16Absent=false for a BCM with a non-blank low-entropy flat SEC16', () => {
    /* The bench flat noise is not blank, so engParseBcm must not mark it absent. */
    const buf = makeBcmBufWithFlat({ flatSlice: BENCH_FLAT_NOISE });
    const parsed = engParseBcm(buf, 'bench.bin');
    expect(parsed.sec16Absent).toBe(false);
  });

  it('sets sec16Absent=false for a BCM that has valid legacy mirrors', () => {
    function crc16(data) {
      let c = 0xFFFF;
      for (const b of data) {
        c ^= b << 8;
        for (let j = 0; j < 8; j++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
      }
      return c & 0xFFFF;
    }
    const buf = makeBlankBcmBuf();
    buf[0x00C8] = 0x01;
    for (let k = 0; k < 16; k++) buf[0x00C9 + k] = REAL_SEC16[k];
    buf[0x00D9] = 0x8F; buf[0x00DA] = 0xFF; buf[0x00DB] = 0xFF;
    const crcInput = new Uint8Array(20);
    crcInput[0] = 0x01;
    for (let k = 0; k < 16; k++) crcInput[1 + k] = REAL_SEC16[k];
    crcInput[17] = 0x8F; crcInput[18] = 0xFF; crcInput[19] = 0xFF;
    const crc = crc16(crcInput);
    buf[0x00DC] = (crc >> 8) & 0xFF;
    buf[0x00DD] = crc & 0xFF;

    const parsed = engParseBcm(buf, 'legacy_mirror.bin');
    expect(parsed.sec16Absent).toBe(false);
    expect(parsed.mirrorsPopulated).toBeGreaterThan(0);
  });

  it('allBlank BCM (all-FF) also has sec16Absent=true', () => {
    const buf = makeBlankBcmBuf();
    const parsed = engParseBcm(buf, 'all_ff.bin');
    expect(parsed.sec16Absent).toBe(true);
  });
});
