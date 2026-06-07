# RFHUB 24C32 EEPROM Reverse-Engineering Report

**Author:** Manus AI  
**Date:** 2026-06-07  
**Dataset:** 23 RFHUB 24C32 EEPROM dumps, 4096 bytes each, plus two XC2268 flash images supplied for firmware cross-reference.

## Executive summary

This analysis loaded and compared all supplied 24C32 EEPROM images, searched each image for VINs from its filename, tested the supplemental SRT Lab Gen2 reversed-VIN layout, searched the known-PIN dump for `7047`, compared the virgin image against programmed images, and probed common checksum families against the observed VIN record trailers. The most important finding is that **the 23 EEPROM dumps supplied in `/home/ubuntu/upload` do not use the supplemental SRT Lab Gen2 layout at offsets `0x0EA5`, `0x0EB9`, `0x0ECD`, and `0x0EE1`**. Instead, these dumps use **low-offset plain ASCII VIN records** at offsets such as `0x0040`, `0x0053`, `0x0092`, `0x00A5`, `0x016A`, `0x01EA`, and `0x01FD`.

Because the supplied EEPROMs do not contain the supplemental reversed-VIN slots, I could not honestly validate the `XOR(VIN) XOR magic` checksum against this dataset. I did implement that algorithm in the delivered tool for files that actually contain that supplemental layout, but **none of these 23 EEPROMs matched it**. For the actual low-offset ASCII layout, the VIN record trailer is consistently a two-byte value following the 17-byte ASCII VIN. The prior hypothesis, **VIN byte sum plus `0x08C7`**, produced no hits in these 23 EEPROMs, and the trailer also did not match the tested simple sums, XORs, common CRC-16 variants, or an exhaustive CRC-16 polynomial-difference search over the unique VIN/trailer pairs and the blank all-`0xFF` VIN slot.

The known-PIN file, `RAM RHF 24C32 pin 7047 3C7WRAKT8JG249045 ram.bin`, contains a strong candidate at **offset `0x01E3`**. Those two bytes decode as the known PIN using **little-endian packed BCD nibble order**. Because there is only one known-PIN sample, this should be treated as a confirmed candidate for that dump and a high-priority field hypothesis for matching layouts, not as a universal RFHUB PIN rule.

I also checked the supplemental SEC16 and key-slot markers. **No file in this dataset has the supplemental SEC16 header `AA 55 31 01` or `FF FF 00 00` at `0x0500`; no file has valid supplemental SEC16 CRC8-65 slots at `0x050E/0x0522`; and no file has `AA 50` key occupancy markers at `0x0880..0x0886`.** The actual low-offset layout does contain repeated high-entropy mirrored records and programmed regions that may include secret-key and transponder material, but the analysis did not produce a defensible exact SEC16 or key-slot assignment. Sensitive candidate bytes are redacted in the delivered tool and report.

## Scope, safety, and deliverables

The deliverables are scoped for authorized diagnostic and research use. I provide structural offsets, checksum validation status, and a safe inspection tool. I do not expose raw immobilizer secrets, raw SEC16 values, or raw transponder identifiers in the report or CSV outputs. The delivered Python utility can inspect and summarize RFHUB dumps, validate the supplemental reversed-VIN layout when present, and repair VIN checksums only for that supplemental layout. It deliberately refuses to modify the low-offset ASCII VIN layout because its two-byte trailer algorithm was not proven from the supplied dataset.

| Deliverable | Path | Purpose |
|---|---:|---|
| Final report | `/home/ubuntu/rfhub_work/RFHUB_24C32_reverse_engineering_report.md` | Human-readable conclusions, offsets, and uncertainty notes. |
| Safe RFHUB tool | `/home/ubuntu/rfhub_work/rfhub_safe_tool.py` | Inspects dumps, scans directories, validates supplemental Gen2 VIN checksum, and redacts sensitive data. |
| Redacted comparison CSV | `/home/ubuntu/rfhub_work/rfhub_safe_summary.csv` | Per-file layout classification, VIN offsets/trailers, supplemental-layout checks, and PIN-candidate plausibility. |
| Analysis scripts and raw intermediate outputs | `/home/ubuntu/rfhub_work/` | Reproducibility artifacts from VIN, PIN, checksum, SEC16-candidate, and key-structure scans. |

## Dataset and duplicate observations

