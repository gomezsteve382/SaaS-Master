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

> **[UNVERIFIED — THIRD-PARTY REPORT]**
> This algorithm was claimed to be fully reverse-engineered from the unpacked binary.
> It has **not** been verified against real ECU traffic. Do **not** implement this in
> `algos.js` or any other execution path until bench-confirmed with known seed→key pairs.

The reported security access level is `0x27 0x61` (requestSeed sub-function `0x61`,
sendKey sub-function `0x62`). The ECU reportedly returns an **8-byte seed** in the
`67 61 [8 bytes]` response.

### 7.1 Inputs / Outputs

- **Input**: 8-byte seed array `Seed[0..7]` (from ECU `67 61` response)
- **Output**: 8-byte key array `Key[0..7]` (sent back in `27 62` request)

### 7.2 Step-by-step (pseudocode)

> **[UNVERIFIED — THIRD-PARTY REPORT]** on every step below.

**Step 1 — Initialize key buffer**

```
Key[0] = 0x5A
Key[1] = 0xA5
Key[2..7] = 0x00
```

**Step 2 — TempSeed permutation (byte reorder + XOR)**

```
TempSeed[0] = Seed[2] ^ Seed[5]
TempSeed[1] = Seed[0] ^ Seed[7]
TempSeed[2] = Seed[4] ^ Seed[1]
TempSeed[3] = Seed[6] ^ Seed[3]
TempSeed[4] = Seed[1] ^ Seed[6]
TempSeed[5] = Seed[3] ^ Seed[0]
TempSeed[6] = Seed[5] ^ Seed[2]
TempSeed[7] = Seed[7] ^ Seed[4]
```

**Step 3 — 4-round mixer**

For each round `i` in `[0, 1, 2, 3]`:
```
Key[2] = (Key[2] + TempSeed[i*2])   & 0xFF
Key[3] = (Key[3] ^ TempSeed[i*2+1]) & 0xFF
Key[4] = (Key[4] + Key[2])           & 0xFF
Key[5] = (Key[5] ^ Key[3])           & 0xFF
Key[6] = (Key[6] + (Key[4] >> 4))   & 0xFF
Key[7] = (Key[7] ^ (Key[5] << 4))   & 0xFF  (note: low byte of shifted value)
Key[0] = (Key[0] + Key[6])           & 0xFF
Key[1] = (Key[1] ^ Key[7])           & 0xFF
```

**Step 4 — CRC-16/CCITT over first 4 seed bytes**

Compute CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`, no final XOR) over
`Seed[0..3]`. Let `CRC_Result` be the 16-bit result.

```
Key[0] = (Key[0] ^ (CRC_Result & 0xFF))        & 0xFF
Key[1] = (Key[1] ^ ((CRC_Result >> 8) & 0xFF)) & 0xFF
```

Our existing `crc16ccitt()` in `src/lib/crc.js` computes this exact variant.

**Step 5 — Final S-box substitution**

Apply a 256-byte custom S-box (`FCA_SBox`) embedded in the binary's data section:

```
for j in 0..7:
    Key[j] = FCA_SBox[Key[j]]
```

> ⚠️ The S-box contents were **not** included in the source report — they were described
> as "embedded in the binary's data section." The full S-box must be extracted from the
> unpacked binary before this algorithm can be implemented. Without it, Steps 1–4 alone
> will not produce a valid key.

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

### 8.2 Net-new gaps from this intel

| VILLAIN intel item | Gap description | Priority |
|-------------------|-----------------|----------|
| `0x27 0x61` security access level | No existing algo for this specific sub-function; needs bench seed→key pair first | High — blocked on S-box extraction |
| `FCA_SBox` (256-byte S-box) | Not present anywhere in codebase; must be extracted from unpacked binary | Blocker for `0x27 0x61` |
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
