# SRT Lab Test Fixtures

Real-world FCA ECU binary dumps used as ground-truth inputs for parser,
checksum, security-byte, and pairing tests. Imported as-is from the user's
attached dumps under `attached_assets/` (timestamp suffixes stripped, names
normalized to `SAMPLE_<MODULE>_<STATE>_<VIN_or_TAG>.bin`).

These files are reference data only. They are not modified by tests and must
remain byte-identical to the originals so round-trip writers can be checked
against them.

## Modules covered

- **BCM DFLASH** — Body Control Module data flash dump (Hellcat / Trackhawk
  797-class BCMs and the 2017 Charger SXT BCM).
- **95640 EXT EEPROM** — External 95640 EEPROM (8 KB) used by various FCA
  modules; here it's the Trackhawk's external EEPROM.
- **GPEC2A EXT EEPROM** — Continental GPEC2A PCM external EEPROM (4 KB
  expected; some captures are larger because the dumper padded extra space).
- **GPEC2A INT FLASH** — Continental GPEC2A PCM internal program flash.
- **RFHUB EEE / P-FLASH** — Radio Frequency Hub (key fob / wireless) external
  EEPROM and program flash.
- **SmartBox EEE** — Dodge Journey SmartBox (MC9S12XEG384) EEPROM.

## File catalog

