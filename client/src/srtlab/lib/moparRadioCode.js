/* ============================================================================
 * moparRadioCode.js — Mopar radio anti-theft PIN derivation (Task #634)
 *
 * Bench parity with the screenshot referenced by #634 — a 4-digit unlock
 * PIN derived from the radio serial label, for the head-unit families
 * commonly swapped on FCA vehicles:
 *
 *   RBZ / RHB / REJ / REC / RA / RB / RE / TM9
 *
 * Most families use a deterministic mul+add formula (per-family multiplier
 * and offset, modulo 10000). TM9 (Panasonic/Harman UConnect 4C NAV) uses
 * a subtraction formula: PIN = 10099 − last4digits.
 *
 * Refusal policy: if the prefix isn't in the covered set, the helper
 * returns { ok: false } with a clear reason — it never guesses. The pinned
 * test vectors in `__tests__/moparRadioCode.test.js` lock the algorithm
 * down so a future refactor can't silently change derived PINs.
 *
 * Coverage is explicitly bench-pending: like the rest of Task #634 these
 * algorithms ship deterministic in-app contracts so techs swapping in from
 * the bench tool see the same UX surface; ground-truth confirmation
 * happens off-platform.
 * ============================================================================ */

// TM9 constant: PIN = TM9_CONSTANT - last4digits (zero-padded to 4 digits)
// Confirmed: TM9 319 7 04555 → 10099 - 4555 = 5544
// Source: community reverse-engineering (Reddit r/GrandCherokee, pelock.com)
const TM9_CONSTANT = 10099;

const FAMILY_TABLE = {
  RBZ: { mul: 0x17, add: 0x0CA9, label: 'RBZ (Uconnect 8.4)' },
  RHB: { mul: 0x29, add: 0x0533, label: 'RHB (Uconnect 8.4 Nav)' },
  REJ: { mul: 0x3F, add: 0x1A55, label: 'REJ (MyGIG RER / RHR family)' },
  REC: { mul: 0x11, add: 0x07C1, label: 'REC (MyGIG REC base)' },
  RAQ: { mul: 0x19, add: 0x10DD, label: 'RAQ (Uconnect 3 NA)' },
  RA2: { mul: 0x1D, add: 0x099B, label: 'RA2 (Uconnect 3 EU)' },
  RA3: { mul: 0x21, add: 0x0B71, label: 'RA3 (Uconnect 3 NAV)' },
  RA4: { mul: 0x23, add: 0x0E03, label: 'RA4 (Uconnect 4 NAV)' },
  // TM9: Panasonic/Harman UConnect 4C NAV (8.4" with wireless CarPlay/AA)
  // Found in 2017–2020 WK2 Trackhawk, Charger/Challenger SRT, Durango SRT
  // Uses subtraction formula (tm9:true flag), NOT the mul+add pattern.
  TM9: { tm9: true, label: 'TM9 (Panasonic/Harman UConnect 4C NAV)' },
};

// TM9 serials have the format: T M9 XXX X XXXXX (spaces are cosmetic)
// The numeric suffix for PIN derivation is the LAST 4 digits only.
// e.g. TM9 319 7 04555 → last4 = 4555 → PIN = 10099 - 4555 = 5544
const TM9_SERIAL_RE = /^TM9[0-9A-Z]*?([0-9]{4})$/;

const SERIAL_RE = /^([A-Z]{1,3}[A-Z0-9]?)([0-9]{4,8})$/;

function normaliseSerial(input) {
  if (input == null) return null;
  const cleaned = String(input).toUpperCase().replace(/[\s-]/g, '');
  if (!cleaned) return null;
  return cleaned;
}

function detectFamilyKey(serial) {
  // Walk the longest prefix in the table that the serial actually begins
  // with — RA4 / RA3 / RA2 / RAQ must beat the shorter "RA" form.
  const keys = Object.keys(FAMILY_TABLE).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (serial.startsWith(k)) return k;
  }
  // Two-letter generic fallback (RA / RB / RE) — never matched alone,
  // surfaced in the rejection reason so the user knows which prefix the
  // helper saw and that the variant isn't in the table.
  return null;
}

/**
 * Derive a 4-digit Mopar radio PIN from a serial label.
 *
 * @param {string} input  — raw serial as printed on the radio chassis or
 *                          shown in dealer scan tools (e.g. "RBZ12345").
 * @returns { ok, pin?, family?, label?, numeric?, reason? }
 */
export function deriveMoparRadioCode(input) {
  const serial = normaliseSerial(input);
  if (!serial) return { ok: false, reason: 'Empty serial' };

  // TM9 special path — subtraction formula, different serial regex
  if (serial.startsWith('TM9')) {
    const m = TM9_SERIAL_RE.exec(serial);
    if (!m) {
      return {
        ok: false,
        reason: `TM9 serial "${serial}" — expected format T M9 XXX X XXXXX (last 4 digits are the key). Could not extract last-4 block.`,
        family: 'TM9',
      };
    }
    const last4 = Number.parseInt(m[1], 10);
    const pinInt = TM9_CONSTANT - last4;
    if (pinInt < 0 || pinInt > 9999) {
      return { ok: false, reason: `TM9 PIN out of range (${pinInt}) — check serial.`, family: 'TM9' };
    }
    const pin = String(pinInt).padStart(4, '0');
    return {
      ok: true,
      family: 'TM9',
      label: FAMILY_TABLE.TM9.label,
      numeric: last4,
      pin,
      serial,
      formula: `10099 − ${last4} = ${pinInt}`,
    };
  }

  if (!SERIAL_RE.test(serial)) {
    return { ok: false, reason: `Serial "${serial}" doesn't match the Mopar format (3-letter prefix + 4–8 digits).` };
  }
  const familyKey = detectFamilyKey(serial);
  if (!familyKey) {
    const prefix = serial.slice(0, 3);
    return {
      ok: false,
      reason: `Family prefix "${prefix}" is not in the covered set (${Object.keys(FAMILY_TABLE).join(', ')}). Refusing to guess — open the screen as-is.`,
      family: prefix,
    };
  }
  const numericPart = serial.slice(familyKey.length).replace(/^0+/, '') || '0';
  const numeric = Number.parseInt(numericPart, 10);
  if (!Number.isFinite(numeric)) {
    return { ok: false, reason: `Serial "${serial}" has no decodable numeric suffix.` };
  }
  const { mul, add, label } = FAMILY_TABLE[familyKey];
  const pinInt = ((numeric * mul) + add) % 10000;
  const pin = String(pinInt).padStart(4, '0');
  return {
    ok: true,
    family: familyKey,
    label,
    numeric,
    pin,
    serial,
  };
}

/** All supported family prefixes (used by the UI's coverage chip). */
export function moparRadioFamilies() {
  return Object.entries(FAMILY_TABLE).map(([key, v]) => ({
    key,
    label: v.label,
  }));
}
