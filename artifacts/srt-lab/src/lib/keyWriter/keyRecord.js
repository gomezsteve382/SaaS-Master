/* ============================================================================
 * keyRecord.js — standalone captured-transponder "key dump" model (Task #985).
 *
 * The RFHUB-slot burn path (serializer.js + index.js) only works off a loaded
 * RFHUB EEPROM dump: it pulls a slot's UID + the 16-byte SEC16 master secret.
 * But a bench operator often reads a transponder *directly* with an external
 * tool (Autel/VVDI) which reports a chip identity and a *calculated SK* — the
 * per-transponder secret — with no RFHUB dump behind it.
 *
 * This module models that standalone read so the operator can capture it,
 * clone it ("copy to new key"), and export a portable key-dump file for their
 * external tool. No physical burn happens from this path — file export only.
 *
 * ┌──────────────────────────── SK ≠ SEC16 ─────────────────────────────────┐
 * │ SK is the per-transponder secret the external tool computed (e.g. a      │
 * │ HITAG2 48-bit / 6-byte crypto key). The 16-byte RFHUB SEC16 master       │
 * │ secret is a different artefact entirely. The two are never conflated     │
 * │ here: a key record has an `sk` field, never a `sec16` field, and the      │
 * │ optional RFHUB prefill (see KeyWriterTab) copies the slot UID but leaves  │
 * │ SK blank for the operator to type from their tool.                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 * ========================================================================== */

import { chipFamily } from './chipFamilies.js';

/* Coding schemes an external tool may report for a transponder read. The
 * ordinal is what the compact raw .bin records (see autelExport.js). */
export const CODING_SCHEMES = [
  { id: 'manchester', label: 'Manchester', ordinal: 0x01 },
  { id: 'biphase',    label: 'Bi-phase',   ordinal: 0x02 },
  { id: 'psk',        label: 'PSK',        ordinal: 0x03 },
  { id: 'fsk',        label: 'FSK',        ordinal: 0x04 },
];

const CODING_BY_ID = new Map(CODING_SCHEMES.map((c) => [c.id, c]));

export function codingScheme(id) {
  return CODING_BY_ID.get(id) || null;
}

/* Default flag set mirrors the common "clean read" an external tool reports
 * for an unlocked, Manchester-coded, crypto-enabled, cloneable transponder. */
export function defaultFlags() {
  return {
    locked: false,
    coding: 'manchester',
    encryption: true,
    cloneable: true,
  };
}

let __seq = 0;
function nextId() {
  __seq += 1;
  return `key-${Date.now().toString(36)}-${__seq}`;
}

/* Parse a loose hex string ("00 77 A2 9B", "0077a29b", "0x0077A29B") into a
 * Uint8Array. Returns null if the string contains non-hex characters or an
 * odd number of nibbles — refuse-on-doubt: never silently truncate. */
export function parseHexBytes(str) {
  if (str == null) return null;
  let s = String(str).trim().replace(/^0x/i, '').replace(/[\s:_-]/g, '');
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHexCompact(u8) {
  return [...u8].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

export function bytesToHexSpaced(u8) {
  return [...u8].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function isBlankBytes(u8) {
  if (!u8 || u8.length === 0) return true;
  let allFF = true, all00 = true;
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] !== 0xFF) allFF = false;
    if (u8[i] !== 0x00) all00 = false;
    if (!allFF && !all00) return false;
  }
  return allFF || all00;
}

/* Build an in-memory key record from raw form inputs. Hex fields stay as the
 * operator typed them (so the form can round-trip edits); the parsed byte
 * views are recomputed on demand by validateKeyRecord / the exporters. */
export function makeKeyRecord({
  chipId = 'id46',
  uidHex = '',
  skHex = '',
  flags = null,
  label = '',
} = {}) {
  return {
    id: nextId(),
    chipId,
    uidHex,
    skHex,
    flags: { ...defaultFlags(), ...(flags || {}) },
    label,
  };
}

/* Deep clone a record into a brand-new, separately-editable entry ("copy to
 * new key"). The clone gets a fresh id and a "(copy)" label hint so the
 * operator can tell the two apart before exporting. */
export function cloneKeyRecord(rec) {
  if (!rec) return makeKeyRecord();
  const baseLabel = (rec.label || '').trim();
  return {
    id: nextId(),
    chipId: rec.chipId,
    uidHex: rec.uidHex,
    skHex: rec.skHex,
    flags: { ...defaultFlags(), ...(rec.flags || {}) },
    label: baseLabel ? `${baseLabel} (copy)` : 'copy',
  };
}

/* Refuse-on-doubt validation, mirroring the serializer/securityBytes gates.
 * Returns { ok, error?, uid?, sk?, chipDef? }. A record only validates if:
 *   - chip family is known
 *   - UID parses, is non-blank, and matches the family UID length
 *   - SK  parses, is non-blank, and matches the family SK length
 *   - coding scheme is one we recognise
 */
export function validateKeyRecord(rec) {
  if (!rec || typeof rec !== 'object') {
    return { ok: false, error: 'No key record supplied' };
  }
  const chipDef = chipFamily(rec.chipId);
  if (!chipDef) {
    return { ok: false, error: `Unknown chip family: ${rec.chipId}` };
  }
  if (!Number.isInteger(chipDef.uidBytes) || !Number.isInteger(chipDef.skBytes)) {
    return { ok: false, error: `Chip family ${chipDef.id} has no documented UID/SK length` };
  }

  const uid = parseHexBytes(rec.uidHex);
  if (uid == null) {
    return { ok: false, error: 'UID is not valid hex (need whole bytes, hex digits only)' };
  }
  if (uid.length !== chipDef.uidBytes) {
    return {
      ok: false,
      error: `UID length ${uid.length} B does not match ${chipDef.id} (expected ${chipDef.uidBytes} B)`,
    };
  }
  if (isBlankBytes(uid)) {
    return { ok: false, error: 'UID is blank (all 0xFF / 0x00) — refusing export' };
  }

  const sk = parseHexBytes(rec.skHex);
  if (sk == null) {
    return { ok: false, error: 'SK is not valid hex (need whole bytes, hex digits only)' };
  }
  if (sk.length !== chipDef.skBytes) {
    return {
      ok: false,
      error: `SK length ${sk.length} B does not match ${chipDef.id} (expected ${chipDef.skBytes} B)`,
    };
  }
  if (isBlankBytes(sk)) {
    return { ok: false, error: 'SK is blank (all 0xFF / 0x00) — refusing export' };
  }

  const flags = rec.flags || {};
  if (!codingScheme(flags.coding)) {
    return { ok: false, error: `Unknown coding scheme: ${flags.coding}` };
  }

  return { ok: true, uid, sk, chipDef };
}
