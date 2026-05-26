# AlfaOBD Complete Extraction Package

**Date:** May 25, 2026
**Source:** AlfaOBD.exe (Delphi/Dotfuscator-obfuscated .NET, FCA/Stellantis diagnostic tool)

---

## Package Contents

### `/database/` — Decrypted SQLite Database + Keys
| File | Description |
|------|-------------|
| `alfaobd_decrypted.db` | 66MB decrypted database (XOR key applied, partially malformed but text-readable) |
| `alfaobd_encrypted_may3.db` | 66MB encrypted database (May 3, 2025 version) |
| `xor_key.bin` | 1024-byte repeating XOR key (binary) |
| `xor_key_hex.txt` | XOR key in human-readable hex format |
| `decrypt_alfaobd.py` | Python decryption script |
| `analysis_notes.txt` | Database schema analysis notes |

**Database Status:** The XOR key was recovered via frequency analysis and is ~90-95% correct. The SQLite header is valid, table schemas are readable, and most text data (routine descriptions, fault codes, multilingual labels) is intact. Some pages have byte-level corruption preventing full SQLite parsing, but raw string extraction works perfectly.

**19 Tables Found:**
- BODY_PN_CONFIG, CAN_DELPHI_500_CONFIG, CAN_DELPHI_RAM_CONFIG, CAN_MARELLI_CONFIG
- Devices_params_units, Diag_names, FCM_CGW_CONFIG
- FGA_ABS_DATA, FGA_DIESEL_DYNAMIC, FGA_DIESEL_STATIC, FGA_ENGINE_DATA
- FGA_IPC_DATA, FGA_IPC_SNAPSHOT, FGA_IPC_SNAPSHOT_DATA
- Faults, STATES, TIPM_CGW_CONFIG, Units, newTable

---

### `/seedkey-algorithms/` — Complete Seed-Key Implementation
| File | Description |
|------|-------------|
| `alfaobd_seedkey.py` | Full Python implementation (884 lines, 380 W6 + 360 W7 entries) |
| `alfaobd_seedkey.js` | JavaScript implementation |
| `algorithm_catalog.json` | Complete catalog: 380 W6 (linear) + 360 W7 (big-integer) + 10 dispatch families |
| `README.md` | Algorithm documentation |

**Three Core Algorithms:**
1. **ht(seed)** — Simple bit-shuffle. Constants: `0x41AA42BB`, `0x22BA9A31`
2. **f(seed)** — XTEA, 64 cycles, delta=`0x8F750A1D`, key=`[0x9B127D51, 0x5BA41903, 0x4FE87269, 0x6BC361D8]`
3. **ao(seed)** — XTEA big-endian variant (UCONNECT 0x149 / RADIO_FGA 0x14E)

**W6 Algorithm:** Simple linear transformation using per-ECU (r, s) constants
**W7 Algorithm:** Big-integer arithmetic using per-ECU (n, o, p) constants
**Dispatch:** Maps ECU family + access level → algorithm code

---

### `/databases-json/` — Pre-Extracted JSON Databases
| File | Description |
|------|-------------|
| `master-module-database.json` | 88KB — All FCA/Stellantis module definitions |
| `firmware_database.json` | 154KB — Firmware version catalog |
| `fms_analysis.json` | 430KB — Flash Memory System analysis |
| `vin-programming-sequences.json` | 240KB — VIN programming step sequences |
| `vin-offset-database-extended.json` | 13KB — VIN byte offsets per module |
| `uds-protocols-extracted.json` | 5.4KB — UDS protocol definitions |
| `did_database.json` | 8.4KB — Data Identifier catalog |
| `dtc-database.json` | 7.6KB — Diagnostic Trouble Code definitions |
| `complete-module-database.json` | 16KB — Module summary |
| `vin_programming_guide.json` | 7.4KB — VIN programming guide |

---

### `/reports/` — Analysis Reports
| File | Description |
|------|-------------|
| `alfaobd_full_extraction_report.md` | 56KB — Complete extraction report (schemas, routines, security, DTCs, CAN addresses) |
| `alfaobd-reverse-engineering-status.md` | 7.5KB — Reverse engineering progress tracker |

---

### `/tools/` — Extraction Scripts
| File | Description |
|------|-------------|
| `full_extraction.py` | Comprehensive DB extraction script (generates the full report) |
| `extract_db.py` | Targeted extraction for routine IDs and keywords |

---

## Key Findings

### Routine Data
- **674 routine references** found in database with multilingual descriptions (EN/DE/ES/FR/IT/CZ/PL/TR)
- Routine descriptions cover: sensor calibration, fuel pump actuation, air bleeding, clutch learning, compass calibration, idle shutdown, DPF regeneration, VIN learning, oil life reset, and more
- Target routine IDs (2504, 1520, 1126, 1750, 1751, 2505, 2507, 1367) appear in binary context — the routines table (`fgaipcroutines`) stores numeric IDs as binary integers, not ASCII

