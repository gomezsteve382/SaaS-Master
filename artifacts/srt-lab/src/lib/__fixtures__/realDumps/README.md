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
  //
  // Each entry SHOULD also declare its anonymization metadata so the
  // anonymization sanity test (`realDumps.anonymization.test.js`) can
  // enforce a per-fixture expected VIN and donor:
  //   - `anonVin`  : the 17-char anonymized VIN this binary should
  //                  contain at every documented VIN slot. Required
  //                  for the per-fixture VIN equality check.
  //   - `donorVin` : the 17-char original donor VIN that must NOT
  //                  appear anywhere in this (or any other) binary.
  //                  Optional — omit only when the original donor is
  //                  genuinely unknown (e.g. fixture landed already
  //                  anonymized upstream). The test always enforces
  //                  the hardcoded baseline forbidden-donor list, so
  //                  declaring `donorVin` here also extends that list
  //                  for every other binary in the manifest.
  "bcm":   { "before": "bcm.before.bin",   "after": "bcm.after.bin",
             "anonVin": "2C3CDXL90MH582899" /* donorVin omitted: original unknown */ },
  "rfhub": { "before": "rfhub.before.bin", "after": "rfhub.after.bin",
             "rfhSec16Hex": "...", "anonVin": "...", "donorVin": "..." },
  "pcm":   { "before": "pcm.before.bin",   "after": "pcm.after.bin",
             "rfhSec16Hex": "...", "anonVin": "...", "donorVin": "..." },

  // Optional list of additional BCM before/after pairs (different VINs
  // than the primary). Each entry has the same shape as the top-level
  // `bcm` slot. The securityBytes round-trip suite asserts each pair
  // round-trips byte-for-byte through writeBcmSec16Gen2.
  "extraBcms": [
    { "before": "bcm2.before.bin", "after": "bcm2.after.bin", "rfhSec16Hex": "...", "source": "..." }
  ],

  // Optional list of additional PCM before/after pairs (e.g. an 8 KB
  // GPEC2A capture alongside the primary 4 KB slot). Each entry has the
  // same shape as the top-level `pcm` slot. The pcmSec6 round-trip
  // suite iterates over every entry and asserts each pair round-trips
  // byte-for-byte through writePcmSec6.
  "extraPcms": [
    { "before": "pcm8kb.before.bin", "after": "pcm8kb.after.bin", "rfhSec16Hex": "...", "source": "..." }
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
ECU's actual behavior on this dump.

Then (Task #448) the buffer is round-tripped through
`scripts/anonymize-real-dump.mjs` (donor=anonVin → stand-in → donor)
to normalize the partial-VIN records at `0x4098` / `0x40B0`. The
upstream sample left the donor's tail (`FH796320`) untouched at those
offsets even though its full-VIN slots had been scrubbed; the helper
re-stamps the partial-VIN tail to match the documented `anonVin`
(`MH582899`) and refreshes the trailing CRC16. Every other byte
remains identical to the captured original.

**Do not hand-edit this file.** A round-trip through
`anonymize-real-dump.mjs` is asserted byte-for-byte by
`anonymizeRealDump.test.js` — any drift between this file and the
helper's output will fail CI. To re-anonymize, re-run the helper on
the original captured `.bin` rather than tweaking the bytes by hand.

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
  the second-VIN gap for #420). Both files were also round-tripped
  through `anonymize-real-dump.mjs` (Task #448) to refresh the
  trailing CRC16 at four full-VIN slots (0x5328/0x5348/0x5368/0x5388
  +17/+18) — the original hand-anonymization had left those CRC bytes
  stale; the helper re-stamps them so the byte-equality round-trip
  test passes.

- **`pcm8kb.before.bin` / `pcm8kb.after.bin`** — Continental GPEC2A
  (95640, **8 KB**) from
  `attached_assets/PCM_FCA_CONTINENTAL_GPEC2A_8KB_KEYPROG_2C3CDXCT1HH652640.bin`.
  Same anonymized vehicle and same paired SEC6 secret (`81 65 31 f7 cd e3`)
  as the 4 KB primary `pcm` pair above. `before` has the marker @
  0x3C4..0x3C7 and SEC6 @ 0x3C8..0x3CD erased to 0xFF; `after` is the
  captured synced image. **VIN slots** on the 8 KB image: 0x0000,
  0x01F0, 0x0224, 0x0CE0 — identical layout to the 4 KB sibling
  (both PCMs were dumped from the same vehicle and carry VINs at all
  four offsets). Half-2 (0x1000..0x1FFF) is verbatim 0xFF padding. Wired through
  `extraPcms[0]` and asserted by the same
  `pcmSec6.realDump.golden.test.js` suite (Task #433). Pins the
  `writePcmSec6` doc-comment assertion that "the 8 KB image is just a
  larger GPEC2A" — same marker offset, same SEC6 offset, no GPEC5
  variant.

## Anonymization checklist

> **One-shot helper:** instead of walking every offset by hand, run
> `node scripts/anonymize-real-dump.mjs <input.bin> --module <bcm|rfhub|pcm> --donor-vin <donor> --anon-vin <stand-in> [--out <path>]`
> from `artifacts/srt-lab/`. It rewrites every documented full-VIN
> slot, the BCM partial-VIN records (the ones Task #436 missed), and
> the RFHUB Gen2 reverse-VIN slots; re-stamps every parser CRC; and
> aborts if the donor's full VIN or last-6 serial survives anywhere
> outside the documented slot windows. The output drops in here and
> passes `realDumps.anonymization.test.js` without further hand-editing.
> Use this for any new capture; the manual checklist below stays as
> the spec the script implements.

> **Local pre-commit check (Task #451):** before pushing a new or
> edited fixture, run the fast realDumps-only suite and let it catch a
> bad edit the same minute it happens — instead of waiting 10 minutes
> for CI to surface the failure. From the repo root:
>
> ```sh
> pnpm --filter @workspace/srt-lab fixtures:check
> ```
>
> That runs only the four suites that guard this directory:
> `anonymizeRealDump.test.js`, `realDumps.anonymization.test.js`,
> `realDumps.helperLeakScan.test.js`, and
> `securityBytes.realDump.golden.test.js` (the ones #448 wired up to
> assert byte-for-byte round-trip through `anonymize-real-dump.mjs`).
>
> To make this run automatically on `git commit` whenever a file under
> `src/lib/__fixtures__/realDumps/` is staged, install the bundled
> hook helper as your pre-commit hook (it no-ops on commits that don't
> touch this directory, so day-to-day commits aren't slowed down):
>
> ```sh
> ln -sf ../../artifacts/srt-lab/scripts/fixtures-precommit.sh \
>   .git/hooks/pre-commit
> chmod +x .git/hooks/pre-commit
> ```
>
> If you already have a project-level pre-commit hook (husky,
> lefthook, a hand-rolled `.git/hooks/pre-commit`, etc.), invoke the
> helper from inside it instead:
>
> ```sh
> sh artifacts/srt-lab/scripts/fixtures-precommit.sh || exit 1
> # equivalent: pnpm --filter @workspace/srt-lab fixtures:precommit
> ```
>
> The helper inspects `git diff --cached`, exits 0 when no realDumps
> file is staged, and otherwise runs `pnpm fixtures:check` so the
> commit fails on a stale fixture before it ever leaves your machine.

Before committing any binary in this directory, scrub:

- VIN bytes — replace the captured 17-character VIN everywhere it appears.
  Module-by-module slot map (these are the **VIN payload** offsets the
  anonymization sanity test in `realDumps.anonymization.test.js` actually
  reads — not the EEPROM record-header offsets one tier higher):
    - **BCM** (Redeye 2020+ layout): VIN payload lives at +8 from each
      EEPROM record header in the 0x5300..0x5380 base table (32 B
      stride). Concretely:
        - Primary BCM (anon `2C3CDXL90MH582899`): VINs at
          **0x5308 / 0x5328 / 0x5348 / 0x5368** (record headers at
          0x5300/0x5320/0x5340/0x5360).
        - Secondary BCM (anon `2C3CDXCT1HH600000`, `extraBcms[0]`):
          VINs at **0x5328 / 0x5348 / 0x5368 / 0x5388** (record headers
          at 0x5320/0x5340/0x5360/0x5380).
      Plus any partial-VIN slots elsewhere in the image. Older legacy
      layouts can park the VIN at base+0 instead of base+8 — the
      scanner tries both deltas per base.
    - **RFHUB** (Gen2 4 KB): VIN slots at 0x0EA5 / 0x0EB9 / 0x0ECD /
      0x0EE1, stored **byte-reversed**.
    - **PCM** (GPEC2A): VIN slots at 0x0000 / 0x01F0 / 0x0224 / 0x0CE0
      — same four offsets on both 4 KB and 8 KB captures.
  The replacement VIN must be valid-shaped (17 chars, no I/O/Q) and the
  writer/parser CRCs must be re-stamped after the swap.
- FOBIK / immobilizer key data outside the SEC16 region under test — these
  vary per vehicle and aren't required for this regression.
- Part-number ASCII fields if they reveal the donor.

Both the full 17-character VIN AND its trailing 6-character serial (the
unique "vehicle serial" portion — e.g. `652640` in
`2C3CDXCT1HH652640`) are enforced by `realDumps.anonymization.test.js`:
the full VIN must not appear anywhere forward or byte-reversed, and the
trailing 6-character serial must not appear anywhere outside the
documented full-VIN slot windows. The latter check catches the
"scrubbed the WMI/VDS but forgot the tail" mistake — see check #6 in
that test's file header for details.

The 16-byte RFH SEC16 region IS the value under test and stays as captured.

## Why "skip" instead of "fail" when dumps are missing

Real ECU dumps are heavyweight, sensitive artifacts. Capturing them requires
bench access, and anonymizing them takes care. We do not want a missing
fixture to red-CI every PR; we want the test to silently no-op until the
dumps land, then start guarding the writers automatically.
