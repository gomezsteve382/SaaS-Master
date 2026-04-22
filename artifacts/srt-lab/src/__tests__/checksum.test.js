import { beforeAll, describe, test, expect } from 'vitest';
import { sha256Hex, backupDidsToBytes } from '../lib/checksum.js';

// sha256Hex calls window.crypto.subtle.  In Node ≥ 18, globalThis.crypto is
// identical; expose it as `window` so the helper works without modification.
beforeAll(() => {
  if (typeof window === 'undefined') {
    global.window = globalThis;
  }
});

// ─── backupDidsToBytes ────────────────────────────────────────────────────────

describe('backupDidsToBytes', () => {
  test('produces a deterministic byte array for a known DID map', () => {
    const dids = {
      '0xF190': { bytes: [0x01, 0x02, 0x03], missing: false },
      '0xF18C': { bytes: [0xAA, 0xBB], missing: false },
    };
    const result = backupDidsToBytes(dids);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([0x01, 0x02, 0x03, 0xAA, 0xBB]);
  });

  test('is stable across repeated calls with the same input', () => {
    const dids = {
      '0xF190': { bytes: [0x10, 0x20, 0x30], missing: false },
    };
    const a = backupDidsToBytes(dids);
    const b = backupDidsToBytes(dids);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test('skips DIDs marked as missing', () => {
    const dids = {
      '0xF190': { bytes: [0x01, 0x02], missing: false },
      '0xF18C': { bytes: [0xAA, 0xBB], missing: true },
    };
    const result = backupDidsToBytes(dids);
    expect(Array.from(result)).toEqual([0x01, 0x02]);
  });

  test('skips DIDs with empty or absent byte arrays', () => {
    const dids = {
      '0xF190': { bytes: [], missing: false },
      '0xF18C': { bytes: [0xFF], missing: false },
      '0xF19E': { missing: false },
    };
    const result = backupDidsToBytes(dids);
    expect(Array.from(result)).toEqual([0xFF]);
  });

  test('returns an empty Uint8Array for a completely empty DID map', () => {
    const result = backupDidsToBytes({});
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  test('returns an empty Uint8Array for null / undefined input (does not throw)', () => {
    expect(() => backupDidsToBytes(null)).not.toThrow();
    expect(() => backupDidsToBytes(undefined)).not.toThrow();
    expect(backupDidsToBytes(null).length).toBe(0);
    expect(backupDidsToBytes(undefined).length).toBe(0);
  });
});

// ─── sha256Hex ────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  test('returns a 64-character lowercase hex string', async () => {
    const hash = await sha256Hex(new Uint8Array([0x61, 0x62, 0x63])); // "abc"
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('matches the known SHA-256 of the ASCII string "abc"', async () => {
    // echo -n "abc" | sha256sum  →  ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const hash = await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]));
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('matches the known SHA-256 of an empty byte sequence', async () => {
    // sha256sum /dev/null  →  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = await sha256Hex(new Uint8Array(0));
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('accepts a plain number array (not only Uint8Array)', async () => {
    const fromArray = await sha256Hex([0x61, 0x62, 0x63]);
    const fromUint8 = await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]));
    expect(fromArray).toBe(fromUint8);
  });

  test('is deterministic — same input always produces the same hash', async () => {
    const bytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const h1 = await sha256Hex(bytes);
    const h2 = await sha256Hex(bytes);
    expect(h1).toBe(h2);
  });
});

// ─── round-trip: sha256Hex(backupDidsToBytes(dids)) ──────────────────────────

describe('round-trip integrity', () => {
  // Pinned fixture – the expected checksum was computed once with:
  //   crypto.subtle.digest('SHA-256', Uint8Array.from([0xDE,0xAD,0xBE,0xEF,0x01,0x02]))
  // and must never change without a corresponding backup-format migration.
  const FIXTURE_DIDS = {
    '0xF190': { bytes: [0xDE, 0xAD, 0xBE, 0xEF], missing: false },
    '0xF18C': { bytes: [0x01, 0x02], missing: false },
  };
  const FIXTURE_CHECKSUM =
    '200c5fe2fef346a741a4e782de6b76ecafb98f93e47e96168fa2e5e53f9ffc90';

  test('sha256Hex(backupDidsToBytes(dids)) matches the stored fixture checksum', async () => {
    const bytes = backupDidsToBytes(FIXTURE_DIDS);
    const checksum = await sha256Hex(bytes);
    expect(checksum).toBe(FIXTURE_CHECKSUM);
  });

  test('checksum changes when a DID byte changes (integrity is sensitive)', async () => {
    const tampered = {
      '0xF190': { bytes: [0xDE, 0xAD, 0xBE, 0xFF], missing: false }, // last byte changed
      '0xF18C': { bytes: [0x01, 0x02], missing: false },
    };
    const checksum = await sha256Hex(backupDidsToBytes(tampered));
    expect(checksum).not.toBe(FIXTURE_CHECKSUM);
  });

  test('all-missing DID map produces a stable empty-hash, does not throw', async () => {
    const dids = {
      '0xF190': { bytes: [0x01, 0x02], missing: true },
      '0xF18C': { bytes: [0xAA, 0xBB], missing: true },
    };
    const bytes = backupDidsToBytes(dids);
    expect(bytes.length).toBe(0);
    const checksum = await sha256Hex(bytes);
    // Must equal the well-known SHA-256 of an empty buffer.
    expect(checksum).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