All 23 EEPROM inputs are 4096 bytes, consistent with 24C32 devices. Several filenames are duplicate content under different names. For example, the two `3C6UR5CLXEG12648/3C6UR5CLXEG126483` files are byte-identical, the `RFH RAM 2019 DIESEL INFINEON` variants are byte-identical, and `RFH 24C32 3C63R3CL4NG240706.bin` is byte-identical to `RFH ram diesel beto morales_XC2265N-40.bin`. These duplicates are useful for confirming extraction consistency but should not be over-weighted when inferring algorithms.

| Category | Result |
|---|---|
| EEPROM image size | Every analyzed EEPROM image is 4096 bytes. |
| Virgin/blank file | `RFH_TRW_GQ4_55T_Virgen.bin` has no detected VIN and differs broadly from programmed images. |
| Blank/unclassified programmed-looking file | `Rfh jeep cherokee 2017.bin` has no detected valid VIN under the low-offset or supplemental layouts. |
| Duplicate content groups | Multiple byte-identical groups exist, so unique-content count is lower than filename count. |

## Confirmed VIN storage in the supplied EEPROMs

The actual VIN records in these EEPROMs are **plain ASCII**, not byte-reversed. The common record format is:

> **Low-offset VIN record:** `17 bytes ASCII VIN + 2-byte trailer`, where the trailer is displayed below as big-endian hex for readability.

The observed family-dependent VIN record positions are summarized below. The duplicate-copy layout is not universal; some Cherokee/KL modules have a single detected VIN record, while many RAM modules have duplicated records separated by `0x13` bytes.

| Layout family | Observed VIN offsets | Record size | Notes |
|---|---:|---:|---|
| RAM low family A | `0x0040`, `0x0053` | 19 bytes each | Seen in the known-PIN RAM dump and one 2018 RAM dump. |
| RAM/KL low family B | `0x0092`, `0x00A5` | 19 bytes each | Common in RAM 2019/2020 and several KL dumps. |
| KL family C | `0x016A` | 19 bytes | Seen in several Cherokee/KL dumps. |
| Module family D | `0x01EA`, `0x01FD` | 19 bytes each | Seen in `MODULO RHF ...` and some KL-style files. |
| Supplemental reversed Gen2 reference | `0x0EA5`, `0x0EB9`, `0x0ECD`, `0x0EE1` | 18 bytes each | Not present in any supplied EEPROM; implemented only for cross-checking other dumps. |

### VIN comparison table

The following table is the redacted per-file VIN layout summary from the final tool. The full CSV, including SHA-256 hashes and supplemental-layout checks, is attached separately.

