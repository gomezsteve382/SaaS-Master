# VILLAIN Binary Intelligence Reference

> ⚠️ **UNVERIFIED — THIRD-PARTY REPORT**
>
> All findings in this document originate from an external AI-assisted static/dynamic
> analysis of `VILLAIN_protected.exe`. They have **not** been ground-truthed against a
> real bench dump, our own disassembly, or a live vehicle. Every algorithm step, byte
> constant, CAN ID, and DID listed here is **unconfirmed intel** until independently
> verified on-bench. Use for reference and planning only — do not wire any algorithm
> from this document into production code paths.
>
> Raw source paste archived at:
> `attached_assets/Pasted-VILLAIN-protected-exe-Binary-12804-0-KB-Findings-28-Met_1779070578247.txt`

---

## 1. Binary Metadata

> **[UNVERIFIED — THIRD-PARTY REPORT]**

| Field | Value |
|-------|-------|
| File name | `VILLAIN_protected.exe` |
| File type | Windows PE32 Executable |
| File size | 13,111,296 bytes (≈ 12.5 MB) |
| Protection | Multi-stage packed / encrypted (custom packer + obfuscation) |
| Assessed purpose | Advanced FCA automotive diagnostics, ECU programming, and configuration |

---

## 2. Unpacking Notes

> **[UNVERIFIED — THIRD-PARTY REPORT]**

The binary was reported to employ three-stage obfuscation:

1. **Stage 1 — XOR decrypt**: Initial stub decrypts a compressed payload into a
   temporary memory region using an XOR cipher with a rotating key derived from PEB
   values.
2. **Stage 2 — LZ decompress**: The decrypted Stage 1 payload is decompressed via a
   custom LZ-variant algorithm, yielding the core unpacking logic.
3. **Stage 3 — Block cipher relocate**: The Stage 2 code allocates final executable
   sections and decrypts/relocates the actual application using a custom block cipher
   keyed on system-specific identifiers.

Additional hardening reported:
- Control flow flattening (jump tables + opaque predicates)
- Dynamic API resolution via `GetProcAddress` / `LoadLibraryA/W`
- Stack-based string decryption
- Anti-debugging / anti-VM checks (`IsDebuggerPresent`, CPUID leaf `0x40000000`)
- Post-unpack anti-dumping checksums over critical code sections

The reported extraction methodology used stealth hardware breakpoints to trigger a memory
dump **after** Stage 3 decryption but **before** the anti-dump checksum ran, followed by
automated IAT reconstruction.

**Bench verification needed**: Run the binary under a controlled J2534 + isolated CAN
harness and capture actual UDS traffic to confirm or refute these assertions.

---

## 3. CAN TX IDs

> **[UNVERIFIED — THIRD-PARTY REPORT]**
> Standard FCA CAN IDs; plausible from public documentation but not bench-confirmed from
> this specific binary.

| Module | TX CAN ID | Notes |
|--------|-----------|-------|
| PCM (Powertrain Control Module) | `0x7E0` | Engine + transmission control |
| BCM (Body Control Module) | `0x640` | Body electronics |
| SKIM (Sentry Key Immobilizer Module) | `0x6B0` | Anti-theft / key programming |
| RFHUB (Radio Frequency Hub) | `0x740` | Key fobs, remote start, TPMS |

Note: Standard UDS RX IDs are typically TX+8. Bench captures needed to confirm
functional RX addresses for this tool.

---

## 4. UDS Service Map

> **[UNVERIFIED — THIRD-PARTY REPORT]**
> Service IDs are ISO 14229-1 standard; the claim that this specific binary uses all of
> them requires bench confirmation.

| SID | Name | Usage per report |
|-----|------|-----------------|
| `0x10` | DiagnosticSessionControl | Session transitions (Default / Programming / Extended) |
| `0x14` | ClearDiagnosticInformation | Clear DTCs |
| `0x22` | ReadDataByIdentifier | Read ECU data (VIN, part numbers, calibration, etc.) |
| `0x2E` | WriteDataByIdentifier | Write ECU configuration data |
| `0x31` | RoutineControl | Start/stop/query factory ECU routines |
| `0x34` | RequestDownload | Initiate firmware download |
| `0x36` | TransferData | Transfer firmware blocks |
| `0x37` | RequestTransferExit | Close transfer session |
| `0x3D` | WriteMemoryByAddress | Arbitrary ECU memory writes (post security access) |
| `0x85` | ControlDTCSetting | Enable/disable DTC reporting |

---

## 5. FCA-Specific DID Examples

> **[UNVERIFIED — THIRD-PARTY REPORT]**
> DID values for `0xF1xx` are ISO 14229 standard. `0xDExx`, `0xABxx`, `0xCDxx` are
> FCA-proprietary — unconfirmed from this source alone.

