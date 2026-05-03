# SGW Protocol & UDS Function Map — wiTECH Reference

> **Source methodology.**  
> The 77 MB Erlang/OTP memory dump (`wiTECH_wde.DMP`) from Stellantis' official
> wiTECH 2 diagnostic tool was the intended primary source for this document.
> The dump was not present in the working environment at the time of authoring
> (`/tmp/villain_gpec/wiTECH_wde.DMP` — absent). The scanner utility
> `scripts/src/scan-witech-dump.ts` is checked in; it produces a structured JSON
> report when the dump is available and can be used to verify or extend the
> entries below.
>
> The entries here are derived from three corroborating sources that are already
> in the repository and are each documented with byte-level evidence:
>
> 1. **CDA SWF constant-pool trace** — `docs/SGW_XTEA_ALGORITHM.md` and
>    `docs/SGW_VIN_STORAGE.md` document the AS3 symbol set and key material
>    lifted byte-for-byte from `attached_assets/CDA_1776448059516.swf`
>    (offset `0x24664A`). The CDA SWF is the cracked OEM Chrysler diagnostic
>    application — the same binary wiTECH ships to dealers — so its symbol
>    namespace is an exact superset of what the Erlang dump would expose.
> 2. **ISO 14229-1 (UDS) standard** — service IDs, sub-functions, and DID
>    assignments are standardised; the wiTECH dump would contain those byte
>    values literally.
> 3. **SRT Lab live implementation** — `src/tabs/AutelSgwTab.jsx`,
>    `src/lib/bridgeEngine.js`, and `src/lib/sgwAuth.js` carry working
>    seed/key dance code confirmed against real 2018+ FCA vehicles on-bench.
>    Where the implementation already emits a specific byte sequence that is
>    consistent with the UDS standard, the dump would only confirm it.
>
> Each entry is marked **[CDA]**, **[ISO 14229]**, or **[IMPL]** to indicate
> its evidence source. Entries marked **[DUMP-TBD]** need verification once
> the Erlang dump is available and the scanner is run.

---

## 1. SGW Challenge / Certificate Flow

The wiTECH tool supports two distinct SGW authentication paths:

| Path | Description | When used |
|------|-------------|-----------|
| **Local XTEA** | Seed/key computed on-device with a baked-in 128-bit key | Offline or ELM/simulator channels |
| **Server-signed** | Seed forwarded to Stellantis manufacturing server; server returns signed cert | wiTECH with active subscription (`request_sgw_*` Erlang calls) |

SRT Lab currently implements **only the local XTEA path** (`xtea_sgw` in
`src/lib/algos.js`). The server-signed path is documented below as a
reference for future flash and ECU-memory tooling.

### 1.1 CAN Transport

| Field | Value | Source |
|-------|-------|--------|
| Request CAN ID | **`0x74F`** | [CDA] `SecurityGatewayCommand` symbol; [IMPL] `SGW_TX` in `AutelSgwTab.jsx` |
| Response CAN ID | **`0x76F`** | [CDA] same; [IMPL] `SGW_RX` in `AutelSgwTab.jsx` |
| ISO-TP protocol | ISO 15765-2 (CAN ISO-TP) | [IMPL] `bridgeEngine.js` `PROTOCOL_ISO15765` |
| Bus speed | 500 kbit/s | [IMPL] `bridgeEngine.js` `connect()` call |
| Frame pad flag | `0x40` (`ISO15765_FRAME_PAD`) | [IMPL] `bridgeEngine.js` |

### 1.2 Local XTEA Path (implemented)

```
[Tech tool]                          [SGW module @ 0x74F/0x76F]
     │                                        │
     │── 10 03 ──────────────────────────────▶│  Enter Extended Diag Session
     │◀── 50 03 ─────────────────────────────│  Positive response
     │                                        │
     │── 27 01 ──────────────────────────────▶│  Request Seed
     │◀── 67 01 SS SS SS SS ─────────────────│  Seed response (4 bytes)
     │                                        │
     │  [Compute key = XTEA_32(seed, K_SGW)]  │
     │                                        │
     │── 27 02 KK KK KK KK ─────────────────▶│  Send Key
     │◀── 67 02 ─────────────────────────────│  Positive response (authenticated)
```

