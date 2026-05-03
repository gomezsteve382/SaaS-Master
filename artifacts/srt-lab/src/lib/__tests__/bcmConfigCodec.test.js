import { describe, it, expect } from 'vitest';
import {
  BCM_CONFIG_DIDS,
  didPayloadByteLength,
  groupCatalogByDid,
  decodeBcmDid,
  encodeBcmDid,
  readBits,
  writeBits,
} from '../bcmConfigCodec.js';

describe('bcmConfigCodec — bit primitives', () => {
  it('writeBits/readBits round-trip across byte boundaries', () => {
    const buf = new Uint8Array(4);
    writeBits(buf, 5, 6, 0b101101);          // straddles byte 0/1
    expect(readBits(buf, 5, 6)).toBe(0b101101);
    writeBits(buf, 14, 10, 0b1011001011);    // 10-bit field straddling 3 bytes
    expect(readBits(buf, 14, 10)).toBe(0b1011001011);
    // first field still intact
    expect(readBits(buf, 5, 6)).toBe(0b101101);
  });

  it('writeBits clears bits when zero is written', () => {
    const buf = new Uint8Array([0xFF, 0xFF]);
    writeBits(buf, 4, 4, 0);
    expect(readBits(buf, 4, 4)).toBe(0);
    // neighbouring nibble untouched
    expect(readBits(buf, 0, 4)).toBe(0xF);
    expect(readBits(buf, 8, 8)).toBe(0xFF);
  });

  it('writeBits masks oversized values to field length', () => {
    const buf = new Uint8Array(2);
    writeBits(buf, 0, 3, 0xFF);              // 0xFF & 0b111 = 0b111
    expect(readBits(buf, 0, 3)).toBe(0b111);
    expect(buf[0] & 0b00011111).toBe(0);
  });

  it('readBits returns null when field falls outside payload', () => {
    expect(readBits(new Uint8Array(1), 4, 8)).toBeNull();
  });
});

describe('bcmConfigCodec — catalog grouping', () => {
  it('exposes 13 DEnn DIDs', () => {
    expect(BCM_CONFIG_DIDS.length).toBe(13);
    expect(BCM_CONFIG_DIDS[0]).toBe(0xDE00);
    expect(BCM_CONFIG_DIDS[12]).toBe(0xDE0C);
  });

  it('groups every catalog row under exactly one DID', () => {
    const grouped = groupCatalogByDid();
    let total = 0;
    for (const did of BCM_CONFIG_DIDS) {
      expect(grouped.has(did)).toBe(true);
      total += grouped.get(did).length;
    }
    expect(total).toBe(155);
  });

  it('Performance & SRT group is DE0A and contains the SRT toggles', () => {
    const fields = groupCatalogByDid().get(0xDE0A) || [];
    const names = fields.map((f) => f.name);
    expect(names).toContain('SRT Performance Pages');
    expect(names).toContain('Launch Control');
    expect(names).toContain('Line Lock');
    expect(names).toContain('Trans Brake');
    expect(names).toContain('Track Mode');
    expect(names).toContain('Drag Mode');
  });

  it('every DID has a positive payload byte length', () => {
    for (const did of BCM_CONFIG_DIDS) {
      expect(didPayloadByteLength(did)).toBeGreaterThan(0);
    }
  });
});

describe('bcmConfigCodec — encode/decode round-trip', () => {
  it('decode then re-encode reproduces the same payload bytes', () => {
    for (const did of BCM_CONFIG_DIDS) {
      const len = didPayloadByteLength(did);
      // Deterministic pseudo-random pattern per byte index so we
      // exercise non-zero edge bits without crypto.
      const original = new Uint8Array(len);
      for (let i = 0; i < len; i++) original[i] = (i * 37 + 0xA5) & 0xFF;

      const decoded = decodeBcmDid(did, original);
      const valueMap = {};
      for (const row of decoded) {
        if (row.raw != null) valueMap[row.field.name] = row.raw;
      }
      const re = encodeBcmDid(did, valueMap, original);
      expect(Array.from(re)).toEqual(Array.from(original));
    }
  });

  it('toggling one bit flips exactly that field on re-decode', () => {
    const did = 0xDE0A; // Performance & SRT
    const len = didPayloadByteLength(did);
    const base = new Uint8Array(len);
    const decodedZero = decodeBcmDid(did, base);
    const perfPages = decodedZero.find((r) => r.field.name === 'SRT Performance Pages');
    expect(perfPages).toBeTruthy();
    expect(perfPages.raw).toBe(0);

    const next = encodeBcmDid(did, { 'SRT Performance Pages': 1 }, base);
    const decodedNext = decodeBcmDid(did, next);
    const flipped = decodedNext.find((r) => r.field.name === 'SRT Performance Pages');
    expect(flipped.raw).toBe(1);

    // Every other field still 0
    for (const r of decodedNext) {
      if (r.field.name === 'SRT Performance Pages') continue;
      expect(r.raw).toBe(0);
    }
  });

  it('encoding without basePayload produces a zero-init buffer of catalog size', () => {
    const did = 0xDE00;
    const buf = encodeBcmDid(did, {});
    expect(buf.length).toBe(didPayloadByteLength(did));
    expect(Array.from(buf).every((b) => b === 0)).toBe(true);
  });

  it('encoding a Demon trim level into DE0B writes the documented value', () => {
    const did = 0xDE0B;
    const out = encodeBcmDid(did, { 'Vehicle Trim Level': 9 }, null);
    const decoded = decodeBcmDid(did, out);
    const trim = decoded.find((r) => r.field.name === 'Vehicle Trim Level');
    expect(trim.raw).toBe(9);
    expect(trim.label).toBe('Demon');
  });
});