| File | VIN | Module | Bytes | Role | Notes / Pair |
|------|-----|--------|------|------|-------------|
| SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin | 2C3CDXL90MH582899 | BCM DFLASH | 65536 | SYNCED | Original synthetic-ish sample, paired with the matching RFH below. |
| SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin | 2C3CDXL90MH582899 | RFHUB EEE | 4096 | SYNCED / VIRGIN | Pairs with the BCM above. |
| SAMPLE_BCM_DFLASH_18TH_DEMO_OG.bin | (none) | BCM DFLASH | 8192 | DEMO_OG | Truncated demo dump (8 KB instead of 64 KB) — useful for short-read handling. |
| SAMPLE_BCM_DFLASH_18TH_DEMO_PATCHED.bin | (none) | BCM DFLASH | 65536 | DEMO_PATCHED | Demo dump with patched bytes; pair with DEMO_OG to diff the patch deltas. |
| SAMPLE_BCM_DFLASH_18TH_DEMO_VIN_CRC_1C4RJFDJ7DC513874.bin | 1C4RJFDJ7DC513874 | BCM DFLASH | 65536 | DEMO_VIN_CRC | VIN+CRC re-applied to the demo BCM for VIN #1 (Trackhawk). |
| SAMPLE_BCM_DFLASH_18TH_DEMO_VIN_CRC_1C4RJFDJXEC365477.bin | 1C4RJFDJXEC365477 | BCM DFLASH | 65536 | DEMO_VIN_CRC | VIN+CRC re-applied to the demo BCM for VIN #2 (Trackhawk). |
| SAMPLE_BCM_DFLASH_18TH_OG.bin | (factory) | BCM DFLASH | 65536 | OG | Real Trackhawk BCM original dump. |
| SAMPLE_BCM_DFLASH_18TH_OG_VARIANT2.bin | (factory) | BCM DFLASH | 65536 | OG | Second Trackhawk BCM original dump (different unit). |
| SAMPLE_BCM_DFLASH_18TH_OG_CRC.bin | (factory) | BCM DFLASH | 65536 | OG_CRC | Trackhawk BCM OG with CRC slots populated. |
| SAMPLE_95640_EXT_EEPROM_18TH_BAMA_OG.bin | (factory) | 95640 EXT EEPROM | 8192 | OG | Trackhawk external EEPROM original (BAMA tuner unit). |
| SAMPLE_95640_EXT_EEPROM_18TH_BAMA_VIN_CRC_1C4RJFDJ7DC513874.bin | 1C4RJFDJ7DC513874 | 95640 EXT EEPROM | 8192 | VIN_CRC | Same external EEPROM with VIN #1 written in. Pairs with the matching `SAMPLE_BCM_DFLASH_18TH_DEMO_VIN_CRC_1C4RJFDJ7DC513874.bin`. |
| SAMPLE_95640_EXT_EEPROM_FCA_DK_OG.bin | (factory) | 95640 EXT EEPROM | 65536 | OG | Generic FCA 95640 OG. NOTE: 64 KB (oversized; capture tool padded the 8 KB content). |
| SAMPLE_95640_EXT_EEPROM_FCA_04120001_OG.bin | (factory) | 95640 EXT EEPROM | 8192 | OG | FCA 95640 part 04120001 OG. |
| SAMPLE_95640_EXT_EEPROM_FCA_04120001_VIN_CRC_1C4RJFDJ7DC513874.bin | 1C4RJFDJ7DC513874 | 95640 EXT EEPROM | 8192 | VIN_CRC | VIN #1 stamped into 04120001. |
| SAMPLE_GPEC2A_EXT_EEPROM_18TH_OG.bin | (factory) | GPEC2A EXT EEPROM | 8192 | OG | Trackhawk PCM external EEPROM. NOTE: 8 KB (twice the typical 4 KB; capture appears doubled). Pairs with the Trackhawk BCM/EEPROM set. |
| SAMPLE_GPEC2A_EXT_EEPROM_JOVENTINO_OG.bin | (factory) | GPEC2A EXT EEPROM | 65536 | OG | "Joventino" Charger 6.2 PCM external EEPROM OG. NOTE: 64 KB (oversized capture). |
| SAMPLE_GPEC2A_EXT_EEPROM_VIN_CRC_2C3CDXCT1HH652640.bin | 2C3CDXCT1HH652640 | GPEC2A EXT EEPROM | 393216 | VIN_CRC | Charger 6.2 PCM external EEPROM with VIN+CRC for VIN #3. NOTE: 384 KB (oversized capture). Pairs with the matching RFHUB files below. |
| SAMPLE_GPEC2A_EXT_EEPROM_VIRGIN_OG.bin | (none / virgin) | GPEC2A EXT EEPROM | 4096 | VIRGIN | Virgin (blank) GPEC2A external EEPROM. |
| SAMPLE_GPEC2A_EXT_EEPROM_VIRGIN_SYNCED_62.bin | (none / virgin) | GPEC2A EXT EEPROM | 4096 | VIRGIN_SYNCED | Virgin GPEC2A 6.2 EEPROM that was already synced (security-bytes-only, no VIN). |
| SAMPLE_GPEC2A_INT_FLASH_OG_62.bin | (factory) | GPEC2A INT FLASH | 8192 | OG | GPEC2A 6.2 internal flash partial OG capture. NOTE: only 8 KB (partial dump). |
| SAMPLE_GPEC2A_INT_FLASH_JAILBREAK_62.bin | (factory) | GPEC2A INT FLASH | 65536 | JAILBREAK | GPEC2A 6.2 internal flash JAILBREAK partial. NOTE: 64 KB partial. |
| SAMPLE_GPEC2A_INT_FLASH_JAILBREAK_62_FULL.bin | (factory) | GPEC2A INT FLASH | 4194304 | JAILBREAK_FULL | Full 4 MB GPEC2A 6.2 internal flash JAILBREAK dump. |
| SAMPLE_RFHUB_EEE_OG_2C3CDXCT1HH652640.bin | 2C3CDXCT1HH652640 | RFHUB EEE | 4096 | OG | Charger 6.2 RFHUB external EEPROM with VIN+CRC. |
| SAMPLE_RFHUB_PFLASH_OG_2C3CDXCT1HH652640.bin | 2C3CDXCT1HH652640 | RFHUB P-FLASH | 4096 | OG | Charger 6.2 RFHUB program flash for the same VIN. |
| SAMPLE_SMARTBOX_EEE_JOVENTINO_VIN_CRC.bin | (Joventino set) | SmartBox EEE (MC9S12XEG384) | 4096 | VIN_CRC | Dodge Journey SmartBox EEPROM with VIN+CRC. Pairs with the JOVENTINO GPEC2A EXT EEPROM. |
| SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2.bin | 2C3CDXL97LH237142 | BCM DFLASH | 65536 | VIN_CRC | Task #497 — rescued from misnamed `attached_assets/Asset-Manager-Tool_1776900673446.zip`. 2020 Charger SXT, header `FEE1000` @ 0x04, locked, 8 immo recs. Pairs with the matching GPEC2A PCM below. |
| SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2_dup_1776900716171.bin | 2C3CDXL97LH237142 | BCM DFLASH | 65536 | VIN_CRC | Task #497 — rescued duplicate (byte-identical sha256 to the BCM above). |
| SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa.bin | 2C3CDXL97LH237142 | GPEC2A EXT EEPROM (8 KB) | 8192 | VIN_CRC | Task #497 — rescued from misnamed `attached_assets/files_(1)_1776900673449.zip`. 2020 Charger SXT, VIN at offset 0x00. Pairs with the matching BCM above. |
| SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa_dup_1776900716173.bin | 2C3CDXL97LH237142 | GPEC2A EXT EEPROM (8 KB) | 8192 | VIN_CRC | Task #497 — rescued duplicate (byte-identical sha256 to the PCM above). |
| SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1.bin | 2C3CDXL97LH237142 | BCM DFLASH | 65536 | VIN_CRC | Task #514 — rescued from misnamed `attached_assets/charger_1776900673447.png`. Second-bench capture of the same 2020 Charger SXT as the `_0d3593f2` BCM, but a different sha256 (84-byte delta). Same `FEE1000` header @ 0x04, same partial-VIN tail `NH176487` @ 0x4098/0x40B0, same security lock 0x5A (LOCKED). |
| SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1_dup_1776900716172.bin | 2C3CDXL97LH237142 | BCM DFLASH | 65536 | VIN_CRC | Task #514 — rescued duplicate (byte-identical sha256 to the BCM above). |
| SAMPLE_GPEC2A_EXT_EEPROM_4KB_RESCUED_VIN_CRC_1C4RJFN9XJC309165_628f7b3c.bin | 1C4RJFN9XJC309165 | GPEC2A EXT EEPROM (4 KB) | 4096 | VIN_CRC | Task #514 — rescued from misnamed `attached_assets/fca_module_analyzer_1776900458950.jsx`. 2018 Jeep Grand Cherokee SRT 6.4L PCM, VIN at offset 0x00, Continental part number `A2C7628120000` visible in the dump. |
| SAMPLE_RFHUB_EEE_22REDEYE797_KEYS_2C3CDXGJXNH176487.bin | 2C3CDXGJXNH176487 | RFHUB EEE | 4096 | OG | **Fifth distinct vehicle.** 2022 Charger Redeye 6.2 "797" RFHUB (master secret `581391E0…`). Charger 0xC5E key table parses clean: 4 paired keys in slots 5..8 (flag 0x01, mirror-verified, index-checksum valid) + 4 empty `5A5A5A5A 95 00` templates. VIN echoed reversed in the Gen2 VIN slots (0xEA5…). **PARSE-VERIFIED-ONLY** — keys are NOT in `knownWorkingKeys.js`: the source bundle's "BCM_DFLASH" file is byte-identical (sha256 `deae1510…`) to this RFHUB (a mislabeled duplicate, not a real BCM), so there is no independent BCM SEC16 cross-check; chip family + per-chip SK are unconfirmed. Pairs (by VIN only) with the GPEC2A below. See `src/lib/__tests__/charRfhubKeyTable.redeye797.test.js`. |
| SAMPLE_GPEC2A_EXT_EEPROM_797REDEYE_2C3CDXGJXNH176487.bin | 2C3CDXGJXNH176487 | GPEC2A EXT EEPROM (8 KB) | 8192 | OG | 2022 Charger Redeye 6.2 "797" PCM (Continental GPEC2A, VIN at offset 0x00). VIN-attribution provenance for the RFHUB above. NOTE: its PCM SEC6 does **not** equal `reverse(RFHUB master)[0:6]`, so it corroborates only the VIN string, not the immobilizer secret. |
| SAMPLE_RFHUB_EEE_19CHARGER62_KEYINDEX_0077A29B.bin | (2019 Charger 6.2) | RFHUB EEE | 4096 | KEYINDEX | Task #1096 — 2019 Charger 6.2 RFHUB dump carved from the key-index package. 6 keys in slots 3-8 of the Charger key table @0xC5E; the confirmed **working** key `0077A29B` (Autel read of the fob that starts the car) is slot 3 @0xC7E, index `0x48`, flag `0x01`. Ground truth for the known-good working-key registry (`knownWorkingKeys.js`). |

