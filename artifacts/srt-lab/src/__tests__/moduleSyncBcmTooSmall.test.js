/**
 * Task #370 regression — Sincro BCM inspector and `parseModule` helper must
 * reject undersized BCM dumps (e.g. the 2,538-byte EEPROM-slice case) with a
 * structured "tooSmall" result instead of falling through and surfacing fake
 * VIN / SEC16 / SEC6 errors.
 */
import { describe, it, expect } from 'vitest';
import { BCM_MIN_SIZE, bcmTooSmall } from '../lib/parseModule.js';
import { engParseBcm } from '../tabs/ModuleSync.jsx';

describe('BCM size guard', () => {
  it('publishes a 64 KB minimum constant', () => {
    expect(BCM_MIN_SIZE).toBe(65536);
  });

  it.each([
    [0,    'empty buffer'],
    [2538, 'EEPROM-slice fragment'],
    [BCM_MIN_SIZE - 1, 'one byte short of the minimum'],
  ])('bcmTooSmall flags a %i-byte buffer (%s)', (size) => {
    const result = bcmTooSmall(new Uint8Array(size), 'fragment.bin');
    expect(result).toEqual({ tooSmall: true, size, min: BCM_MIN_SIZE, ext: '.bin' });
  });

  it('bcmTooSmall accepts a buffer at the minimum size', () => {
    expect(bcmTooSmall(new Uint8Array(BCM_MIN_SIZE), 'full.bin')).toBeNull();
  });

  it('bcmTooSmall captures the file extension when present', () => {
    expect(bcmTooSmall(new Uint8Array(10), 'CHUNK.EPROM').ext).toBe('.eprom');
    expect(bcmTooSmall(new Uint8Array(10), 'noext').ext).toBe('');
  });
});

describe('engParseBcm short-circuits on undersized buffers', () => {
  it.each([
    [0,    'empty buffer'],
    [2538, '2,538-byte fragment from the original report'],
  ])('returns a tooSmall result for a %i-byte buffer (%s)', (size) => {
    const parsed = engParseBcm(new Uint8Array(size), 'fragment.bin');
    expect(parsed.tooSmall).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.size).toBe(size);
    expect(parsed.minSize).toBe(BCM_MIN_SIZE);
    expect(parsed.fileExt).toBe('.bin');
    // The misleading VIN / SEC16 / SEC6 fields must NOT be populated for an
    // undersized file — the whole point of Task #370 is that the inspector
    // doesn't render them.
    expect(parsed.vinSlots).toEqual([]);
    expect(parsed.sec16Records).toEqual([]);
    expect(parsed.sec16Mirrors).toEqual([]);
    expect(parsed.vin).toBeNull();
    expect(parsed.sec16Hex).toBeNull();
    expect(parsed.banks).toBeNull();
  });

  it('does not short-circuit a buffer at the minimum size', () => {
    const parsed = engParseBcm(new Uint8Array(BCM_MIN_SIZE), 'full.bin');
    expect(parsed.tooSmall).toBeUndefined();
    expect(parsed.size).toBe(BCM_MIN_SIZE);
  });
});

describe('engParseBcm tooSmall result shape (Task #370)', () => {
  /* The Sincro inspector card, the Inspection Result banner, and the
   * "Sync Actions disabled" notice all gate on these fields. Locking down
   * the shape here ensures any future refactor of the parser cannot quietly
   * break the UX hard-stop the task was filed for. */
  const parsed = engParseBcm(new Uint8Array(2538), 'fragment.bin');

  it('exposes the size, minSize and fileExt the UI cards need', () => {
    expect(parsed.tooSmall).toBe(true);
    expect(parsed.size).toBe(2538);
    expect(parsed.minSize).toBe(BCM_MIN_SIZE);
    expect(parsed.fileExt).toBe('.bin');
  });

  it('marks the parse not-ok so bothReady is false (SyncActions card hidden)', () => {
    expect(parsed.ok).toBe(false);
  });

  it('omits every field the inspector would otherwise render as a fake verdict', () => {
    expect(parsed.vin).toBeNull();
    expect(parsed.vinSlots).toEqual([]);
    expect(parsed.sec16Records).toEqual([]);
    expect(parsed.sec16Mirrors).toEqual([]);
    expect(parsed.sec16Hex).toBeNull();
    expect(parsed.banks).toBeNull();
  });
});
