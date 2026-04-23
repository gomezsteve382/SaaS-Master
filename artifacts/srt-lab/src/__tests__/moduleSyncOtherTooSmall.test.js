/**
 * Task #372 regression — extends the BCM size-guard pattern from Task #370
 * to PCM, RFHUB, and 95640 module slots. Each engParseX must short-circuit
 * undersized buffers with a structured `tooSmall` result so the inspector
 * renders the "this isn't a full <module> dump" card instead of partial
 * VIN / SEC verdicts.
 */
import { describe, it, expect } from 'vitest';
import {
  MODULE_MIN_SIZES,
  MODULE_MIN_LABELS,
  moduleTooSmall,
} from '../lib/parseModule.js';
import {
  engParseRfh,
  engParsePcm,
  engParseEep95640,
} from '../tabs/ModuleSync.jsx';

describe('moduleTooSmall helper (Task #372)', () => {
  it('publishes per-type minimums derived from CANONICAL_SIZES_BY_TYPE', () => {
    expect(MODULE_MIN_SIZES.BCM).toBe(65536);
    expect(MODULE_MIN_SIZES.RFHUB).toBe(2048);
    expect(MODULE_MIN_SIZES.PCM).toBe(4096);
    expect(MODULE_MIN_SIZES.GPEC2A).toBe(4096);
    expect(MODULE_MIN_SIZES['95640']).toBe(8192);
  });

  it('returns null for buffers at or above the canonical minimum', () => {
    expect(moduleTooSmall(new Uint8Array(2048), 'RFHUB', 'rfh.bin')).toBeNull();
    expect(moduleTooSmall(new Uint8Array(4096), 'PCM', 'pcm.bin')).toBeNull();
    expect(moduleTooSmall(new Uint8Array(8192), '95640', 'eep.bin')).toBeNull();
  });

  it('returns null for unknown module types so callers degrade safely', () => {
    expect(moduleTooSmall(new Uint8Array(1), 'UNKNOWN', 'x.bin')).toBeNull();
  });

  it.each([
    ['RFHUB', 'rfh.bin'],
    ['PCM', 'pcm.bin'],
    ['95640', 'eep.bin'],
    ['GPEC2A', 'gpec.bin'],
  ])('flags a 1-byte buffer for %s with structured fields', (type, name) => {
    const r = moduleTooSmall(new Uint8Array(1), type, name);
    expect(r).toEqual({
      tooSmall: true,
      type,
      size: 1,
      min: MODULE_MIN_SIZES[type],
      ext: '.bin',
      label: MODULE_MIN_LABELS[type],
    });
  });

  it('captures the file extension when present (case-insensitive)', () => {
    expect(moduleTooSmall(new Uint8Array(0), 'RFHUB', 'CHUNK.EPROM').ext).toBe('.eprom');
    expect(moduleTooSmall(new Uint8Array(0), 'PCM', 'noext').ext).toBe('');
  });
});

describe('engParseRfh short-circuits on undersized buffers (Task #372)', () => {
  it.each([
    [0,    'empty buffer'],
    [512,  'EEPROM-slice fragment'],
    [MODULE_MIN_SIZES.RFHUB - 1, 'one byte short of the 2 KB minimum'],
  ])('returns a tooSmall result for a %i-byte buffer (%s)', (size) => {
    const parsed = engParseRfh(new Uint8Array(size), 'fragment.bin');
    expect(parsed.tooSmall).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('RFHUB');
    expect(parsed.size).toBe(size);
    expect(parsed.minSize).toBe(MODULE_MIN_SIZES.RFHUB);
    expect(parsed.fileExt).toBe('.bin');
    expect(parsed.minLabel).toBe(MODULE_MIN_LABELS.RFHUB);
    // Fields the inspector would otherwise render as a fake verdict.
    expect(parsed.vinSlots).toEqual([]);
    expect(parsed.vin).toBeNull();
    expect(parsed.sec16).toBeNull();
    expect(parsed.format).toBe('unknown');
  });

  it('does not short-circuit a buffer at the 2 KB minimum', () => {
    const parsed = engParseRfh(new Uint8Array(MODULE_MIN_SIZES.RFHUB), 'rfh.bin');
    expect(parsed.tooSmall).toBeUndefined();
    expect(parsed.size).toBe(MODULE_MIN_SIZES.RFHUB);
  });
});

describe('engParsePcm short-circuits on undersized buffers (Task #372)', () => {
  it.each([
    [0,    'empty buffer'],
    [1024, 'kilobyte fragment'],
    [MODULE_MIN_SIZES.PCM - 1, 'one byte short of the 4 KB minimum'],
  ])('returns a tooSmall result for a %i-byte buffer (%s)', (size) => {
    const parsed = engParsePcm(new Uint8Array(size), 'fragment.bin');
    expect(parsed.tooSmall).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('PCM');
    expect(parsed.size).toBe(size);
    expect(parsed.minSize).toBe(MODULE_MIN_SIZES.PCM);
    expect(parsed.fileExt).toBe('.bin');
    expect(parsed.minLabel).toBe(MODULE_MIN_LABELS.PCM);
    expect(parsed.vinSlots).toEqual([]);
    expect(parsed.vin).toBeNull();
    expect(parsed.currentVin).toBeNull();
    expect(parsed.originalVin).toBeNull();
    expect(parsed.sec6).toBeNull();
    expect(parsed.immoOk).toBe(false);
    expect(parsed.immoDamaged).toBe(false);
  });

  it('does not short-circuit a buffer at the 4 KB minimum', () => {
    const parsed = engParsePcm(new Uint8Array(MODULE_MIN_SIZES.PCM), 'pcm.bin');
    expect(parsed.tooSmall).toBeUndefined();
    expect(parsed.size).toBe(MODULE_MIN_SIZES.PCM);
  });
});

describe('engParseEep95640 short-circuits on undersized buffers (Task #372)', () => {
  it.each([
    [0,    'empty buffer'],
    [4096, 'half-chip fragment'],
    [MODULE_MIN_SIZES['95640'] - 1, 'one byte short of the 8 KB minimum'],
  ])('returns a tooSmall result for a %i-byte buffer (%s)', (size) => {
    const parsed = engParseEep95640(new Uint8Array(size), 'fragment.bin');
    expect(parsed.tooSmall).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('95640');
    expect(parsed.size).toBe(size);
    expect(parsed.minSize).toBe(MODULE_MIN_SIZES['95640']);
    expect(parsed.fileExt).toBe('.bin');
    expect(parsed.minLabel).toBe(MODULE_MIN_LABELS['95640']);
    expect(parsed.vinSlots).toEqual([]);
    expect(parsed.vin).toBeNull();
    expect(parsed.secretKey).toBeNull();
    expect(parsed.bcmSec16).toBeNull();
  });

  it('does not short-circuit a buffer at the 8 KB minimum', () => {
    const parsed = engParseEep95640(new Uint8Array(MODULE_MIN_SIZES['95640']), 'eep.bin');
    expect(parsed.tooSmall).toBeUndefined();
    expect(parsed.size).toBe(MODULE_MIN_SIZES['95640']);
  });
});
