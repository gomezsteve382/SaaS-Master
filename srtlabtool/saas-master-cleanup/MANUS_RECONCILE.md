# Manus reconciliation — engine substance vs. your own tab

Context: Manus already applied stages 1–7 and built its **own `MarryModuleTab`**.
My later stages add a `MarrySyncTab` + rewire `App.jsx`, so **the UI hunks in
stages 8 & 12 will conflict with your tree.** Don't `git am` the full combined
patch on top of your divergence — instead split it:

## 1. Apply the ENGINE/LIB substance (clean, no UI conflicts)
`MANUS-engine-substance.diff` contains only the new library/engine work since
stage 7 — no `MarrySyncTab`, no `App.jsx`, no `SeedTab`/`RfhubTab`:

```sh
git apply --3way MANUS-engine-substance.diff   # from SaaS-Master repo root
```
It touches:
- `lib/marryModule.js` — **`marryAll()`** (3-module marry: BCM → RFHUB + PCM,
  both from the BCM root, cross-synced, + the direct RFHUB↔PCM pass).
- `lib/parseModule.js` — **the 2014-BCM fix**: `resolveBcmSec16` now resolves
  the legacy `0x00C8/0x00F0` mirror (purely additive — only matches the exact
  `0x8F FF FF` + valid-CRC signature). **Do not skip this — without it the
  engine refuses real 2014 LX BCMs.**
- `lib/engBcmParse.js` — `engParseBcm` extracted to a pure, testable module.
- `tabs/ModuleSync.jsx` — re-export of the extracted parser, the XC2268
  unverified-write gate, delegation of BCM resolution to the engine, and the
  **Gen1 RFHUB SEC16 offset fix** (`engParseRfh` read `0x0226` = the key-table
  region; aligned to `0x00AE` where the writer + 3 other modules read/write).
  *(If your `ModuleSync.jsx` is unmodified base, this applies; if you changed
  it, take the hunks by hand — they're small and localized.)*
- new tests: `marryAll.test.js`, `bcmSec16Resolve.equivalence.test.js`,
  `rfhSec16Resolve.equivalence.test.js`.

## 2. PORT the UI (don't apply my tab hunks)
Wire these into **your `MarryModuleTab`** instead of applying `MarrySyncTab`:
- **Marry all 3 mode**: call `marryAll({ bcm, rfhub, pcm, vin, allowUnverifiedTarget })`,
  show per-target result + confidence, and zip the `result.files` with
  `fflate.zipSync` (`{ 'RFHUB_MARRIED.bin': bytes, 'PCM_MARRIED.bin': bytes }`).
- `result.ok && result.crossSync` ⇒ show "ALL IN SYNC".
- Unverified targets (Gen1/XC2268) return `ok:false` with a reason matching
  `/allowUnverifiedTarget/` — surface a checkbox that re-runs with
  `allowUnverifiedTarget:true`.

`MarrySyncTab.jsx` in my tree is a working reference for all of the above.

## 3. Stage D is DONE — stand down from standby
`marryAll()` IS the "Marry All 3" feature, with Manus's step-3 RFHUB↔PCM
verification included. No separate build needed.

## Verify
`pnpm -r test` (vitest). New/updated suites: `marryAll`, `bcmSec16Resolve.equivalence`,
`marryModule`, `dealerLockoutBypass`.
