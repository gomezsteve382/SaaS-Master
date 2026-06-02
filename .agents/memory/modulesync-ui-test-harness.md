---
name: ModuleSync UI test harness
description: How to drive ModuleSync.jsx to bothReady in jsdom UI tests (file loading + fixtures).
---

# ModuleSync UI test harness

To reach `bothReady` in a ModuleSync UI test (which mounts the Sync Actions
card, the VIN sync buttons like "⬅ BCM VIN → RFH", and the virginize
checkbox), two non-obvious things must both be true:

1. **Use real-shape fixtures, not synthetic buildFixtures.** `engParseRfh`
   sets `ok = vin !== null` from its own reversed VIN offsets, and the BCM
   parser scans for slot markers. The `makeBcm` / `makeRfhubGen2` generators
   do NOT carry those markers, so they never reach `parsed.ok` and the
   workspace never flips to bothReady. Load real corpus fixtures from
   `artifacts/srt-lab/src/__tests__/fixtures/` instead, e.g. the matched
   pair `SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin` +
   `SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin` (same VIN → vinMatch).
   `moduleSyncGuidesAndReset.ui.test.jsx` is the canonical reference.

2. **Re-query the file inputs between the two sequential loads.** The
   DropZone reads each File via `await f.arrayBuffer()`. Loading the BCM
   first re-renders the workspace (the inspection panel mounts), which
   detaches the original `<input type=file>` nodes. A `querySelectorAll`
   NodeList captured before the first load is stale — firing change on its
   `[1]` does nothing. Wait for the BCM to land (e.g. `vehicle-family-select`
   appears), THEN re-query the inputs before loading the RFH.

**Why:** spent multiple iterations chasing a "button never appears" failure
that was actually a stale input-node reference + a fixture that never parsed.

**Also:** stub `URL.createObjectURL`/`revokeObjectURL` (jsdom lacks them) so
the download path doesn't throw mid-`doSync`. And a `queryByText` regex with
an alternation (e.g. `/Downloaded:|gate PASSED/`) can match two separate log
spans → "multiple elements" throw → `waitFor` timeout; match one unique line.
