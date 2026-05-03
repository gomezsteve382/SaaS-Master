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

Three complementary bench-trace tests pin the SWF mining:

- `cdaSwfSgwBenchTrace.test.js` — pins SGW VIN-storage **absence** (Task #457)
- `cdaOfflineFlash.test.js`     — pins the offline-flash / VIN-write / reset
  catalogs against a fresh re-extraction (Task #599)
- `cdaSuperMine.test.js`        — pins the SUPER-MINE catalogs (SID/DID/routine
  indexes, Commands/Events/Endpoints/Localization catalogs) against a fresh
  re-extraction. Locks the floor for `0x10` SID refs (≥20), the ceiling for
  `0x83/0x85/0x86/0x87` SID refs (==0, architectural fact), the presence of
  known command classes, and the small ceilings on DID/routine catalogs that
  prove the hot-class scoping is still in effect.

All three tests skip cleanly when the SWF is missing.

## SUPER-MINE — what the deep AS3 ABC mine produces

`tools/cda-extractor/src/extract.mjs` does not stop at string scraping. It
parses every `DoABC` tag's full ABC structure (constant pools, methods,
instances, classes, scripts, method bodies) and **disassembles the AVM2
opcode stream** of every method body, recording every push-constant
(bytes / shorts / ints / uints / strings / call-target multinames) and the
class that owns each method.

The output is partitioned by a **HOT class flag** that marks the diagnostic /
flash / unlock / proxi / authenticatedDiagnostics / `*Command` /  `*Message` /
`*Event` class trees. The downstream catalogs are **scoped to HOT classes
only**, which avoids the large false-positive rate the unscoped variant
produced (e.g. 274 refs to `0x10` from `RuntimeDPIProvider` and image-watcher
utilities pushing the byte 16 for unrelated reasons).

| Catalog file                          | What it pins                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `cdaUdsByClass.generated.json`        | Per-AS3-class push-constant inventory (every method, every byte/short/int/string/call). The raw substrate every other catalog is built from. |
| `cdaSidIndex.generated.json`          | UDS SID → list of HOT class+method pairs that push that byte, with co-pushed bytes (likely sub-functions).                                    |
| `cdaDidIndex.generated.json`          | UDS DID-shaped values pushed inside HOT classes. Tiny on purpose — DIDs are composed in the native MVCI layer, not in AS3.                    |
| `cdaRoutineIndex.generated.json`      | Routine IDs pushed inside HOT classes whose name matches `Routine|Flash|Erase|Checksum|Proxi|Align|Reset|Memory|StartFlash|GetFlash`.        |
| `cdaCommands.generated.json`          | Every `*Command` / `*Message` / `*Event` class with its observer methods, `on*` event names, REST paths, and dotted localization keys.       |
| `cdaEvents.generated.json`            | Every `on*` callback name in HOT classes → list of HOT classes that mention it. Approximates the SWF call graph.                              |
| `cdaEndpoints.generated.json`         | Every `vehicle/`, `service/`, `cda/`, `flash/`, `diagnostic/`, `rest/`, `api/` URL path string in HOT classes.                                |
| `cdaLocalizationKeys.generated.json`  | Every dotted lower-case localization bundle key in HOT classes.                                                                               |
| `cdaBinaryData.generated.json`        | Inventory of every `DefineBinaryData` tag (id, length, sha256(16) prefix, head hex, ASCII snippets).                                          |

### Findings recorded by the super-mine (and why they are findings, not gaps)

- The SWF authors **only the lower UDS SIDs** (0x10, 0x11, 0x14, 0x19, 0x22,
  0x27, 0x2E, 0x31, 0x34, 0x36, 0x37, 0x3E and friends) as raw bytes. SIDs
  `0x83 / 0x85 / 0x86 / 0x87` show **0 refs** — they live in the native MVCI /
  J2534 layer that the SWF talks to over HTTP/IPC. The super-mine test pins
  this `==0` so any future regression that re-includes cold framework classes
  fails loudly.
- The DID and routine catalogs are intentionally tiny (single digits). DIDs
  and routine IDs are composed at runtime by the native layer; the SWF UI
  passes them as strings or builds them from configuration, not as AS3
  literal constants. The super-mine test pins small ceilings (`<50` each)
  to prove the hot-class scoping is doing its job.
- The SWF's REST surface to the local helper service is **tiny** — only one
  path (`vehicle/flash/start/`) appears as an AS3 string constant. The rest
  of the wire protocol is built up dynamically and could only be recovered
  from a live network capture.
- The 9 `DefineBinaryData` tags (~12 KB total) are all blend-mode shader and
  text-layout helpers — **no diagnostic content** is shipped inline in the
  SWF. Flash payloads, seed/key tables, and DID dictionaries all live
  outside the SWF.

### Re-running the super-mine

```bash
node tools/cda-extractor/src/extract.mjs
pnpm --filter @workspace/srt-lab exec vitest run cdaSuperMine cdaOfflineFlash
```
