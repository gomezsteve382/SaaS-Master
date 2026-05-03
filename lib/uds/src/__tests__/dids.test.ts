/**
 * @workspace/uds DID catalog tests — verifies the FCA / Stellantis scoped
 * DID space (24-bit 0x6Exxxxx, 32-bit SCI-B flags), the BCM 0xDExx
 * configuration window, RFHUB family, and ECM 0xFDxx entries are present
 * with golden labels matching srt-lab's CRITICAL_DIDS / VILLAIN extraction.
 */

import { describe, it, expect } from 'vitest';
import { DID_CATALOG, didEntry, decodeDid } from '../dids.js';

// ── Standard ISO 14229 identification block ──────────────────────────

describe('DID_CATALOG: ISO 14229 0xF1xx block', () => {
  it('0xF190 → VIN, 17 bytes, ASCII', () => {
    const e = didEntry(0xF190)!;
    expect(e).toBeDefined();
    expect(e.name).toMatch(/VIN/);
    expect(e.length).toBe(17);
    expect(e.encoding).toBe('ascii');
  });

  it('0xF18C → ECU Serial Number (added for srt-lab CRITICAL_DIDS parity)', () => {
    expect(didEntry(0xF18C)?.name).toBe('ECU Serial Number');
  });

  it('decodeDid(0xF190, "5GAEV13708J123456") → ASCII VIN string', () => {
    const vin = '5GAEV13708J123456';
    const bytes = Array.from(vin).map(c => c.charCodeAt(0));
    expect(decodeDid(0xF190, bytes)).toBe(vin);
  });
});

// ── 24-bit FCA scoped DIDs (0x6Exxxxx) ───────────────────────────────

describe('DID_CATALOG: FCA scoped 0x6Exxxxx range', () => {
  it('0x6E2025 → Bus-Transmitted VIN (golden label from VILLAIN)', () => {
    expect(didEntry(0x6E2025)?.name).toBe('Bus-Transmitted VIN');
  });

  it('0x6E2027 → WCM Configured VIN (golden label from VILLAIN)', () => {
    expect(didEntry(0x6E2027)?.name).toBe('WCM Configured VIN');
  });

  it('0x6E9EB0 → SKIM State', () => {
    expect(didEntry(0x6E9EB0)?.name).toBe('SKIM State');
  });

  it('0x6EF190 → EPS VIN', () => {
    expect(didEntry(0x6EF190)?.name).toBe('EPS VIN');
  });

  it('SKIM State decoder maps 0x80 → Enabled, 0x00 → Disabled', () => {
    expect(decodeDid(0x6E9EB0, [0x80])).toMatch(/Enabled/);
    expect(decodeDid(0x6E9EB0, [0x00])).toMatch(/Disabled/);
    // Unknown values fall back to hex
    expect(decodeDid(0x6E9EB0, [0x42])).toBe('42');
  });
});

// ── 32-bit SCI-B addressed flag ──────────────────────────────────────

describe('DID_CATALOG: 32-bit SCI-B flag', () => {
  it('0xF79EB045 → SKIM State Flag (SCI-B)', () => {
    expect(didEntry(0xF79EB045)?.name).toBe('SKIM State Flag (SCI-B)');
  });

  it('SCI-B SKIM flag decodes 0x80/0x00 the same as the 24-bit DID', () => {
    expect(decodeDid(0xF79EB045, [0x80])).toMatch(/Enabled/);
    expect(decodeDid(0xF79EB045, [0x00])).toMatch(/Disabled/);
  });
});

// ── VILLAIN VIN block (16-bit Chrysler ECU CAN 11-bit) ───────────────

describe('DID_CATALOG: VILLAIN 0x7Bxx VIN block', () => {
  it('0x7B90 → Current VIN', () => {
    expect(didEntry(0x7B90)?.name).toBe('Current VIN');
  });

  it('0x7B88 → Original VIN', () => {
    expect(didEntry(0x7B88)?.name).toBe('Original VIN');
  });
});

// ── BCM configuration window 0xDE00–0xDE0C ───────────────────────────