Several attachments in the source set were intentionally **not imported**:

- `attached_assets/VIN_1C4RJFDJXEC365477_18TRACKHAWKDFLASHBCM_DRAGKAT_OG_1776900458956.bin`
  is a 52 MB Windows PE executable (DragKat tool binary), not a BCM dump,
  despite the `.bin` extension and "BCM_DRAGKAT_OG" in the filename. It would
  poison any BCM parser test.
- The unrelated AlfaOBD / alphabcm / App.jsx attachments mentioned in the
  import task — they are tool sources or zips, not module dumps.

## Matched sets (for cross-module pairing tests)

### Trackhawk #1 — VIN `1C4RJFDJ7DC513874`
The BCM, external 95640, and FCA 95640 captures all share this VIN, so they
form a 3-module set for VIN-write / cross-module-secret / pairing checks:

- BCM DFLASH: `SAMPLE_BCM_DFLASH_18TH_DEMO_VIN_CRC_1C4RJFDJ7DC513874.bin`
- 95640 (Trackhawk BAMA): `SAMPLE_95640_EXT_EEPROM_18TH_BAMA_VIN_CRC_1C4RJFDJ7DC513874.bin`
- 95640 (FCA 04120001):   `SAMPLE_95640_EXT_EEPROM_FCA_04120001_VIN_CRC_1C4RJFDJ7DC513874.bin`