| File | Layout | Detected VIN record offsets and trailers |
|---|---|---|
| `KL RFH 1C4PJMDBXGW294562 MCU XC2268-40 EEPROM 24C32.bin` | Low-offset ASCII | `0x016A: 1C4PJMDBXGW294562 + DE6E` |
| `KL RFH 1C4PJMDS6GW133769 MCU XC2268-40.bin` | Low-offset ASCII | `0x016A: 1C4PJMDS6GW133769 + FCAF` |
| `KL RFH 1C4PJMMB9PD115598 MCU 24C32.bin` | Low-offset ASCII | `0x0092: 1C4PJMMB9PD115598 + ABE6` |
| `MODULO RHF 3C6SRBDT4FG680947 68234886AC ram.bin` | Low-offset ASCII | `0x01EA: 3C6SRBDT4FG680947 + 7937`; `0x01FD: 3C6SRBDT4FG680947 + 7937` |
| `RAM RHF 24C32 pin 7047 3C7WRAKT8JG249045 ram.bin` | Low-offset ASCII | `0x0040: 3C7WRAKT8JG249045 + 7C98`; `0x0053: 3C7WRAKT8JG249045 + 7C98` |
| `RFH 24C32 3C63R3CL4NG240706.bin` | Low-offset ASCII | `0x0092: 3C63R3CL4NG240706 + 91CC`; `0x00A5: 3C63R3CL4NG240706 + 91CC` |
| `RFH 24C32 3C63RRGL6MG528500.bin` | Low-offset ASCII | `0x0092: 3C63RRGL6MG528500 + F96D`; `0x00A5: 3C63RRGL6MG528500 + F96D` |
| `RFH 24C32 3C6UR5CLXEG12648.bin` | Low-offset ASCII | `0x0092: 3C6UR5CLXEG126483 + B701`; `0x00A5: 3C6UR5CLXEG126483 + B701` |
| `RFH 24C32 3C6UR5CLXEG126483.bin` | Low-offset ASCII | `0x0092: 3C6UR5CLXEG126483 + B701`; `0x00A5: 3C6UR5CLXEG126483 + B701` |
| `RFH 24C32 3C7WRAKTXLG203140 VIN 2 UPDATE.bin` | Low-offset ASCII | `0x00A5: 3C7WRAKTXLG203140 + 328B`; first copy at `0x0092` is blanked in this file. |
| `RFH 24C32 3C7WRAKTXLG203140.bin` | Low-offset ASCII | `0x0092: 3C7WRAKTXLG203140 + 328B`; `0x00A5: 3C7WRAKTXLG203140 + 328B` |
| `rfh de cherokee original.BIN` | Low-offset ASCII | `0x016A: 1C4PJLCB0FW542067 + A830` |
| `Rfh jeep cherokee 2017.bin` | Unclassified/blank | No valid VIN detected. |
| `RFH KL 1C4PJMCXXKD481740 MCU 24C32 - copia.bin` | Low-offset ASCII | `0x0092: 1C4PJMCXXKD481740 + 7E0E` |
| `RFH Orig 24C32 UPA ram dj.bin` | Low-offset ASCII | `0x0092: 3C63RRGL8MG528191 + EB82`; `0x00A5: 3C63R3RL2NG308881 + AB94` |
| `RFH RAM 2018 INFINEON LENO.bin` | Low-offset ASCII | `0x0040: 3C6UR5DL5JG402562 + 6536`; `0x0053: 3C6UR5DL5JG402562 + 6536` |
| `RFH RAM 2019 DIESEL INFINEON CHUY CERRAJERO.bin` | Low-offset ASCII | `0x0092: 3C6UR5FL7LG237033 + 2B56`; `0x00A5: 3C6UR5FL7LG237033 + 2B56` |
| `RFH RAM 2019 DIESEL INFINEON ORG.bin` | Low-offset ASCII | `0x0092: 3C6UR5FL7LG237033 + 2B56`; `0x00A5: 3C6UR5FL7LG237033 + 2B56` |
| `RFH RAM 2019 VIN 3C6UR5FL7LG237033 DIESEL 24C32 CHUY CERRAJERO.bin` | Low-offset ASCII | `0x0092: 3C6UR5FL7LG237033 + 2B56`; `0x00A5: 3C6UR5FL7LG237033 + 2B56` |
| `RFH ram diesel beto morales_XC2265N-40.bin` | Low-offset ASCII | `0x0092: 3C63R3CL4NG240706 + 91CC`; `0x00A5: 3C63R3CL4NG240706 + 91CC` |
| `rfh.bin` | Low-offset ASCII | `0x016A: 1C4PJMCS5FW675350 + CA6B` |
| `RFH_TRW_GQ4_55T_Virgen.bin` | Virgin/blank | No valid VIN detected. |
| `Untited1.bin` | Low-offset ASCII | `0x0092: 1C4PJLDB2KD143844 + 5876` |

## VIN checksum and trailer analysis

The supplemental SRT Lab Gen2 rule is internally consistent for dumps that actually contain the reversed-VIN layout:

```python
def rfh_gen2_vin_checksum(raw17_reversed: bytes, magic: int = 0xDB) -> int:
    x = 0
    for b in raw17_reversed:
        x ^= b
    return x ^ magic
```

However, no supplied EEPROM has printable reversed VINs at the supplemental offsets, and none has the four-slot layout necessary to validate `magic = stored_checksum XOR XOR(raw17)`. For the supplied low-offset ASCII layout, the two-byte trailer remains unresolved. The following tests were performed and rejected for the actual low-offset trailer.

| Hypothesis tested | Result on supplied low-offset records |
|---|---|
| `sum(VIN bytes) + 0x08C7`, little-endian or big-endian | No hits across the dataset. |
| Simple unsigned byte sum, complemented sum, XOR, or additive constants | No consistent match. |
| Common CRC-16 families, including CCITT-style variants | No consistent match. |
| Exhaustive CRC-16 polynomial-difference search over unique VIN/trailer pairs and blank all-`0xFF` slot | No valid polynomial relation found under the tested model. |
| Firmware literal search for observed trailer constants and obvious EEPROM/checksum strings | No useful direct confirmation in the supplied XC2268 flash images. |