### 5.1 Identification Block (ISO 14229 `0xF1xx`)

| DID | Reported name | Notes |
|-----|---------------|-------|
| `0xF180` | Vehicle Identification Number (VIN) | Standard ISO DID |
| `0xF18A` | ECU Part Number | Standard ISO DID |
| `0xF190` | Calibration ID | Standard ISO DID |
| `0xF191` | Calibration Verification Number (CVN) | Standard ISO DID |

> ⚠️ Note: the raw-source report labels are slightly inconsistent with ISO 14229. In the
> standard: `0xF180` = Boot Software Block Version, `0xF18A` = ECU Assembly Number,
> `0xF190` = VIN. The report may be using FCA-internal labels that differ from the ISO
> names. Cross-check against `lib/uds/src/dids.ts` before implementing.

### 5.2 SKIM / Immobilizer DIDs (`0xDExx`)

| DID | Reported name |
|-----|---------------|
| `0xDE01` | Immobilizer Status (SKIM) |
| `0xDE02` | Key Count (SKIM) |
| `0xDE03` | Key Learning Status (SKIM) |

### 5.3 RFHUB DIDs (`0xABxx`)

| DID | Reported name |
|-----|---------------|
| `0xAB01` | Remote Start Enable/Disable |
| `0xAB02` | Key Fob Configuration Data |

### 5.4 PCM DIDs (`0xCDxx`)

| DID | Reported name |
|-----|---------------|
| `0xCD01` | Injector Flow Rates |
| `0xCD02` | Transmission Adaptives |

---

## 6. Proprietary RoutineControl IDs (`0x31`)

> **[UNVERIFIED — THIRD-PARTY REPORT]**

All routines use sub-type `0x01` (startRoutine). Frame format: `31 01 HH LL [options]`.

| Routine ID | Reported name | Target ECU |
|-----------|---------------|------------|
| `0x0100` | Reset Transmission Adaptives | PCM (`0x7E0`) |
| `0x0101` | Perform Crankshaft Relearn | PCM (`0x7E0`) |
| `0x0200` | Key Learning Procedure | SKIM (`0x6B0`) |
| `0x0300` | RFHUB Component Replacement | RFHUB (`0x740`) |

---

## 7. `CalculateSecurityKey_0x61` Algorithm

> **[UNVERIFIED — THIRD-PARTY REPORT, SUPERSEDED]**

The reported security access level is `0x27 0x61` (requestSeed sub-function `0x61`,
sendKey sub-function `0x62`). The ECU reportedly returns an **8-byte seed** in the
`67 61 [8 bytes]` response.

### 7.2 Historical note — original (wrong) CRC16 + S-box report

The original third-party report described `0x27/0x61` as a 5-step algorithm: (1) init
`Key[0]=0x5A, Key[1]=0xA5`; (2) a byte-reorder + XOR permutation of `Seed[0..7]` into
`TempSeed[0..7]`; (3) a 4-round byte-wise mixer over `Key[]`; (4) CRC-16/CCITT-FALSE
(poly `0x1021`, init `0xFFFF`) over `Seed[0..3]` XOR'd into `Key[0..1]`; and (5) a
final substitution through a 256-byte `FCA_SBox` claimed to be embedded in the binary
but never extracted. That shape was implemented as `src/lib/villain27_61.js` (gated
behind `ENABLE_VILLAIN_0x61 = false`) and then refuted on bench by the
`VILLAIN_GPEC_COMPLETE_EXTRACTION.zip` upload — see §7.3 below for the correction. The
dead implementation, its feature flag, its `villain_0x61` `ALGOS` entry, the
`_unverified/` candidate file, and the bench-pair harness were all removed in a
follow-up cleanup. The pseudocode is intentionally not reproduced here — refer to
this file's git history if you need the original wording.

---

## 7.3 REVISED 2026-05-25 — §7.2 algorithm shape is wrong

A subsequent independent extraction of the VILLAIN memory dump
(`attached_assets/VILLAIN_GPEC_COMPLETE_EXTRACTION_1777782698204.zip`,
summarised in its bundled `VILLAIN_COMPLETE_EXTRACTION.md`) contradicts the
Steps-1–4 + S-box structure documented in §7.2. The findings:

- **Level 0x61 is in Group 4** of the binary's `EcuUnlocks` dispatch table
  (`0x22–0x26, 0x42, 0x45, 0x44, 0x60–0x62, 0x66, 0x67, 0x6B–0x6D`).
- Group 4 routes to the function `_gpec_calculator` (GPEC2 base), confirmed
  by the disassembled strings (`J2534_Define_strings.txt: a_gpec_calculator`)
  and the dispatch summary in §"Security Access Dispatch".
