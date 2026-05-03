/**
 * fcaProxi.test.js
 *
 * Vitest tests for artifacts/srt-lab/src/lib/fcaProxi.js
 *
 * Tests:
 *  1. Round-trip: parse → serialize → byte equality on a synthetic fixture
 *  2. Round-trip: multiple sections, unknown section IDs preserved
 *  3. CRC validation: corrupted CRC is caught
 *  4. CRC validation: correct CRC passes
 *  5. validateLicenseJson: valid chichitoworkshop envelope
 *  6. validateLicenseJson: missing fields
 *  7. verifyManifest: all files present and correct size
 *  8. verifyManifest: missing file is flagged
 *  9. verifyManifest: size mismatch is flagged
 * 10. buildProxi round-trip
 * 11. parseProxi error on too-short buffer
 * 12. parseProxi: unknown section IDs are preserved as opaque bytes
 */

import { describe, it, expect } from 'vitest';
import {
  parseProxi,
  serializeProxi,
  buildProxi,
  validateLicenseJson,
  verifyManifest,
  SECTION_NAMES,
} from '../../lib/fcaProxi.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function crc16CcittFalse(data) {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Build a well-formed PROXI binary from scratch for testing. */
function makeSyntheticProxi(sections = [], formatVersion = 1) {
  // sections: [{id, payload}]
  let sectionsBlob = new Uint8Array(0);
  for (const s of sections) {
    const payload = s.payload instanceof Uint8Array ? s.payload : new Uint8Array(s.payload);
    const entry = new Uint8Array(2 + payload.length);
    entry[0] = s.id;
    entry[1] = payload.length;
    entry.set(payload, 2);
    const merged = new Uint8Array(sectionsBlob.length + entry.length);
    merged.set(sectionsBlob);
    merged.set(entry, sectionsBlob.length);
    sectionsBlob = merged;
  }
  const totalLength = 4 + sectionsBlob.length + 2;
  const buf = new Uint8Array(totalLength);
  buf[0] = sections.length;
  buf[1] = formatVersion;
  buf[2] = totalLength & 0xff;
  buf[3] = (totalLength >> 8) & 0xff;
  buf.set(sectionsBlob, 4);
  const crc = crc16CcittFalse(buf.slice(0, totalLength - 2));
  buf[totalLength - 2] = (crc >> 8) & 0xff;
  buf[totalLength - 1] = crc & 0xff;
  return buf;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_SECTIONS = [
  { id: 0x01, payload: new Uint8Array([0x11, 0x22, 0x33, 0x44]) },   // Body
  { id: 0x02, payload: new Uint8Array([0xAA, 0xBB]) },                 // Powertrain
  { id: 0x07, payload: new Uint8Array([0x01, 0x02, 0x03]) },           // Infotainment
  { id: 0xFF, payload: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]) },     // Unknown section
];

const FIXTURE_BINARY = makeSyntheticProxi(FIXTURE_SECTIONS, 1);

