# CDA Offline Flash, VIN Write, and Module Reset

This doc describes the **offline-flash mode** wired into the SRT Lab and how it
relates to the cracked Chrysler Diagnostic Application SWF re-mined under
`tools/cda-extractor/`.

## Source

- **SWF**: `attached_assets/CDA_1776448059516.swf` (CWS v11)
- **Inflated body**: 8,716,982 bytes
- **SHA-256 (inflated)**: `d8b08bd85cf1a7f83ac560dab1fdbfc50ada701e767e290229e66d9cc5c6560f`

The SWF is parsed by `tools/cda-extractor/src/extract.mjs`, which inflates the
CWS payload, walks every `DoABC` and `DefineBinaryData` tag, decodes the AS3
constant pool, and emits four deterministic JSON catalogs into
`tools/cda-extractor/out/`:

| Catalog | Purpose |
| --- | --- |
| `cdaFlashSequences.generated.json` | Per-module UDS programming sequence + preferred unlock algorithm |
| `cdaVinWrite.generated.json`       | VIN-write DID maps (default + per-module overrides) |
| `cdaResets.generated.json`         | UDS 0x11 sub-function map (hard / key-off / soft) |
| `harvestedStrings.generated.json`  | Curated AS3 string buckets used as provenance evidence |

Every catalog pins `_meta.sha256` of the inflated SWF body so the bench trace
test (`artifacts/srt-lab/src/lib/__tests__/cdaOfflineFlash.test.js`) can prove
the JSONs were generated from the canonical SWF and not hand-edited.

## Re-running the extractor

```bash
pnpm --filter @workspace/cda-extractor run extract        # write catalogs
pnpm --filter @workspace/cda-extractor run extract:check  # CI guard (drift)
```

If `attached_assets/CDA_1776448059516.swf` is missing, both modes exit `0`
with a warning so fresh checkouts are not blocked.

## Offline flash mode in the flasher state machine

`artifacts/srt-lab/src/lib/flasherStateMachine.js` exposes `flashEcuOffline()`
in addition to the existing `flashEcm()`. The offline variant is the same
state machine as `flashEcm()` but the UDS sequence is **driven by the catalog**
instead of being hand-coded:

```js
import { flashEcuOffline } from './flasherStateMachine.js';

const ctl = flashEcuOffline({
  engine,                 // any UDS engine (createBridgeEngine / createMicroPodEngine)
  moduleCode: 'BCM',      // → looks up tx/rx/unlockAlgo + sequence in cdaCatalog.js
  payload: calBytes,
  // optional: addr/eraseAddress/eraseLength/algoFn override the catalog defaults
});
const result = await ctl.start();
```

Internally `flashEcuOffline()` calls `getOfflineFlashModule(code)` from
`cdaCatalog.js` to resolve the address pair and unlock algorithm, then
delegates to `flashEcm()` with those values pre-populated. The catalog's
sequence is **structural documentation** — it pins the UDS phases the state
machine must walk, and the bench-trace test enforces that every required
phase (`session_extended`, `session_program`, `seed`, `key`, `erase`,
`request_download`, `transfer`, `transfer_exit`, `checksum`, `reset`) is
present per module.

## VIN write

`artifacts/srt-lab/src/lib/vinProgrammer.js` consults
`getOfflineVinDids(code)` from `cdaCatalog.js` to resolve the DID chain when
the row doesn't override it. The catalog confirms (via the SWF's localized
proxi-read string `"The Proxi String is read from the BCM using command
222023"`) that BCM's `0x6E2025` and RFHUB's `0x6E2027` extra mirrors are real
24-bit DIDs and not implementation guesses.

## Module reset

`flashEcuOffline()` looks up the reset variant via `getOfflineResetSub()`:

| Variant         | UDS  | Source string in SWF                                                          |
| --------------- | ---- | ----------------------------------------------------------------------------- |
| `hardReset`     | `11 01` | `hardReset` / `onGetAlignmentInformationResultForHardReset`               |
| `keyOffOnReset` | `11 02` | (implicit via `ResetECUCommand`)                                          |
| `softReset`     | `11 03` | `softReset` / `onGetAlignmentInformationResultForSoftReset`               |

## Transports

Two UDS engines feed the state machine:

1. `createBridgeEngine()` — Autel J2534 via the local `j2534_bridge.py`
   daemon. Used for SGW-required flashes.
2. `createMicroPodEngine()` — MicroPod II adapter stub (Task #599). The stub
   accepts the same `{ ok, d, raw }` UDS contract as the Autel bridge so the
   flasher state machine doesn't care which transport is wired in. The real
   USB I/O lives in the OEM driver and is intentionally out of scope here.

## Bench traces

Two complementary bench-trace tests pin the SWF mining:

- `cdaSwfSgwBenchTrace.test.js` — pins SGW VIN-storage **absence** (Task #457)
- `cdaOfflineFlash.test.js`     — pins the offline-flash / VIN-write / reset
  catalogs against a fresh re-extraction (Task #599)

Both tests skip cleanly when the SWF is missing.