- `_gpec_calculator` operates on **32-bit integers** — variables
  `seedInt`, `tempSeedInt`, `TL1`–`TL5`, `keyInt` — with the constant pair
  `q1 = 0xE72E3799`, `q2 = 0x1B64DB03`. These are already wired into
  `algos.js` as the `gpec2_q1` / `gpec2_q2` sxor entries.
- **There is no 256-byte S-box in the binary.** A grep across the entire
  extraction (strings dumps + the 77 MB `wiTECH_wde.DMP`) returns zero hits
  for `FCA_SBox`, `sbox`, `S_BOX`, `CalculateSecurityKey`, or
  `security_key_0x61`. The original §7.2 description appears to be a
  fabrication or a confusion with a different module.
- The extraction also has no actual `_gpec_calculator` body — only its
  string-table name and constants. The function bytecode body was not
  captured, and no `(seed → key)` bench-pair captures from a live ECU were
  included in the upload.

**Consequence for the codebase:**

- The CRC16 + S-box scaffold (`src/lib/villain27_61.js`, the `ENABLE_VILLAIN_0x61`
  feature flag, the `villain_0x61` `ALGOS` entry, and the `_unverified/`
  candidate file with its bench-pair harness) has been **deleted**. It was
  structurally wrong for level 0x61 and kept the codebase carrying dead code.
- The bench-verification checklist below (§9) is superseded: the correct
  goal is to extract the `_gpec_calculator` body from an unpacked
  `VILLAIN.exe`, not to "find the S-box."
- The `gpec2_q1` / `gpec2_q2` entries in `algos.js` already cover the
  constants that the upload actually confirms. Whether their `sxor`
  implementation matches the unextracted `_gpec_calculator` body is still
  unverified.

