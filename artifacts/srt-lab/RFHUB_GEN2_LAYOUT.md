# RFHUB EEPROM layout — evidence-grounded reference

Every row here is backed by a byte-level diff or a multi-sample read across the
real dump corpus. **Nothing in this file is inferred without a stated proof.**
Where a field's *role* is not provable from the files, it says so — those are
NOT to be encoded as security secrets.

## Corpus used
4 KB (24C32) RFHUB EEPROM dumps:
- `530589` (`19_rfhub_ogfile_scat`), `652640` (`20CHRGR6.2...EEE_OG` + CRC-written),
  `167935` (`19RFHUB_6.2_REDEYEOGEEE`), `592745` (`CHARGER_RFH_VIN...` / `AESKEYOG`),
  `615142` before/after a key-add (`redandblackkysprogrammed` / `_afterprogrammed`),
  plus `615142-prog` (an 87.7 %-identical **clone of the 652640 base**).

## PROVEN layout (4 KB "6.2" variant)

| Region | Fact | Proof |
|---|---|---|
| **VIN** `~0x0EB6–0x0EF2` | VIN/CRC write touches *only* this range (ASCII VIN mirrored ~`0x0ECF`/`0x0EE3` + CRC bytes) | `652640` OG vs CRC-written diff = 10 ranges, all here |
| **Key table** `0x0100–0x0253` | A key-add writes *only* here (+ counters below) | `615142` before/after diff = 18 ranges, all in `0x0100–0x0253` + `0x0C0E` |
| **Key count** `0x0150` (mirror `0x01D4`) | `0x02 → 0x03` when one key added; the two bytes are equal on every independent 6.2 hub | `615142` before/after; `530589`/`652640`/`167935` = `01`/`06`/`01`, both mirrors equal |
| **Counters** `0x0C0E–0x0C1B` | Bump on key-add | `615142` before/after |
| **`0x050E` / `0x0522`** | A **matched 16-byte mirror pair**, per-car, on 6.2 hubs (`0x050E`==`0x0522`) | direct read: 530589/652640/167935/615142 all match; 592745 does NOT |
| **`0x0226`** (16 B) | Per-car, high-entropy; **unchanged by VIN-write AND by key-add**; survives hub cloning | `652640` OG/CRC diff + `615142` before/after (untouched in both) |
| **`0x00AE`** | A **constant** (`D101 0102 F902 D000 FE00 D000 FE00`) across independent 6.2 hubs → structural, NOT per-car | identical on 530589/652640/167935 |

## NOT proven — do NOT encode as secrets
- **Role of `0x050E` and `0x0226`.** They are per-car and write-stable, but the
  files do **not** prove either is *the* immobilizer secret, nor any BCM↔RFHUB
  relationship. On a matched set (530589) the BCM "split" secret
  (`6B 56 F3 63…`) does **not** equal/reverse/copy either block.
- **Key derivation.** The before/after proves *where* keys are stored and that
  the count increments — **not** how key values are computed.
- **The `592745` variant.** Its `0x050E` is `FF03…` (slots differ) and its
  `0x00AE` (`D5 00 18 00 10 00 3E 31…`) echoes the reverse of its BCM
  (`31 3E 00 10 00 18…`) but is **not** a clean matched pair at either offset.
  Layout unrecognized → must be reported `unverified-layout`, never "mismatch."

## Parser change shipped (parseModule.js, RFHUB branch)
Purely additive — `sec16valid`/`sec16match` unchanged (all 24 RFH tests still pass):
- `info.sec16Status` ∈ {`verified-mirror` (matched pair + valid CS), `unverified-layout`
  (bytes present but not validatable from the file — **replaces the false
  "INVALID/MISMATCH"**), `blank`}.
- `info.rfhKeyCountByte` = `data[0x150]`, surfaced **only** when `0x150 == 0x1D4`
  (the variant invariant); left undefined otherwise (e.g. 592745) rather than guess.

## What would extend this (needs ground truth, not guessing)
- A **matched BCM + RFHUB pulled off one running 6.2 car** → to test any
  BCM↔`0x050E`/`0x0226` relationship.
- The `592745`/`AESKEY` variant's matching BCM → to confirm its `0x00AE` reverse16 link.
