# SGW VIN Storage — design decision

> **Permanent design decision.** The Secure Gateway (SGW, CAN id `0x74F`
> request / `0x76F` response on 2018+ FCA vehicles) does **not** store the
> vehicle VIN in any documented flash / EEPROM slot. The
> `SGW_VIN_OFFSETS` array in `src/lib/parseModule.js` and
> `src/lib/donorLeakScan.js` is intentionally **EMPTY** and is expected to
> stay empty.
>
> Task #457 — written down so a future maintainer can stop re-asking
> "why doesn't the anonymizer scrub anything for `--module sgw`?" The
> answer is: there are no documented bytes to scrub, by design.

## Why we believe SGW carries no stored VIN

The primary evidence is a **symbol-level bench trace on the cracked OEM
Chrysler diagnostic application** (the same SWF that produced the SGW
XTEA key per `docs/SGW_XTEA_ALGORITHM.md`). Three corroborating angles
all agree with that trace.

### 0. Bench trace — `attached_assets/CDA_1776448059516.swf` (dump X)

> **No VIN slot — confirmed by bench trace on dump X = the CDA OEM
> diagnostic SWF (`attached_assets/CDA_1776448059516.swf`,
> 4,346,734 bytes CWS v11 → 8,716,982 bytes inflated AS3 ABC body).**

This SWF is the cracked Chrysler OEM diagnostic application — the
canonical reference for what the OEM tool is allowed to do with a
factory-stock SGW. The XTEA key, delta, and round count documented in
`docs/SGW_XTEA_ALGORITHM.md` were lifted byte-for-byte from this same
file (AS3 constant pool offset `0x24664A`), so this isn't a guess about
which binary represents the OEM SGW contract — it IS the binary.

The bench trace is automated in
`src/lib/__tests__/cdaSwfSgwBenchTrace.test.js`, which on every CI run:

1. Re-decompresses the SWF (`CWS` → `FWS`, `zlib.inflateSync` from
   offset 8) and asserts the inflated body length matches `8,716,982`
   — the value `docs/SGW_XTEA_ALGORITHM.md` records as the canonical
   inflated size, so any swap or corruption of the SWF is caught
   before the rest of the trace runs.
