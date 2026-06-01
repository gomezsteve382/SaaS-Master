/* ============================================================================
 * keyDump.js — Task #985
 *
 * A *standalone* captured transponder-key record. Unlike the Autel/Key-Writer
 * export (which pulls a UID + the 16-byte RFHUB SEC16 master secret out of a
 * loaded RFHUB EEPROM dump), this models a key an operator reads directly with
 * an external bench tool (Autel IM608 / Xhorse VVDI). That read reports:
 *
 *   - a chip family   (e.g. PCF7945A/53A, HITAG2/ID46)
 *   - a UID           (4 bytes for HITAG2)
 *   - a calculated SK (the transponder *secret key* the tool derived — 6 bytes
 *                      / 48-bit for HITAG2). This is NOT the RFHUB SEC16.
 *   - chip flags      (locked, coding scheme, encryption mode, cloneable)
 *
 * There is no RFHUB behind it, so nothing here touches SEC16. The operator can
 * capture the read, copy it to a new editable key, and export:
 *
 *   1. A human-readable JSON manifest with every field labelled.
 *   2. A compact raw .bin "KDMP" record:
 *        offset  0 : magic   4B 44 4D 50   ("KDMP")
 *        offset  4 : version 01
 *        offset  5 : chip ordinal (01=pcf7953, 02=pcf7945, 10=megamos-aes, FF=unknown)
 *        offset  6 : UID length in bytes
 *        offset  7 : SK length in bytes
 *        offset  8 : flags bitfield  (bit0 locked, bit1 encryption, bit2 cloneable)
 *        offset  9 : coding ordinal  (index into CODING_SCHEMES, FF=unknown)
 *        offset 10 : UID bytes
 *        offset 10+uidLen : SK bytes
 *        total = 10 + uidLen + skLen
 *
 * Both artefacts are a clearly-labelled *portable intermediate* for the
 * operator's own external tool — NOT a verified Autel/VVDI vendor import format.
 * ========================================================================== */

import { chipFamily } from './keyWriter/chipFamilies.js';

export const KEY_DUMP_MAGIC = [0x4b, 0x44, 0x4d, 0x50]; // "KDMP"
export const KEY_DUMP_VERSION = 0x01;
export const KEY_DUMP_HEADER_LEN = 10;

/* Single-byte chip ordinal for the .bin header. Mirrors the values used by the
 * Key Writer serializer / Autel export so a downstream script can treat them
 * the same. Kept inline (rather than imported) so this stays a pure-data leaf
 * module that does not pull in the writer protocol. */
export const KEY_DUMP_CHIP_ORDINAL = {
  pcf7953: 0x01,
  pcf7945: 0x02,
  'megamos-aes': 0x10,
};
const ORDINAL_TO_CHIP = Object.fromEntries(
  Object.entries(KEY_DUMP_CHIP_ORDINAL).map(([k, v]) => [v, k]),
);

/* Coding schemes the external tool reports. Index = ordinal in the .bin. */
export const CODING_SCHEMES = [
  'Manchester coding',
  'Bi-phase coding',
  'PSK',
  'Unknown',
];

const FLAG_LOCKED = 0x01;
const FLAG_ENCRYPTION = 0x02;
const FLAG_CLONEABLE = 0x04;

function toHexStr(u8) {
  return [...u8].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
function toHexStrCompact(u8) {
  return [...u8].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

function isBlank(u8) {
  if (!u8 || u8.length === 0) return true;
  let allFF = true;
  let all00 = true;
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] !== 0xff) allFF = false;
    if (u8[i] !== 0x00) all00 = false;
    if (!allFF && !all00) return false;
  }
  return allFF || all00;
}

/**
 * Parse a hex string into bytes — refuse-on-doubt (strict).
 *
 * Accepts hex bytes separated only by whitespace and/or commas, with an
 * optional `0x`/`0X` prefix per token:
 *   "4F4E4D494B52", "4F 4E 4D", "0x4F,0x4E"
 *
 * ANY other character (letters outside 0-9A-F, stray punctuation, an `x` in
 * the middle of a token, a lone `0x`) rejects the WHOLE input rather than
 * being silently stripped. We do not normalise garbage into a passing value.
 *
 * @returns {{ ok: boolean, bytes?: Uint8Array, error?: string }}
 */
