# Rescued misnamed dumps in `attached_assets/`

Files in this directory have been uploaded over time with the wrong
extension or filename. Each rescue moves the real content to its proper
home (and leaves a zero-byte stub here so anyone searching for the old
filename can still find this note and the new path), or — when the file
turned out not to be vehicle data at all — deletes the content with a
one-line reason.

## Task #497 — misnamed `.zip` files

Four files were uploaded with a `.zip` extension but were actually raw
module dumps that wouldn't open as archives. They have been renamed by
content and moved to `artifacts/srt-lab/src/__tests__/fixtures/`.

| Original (zero-byte stub now) | Module | Bytes (orig) | New location |
|---|---|---|---|
| `Asset-Manager-Tool_1776900673446.zip` | BCM | 65536 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2.bin` |
| `Asset-Manager-Tool_1776900716171.zip` | BCM (dup) | 65536 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2_dup_1776900716171.bin` |
| `files_(1)_1776900673449.zip` | PCM (Continental GPEC2A 8 KB) | 8192 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa.bin` |
| `files_(1)_1776900716173.zip` | PCM (dup) | 8192 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa_dup_1776900716173.bin` |

## Task #514 — second-wave rescues from the new content-sniffing scanner

The Task #504 scanner (`pnpm --filter @workspace/srt-lab assets:check`)
flagged eight more files whose contents didn't match their extension.
Three were real vehicle dumps and have been renamed; four were not
vehicle data and have been deleted; one (the duplicate of an existing
JSX file pattern) is covered by the same "Not vehicle data" note.

### Renamed (real dumps moved to fixtures)

| Original (zero-byte stub now) | Module | Bytes (orig) | New location |
|---|---|---|---|
| `charger_1776900673447.png` | BCM (2020 Charger SXT, second bench capture) | 65536 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1.bin` |
| `charger_1776900716172.png` | BCM (dup of `_ba26d1c1`) | 65536 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1_dup_1776900716172.bin` |
| `fca_module_analyzer_1776900458950.jsx` | PCM (Continental GPEC2A 4 KB, 2018 Jeep Grand Cherokee SRT 6.4L) | 4096 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_GPEC2A_EXT_EEPROM_4KB_RESCUED_VIN_CRC_1C4RJFN9XJC309165_628f7b3c.bin` |

### Deleted (content was not vehicle data — zero-byte stub kept for traceability)

| Original (zero-byte stub now) | Bytes (orig) | One-line reason |
|---|---|---|
| `MITCH_PFLASH_1776900673451.bin` | 18683 | Not vehicle data — Python source (J2534 bridge daemon), byte-identical to `attached_assets/zip_j2534_bridge.py` already in this directory; the `MITCH_PFLASH` filename is misleading. |
| `MITCH_PFLASH_1776900716175.bin` | 18683 | Not vehicle data — duplicate of the file above (same sha256). |
| `j2534_bridge_1776900673450.py` | 242502 | Not vehicle data — ZIP archive of stale source bundles (`RFHUBVirginizer.tsx`, `BCMConfiguration.tsx`, `VINCommander.tsx`, …) for components that no longer exist anywhere in the SRT Lab artifact. |
| `j2534_bridge_1776900716174.py` | 242502 | Not vehicle data — duplicate of the file above (same sha256). |

See `artifacts/srt-lab/src/__tests__/fixtures/RESCUED_DUMPS.md` for full
provenance, surgical-inspection match, and smoke-check output for every
rescued dump.
