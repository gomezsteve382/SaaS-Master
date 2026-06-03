/* ============================================================================
 * knownWorkingKeys.js — curated registry of CONFIRMED working transponder
 * keys (Task #1096).
 *
 * The Key Dump card (keyRecord.js) and the per-VIN key history (keyHistory.js)
 * capture whatever the operator reads from their bench tool — but neither has
 * any notion of a *ground-truth* "this key actually starts the car" entry.
 * This module is that ground truth, modelled on rfhPinnedRegistry.js: a frozen
 * data table plus a handful of pure lookup / classification / prefill helpers.
 *
 * Seeded with the first key dump from the 2019 Charger 6.2 RFHUB package — an
 * Autel read of the working fob that the operator confirmed starts the car.
 *
 * ┌──────────────────────────── SK ≠ SEC16 ─────────────────────────────────┐
 * │ The `sk` stored here is the per-transponder secret an external tool       │
 * │ (Autel/VVDI) reports — for these FCA chips the UNIVERSAL "MIKRON" default │
 * │ (4F4E4D494B52). It is NOT the per-vehicle differentiator and it is NOT    │
 * │ the 16-byte RFHUB SEC16 master secret. Prefill sets SK from this          │
 * │ documented value; it never copies SEC16 into the SK field.                │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌──────────────────────────── INDEX BYTE ─────────────────────────────────┐
 * │ `tableIndex` (0x48 for the seed) is stored as DATA only. Deriving it      │
 * │ algorithmically is the package's open problem (SEARCH_SPEC.md) and is     │
 * │ explicitly out of scope here. The empty-slot template low byte 0x95 is    │
 * │ recorded as a NON-KEY sentinel so it can never be presented as known-good │
 * │ (an earlier failed add used 0x95).                                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 * ========================================================================== */

import { chipFamily } from './chipFamilies.js';
import { makeKeyRecord } from './keyRecord.js';
import { normalizeVin } from './keyHistory.js';

/* Empty-slot template low byte + revUID (5A 5A 5A 5A 95 00). This is the
 * "no key here" marker in the Charger RFHUB key table — NOT a real key. The
 * registry records it so the UI and classifier can refuse to ever treat it as
 * known-good. */
export const EMPTY_SLOT_MARKER = Object.freeze({
  index: 0x95,
  flag: 0x00,
  revUid: '5A5A5A5A',
  note: 'Empty-slot template (5A 5A 5A 5A 95 00) — NOT a real key. Never present as known-good.',
});

/* Each entry:
 *   id          — stable key for React lists / lookups.
 *   vin         — OPTIONAL. null = a global known-good usable on any vehicle.
 *   keyId       — BE, exactly as the Autel programmer prints it (4-byte chip UID).
 *   revUid      — LE, byte-reversed keyId, as stored in the RFHUB table.
 *   chipId      — chipFamilies.js id (drives UID/SK length validation).
 *   sk          — documented per-transponder secret key (compact hex).
 *   flags       — coding/locked/encryption/cloneable as the tool reported.
 *   tableIndex / tableFlag / tableAddr — RFHUB table placement (DATA only).
 *   vehicle     — human label for the source vehicle.
 *   profile     — chip-profile extras kept for provenance/reference only.
 *   provenance  — where the entry came from + the confirmation.
 */
export const KNOWN_WORKING_KEYS = Object.freeze([
  Object.freeze({
    id: 'charger62-2019-0077A29B',
    vin: null,
    keyId: '0077A29B',
    revUid: '9BA27700',
    chipId: 'id46',
    sk: '4F4E4D494B52',
    flags: Object.freeze({ locked: false, coding: 'manchester', encryption: true, cloneable: true }),
    tableIndex: 0x48,
    tableFlag: 0x01,
    tableAddr: 0x0C7E,
    vehicle: '2019 Charger 6.2 (RFHUB EEPROM)',
    profile: Object.freeze({
      configuration: '08AA4854',
      page0: 'FFFFFFFF',
      page1: '50207755',
      page2: '01000000',
      page3: 'FF6E5500',
    }),
    provenance:
      'Autel programmer read of working fob (starts the car) = key #1 in 2019 Charger 6.2 dump',
  }),
]);

/* Normalize a hex token the same way dedupeKey / validateKeyRecord do: strip
 * separators + an optional 0x prefix, uppercase. */
function normHex(s) {
  return String(s == null ? '' : s).replace(/^0x/i, '').replace(/[\s:_-]/g, '').toUpperCase();
}

function normChip(s) {
  return String(s == null ? '' : s).toLowerCase();
}

