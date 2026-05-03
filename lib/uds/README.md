# @workspace/uds

ISO 14229-1 (UDS) pure JavaScript/TypeScript library. Covers every standard service (0x10–0x87), all NRCs (0x10–0x93), typed frame builders, response parsers, standard DID catalog, and ISO-TP framing.

No I/O, no state — every function is a pure byte-in / byte-out transform.

---

## Installation (pnpm workspace)

```json
// package.json
{ "dependencies": { "@workspace/uds": "workspace:*" } }
```

---

## Worked Examples

### 1 — Read VIN

```ts
import { build, parse, dids } from '@workspace/uds';

// Build the 0x22 request frame
const request = build.readDataByIdentifier({ dids: [0xF190] });
// → Uint8Array [0x22, 0xF1, 0x90]

// After sending via your transport:
const response = parse.response(rawFrame);
if (!response.ok) {
  console.error('NRC:', response.nrcDescription);
} else {
  // payload starts after the SID byte (RDBI has no sub-function echo)
  const vinBytes = response.payload.slice(2); // skip DID echo (F1 90)
  const vin = dids.decodeDid(0xF190, vinBytes);
  console.log('VIN:', vin); // e.g. "1C3CDFBB7FD205999"
}
```

### 2 — Write VIN

```ts
import { build, parse } from '@workspace/uds';

const vinBytes = Array.from('1C3CDFBB7FD205999', c => c.charCodeAt(0));
const request = build.writeDataByIdentifier({ did: 0xF190, data: vinBytes });
// → Uint8Array [0x2E, 0xF1, 0x90, 0x31, 0x43, ...]

const response = parse.response(rawFrame);
if (response.ok && response.posRsp === 0x6E) {
  console.log('VIN written successfully');
}
```

### 3 — Extended Session + Security Access Seed/Key Handshake

```ts
import { build, parse, isSeedRequest } from '@workspace/uds';

// Step 1: enter extended diagnostic session
const sessFrame = build.diagnosticSessionControl({ session: 'extendedDiagnosticSession' });
// → [0x10, 0x03]
const sessResp = parse.response(await transport(sessFrame));

// Step 2: request seed (sub-function 0x01)
const seedReqFrame = build.securityAccess({ subFunction: 0x01 });
// → [0x27, 0x01]
const seedResp = parse.parseSecurityAccessSeedResponse(await transport(seedReqFrame));

if (!seedResp.ok) throw new Error('Seed request failed: NRC ' + seedResp.nrc?.toString(16));

// Step 3: compute key from seed using your algorithm
const seedBytes = Array.from(seedResp.seedBytes);
const keyBytes  = computeKey(seedBytes); // your CDA6/GPEC2/etc. algorithm

// Step 4: send key (sub-function 0x02)
const keyFrame = build.securityAccess({ subFunction: 0x02, data: keyBytes });
// → [0x27, 0x02, k0, k1, k2, k3]
const keyResp = parse.response(await transport(keyFrame));
if (!keyResp.ok) throw new Error('Security access denied: ' + keyResp.nrcDescription);
console.log('Module unlocked');
```

### 4 — Routine Control Start / Stop / Result

```ts
import { build, parse } from '@workspace/uds';

const PROXI_ALIGN = 0x0202;

// Start
const start = build.routineControl({ type: 'startRoutine', routineIdentifier: PROXI_ALIGN });
// → [0x31, 0x01, 0x02, 0x02]
const startResp = parse.parseRoutineControlResponse(await transport(start));
if (!startResp.ok) throw new Error('Routine start failed');

// Poll for result
const result = build.routineControl({ type: 'requestRoutineResults', routineIdentifier: PROXI_ALIGN });
const resultResp = parse.parseRoutineControlResponse(await transport(result));
console.log('Routine status:', Array.from(resultResp.statusRecord ?? []).map(b => b.toString(16)));

// Stop (if interruptable)
const stop = build.routineControl({ type: 'stopRoutine', routineIdentifier: PROXI_ALIGN });
await transport(stop);
```

### 5 — Request-Download → Transfer → Exit Flash Sequence

```ts
import { build, parse, segmentPayload } from '@workspace/uds';

const flashData = new Uint8Array(firmwareBuffer);
const FLASH_BASE = 0x08000000;

// 1. Request download
const reqDl = build.requestDownload({ address: FLASH_BASE, length: flashData.length });
const reqDlResp = parse.parseRequestDownloadResponse(await transport(reqDl));
if (!reqDlResp.ok) throw new Error('RequestDownload rejected');
const maxBlock = reqDlResp.maxBlockLength ?? 256;

// 2. Transfer data in maxBlock-sized chunks
let bsc = 1; // block sequence counter
for (let offset = 0; offset < flashData.length; offset += maxBlock - 2) {
  const chunk = flashData.slice(offset, offset + maxBlock - 2);
  const tdFrame = build.transferData({ blockSequenceCounter: bsc, data: chunk });
  // Split into ISO-TP CAN frames and send all frames
  const { frames } = segmentPayload(tdFrame, { padding: 0xCC });
  for (const canFrame of frames) await sendCanFrame(canFrame);
  // Read final response (your transport reassembles ISO-TP)
  const resp = parse.response(await receiveUdsResponse());
  if (!resp.ok) throw new Error(`Transfer block ${bsc} failed: NRC 0x${resp.nrc?.toString(16)}`);
  bsc = bsc >= 0xFF ? 0 : bsc + 1;
}

// 3. Request transfer exit
const exit = build.requestTransferExit();
const exitResp = parse.response(await transport(exit));
if (!exitResp.ok) throw new Error('Transfer exit failed');
console.log('Flash complete');
```

