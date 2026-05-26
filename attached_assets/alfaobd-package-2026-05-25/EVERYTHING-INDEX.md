# EVERYTHING.json — index of all extracted info

**Single 1.3 MB JSON file consolidating every piece of actionable data from every uploaded file.** Top-level keys + what's in each:

| Key | Type | Count | What |
|---|---|---|---|
| `routines` | dict | **3,789** | label_id → English routine description (from AlfaOBD DIAG_NAMES). All 8 Tier-1 IDs present (2504, 1520, 1126, 1750, 1751, 2505, 2507, 1367). |
| `multilingual_routine_blobs` | list | 324 | Concatenated EN+DE+CZ+ES+IT+FR+HU+RU description blobs from extraction-report.md |
| `alfaobd_exe_decrypted_strings` | dict | **2,078** | Every string from AlfaOBD.exe #US heap (Dotfuscator-decrypted) |
| `dids` | dict | 30 | UDS DIDs (F186-F1A5 ISO 14229 standard + module-specific guesses, each flagged) |
| `modules` | dict | **49** | Module catalog merged from 3 sources (V1 + V3 + SRT Lab verified) — each entry shows CAN IDs per source so you can pick by context |
| `algorithms.W6` | dict | **380** | Per-ECU (r, s) constant pairs for the linear seed-key cipher |
| `algorithms.W7` | dict | **360** | Per-ECU (n, o, p) parameter triples (cipher core not yet translated) |
| `algorithms.core` | dict | 3 | `ht`, `f`, `ao` constants (XTEA δ=0x8F750A1D, key, rounds=64) |
| `algorithms.special_ecus` | dict | 2 | UCONNECT (0x149), RADIO_FGA (0x14E) → `ao` |
| `dispatch` | dict | 10 | Family × security level → wrapper name (8 families × 1-3 levels each, partial) |
| `firmware` | list | **55** | Mopar firmware files w/ part numbers, calibrations, application metadata |
| `dtcs_sample` | list | 10 | Generic FCA DTC reference (sample only, NOT extracted from .db Faults table) |
| `vin_offsets` | dict | **17** | Per-module EEPROM VIN byte offsets + CRC-16-CCITT checksum locations |
| `vin_programming_sequence` | dict | 7 steps | UDS-over-CAN VIN write sequence template |
| `dealer_api` | list | **285** | Stellantis DealerCONNECT endpoints (POST /service/mds2002/Dispatcher) |
| `vin_api_specific` | list | 64 | DealerCONNECT VIN-specific endpoints (subset of `dealer_api`) |
| `flash_api_specific` | list | 15 | DealerCONNECT flash-specific endpoints |
| `cda_uds_commands` | dict | 4 | Confirmed plaintext UDS commands from CDA.swf (22 20 23 PROXI read, 2E 20 23 PROXI write, 22 10 2A EOL, 22 40 A2 EOL alt) |
| `cda_main_menu_xml` | str | — | CDA.swf full mainMenu XML (every UI feature/screen) |
| `uds_services` | dict | 6 | Generic UDS 0x10/0x27/0x2E/0x31/0x3E/0x11 with request/response formats |
| `fms_scripts` | list | 21 | wiTECH FMS flash-script filenames + sizes |
| `fms_common_commands` | list | 9 | UDS commands referenced across all .fms scripts |
| `security_intel.default_immobilizer_pin` | dict | — | **59183** — published default per DIAG_NAMES[1674] |
| `security_intel.skim_secret_size_bytes` | dict | — | **6 bytes hex** per DIAG_NAMES[1681] |
| `security_intel.sbec23_algorithm` | dict | — | Legacy SCI-bus PCM unlock: `Solution = (Seed × 4) + 0x9018` |
| `security_intel.security_references` | list | 28 | Multilingual security access strings from .db extraction |
| `security_intel.related_routines` | dict | 31 | DIAG_NAMES entries mentioning SKIM/secret/immobilizer/Code Card/FOBIK |
| `xor_key` | dict | 4 | 1024-byte AlfaOBD .db XOR key (length, first/last 32 hex, SHA-256) |
| `dotfuscator` | dict | 4 | AlfaOBD string decryption algorithm + verified test case |
| `vehicle_bin_dumps.bcm` | dict | — | **REAL 2019 Charger SRT Hellcat BCM**: VIN `2C3CCABG1KH539430`, 14 config DIDs present, NO SEC16 block (immobilizer pairing absent) |
| `vehicle_bin_dumps.rfh` | dict | — | **REAL 2020 Charger 6.2 RFH**: HW `AA40712804`, SW `AA61614486`, programmed secret `AB80 15D7 7ED9 43C1 AB45 EC16 8969 69DA 5D` at 0x050E (mirrored at 0x0522). Marked FRESH — needs PROXI alignment to marry to BCM. |
| `ecu_types_from_alfaobd_strings` | list | 6 | ECU type identifiers (GIULIA_PETROL_MED17_*, ECM_FGA_*, etc.) |
| `can_messages_from_alfaobd_strings` | list | 32 | CAN Input/Output message names (CAN Input (BCM_A5), CAN Input (SKREEM_A1), etc.) |
| `alfaobd_exe` | dict | 10 | AlfaOBD_PC v2.5.7.0 metadata (build 2025-08-24, .NET 4.8, Dotfuscator, EF6+SQLite) |
| `cda_swf` | dict | 12 | CDA.swf metadata (1204 classes, AdobeFlex 4.x + Parsley DI, wiTECH 2 client) |

## How to use this

This single file is meant for handoff: pass it to any tool that needs FCA diagnostic data and it picks out the slice it cares about. Browser app can load it directly (`fetch('/EVERYTHING.json')`); React component can do `const data = await fetch(...); data.routines["2504"].description_en` etc.

For SRT Lab features, each top-level key already has its own dedicated `client/src/lib/srt/*.generated.js` module — this file is the merged view.

## What's still NOT here

- The dispatch lookup that joins a `(label_id, target_ecu)` pair to the UDS `(routine_identifier, security_level, option_record)` bytes. This is the only thing actually unknown. Per `PROVENANCE.md`, it lives in a table in the .db whose shape match against `lost_and_found` is pending.
- One bench-verified `(seed, key)` pair for any of the 740 wrappers.
- Real Faults table content (10-entry sample is generic FCA docs, not .db extract).
