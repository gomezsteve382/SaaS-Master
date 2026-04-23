# Gen1 RFHUB golden dumps

This directory holds 2 KB (24C16) RFHUB EEPROM images used by
`rfhubGen1RealDumps.golden.test.js` to verify Gen1 key-hub edits
(Task #416, follow-up to Task #409 which unlocked Gen1 slot editing).

## Provenance of the seed fixtures (`*.bin` already in this folder)

The six binaries currently checked in fall into two categories. **None
of them are physical EEPROM captures yet** — real sanitized donor dumps
are still pending (Task #420 remains the holding task for that).

### Seed conformance fixtures (Task #416)

`cherokee_xk_2010_2fobs.bin`, `wk_grand_2008_4fobs.bin`,
`lx_charger_2016_1fob.bin` are **structural conformance fixtures**
hand-built to the published Gen1 24C16 layout, not captures from a
physical EEPROM:

- VINs are FreshAuto-style donor placeholders (no real customer data).
- Scratch regions are filled with deterministic Mulberry32 noise (seeded
  per-vehicle) to mimic the non-FF garbage a real EEPROM carries — this
  is what lets the round-trip byte-identity assertion catch a writer
  that touches a stray offset.
- All structured regions (VIN @ 0x92 + CRC16 BE, SEC16 mirror pair
  @ 0x00AE/0x00C0 with `rfhSec16Cs`, AA-50 markers @ 0x00D2 stride 2,
  Autel ID block @ 0x00DA stride 8) are stamped from the same constants
  the production parser/writer uses.

These fixtures verify that the parser and writer agree with each other
and with the documented layout, but they cannot by themselves catch
per-vehicle layout drift (e.g. a Cherokee variant whose AA-50 base
differs from 0x00D2). Capturing that drift requires real donor dumps
— see Task #420.

### Donor-style synthetic fixtures (Task #420 expansion)

`cherokee_xk_2009_partial.bin`, `wk_grand_2011_3fobs.bin`,
`lx_charger_2014_fullhouse.bin` are also hand-built (still NOT physical
captures), but they exercise patterns the seed conformance set doesn't
cover and that only show up on real donors:

- **Sparse, non-contiguous AA-50 occupancy** —
  `cherokee_xk_2009_partial.bin` uses `[true, true, false, true]`
  (slot 2 deprogrammed by a previous locksmith). The seed set only
  covers contiguous leading-occupancy patterns.
- **Distinct SEC16 secrets per VIN** — every donor file ships with a
  different 16-byte master transponder secret (mirrored at
  0x00AE/0x00C0 with the standard `rfhSec16Cs` checksum). The seed set
  reused a single default secret.
- **Distinct per-fob Autel ID blocks** — each populated slot carries a
  unique 8-byte ID at `0x00DA + i*8`; no two slots in any donor share
  an ID. This is what `transferSlot`'s ID-copy path will see in the
  field.
- **Independent Mulberry32 noise seeds per donor** — scratch regions
  vary file-by-file, so no two fixtures can accidentally share the
  same byte pattern outside the structured regions.

The generator is checked in at
`artifacts/srt-lab/scripts/generate-rfhub-gen1-donor-fixtures.mjs`
and is fully deterministic — re-running it reproduces the exact same
binaries. These donor-style fixtures still cannot catch per-vehicle
layout drift on their own (drift detection requires a physical
capture), but they widen the variant matrix the harness iterates
over and confirm `AA50_BASE_GEN1 = 0x00D2`,
`SEC16_OFFSETS_GEN1 = [0x00AE, 0x00C0]`, and the
`(crc8_65 << 8) | 0x00` SEC16 CS formula hold across:
1, 2, 3, and 4 paired fobs; sparse and contiguous occupancy; and
multiple distinct master secrets.

## Adding real (sanitized) captures

When a real Cherokee XK / WK Grand / LX Charger 24C16 RFHUB dump becomes
available, drop the sanitized binary here and add an entry to the
`FIXTURES` array in `rfhubGen1RealDumps.golden.test.js`:

```js
{
  file: 'cherokee_xk_2011_real_donor1.bin',
  label: 'Cherokee XK 2011 (real donor)',
  expectedFobikSlots: 2,
  expectedOccupied: [true, true, false, false],
  source: 'real',  // optional metadata
},
```

The five existing assertions (Gen1 detection, AA-50 occupancy,
parseModule.fobikSlots, SEC16 csOk on both mirror slots, add→delete
round-trip byte identity, read-path non-mutation) all run unchanged
against the new file.

### Sanitization procedure for a real capture

1. Capture the full 2048-byte EEPROM image (e.g. via XPROG / Orange5).
2. Replace the VIN at 0x92 with a FreshAuto-style donor VIN of the same
   make/year (any 17-char alphanumeric string that passes the
   `/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/` check). Recompute the
   CRC16 BE at 0xA3 with `crc16(vinAscii)` from `lib/crc.js`.
3. If any partial-VIN strings or owner identifiers leak into scratch
   regions, scrub them too.
4. Leave the SEC16 mirror pair, AA-50 markers, and Autel ID block
   untouched — those are what the golden test is verifying.
5. Record the source capture ID (or `synthetic` for built fixtures) and
   the sanitization steps in a short comment in this README.

## Disagreements

If a real dump's parsed `fobikSlots` or `sec16.csOk` flags don't match
what the layout predicts, **widen the per-gen constants in
`lib/rfhubKeySlots.js`** (`AA50_BASE_GEN1`, `sec16OffsetsFor`) instead
of editing the dump. The dump is authoritative.
