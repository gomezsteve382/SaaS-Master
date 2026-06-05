/* ============================================================================
 * rfhubKeyTypeDetector.js — pure (no React) RFHUB blank-key-type detector.
 *
 * Analyzes a loaded RFHUB dump and determines which blank transponder key
 * family the module expects for programming. This is derived from the family
 * flag byte in each key record of the 4 KB Charger/Challenger key table:
 *
 *   flag 0x01 → HITAG 2 / id46 (PCF7945/53) — 2019 and earlier
 *   flag 0x03 → HITAG AES / PCF7953 (alt-family) — 2020/21+ Redeye / Hellcat
 *
 * If the dump is not a 4 KB Charger RFHUB (e.g. Gen1/Gen2 AA-50 format,
 * XC2268, or unrecognized size), the detector returns family:'unknown' with
 * a safe fallback message.
 *
 * Usage:
 *   import { detectRfhubKeyFamily } from '../lib/rfhubKeyTypeDetector.js';
 *   const result = detectRfhubKeyFamily(uint8ArrayBytes);
 *   // result.family: 'hitag2' | 'hitag-aes' | 'mixed' | 'no-keys' | 'unknown'
 *   // result.banner: { level, title, body, partNumber, chipType, progTool }
 * ============================================================================ */

import {
  isCharRfhubKeyTable,
  parseCharKeyTable,
  CHAR_KEY_FLAG_PRESENT,
  CHAR_KEY_FLAG_ALT,
} from './charRfhubKeyTable.js';

/* ── Key family descriptors ─────────────────────────────────────────────── */

export const KEY_FAMILY_INFO = Object.freeze({
  hitag2: Object.freeze({
    family: 'hitag2',
    chipType: 'PCF7945/53 (HITAG 2 / id46)',
    partNumber: 'Autel IKEY CHRYAK01 / VVDI Super Chip (id46 mode)',
    blankLabel: 'HITAG 2 blank (id46)',
    color: '#2563EB',
    bg: '#EFF6FF',
    border: '#93C5FD',
    emoji: '🔵',
    yearRange: '2011–2019',
    progTool: 'Autel IM608 → Chrysler → HITAG2 → id46 mode',
    notes:
      'Standard FCA/Mopar FOBIK blank. Programs with HITAG 2 / id46 workflow. ' +
      'Chip reads as PCF7945/53 on Autel Prog / VVDI Prog. ' +
      'SK = 6-byte secret derived from RFHUB SEC16.',
  }),
  'hitag-aes': Object.freeze({
    family: 'hitag-aes',
    chipType: 'PCF7939FA (HITAG AES)',
    partNumber: 'Autel IKEY CHRYAK01 AES variant / OEM 2021+ Redeye FOBIK',
    blankLabel: 'HITAG AES blank (PCF7939FA)',
    color: '#7C3AED',
    bg: '#F5F3FF',
    border: '#C4B5FD',
    emoji: '🟣',
    yearRange: '2020–2021+',
    progTool: 'Autel IM608 → Chrysler → HITAG AES → PCF7939FA mode',
    notes:
      'Alternate-family FCA/Mopar FOBIK blank. Requires HITAG AES workflow. ' +
      'Chip reads as PCF7939FA on Autel Prog / VVDI Prog. ' +
      'SK0–SK3 = four 4-byte AES key blocks written by the vehicle during pairing.',
  }),
  mixed: Object.freeze({
    family: 'mixed',
    chipType: 'Mixed (HITAG 2 + HITAG AES)',
    partNumber: 'Depends on which slot you are adding to — check individual key flags',
    blankLabel: 'Mixed families',
    color: '#D97706',
    bg: '#FFFBEB',
    border: '#FCD34D',
    emoji: '⚠️',
    yearRange: 'Unknown',
    progTool: 'Check each key slot individually',
    notes:
      'This RFHUB contains both HITAG 2 (flag 0x01) and HITAG AES (flag 0x03) key records. ' +
      'This is unusual. Verify the dump is from the correct module before programming.',
  }),
  'no-keys': Object.freeze({
    family: 'no-keys',
    chipType: 'No keys programmed',
    partNumber: 'N/A — module has no paired keys',
    blankLabel: 'No keys',
    color: '#6B7280',
    bg: '#F9FAFB',
    border: '#D1D5DB',
    emoji: '⬜',
    yearRange: 'Unknown',
    progTool: 'Program first key to determine family',
    notes:
      'All 8 key slots are empty (5A5A5A5A template). The module has never had a key paired. ' +
      'Use the vehicle year/platform to determine the correct blank type.',
  }),
  unknown: Object.freeze({
    family: 'unknown',
    chipType: 'Unknown (non-Charger RFHUB format)',
    partNumber: 'Cannot determine from this dump format',
    blankLabel: 'Unknown',
    color: '#6B7280',
    bg: '#F9FAFB',
    border: '#D1D5DB',
    emoji: '❓',
    yearRange: 'Unknown',
    progTool: 'Identify module type first',
    notes:
      'This dump is not a 4 KB Charger/Challenger RFHUB with the standard key table at 0x0C5E. ' +
      'It may be a Gen1/Gen2 AA-50 format, XC2268, or a different module entirely. ' +
      'Key family detection requires the 4 KB Charger key table layout.',
  }),
});

