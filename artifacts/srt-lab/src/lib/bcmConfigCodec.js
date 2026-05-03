/**
 * bcmConfigCodec.js — encode/decode bit-field BCM Configuration DIDs
 * (0xDE00..0xDE0C) using DE_FEATURE_CATALOG.
 *
 * Bit positions in the catalog are GLOBAL into each DID's response
 * payload, MSB-first — i.e. for a field at bit B and length L, the
 * value is read as L sequential bits starting at the B-th bit of the
 * payload, where bit 0 is the MSB of byte 0. This matches the
 * convention used by `proxiFieldCatalog.readProxiField` (with
 * byte=0, bit=field.bit).
 *
 * The codec is symmetric: encode(decode(p)) === p for any payload
 * sized to fit the DID's catalog (verified by tests).
 *
 * Public API:
 *   - groupCatalogByDid()      → Map<didNum, fields[]>
 *   - didPayloadByteLength(d)  → required payload size in bytes
 *   - decodeBcmDid(d, payload) → array of {field, raw, label}
 *   - encodeBcmDid(d, valueMap, basePayload?) → Uint8Array
 *
 * `valueMap` is { [field.name]: number }. Missing names are taken
 * from `basePayload` (so partial edits preserve unrelated bits — the
 * caller should always pass the freshly-read payload as basePayload).
 */

import { DE_FEATURE_CATALOG } from './bcmFeatureCatalog.generated.js';
import {
  BCM_CONFIG_EXTRA_CATALOG,
  BCM_CONFIG_EXTRA_DIDS,
} from './bcmFeatureCatalogExtra.js';

/* DE00..DE0C plus hand-curated extras (e.g. 0x05AE — Red Key Feature
 * Present and the rest of the BCM Body presence flags). */
export const BCM_CONFIG_DIDS = [
  0xDE00, 0xDE01, 0xDE02, 0xDE03, 0xDE04, 0xDE05, 0xDE06,
  0xDE07, 0xDE08, 0xDE09, 0xDE0A, 0xDE0B, 0xDE0C,
  ...BCM_CONFIG_EXTRA_DIDS,
];

function didKey(did) {
  const hi = (did >> 8) & 0xFF;
  if (hi === 0xDE) return 'DE' + (did & 0xFF).toString(16).toUpperCase().padStart(2, '0');
  return did.toString(16).toUpperCase().padStart(4, '0');
}

let _grouped = null;
export function groupCatalogByDid() {
  if (_grouped) return _grouped;
  const m = new Map();
  for (const did of BCM_CONFIG_DIDS) {
    m.set(did, []);
  }
  // request strings of the form "DEnn" map to 0xDE00|nn. Extra rows use
  // a 4-hex-char request like "05AE" — map directly.
  for (const f of [...DE_FEATURE_CATALOG, ...BCM_CONFIG_EXTRA_CATALOG]) {
    let did;
    if (/^DE/i.test(f.request)) {
      const num = parseInt(f.request.replace(/^DE/i, ''), 16);
      did = 0xDE00 | num;
    } else {
      did = parseInt(f.request, 16);
    }
    if (!m.has(did)) m.set(did, []);
    m.get(did).push(f);
  }
  _grouped = m;
  return m;
}

/* Required payload size for a DID = ceil(max(bit+length)/8). */
export function didPayloadByteLength(did) {
  const fields = groupCatalogByDid().get(did) || [];
  let maxBit = 0;
  for (const f of fields) {
    const end = f.bit + f.length;
    if (end > maxBit) maxBit = end;
  }
  return Math.ceil(maxBit / 8);
}

/* Read L bits starting at global bit B (MSB-first within byte 0). */
export function readBits(payload, bit, length) {
  if (!payload || length <= 0) return 0;
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  let v = 0;
  for (let i = 0; i < length; i++) {
    const abs = bit + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    if (byteIdx < 0 || byteIdx >= bytes.length) return null;
    v = (v << 1) | ((bytes[byteIdx] >> bitIdx) & 1);
  }
  return v;
}

/* Write L bits of value V at global bit B into `bytes` (mutated). */
export function writeBits(bytes, bit, length, value) {
  if (length <= 0) return;
  // Mask value to length to avoid clobbering neighbouring bits.
  const max = length >= 31 ? 0xFFFFFFFF : ((1 << length) - 1);
  const v = (value >>> 0) & max;
  for (let i = 0; i < length; i++) {
    const abs = bit + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    if (byteIdx < 0 || byteIdx >= bytes.length) {
      throw new RangeError(
        `writeBits: bit ${abs} out of range for ${bytes.length}-byte buffer`,
      );
    }
    // Most-significant source bit first.
    const srcBit = (v >> (length - 1 - i)) & 1;
    if (srcBit) bytes[byteIdx] |= (1 << bitIdx);
    else        bytes[byteIdx] &= ~(1 << bitIdx);
  }
}

function labelForRaw(field, raw) {
  if (raw == null) return '(out of range)';
  if (!field.options || field.options.length === 0) return String(raw);
  const hit = field.options.find((o) => o.value === raw);
  return hit ? hit.label : String(raw);
}

/* Decode every catalog field for the DID against the read payload. */
export function decodeBcmDid(did, payload) {
  const fields = groupCatalogByDid().get(did) || [];
  return fields.map((f) => {
    const raw = readBits(payload, f.bit, f.length);
    return {
      field: f,
      raw,
      label: labelForRaw(f, raw),
    };
  });
}

/* Build a writable payload for the DID, starting from basePayload
 * (or zeros if not provided / wrong length) and overlaying every
 * field listed in valueMap. Returns a fresh Uint8Array — does not
 * mutate basePayload. */
export function encodeBcmDid(did, valueMap, basePayload = null) {
  const fields = groupCatalogByDid().get(did) || [];
  const need = didPayloadByteLength(did);
  const out = new Uint8Array(need);
  if (basePayload && basePayload.length === need) {
    out.set(basePayload);
  } else if (basePayload && basePayload.length > 0) {
    out.set(basePayload.subarray(0, Math.min(basePayload.length, need)));
  }
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(valueMap || {}, f.name)) continue;
    const v = valueMap[f.name];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    writeBits(out, f.bit, f.length, v);
  }
  return out;
}

/* Convenience for UI: name → field record. */
export function fieldsForDid(did) {
  return groupCatalogByDid().get(did) || [];
}

/* Stable display name for a DID. */
export function bcmDidName(did) {
  const fields = groupCatalogByDid().get(did) || [];
  return fields.length > 0 ? fields[0].groupName : didKey(did);
}

export { didKey as bcmDidLabel };
