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

/** `skBytes` is the documented per-transponder secret-key (SK) length the
 *  external bench tool (Autel/VVDI) reports for this family — a HITAG2 48-bit
 *  crypto key is 6 bytes, an AES key is 16 bytes. It is used ONLY by the
 *  standalone key-dump capture/export path (keyRecord.js + autelExport.js) to
 *  refuse a wrong-length SK. It is NOT the 16-byte RFHUB SEC16 master secret
 *  and plays no part in the RFHUB-slot burn serializer. */

/** @typedef {{
 *   id: string,
 *   label: string,
 *   uidBytes: number,
 *   payloadBytes: number,
 *   skBytes: number,
 *   writers: Array<'vvdi-mini'|'tango'>,
 *   notes: string,
 * }} ChipFamily */

/* `skBytes` is the length of the transponder *secret key* (SK) — the value an
 * external programmer (Autel / VVDI) reports after its own "Calculate SK" step.
 * This is a DIFFERENT thing from the RFHUB's 16-byte SEC16 master secret and
 * from the per-slot `payloadBytes`; never conflate them. HITAG2 (PCF7945/7953)
 * uses a 48-bit (6-byte) crypto key; Megamos AES carries a 16-byte AES key. */

/** @type {ChipFamily[]} */
export const CHIP_FAMILIES = [
  {
    id: 'pcf7953',
    label: 'PCF7953 (HITAG2 + AES, FCA/Mopar FOBIK)',
    uidBytes: 4,
    payloadBytes: 4,
    skBytes: 6,
    writers: ['vvdi-mini', 'tango'],
    notes:
      'Default for 2011+ FCA SRT/Demon/Hellcat/Redeye FOBIKs. RFHUB stores 8 bytes per slot (KEY_ID_BLOCK_LEN) — first 4 are the chip UID, remaining 4 are the per-fob payload the receiver hashes against the SEC16 master secret. Higher-page material (AES root key, lock bits) lives on the chip itself and is the writer firmware\'s concern, not ours. SK = 6 B HITAG2 crypto key when an external tool reports the chip secret directly.',
  },
  {
    id: 'id46',
    label: 'ID46 / HITAG2 (PCF7945A/53A, external read)',
    uidBytes: 4,
    payloadBytes: 4,
    skBytes: 6,
    writers: ['vvdi-mini', 'tango'],
    notes:
      'HITAG2 crypto-mode read as reported by an Autel/VVDI bench tool: 4-byte UID + a 6-byte (48-bit) SK. Same physical PCF794x silicon as the FCA FOBIK families, but captured standalone from an external transponder read rather than an RFHUB dump. Use this family for the standalone key-dump capture path.',
  },
  {
    id: 'pcf7945',
    label: 'PCF7945 (HITAG2 fixed-code, pre-2011 FCA)',
    uidBytes: 4,
    payloadBytes: 4,
    skBytes: 6,
    writers: ['vvdi-mini', 'tango'],
    notes:
      'Older Gen1 RFHUB (Cherokee / WK / LX) FOBIKs. RFHUB slot idBytes hold a 4-byte UID + 4 bytes padding. SK = 6 B HITAG2 crypto key when read standalone.',
  },
  {
    id: 'megamos-aes',
    label: 'Megamos AES (ID88)',
    uidBytes: 7,
    payloadBytes: 16,
    skBytes: 16,
    writers: ['tango'],
    notes:
      'Not used by stock FCA — listed for benches that share a writer with VW/Audi work. Megamos AES is a Tango-only family here: VVDI Mini lacks the Megamos AES routine in its firmware, so we refuse that combination at the serializer. SRT Lab will also refuse to burn this from a FCA RFHUB slot. SK = 16 B AES key.',
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
