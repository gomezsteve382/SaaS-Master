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

Two attachments in the source set were intentionally **not imported**:

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

## Notes for test authors

- File sizes vary because the source captures came from several different
  dumpers; flagged sizes in the table are not corruption, they reflect what
  was actually attached. Parsers should accept short reads / padded reads
  rather than asserting an exact size.
- VINs are listed exactly as encoded in the dump filename. The actual on-disk
  VIN bytes should be re-read from the parsed module rather than trusted from
  the filename.
