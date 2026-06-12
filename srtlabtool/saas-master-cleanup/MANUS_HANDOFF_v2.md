# Manus handoff v2 — full update (20 stages)

Manus last synced at **stage 7** (marryModule engine) and built its **own
`MarryModuleTab`**. This brings it current through **stage 20**.

## Apply (conflict-free)
`MANUS-update.diff` = everything since stage 7 **except** the two files that
collide with your own tab. From the **SaaS-Master** repo root:

```sh
git apply --3way MANUS-update.diff
pnpm -r test
```

It touches 20 files — all lib/engine + ModuleSync/KeyProgTab/Gpec2aImmoPanel/
TwinTab logic + 9 new/updated tests. None of it is your MarryModuleTab.

## Port by hand (your tab diverged — do NOT apply these)
- **`tabs/MarrySyncTab.jsx`** (new) and **`App.jsx`** (the `secsync`→engine-tab
  swap + `bcmpcmpair` redirect). Wire the equivalent into your `MarryModuleTab`:
  - **`marryAll({ bcm, rfhub, pcm, vin, allowUnverifiedTarget })`** for the
    "Marry all 3" mode; zip `result.files` with `fflate`; show
    `result.crossSync` as "ALL IN SYNC".
  - Unverified RFHUB targets (Gen1/XC2268) return a result whose `checks`/reason
    mention `allowUnverifiedTarget` → surface an opt-in checkbox.
  My `MarrySyncTab.jsx` is the reference implementation.

## What's new since stage 7 (stages 8–20)
8.  Unified engine-backed Marry/Sync tab; retire 2 duplicate tabs
9.  Deprecate dead TwinTab (last writer that bypassed securityBytes)
10. ModuleSync: gate the UNVERIFIED XC2268 SEC16 write
11. **Engine resolver = proven superset** — caught + fixed the legacy 2014
    (0x00C8/0x00F0) BCM mirror bug; delegate ModuleSync resolution to it
12. **marryAll()** — one-shot 3-module marry (BCM → RFHUB + PCM)
13. marryAll: direct RFHUB↔PCM verification pass
14. **Activate GPEC2A File-Unlock** — recovered the real patterns from a genuine
    unlock; flag offset corrected 0x2FFFC→0x2FFF0; INT_FLASH proven byte-exact
15. Lock marryModule ≡ ModuleSync writer sequence in CI (single write path)
16. checksumScanner: confidence tag to filter coincidental sum8 false-positives
17. **Gen1 RFHUB SEC16 offset fix** (engParseRfh read 0x0226 = key-table region;
    aligned to 0x00AE where the writer + 3 modules agree) — see ModuleSync hunk
18. GPEC immo: surface the SKIM (0x0011) immobilizer enable byte + bypass warning
19. Gpec2aImmoPanel: render the SKIM card
20. KeyProgTab: gate the UNVERIFIED XC2268 SEC16 write (parity with the engine)
21. **CommandShell: Advanced/Reference drawer → collapsible accordion.** The
    52-item flat scroll was the worst back-end offender. Group into the 6
    sections, default-open only the active tab's section, count badge per
    section, dense 2-col icon+title tiles when expanded, search auto-opens
    matching sections. **Front-page rail/landing untouched.** Pure-presentation
    (no logic) — see `patches/0021-drawer-accordion.patch`.

## Two real bug fixes in here — do NOT skip the parseModule.js / ModuleSync.jsx hunks
- **2014 LX BCM** legacy mirror (parseModule.js) — without it the engine refuses
  real 2014 BCMs.
- **Gen1 RFHUB** SEC16 offset 0x0226→0x00AE (ModuleSync.jsx engParseRfh) — read
  was at the wrong region vs the writer.

## New tests (run after applying)
`marryAll`, `marryModule.moduleSyncEquivalence`, `bcmSec16Resolve.equivalence`,
`rfhSec16Resolve.equivalence`, `keyProgXc2268Gate`, `checksumConfidence`,
`gpec2aSkim`, plus updated `gpec2aUnlocker` + `gpec2aUnlocker.fixture`.

Everything is also on `gomezsteve382/srtlabtool` (branch
`claude/saas-master-repo-dagbth`, `saas-master-cleanup/`) — pull instead of
taking files if you prefer. The full 20-commit series is
`srt-lab-cleanup-ALL.patch` (applies on a clean base at 4a6a06d).