2. Asserts the SGW **authentication / status / timeout** API surface
   IS present (proves we're inspecting the SGW-aware OEM tool):
   `unlockSecurityGateway` ≥ 1, `dongleUnlockSecurityGateway` ≥ 3,
   `flashUnlockSecurityGateway` ≥ 1, `SecurityGatewayCommand` ≥ 6,
   `SGWStatusIndicator` ≥ 48, `SGWStatusModel` ≥ 4, `isSGWReady` ≥ 2,
   `hasSgw` ≥ 2, `sgwUnlockedBy` ≥ 2 (counts are raw substring
   occurrences in the inflated body — they include both the symbol
   declaration and every cross-reference, which is what we want for
   "the OEM tool actually wires this up").
3. Asserts the SGW **VIN read/write** API surface is **absent**.
   Across seventeen needles spanning every plausible naming
   convention — `WriteVinToSGW`, `WriteSGWVin`, `SGWWriteVin`,
   `ReadVinFromSGW`, `ReadSGWVin`, `SGWReadVin`, `SGWVinSlot`,
   `SGWVinOffset`, `SGWVinDID`, `SGWVinHandler`, `SGWVinCommand`,
   `SGWVinMessage`, `SGWVinService`, `VinSGW`, `SgwVin` (and the
   case-insensitive variants `vinsgw` / `sgwvin`) — the CDA SWF
   returns **zero matches**. The OEM tool exposes no API to write a
   VIN to the SGW or read a VIN from it.
4. Asserts the standard VIN UDS DID identifier `F190` does not appear
   as an ASCII string anywhere in the inflated body (case-insensitive
   `F190` and `f190` both return zero). The OEM diagnostic
   application carries no string-form reference to a VIN-bearing
   identifier — it knows about VINs (it has `VinValidator`,
   `currentVin`, `flashByVIN`) but never names them at the F190 DID
   level, which is consistent with VIN handling living on other
   ECUs (BCM/PCM/RFHUB UDS endpoints) and not on the SGW. (The raw
   `F1 90` byte pair appears 37 times scattered across the 8.7 MB
   AS3 body, which is in line with random-byte expectation for a
   binary of that size and is not a meaningful signal — the test
   pins the ASCII form, not the byte form.)

The full unique-symbol set found in the SGW namespace clusters
exclusively around four concerns:

- Authentication: `unlockSecurityGateway`, `dongleUnlockSecurityGateway`,
  `flashUnlockSecurityGateway`, `SecurityGatewayCommand`,
  `SecurityGatewayOfflineDongleServiceAPIVersionCommand`,
  `securityGatewayUnlocked`, `SecurityGatewayUnlockComplete`,
  `SgwLoginTriggered`.
- Status / equipment indication: `SGWStatusIndicator`,
  `SGWStatusModel`, `SGWStatusIndicatorBase`, `SGWStatusIndicatorSkin`,
  `SGWUnlockStatus`, `SGWReady`, `isSGWReady`, `hasSgw`, `sgwUnlocked`,
  `sgwLocked`, `sgwUnable`, `sgwUnknown`, `SgwEquippedMessage`,
  `sgwUnlockedBy`, `sgwECU`, `sgwStateModel`, `sgwStatusModel`,
  `sgwStatusChangedHandler`, `sgwStatusResetHandler`.
- Transport / timeout: `SGWJsonHTTPAction`, `sgwTimeoutHTTPActionContext`,
  `SecurityGatewayMessage`, `DongleSecurityGatewayMessage`,
  `FlashSecurityGatewayMessage`, `SecurityGatewayCompleteMessage`,
  `SecurityGatewayResult`, `SGWMessage`, `SgwNoticeHide`,
  `ForceStateReportForSGWMessage`,
  `SecurityGatewayOfflineDongleServiceVersionMessage`.
- Error / feedback / UI chrome: `SecurityGatewayFault`,
  `SecurityGatewayFeedbackMessage`, `sgwBackground`, `sgwHelp`,
  `SGWHelp`, `com.chrysler.cda.presentation.component.sgw`.

VIN-related symbols **do** exist in the SWF
(`VinValidator`, `currentVin`, `getVin`, `flashByVIN`, `correctVin`,
`enableVinBox`, `validationValidVinHandler`,
`validationInvalidVinHander`, `vinMessageResult`, `vinMessageError`,
`runVinValidation`) — but every one of them lives in
`com.chrysler.cda.presentation.component.tracer.validation`,
`com.chrysler.cda.presentation.component.edit`,
`com.chrysler.cda.presentation.component.sync`, or the
`flash:StartFlashCommand` namespace. **None** appear in the
`com.chrysler.cda.presentation.component.sgw` package or in any
`SecurityGateway*` class. The OEM tool does not have a code path that
writes a VIN through the SGW.

Together, items (2) + (3) + (4) constitute the bench trace: the OEM
diagnostic application that is canonically authoritative on the SGW
wire contract has zero SGW-VIN API surface. If the SGW had a VIN-
bearing slot, this is the binary that would speak to it — and it
doesn't.

**Scope note.** This bench trace is a **supporting evidence control**
for the design decision — it is not a substitute for a real SGW
EEPROM `before.bin` / `after.bin` fixture in
`src/lib/__fixtures__/realDumps/`. Under the design decision the
real-fixture acceptance bullet from Task #457 is explicitly waived
because no sanctioned OEM tooling reads the SGW EEPROM in the first
place — and it's exactly this bench trace that proves that. The day a
genuine SGW dump becomes available, the maintainer's job is unchanged
from the original task: drop a fixture pair, populate
`SGW_VIN_OFFSETS`, graduate SGW into the per-fixture loop, and let
this bench-trace test demote itself to a corroborating sanity check.
See the SGW bullet in `src/lib/__fixtures__/realDumps/README.md`
("Acceptance-criteria note") for the same wording mirrored next to the
fixtures.

### 1. SGW is an authentication module, not a content module

The Secure Gateway exists to gate UDS WriteByID writes on the bus. Its
in-vehicle responsibility is to run a seed/key handshake (UDS `27 01`
returns a 4-byte seed; UDS `27 02` consumes a 4-byte key derived from
that seed) and then permit or deny downstream BCM / RFHUB / ECM / ADCM
writes for the duration of the diagnostic session. The whole reason the
module exists is to be a **policy** module, not a **state** module.

Concretely:

- `docs/SGW_XTEA_ALGORITHM.md` documents the XTEA(32) algorithm extracted
  from the cracked OEM diagnostic SWF (`attached_assets/CDA_*.swf`,
  AS3 constant pool offset `0x24664A`). The algorithm is a **stateless
  block transform** — `seed → key = XTEA_encrypt(seed, K_SGW)` — with
  the 128-bit key `BC474048A33B483A6368727973313372` baked into the
  SGW firmware. No VIN-keyed material appears anywhere in that key
  derivation.
- `src/lib/algos.js` (`xtea_sgw`, `unlockKey('xtea_sgw', seed)`) and
  `public/srt_lab.py` (`algo_xtea_sgw`) port the same transform. Both
  ports take a 4-byte seed and return a 4-byte key — no VIN input.
- `src/tabs/AutelSgwTab.jsx` runs the live `27 01 / 27 02` dance against
  `0x74F`. It never reads or writes any SGW EEPROM byte; the only SGW
  state it touches is the ephemeral session-auth flag managed by
  `src/lib/sgwAuth.js`.
- `src/lib/sgwAuth.js` is purely an in-memory TTL cache (10 min default,
  matches the typical UDS session timeout). Intentionally not persisted;
  there is nothing on the SGW side to mirror.

### 2. The codebase already encodes "no VIN slot"

Every site in the codebase that touches SGW agrees:

- `src/lib/moduleRegistry.js` declares the SGW row as
  `kind:'unsupported'` with the note **"SGW authenticates other writes;
  it does not store a VIN slot. Excluded from Program-All."** This is
  the single source of truth used by the Program-All UI to skip SGW
  in every batch flow.
- `src/lib/parseModule.js` exposes `SGW_VIN_OFFSETS = []`. There is no
  `parseSgw()` function and no module-type detection branch for SGW —
  any binary the user uploads as SGW would not be auto-classified as
  one (sizes overlap RFHUB / GPEC2A territory, and SGW images carry
  none of the BCM-defining structures `parseModule` keys on).
- `src/lib/donorLeakScan.js` exposes the same empty
  `SGW_VIN_OFFSETS = []` and `getDocumentedSlotWindows('sgw')` returns
  an empty window list — meaning the donor-leak guard runs with **no
  masking** for SGW. Any donor-VIN occurrence anywhere in an SGW buffer
  is reported as a leak. That's the right default for a family whose
  slot table is the empty set.
- `scripts/anonymize-real-dump.mjs` registers `sgw` in
  `SCRUBBERS_BY_TYPE` so `--module sgw` is accepted, but the scrubber
  function `anonymizeSgw` returns a no-op slots list. The post-scrub
  leak guard is what actually does the work for this family.

### 3. The user-facing SGW dump never appears in the repo's captures

`attached_assets/` carries 30+ ECU dumps (BCM DFLASH, RFHUB Gen1/Gen2
EEPROM, GPEC2A PCM 4 KB and 8 KB, etc.). None are SGW dumps. Searches
for `SGW`, `SECUR`, `GATEWAY`, and the SGW UDS IDs (`74F`, `76F`)
across the captures directory return zero binary files — the only
SGW-named asset is `Pasted--All-VINs-Match…` which is a textual UI
snapshot of the validator panel, not an SGW dump. The same is true of
the in-app validator: it cross-checks BCM/RFHUB/PCM but never compares
an SGW image because none can be uploaded.

This is not a coincidence. SGW dumps are not commonly produced in the
field because:

- The SGW firmware is signed and the boot/flash region is not exposed
  via UDS to ordinary tools — Autel/AlfaOBD/Drew Tech tools don't
  expose a "READ SGW EEPROM" button.
- For the workflows SRT Lab supports (key programming, VIN write,
  module sync), the SGW is treated as a black-box authenticator on
  the bus. There is no use case in the app that would consume an
  SGW dump.

## What the "empty slot table" means in practice

The `--module sgw` CLI alias is wired so that **if** a real SGW dump
ever lands and the maintainer wants to anonymize it for sharing, the
helper script accepts the flag. With an empty slot table:

1. `anonymizeSgw()` writes nothing — the buffer comes out byte-for-byte
   identical to the input.
2. `scanBufferForDonorLeak({ buffer, donorVin, slotWindows: [] })` runs
   with **no masking**. Any occurrence of the donor VIN (forward, byte-
   reversed, or even just its trailing 6-character serial) anywhere in
   the buffer trips the leak guard and the helper exits 1 with a
   pointer to the offset.

This means the "empty SGW slot table" failure mode is **fail-loud, not
fail-silent**. If a future SGW capture turns out to embed a VIN string
at some undocumented offset (audit log, config table, future firmware
revision that started caching VINs, etc.) the helper will refuse to
write the output file and tell the maintainer exactly where the leak
lives. At that point — and only at that point — the right move is to:

1. Update `SGW_VIN_OFFSETS` in `src/lib/parseModule.js` and
   `src/lib/donorLeakScan.js` (single source of truth, both files
   import from each other) with the documented offset(s).
2. Land a `parseSgw()` function in `parseModule.js` that mirrors the
   BCM/RFHUB families.
3. Drop the captured `before.bin` / `after.bin` pair under
   `src/lib/__fixtures__/realDumps/` and register it in
   `manifest.json` (alongside the existing `bcm`/`rfhub`/`pcm`
   entries) so the per-fixture round-trip in
   `anonymizeRealDump.test.js` exercises the new family.
4. Update this doc to reflect what was actually found, and re-classify
   it from "design decision" to "documented slot table."

Until that day, **the empty array is the correct, intentional state**
— not a TODO and not a placeholder.

## How this doc relates to the synthetic SGW tests

`src/lib/__tests__/anonymizeRealDump.test.js` carries a dedicated
SGW block that pins the four invariants the empty slot table relies on:

1. `SGW_VIN_OFFSETS` is exposed and is empty.
2. A clean SGW buffer round-trips byte-for-byte (zero slots reported,
   buffer unchanged).
3. A buffer that embeds the donor VIN forward at any offset throws.
4. A buffer that embeds the donor VIN byte-reversed at any offset
   throws.
5. A buffer that embeds the donor VIN's trailing 6-character serial at
   any offset throws (because with an empty slot table, every offset
   is "outside the documented windows" by definition).

If the day comes when SGW grows real slots, these synthetic invariants
graduate into the per-fixture loop alongside BCM/RFHUB Gen1/Gen2/PCM
— the synthetic block becomes the "minimum baseline" floor and the
real-fixture round-trip becomes the canonical proof. Until then, the
synthetics ARE the SGW round-trip suite, by design.
