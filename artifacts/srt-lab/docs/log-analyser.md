# Log Analyser

> **Surfaces wired for live capture:** **SWARM** (`OBDSwarmDiagnostic.jsx` —
> rendered from the LIVE OBD tab) and **J2534 RAW CAN** (`J2534Scanner.jsx`)
> ship a `● START / ■ STOP / 📥 .log / 📜 OPEN IN ANALYSER` recorder card.
> The CDA6 SESSION tab also taps its bridge UDS pathway for convenience while
> running offline flashes. The Log Analyser tab itself consumes the in-memory
> hand-off via `consumeAnalyserHandoff()` on mount.

> **Catalog-growth output:** the Log Analyser renders a "GROW CATALOG FROM
> DIFF" panel with two actions:
> - **ACCEPT** — POSTs the proposals to `/api/bcm-catalog-proposals` which
>   upserts (by DID) into `artifacts/srt-lab/src/lib/bcmCatalogProposals.json`.
>   This file is the **only** sink. `bcmFeatureCatalog.generated.js` is
>   never touched automatically; promoting a queued proposal to the real
>   catalog is a deliberate human step.
> - **DOWNLOAD** — saves the same JSON locally as a fallback when the API
>   server is offline.


The **Log Analyser** tab (`📜 LOG ANALYSER`) ingests candump-format `.log`
captures, decodes the UDS sessions inside them, computes per-ID statistics,
and supports two-file diffing to grow the BCM proxi catalog.

It uses the `@workspace/uds` library exclusively — no vendored
third-party code. Format support is a clean re-implementation modelled on
the `reversegear` candump conventions; original credit to the SocketCAN
project for the on-the-wire log format.

## Supported file formats

The parser auto-detects every common candump line shape, including:

| Shape                                   | Example                                    |
|-----------------------------------------|--------------------------------------------|
| Compact, 11-bit ID                      | `(0001.000000) can0 7E0#0210010000000000`  |
| Compact, 29-bit ID                      | `(1.0) can0 18DAF110#022001`               |
| Bracket form, classical CAN             | `(1.0) can0 7E0   [8]  02 10 01 00 …`      |
| RTR frames                              | `(1.0) can0 7E0#R8`                        |
| CAN-FD with `##` and flags byte         | `(1.0) can0 123##100AABB…` (up to 64 B)    |
| Tab/space separators, blank/comment lines | (ignored)                                  |

Each frame is normalised into a `CandumpFrame { ts, iface, id, ext, fd, rtr, data, fdFlags }`.

## Workflow — four steps

1. **Load a `.log`** (drag-and-drop or browse). The tab parses every
   frame, builds a per-ID stat table (`count`, `firstTs`, `lastTs`,
   `dlcs`), and shows the top talkers.
2. **Decode UDS sessions.** ISO-TP reassembly groups frames into request /
   response transactions; each is decoded against the `@workspace/uds`
   service + NRC tables. Common request/response ID pairs (7E0/7E8 powertrain,
   714/F1A FCA BCM, 75F/767 RFHUB, plus generic OBD-II broadcast) are
   pre-recognised; unknown pairs are auto-suggested by traffic pattern.
3. **Diff two captures.** Drop a *baseline* `.log` and an *after* `.log`;
   the iddiff view highlights newly-seen IDs, dropped IDs, and per-ID
   payload deltas (single-bit toggles get a special call-out).
4. **GROW CATALOG FROM DIFF.** The wizard asks you to confirm which
   diff rows correspond to BCM proxi changes, then writes
   `bcmCatalogProposals.json` (download). The file is **not** auto-merged
   into `bcmFeatureCatalog.generated.js` — every proposal carries
   `notes: "Human review required before merging…"` and must be ground-truthed
   on the bench before promotion.

## Live recording

The tab exposes a **🎙 RECORD** button that wires into the
`useCanRecorder` hook from `src/lib/canRecorder.js`. It accepts handoffs
from any tab that publishes to the global slot
`window.__srtLabAnalyserHandoff = { text, name }` — currently the J2534
bench (`BenchTab`) and SWARM SGW recorder. Mounting the analyser tab
calls `consumeAnalyserHandoff()`, which clears the slot once consumed.

Off-line / headless capture is provided by the sibling Node CLI:

```bash
pnpm --filter @workspace/scripts run can-recorder \
  --out capture.log --bridge http://127.0.0.1:8765 \
  --iface can0 --duration 30
```

The CLI talks to the existing J2534 desktop bridge over its public HTTP
API (`POST /readmsg` — the canonical lowercase path used by the existing
repo bridge; `--poll <path>` overrides it for forks). It does **not** modify `tools/python-bridge/` in
any way — that folder is intentionally untouched per the project
constraint.

## Tests

`@workspace/uds` covers the candump parser/writer, ISO-TP reassembly,
session decoder, ID-stat aggregation, iddiff, and `bcmDiffToProposals`
naming heuristics in `lib/uds/src/__tests__/candump.test.ts`
(34 cases). The full lib/uds suite is 163 green; the srt-lab suite of
3458 + 153 tests stays green with the new tab registered.
