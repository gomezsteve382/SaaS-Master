/**
 * Unit tests for detectCorruptFill — the upload-time sanity guard that rejects
 * tool-error fill patterns before they reach the module parser.
 *
 * Canonical incident: seven 128 KB files filled entirely with the repeated
 * string "OBDSTAR6" were stored as real BCM dumps and went undetected for
 * months. This guard catches that class of corruption at drop time.
 */
import { describe, it, expect } from 'vitest';
import { detectCorruptFill } from '../lib/parseModule.js';

// Build a Uint8Array of `size` bytes filled with repeated `pattern`.
function makeFill(pattern, size) {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = pattern[i % pattern.length];
  return buf;
}

// Encode an ASCII string as bytes.
function ascii(str) {
  return Uint8Array.from(str, c => c.charCodeAt(0));
}

// ─── Canonical OBDSTAR6 incident ─────────────────────────────────────────────

describe('OBDSTAR6 repeated-string fill (128 KB)', () => {
  const obstar = ascii('OBDSTAR6');
  const buf = makeFill(obstar, 131072);
  const result = detectCorruptFill(buf);

  it('returns a truthy corruptFill result', () => {
    expect(result).not.toBeNull();
    expect(result.corruptFill).toBe(true);
  });

  it('identifies the reason as repeated ASCII string', () => {
    expect(result.reason).toBe('repeated ASCII string');
  });

  it('includes "OBDSTAR6" in the detail message', () => {
    expect(result.detail).toContain('OBDSTAR6');
  });

  it('mentions the repetition count in the detail', () => {
    // 131072 / 8 = 16384 repetitions
    expect(result.detail).toMatch(/16[,.]?384/);
  });
});

// ─── Other repeated ASCII patterns ───────────────────────────────────────────

describe('other repeated ASCII string fills', () => {
  it('rejects "NO DATA" repeated across 64 KB', () => {
    const buf = makeFill(ascii('NO DATA'), 65536);
    const r = detectCorruptFill(buf);
    expect(r).not.toBeNull();
    expect(r.corruptFill).toBe(true);
    expect(r.detail).toContain('NO DATA');
  });

  it('rejects a 4-byte mixed ASCII pattern repeated across 4 KB', () => {
    // Use 'ABCD' (four distinct bytes) so the single-byte-fill check doesn't
    // fire first and the repeated-ASCII path is exercised.
    const buf = makeFill(ascii('ABCD'), 4096);
    const r = detectCorruptFill(buf);
    expect(r).not.toBeNull();
    expect(r.corruptFill).toBe(true);
    expect(r.reason).toBe('repeated ASCII string');
    expect(r.detail).toContain('ABCD');
  });
});

// ─── Single-byte fills ───────────────────────────────────────────────────────

describe('single-byte fill patterns', () => {
  // 0xFF (flash erase) and 0x00 (EEPROM blank) are explicitly excluded from the
  // single-byte-fill gate: an all-FF or all-00 buffer is a legitimate virgin module
  // read and is handled by the existing contentWarn / ContentWarnBanner system.
  // The guard only fires for other byte values that have no meaning in a real capture.
  it('passes through an all-0xFF fill (legitimate flash erase / virgin module)', () => {
    const buf = new Uint8Array(65536).fill(0xFF);
    expect(detectCorruptFill(buf)).toBeNull();
  });

  it('passes through an all-0x00 fill (legitimate EEPROM blank / virgin module)', () => {
    const buf = new Uint8Array(65536).fill(0x00);
    expect(detectCorruptFill(buf)).toBeNull();
  });

  it('rejects an all-0x55 fill (OBDSTAR tool error byte pattern)', () => {
    const buf = new Uint8Array(131072).fill(0x55);
    const r = detectCorruptFill(buf);
    expect(r).not.toBeNull();
    expect(r.corruptFill).toBe(true);
    expect(r.reason).toBe('single-byte fill');
    expect(r.detail).toContain('0x55');
  });

  it('rejects an all-0xAA fill', () => {
    const buf = new Uint8Array(65536).fill(0xAA);
    const r = detectCorruptFill(buf);
    expect(r).not.toBeNull();
    expect(r.corruptFill).toBe(true);
    expect(r.detail).toContain('100%');
    expect(r.detail).toContain('0xAA');
  });
});

// ─── Edge cases that must NOT be flagged ─────────────────────────────────────

describe('clean / real captures pass through', () => {
  it('returns null for a buffer smaller than 64 bytes (too-small guard handles it)', () => {
    expect(detectCorruptFill(new Uint8Array(32).fill(0xFF))).toBeNull();
    expect(detectCorruptFill(new Uint8Array(63).fill(0x55))).toBeNull();
  });

  it('returns null for a null / undefined argument', () => {
    expect(detectCorruptFill(null)).toBeNull();
    expect(detectCorruptFill(undefined)).toBeNull();
  });

  it('returns null for a sparse real-looking buffer with mixed bytes', () => {
    // Simulate a plausible module dump: varied bytes, no single value dominant.
    const buf = new Uint8Array(65536);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 97 + 13) & 0xFF;
    expect(detectCorruptFill(buf)).toBeNull();
  });

  it('returns null for a buffer that is mostly-FF but with enough variation to be a real virgin BCM', () => {
    // Real virgin BCMs are ~98% FF but have a few populated bytes.
    // Our threshold is >=98%, so 97% FF (2,000 non-FF out of 65,536) must pass.
    const buf = new Uint8Array(65536).fill(0xFF);
    // Inject 2,000 non-FF bytes (~3% of the buffer) — just above the noise floor.
    for (let i = 0; i < 2000; i++) buf[i * 32] = i & 0xFE; // never 0xFF
    const ffCount = buf.filter(b => b === 0xFF).length;
    // Confirm the fixture is actually below 98% FF before testing.
    expect(ffCount / buf.length).toBeLessThan(0.98);
    expect(detectCorruptFill(buf)).toBeNull();
  });

  it('returns null for a 4 KB GPEC2A buffer with a real-looking VIN header', () => {
    // A real 4 KB PCM capture starts with a 17-char VIN then varied bytes.
    const buf = new Uint8Array(4096).fill(0xFF);
    const vin = ascii('1C4RJFBG4KC123456');
    buf.set(vin, 0);
    // Spread some SKIM / SEC bytes to push FF% well below 98%.
    for (let i = 17; i < 200; i++) buf[i] = i & 0x7F;
    expect(detectCorruptFill(buf)).toBeNull();
  });
});

// ─── Result shape contract ────────────────────────────────────────────────────

describe('result shape when corruption is detected', () => {
  const buf = makeFill(ascii('OBDSTAR6'), 131072);
  const r = detectCorruptFill(buf);

  it('always has corruptFill: true', () => expect(r.corruptFill).toBe(true));
  it('always has a non-empty reason string', () => {
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
  });
  it('always has a non-empty detail string', () => {
    expect(typeof r.detail).toBe('string');
    expect(r.detail.length).toBeGreaterThan(0);
  });
});