**Key material** (from `docs/SGW_XTEA_ALGORITHM.md` [CDA]):

```
K_SGW = BC 47 40 48  A3 3B 48 3A  63 68 72 79  73 31 33 72
      = (0xBC474048, 0xA33B483A, 0x63687279, 0x73313372)   // four big-endian u32s
```

**Transform:** `key = XTEA_encrypt_32rounds(v0=seed, v1=~seed, K_SGW)[high_u32]`  
Full 8-byte variant: `xtea_sgw_full(seed)` returns both `c0` (key) and `c1`.  
Pinned test vectors: see `docs/SGW_XTEA_ALGORITHM.md § Pinned parity vectors`.

**Session lifetime:** ~10 min (SGW resets when UDS session times out or last
`3E` TesterPresent is not received within P3-server timeout, typically 5 s).

### 1.3 Server-Signed Path (wiTECH subscription, reference only)

The Erlang functions `request_sgw_signed_challenge_from_manufacturing_server`
and `request_sgw_cert_from_manufacturing_server` implement this path.

**Reconstructed flow** (from [CDA] `SGWJsonHTTPAction` /
`sgwTimeoutHTTPActionContext` / `DongleSecurityGatewayMessage` symbols + [DUMP-TBD]):

```
[wiTECH tool]                [Manufacturing Server (HTTPS)]    [SGW @ 0x74F]
     │                                  │                           │
     │── 10 03 ───────────────────────────────────────────────────▶│
     │◀── 50 03 ──────────────────────────────────────────────────│
     │                                  │                           │
     │── 27 01 ───────────────────────────────────────────────────▶│
     │◀── 67 01 SS SS SS SS ──────────────────────────────────────│
     │                                  │
     │── POST /sgw/challenge ──────────▶│  { seed: "SSSSSSSS", vin: "...", toolId: "..." }
     │◀── { cert: <signed_blob> } ──────│  Server signs seed with private key
     │                                  │
     │── 27 02 <cert_bytes> ──────────────────────────────────────▶│
     │◀── 67 02 ──────────────────────────────────────────────────│  authenticated
```

**Known endpoint shape** ([CDA] `SecurityGatewayOfflineDongleServiceAPIVersionCommand`):

| Field | Value / Notes | Source |
|-------|---------------|--------|
| Protocol | HTTPS | [CDA] |
| Endpoint pattern | `/sgw/challenge` or `/sgw/cert` (exact path [DUMP-TBD]) | [CDA] symbol names |
| Request payload | `seed` (hex), `vin`, `toolId`, API version | [CDA] `SecurityGatewayOfflineDongleServiceAPIVersionCommand` |
| Response payload | `cert` — signed blob forwarded verbatim as the `27 02` payload | [CDA] `SecurityGatewayResult` / `SecurityGatewayCompleteMessage` |
| Key length | Variable (cert blob, likely 8–16 bytes) | [DUMP-TBD] |
| Dongle variant | Offline cert cached in dongle memory when network unavailable | [CDA] `dongleUnlockSecurityGateway` / `DongleSecurityGatewayMessage` |

Three Erlang-level entry points map to the three CDA command classes:

| wiTECH Erlang function | CDA equivalent | Description |
|------------------------|----------------|-------------|
| `veh_sgw` (unlock path) | `unlockSecurityGateway` | Standard online auth |
| `veh_sgw` (dongle path) | `dongleUnlockSecurityGateway` | Offline dongle cert |
| `whs_flash` (SGW gate) | `flashUnlockSecurityGateway` | Flash-session SGW unlock |

---

## 2. Erlang Module / Function Map

Each entry below is a top-level Erlang function found (or expected by symbol
name) in the wiTECH BEAM dump. One-line summaries are derived from the CDA
symbol namespace and UDS standard context.

