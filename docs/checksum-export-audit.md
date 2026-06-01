# Checksum & Security-Byte Export Audit (Task #1023)

## Why this exists

A "Sync all" run once exported an RFHUB whose SEC16 secret did **not** match the
BCM, wrote both files with the `_SYNCED` label, and reported success. Flashing
that pair desynchronises the immobilizer handshake — a brick risk. The success
report was the real defect: the export path applied the `_SYNCED` / `_CANONICAL`
labels and counted the run as a win **without ever verifying the bytes it was
about to ship were mutually consistent.**

This document audits **every** checksum / security-byte export path in
`artifacts/srt-lab` and records, for each, whether it is now protected.

## The shared gate

`artifacts/srt-lab/src/lib/exportSafetyGate.js` — `checkExportSafety(...)`.

It is the single pre-download choke point. Given the bytes that are about to be
written:

1. **Re-parses the outgoing bytes** with the real `parseModule` (not the
   in-flight engine state) — what is parsed is what will land on the chip.
2. **Per-file checksum self-checks** (`selfChecks`, default `['vin','partials','sec16']`):
   every VIN-slot CRC, every partial/tail VIN CRC, and every populated SEC16
   record checksum must re-derive correctly; the two SEC16 banks must agree.
3. **Cross-module rule engine** (`crossModule`, default `true`): runs
   `crossValidate` over the outgoing set **plus** any read-only `context`
   modules, so an RFH written from a BCM is checked against that BCM, etc.

Returns `{ ok, blocking[], warnings[], passed[], parsed[] }`. `formatBlockingMessage(verdict)`
renders the refusal. **No file is written unless `ok === true`.** Two knobs let
each call match what the operation actually touched:

- `crossModule: false` — VIN-only / virginize exports where a SEC16 mismatch is
  expected and is not this operation's concern.
- `selfChecks: ['vin','partials']` — VIN-only exports that must **not** refuse on
  a pre-existing SEC16 condition the export never created (e.g. a virgin RFH that
  still carries stale, invalid SEC16 records).

## Coverage matrix

Legend — **GATED**: routed through `checkExportSafety` before download — every
`.bin`-writing path is now gated. **VERIFIED**: a verbatim snapshot copy that
recomputes no checksum, so there is nothing for the gate to verify.

| # | Action (`doSync`) | Output label | Writes | Status | Gate config |
|---|---|---|---|---|---|
| 1 | `rfh-to-bcm` | `BCM_SYNCED` | BCM VIN ← RFH (+ optional RFH virginize) | **GATED** | `crossModule:false`, `selfChecks:['vin','partials']` |
| 2 | `bcm-to-rfh` | `RFH_SYNCED` | RFH VIN ← BCM | **GATED** | `crossModule:false`, `selfChecks:['vin','partials']` |
| 3 | `target-both` | `BCM_SYNCED` + `RFH_SYNCED` | BCM & RFH VIN | **GATED** | `crossModule:false`, `selfChecks:['vin','partials']` |
| 4 | `sync-all` | `BCM_SYNCED` + `RFH_SYNCED` + `PCM_SYNCED` | VIN all + SEC16 BCM←RFH + SEC6 PCM←RFH | **GATED** | `crossModule:!virginize` (full) |
| 5 | `sec16-only` | `BCM_SEC16_SYNCED` + `PCM_SEC6_SYNCED` | SEC16 BCM←RFH + SEC6 PCM←RFH | **GATED** | full, RFH as read-only `context` |
| 6 | `bcm-sec16-to-rfh` | `RFHUB_BCM_SEC16_SYNCED` | SEC16 RFH←BCM | **GATED** | full, BCM (master) as read-only `context` |
| 7 | `bcm-flat-from-resolved` | `BCM_FLAT40C9_REPAIRED` | flat 0x40C9 ← resolved split/mirror | **GATED** | `crossModule:false`; canonical → full `selfChecks`, legacy-flat → `['vin','partials']` (mirror1 intentionally clobbered) |
| 8 | `bcm-flat-from-resolved-both` | `..._CANONICAL` + `..._LEGACYFLAT` | both flat variants ← resolved secret | **GATED** | canonical copy full `selfChecks` (aborts both on fail); legacy copy `['vin','partials']` |
| 9 | `rekey-virgin-bcm` | `BCM_REKEYED` | SEC16 (split+mirror+flat) ← RFH, virgin BCM only | **GATED** | full, RFH as read-only `context` — verified reparse + `crossValidate` round-trip |
| 10 | `rekey-95640-from-rfh` | `EEP95640_REKEYED` | 95640 SEC16 + CRC16 ← RFH | **GATED** | shared gate `selfChecks:['vin']` + explicit `engParseEep95640` SEC16/CRC16 self-check (== `wr.sec16Hex`) |
| — | `doRestore` | `*_ORIGINAL` | verbatim pre-patch snapshot | VERIFIED | byte-for-byte snapshot; no checksum is recomputed, so there is nothing to verify |