---

## API Reference

### `build.*` — Frame builders (all return `Uint8Array`)

| Function | SID | Description |
|---|---|---|
| `build.diagnosticSessionControl({ session })` | 0x10 | Open a diagnostic session |
| `build.ecuReset({ resetType })` | 0x11 | ECU reset (hard/soft/keyOffOn) |
| `build.securityAccess({ subFunction, data? })` | 0x27 | Seed request or key response |
| `build.communicationControl({ controlType, ... })` | 0x28 | Enable/disable Rx/Tx |
| `build.testerPresent({ subFunction? })` | 0x3E | Keep-alive |
| `build.accessTimingParameter({ subFunction, ... })` | 0x83 | Read or set P2/P2* timing |
| `build.controlDtcSetting({ dtcSettingType })` | 0x85 | Enable/disable DTC recording |
| `build.responseOnEvent({ subFunction, ... })` | 0x86 | Subscribe to ECU events |
| `build.linkControl({ subFunction, ... })` | 0x87 | Change CAN baud rate |
| `build.readDataByIdentifier({ dids })` | 0x22 | Read one or more DIDs |
| `build.readMemoryByAddress({ address, length })` | 0x23 | Raw memory read |
| `build.readScalingDataByIdentifier({ did })` | 0x24 | DID scaling data |
| `build.dynamicallyDefineDataIdentifier({ ... })` | 0x2C | Create/clear dynamic DIDs |
| `build.writeDataByIdentifier({ did, data })` | 0x2E | Write a DID |
| `build.writeMemoryByAddress({ address, data })` | 0x3D | Raw memory write |
| `build.clearDiagnosticInformation({ groupOfDtc? })` | 0x14 | Clear DTCs |
| `build.readDtcInformation({ subFunction, ... })` | 0x19 | Read DTC records |
| `build.inputOutputControlByIdentifier({ ... })` | 0x2F | I/O actuator control |
| `build.routineControl({ type, routineIdentifier })` | 0x31 | Start/stop/result routine |
| `build.requestDownload({ address, length })` | 0x34 | Initiate flash download |
| `build.requestUpload({ address, length })` | 0x35 | Initiate upload |
| `build.transferData({ blockSequenceCounter, data })` | 0x36 | Transfer a data block |
| `build.requestTransferExit()` | 0x37 | End data transfer |
| `build.requestFileTransfer({ ... })` | 0x38 | File-level transfer |

### `parse.*` — Response parsers

- `parse.response(frame)` → `ParsedResponse` — generic decoder for any UDS response
- `parse.parseReadDataByIdentifierResponse(frame, dids)` → `ReadDbiParsedResult`
- `parse.parseSecurityAccessSeedResponse(frame)` → `SecurityAccessSeedResult`
- `parse.parseRoutineControlResponse(frame)` → `RoutineControlParsedResult`
- `parse.parseRequestDownloadResponse(frame)` → `RequestDownloadParsedResult`

### `nrc.*` — NRC table

- `nrc.NRC_TABLE` — complete readonly array of all NRCEntry objects
- `nrc.nrcEntry(code)` — look up a specific NRC code
- `nrc.nrcDescription(code)` — formatted string with code + name + description
- `nrc.nrcIsPending(code)` — true for temporary/retry-appropriate NRCs

### `dids.*` — DID catalog

- `dids.DID_CATALOG` — readonly array of standard DID entries (0xF1xx block + common)
- `dids.didEntry(did)` — look up an entry by DID number
- `dids.decodeDid(did, data)` — decode raw bytes using the catalog entry's decoder

### `isotp.*` — ISO-TP (ISO 15765-2) framing

- `isotp.segmentPayload(payload, opts?)` — split a UDS payload into CAN frames (SF or FF+CFs)
- `isotp.encodeSingleFrame(payload, opts?)` — encode a Single Frame
- `isotp.encodeFirstFrame(payload, totalLength, opts?)` — encode the First Frame
- `isotp.encodeConsecutiveFrame(payload, sn, opts?)` — encode a Consecutive Frame
- `isotp.encodeFlowControl(args, opts?)` — encode a Flow Control frame
- `isotp.decodeFlowControl(frame)` → `DecodedFlowControl` — decode an FC frame

### Constants

- `sessions` — `{ defaultSession: 0x01, programmingSession: 0x02, ... }`
- `resetTypes` — `{ hardReset: 0x01, softReset: 0x03, ... }`
- `securityLevels` — `{ level1_requestSeed: 0x01, level1_sendKey: 0x02, ... }`
- `routineControlTypes` — `{ startRoutine: 0x01, stopRoutine: 0x02, ... }`
- `dtcStatusMask` — all DTC status bit flags
- `commCtrlTypes` — communication control type constants
- `ioControlParams` — `{ returnControlToECU: 0x00, shortTermAdjustment: 0x03, ... }`
