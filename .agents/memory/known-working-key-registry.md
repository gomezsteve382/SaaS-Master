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

## Per-chip SK capture — seed key only carries its real secret
The seed key `0077A29B` is the ONE entry with a real Autel page read (`profile`),
so it now carries its OWN per-chip SK `502077550100`, re-derived from the read as
`profile.page1 ∥ profile.page2[:2 bytes]` (KEYLOW ∥ KEYHIGH high word). It is NO
LONGER the universal MIKRON `4F4E4D494B52` — presenting MIKRON (or any other
secret) against `0077A29B` now classifies as `sk` **mismatch**, which the old
all-identical-SK registry could never catch. **All OTHER entries (5 siblings + 2
other vehicles) still carry the MIKRON default** because no per-chip read exists
for them — keep that honest in provenance; do NOT fabricate per-chip secrets for
keys without a real `profile`. The seed's golden test re-derives SK from `profile`
so a re-extracted read can't silently drift. Prefill message in KeyWriterTab
branches on `/per-chip read confirmed/` in provenance.

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
(2C3CDXCT1HH652640) have flag `0x03`: these are now recognized as REAL keys of
an alternate transponder family (`state:'key'`, `keyKind:'alt'` — see
charger-rfhub-keytable.md) and so are ELIGIBLE for the registry, but are STILL
NOT known-good: `classifyAgainstRegistry` needs `chipId`+`SK`, and the alt
family's chip + per-chip SK are not bench-confirmed (claiming id46/MIKRON would
be a lie).

## PENDING alt-family staging (NOT known-good)
The three flag-0x03 keys on VIN `2C3CDXCT1HH652640` (2020 6.2 Redeye: BFA40065,
2369DA69, 1248C964 — slots 6-8 @0xCAE/0xCBE/0xCCE) are STAGED in a separate
frozen export `PENDING_ALT_FAMILY_KEYS` with `chipId:null, sk:null, pending:true,
needs:['chipId','sk']`, surfaced via `getPendingAltFamilyKeys(vin)`. They live
OUTSIDE `KNOWN_WORKING_KEYS` on purpose, so `getKnownWorkingKeys` /
`classifyAgainstRegistry` never see them and they can NEVER be called known-good
(null chipId → `knownKeyToRecord` returns null; UID isn't a registered key →
classify is 'unknown'). Their real bytes (UID/revUid/index/flag 0x03/offset) ARE
asserted against both fixtures (OG + PFLASH) in `knownWorkingKeys.golden.test.js`.
**To promote:** bench-read one alt fob → fill chipId+sk → move the entries into
`KNOWN_WORKING_KEYS` → drop the pending golden guards. Do NOT promote without a
real bench read; that's the whole point of the staging.

## Adding MORE vehicles — sourcing rule + VIN attribution
The registry now holds THREE cars. To add another, the candidate RFHUB dump
must parse with `parseCharKeyTable().ok && unknownCount===0` and every key
record flag `0x01` (mirror-verified). Then attribute the VIN by **SEC16
cross-check, not filename**: extract the dump's RFHUB SEC16 and confirm a BCM
dump that (a) carries the claimed VIN and (b) embeds that SEC16 (`forward
@0x40C9` and/or `reverse @0xC9`, per the RFH SEC16 = reverse(BCM) layout). That
pairing proves the fobs belong to that immobilizer. Registered vehicles 2 & 3:
- **Charger SCAT** VIN `2C3CDXHG5EH219538`, 5 keys (slots 4..8), SEC16
  `08A1C5E7BA303582C3821594793C2FC4`. Fixture `SAMPLE_RFHUB_EEE_SCATPACK_KEYS_2C3CDXHG5EH219538.bin`.
- **Charger 6.2 "CARTMAN"** VIN `2C3CDZL95NH179529`, 3 keys (slots 6..8), SEC16
  `DE4BBD2F5A1D73647EB2192D01E4F88C`. Fixture `SAMPLE_RFHUB_EEE_21CHARGER62_KEYS_2C3CDZL95NH179529.bin`.
All entries reuse the car-wide id46 / universal-MIKRON `sk` default (no per-chip
Autel read) — keep that honest in `provenance`. Golden tests live in
`knownWorkingKeys.golden.test.js` (a `describe.each(VEHICLES)` block asserts each
key's slot/offset/index/flag/revUid against the fixture bytes).
