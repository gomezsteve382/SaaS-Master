// Vitest coverage for the EFD/.webm container parser (Task #488).
import { describe, test, expect } from 'vitest';
import { parseEFD, isEbmlBuffer, shannonEntropy, EBML_MAGIC } from '../lib/efdParser.js';

// Encode an EBML variable-length integer for our tiny test payloads.
function vintEncode(value) {
  if (value < 0x80) return [0x80 | value];
  if (value < 0x4000) return [0x40 | (value >> 8), value & 0xFF];
  if (value < 0x200000) return [0x20 | (value >> 16), (value >> 8) & 0xFF, value & 0xFF];
  throw new Error('vintEncode size too big for tiny test');
}

function buildEfd({ withDs = true, withUp = true, payloadSize = 256 } = {}) {
  const parts = [];
  parts.push([0x1A, 0x45, 0xDF, 0xA3, 0x80]);
  if (withDs) {
    const meta = 'Engine=6.2L Hellcat\nProgram=PowerCal-2024\nModelYear=2023\nBody=Charger\n';
    const metaBytes = new TextEncoder().encode(meta);
    parts.push([0x20, 0x44, 0x53, ...vintEncode(metaBytes.length), ...metaBytes]);
  }
  if (withUp) {
    const payload = new Uint8Array(payloadSize);
    for (let i = 0; i < payloadSize; i++) payload[i] = i & 0xFF;
    parts.push([0x20, 0x55, 0x50, ...vintEncode(payloadSize), ...payload]);
  }
  return new Uint8Array(parts.flat());
}

describe('isEbmlBuffer', () => {
  test('accepts buffers with the EBML magic prefix', () => {
    expect(isEbmlBuffer(new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0xFF]))).toBe(true);
    expect(isEbmlBuffer(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0xFF]))).toBe(false);
    expect(isEbmlBuffer(new Uint8Array([0x1A, 0x45]))).toBe(false);
    expect(EBML_MAGIC[0]).toBe(0x1A);
  });
});

describe('parseEFD', () => {
  test('rejects too-small buffers', () => {
    const r = parseEFD(new Uint8Array(2), 'x');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Too small/);
  });

  test('rejects non-EBML buffers', () => {
    const r = parseEFD(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE]), 'x.bin');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/EBML/);
  });

  test('parses DS metadata and UP payload from a minimal EBML container', () => {
    const r = parseEFD(buildEfd(), 'test.webm');
    expect(r.valid).toBe(true);
    expect(r.sections.length).toBeGreaterThanOrEqual(2);
    expect(r.metadata.Engine).toBe('6.2L Hellcat');
    expect(r.metadata.Program).toBe('PowerCal-2024');
    expect(r.metadata.ModelYear).toBe('2023');
    expect(r.efdType).toBe('mopar_powercal');
    expect(r.payload).toBeTruthy();
    expect(r.payload.size).toBe(256);
    expect(r.payload.entropy).toBeGreaterThanOrEqual(7.0);
    expect(r.payload.entropy).toBeLessThanOrEqual(8.0);
  });

  test('without DS still returns a valid container with no metadata', () => {
    const r = parseEFD(buildEfd({ withDs: false }), 'no-ds.webm');
    expect(r.valid).toBe(true);
    expect(r.metadata).toEqual({});
    expect(r.efdType).not.toBe('mopar_powercal');
  });
});

describe('shannonEntropy', () => {
  test('reports near zero for constant data and near 8 for uniform-like data', () => {
    expect(shannonEntropy(new Uint8Array(1024))).toBeLessThan(0.01);
    const r = new Uint8Array(1024);
    for (let i = 0; i < r.length; i++) r[i] = i & 0xFF;
    expect(shannonEntropy(r)).toBeGreaterThan(7.5);
  });
});
