---
name: ZF 8HP TCU dump ground truth
description: Real byte layout of the ZF 8HP TCU dumps (OBDSTAR EEPROM + TriCore flash); the old synthetic parser was fiction.
---

# ZF 8HP TCU — real dump ground truth

The earlier `zf8hp.js` assumed a synthetic contract that NO real dump matches: a
"ZF8HP" ASCII header at 0x0000, a variant tag byte at 0x0008, sizes of
256K/512K/1M, and per-64KB-block zlib CRC32 trailers. All of that was invented.
It has been retired/replaced with a grounded parser.

## The two real formats

1. **OBDSTAR-tool internal-EEPROM dump** — `0x20000` (128 KB).
   - Padded with repeating ASCII filler `OBDSTAR6` (the OBDSTAR programmer's
     signature) → these are tool-wrapped reads, not raw TCU EEPROM.
   - Vehicle-identity block is mirrored ~3x. On the bench set the mirrors sit at
     0xae6f / 0x12e6f / 0x1ae6f (stride 0x4000), but DO NOT hardcode offsets —
     scan for VIN occurrences instead; offsets vary by dump.
   - Each mirror layout: `[record marker 0x01] VIN_A(17 ASCII) VIN_B(17 ASCII)
     [01 FF FF FF ...]`. The two VINs are stored ADJACENT/concatenated with
     **NO per-VIN checksum** between or after them.
   - Also plain ASCII elsewhere: ZF unit number (`1034420271`=8HP95;
     `1034420267`=older, variant unconfirmed), Mopar assembly p/n
     (`05035827AC`), ZF calibration/sw id (`0260TP1122V02`), build date
     (`Oct  1 2019`).

2. **Infineon TriCore program flash** — `0x200000` (2 MB), `.HexTemp` extension.
   - Boot pattern `c3 05 c3 05 ...`. Only reliable plain ASCII is the
     software-protection version string e.g. `TPROT_TC_G2_V05.01.00` at 0x1F00.
   - No clean VIN, no write path.

## VIN extraction gotcha

A loose 17-char `[A-HJ-NPR-Z0-9]{17}` regex is not enough: calibration junk like
`1034420271011270H` and `1039S210650260TP0...` can pass the VIN check digit by
coincidence. Filter = **check digit AND an alphabetic char in position 2** (every
FCA/Stellantis VIN — 1C4…, 2C3…, ZAR… — has a letter there; numeric-prefix
calibration strings do not).

## Identity-string regex gotcha

The ZF unit number and Mopar p/n are stored immediately adjacent to the
calibration string (no separator), so `\b` word-boundary anchors NEVER match.
Use boundary-free patterns: ZF unit `/103[0-9]{7}/`, Mopar `/0[0-9]{7}[A-Z]{2}/`.

## Writer

`patchZf8hpVin(buf, targetVinOrOpts)` rewrites the 17 ASCII VIN bytes. Two modes:
- **surgical** (`{ sourceVin }` or bare string): replaces every mirror of ONE
  named source VIN, preserving any second distinct VIN. A bare string only works
  on single-VIN dumps; on a dual-VIN dump it refuses unless a source is named.
- **allVins** (`{ targetVin, allVins: true }`): overwrites EVERY VIN slot of
  every distinct VIN with the target. This is what the generic `fileUtils.patchFile`
  pipeline uses, matching the codebase-wide BCM/RFHUB convention ("write the new
  VIN at every detected slot") so a module adapted into a target vehicle reports
  that VIN everywhere.
**Why two modes:** real dumps carry two distinct VINs, so a blind single-target
write is ambiguous for surgical edits but the generic pipeline still needs a
usable "make this dump report VIN X" path. No checksum is recomputed because none
exists in this block. The immobilizer secret (ISN) and any global EEPROM
integrity field were not located, so the module never claims to read or write them.

**Schema plumbing gotcha:** `parseTricore8hpFlash` returns `versionOffset`;
`parseModule` MUST copy it into `info.zf8hp` or `eepromLayoutScan.regionsZf8hp`
emits zero regions for a flash dump (the software-version region keys off
`versionOffset`). Keep the parse output shape and the parseModule mapping in lockstep.

**How to apply:** when touching 8HP support, trust VIN-scan + check-digit, never
the retired header/variant-tag/block-CRC model. Real golden dumps live in
`attached_assets` (8HP_Read_INT_eeprom_*, *_ZF_8HP95_INT_EEPROM_*,
8HP_Read_INT_flash_*.HexTemp); tests skip-if-absent.
