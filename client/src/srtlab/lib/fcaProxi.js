/**
 * fcaProxi.js — Native FCA PROXI record parser / serializer
 *
 * Documented against the decompiled Python source from FCA_PROXI_Tool.exe
 * (PyInstaller bundle, Python 3.12) and cross-referenced with known BCM
 * DID 0xFD01 / 0xFD20 UDS responses captured on the bench.
 *
 * A PROXI record is a 128-byte (0x80) vehicle-specific configuration blob
 * stored in the BCM. It is read via UDS 0x22 0xFD 0x01 and written via
 * UDS 0x2E 0xFD 0x01 (older non-SGW platforms use DID 0xFD20).
 *
 * Layout (all multi-byte values big-endian unless noted):
 *
 *   Offset  Len  Field
 *   ------  ---  -----
 *   0x00    1    section_count  — number of sections that follow (typically 8)
 *   0x01    1    format_version — record format version (0x01 or 0x02)
 *   0x02    2    total_length   — total byte count of payload incl. header (LE)
 *   0x04    N    sections[]     — variable-length section array
 *   last-2  2    record_crc     — CRC-16/CCITT-FALSE over bytes 0x00..last-3
 *
 * Each section:
 *   +0  1  section_id   — feature group ID (see SECTION_NAMES)
 *   +1  1  section_len  — byte count of section payload (not including these 2 bytes)
 *   +2  N  payload      — section-specific bytes
 *
 * Unknown sections and unknown bytes within known sections are preserved as
 * opaque Uint8Array segments so round-tripping is always byte-for-byte lossless.
 */

export const SECTION_NAMES = {
  0x01: 'Body',
  0x02: 'Powertrain',
  0x03: 'Chassis',
  0x04: 'Occupant Restraint',
  0x05: 'Electrical',
  0x06: 'HVAC',
  0x07: 'Infotainment',
  0x08: 'Telematics',
  0x10: 'Market / Region',
  0x20: 'Customer Options',
  0x30: 'Dealer Options',
};

const LICENSE_SCHEMA = {
  required: ['v', 'product', 'request', 'edition', 'features', 'sig'],
  types: {
    v: 'string',
    product: 'string',
    request: 'string',
    edition: 'string',
    features: 'array',
    sig: 'string',
  },
};

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

/**
 * Parse a PROXI binary (Uint8Array or ArrayBuffer) into a structured object.
 *
 * Returns:
 * {
 *   ok: boolean,
 *   error?: string,
 *   formatVersion: number,
 *   sectionCount: number,
 *   totalLength: number,
 *   sections: Array<{
 *     id: number,
 *     name: string,
 *     payload: Uint8Array,   // raw section bytes (opaque)
 *   }>,
 *   recordCrc: number,
 *   computedCrc: number,
 *   crcValid: boolean,
 *   raw: Uint8Array,         // original bytes, always present
 * }
 */
export function parseProxi(input) {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (raw.length < 6) {
    return { ok: false, error: `Buffer too short (${raw.length} bytes, need at least 6)`, raw };
  }

  const sectionCount = raw[0];
  const formatVersion = raw[1];
  const totalLength = (raw[3] << 8) | raw[2];

  if (raw.length < totalLength) {
    return {
      ok: false,
      error: `Buffer (${raw.length} B) shorter than declared totalLength (${totalLength} B)`,
      raw,
    };
  }

  const payload = raw.slice(0, totalLength);
  const recordCrc = (payload[totalLength - 2] << 8) | payload[totalLength - 1];
  const computedCrc = crc16CcittFalse(payload.slice(0, totalLength - 2));
  const crcValid = recordCrc === computedCrc;

  if (!crcValid) {
    return {
      ok: false,
      error: `CRC mismatch: stored=0x${recordCrc.toString(16).toUpperCase().padStart(4, '0')} computed=0x${computedCrc.toString(16).toUpperCase().padStart(4, '0')}`,
      raw,
      recordCrc,
      computedCrc,
      crcValid: false,
    };
  }

  const sections = [];
  let cursor = 4;
  for (let s = 0; s < sectionCount && cursor + 2 <= totalLength - 2; s++) {
    const id = payload[cursor];
    const len = payload[cursor + 1];
    cursor += 2;
    if (cursor + len > totalLength - 2) {
      return {
        ok: false,
        error: `Section ${s} (id=0x${id.toString(16)}) claims ${len} bytes but only ${totalLength - 2 - cursor} remain`,
        raw,
        sections,
        formatVersion,
        sectionCount,
        totalLength,
        recordCrc,
        computedCrc,
        crcValid,
      };
    }
    const sectionPayload = payload.slice(cursor, cursor + len);
    sections.push({
      id,
      name: SECTION_NAMES[id] ?? `Section 0x${id.toString(16).toUpperCase().padStart(2, '0')}`,
      payload: sectionPayload,
    });
    cursor += len;
  }

  return {
    ok: true,
    formatVersion,
    sectionCount,
    totalLength,
    sections,
    recordCrc,
    computedCrc,
    crcValid,
    raw,
  };
}