### Notes on the GATED rows

- **#1 / #2 / #3** are VIN-only stamps (single module for #1/#2, both for #3).
  They never touch SEC16, so they gate `crossModule:false` with VIN-scoped
  `selfChecks` — the outgoing VIN-slot CRCs are verified before any `_SYNCED`
  download, but the gate does not refuse on the two modules' SEC16 secrets
  legitimately still differing (that is what the secret-sync paths are for, and a
  paired RFH may be virgin). #1's optional `virginize` co-emits a wiped
  `RFH_VIRGIN` file in the same gated set.
- **#7 / #8** repair the legacy flat `0x40C9` slice **from** the secret already
  resolved out of the live split/mirror records. The canonical copy leaves the
  split + mirror records intact, so it runs the **full** `selfChecks` (any VIN
  or SEC16 corruption refuses the download). The legacy-flat copy intentionally
  clobbers the mirror1 record on overlap dumps (the master split records stay
  valid), so a full SEC16 self-check would *correctly* but unhelpfully refuse a
  legitimate copy — it is therefore scoped to `['vin','partials']`. In the
  double-emit branch a failing canonical copy aborts **both** downloads, since
  the canonical is the vaulted source of truth.
- **#9 `rekey-virgin-bcm`** re-keys a *fully virgin* BCM (`bcmFullyVirgin`),
  creating the split/mirror SEC16 records from scratch off reverse(RFHUB SEC16).
  The freshly-written BCM is run back through the shared gate cross-module
  against the RFH `context`, so a re-key whose SEC16 does not actually mirror the
  RFH is refused instead of shipped `_REKEYED`. The reparse + `crossValidate`
  round-trip is pinned by a regression test (happy + secret-mismatch).
- **#10 `rekey-95640-from-rfh`** writes reverse(RFHUB SEC16) @0x838 + CRC16.
  `crossValidate` does not model the 95640↔RFH relationship, so the shared gate
  runs scoped to the (untouched) VIN slots while the meaningful SEC16 check is
  explicit: the written bytes are reparsed with `engParseEep95640` and the
  download is refused unless the stored CRC16 verifies **and** the SEC16 equals
  what the writer reported (`wr.sec16Hex`).

## Tests pinning this

- `src/lib/__tests__/exportSafetyGate.test.js`
  - **Golden round-trip**: real bench files driven through the actual export
    engine functions (`writeBcmSec16Gen2`, `writePcmSec6`, `runRfhBcmSync`) →
    gate returns `ok: true`.
  - **BCM-holds-secret mismatch regression**: a BCM carrying secret A paired
    with an RFH carrying secret B → gate returns `ok: false` with a blocking
    SEC16 mismatch message. This is the exact incident, frozen as a test.
- `src/lib/__tests__/checksum.realfiles.golden.test.js`
  - Checksum primitives pinned to **real** bench bins, not synthetic input:
    `crc16`, `crc8_42`, `crc8rf`, `crc8_65`, `rfhSec16Cs`, RFH Gen2 VIN check.
- `src/__tests__/moduleSyncGuidesAndReset.ui.test.jsx`
  - Drives a real `target-both` sync end-to-end; proves the VIN-only gate lets a
    secret-bearing BCM + virgin RFH through (it must not refuse on the RFH's
    pre-existing SEC16 state) while still verifying VIN-slot CRCs.

## Pinned golden vectors (canonical 6.2 Charger bench set)

These are the ground-truth values the checksum tests assert against (RFH SEC16
raw `816531F7CDE32E33C25A415C8440C72A`):

| Primitive | Value |
|---|---|
| RFH SEC16 slot checksum (`rfhSec16Cs`) | `0x6a00` |
| `crc8_65` | `0x6a` |
| `crc8_42` | `0xe4` |
| `crc8rf` | `0x26` |
| `crc16` (RFH SEC16 record) | `0xfe51` |
| RFH VIN (`2C3CDXCT1HH600000`) magic / sc | `0xde` / `0xe3` |
| BCM VIN CRC16 | `0x22d9` |