The `VIN 2 UPDATE` pair is especially informative. The original file has the VIN at `0x0092` and `0x00A5`, both with trailer `328B`. The update file has the `0x00A5` copy intact, while the first copy at `0x0092` is blanked with all `0xFF` VIN bytes and a trailer of `B4A2`. That gives a useful blank-record reference, but it still did not solve the trailer algorithm under the tested checksum families.

## PIN storage candidate

The known-PIN file contains one exact match for PIN `7047` at **offset `0x01E3`** under a **little-endian packed-BCD nibble interpretation**. In other words, the two-byte field at `0x01E3..0x01E4` decodes to the known four digits when nibbles are read as low nibble, high nibble, low nibble, high nibble.

| Field | Finding |
|---|---|
| Known-PIN file | `RAM RHF 24C32 pin 7047 3C7WRAKT8JG249045 ram.bin` |
| Candidate offset | `0x01E3` |
| Encoding | Two-byte packed BCD, little-endian nibble order. |
| Confidence | High for the known-PIN file; medium as a universal cross-layout RFHUB rule because only one known-PIN sample was supplied. |
| Tool behavior | The delivered tool reports only plausibility and a redacted value. |

This field is located outside the VIN records in the known-PIN RAM low family A layout. Several files have BCD-plausible bytes at the same offset, but without external known PINs those cannot be treated as confirmed PINs.

## SEC16 and security-key analysis

The supplemental SRT Lab SEC16 structure was tested exactly as provided: header at `0x0500`, slot 1 at `0x050E` with checksum at `0x051E`, slot 2 at `0x0522` with checksum at `0x0532`, and CRC8 polynomial `0x65` with init `0xBF` stored as `(CRC8 << 8) | 0x00`. No supplied EEPROM validated this structure.

| Supplemental SEC16 test | Result in 23 supplied EEPROMs |
|---|---|
| Header `AA 55 31 01` at `0x0500` | Not present. |
| Header `FF FF 00 00` at `0x0500` | Not present. |
| Slot 1 CRC8-65 at `0x050E/0x051E` | No valid matches. |
| Slot 2 CRC8-65 at `0x0522/0x0532` | No valid matches. |
| Safe conclusion | The supplemental SEC16 map is a different layout from these low-offset ASCII EEPROMs. |

The actual EEPROMs contain many repeated high-entropy mirrored records, often appearing as 16-byte or 18-byte windows with adjacent two-byte values. These are credible candidates for security/key-related material, but the dataset does not provide a BCM/RFHUB/ECM matched set or known SEC16 values to prove assignment. I therefore report them as candidate mirrored records only and keep raw values redacted.

| Candidate pattern in actual low-offset layout | Evidence | Status |
|---|---|---|
| Mirrored high-entropy records near low offsets | Found in several programmed images and absent or different in virgin/blank image. | Candidate secret or learned-data records; not assigned to SEC16. |
| Repeated 16-byte windows with identical following two-byte fields | Seen in multiple family-specific offsets. | Possible 16-byte data plus checksum pattern; no checksum formula validated. |
| Supplemental fixed SEC16 offsets | Tested and failed. | Rejected for this dataset. |

## Key-slot and transponder-record analysis

The supplemental key-slot structure with `AA 50` occupancy markers at `0x0880`, stride 2, and 8-byte IDs at `0x0888`, stride 8, was not present in the supplied EEPROMs. A whole-image search for `AA 50` also produced no useful marker evidence in the dataset. The filename set available in `/home/ubuntu/upload` did not include a file whose basename explicitly says `2 keys ok`, so I could not anchor key-count inference to a known ground-truth sample.

| Key-slot hypothesis | Result |
|---|---|
| `AA 50` markers at `0x0880`, `0x0882`, `0x0884`, `0x0886` | Not present. |
| 8-byte Autel ID array at `0x0888`, stride 8 | Not validated because markers are absent. |
| Whole-image `AA 50` marker search | No consistent key-slot marker found. |
| Actual low-offset key slots | Not exactly identified; repeated high-entropy regions likely include learned key/transponder material. |

