# VILLAIN Unpack & Seed/Key Verification Workflow

> **Status: PLAN ONLY — not yet executed**
>
> This document is a reviewable methodology for independently verifying two claims
> from the third-party VILLAIN report: (1) the multi-stage unpacking of
> `VILLAIN_protected.exe`, and (2) the `0x27 0x61` seed-to-key algorithm. It does
> **not** execute any unpacking, run the binary, dump memory, or call the candidate
> algorithm against a live ECU. It is the playbook and test-harness specification
> for a human operator (or a follow-up task scoped to a Windows bench).
>
> Source intel: `attached_assets/Pasted-VILLAIN-protected-exe-Binary-12804-0-KB-Findings-28-Met_1779070578247.txt`
> Analysis summary: `artifacts/srt-lab/docs/villain-binary-intel.md`

---

## Ethics & Legal Caveats

**Read this section before any bench work.**

- This workflow is intended exclusively for **own-vehicle bench use** — ECUs you own
  or have written authorisation to test.
- The unpacked binary, any memory dumps, or any intermediate artefacts **must not
  be redistributed** under any circumstances. `VILLAIN_protected.exe` is proprietary
  IP; reproduction and distribution may violate copyright law and vehicle-security
  regulations in your jurisdiction.
- Working on production vehicles on a public road is out of scope. All ECU bench
  work must be performed on a **powered bench harness or a stationary, registered-out
  vehicle** in a controlled shop environment.
- Verify compliance with local laws (e.g. DMCA §1201 exemptions in the US, UK
  Computer Misuse Act) before proceeding with any reverse-engineering activity.
- The Phase 3 integration gate deliberately blocks promotion of any finding from
  this document into production code paths until independent bench verification
  passes. This gate must not be bypassed.

---

## Phase 1 — Unpack & Dump

### 1.1 Prerequisites

| Item | Notes |
|------|-------|
| Windows 10/11 VM | 64-bit, Hyper-V or VMware, **not** VirtualBox (too many VM fingerprints) |
| x64dbg (latest) | Free debugger; install the ScyllaHide and OllyDumpEx plugins |
| ScyllaHide plugin | Stealth anti-anti-debug layer; required to suppress PEB/IsDebuggerPresent checks |
| Import REConstructor (x64dbg edition) | Rebuilds the IAT after dumping |
| Process Hacker 2 | Memory map inspector; monitors allocation/protection changes |
| API Monitor | Optional; logs Win32 API calls from the target process |
| Isolated CAN harness | No live vehicle network; dummy load resistors on CANH/CANL are sufficient |
| Snapshot before each stage | Roll back the VM to a clean snapshot before each attempt |

#### Anti-VM Evasion Checklist (apply to VM before running target)

- Set CPU vendor string to `GenuineIntel` via CPUID spoofing (VMware: add
  `cpuid.1.ecx = "0000:0010:0000:0000:0000:0000:0000:0010"` to `.vmx`).
- Randomise the MAC address and remove VMware/VirtualBox NIC drivers.
- Set disk serial, BIOS strings, and SMBIOS model to realistic OEM values.
- Remove VMware Tools / Guest Additions.
- Confirm CPUID leaf `0x40000000` does not return a hypervisor signature
  (`0x40000000 EAX = 0x00000000` when queried from within the VM).

### 1.2 Step-by-Step Procedure

The third-party report describes a **three-stage unpacker**: Stage 1 (XOR decrypt
with a PEB-derived rotating key) → Stage 2 (custom LZ decompression) → Stage 3
(custom block cipher relocation). The following procedure mirrors that description.

**Step 1 — Baseline static scan**

1. Open `VILLAIN_protected.exe` in x64dbg *without* running it.
2. Check the PE headers: note the entry point RVA, section names, and import table
   size. A near-empty import table with only `VirtualAlloc`, `LoadLibraryA/W`, and
   `GetProcAddress` strongly suggests a custom packer.
3. Export a hex dump of the `.text` section for baseline comparison after unpacking.
4. Note the file SHA-256 for audit log entry (required by Phase 3 gate).

**Step 2 — Attach and start with ScyllaHide**