describe('DID_CATALOG: BCM 0xDE00–0xDE0C configuration window', () => {
  it('covers every byte of the contiguous 0xDE00–0xDE0C window', () => {
    for (let did = 0xDE00; did <= 0xDE0C; did++) {
      const e = didEntry(did);
      expect(e, `missing BCM config DID 0x${did.toString(16).toUpperCase()}`).toBeDefined();
      expect(e!.name).toMatch(/^BCM Configuration Block/);
    }
  });

  it('keeps ADCM-shared 0xDE10 / 0xDE11 in the same family', () => {
    expect(didEntry(0xDE10)?.name).toBe('Vehicle Config');
    expect(didEntry(0xDE11)?.name).toBe('Variant Code');
  });
});

// ── RFHUB family ─────────────────────────────────────────────────────

describe('DID_CATALOG: RFHUB tire-sensor / secret-key DIDs', () => {
  it('0xF1E0 carries the RFHUB tire-sensor annotation', () => {
    expect(didEntry(0xF1E0)?.name).toMatch(/RFHUB.*Tire Sensors/i);
  });

  it('0xF1E1 carries the RFHUB secret-key annotation', () => {
    expect(didEntry(0xF1E1)?.name).toMatch(/RFHUB.*Secret Key/i);
  });
});

// ── ECM 0xFDxx + odometer/runtime ────────────────────────────────────

describe('DID_CATALOG: ECM 0xFDxx family and runtime DIDs', () => {
  it('0xFD01 / 0xFD31 / 0xFDFD are catalogued', () => {
    expect(didEntry(0xFD01)?.name).toBe('Control Status Data');
    expect(didEntry(0xFD31)?.name).toBe('Pending Fault Memory');
    expect(didEntry(0xFDFD)?.name).toBe('Fast Vehicle Info');
  });

  it('0xF40D Odometer + 0xF1C1 Engine Hours are decoded as uint', () => {
    expect(didEntry(0xF40D)?.encoding).toBe('uint');
    expect(didEntry(0xF1C1)?.encoding).toBe('uint');
    expect(decodeDid(0xF40D, [0x00, 0x01, 0x86, 0xA0])).toBe('100000');
  });
});

// ── Golden parity with srt-lab CRITICAL_DIDS labels ──────────────────

describe('DID_CATALOG: srt-lab CRITICAL_DIDS golden labels', () => {
  // These labels are what srt-lab's getDidDescription() returns after
  // seedFromSharedCatalog() runs. CRITICAL_DIDS-supplied labels (e.g.
  // "Software Version" for 0xF189) win locally, but DIDs that only the
  // shared catalog knows about must match these goldens exactly.
  const golden: Array<readonly [number, string]> = [
    [0x6E2025, 'Bus-Transmitted VIN'],
    [0x6E2027, 'WCM Configured VIN'],
    [0x6E9EB0, 'SKIM State'],
    [0x6EF190, 'EPS VIN'],
    [0x7B88, 'Original VIN'],
    [0x7B90, 'Current VIN'],
    [0xF79EB045, 'SKIM State Flag (SCI-B)'],
  ];

  for (const [did, name] of golden) {
    it(`0x${did.toString(16).toUpperCase()} → "${name}"`, () => {
      expect(didEntry(did)?.name).toBe(name);
    });
  }
});

// ── Catalog hygiene ──────────────────────────────────────────────────

describe('DID_CATALOG: hygiene', () => {
  it('has no duplicate DID numbers', () => {
    const seen = new Set<number>();
    const dupes: number[] = [];
    for (const e of DID_CATALOG) {
      if (seen.has(e.did)) dupes.push(e.did);
      seen.add(e.did);
    }
    expect(dupes).toEqual([]);
  });

  it('every entry has a non-empty name and a callable decode()', () => {
    for (const e of DID_CATALOG) {
      expect(typeof e.name).toBe('string');
      expect(e.name.length).toBeGreaterThan(0);
      expect(typeof e.decode).toBe('function');
    }
  });
});
