# Rescued Dumps Index (Task #497)

Four files in `attached_assets/` were uploaded with a `.zip` extension but
were actually raw module dumps — they wouldn't open as archives, never got
picked up by the dump tools, and weren't traceable from their generic
`Asset-Manager-Tool` / `files_(1)` filenames.

This task verified each by content (BCM signature `FEE1000` at byte 4;
GPEC2A 17-char VIN at byte 0), renamed them to follow the `SAMPLE_<MODULE>_…`
convention used by the rest of this directory, and added entries in
`src/lib/sampleFixtures.js` so the in-tab "Load sample" picker can serve
them.

The two BCM files in the original upload pair are **byte-identical**
(sha256 `0d3593f2…`); the same is true for the two PCM files
(sha256 `566b18fa…`). Per Task #497 they are kept as separate files (not
deduplicated) in case they capture different bench states; the
`_dup_<original-timestamp>` suffix on the second copy of each pair makes
the original upload traceable.

All four dumps belong to a single 2020 Charger SXT vehicle
(VIN `2C3CDXL97LH237142`, pair tag `sxt-charger-237142`), so they form a
real BCM ↔ PCM matched set for cross-module pairing / VIN-write /
checksum verification work (Tasks #47, #48, #103).

## Index

| Original filename | New filename | Module | Bytes | VIN | Header marker | Notes |
|---|---|---|---|---|---|---|
| `attached_assets/Asset-Manager-Tool_1776900673446.zip` | `SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2.bin` | BCM | 65536 | `2C3CDXL97LH237142` | `FEE1000` @ 0x04 | Rescued from misnamed `.zip`. 4 full VINs @ 0x5328/0x5348/0x5368/0x5388, partial-VIN tail still legacy `NH176487` @ 0x4098/0x40B0 (CRCs valid), security lock = 0x5A (LOCKED), 16-byte vehicle secret @ 0x40C9, 8 immo records present. |
| `attached_assets/Asset-Manager-Tool_1776900716171.zip` | `SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2_dup_1776900716171.bin` | BCM | 65536 | `2C3CDXL97LH237142` | `FEE1000` @ 0x04 | Rescued from misnamed `.zip`. Byte-identical (sha256) to the BCM above; kept under a `_dup_<ts>` suffix so the original pair stays traceable. |
| `attached_assets/files_(1)_1776900673449.zip` | `SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa.bin` | PCM (Continental GPEC2A 8 KB) | 8192 | `2C3CDXL97LH237142` | VIN @ 0x00 | Rescued from misnamed `.zip`. 8 KB GPEC2A 95640-style EXT EEPROM. Detected as `GPEC2A` via the filename hint in `detectModuleType` (raw size-only detection returns `95640`, so the in-tab loader must keep its filename hint). |
| `attached_assets/files_(1)_1776900716173.zip` | `SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa_dup_1776900716173.bin` | PCM (Continental GPEC2A 8 KB) | 8192 | `2C3CDXL97LH237142` | VIN @ 0x00 | Rescued from misnamed `.zip`. Byte-identical (sha256) to the PCM above; kept under a `_dup_<ts>` suffix so the original pair stays traceable. |
| `attached_assets/charger_1776900673447.png` | `SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1.bin` | BCM | 65536 | `2C3CDXL97LH237142` | `FEE1000` @ 0x04 | **Task #514** rescue. 64 KB binary uploaded with a `.png` extension. Same SXT Charger VIN, same partial-VIN tail `NH176487` @ 0x4098/0x40B0, same security lock 0x5A as the `_0d3593f2` BCM, but a different bench capture (84-byte delta — kept as a separate sample, not a duplicate of `_0d3593f2`). |
| `attached_assets/charger_1776900716172.png` | `SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1_dup_1776900716172.bin` | BCM | 65536 | `2C3CDXL97LH237142` | `FEE1000` @ 0x04 | **Task #514** rescue. Byte-identical (sha256 `ba26d1c1…`) to the BCM above; kept under a `_dup_<ts>` suffix so the original upload pair stays traceable. |
| `attached_assets/fca_module_analyzer_1776900458950.jsx` | `SAMPLE_GPEC2A_EXT_EEPROM_4KB_RESCUED_VIN_CRC_1C4RJFN9XJC309165_628f7b3c.bin` | PCM (Continental GPEC2A 4 KB) | 4096 | `1C4RJFN9XJC309165` | VIN @ 0x00 | **Task #514** rescue. 4 KB binary uploaded with a `.jsx` extension. 2018 Jeep Grand Cherokee SRT 6.4L. Continental EEPROM part number `A2C7628120000` visible in the dump confirms 4 KB GPEC2A EXT EEPROM (vs the 4 KB RFHUB EEE alternative the scanner couldn't disambiguate from size alone). |

The Task #514 list above does not include the four other files the scanner
flagged in the same scan — they were rescued by deletion (see
`attached_assets/RESCUED_DUMPS_NOTE.md`):
- `MITCH_PFLASH_1776900673451.bin` / `MITCH_PFLASH_1776900716175.bin` — 18,683-byte
  Python source (a copy of the J2534 bridge daemon `zip_j2534_bridge.py` already
  present in `attached_assets/`), uploaded with the wrong filename and the wrong
  extension. Not vehicle data.
- `j2534_bridge_1776900673450.py` / `j2534_bridge_1776900716174.py` — 242,502-byte
  ZIP archives of stale source bundles (`RFHUBVirginizer.tsx`, `BCMConfiguration.tsx`,
  …) for components that no longer exist anywhere in the SRT Lab artifact. Not
  vehicle data.

## Smoke check (Task #497 step 5)

Loaded each renamed dump through `parseModule` (the same path the SRT Lab's
in-tab samples loader uses). Output matches the surgical inspection report
exactly:

```
SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2.bin
  type=BCM size=65536  header @4..11 = "FEE1000"
  VINs : 2C3CDXL97LH237142 @ 0x5328 / 0x5348 / 0x5368 / 0x5388
  partials: NH176487 @ 0x4098 (CRC OK), 0x40B0 (CRC OK)
  vehicleSecret @ 0x40C9 = DA 69 69 89 16 EC 45 AB C1 43 D9 7E D7 15 80 AB
  securityLock @ 0x8028 = 0x5A (LOCKED)
  immoRecs=8 bakRecs=0

SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2_dup_1776900716171.bin
  (identical to the entry above — byte-for-byte)

SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa.bin
  type (filename-hinted) = GPEC2A
  type (raw size-detect) = 95640      ← parser default for 8 KB
  size = 8192
  VIN @ offset 0x0000    = 2C3CDXL97LH237142

SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa_dup_1776900716173.bin
  (identical to the entry above — byte-for-byte)

SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1.bin   (Task #514)
  type=BCM size=65536  header @4..11 = "FEE1000"
  VINs : 2C3CDXL97LH237142 @ 0x5328 / 0x5348 / 0x5368 / 0x5388  (all 4 CRCs OK)
  partials: NH176487 @ 0x4098 (CRC OK), 0x40B0 (CRC OK)
  securityLock @ 0x8028 = 0x5A (LOCKED)
  immoRecs=8 bakRecs=0
  → matches the _0d3593f2 BCM on every parser-visible field; the only
    difference is 84 bytes elsewhere in the image (different bench capture
    of the same vehicle, kept as a separate sample on purpose).

SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1_dup_1776900716172.bin   (Task #514)
  (identical to the entry above — byte-for-byte)

SAMPLE_GPEC2A_EXT_EEPROM_4KB_RESCUED_VIN_CRC_1C4RJFN9XJC309165_628f7b3c.bin   (Task #514)
  type (filename-hinted) = GPEC2A
  type (parseModule)     = GPEC2A
  size = 4096
  VIN @ offset 0x0000 = 1C4RJFN9XJC309165   (primary)
  VIN @ offset 0x01F0 = 1C4RJFN9XJC309165   (mirror)
  VIN @ offset 0x0224 = 1C4RJFN9XJC309165   (mirror)
  Continental EEPROM part-number string `A2C7628120000` visible in the dump.
```

The BCM partial-VIN tail (`NH176487`) is the same legacy Hellcat tail
carried by the virgin BCM source used by the KEYPROG bundler — i.e. the
VIN-write that produced this dump rewrote the four full-VIN slots but left
the two 8-byte partial slots untouched. That mismatch is preserved on
purpose: it's a real-bench symptom worth pinning future partial-VIN /
secondary-offset verification work against (Task #47).

## Out of scope

- Verifying any algorithm or checksum behavior against these dumps — that
  belongs with #47, #48, #103.
- Reverse-engineering anything inside the dumps; this task only renames,
  relocates, and indexes.