1. Attach ScyllaHide profile `aggressive` before running.
2. Set a breakpoint on `VirtualAlloc` and `VirtualProtect` via x64dbg's API
   breakpoint panel.
3. Run to the entry point stub.

**Step 3 — Stage 1 trace (XOR stub)**

1. After `VirtualAlloc` fires for the first time, note the allocated base address
   (call it `STAGE1_BASE`).
2. Set a hardware execute breakpoint at `STAGE1_BASE` (this triggers after the XOR
   decryption writes the Stage 1 payload and jumps into it).
3. When the BP fires, verify that `STAGE1_BASE` now contains a valid MZ/PE header
   or compressed blob header. If the header is absent, the decryption is incomplete
   — adjust the BP to trigger one allocation later.
4. **Abort criterion:** If `IsDebuggerPresent` is caught returning a non-zero value
   before Stage 1 jump, ScyllaHide is not cloaking correctly — restart with a
   hardware breakpoint set on `NtQueryInformationProcess` instead.

**Step 4 — Stage 2 trace (LZ decompression)**

1. Single-step or use a run-to-RET from `STAGE1_BASE` until a second
   `VirtualAlloc` + write sequence is observed.
2. Note the second allocated base (`STAGE2_BASE`). Set a hardware BP there.
3. When the BP fires, verify `STAGE2_BASE` contains recognisable x86/x64
   executable code (function prologues, `push rbp; mov rbp, rsp` etc.).
4. **Abort criterion:** If the code at `STAGE2_BASE` is still obfuscated or small
   (< 50 KB), more decompression stages remain — continue the pattern until the
   allocation contains a plausible executable image.

**Step 5 — Stage 3 trace (block-cipher relocation)**

1. After Stage 2, a final `VirtualAlloc`/`VirtualProtect(PAGE_EXECUTE_READWRITE)`
   sequence writes the actual application sections.
2. Note this final base (`OEP_BASE`). The OEP (original entry point) is typically
   near the start of the first executable section.
3. **Anti-dumping window:** The report states post-unpack integrity checksums run
   shortly after OEP. Set a hardware BP *at* OEP and dump immediately when it
   fires, before allowing execution to continue.
4. **Abort criterion:** If the dump is corrupted or contains junk sections, the
   binary is checking page hashes after decryption. In this case, trigger the dump
   one instruction earlier (at the JMP OEP from Stage 3) using a conditional
   breakpoint on `EIP == stage3_jmp_addr`.

**Step 6 — Memory dump**

1. With execution paused at OEP, use OllyDumpEx (from the x64dbg plugin panel):
   - Set OEP address to the current `EIP`/`RIP`.
   - Dump all readable + executable sections.
   - Save as `VILLAIN_unpacked_raw.bin`.
2. Run Import REConstructor against the dumped binary to rebuild the IAT.
3. Save the IAT-reconstructed dump as `VILLAIN_unpacked.exe`.

**Step 7 — Verification**

1. Open `VILLAIN_unpacked.exe` in x64dbg (without running).
2. Confirm the import table now lists recognisable DLLs (e.g. `kernel32.dll`,
   `user32.dll`, `setupapi.dll` for J2534 usage).
3. Search for ASCII strings `"0x27"`, `"SecurityAccess"`, `"Seed"`, `"CAN"` —
   at least one should be present if unpacking was successful.
4. Perform a second static SHA-256 hash of `VILLAIN_unpacked.exe` and record it
   in the audit log.

### 1.3 Artefacts to Capture

| Artefact | Description |
|----------|-------------|
| `VILLAIN_unpacked.exe` | IAT-reconstructed dump of the decrypted binary |
| OEP address (hex) | Recorded for reproducibility |
| Stage 1/2/3 base addresses | Memory layout for future reference |
| Pre/post dump SHA-256 hashes | Required by Phase 3 checklist |
| Session notes (date, VM config, x64dbg version) | Reproducibility record |

### 1.4 Success / Abort Criteria

| Criterion | Pass | Abort |
|-----------|------|-------|
| IAT reconstruction | ≥ 5 recognisable imported DLLs | 0 or 1 DLL (likely bad OEP) |
| String search | UDS/CAN strings present | No automotive strings found |
| Disassembly quality | Clean function prologues in IDA/Ghidra | Code is still virtualised (VM handlers) |
| File size ratio | Unpacked ≥ 3× packed (expected ~40 MB from 13 MB packed) | Ratio < 1.5× |

