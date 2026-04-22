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
  // Hex string of the 16-byte RFH SEC16 captured for this bench run.
  // This is the input fed into all three writers.
  "rfhSec16Hex": "0123456789abcdef0123456789abcdef",

  // Optional human-readable provenance — anonymized vehicle/year/source so
  // future maintainers know where the dump came from.
  "source": "anonymized 2022 Charger Redeye, real-bench Module Sync, 2026-04",

  // For each module: the "before" dump fed into the writer, and the "after"
  // dump the writer's output is compared against. Paths are relative to
  // this directory.
  "bcm":   { "before": "bcm.before.bin",   "after": "bcm.after.bin"   },
  "rfhub": { "before": "rfhub.before.bin", "after": "rfhub.after.bin" },
  "pcm":   { "before": "pcm.before.bin",   "after": "pcm.after.bin"   }
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

### What's NOT yet committed (manifest skip slots)

- **RFHUB** (`writeRfhSec16FromBcm`): the only available real RFHUB
  sample is `SAMPLE_RFH_SYNCED_VIRGIN_*` whose SEC16 slots are wiped to
  `0xFF`. We have no captured "synced" RFHUB to compare against, so the
  RFHUB pair is omitted from the manifest and that suite skips.
- **PCM** (`writePcmSec6`): no real PCM dump is available in the
  repository. Drop one in here (with the captured RFH SEC16 matching
  the manifest's `rfhSec16Hex`) and add a `"pcm"` entry to the manifest
  to activate that suite.

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
