# Real ECU dump fixtures (security-byte writers)

This directory holds anonymized **real-bench** ECU dump triples used by
`src/lib/__tests__/securityBytes.realDump.golden.test.js`.

The companion test file `securityBytes.golden.test.js` (one tier up) pins the
three security-byte writers — `writeBcmSec16Gen2`, `writePcmSec6`,
`writeRfhSec16FromBcm` — against **synthetic, hand-built** input buffers. That
proves the writers are internally consistent and unchanged from the day they
were captured, but it does NOT prove the writers produce bytes that an actual
SINCRO/ArmandoQS-flashed ECU would also produce.

The dumps in this directory close that gap: they are captured from a known-good
real-bench Module Sync run and let the writers be regression-tested against
real-world output, byte-for-byte.

## Expected files

The test loader reads `manifest.json` from this directory. If the manifest is
absent (or any referenced file is missing), the test is **skipped** rather
than failing — that way the build never breaks just because the dumps haven't
been committed yet.

When you have a captured triple, drop the binaries in here and create a
manifest like the example below.

```
realDumps/
  manifest.json
  bcm.before.bin
  bcm.after.bin
  rfhub.before.bin
  rfhub.after.bin
  pcm.before.bin
  pcm.after.bin
```

### `manifest.json` shape

```jsonc
{
  // Default 16-byte RFH SEC16 (hex). Used by any pair entry that does not
  // carry its own `rfhSec16Hex` override. Required at the top level so
  // the loader can validate the manifest even when only the primary BCM
  // is wired.
  "rfhSec16Hex": "0123456789abcdef0123456789abcdef",

  // Optional human-readable provenance — anonymized vehicle/year/source so
  // future maintainers know where the dump came from.
  "source": "anonymized 2022 Charger Redeye, real-bench Module Sync, 2026-04",

  // For each module: the "before" dump fed into the writer, and the "after"
  // dump the writer's output is compared against. Paths are relative to
  // this directory. Each entry MAY override `rfhSec16Hex` when the pair
  // was captured from a different vehicle than the top-level default
  // (e.g. the rfhub/pcm/extraBcms triple lives on a different VIN than
  // the primary BCM pair).
  "bcm":   { "before": "bcm.before.bin",   "after": "bcm.after.bin"   },
  "rfhub": { "before": "rfhub.before.bin", "after": "rfhub.after.bin", "rfhSec16Hex": "..." },
  "pcm":   { "before": "pcm.before.bin",   "after": "pcm.after.bin",   "rfhSec16Hex": "..." },

  // Optional list of additional BCM before/after pairs (different VINs
  // than the primary). Each entry has the same shape as the top-level
  // `bcm` slot. The securityBytes round-trip suite asserts each pair
  // round-trips byte-for-byte through writeBcmSec16Gen2.
  "extraBcms": [
    { "before": "bcm2.before.bin", "after": "bcm2.after.bin", "rfhSec16Hex": "...", "source": "..." }
  ]
}
```

Each module entry is independently optional — if (for example) only a BCM
triple has been captured, omit the `rfhub` and `pcm` keys and only the BCM
assertion will run; the others will be reported as skipped.

## What's currently committed

A real-anchored BCM before/after pair derived from the existing real-bench
sample dump `src/__tests__/fixtures/SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin`
(VIN `2C3CDXL90MH582899`, already anonymized in that file).

### How `bcm.after.bin` is constructed

Starts as a verbatim copy of the captured SAMPLE_BCM dump. The captured
dump's inactive-bank EEPROM record table contains hundreds of allocated
record slots (slotType / size pairs at `00 00 00 sz 00 46 slot 00`). Two
of those slots — `slot=0xEB size=0x18` at `0x40C0` and (if present)
`slot=0xCA size=0x28` — match `writeBcmSec16Gen2`'s mirror-record search
criteria, but in the captured dump their payload bodies are **all-zero**:
the real ECU sync that produced this dump only populated the SEC16
**split records** at `0x81A0` / `0x81C0` / `0x81E0`, not the mirror
records. To make this dump a faithful before/after pair for the writer,
we neutralize those two writer-target mirror header marker bytes (set
`+5` from `0x46` to `0x00`) so `findRec` skips them — matching the real
ECU's actual behavior on this dump. Every other byte in `bcm.after.bin`
is identical to the captured original.

### How `bcm.before.bin` is constructed

`bcm.after.bin` with the SEC16 split-record body bytes erased to `0xFF`
at offsets `+9..+15` (prefix7) and `+20..+28` (suffix9) of each of the
three split records `0x81A0` / `0x81C0` / `0x81E0`. The split-record
header (`+0..+8`) and separator (`+16..+19`) bytes are left intact so
the writer's split-record matcher still fires.

### What the test asserts

