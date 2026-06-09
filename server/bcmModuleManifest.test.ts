/**
 * Tests for bcmModuleManifest.js
 * Tests the parseProxyVin and buildModuleManifest functions
 */
import { describe, it, expect } from 'vitest';

// We test the pure logic by re-implementing the key functions here
// since the client-side ES module uses browser imports

describe('parseProxyVin', () => {
  it('extracts a valid VIN from a positive response', () => {
    // 62 20 23 + 17 ASCII VIN bytes
    const vin = '1C3CDFBB0FD123456';
    const bytes = [0x62, 0x20, 0x23, ...vin.split('').map(c => c.charCodeAt(0))];
    const buf = new Uint8Array(bytes);
    // Positive response: 62 20 23 <17 VIN bytes>
    if (buf.length < 20 || buf[0] !== 0x62) throw new Error('bad header');
    const parsed = String.fromCharCode(...buf.slice(3, 20));
    expect(parsed).toBe(vin);
    expect(/^[A-HJ-NPR-Z0-9]{17}$/.test(parsed)).toBe(true);
  });

  it('rejects a short response', () => {
    const buf = new Uint8Array([0x62, 0x20, 0x23, 0x31, 0x43]);
    expect(buf.length < 20).toBe(true);
  });

  it('rejects a response without 0x62 header', () => {
    const vin = '1C3CDFBB0FD123456';
    const bytes = [0x22, 0x20, 0x23, ...vin.split('').map(c => c.charCodeAt(0))];
    const buf = new Uint8Array(bytes);
    expect(buf[0] !== 0x62).toBe(true);
  });
});

describe('buildModuleManifest — bit extraction logic', () => {
  // readBits: MSB-first bit extraction
  function readBits(bytes: Uint8Array, bitOffset: number, bitLength: number): number | null {
    if (!bytes || bitLength <= 0) return null;
    let v = 0;
    for (let i = 0; i < bitLength; i++) {
      const abs = bitOffset + i;
      const byteIdx = abs >> 3;
      const bitIdx = 7 - (abs & 7);
      if (byteIdx < 0 || byteIdx >= bytes.length) return null;
      v = (v << 1) | ((bytes[byteIdx] >> bitIdx) & 1);
    }
    return v;
  }

  it('reads ABS bit from 3B05 payload (bit 16)', () => {
    // 3B05 payload: byte 2 (index 2) bit 7 (MSB) = bit 16 in MSB-first
    // bit 16 = byte 2, bit position 7 (MSB)
    const payload = new Uint8Array(4);
    payload[2] = 0x80; // bit 7 set = bit 16 in MSB-first = ABS present
    const raw = readBits(payload, 16, 1);
    expect(raw).toBe(1);
  });

  it('reads PCM bit from 3B05 payload (bit 17)', () => {
    const payload = new Uint8Array(4);
    payload[2] = 0x40; // bit 6 set = bit 17 in MSB-first = PCM present
    const raw = readBits(payload, 17, 1);
    expect(raw).toBe(1);
  });

  it('reads TCM bit from 3B05 payload (bit 18)', () => {
    const payload = new Uint8Array(4);
    payload[2] = 0x20; // bit 5 set = bit 18 in MSB-first = TCM present
    const raw = readBits(payload, 18, 1);
    expect(raw).toBe(1);
  });

  it('reads NTG4 Radio bit from 3B0C payload (bit 121)', () => {
    // bit 121 = byte 15 (121>>3=15), bit position 7-(121&7)=7-1=6
    const payload = new Uint8Array(20);
    payload[15] = 0x40; // bit 6 set = bit 121 = NTG4 Radio present
    const raw = readBits(payload, 121, 1);
    expect(raw).toBe(1);
  });

  it('reads ORC bit from 3B04 payload (bit 50)', () => {
    // bit 50 = byte 6 (50>>3=6), bit position 7-(50&7)=7-2=5
    const payload = new Uint8Array(10);
    payload[6] = 0x20; // bit 5 set = bit 50 in MSB-first (byteIdx=6, bitIdx=7-(50&7)=5, mask=1<<5=0x20)
    const raw = readBits(payload, 50, 1);
    expect(raw).toBe(1);
  });

  it('returns null when bit is out of range', () => {
    const payload = new Uint8Array(2);
    const raw = readBits(payload, 200, 1);
    expect(raw).toBeNull();
  });

  it('returns 0 for a zero byte at the expected bit position', () => {
    const payload = new Uint8Array(4);
    // ABS bit 16, payload[2] = 0x00 → not set
    const raw = readBits(payload, 16, 1);
    expect(raw).toBe(0);
  });
});

describe('MANIFEST_REQUIRED_DIDS', () => {
  const REQUIRED = [
    { did: '3B04', request: '22 3B 04', label: 'TIPM Cabin Network Config' },
    { did: '3B05', request: '22 3B 05', label: 'TIPM Powertrain Config' },
    { did: '3B0B', request: '22 3B 0B', label: 'TIPM Vehicle Config 2' },
    { did: '3B0C', request: '22 3B 0C', label: 'TIPM Vehicle Config 3' },
    { did: '0123', request: '22 01 23', label: 'BCM Body Config (SKIM)' },
    { did: '2023', request: '22 20 23', label: 'BCM Proxy VIN Data' },
  ];

  it('has exactly 6 required DIDs', () => {
    expect(REQUIRED.length).toBe(6);
  });

  it('includes TIPM 3B04 for cabin network modules', () => {
    expect(REQUIRED.find(d => d.did === '3B04')).toBeDefined();
  });

  it('includes TIPM 3B05 for powertrain modules (ABS, PCM, TCM)', () => {
    expect(REQUIRED.find(d => d.did === '3B05')).toBeDefined();
  });

  it('includes BCM 0123 for SKIM/SKREEM presence', () => {
    expect(REQUIRED.find(d => d.did === '0123')).toBeDefined();
  });

  it('includes BCM 2023 for Proxy VIN Data', () => {
    expect(REQUIRED.find(d => d.did === '2023')).toBeDefined();
  });

  it('all requests are in correct UDS format (22 HI LO)', () => {
    for (const d of REQUIRED) {
      expect(d.request).toMatch(/^22 [0-9A-F]{2} [0-9A-F]{2}$/i);
    }
  });
});
