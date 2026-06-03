/**
 * Regression: engParseRfh must classify a 24C32 (4 KB) RFHUB as Gen2 by SIZE,
 * even when the 0x0500 banner is NOT the canonical `AA 55 31 01`.
 *
 * Real Gen2 EEE Charger dumps carry a non-canonical banner (e.g. FF FF 00 00)
 * yet store a valid SEC16 at 0x050E. The old detection gated Gen2 solely on the
 * banner, so these files fell back to the Gen1 offset 0x0226 and surfaced a
 * garbage SEC16 → false "MISMATCH" in the Security Sync tab.
 * Ground truth for the EEE slot1 offset: .agents/memory/charger62-bench-set.md
 */
import { describe, it, expect } from 'vitest';
import { engParseRfh } from '../tabs/ModuleSync.jsx';

const KNOWN_SEC16 = [
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
  0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x12, 0x34,
];

function buildGen2NoBanner(size = 4096) {
  const b = new Uint8Array(size).fill(0xFF);
  // Non-canonical banner at 0x0500 (NOT AA 55 31 01).
  b[0x0500] = 0xFF; b[0x0501] = 0xFF; b[0x0502] = 0x00; b[0x0503] = 0x00;
  // Valid SEC16 at the Gen2 slot1 offset.
  for (let i = 0; i < 16; i++) b[0x050E + i] = KNOWN_SEC16[i];
  return b;
}

describe('engParseRfh — Gen2 detection by size (non-canonical banner)', () => {
  it('labels a 4 KB dump Gen2 and reads SEC16 from 0x050E even without the AA5531 banner', () => {
    const p = engParseRfh(buildGen2NoBanner(4096), 'rfhub_eee_noband.bin');
    expect(p.format).toBe('gen2');
    expect(p.sec16).toBeTruthy();
    expect(p.sec16.offsets[0]).toBe(0x050E);
    expect(Array.from(p.sec16.slot1)).toEqual(KNOWN_SEC16);
    expect(p.sec16.virgin).toBe(false);
  });

  it('labels an 8 KB double-dump Gen2 as well', () => {
    const p = engParseRfh(buildGen2NoBanner(8192), 'rfhub_eee_8k.bin');
    expect(p.format).toBe('gen2');
    expect(p.sec16.offsets[0]).toBe(0x050E);
  });

  it('keeps a 2 KB (24C16) dump on the Gen1 path — size must not over-promote', () => {
    const b = new Uint8Array(2048).fill(0xFF);
    for (let i = 0; i < 16; i++) b[0x0226 + i] = KNOWN_SEC16[i];
    const p = engParseRfh(b, 'rfhub_gen1.bin');
    expect(p.format).toBe('gen1');
    expect(p.sec16.offsets[0]).toBe(0x0226);
  });
});