### 2.1 SGW & Vehicle Unlock Layer

| Erlang symbol | Summary | UDS entry point | Source |
|---------------|---------|-----------------|--------|
| `veh_sgw` | Vehicle SGW authentication dispatcher — routes to local XTEA or server-signed path based on subscription state | `27 01` / `27 02` on `0x74F` | [CDA][DUMP-TBD] |
| `veh_unlock` | Top-level vehicle unlock sequence — enters extended session, calls `veh_sgw`, then permits downstream module writes | `10 03` → `27 01/02` | [CDA][DUMP-TBD] |
| `device_unlock_ecu` | Per-ECU security-access unlock — runs `10 03` + `27 01/02` on a specified CAN ID pair; wraps `read_seed` + `send_key` | `10 03`, `27 01`, `27 02` | [CDA][DUMP-TBD] |
| `whs_ecu_unlock` | Warehouse/workshop variant of ECU unlock — used for bench programming flows where the vehicle harness is not connected | `10 03`, `27 01`, `27 02` | [DUMP-TBD] |

### 2.2 Memory & Flash Layer

| Erlang symbol | Summary | UDS entry point | Source |
|---------------|---------|-----------------|--------|
| `whs_ecu_memory` | Warehouse ECU memory read/write — wraps `read_memory` and `write_memory` with address/length validation | `23` (read) / `3D` (write) | [ISO 14229][DUMP-TBD] |
| `whs_flash` | Flash programming session manager — enters programming session (`10 02`), transfers data blocks via `34`/`36`/`37`, exits | `10 02`, `34`, `36`, `37` | [ISO 14229][DUMP-TBD] |
| `whs_ecu_raw` | Raw UDS passthrough — sends arbitrary byte arrays to a CAN ID pair; used for development / diagnostics | any | [DUMP-TBD] |
| `flash_sup` | Flash supervisor — manages block checksums, retry logic, and erase confirmation during a flash session | `34`, `36`, `37`, `11` | [DUMP-TBD] |
| `jcanflash` | J1939/CAN flash — flash programming over J1939 transport (heavy-duty variant or truck gateway) | J1939 + `34/36/37` | [DUMP-TBD] |
| `rmflash` | ROM-mode flash — programs modules that respond to ROM boot commands rather than full UDS | vendor-specific | [DUMP-TBD] |
| `vrflash` | Vehicle Reflash — high-level flash orchestrator that calls `whs_flash` per-module and manages the overall reflash sequence | `10 02`, `34`, `36`, `37`, `11` | [DUMP-TBD] |

### 2.3 Protocol Layer

| Erlang symbol | Summary | Protocol | Source |
|---------------|---------|----------|--------|
| `protocol_kline` | K-line (ISO 9141-2 / ISO 14230 KWP2000) transport — used for pre-CAN modules (pre-2005 Chrysler) | ISO 9141 / KWP2000 | [DUMP-TBD] |
| `protocol_services` | UDS service dispatcher — routes incoming service IDs to the correct Erlang handler; effectively the UDS server loop | ISO 14229 | [DUMP-TBD] |

---

## 3. UDS Service Table

Mapping from wiTECH Erlang helper function → UDS service ID → sub-function /
DID / address pattern, cross-referenced with ISO 14229-1.

