# AlfaOBD Seed-Key Algorithms — Reverse Engineering Report

## Executive summary

Three seed-key algorithms recovered from AlfaOBD.exe (Dodge/Chrysler/FCA diagnostic tool):

| Name | Type | When used | Confidence |
|------|------|-----------|-----------|
| `ht` | linear bit-shuffle | ECU name string match (specific set) | HIGH — matches IL exactly |
| `f`  | XTEA (delta 0x8F750A1D) | af::ix=true, af::ge=51, security level 5 | HIGH — XTEA avalanche verified |
| `ao` | XTEA big-endian input | UCONNECT or RADIO_FGA at security level 5 | HIGH — same keystream, different input encoding |

**Key material (shared by f and ao):**
- XTEA delta: `0x8F750A1D` (custom — *not* the standard golden-ratio 0x9E3779B9)
- XTEA key (4 × uint32): `[0x9B127D51, 0x5BA41903, 0x4FE87269, 0x6BC361D8]`
- Rounds: 64 cycles (= 128 Feistel rounds)

**ht constants:**
- XOR constant: `0x41AA42BB`
- AND mask: `0x22BA9A31`
- No loop, no table — single pass linear algorithm

## How I got here

1. AlfaOBD.exe is a **Delphi PE32 stub** (~600 KB of Delphi code, 27 MB resource section).
2. The resource section contains a `RCDATA/EXERESX` entry starting with `MZ` → **embedded inner executable, 26.8 MB.**
3. Inner binary is a **.NET Framework 4.0 assembly** (CLR v4.0.30319) obfuscated with **PreEmptive Dotfuscator**.
4. Type names are flattened to `a, b, c, ..., fe` (266 types). Strings are encrypted via `b::h(string, int32)`. Two namespace types survived unobfuscated: `AlfaOBD_PC.eEcutype` (506-entry ECU enum) and `AlfaOBD_PC.Stage` (5-entry progress enum).
5. Disassembled 26.8 MB to 295 MB of IL via `ikdasm` → 2,586 methods total.
6. Scanned for methods with signature `uint8[] method(uint8[])` and crypto-style arithmetic density → exactly 3 hits: `ad::f`, `ad::ht`, `ad::ao`. Every other `byte[]→byte[]` method in the binary is file I/O or string handling.
7. All three methods are called from **one dispatcher**: `abf()` — a 32 KB-IL method that contains ~377 calls to per-ECU-type helpers (other `ad::XX` methods), with ECU-type + security-level branching.
8. XTEA key tables extracted from data RVAs `I_00006248` (for `f`, 16 bytes as 4×uint32) and `I_0000B008` (for `ao`, 32 bytes as 4×uint64-padded — same underlying values).

## Dispatch logic (for the three reversed methods)

The dispatcher `abf()` loads these fields from the current ECU context (class `af`):
- `af::ak` — the 4-byte seed buffer (the ECU's challenge)
- `af::ix` — a boolean flag (possibly "is modern security" or "is UDS-based")
- `af::ge` — an int32 group/subsystem ID
- `af::aj` — security access level (1 = basic, 5 = advanced)
- `af::d::j` — eEcutype (the ECU type enum value)

Branches:
- `ht`: if `af::ix == true` AND a decrypted string name matches a specific ECU identifier (via obfuscated `b::h` compare)
- `f`:  if `af::ix == true` AND `af::ge == 51` AND `af::aj == 5`
- `ao`: if (`af::ix == true` OR eEcutype ∈ {UCONNECT=0x149, RADIO_FGA=0x14E}) AND `af::ge == 34` AND `af::aj == 5`

## Scope of what's NOT covered

The `abf()` dispatcher calls **~370 other algorithm variants** (methods `ad::a0`, `ad::b2`, ..., `ad::wz`) for different ECU types and security levels. These are *not* reversed here. Each is likely a small algorithm (shift-xor, table-lookup, or linear) tailored to a specific module family. For the Dodge Scat Pack / Hellcat ECUs (BCM, RFHUB, ECM, TCM, etc.), the exact algorithm depends on which `ad::XX` helper the dispatcher routes to — which requires either (a) a real seed/key capture from each module, or (b) continuing to manually trace the full dispatcher logic.

## Validation limits

No known seed/key pairs were available to validate these translations against ground truth. The confidence rating comes from:
- **ht**: linear algorithm — every IL instruction is directly translated to the equivalent arithmetic. Python and JS implementations produce identical output across all test seeds.
- **f**, **ao**: the 15.97 bits-changed-per-seed-bit-flipped avalanche score matches canonical XTEA (expected 16.0 for a 32-bit cipher). This is a strong structural confirmation. Endianness at output may need tweaking if a real seed/key pair turns out to reveal a specific byte-order convention I didn't capture from the IL return section.

## Files

- `alfaobd_seedkey.py` — Python 3 reference implementation (CPython 3.8+)
- `alfaobd_seedkey.js` — ES module JavaScript implementation for browser / Node
- Both produce identical output for all inputs.

## Constants from the competing Kimi calculator

The Kimi zip you had contains a mix of real and fabricated algorithm parameters:
- `bcm_standard: seed * 0x9D + 0x1234` — matches your existing App.jsx BCM fallback. **Plausible real.**
- `bcm_fca: (seed ^ 0xABCDEF12) * 0x4D + 0x5678` — matches your App.jsx BCM FCA fallback. **Plausible real.**
- `rfhub_rh850` includes `0xDEADBEEF`, `ecm_pcm_modern` includes `0x5A5A5A5A`/`0xC3C3C3C3`, the `X`/`A`/`B`/`C` lookup tables are `0xAAAAAAAA` / `0xCCCCCCCC` patterns — **placeholders, not real algorithm output.**
- `B1` table `[68,65,73,77,76,69,82,67,72,82,89,83,76,69,82,49]` decodes to ASCII `"DAIMLERCHRYSLER1"` — **real Chrysler NGC constant.**
- None of Kimi's constants match `0x8F750A1D`, `0x41AA42BB`, `0x22BA9A31`, or the XTEA key table from AlfaOBD.
