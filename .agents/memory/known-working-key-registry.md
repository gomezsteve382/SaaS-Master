---
name: Known-working-key registry
description: Curated "this key starts the car" registry surfaced in the Key Writer tab — data shape, classify/prefill contract, and the SK-vs-readable-ASCII gotcha.
---

# Known-working-key registry (Key Writer tab)

`keyWriter/knownWorkingKeys.js` is a frozen ground-truth table of CONFIRMED
working transponder keys (modelled on `rfhPinnedRegistry.js`), plus pure
helpers: `getKnownWorkingKeys(vin)`, `classifyAgainstRegistry(record, vin)`,
`knownKeyToRecord(entry)`, `isEmptySlotMarker(...)`. Surfaced on the Key Dump
card in `KeyWriterTab.jsx` (testids `known-key-status` with `data-status`,
`known-key-list`, `known-key-prefill-<id>`).

## Contract decisions (be consistent)
- **UID comparison/prefill uses the BE keyId** (e.g. `0077A29B`), NOT the
  LE stored revUID (`9BA27700`). The Key Dump card's UID field convention is
  BE keyId order (placeholder `00 77 A2 9B`, import test). The revUID is stored
  for provenance only.
- **SK is NEVER SEC16.** The `sk` field is the 6-byte per-transponder secret an
  external tool reports — for FCA id46 chips the universal MIKRON default
  (`4F4E4D494B52`). It is NOT the per-vehicle differentiator and NOT the 16-byte
  RFHUB SEC16 master. Prefill copies this value into the SK field; it must never
  copy SEC16 there.
- **classify is refuse-on-doubt:** blank / all-FF / all-00 / unparseable input,
  or the empty-slot sentinel → `unknown`. Match is by keyId; if keyId matches but
  chipId or SK differ → `mismatch` (with `mismatchedFields`); else `unknown`.
- **Empty-slot sentinel index `0x95` (revUID `5A5A5A5A`) is a non-key** and can
  never be presented as known-good — an earlier failed bench add used 0x95.
  Recorded as `EMPTY_SLOT_MARKER`, not in `KNOWN_WORKING_KEYS`.
- The RFHUB-table **index byte (0x48 for the seed) is stored as DATA only** —
  deriving it algorithmically is the package's open problem, out of scope.

## SK ASCII gotcha
`4F4E4D494B52` renders as ASCII `"ONMIKR"`, NOT `"MIKRON"`. The readable
"MIKRON" comes from a different byte order (`4D494B524F4E`, the chip profile's
`password_cs_last6`). Don't assert `ascii(sk) === "MIKRON"`; the bytes are the
same letter SET, just rotated.

## Seed ground truth (2019 Charger 6.2) — the single seeded confirmed key
keyId `0077A29B` → slot 3 @ `0xC7E`, index `0x48`, flag `0x01`, chip id46
(PCF7945A/53A HITAG2, Manchester, not locked/cloneable). Verified against the
real dump via `parseCharKeyTable` (base 0xC5E, stride 16, first real key slot 3).
Fixture: `src/__tests__/fixtures/SAMPLE_RFHUB_EEE_19CHARGER62_KEYINDEX_0077A29B.bin`.

## Sibling keys = the rest of the same dump (don't go hunting elsewhere)
The seed dump holds SIX paired keys (slots 3..8, all flag 0x01, mirror-verified):
0077A29B (seed), CC62209F, 09A6629F, 91654F9E, 197E6C9E, C47D6C9E. The five
non-seed ones are registered VIN-scoped to `2C3CDXL92KH674464` (the documented
reference car for the 0xC5E layout — NOT embedded in the fixture, sourced from
charRfhubKeyTable.js header). **Why VIN-scoped while the seed is global:** to
exercise/prove the per-VIN path in `getKnownWorkingKeys(vin)` against real bytes.
Provenance says "present in the immobilizer table; not independently fob-tested"
— honest distinction from the operator-fob-tested seed. Other RFHUB fixtures
(2C3CDXCT1HH652640) have flag `0x03` = `state:'unknown'` → refuse-on-doubt,
do NOT register those.