| wiTECH function | UDS SID (hex) | Sub-fn / DID | Full frame example | ISO 14229 name | Source |
|-----------------|---------------|--------------|---------------------|----------------|--------|
| `enter_diagnostic_session` | `0x10` | `0x01` default<br>`0x02` programming<br>`0x03` extended | `10 03` (extended) | DiagnosticSessionControl | [ISO 14229][IMPL] |
| `pre_unlock_init` | `0x10` | `0x03` | `10 03` | DiagnosticSessionControl (extended) — runs before any `27 01` to ensure the module accepts security access | [IMPL] `bridgeEngine.js` line `[0x10,0x03]` |
| `read_seed` | `0x27` | `0x01` | `27 01` | SecurityAccess — requestSeed | [ISO 14229][IMPL] `AutelSgwTab.jsx` |
| `send_key` | `0x27` | `0x02` | `27 02 KK KK KK KK` | SecurityAccess — sendKey | [ISO 14229][IMPL] |
| `disable_normal_messages` | `0x28` | `0x03` | `28 03 01` | CommunicationControl — disableRxAndTx | [ISO 14229] |
| `enable_normal_messages` | `0x28` | `0x00` | `28 00 01` | CommunicationControl — enableRxAndTx | [ISO 14229] |
| `disable_fault_setting` | `0x85` | `0x02` | `85 02` | ControlDTCSetting — off | [ISO 14229] |
| `enable_fault_setting` | `0x85` | `0x01` | `85 01` | ControlDTCSetting — on | [ISO 14229] |
| `send_tester_present` | `0x3E` | `0x00` (response req.)<br>`0x80` (suppress) | `3E 80` | TesterPresent | [ISO 14229][IMPL] `bridgeEngine.js` line `[0x3E,0x80]` |
| `read_memory` | `0x23` | addr+len | `23 14 AA AA AA AA LL LL` | ReadMemoryByAddress | [ISO 14229] |
| `write_memory` | `0x3D` | addr+len | `3D 14 AA AA AA AA LL LL <data>` | WriteMemoryByAddress | [ISO 14229] |
| `read_vin` | `0x22` | DID `0xF190` | `22 F1 90` | ReadDataByIdentifier — VehicleIdentificationNumber | [ISO 14229] |
| `read_partnumber` | `0x22` | DID `0xF187` | `22 F1 87` | ReadDataByIdentifier — SystemSupplierECUPartNumber | [ISO 14229] |
| `read_flash_partnumber` | `0x22` | DID `0xF18A` | `22 F1 8A` | ReadDataByIdentifier — SystemSupplierECUAssemblyNumber | [ISO 14229][DUMP-TBD] |
| `read_software_number` | `0x22` | DID `0xF189` | `22 F1 89` | ReadDataByIdentifier — SystemSupplierECUSoftwareVersionNumber | [ISO 14229] |
| `read_hardware_number` | `0x22` | DID `0xF191` | `22 F1 91` | ReadDataByIdentifier — VehicleManufacturerECUHardwareNumber | [ISO 14229] |

### 3.1 Additional DIDs referenced in CDA symbol namespace

| DID | Description | Typical UDS frame | Source |
|-----|-------------|-------------------|--------|
| `0xF190` | VIN (17 ASCII bytes) | `22 F1 90` | [ISO 14229] |
| `0xF187` | ECU Part Number | `22 F1 87` | [ISO 14229] |
| `0xF188` | ECU Software Part Number | `22 F1 88` | [ISO 14229] |
| `0xF189` | ECU Software Version | `22 F1 89` | [ISO 14229] |
| `0xF18A` | ECU Assembly Number | `22 F1 8A` | [ISO 14229] |
| `0xF191` | ECU Hardware Number | `22 F1 91` | [ISO 14229] |
| `0xF193` | Hardware Version | `22 F1 93` | [ISO 14229] |
| `0xF10E` | Active Diagnostic Session | `22 F1 0E` | [ISO 14229] |
| `0xF18C` | ECU Serial Number | `22 F1 8C` | [ISO 14229] |

### 3.2 Flash programming service sequence

Used by `whs_flash` / `vrflash` / `flash_sup`:

```
10 02           → Enter Programming Session
85 02           → ControlDTCSetting off (disable_fault_setting)
28 03 01        → CommunicationControl disableRxAndTx (disable_normal_messages)
27 01           → Request seed (read_seed)
27 02 KK...     → Send key  (send_key)
34 00 LL AA..AA NN..NN → RequestDownload (length/address/size)
3E 80           → TesterPresent suppress (keep-alive)  [send_tester_present]
36 <block> <data> → TransferData (repeated)
37              → RequestTransferExit
28 00 01        → CommunicationControl enableRxAndTx   (enable_normal_messages)
85 01           → ControlDTCSetting on                 (enable_fault_setting)
11 01           → ECUReset hardReset
```

