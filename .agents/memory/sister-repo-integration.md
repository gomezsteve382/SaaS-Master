---
name: Sister-repo file integration pattern
description: Rules for integrating generated data files from srt-lab-ultimate into this repo
---

## Rule

When adding new `.generated.js` files to `artifacts/srt-lab/src/lib/`, always run `pnpm sweep:assets` afterward. The asset-sweep sync test (`assetSweepSync.test.mjs`) compares the live file count in `attached_assets/` + `src/lib/` against a committed inventory.json — adding files without re-running the sweep causes that test to fail.

**Why:** The sweep walks both `attached_assets/` (5000+ files) and the generated lib outputs. Its inventory.json is committed and the test asserts no drift. Any file addition or removal changes the virtual-file count and triggers the assertion.

**How to apply:** After copying any batch of new files into `artifacts/srt-lab/src/lib/` (or `attached_assets/`), run `pnpm sweep:assets` before running the test suite.

## Sister-repo file selection rules

When importing from `srt-lab-ultimate` (the sister monorepo):

- **Skip** `bigMethodsVocabulary.generated.js` — 1.1 MB, bundle killer.
- **Keep local** for any JS file where local is larger: algos.js (809L), parseModule.js (1143L), crossValidate.js (183L), rfhPcmPair.js (574L), bridgeClient.js (200L), bridgeEngine.js (390L), jailbreakFeatures.js (388L), vin.js (67L), fileUtils.js (187L), obdEngine.js (307L), tabReferences.js (266L).
- **Keep local** `alfaobdData.generated.js` and `alfaobdAlgorithms.generated.js` — local has safety naming (`AOBD_W7_UNVERIFIED`) and audit corrections applied.
- **Copy freely** any `.generated.js` not already in the repo — they are static data files with no side effects.
- **Copy** `alfaobdStringDecrypt.js` and `alfaobdDbXorKey.js` — new helper libs not in the local repo.