If any abort criterion fires, do not proceed to Phase 2. Document the failure,
roll back the VM snapshot, adjust the BP strategy, and re-run Phase 1.

---

## Phase 2 — Seed/Key Verification

### 2.1 Prerequisites

| Item | Notes |
|------|-------|
| Bench ECU (PCM or RFHUB) | One that responds to `0x27 0x61` requestSeed |
| J2534 PassThru device | Supported by the existing `tools/python-bridge/` daemon |
| SRT Lab running locally | For the UDS console or J2534 bridge tab |
| `@workspace/uds` builders | Available in `lib/uds/src/build.ts` |
| `bench-pairs.json` fixture | Located at `src/lib/_unverified/__tests__/bench-pairs.json` |

### 2.2 Capturing Real Seed/Key Pairs

Use the existing J2534 bridge and `@workspace/uds` frame builders to run a
seed/key exchange against a bench ECU.

**UDS frame sequence for `0x27 0x61`:**

```
1. DiagnosticSessionControl: 10 03          (extended session)
   Positive response:        50 03 xx xx xx xx

2. SecurityAccess requestSeed: 27 61
   Positive response:           67 61 S0 S1 S2 S3 S4 S5 S6 S7
                                       └─────── 8-byte seed ───┘

3. SecurityAccess sendKey: 27 62 K0 K1 K2 K3 K4 K5 K6 K7
                                   └──────── 8-byte key ────┘
   Positive response:      67 62      (access granted)
   Negative response:      7F 27 35   (NRC 0x35 = invalid key)
```

Using `@workspace/uds` builders (TypeScript/JS):

```js
import { build } from '@workspace/uds';

const sessFrame  = build.diagnosticSessionControl({ session: 0x03 });
const seedFrame  = build.securityAccess({ subFunction: 0x61 });
const keyFrame   = build.securityAccess({ subFunction: 0x62, data: keyBytes });
```

**Capture procedure:**

1. Send `10 03`, confirm positive response.
2. Send `27 61`, record the full 8-byte seed from the `67 61` response.
3. Run the candidate algorithm (`calculateSecurityKey_0x61` in
   `src/lib/_unverified/villain27_61.candidate.js`) against the captured seed.
4. Send `27 62 [computed key]`.
5. If `67 62` is received → **pair verified** (record seed + key in `bench-pairs.json`).
6. If `7F 27 35` is received → key was rejected. Do not record. Investigate.
7. After a rejected key, ECU will typically lock out for a cool-down period
   (usually 10–30 seconds or requires a session reset). Do not attempt more than
   3 consecutive wrong keys per session.

**Minimum pass bar:** ≥ 3 independent seed/key pairs round-trip cleanly (i.e.
produce `67 62` positive responses) before the algorithm is treated as verified.
"Independent" means different seeds captured in different sessions (ECU powered
off and on between captures to ensure fresh randomness).

### 2.3 Populating the Bench Fixture

After each verified pair, add an entry to
`src/lib/_unverified/__tests__/bench-pairs.json`:

```json
[
  {
    "seed": "A1B2C3D4E5F60708",
    "key":  "F1E2D3C4B5A69788",
    "date": "2026-01-15",
    "ecu":  "PCM 2019 Hellcat",
    "notes": "bench harness, no vehicle"
  }
]
```

Both `seed` and `key` are **uppercase hex strings, no spaces, 16 characters**
(8 bytes each). The test harness in
`src/lib/_unverified/__tests__/villain27_61.candidate.test.js` reads this file
and asserts the algorithm output matches the captured key for each entry. The
harness skips all fixture-driven tests when the array is empty, keeping CI green
until real pairs are captured.

### 2.4 S-box Extraction (Prerequisite for Full Verification)

Steps 1–4 of the algorithm (init, TempSeed permutation, 4-round mixer, CRC-16
XOR) can be tested for self-consistency without the S-box. However, the full
round-trip requires the 256-byte `FCA_SBox`.

After obtaining `VILLAIN_unpacked.exe` from Phase 1:

1. In Ghidra or IDA Pro, search the `.data` or `.rdata` section for a 256-byte
   block where each byte value from `0x00` to `0xFF` appears exactly once
   (permutation property). This is the hallmark of a bijective S-box.
2. If multiple candidates exist, narrow by cross-referencing the function that
   applies it — look for a tight loop of the form `Key[j] = SBox[Key[j]]`
   iterating 8 times over the key buffer.
3. Once identified, export the 256 bytes and replace the `FCA_SBOX_PLACEHOLDER`
   constant in `src/lib/_unverified/villain27_61.candidate.js`.
4. Re-run the self-consistency tests (`pnpm --filter @workspace/srt-lab run test
   src/lib/_unverified/__tests__/villain27_61.candidate.test.js`) to confirm
   the S-box wiring is correct.

---

## Phase 3 — Integration Gate

Before **any** finding from this workflow moves from the `_unverified/` quarantine
into `algos.js` or is surfaced in the seed calculator UI, every item on the
following checklist must be green. This gate requires both technical verification
and a peer-review sign-off.

### 3.1 Checklist

- [ ] **Bench pair count** — At least 3 independent seed/key pairs are recorded
      in `bench-pairs.json` and all pass the harness (`calculateSecurityKey_0x61`
      output === captured key for each entry).
- [ ] **S-box extracted** — The 256-byte `FCA_SBox` has been extracted from
      `VILLAIN_unpacked.exe` and replaces the placeholder in the candidate file.
      The placeholder comment must be absent from the promoted code.
- [ ] **Self-consistency tests pass** — All tests in
      `villain27_61.candidate.test.js` pass with zero skips (fixture is non-empty).
- [ ] **No accidental import** — Confirm the candidate file is still not imported
      by any file outside `_unverified/` (grep for `villain27_61` across the
      workspace).
- [ ] **Peer review** — At least one other person has read the candidate
      implementation and cross-checked it against the algorithm description in
      `villain-binary-intel.md §7.2`. Sign-off recorded in this document.
- [ ] **Audit log entry** — A new entry is added to the session log (or a
      hand-written bench log if offline) recording: date, ECU model, seed/key
      pairs tested, and operator name.
- [ ] **`algos.js` entry drafted** — The integration PR includes a new entry in
      `ALGOS` with `id: 'villain_0x61'`, gated behind a `ENABLE_VILLAIN_0x61`
      feature flag defaulting to `false`. The flag is not flipped true in the
      same PR.
- [ ] **Seed calculator wired (deferred)** — Surfacing in the seed calculator UI
      is a separate follow-up task, filed only after all items above are checked.

### 3.2 Peer Review Sign-Off Record

| Reviewer | Date | Notes |
|----------|------|-------|
| *(pending first bench run)* | — | — |

### 3.3 Promotion Steps (when gate passes)

1. Copy `villain27_61.candidate.js` → `src/lib/villain27_61.js` (remove the
   `_unverified/` path and the "UNVERIFIED" header comment).
2. Add the `ALGOS` entry in `algos.js` behind the feature flag.
3. Add the NRC/level routing note to `villain-binary-intel.md §8.1` (move the
   row from §8.2 gap table to §8.1 covered table).
4. Delete `src/lib/_unverified/villain27_61.candidate.js` and its test file
   (or leave the test file pointing at the promoted path — team preference).
5. Update `replit.md` to reflect the algorithm as verified.

---

## Related Documents

- `artifacts/srt-lab/docs/villain-binary-intel.md` — full VILLAIN intel reference
- `artifacts/srt-lab/src/lib/_unverified/README.md` — quarantine policy
- `artifacts/srt-lab/src/lib/_unverified/villain27_61.candidate.js` — candidate algorithm
- `artifacts/srt-lab/src/lib/_unverified/__tests__/villain27_61.candidate.test.js` — harness
- `artifacts/srt-lab/src/lib/_unverified/__tests__/bench-pairs.json` — fixture
- `artifacts/srt-lab/src/lib/algos.js` — production algorithm registry
- `artifacts/srt-lab/src/lib/crc.js` — `crc16ccitt()` used in Step 4
- `lib/uds/src/build.ts` — UDS frame builders for bench captures