The safest conclusion is that the supplied EEPROMs represent a different 24C32 RFHUB family from the supplemental Gen2 reversed-VIN map. Their learned-key structures are probably in the low and mid EEPROM regions that differ sharply from virgin, but exact slot boundaries require at least one sample pair with a known key count change or a confirmed transponder ID.

## Virgin/blank comparison

The virgin file has no valid VIN under either detector and no supplemental key/SEC markers. Programmed files differ from virgin across the low EEPROM region where VIN records, PIN candidate bytes, and high-entropy mirrored records appear. The differences are not limited to VIN bytes; many adjacent low/mid-range regions are written during programming.

| Region class | Evidence from virgin comparison | Interpretation |
|---|---|---|
| VIN record regions | Virgin lacks valid VIN records at the family offsets. | Written during personalization or module programming. |
| Low and mid EEPROM high-entropy regions | Programmed files diverge substantially from virgin in many runs. | Likely learned security/key/configuration data. |
| Supplemental Gen2 high offsets | No reversed-VIN slot evidence in these images. | Not the active layout for this dataset. |

## Firmware cross-reference

The two XC2268 flash images were searched for obvious VINs, trailer constants, `0x08C7`, EEPROM/checksum strings, and direct references that would explain the low-offset trailer. This did not produce a clear routine or literal table that confirms the trailer algorithm. The firmware files remain useful for a deeper static-disassembly effort, but the quick literal and constant scans did not solve the low-offset trailer.

## Delivered tool usage

The delivered Python tool is `/home/ubuntu/rfhub_work/rfhub_safe_tool.py`.

```bash
python3 /home/ubuntu/rfhub_work/rfhub_safe_tool.py inspect dump.bin
python3 /home/ubuntu/rfhub_work/rfhub_safe_tool.py inspect dump.bin --json
python3 /home/ubuntu/rfhub_work/rfhub_safe_tool.py scan-dir /path/to/dumps --csv summary.csv
```

For dumps that actually contain the supplemental reversed Gen2 layout, the tool can update the four reversed-VIN slots and recalculate the one-byte XOR checksum:

```bash
python3 /home/ubuntu/rfhub_work/rfhub_safe_tool.py set-gen2-vin input.bin 1C4PJMDBXGW294562 --out output.bin --magic auto
```

The tool refuses to modify the actual low-offset ASCII layout in these 23 EEPROMs because the two-byte trailer algorithm is unresolved. This is an intentional data-integrity safeguard.

## Final conclusions

The 23 supplied 24C32 EEPROMs are internally consistent as a **low-offset ASCII VIN RFHUB layout**, not the supplemental reversed-VIN Gen2 layout. VIN offsets and trailers are now mapped for every supplied file. The known PIN `7047` maps cleanly to **offset `0x01E3`** as little-endian packed BCD in the known-PIN file. The supplemental SEC16 and key-slot maps are rejected for this dataset. The exact SEC16/key-slot structures and the two-byte low-offset VIN trailer algorithm remain unresolved with the available evidence, despite targeted differential, checksum, CRC, and firmware-constant searches.

The attached tool and CSV make the findings reproducible and provide a safe foundation for the next stage. To finish the remaining unknowns definitively, the most valuable additional samples would be a matched before/after key-learning pair with known key count and transponder IDs, two or more additional dumps with externally known PINs, and a matched BCM/RFHUB/ECM trio with a known SEC16 value for one vehicle.

## References

[1]: /home/ubuntu/rfhub_work/rfhub_safe_summary.csv "Redacted RFHUB per-file comparison CSV generated from the supplied EEPROMs"  
[2]: /home/ubuntu/rfhub_work/rfhub_safe_tool.py "Safe RFHUB 24C32 inspection and supplemental Gen2 VIN checksum utility"  
[3]: /home/ubuntu/rfhub_work/vin_record_crc_probe.txt "Focused VIN trailer checksum probe output"  
[4]: /home/ubuntu/rfhub_work/vin_crc_poly_search_results.txt "Compiled CRC-16 polynomial-difference search result"  
[5]: /home/ubuntu/rfhub_work/checksum_08c7_hits.txt "Explicit VIN-sum-plus-0x08C7 search result"  
[6]: /home/ubuntu/rfhub_work/sec16_candidates.csv "Redacted SEC16 candidate scan output"  
[7]: /home/ubuntu/rfhub_work/virgin_compare.json "Virgin-versus-programmed byte-difference summary"
