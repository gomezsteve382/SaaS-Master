# Rescued misnamed `.zip` dumps (Task #497)

Four files in this directory were originally uploaded with a `.zip`
extension but were actually raw module dumps that wouldn't open as
archives and never got picked up by the dump tools. They have been
rescued, renamed by content, and moved to the SRT Lab fixtures
directory `artifacts/srt-lab/src/__tests__/fixtures/`.

The originals here are now zero-byte stubs so anyone who searches for
the old filename can find this note and the new path.

| Original (zero-byte stub now) | Module | Bytes (orig) | New location |
|---|---|---|---|
| `Asset-Manager-Tool_1776900673446.zip` | BCM | 65536 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2.bin` |
| `Asset-Manager-Tool_1776900716171.zip` | BCM (dup) | 65536 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2_dup_1776900716171.bin` |
| `files_(1)_1776900673449.zip` | PCM (Continental GPEC2A 8 KB) | 8192 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa.bin` |
| `files_(1)_1776900716173.zip` | PCM (dup) | 8192 | `artifacts/srt-lab/src/__tests__/fixtures/SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa_dup_1776900716173.bin` |

See `artifacts/srt-lab/src/__tests__/fixtures/RESCUED_DUMPS.md` for full
provenance, surgical-inspection match, and smoke-check output.
