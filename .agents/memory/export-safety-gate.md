---
name: Export safety gate (pre-download)
description: How checkExportSafety guards ModuleSync checksum/secret exports and why VIN-only vs secret-write paths configure it differently.
---

# Export safety gate

`src/lib/exportSafetyGate.js` — `checkExportSafety({outgoing, context, crossModule, selfChecks})`
is the single pre-download choke point for ModuleSync exports. Reparses outgoing
bytes with `parseModule`, runs per-file checksum self-checks, then `crossValidate`
over outgoing+context. No download unless `ok===true`.

**Rule: configure the gate to match what the operation actually wrote.**
- VIN-only exports (e.g. `target-both`, `rfh-to-bcm`, `bcm-to-rfh`) must pass
  `crossModule:false` AND `selfChecks:['vin','partials']`. They never touch SEC16,
  so a full check false-refuses on a *pre-existing* SEC16 condition the export did
  not create — notably a "virgin" RFH that still carries stale, invalid SEC16
  records (blank≠true; csOk===false). This bit once: the moduleSyncGuidesAndReset
  UI test (secret-bearing BCM + virgin RFH target-both) broke until selfChecks was
  scoped to VIN only.
- Secret-writing exports (`sync-all`, `sec16-only`, `bcm-sec16-to-rfh`) use the
  full default checks. The module being *written from* goes in `context` (read-only),
  the written module in `outgoing`. `crossModule:!virginize`.

**Why:** the original brick incident — a `_SYNCED` RFH whose SEC16 didn't match the
BCM, shipped with a success report. The cross-module crossValidate pass is the real
defense; per-file checks are secondary and must not over-trigger on untouched fields.

**How to apply:** when adding/auditing an export path, decide which checksum
families it produces, gate only those, and put the authoritative/master module in
context. `bcm-sec16-to-rfh` is the symmetric twin of the incident (RFH←BCM secret).

Two edge cases worth remembering:
- **Legacy-flat repair intentionally clobbers a mirror record** (master split
  records stay valid). A full SEC16 self-check would *correctly* but unhelpfully
  refuse that copy, so legacy-flat exports must scope to `['vin','partials']`;
  only the canonical copy gets the full SEC16 check.
- **The 95640 BCM-backup chip is not cross-validated by `crossValidate`.** Route
  it through the gate scoped to VIN only, then verify its SEC16 explicitly with a
  reparse (CRC16 valid AND equals the writer's reported reversed secret) — a
  bare cross-module gate is vacuous for it.

Full path matrix lives in `docs/checksum-export-audit.md`.