**Bench-pair verification harness (Task #743):**

A fixture-driven test sits at
`src/lib/__tests__/gpec2BenchPairs.test.js` with its fixture at
`src/lib/__tests__/gpec2-bench-pairs.json` (currently `[]`, so the suite
reports a single skipped placeholder and CI stays green). The pattern
mirrors `src/lib/_unverified/__tests__/villain27_61.candidate.test.js`.

For each captured pair the harness asserts that either
`sxor(seed, 0xE72E3799)` or `sxor(seed, 0x1B64DB03)` reproduces the
captured key — accepting either constant because the bench operator
records the raw `0x27` sub-function used, not which of the two
`_gpec_calculator` internal branches the ECU took. If neither matches,
`sxor()` is the wrong shape for `_gpec_calculator` and must be replaced;
the `gpec2_q1` / `gpec2_q2` ALGOS entries get updated in the same change.

Fixture schema (per entry):

```
{ "seed":    "AABBCCDD",        // 4 bytes, big-endian, 8 hex chars
  "key":     "11223344",        // 4 bytes, big-endian, 8 hex chars
  "saLevel": 66,                // 0x42 — decimal so JSON stays readable
  "ecu":     "GPEC2A PCM (XYZ)",
  "date":    "2026-06-01",
  "source":  "bench notes / capture file ref" }
```

Only Group-4 SA levels are accepted by the schema check:
`0x22, 0x42, 0x44, 0x60, 0x61, 0x62, 0x66, 0x67, 0x6B, 0x6C, 0x6D`.

The "done" bar (≥3 pairs) is enforced inside the suite — populating the
fixture with fewer than 3 entries will fail loud rather than silently
pass with thin coverage.

---

## 8. How This Maps to SRT Lab Today

This section cross-references the VILLAIN intel against the existing codebase to identify
what is already covered and what is net-new.

### 8.1 Already covered

| VILLAIN intel item | SRT Lab coverage | File |
|-------------------|------------------|------|
| CAN TX IDs for PCM / BCM / SKIM / RFHUB | All four IDs referenced in existing module tabs | `RfhubTab.jsx`, `BcmTab.jsx`, `unlock_catalog.json` |
| UDS `0x10` DiagnosticSessionControl | `build.diagnosticSessionControl()` | `lib/uds/src/build.ts` |
| UDS `0x14` ClearDiagnosticInformation | `build.clearDiagnosticInformation()` | `lib/uds/src/build.ts` |
| UDS `0x22` ReadDataByIdentifier | `build.readDataByIdentifier()` | `lib/uds/src/build.ts` |
| UDS `0x2E` WriteDataByIdentifier | `build.writeDataByIdentifier()` | `lib/uds/src/build.ts` |
| UDS `0x31` RoutineControl | `build.routineControl()` | `lib/uds/src/build.ts` |
| UDS `0x34` RequestDownload | `build.requestDownload()` | `lib/uds/src/build.ts` |
| UDS `0x36` TransferData | `build.transferData()` | `lib/uds/src/build.ts` |
| UDS `0x37` RequestTransferExit | `build.requestTransferExit()` | `lib/uds/src/build.ts` |
| UDS `0x3D` WriteMemoryByAddress | `build.writeMemoryByAddress()` | `lib/uds/src/build.ts` |
| UDS `0x85` ControlDTCSetting | `build.controlDtcSetting()` | `lib/uds/src/build.ts` |
| UDS `0x27` SecurityAccess (frame builder) | `build.securityAccess()` | `lib/uds/src/build.ts` |
| VIN DID `0xF190` | Catalogued + decoded | `lib/uds/src/dids.ts` |
| BCM config DIDs `0xDE00`–`0xDE0C` | Catalogued + decoded | `lib/uds/src/dids.ts` |
| CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`) | `crc16ccitt()` confirmed matching | `src/lib/crc.js` |
| SecurityAccess for various GPEC/TIPM levels | Multiple `sxor` / `tipm` variants | `src/lib/algos.js` |
| SGW security access (`0x27 0x01` XTEA) | `xtea_sgw()`, `xtea_sgw_full()` | `src/lib/algos.js` |
| `0x27 0x61` security access | Dispatches to `_gpec_calculator` (GPEC2 base) per §7.3 — already wired as `gpec2` / `gpec2_q2` sxor entries (constants `q1=0xE72E3799` / `q2=0x1B64DB03`). Sxor body vs. live ECU still bench-pending. | `src/lib/algos.js` |

### 8.2 Net-new gaps from this intel

| VILLAIN intel item | Gap description | Priority |
|-------------------|-----------------|----------|
| `_gpec_calculator` function body | Per §7.3, level `0x61` routes to `_gpec_calculator`. The constants are in `algos.js` but the disassembled function body was not in the upload — bench-verify the existing `gpec2` / `gpec2_q2` sxor implementation against ≥3 live `(seed → key)` captures, or extract the body from an unpacked `VILLAIN.exe`. | High |
| 8-byte seed format for `0x27 0x61` | Existing `unlockKeyBytes()` handles 4-byte and 8-byte seeds; framing may need extension | Medium |
| SKIM DIDs `0xDE01`–`0xDE03` | Not in `dids.ts` catalog (only `0xDE00`–`0xDE0C` generic BCM blocks) | Low |
| RFHUB DIDs `0xAB01`–`0xAB02` | Not in `dids.ts` catalog | Low |
| PCM DIDs `0xCD01`–`0xCD02` | Not in `dids.ts` catalog | Low |
| Routine `0x0100` Reset Transmission Adaptives | No dedicated wrapper | Low |
| Routine `0x0101` Crankshaft Relearn | No dedicated wrapper | Low |
| Routine `0x0200` Key Learning Procedure | No dedicated wrapper | High (immobilizer path) |
| Routine `0x0300` RFHUB Component Replacement | Partially covered by `DealerLockoutBypassCard` flow | Medium |
| `0xF180` / `0xF18A` / `0xF191` label reconciliation | Report labels differ from ISO 14229 standard names; needs bench verification | Low |

---

## 9. Bench Verification Checklist

Before promoting any algorithm or DID from this document into production code:

- [ ] Obtain a real `67 61 [8-byte seed]` response from a target ECU on-bench
- [ ] Run Steps 1–4 from §7.2 against the captured seed; record intermediate `Key[]` state
- [ ] Extract the 256-byte `FCA_SBox` from the unpacked binary's data section
- [ ] Apply Step 5 and confirm the resulting key is accepted by the ECU (`67 62` positive response)
- [ ] Repeat with at least 3 different seed values to rule out lucky coincidence
- [ ] Cross-check `0xDE01`–`0xDE03` DID reads against a known-good SKIM bench unit
- [ ] Confirm CAN TX IDs for SKIM and RFHUB match live bus captures

---

## 10. Related Documents

- `artifacts/srt-lab/docs/fca-proxi-reference.md` — FCA PROXI Tool RE reference (bench-verified)
- `artifacts/srt-lab/docs/sgw-and-uds-reference.md` — SGW / wiTECH UDS function map
- `lib/uds/src/build.ts` — UDS frame builders (all services referenced above are implemented)
- `lib/uds/src/dids.ts` — DID catalog (covers `0xF1xx` and `0xDExx` families)
- `artifacts/srt-lab/src/lib/algos.js` — Seed-to-key algorithms (GPEC, TIPM, SGW XTEA)
- `artifacts/srt-lab/src/lib/crc.js` — CRC primitives including `crc16ccitt()`
