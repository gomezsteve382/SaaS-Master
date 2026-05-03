/* Hand-curated companion to bcmFeatureCatalog.generated.js.
 *
 * Holds BCM Configuration DIDs that AlfaOBD exposes outside the
 * 0xDE00..0xDE0C "DE_FEATURE_CATALOG" range so they can be mounted
 * into the same editor without touching the auto-generated file.
 *
 * Source for 0x05AE: artifacts/srt-lab/public/unlock_catalog_extended.json
 * lists six presence flags under DID 0x05AE (BCM body parameters),
 * in this order:
 *
 *   1. Full Central Vision Processing Present
 *   2. Surround View Camera Present
 *   3. Air Suspension Control Module (ASCM) — Suspension
 *   4. Air Suspension Control Module (ASCM) — Active Damping
 *   5. RED KEY FEATURE PRESENT          ← the SRT performance-key flag
 *   6. Active Blind Spot Present
 *
 * AlfaOBD packs these as boolean bits in byte 0 of the read response.
 * The exact bit ordering inside that byte is not documented in the
 * extracted JSON (the AlfaOBD assembly's string table is Dotfuscator-
 * encrypted — see alfaobdMined/MINING_NOTES.md), so we map them to
 * MSB-first bits 0..5 of byte 0 — matching the order they appear in
 * the catalog. A tech bench-read against a known-good Demon BCM
 * should be used to lock the bit positions in if the live read shows
 * Red Key as a different flag than what this catalog says.
 *
 * Same row shape as DE_FEATURE_CATALOG so groupCatalogByDid() can
 * merge both lists transparently.
 */

export const BCM_CONFIG_EXTRA_CATALOG = [
  {
    request: '05AE',
    groupName: 'BCM Body Presence Flags (0x05AE)',
    name: 'Full Central Vision Processing Present',
    bit: 0, length: 1,
    options: [{ value: 0, label: 'Not present' }, { value: 1, label: 'Present' }],
  },
  {
    request: '05AE',
    groupName: 'BCM Body Presence Flags (0x05AE)',
    name: 'Surround View Camera Present',
    bit: 1, length: 1,
    options: [{ value: 0, label: 'Not present' }, { value: 1, label: 'Present' }],
  },
  {
    request: '05AE',
    groupName: 'BCM Body Presence Flags (0x05AE)',
    name: 'Air Suspension Control Module (ASCM) — Suspension',
    bit: 2, length: 1,
    options: [{ value: 0, label: 'Not present' }, { value: 1, label: 'Present' }],
  },
  {
    request: '05AE',
    groupName: 'BCM Body Presence Flags (0x05AE)',
    name: 'Air Suspension Control Module (ASCM) — Active Damping',
    bit: 3, length: 1,
    options: [{ value: 0, label: 'Not present' }, { value: 1, label: 'Present' }],
  },
  {
    request: '05AE',
    groupName: 'BCM Body Presence Flags (0x05AE)',
    name: 'Red Key Feature Present',
    bit: 4, length: 1,
    options: [{ value: 0, label: 'Disabled (Black Key only)' }, { value: 1, label: 'Enabled (Red Key recognised)' }],
  },
  {
    request: '05AE',
    groupName: 'BCM Body Presence Flags (0x05AE)',
    name: 'Active Blind Spot Present',
    bit: 5, length: 1,
    options: [{ value: 0, label: 'Not present' }, { value: 1, label: 'Present' }],
  },
];

/* Numeric DIDs added by this extra catalog. Kept separate from
 * BCM_CONFIG_DIDS so callers can choose to render them in a distinct
 * group ("hand-curated, bench-confirmable") if desired. */
export const BCM_CONFIG_EXTRA_DIDS = [0x05AE];