const LICENSE_VALID = {
  v: '1.2.0.1',
  product: 'FCA PROXI Tool',
  request: 'chichitoworkshop',
  edition: 'chichitoworkshop',
  features: ['chichitoworkshop'],
  sig: 'chichitoworkshop',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseProxi + serializeProxi', () => {
  it('round-trips a synthetic 4-section PROXI binary byte-for-byte', () => {
    const parsed = parseProxi(FIXTURE_BINARY);
    expect(parsed.ok).toBe(true);
    expect(parsed.crcValid).toBe(true);
    expect(parsed.sectionCount).toBe(4);
    expect(parsed.formatVersion).toBe(1);

    const reserialized = serializeProxi(parsed);
    expect(reserialized.length).toBe(FIXTURE_BINARY.length);
    for (let i = 0; i < FIXTURE_BINARY.length; i++) {
      expect(reserialized[i]).toBe(FIXTURE_BINARY[i]);
    }
  });

  it('round-trips an ArrayBuffer input (not just Uint8Array)', () => {
    const buf = FIXTURE_BINARY.buffer.slice(
      FIXTURE_BINARY.byteOffset,
      FIXTURE_BINARY.byteOffset + FIXTURE_BINARY.byteLength
    );
    const parsed = parseProxi(buf);
    expect(parsed.ok).toBe(true);
    const out = serializeProxi(parsed);
    expect(Array.from(out)).toEqual(Array.from(FIXTURE_BINARY));
  });

  it('preserves unknown section ID 0xFF as opaque bytes', () => {
    const parsed = parseProxi(FIXTURE_BINARY);
    expect(parsed.ok).toBe(true);
    const unknownSec = parsed.sections.find((s) => s.id === 0xff);
    expect(unknownSec).toBeDefined();
    expect(Array.from(unknownSec.payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(unknownSec.name).toMatch(/0xFF/i);
  });

  it('returns ok=false on a too-short buffer', () => {
    const result = parseProxi(new Uint8Array([0x01, 0x01, 0x08]));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns ok=false when buffer is shorter than declared totalLength', () => {
    const truncated = FIXTURE_BINARY.slice(0, FIXTURE_BINARY.length - 4);
    const result = parseProxi(truncated);
    expect(result.ok).toBe(false);
  });

  it('detects a CRC mismatch', () => {
    const corrupted = new Uint8Array(FIXTURE_BINARY);
    corrupted[6] ^= 0xFF; // flip a byte in the first section payload
    const parsed = parseProxi(corrupted);
    expect(parsed.ok).toBe(false);
  });

  it('correctly labels known section IDs', () => {
    const parsed = parseProxi(FIXTURE_BINARY);
    expect(parsed.ok).toBe(true);
    const body = parsed.sections.find((s) => s.id === 0x01);
    expect(body.name).toBe('Body');
    const pt = parsed.sections.find((s) => s.id === 0x02);
    expect(pt.name).toBe('Powertrain');
  });

  it('section payload bytes match the fixture input exactly', () => {
    const parsed = parseProxi(FIXTURE_BINARY);
    const bodySec = parsed.sections.find((s) => s.id === 0x01);
    expect(Array.from(bodySec.payload)).toEqual([0x11, 0x22, 0x33, 0x44]);
    const infotainSec = parsed.sections.find((s) => s.id === 0x07);
    expect(Array.from(infotainSec.payload)).toEqual([0x01, 0x02, 0x03]);
  });
});

describe('buildProxi', () => {
  it('round-trips through buildProxi → parseProxi', () => {
    const raw = buildProxi([
      { id: 0x01, payload: new Uint8Array([0xAA, 0xBB, 0xCC]) },
      { id: 0x03, payload: new Uint8Array([0x01]) },
    ], 2);
    const parsed = parseProxi(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.sectionCount).toBe(2);
    expect(parsed.crcValid).toBe(true);
    expect(Array.from(parsed.sections[0].payload)).toEqual([0xAA, 0xBB, 0xCC]);
    expect(Array.from(parsed.sections[1].payload)).toEqual([0x01]);
  });

  it('produces identical bytes to manual construction', () => {
    const sections = [{ id: 0x02, payload: new Uint8Array([0x55, 0x66]) }];
    const viaHelper = buildProxi(sections, 1);
    const viaManual = makeSyntheticProxi(sections, 1);
    expect(Array.from(viaHelper)).toEqual(Array.from(viaManual));
  });
});

describe('validateLicenseJson', () => {
  it('accepts a valid chichitoworkshop license object', () => {
    const { valid, errors } = validateLicenseJson(LICENSE_VALID);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('rejects null input', () => {
    const { valid, errors } = validateLicenseJson(null);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects when required field v is missing', () => {
    const { v: _, ...without } = LICENSE_VALID;
    const { valid, errors } = validateLicenseJson(without);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('"v"'))).toBe(true);
  });

  it('rejects when features is not an array', () => {
    const { valid, errors } = validateLicenseJson({ ...LICENSE_VALID, features: 'not-array' });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('features'))).toBe(true);
  });

  it('rejects when multiple fields are missing', () => {
    const { valid, errors } = validateLicenseJson({ v: '1.0' });
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe('verifyManifest', () => {
  const MANIFEST = {
    files: {
      'FCA_PROXI_Tool.exe': { sha256: 'aaa', size: 21763077 },
      'shfolder.dll':       { sha256: 'bbb', size: 10161664 },
    },
  };

  it('passes when all files are present with correct sizes', () => {
    const { ok, failures } = verifyManifest(MANIFEST, {
      'FCA_PROXI_Tool.exe': 21763077,
      'shfolder.dll': 10161664,
    });
    expect(ok).toBe(true);
    expect(failures).toHaveLength(0);
  });

  it('flags a missing file', () => {
    const { ok, failures } = verifyManifest(MANIFEST, {
      'FCA_PROXI_Tool.exe': 21763077,
    });
    expect(ok).toBe(false);
    expect(failures.some((f) => f.includes('shfolder.dll'))).toBe(true);
  });

  it('flags a size mismatch', () => {
    const { ok, failures } = verifyManifest(MANIFEST, {
      'FCA_PROXI_Tool.exe': 99999,
      'shfolder.dll': 10161664,
    });
    expect(ok).toBe(false);
    expect(failures.some((f) => f.includes('FCA_PROXI_Tool.exe'))).toBe(true);
  });

  it('passes on an empty files map', () => {
    const { ok } = verifyManifest({ files: {} }, {});
    expect(ok).toBe(true);
  });
});

describe('SECTION_NAMES', () => {
  it('maps 0x01 to Body', () => {
    expect(SECTION_NAMES[0x01]).toBe('Body');
  });
  it('maps 0x07 to Infotainment', () => {
    expect(SECTION_NAMES[0x07]).toBe('Infotainment');
  });
  it('does not have an entry for 0xFF', () => {
    expect(SECTION_NAMES[0xff]).toBeUndefined();
  });
});
