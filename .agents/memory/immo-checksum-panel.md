---
name: Shared ImmoChecksumPanel workbench
description: One shared light-theme inspect→validate→edit ImmoVIN/checksum component driving BCM/ECM/RFHUB tabs via per-module adapters.
---

# Shared ImmoChecksumPanel

`components/ImmoChecksumPanel.jsx` is a presentational/controlled, model-driven
panel (header / analysis MiniCards / VIN table / security table / editing
fields+controls / status). Per-module adapters build the models and own state:
- `BcmImmoSection.jsx` (parseMpc5606bBcm/applyMpc5606bBcm) — VIN edit non-LOCKED, SEC16 edit FULL-mode only.
- `RfhubImmoSection.jsx` (XC2268 only via isXc2268Rfhub) — VIN edit only when size+variant supported; SEC16 mirrors READ-ONLY.
- `Gpec2aImmoPanel.jsx` (ECM tab) — renders through the shared panel too.

**Export gate:** `runGatedExport()` (exported from ImmoChecksumPanel) is the
single download path — runs checkExportSafety()+formatBlockingMessage() before
emitting any .bin. Scope `selfChecks` to what was written (VIN-only →
["vin","partials"]; +SEC16 → add "sec16").

**Intentional drifts (do not "fix" without re-checking tests/scope):**
- GPEC panel keeps its OWN ungated `dl()` (not runGatedExport) to preserve its strict existing tests.
- RFHUB SEC16 is read-only on purpose — chip/vehicle pairing stays on the RoutineControl 0x0401 key-prog flow, not this export path.

**Why:** consolidating three near-identical inspect/edit surfaces behind one
component keeps the light-theme look and the safety gate consistent; the two
drifts are deliberate scoping, not oversights.