### Trackhawk #2 — VIN `1C4RJFDJXEC365477`
- BCM DFLASH: `SAMPLE_BCM_DFLASH_18TH_DEMO_VIN_CRC_1C4RJFDJXEC365477.bin`

(Plus the OG / OG_VARIANT2 / OG_CRC and DEMO_OG / DEMO_PATCHED Trackhawk BCMs
above as no-VIN baselines for diffing the VIN+CRC overlay.)

### Charger 6.2 "Mitchell" — VIN `2C3CDXCT1HH652640` (RFH ↔ PCM pair)
This is the canonical RFH ↔ PCM pair that the RFH→PCM pairing tab should be
verified against:

- RFHUB EEE:    `SAMPLE_RFHUB_EEE_OG_2C3CDXCT1HH652640.bin`
- RFHUB P-FLASH: `SAMPLE_RFHUB_PFLASH_OG_2C3CDXCT1HH652640.bin`
- PCM GPEC2A EXT EEPROM: `SAMPLE_GPEC2A_EXT_EEPROM_VIN_CRC_2C3CDXCT1HH652640.bin`

### Joventino set
- PCM GPEC2A EXT EEPROM (oversized OG): `SAMPLE_GPEC2A_EXT_EEPROM_JOVENTINO_OG.bin`
- Journey SmartBox EEPROM (VIN+CRC):    `SAMPLE_SMARTBOX_EEE_JOVENTINO_VIN_CRC.bin`

### Original synced pair — VIN `2C3CDXL90MH582899`
- BCM:  `SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin`
- RFH:  `SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin`

### 2020 Charger SXT — VIN `2C3CDXL97LH237142` (rescued, Tasks #497 and #514)
Real BCM ↔ PCM pair rescued from misnamed files in `attached_assets/`. The
Task #497 BCM (`_0d3593f2`) and the Task #514 BCM (`_ba26d1c1`) are two
different bench captures of the same SXT Charger BCM (84-byte delta — same
VIN, same partial-VIN tail, same security lock). Each capture has a
byte-identical duplicate (suffixed `_dup_<original-timestamp>`) — see
`RESCUED_DUMPS.md` for the original filename mapping and full smoke-check
output.

- BCM DFLASH (capture #1, Task #497): `SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2.bin`
                                       `SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2_dup_1776900716171.bin`
- BCM DFLASH (capture #2, Task #514): `SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1.bin`
                                       `SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1_dup_1776900716172.bin`
- PCM GPEC2A 8 KB (Task #497): `SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa.bin`
                                `SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa_dup_1776900716173.bin`

### 2018 Jeep Grand Cherokee SRT — VIN `1C4RJFN9XJC309165` (rescued, Task #514)
Standalone PCM dump rescued from a misnamed `.jsx` file in
`attached_assets/`. The Continental part number `A2C7628120000` is visible
inside the dump, confirming GPEC2A 4 KB EXT EEPROM. No matching BCM in the
attachment set; this is a PCM-only single-module sample.

- PCM GPEC2A 4 KB: `SAMPLE_GPEC2A_EXT_EEPROM_4KB_RESCUED_VIN_CRC_1C4RJFN9XJC309165_628f7b3c.bin`

## Notes for test authors

- File sizes vary because the source captures came from several different
  dumpers; flagged sizes in the table are not corruption, they reflect what
  was actually attached. Parsers should accept short reads / padded reads
  rather than asserting an exact size.
- VINs are listed exactly as encoded in the dump filename. The actual on-disk
  VIN bytes should be re-read from the parsed module rather than trusted from
  the filename.
