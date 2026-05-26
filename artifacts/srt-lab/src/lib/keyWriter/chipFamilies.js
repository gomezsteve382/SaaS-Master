/* ============================================================================
 * chipFamilies.js — table of transponder chip families supported by the
 * commercial writers SRT Lab can hand RFHUB slot bytes to.
 *
 * This is a catalog. The actual burn protocol lives in protocol.js; this
 * module just lets the UI present a chip picker and lets the serializer
 * gate "is this slot's idBytes shape compatible with the selected chip?"
 *
 * Honesty note: the per-chip "uidBytes" / "writableBytes" values below
 * are the publicly-documented logical limits for each family (HITAG2
 * has a 4-byte UID and 4 × 4-byte pages, etc.). They are NOT a claim
 * that SRT Lab can flash all of those pages today — the writers we
 * delegate to handle the page-level details. The serializer only cares
 * about the UID/payload shape carried in the RFHUB slot.
 * ========================================================================== */

/** @typedef {{
 *   id: string,
 *   label: string,
 *   uidBytes: number,
 *   payloadBytes: number,
 *   writers: Array<'vvdi-mini'|'tango'>,
 *   notes: string,
 * }} ChipFamily */

/** @type {ChipFamily[]} */
export const CHIP_FAMILIES = [
  {
    id: 'pcf7953',
    label: 'PCF7953 (HITAG2 + AES, FCA/Mopar FOBIK)',
    uidBytes: 4,
    payloadBytes: 4,
    writers: ['vvdi-mini', 'tango'],
    notes:
      'Default for 2011+ FCA SRT/Demon/Hellcat/Redeye FOBIKs. RFHUB stores 8 bytes per slot (KEY_ID_BLOCK_LEN) — first 4 are the chip UID, remaining 4 are the per-fob payload the receiver hashes against the SEC16 master secret. Higher-page material (AES root key, lock bits) lives on the chip itself and is the writer firmware\'s concern, not ours.',
  },
  {
    id: 'pcf7945',
    label: 'PCF7945 (HITAG2 fixed-code, pre-2011 FCA)',
    uidBytes: 4,
    payloadBytes: 4,
    writers: ['vvdi-mini', 'tango'],
    notes:
      'Older Gen1 RFHUB (Cherokee / WK / LX) FOBIKs. RFHUB slot idBytes hold a 4-byte UID + 4 bytes padding.',
  },
  {
    id: 'megamos-aes',
    label: 'Megamos AES (ID88)',
    uidBytes: 7,
    payloadBytes: 16,
    writers: ['vvdi-mini'],
    notes:
      'Not used by stock FCA — listed for benches that share a writer with VW/Audi work. SRT Lab will refuse to burn this from a FCA RFHUB slot.',
  },
];

const BY_ID = new Map(CHIP_FAMILIES.map((c) => [c.id, c]));

export function chipFamily(id) {
  return BY_ID.get(id) || null;
}

/** Which chip family ID the FCA RFHUB layout corresponds to per generation. */
export function chipForRfhubGen(gen) {
  if (gen === 'gen2') return 'pcf7953';
  if (gen === 'gen1') return 'pcf7945';
  return null;
}