### Security Access
- **27 security references** including: security key validation, access denial messages, login attempt limits, time delay enforcement, Code Card authentication
- Full seed-key algorithm catalog with 740+ ECU-specific parameter sets

### ECU Coverage
- PCM, BCM, TCM, ABS, TIPM, IPC, RFHUB, GPEC, ADCM, SGW, UCONNECT, RADIO, EPS, ESC, HVAC, DTCM, EHPS, OCM, SCCM, UCM, ORC

### CAN Bus
- Known FCA diagnostic addresses: 0x740/0x742 (RFHUB), 0x7E0/0x7E8 (PCM), 0x7E2/0x7EA (TCM), 0x760/0x768 (BCM), 0x762/0x76A (IPC)

---

## Usage

### Decrypt the database yourself:

```python
python3 database/decrypt_alfaobd.py database/alfaobd_encrypted_may3.db output.db
```

### Use seed-key algorithms:

```python
from seedkey_algorithms.alfaobd_seedkey import ht, f, ao, compute_w6_key, compute_w7_key

# Simple bit-shuffle (most ECUs)
key = ht(seed_bytes)

# XTEA (level 5 access)
key = f(seed_bytes)

# UCONNECT/RADIO
key = ao(seed_bytes)

# Per-ECU parameterized (W6)
key = compute_w6_key(seed_bytes, ecu_code='a0')
```

### Run extraction on the database:

```python
python3 tools/full_extraction.py
```

---

## Notes

- The database XOR encryption uses a 1024-byte repeating key. The key was recovered via frequency analysis of the encrypted file against known SQLite page structure.
- ~5-10% of bytes may be incorrect at offsets where plaintext varies heavily across pages. The first 100 bytes (SQLite header) are guaranteed correct.
- The `fgaipcroutines` table stores routine IDs as binary integers in SQLite's native format, not as ASCII text. A fully-valid SQLite parser would be needed to extract them cleanly.
- The algorithm catalog's "dispatch" table maps ECU families to algorithm codes based on access level (aj_1=level 1, aj_3=level 3, aj_5=level 5).

---

## SRT Lab integration map

For each file listed above, here's where its content landed in `srt-lab-ultimate`:

| Package file | SRT Lab location |
|---|---|
| `database/xor_key.bin` | `attached_assets/alfaobd-db-xor-key.bin` + `client/src/lib/srt/alfaobdDbXorKey.js` |
| `database/decrypt_alfaobd.py` | `scripts/decrypt-alfaobd-db.mjs` (Node port) |
| `seedkey-algorithms/alfaobd_seedkey.py` | `client/src/lib/srt/algos.js` + `client/src/lib/srt/alfaobdAlgorithms.generated.js` |
| `seedkey-algorithms/algorithm_catalog.json` | `client/src/lib/srt/alfaobdAlgorithms.generated.js` |
| `databases-json/master-module-database.json` | `client/src/lib/srt/masterModuleDatabase.generated.js` |
| `databases-json/firmware_database.json` | `client/src/lib/srt/firmwareCatalog.generated.js` |
| `databases-json/fms_analysis.json` | `client/src/lib/srt/fmsScripts.generated.js` |
| `databases-json/vin-programming-sequences.json` | `client/src/lib/srt/witechServices.generated.js` |
| `databases-json/vin-offset-database-extended.json` | `client/src/lib/srt/vinOffsetDatabase.generated.js` |
| `databases-json/uds-protocols-extracted.json` | `client/src/lib/srt/udsProtocolsExtracted.generated.js` |
| `databases-json/did_database.json` | `client/src/lib/srt/udsDidCatalog.generated.js` |
| `databases-json/dtc-database.json` | `client/src/lib/srt/dtcDatabaseSample.generated.js` |
| `databases-json/complete-module-database.json` | `client/src/lib/srt/completeModuleDatabase.generated.js` |
| `databases-json/vin_programming_guide.json` | `client/src/lib/srt/vinProgrammingGuide.generated.js` |
| `reports/alfaobd_full_extraction_report.md` | `attached_assets/alfaobd-package-2026-05-25/extraction-report.md` + `client/src/lib/srt/alfaobdExtractedText.generated.js` |
| `reports/alfaobd-reverse-engineering-status.md` | `attached_assets/alfaobd-package-2026-05-25/reverse-engineering-status.md` |
| `tools/full_extraction.py` | `attached_assets/alfaobd-package-2026-05-25/full-extraction-script.py` |
| `tools/extract_db.py` | `attached_assets/alfaobd-package-2026-05-25/extract-db-script.py` |

**Not received (binary files too large for chat upload):**
- `database/alfaobd_decrypted.db` (66 MB) — required to run `sqlite3 .recover` for fgaipcroutines
- `database/alfaobd_encrypted_may3.db` (66 MB) — required to re-run `decrypt-alfaobd-db.mjs` with a refined key

Everything else from the package is fully landed.