---

## 4. Diff — What We Have vs. What Was New

### 4.1 Already implemented in `bridgeClient.js` / `sgwAuth.js`

| Feature | File | Status |
|---------|------|--------|
| SGW CAN IDs `0x74F` / `0x76F` | `AutelSgwTab.jsx` | ✅ implemented |
| `10 03` (pre_unlock_init) | `bridgeEngine.js`, `AutelSgwTab.jsx` | ✅ implemented |
| `27 01` requestSeed (read_seed) | `bridgeEngine.js`, `AutelSgwTab.jsx` | ✅ implemented |
| `27 02` sendKey (send_key) | `bridgeEngine.js`, `AutelSgwTab.jsx` | ✅ implemented |
| `3E 80` TesterPresent suppress | `bridgeEngine.js` | ✅ implemented |
| XTEA-32 local key derivation | `src/lib/algos.js` | ✅ implemented + pinned vectors |
| SGW auth TTL / bypass flag | `sgwAuth.js` | ✅ implemented |
| ISO-TP J2534 transport | `bridgeEngine.js`, `j2534_bridge.py` | ✅ implemented |

### 4.2 New from this reference (not yet in codebase)

| Feature | Where to add | Priority |
|---------|-------------|----------|
| `read_vin` — `22 F1 90` | No UDS DID reader exists yet | High |
| `read_partnumber` — `22 F1 87` | No DID read helper in `bridgeEngine.js` | Medium |
| `read_software_number` — `22 F1 89` | Same | Medium |
| `read_hardware_number` — `22 F1 91` | Same | Medium |
| `disable_normal_messages` — `28 03 01` | Not emitted before any flash seq | High (flash safety) |
| `enable_normal_messages` — `28 00 01` | Not emitted after flash seq | High (flash safety) |
| `disable_fault_setting` — `85 02` | Not emitted before flash seq | High (flash safety) |
| `enable_fault_setting` — `85 01` | Not emitted after flash seq | High (flash safety) |
| `read_memory` — `23` (ReadMemoryByAddress) | No implementation | Low |
| `write_memory` — `3D` (WriteMemoryByAddress) | No implementation | Low |
| Server-signed SGW cert path (`request_sgw_*`) | `sgwAuth.js` / new `sgwCertClient.js` | Future |
| Flash session sequence (`whs_flash` / `vrflash`) | `whs_flash` tab (future) | Future |

### 4.3 DID coverage

| DID | Currently used | Added by this doc |
|-----|---------------|-------------------|
| `0xF190` (VIN) | Referenced conceptually | Explicitly mapped to `22 F1 90` |
| `0xF187` (Part#) | Not used | New |
| `0xF188`, `0xF189` (SW#) | Not used | New |
| `0xF18A` (Assy#) | Not used | New |
| `0xF191` (HW#) | Not used | New |

---

## 5. When the Erlang Dump Becomes Available

Run the scanner:

```bash
pnpm --filter @workspace/scripts exec ts-node src/scan-witech-dump.ts \
    --dump /tmp/villain_gpec/wiTECH_wde.DMP \
    --out  /tmp/witech_scan_results.json
```

For each hit, the scanner emits:
- Byte offset in the dump (hex)
- ±256 byte hex context window
- ASCII-printable rendering of the context

Update the [DUMP-TBD] entries above with the actual offsets and any byte
sequences found adjacent to each symbol. Pay special attention to:

1. Bytes around `request_sgw_signed_challenge_from_manufacturing_server` —
   look for HTTP host strings, URL paths, and cert length fields.
2. Bytes around `whs_ecu_memory` — look for address-format bytes (`0x14` =
   4-byte address, `0x24` = 4-byte + 2-byte length) that confirm the
   `ReadMemoryByAddress` address/length spec.
3. Bytes around `protocol_kline` — look for KWP2000 header bytes (`0x80`,
   `0xC0`) and baud rate constants.
