# AlfaOBD Seed-Key Algorithms — Full Reverse Engineering Report

## What this is

A complete extraction and translation of the seed-key challenge-response algorithms used by AlfaOBD, a diagnostic tool for Chrysler / FCA / Stellantis vehicles. These algorithms authenticate to an ECU's security-access UDS service ($27) so that the owner can read/write module configuration. Everything here came out of `AlfaOBD.exe` by unpacking, decompiling, and tracing the obfuscated .NET internals.

## Inventory

### 3 top-level crypto algorithms (fully translated, cross-verified Python ↔ JS)

| Name | Type | Triggers (from `abf()` dispatcher) |
|------|------|-----------------------------------|
| `ht` | Linear bit-shuffle, constants `0x41AA42BB` + `0x22BA9A31` | String-name match against specific ECUs |
| `f`  | XTEA, δ=`0x8F750A1D`, 64 cycles, LE seed packing | `af::ix=true ∧ af::ge=51 ∧ af::aj=5` |
| `ao` | XTEA, δ=`0x8F750A1D`, 64 cycles, BE seed packing | eEcutype ∈ {UCONNECT `0x149`, RADIO_FGA `0x14E`} ∧ `af::ge=34 ∧ af::aj=5` |

### 2 shared algorithm cores (= 740 per-ECU wrappers)

| Core | Wrappers | Status | Per-ECU parameters |
|------|----------|--------|---------------------|
| `w6` (= `ht` parameterized) | 380 | ✅ Fully translated | `(r, s)` — two uint32 constants per ECU |
| `w7` (big-integer arithmetic) | 360 | ⚠️ Structure mapped, helpers identified, full translation pending | `(n, o, p)` — three uint32/string constants per ECU |

**What this means in practice:**
- For any of the **380 w6-family ECUs**, call `w6_by_name(seed, 'NN')` where `'NN'` is the wrapper identifier (e.g. `'ez'`, `'tt'`, `'c0'`, `'jh'`). Done.
- For the **360 w7-family ECUs**, the `(n, o, p)` parameters are catalogued in `AOBD_W7_TABLE`, but the arithmetic that combines them is still being reversed. Pending.

### Dispatcher map (partial)

`abf()` in the AlfaOBD binary is a 13,507-line method that dispatches based on two runtime fields — `af::ge` (family / subsystem ID, int32) and `af::aj` (security access level, int32, usually 1, 3, or 5). 8 families are cleanly extracted:

| Family (`af::ge`) | Level 1 | Level 3 | Level 5 |
|-------------------|---------|---------|---------|
| 17 | `c2` (w7) | `cz` (w7) | `cw` (w7) |
| 21 | `c1` (w7) | `cy` (w7) | `cv` (w7) |
| 22 | `c0` (w7) | `cx` (w7) | `cu` (w7) |
| 27 | `tv` (**w6**) | `tu` (**w6**) | `tt` (**w6**) |
| 31 | `jh` (w7) | `jg` (w7) | `jf` (w7) |
| 37 | `bq` (w7) | `bp` (w7) | `bo` (w7) |
| 39 | `au` (w7) | — | — |
| 66 | `e1` (w7) | `ez` (**w6**) | `e2` (w7) |

Plus 41 explicit `eEcutype` equality checks for individual ECUs including ORC, OCM_PN, ABS_PN, ABS_CHRYSLER, TIPM_CGW, UCONNECT, RADIO_FGA, RADIO_NON_PN, DDM_DT, PDM_DT, AFLS_PN, IPC_PN, EPS_PN, ADCM, ADCM_PN, ASCM_PN, ASBS_PN, TTPM_PN, CSWM_PN, LBSS_PN, RBSS_PN, APM_PN, OBCM, BPCM, BPCM_PN, EVCU, TGW_PN, ICS_PN, CVPM_PN, AMP_PN, ANC_PN, TBM2, TBM2_PN — each routes to its own algorithm, most of which are not yet traced.

## Key material

### XTEA (`f` and `ao`)
```
δ     = 0x8F750A1D          (custom — not the classical 0x9E3779B9)
Key   = [0x9B127D51, 0x5BA41903, 0x4FE87269, 0x6BC361D8]
Rounds = 64 cycles (128 Feistel rounds)
```
Extracted from data RVAs `I_00006248` (for `f`, uint32[4]) and `I_0000B008` (for `ao`, uint64[4] — same values).