/**
 * Serialize a parsed PROXI object back to bytes. Recomputes the CRC.
 * Unknown bytes (opaque section payloads) are preserved verbatim.
 *
 * @param {object} parsed  — result from parseProxi()
 * @returns Uint8Array
 */
export function serializeProxi(parsed) {
  const { formatVersion, sectionCount, sections } = parsed;

  let sectionsLen = 0;
  for (const s of sections) {
    sectionsLen += 2 + s.payload.length;
  }

  const totalLength = 4 + sectionsLen + 2;
  const out = new Uint8Array(totalLength);

  out[0] = sectionCount & 0xff;
  out[1] = formatVersion & 0xff;
  out[2] = totalLength & 0xff;
  out[3] = (totalLength >> 8) & 0xff;

  let cursor = 4;
  for (const s of sections) {
    out[cursor++] = s.id & 0xff;
    out[cursor++] = s.payload.length & 0xff;
    out.set(s.payload, cursor);
    cursor += s.payload.length;
  }

  const crc = crc16CcittFalse(out.slice(0, totalLength - 2));
  out[totalLength - 2] = (crc >> 8) & 0xff;
  out[totalLength - 1] = crc & 0xff;

  return out;
}

/**
 * Validate the shape of a license.json object.
 *
 * Returns { valid: boolean, errors: string[] }
 */
export function validateLicenseJson(obj) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['license.json must be a JSON object'] };
  }
  const errors = [];
  for (const key of LICENSE_SCHEMA.required) {
    if (!(key in obj)) {
      errors.push(`Missing required field: "${key}"`);
      continue;
    }
    const expectedType = LICENSE_SCHEMA.types[key];
    const actualType = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
    if (actualType !== expectedType) {
      errors.push(`Field "${key}" must be ${expectedType}, got ${actualType}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Verify a vendor manifest: check that each file listed in the manifest
 * has the expected byte size.
 *
 * @param {object} manifest      — parsed manifest.json
 * @param {object} fileSizeMap   — { filename: actualByteSize }
 * @returns { ok: boolean, failures: string[] }
 */
export function verifyManifest(manifest, fileSizeMap) {
  const failures = [];
  for (const [filename, info] of Object.entries(manifest.files ?? {})) {
    if (!(filename in fileSizeMap)) {
      failures.push(`${filename}: not present`);
      continue;
    }
    const actual = fileSizeMap[filename];
    if (actual !== info.size) {
      failures.push(`${filename}: expected ${info.size} bytes, got ${actual}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Build a synthetic PROXI record from a list of sections.
 * Useful for creating test fixtures.
 *
 * @param {Array<{id: number, payload: Uint8Array}>} sections
 * @param {number} [formatVersion=1]
 * @returns Uint8Array
 */
export function buildProxi(sections, formatVersion = 1) {
  return serializeProxi({
    formatVersion,
    sectionCount: sections.length,
    sections: sections.map((s) => ({
      id: s.id,
      name: SECTION_NAMES[s.id] ?? `Section 0x${s.id.toString(16)}`,
      payload: s.payload instanceof Uint8Array ? s.payload : new Uint8Array(s.payload),
    })),
  });
}