/* All-FF / all-00 over the parsed nibbles → "blank", refuse to classify. */
function isBlankHex(h) {
  if (!h || h.length === 0) return true;
  return /^(?:FF)+$/.test(h) || /^(?:00)+$/.test(h);
}

/* A well-formed byte string: non-empty, even nibble count, hex only. Anything
 * else (stray non-hex chars, odd length) is malformed → refuse-on-doubt. */
function isValidHexBytes(h) {
  return !!h && h.length % 2 === 0 && /^[0-9A-F]+$/.test(h);
}

/** A human label for an entry (used by the UI list + prefill). */
export function knownKeyLabel(entry) {
  if (!entry) return '';
  return `${entry.vehicle} — known-good ${entry.keyId}`;
}

/** True if the supplied {index|revUid|keyId} is the empty-slot sentinel. */
export function isEmptySlotMarker({ index, revUid, keyId } = {}) {
  if (Number.isInteger(index) && index === EMPTY_SLOT_MARKER.index) return true;
  const r = normHex(revUid != null ? revUid : keyId);
  return r === EMPTY_SLOT_MARKER.revUid;
}

/* Look up a single entry by id. Returns null when absent. */
export function getKnownWorkingKeyById(id) {
  if (!id) return null;
  return KNOWN_WORKING_KEYS.find((e) => e.id === id) || null;
}

/**
 * Return the known-good keys applicable to `vin`: every global entry (vin ==
 * null) plus any entry whose VIN matches the normalized argument. With no /
 * invalid VIN, only the globals are returned. Result is a fresh array.
 */
export function getKnownWorkingKeys(vin) {
  const norm = normalizeVin(vin);
  return KNOWN_WORKING_KEYS.filter((e) => !e.vin || (norm && e.vin === norm));
}

/**
 * Classify a captured/typed key record against the registry.
 *
 * Returns { status, entry, mismatchedFields }:
 *   'known-good' — chipId + UID + SK all match a registry entry.
 *   'mismatch'   — UID matches a registry entry but chipId and/or SK differ
 *                  (mismatchedFields lists which: 'chipId' / 'sk').
 *   'unknown'    — no registry entry shares this UID, OR the input is blank /
 *                  unparseable / the empty-slot sentinel (refuse-on-doubt).
 *
 * UID comparison uses the BE keyId form the operator types into the Key Dump
 * card (matching the placeholder "00 77 A2 9B"). `vin` scopes the candidate
 * set the same way getKnownWorkingKeys does.
 */
export function classifyAgainstRegistry(record, vin) {
  const uid = normHex(record?.uidHex);
  const sk = normHex(record?.skHex);
  const chip = normChip(record?.chipId);

  // Refuse-on-doubt: need a well-formed, non-blank UID + SK + chip to say
  // anything. Malformed hex (stray chars, odd length) is treated as unknown,
  // never allowed to fall through to a UID-only 'mismatch'.
  if (
    !chip ||
    !isValidHexBytes(uid) ||
    !isValidHexBytes(sk) ||
    isBlankHex(uid) ||
    isBlankHex(sk)
  ) {
    return { status: 'unknown', entry: null, mismatchedFields: [] };
  }
  // The empty-slot sentinel is never a real key.
  if (isEmptySlotMarker({ keyId: uid })) {
    return { status: 'unknown', entry: null, mismatchedFields: [] };
  }

  const candidates = getKnownWorkingKeys(vin);
  const entry = candidates.find((e) => normHex(e.keyId) === uid) || null;
  if (!entry) return { status: 'unknown', entry: null, mismatchedFields: [] };

  const mismatchedFields = [];
  if (normChip(entry.chipId) !== chip) mismatchedFields.push('chipId');
  if (normHex(entry.sk) !== sk) mismatchedFields.push('sk');

  if (mismatchedFields.length === 0) {
    return { status: 'known-good', entry, mismatchedFields: [] };
  }
  return { status: 'mismatch', entry, mismatchedFields };
}

/**
 * Build a fresh, editable makeKeyRecord from a registry entry, for prefilling
 * the Key Dump card. UID = the BE keyId; SK = the documented per-transponder
 * secret (NEVER SEC16). Returns null when the entry's chip family is unknown
 * (refuse-on-doubt — a record we couldn't validate is useless for prefill).
 */
export function knownKeyToRecord(entry) {
  if (!entry || !chipFamily(entry.chipId)) return null;
  return makeKeyRecord({
    chipId: entry.chipId,
    uidHex: entry.keyId,
    skHex: entry.sk,
    flags: entry.flags,
    label: knownKeyLabel(entry),
  });
}