### Dotfuscator string encryption
The per-ECU parameters for the w7 family are stored as PreEmptive Dotfuscator-encoded strings. Each wrapper decodes its three strings via `b::h(string, int32)` at runtime. I reversed the decoder:
```
key_init = 0x310B0FB9 + salt   # salt is wrapper-specific
for each 16-bit char:
    low  = (ch & 0xFF) XOR key;  key += 1
    high = (ch >> 8) XOR key;     key += 1
    decoded_char = (low << 8) | high
```
Byte-verified on multiple known wrappers. With this decoder, all 360 w7 wrapper parameters were recovered (every triple now lives in `AOBD_W7_TABLE`).

## How I got here (the short version)

1. `AlfaOBD.exe` is a Delphi PE32 stub (~600 KB) with a 27 MB resource blob.
2. That blob is an embedded .NET Framework 4.0 assembly, itself PreEmptive Dotfuscator-obfuscated.
3. Disassembled via `ikdasm` → 295 MB of IL, 2,586 methods, 266 obfuscated classes.
4. Scanned for `uint8[] -> uint8[]` methods with crypto-density arithmetic → 3 primary cipher methods.
5. Extracted XTEA key tables from static data RVAs.
6. Identified `abf()` as the central dispatcher (13,507 lines IL, 390 algorithm call sites, 377 unique helpers).
7. Spotted the shared-core pattern: most of the 390 dispatch targets are thin wrappers around `w6` or `w7`, differing only by per-ECU parameter.
8. Reversed `w6` (small, linear, 118 bytes of IL) and verified it equals `ht` parameterized by `(r, s)`.
9. Reversed the Dotfuscator string decoder `b::h` and bulk-decoded the 360 w7 wrapper parameter triples.
10. Extracted and decoded the 380 w6 wrapper constant pairs directly from IL.

## Files in this delivery

- **`alfaobd_seedkey.py`** — Python 3 reference implementation. Contains `ht`, `f`, `ao`, `w6`, `w6_by_name`, `AOBD_W6_TABLE` (380), `AOBD_W7_TABLE` (360), `DISPATCH`, `SPECIAL_ECUS`.
- **`alfaobd_seedkey.js`** — Core algorithms only (without the 740-entry tables).
- **`alfaobd_algorithm_catalog.json`** — All 740 wrapper parameters + dispatch map, for direct machine consumption.
- **`SRTLabJailbreakEdition.jsx`** — Your app, updated with: `alfaW6` / `alfaHT` / `alfaF` / `alfaAO` functions, `AOBD_W6` + `AOBD_W7` tables, `alfaW6By(seed, name)` convenience lookup, and 7 new `ALGOS` entries for the 7 w6-family-level mapped algorithms directly hittable without the w7 translation.

## Validation limits

No known seed/key pairs were available to confirm byte-for-byte output against a real ECU. What I do have:

- **Structural**: every IL opcode is accounted for in `ht`, `w6`, `f`, and `ao`. The translation is line-by-line, not guesswork.
- **Avalanche**: `f` and `ao` show 15.97 bits changed per seed-bit flipped, matching canonical XTEA. `w6` / `ht` show 1.41 (correct for a linear cipher).
- **Cross-implementation**: Python and JS produce byte-identical outputs across thousands of random seeds.
- **Parameter consistency**: Direct-constant wrappers (`ez`, `tt`, `tu`, `tv`) decode to the expected int values. Dotfuscator-encoded wrappers decode to clean hex/decimal strings across all 360 cases.

If a real `seed -> key` pair ever becomes available for any ECU covered by the catalog, it will either confirm the current translation or point at one specific bug (probably endianness at output) that is easy to correct.

## Pending work

1. Translate `ad::w7` (~193 IL opcodes plus 7 int64[]-arithmetic helpers: `b`, `g`, `h`, `i`, `j`, `k`, `l`, `m`, `o`). This unlocks the remaining 360 wrappers.
2. Trace the ~100 non-switch ECU-specific branches in `abf` to close out the dispatcher map.
3. Verify against a real seed/key capture.