/* ── Main detector ──────────────────────────────────────────────────────── */

/**
 * detectRfhubKeyFamily(bytes) → DetectorResult
 *
 * Analyzes the RFHUB dump bytes and returns:
 *   {
 *     family: 'hitag2' | 'hitag-aes' | 'mixed' | 'no-keys' | 'unknown',
 *     info: KEY_FAMILY_INFO[family],
 *     keyCount: number,
 *     hitag2Count: number,
 *     hitagAesCount: number,
 *     slots: parsed slot array (or [] if not a Charger RFHUB),
 *     parseError: string | null,
 *   }
 */
export function detectRfhubKeyFamily(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return _result('unknown', 0, 0, 0, [], 'No buffer provided');
  }

  // Must be exactly 4 KB for the Charger key table layout
  if (bytes.length !== 4096) {
    const reason =
      bytes.length === 2048 ? 'Gen1 24C16 (2 KB) — key table at 0x0C5E not present in this format' :
      bytes.length === 8192 ? 'Gen2 8 KB — key table at 0x0C5E not present in this format' :
      `Unrecognized size (${bytes.length} B)`;
    return _result('unknown', 0, 0, 0, [], reason);
  }

  // Structural gate: must have the mirrored 8-slot table at 0x0C5E
  if (!isCharRfhubKeyTable(bytes)) {
    return _result('unknown', 0, 0, 0, [], 'Charger 8-slot key table not found at 0x0C5E (mirror/separator check failed)');
  }

  const parsed = parseCharKeyTable(bytes);
  if (!parsed.ok) {
    return _result('unknown', 0, 0, 0, [], parsed.error || 'parseCharKeyTable failed');
  }

  let hitag2Count = 0;
  let hitagAesCount = 0;
  for (const s of parsed.slots) {
    if (s.state !== 'key') continue;
    if (s.flag === CHAR_KEY_FLAG_PRESENT) hitag2Count++;
    else if (s.flag === CHAR_KEY_FLAG_ALT) hitagAesCount++;
  }

  const keyCount = parsed.keyCount;

  let family;
  if (keyCount === 0) {
    family = 'no-keys';
  } else if (hitag2Count > 0 && hitagAesCount > 0) {
    family = 'mixed';
  } else if (hitagAesCount > 0) {
    family = 'hitag-aes';
  } else {
    family = 'hitag2';
  }

  return _result(family, keyCount, hitag2Count, hitagAesCount, parsed.slots, null);
}

function _result(family, keyCount, hitag2Count, hitagAesCount, slots, parseError) {
  return {
    family,
    info: KEY_FAMILY_INFO[family] || KEY_FAMILY_INFO.unknown,
    keyCount,
    hitag2Count,
    hitagAesCount,
    slots,
    parseError,
  };
}

/* ── React-ready banner builder ─────────────────────────────────────────── */

/**
 * buildKeyTypeBanner(detectorResult) → banner object for UI rendering.
 *
 * Returns a structured object that any tab can render as a status banner:
 *   {
 *     show: boolean,
 *     level: 'info' | 'warning' | 'error' | 'success',
 *     family, info, keyCount, hitag2Count, hitagAesCount,
 *     parseError,
 *   }
 */
export function buildKeyTypeBanner(result) {
  if (!result) return { show: false };
  const { family, info, keyCount, hitag2Count, hitagAesCount, parseError } = result;

  // Always show a banner — even for unknown/unsupported formats
  if (family === 'unknown') {
    return {
      show: true,
      level: 'unknown',
      family,
      info,
      keyCount: 0,
      hitag2Count: 0,
      hitagAesCount: 0,
      parseError,
    };
  }

  const level =
    family === 'hitag-aes' ? 'warning' :
    family === 'mixed'     ? 'error'   :
    family === 'no-keys'   ? 'info'    :
    'success'; // hitag2

  return {
    show: true,
    level,
    family,
    info,
    keyCount,
    hitag2Count,
    hitagAesCount,
    parseError,
  };
}