`writeBcmSec16Gen2(bcm.before.bin, rfhSec16=86fa723776605a7da0c3abbb7cffbded)
.bytes` must equal `bcm.after.bin` byte-for-byte. The RFH SEC16 fed in
is the **real captured value** — extracted from the captured split-record
bytes (`BCM SEC16 = edbdff7cbbabc3a07d5a60763772fa86`, reversed to get
RFH form). If the writer ever drifts away from the algorithm an actual
SINCRO/ArmandoQS sync used on this real bench, the comparison fails
with a focused first-mismatch diff.

### Real-bench triple for VIN `2C3CDXCT1HH600000` (anonymized)

Wired in Task #423 — a real-bench triple captured from a single 2020
6.2 Charger Redeye sync run. The VIN was scrubbed everywhere it appears
in plaintext (forward in BCM/PCM, byte-reversed in the RFHUB Gen2 slots
@ 0xEA5/0xEB9/0xECD/0xEE1). Source filenames are recorded in
`manifest.json#source` strings so provenance can be retraced.

The captured RFH SEC16 (shared by all three modules of this triple) is
`81 65 31 f7 cd e3 2e 33 c2 5a 41 5c 84 40 c7 2a`, recorded as the
per-pair `rfhSec16Hex` override on the `rfhub`/`pcm`/`extraBcms[0]`
entries. The pre-existing primary BCM pair keeps using the top-level
`rfhSec16Hex` (`86fa72…ded`) since it was captured from a different
vehicle (anonymized VIN `2C3CDXL90MH582899`).

- **`rfhub.before.bin` / `rfhub.after.bin`** — Gen2 RFHUB (24C32, 4 KB)
  from `attached_assets/RFH_20CHRGR6.2_KEYPROG_2C3CDXCT1HH652640.bin`.
  `before` has the two Gen2 SEC16 slots @ 0x050E and 0x0522 (16 B SEC16
  + 2 B CS each) erased to 0xFF; `after` is the captured synced image.
  Test: `lib/__tests__/rfhubGen2.realDump.golden.test.js`
  (closes follow-ups for #408 / #412).

- **`pcm.before.bin` / `pcm.after.bin`** — Continental GPEC2A (95320,
  4 KB) from
  `attached_assets/PCM_FCA_CONTINENTAL_GPEC2A_4KB_KEYPROG_2C3CDXCT1HH652640.bin`.
  `before` has the marker @ 0x3C4..0x3C7 and SEC6 @ 0x3C8..0x3CD erased
  to 0xFF; `after` is the captured synced image with the canonical
  `FF FF FF AA` marker + `81 65 31 f7 cd e3` SEC6.
  Test: `lib/__tests__/pcmSec6.realDump.golden.test.js`
  (closes follow-up for #406, complements `pcmSec6.fullFileRoundTrip`
  which uses synthetic fixtures).

- **`bcm2.before.bin` / `bcm2.after.bin`** — BCM (MPC5606B DFLASH, 64 KB)
  from `attached_assets/BCM_22CHARGER_REDEYE_6.2_KEYPROG_2C3CDXCT1HH652640.bin`,
  same vehicle as the rfhub/pcm pair above. `before` has the writer-
  target bytes erased to 0xFF: split records @ 0x81A0/C0/E0
  (+9..+15 prefix7, +20..+28 suffix9) and the inactive-bank mirror
  records @ 0x40C0 (slot 0xEB / size 0x18) and 0x40E8 (slot 0xCA /
  size 0x28) at +8..+31. Headers + separators left intact so the
  writer's matchers fire. Wired through `extraBcms[0]` and asserted by
  the existing `securityBytes.realDump.golden.test.js` suite (closes
  the second-VIN gap for #420).

## Anonymization checklist

Before committing any binary in this directory, scrub:

- VIN bytes — replace the captured 17-character VIN everywhere it appears
  (BCM: 0x5320/0x5340/0x5360/0x5380 and partial-VIN slots; RFHUB Gen2 VIN
  slots at 0x0EA5/0x0EB9/0x0ECD/0x0EE1 stored byte-reversed; PCM VIN at
  0x0000/0x01F0/0x0224). The replacement VIN must be valid-shaped (17 chars,
  no I/O/Q) and the writer/parser CRCs must be re-stamped after the swap.
- FOBIK / immobilizer key data outside the SEC16 region under test — these
  vary per vehicle and aren't required for this regression.
- Part-number ASCII fields if they reveal the donor.

The 16-byte RFH SEC16 region IS the value under test and stays as captured.

## Why "skip" instead of "fail" when dumps are missing

Real ECU dumps are heavyweight, sensitive artifacts. Capturing them requires
bench access, and anonymizing them takes care. We do not want a missing
fixture to red-CI every PR; we want the test to silently no-op until the
dumps land, then start guarding the writers automatically.