export function parseHexBytes(str) {
  if (str == null) return { ok: false, error: 'no hex supplied' };
  const trimmed = String(str).trim();
  if (trimmed.length === 0) return { ok: false, error: 'no hex digits found' };

  const tokens = trimmed.split(/[\s,]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: false, error: 'no hex digits found' };

  let cleaned = '';
  for (const tok of tokens) {
    const body = /^0x/i.test(tok) ? tok.slice(2) : tok;
    if (body.length === 0 || !/^[0-9a-fA-F]+$/.test(body)) {
      return { ok: false, error: `invalid hex token "${tok}"` };
    }
    cleaned += body;
  }

  if (cleaned.length === 0) return { ok: false, error: 'no hex digits found' };
  if (cleaned.length % 2 !== 0) {
    return { ok: false, error: `odd number of hex digits (${cleaned.length}) — need whole bytes` };
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return { ok: true, bytes };
}

/**
 * Build a plain key record from form-ish input. UID/SK accept either hex
 * strings or byte arrays. This does NOT validate — call validateKeyRecord.
 *
 * @returns {{
 *   chipId: string, label: string,
 *   uid: Uint8Array, sk: Uint8Array,
 *   uidError: string|null, skError: string|null,
 *   locked: boolean, encryption: boolean, cloneable: boolean,
 *   coding: string,
 * }}
 */
export function makeKeyRecord({
  chipId = 'pcf7953',
  label = '',
  uid = '',
  sk = '',
  locked = false,
  encryption = false,
  cloneable = false,
  coding = CODING_SCHEMES[0],
} = {}) {
  const coerce = (v) => {
    if (v instanceof Uint8Array) return { ok: true, bytes: v };
    if (Array.isArray(v)) return { ok: true, bytes: new Uint8Array(v) };
    return parseHexBytes(v);
  };
  const uidP = coerce(uid);
  const skP = coerce(sk);
  return {
    chipId,
    label: String(label || ''),
    uid: uidP.ok ? uidP.bytes : new Uint8Array(),
    sk: skP.ok ? skP.bytes : new Uint8Array(),
    uidError: uidP.ok ? null : uidP.error,
    skError: skP.ok ? null : skP.error,
    locked: !!locked,
    encryption: !!encryption,
    cloneable: !!cloneable,
    coding: coding || CODING_SCHEMES[0],
  };
}

/**
 * Refuse-on-doubt validation, consistent with the rest of the app:
 *   - unknown chip family → refuse
 *   - hex that failed to parse → refuse
 *   - blank UID/SK (all 0xFF or all 0x00) → refuse
 *   - wrong-length UID/SK for the selected chip family → refuse
 *
 * @returns {{ ok: boolean, error?: string, uid?: Uint8Array, sk?: Uint8Array, chip?: object }}
 */
export function validateKeyRecord(rec) {
  if (!rec) return { ok: false, error: 'no key record' };
  const chip = chipFamily(rec.chipId);
  if (!chip) return { ok: false, error: `Unknown chip family: ${rec.chipId}` };

  if (rec.uidError) return { ok: false, error: `UID hex invalid: ${rec.uidError}` };
  if (rec.skError) return { ok: false, error: `SK hex invalid: ${rec.skError}` };

  const uid = rec.uid instanceof Uint8Array ? rec.uid : new Uint8Array(rec.uid || []);
  const sk = rec.sk instanceof Uint8Array ? rec.sk : new Uint8Array(rec.sk || []);

  if (uid.length === 0) return { ok: false, error: 'UID is empty' };
  if (uid.length !== chip.uidBytes) {
    return { ok: false, error: `UID length ${uid.length} B does not match ${chip.label} (expected ${chip.uidBytes} B)` };
  }
  if (isBlank(uid)) return { ok: false, error: 'UID is blank (all 0xFF / 0x00) — refusing export' };

  if (sk.length === 0) return { ok: false, error: 'SK is empty' };
  if (chip.skBytes && sk.length !== chip.skBytes) {
    return { ok: false, error: `SK length ${sk.length} B does not match ${chip.label} (expected ${chip.skBytes} B)` };
  }
  if (isBlank(sk)) return { ok: false, error: 'SK is blank (all 0xFF / 0x00) — refusing export' };

  return { ok: true, uid, sk, chip };
}

/**
 * Copy-to-new-key: clone a record into a fresh, separately-editable record.
 * UID/SK byte arrays are deep-copied so edits to the clone never mutate the
 * source. The label gets a " (copy)" suffix.
 */
export function cloneKeyRecord(rec) {
  const base = rec || {};
  const copyBytes = (v) => {
    if (v instanceof Uint8Array) return new Uint8Array(v);
    if (Array.isArray(v)) return new Uint8Array(v);
    return new Uint8Array();
  };
  const label = base.label ? `${base.label} (copy)` : 'Key (copy)';
  return {
    chipId: base.chipId || 'pcf7953',
    label,
    uid: copyBytes(base.uid),
    sk: copyBytes(base.sk),
    uidError: base.uidError ?? null,
    skError: base.skError ?? null,
    locked: !!base.locked,
    encryption: !!base.encryption,
    cloneable: !!base.cloneable,
    coding: base.coding || CODING_SCHEMES[0],
  };
}

/** Build the JSON manifest string for a validated record. */
export function buildKeyDumpManifest(rec) {
  const v = validateKeyRecord(rec);
  const codingIdx = CODING_SCHEMES.indexOf(rec.coding);
  const manifest = {
    _note:
      'Standalone transponder key captured in SRT Lab from an external tool read (Autel/VVDI). ' +
      'Portable intermediate for re-entry into your own programmer — NOT a verified vendor import format.',
    _sk_note:
      'sk_hex is the transponder SECRET KEY reported by the external tool. It is NOT the RFHUB 16-byte SEC16 master secret.',
    valid: v.ok,
    validation_error: v.ok ? null : v.error,
    label: rec.label || null,
    chip_family: rec.chipId,
    chip_label: chipFamily(rec.chipId)?.label || rec.chipId,
    uid_hex: toHexStr(rec.uid || new Uint8Array()),
    uid_hex_compact: toHexStrCompact(rec.uid || new Uint8Array()),
    sk_hex: toHexStr(rec.sk || new Uint8Array()),
    sk_hex_compact: toHexStrCompact(rec.sk || new Uint8Array()),
    flags: {
      locked: !!rec.locked,
      encryption_mode: !!rec.encryption,
      cloneable: !!rec.cloneable,
      coding: rec.coding || CODING_SCHEMES[codingIdx] || 'Unknown',
    },
  };
  return JSON.stringify(manifest, null, 2);
}

/** Build the compact raw "KDMP" .bin for a validated record. */
export function buildKeyDumpBin(rec) {
  const v = validateKeyRecord(rec);
  if (!v.ok) return { ok: false, error: v.error };
  const { uid, sk } = v;
  const ordinal = KEY_DUMP_CHIP_ORDINAL[rec.chipId] ?? 0xff;
  let flags = 0;
  if (rec.locked) flags |= FLAG_LOCKED;
  if (rec.encryption) flags |= FLAG_ENCRYPTION;
  if (rec.cloneable) flags |= FLAG_CLONEABLE;
  const codingIdx = CODING_SCHEMES.indexOf(rec.coding);
  const codingOrd = codingIdx >= 0 ? codingIdx : 0xff;

  const out = new Uint8Array(KEY_DUMP_HEADER_LEN + uid.length + sk.length);
  let i = 0;
  for (const b of KEY_DUMP_MAGIC) out[i++] = b;
  out[i++] = KEY_DUMP_VERSION;
  out[i++] = ordinal;
  out[i++] = uid.length;
  out[i++] = sk.length;
  out[i++] = flags;
  out[i++] = codingOrd;
  out.set(uid, i);
  out.set(sk, i + uid.length);
  return { ok: true, bin: out };
}

/**
 * Parse a "KDMP" .bin back into a record (used for round-trip + re-import).
 * @returns {{ ok: boolean, error?: string, record?: object }}
 */
export function parseKeyDumpBin(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < KEY_DUMP_HEADER_LEN) return { ok: false, error: 'too short for a KDMP header' };
  for (let i = 0; i < KEY_DUMP_MAGIC.length; i++) {
    if (b[i] !== KEY_DUMP_MAGIC[i]) return { ok: false, error: 'bad magic (not a KDMP record)' };
  }
  const version = b[4];
  if (version !== KEY_DUMP_VERSION) return { ok: false, error: `unsupported KDMP version 0x${version.toString(16)}` };
  const ordinal = b[5];
  const uidLen = b[6];
  const skLen = b[7];
  const flags = b[8];
  const codingOrd = b[9];
  const need = KEY_DUMP_HEADER_LEN + uidLen + skLen;
  if (b.length < need) return { ok: false, error: `truncated KDMP (need ${need} B, got ${b.length} B)` };
  const uid = b.slice(KEY_DUMP_HEADER_LEN, KEY_DUMP_HEADER_LEN + uidLen);
  const sk = b.slice(KEY_DUMP_HEADER_LEN + uidLen, KEY_DUMP_HEADER_LEN + uidLen + skLen);
  return {
    ok: true,
    record: {
      chipId: ORDINAL_TO_CHIP[ordinal] || 'unknown',
      label: '',
      uid,
      sk,
      uidError: null,
      skError: null,
      locked: !!(flags & FLAG_LOCKED),
      encryption: !!(flags & FLAG_ENCRYPTION),
      cloneable: !!(flags & FLAG_CLONEABLE),
      coding: CODING_SCHEMES[codingOrd] || 'Unknown',
    },
  };
}

/** Safe base filename for a key dump export. */
export function keyDumpBaseName(rec) {
  const stem = (rec?.label || rec?.chipId || 'key')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const uidPart = rec?.uid?.length ? `_${toHexStrCompact(rec.uid)}` : '';
  return `keydump_${stem || 'key'}${uidPart}`;
}
