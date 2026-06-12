# Handoff to Manus — SRT Lab cleanup (11 stages)

Paste-ready instruction for Manus:

> From the **SaaS-Master** repo root, apply `srt-lab-cleanup-ALL.patch`:
> ```sh
> git am < srt-lab-cleanup-ALL.patch
> ```
> If `git am` hits a conflict (SaaS-Master changed since base `4a6a06d`):
> ```sh
> git am --abort
> git apply --3way srt-lab-cleanup-ALL.diff   # squashed fallback, no commit msgs
> ```
> Then run the test suite (`pnpm -r test` / vitest). New tests added:
> `marryModule.test.js`, `bcmSec16Resolve.equivalence.test.js`,
> and an updated `dealerLockoutBypass.test.js`.

Base commit these patches apply on top of: `4a6a06d` ("Add ECU catalog…").

## The 11 stages (in order)

1. **immoSecret.js** — one verified core for the SEC16 reversal / SEC6 slice
   (was copy-pasted in 9 files). Adds `deriveAllFromBcm` (BCM-as-source).
2. **Tab regroup** — the 51-tab drawer bucketed into 6 groups; closes a latent
   "uncategorized tab vanishes" bug. Front-page rail untouched.
3. **algoProvenance.js trust ledger** — honest grounding for all 43 algorithms
   (0 bench-verified, 21 extracted-unconfirmed, 22 unverified). Corrects
   overstated `VILLAIN confirmed` / `VILLAIN q2` hint strings.
4. **Dealer-lockout 0xFF00 gate** — that's the generic firmware-ERASE RID; it
   now refuses to transmit without `acknowledgeEraseRisk` (UI confirm).
5. **Provenance honesty** — `canflashAlgos` "BYTE-VERIFIED / identical to factory
   DLL" corrected (DLLs aren't in the repo); `tabReferences` labels downgraded.
6. **SeedTab confidence dots** — green/amber/red per algorithm from the ledger.
7. **marryModule() engine** — one derive→write→**re-parse-verify** path; blank
   source refused; unverified targets (Gen1/XC2268) need `allowUnverifiedTarget`.
8. **MarrySyncTab** — unified engine-backed tab; "Security Sync" rail now opens
   it; `SecuritySyncTab` + `BcmPcmPairingTab` merged in; `bcmpcmpair` redirected.
9. **TwinTab deprecated** — neutralizes the last writer that bypassed
   securityBytes (it was already dead/unwired).
10. **ModuleSync XC2268 gate** — the unverified XC2268 SEC16 write now requires
    an acknowledgement; every RFHUB SEC16 write logs its writer confidence.
11. **Engine resolver superset + delegation** — extracted `engParseBcm` to pure
    `engBcmParse.js`; an equivalence proof caught the engine MISSING the legacy
    2014 (0x00C8/0x00F0) BCM mirror (would have bricked 2014 LX BCMs); fixed
    `resolveBcmSec16` to handle it; delegated ModuleSync's BCM resolution to the
    engine on that proof; locked the equivalence in CI.

## What still needs YOU (not doable headless)
- **GPEC2A unlock patterns** — one Windows run of the unlocker → drop a
  locked+unlocked pair into `derive-gpec-patterns.mjs` → paste constants into
  `gpec2aUnlocker.js`. Activates the inert GPEC2A File-Unlock tab.
- **aemt.exe** — packed/encrypted; needs a runtime memory dump on Windows.
- **Bench seed→key captures** — the only thing that turns an amber/red
  confidence dot green.

## Safe to trust vs. flagged
- **Trust:** parseModule offsets, SEC16/SEC6/RFHUB-Gen2 writers, knownWorkingKeys,
  the Charger key-table formula, and the whole marry/parse path — bench-grounded.
- **Flagged (now labeled + gated, not silenced):** cda6, xtea_sgw, the canflash
  catalog, GPEC q2/q3/q4, dealerLockoutBypass, XC2268/Gen1 writers.
