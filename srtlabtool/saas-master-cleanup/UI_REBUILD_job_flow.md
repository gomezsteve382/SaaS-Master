# UI rebuild — job-flow model (stages 22–23)

Fixes the "three competing menus, three names per job, 61 flat tabs" problem.
Front-page rail/landing intent preserved; this restructures the **back-end**
workspace nav into six **job doors**. Verified against the live test suite
(pnpm/vitest) — 15 nav-guard tests green, DumpsTab suites green.

## The model — one source of truth
`artifacts/srt-lab/src/workspaceJobs.js` (new). Six jobs, each with a `primary`
tab + member `modes`:

| Job | Door label | Primary | Members (modes) |
|---|---|---|---|
| read  | READ MODULE  | inspector | bcm, rfhub, ecm, skim, skimlive, smartbox, immobcm56xb, bcmconfig, proxi |
| marry | MARRY / SYNC | secsync   | vinsync, modsync |
| keys  | KEYS         | keyprog   | keyxfer, keymgr, livekey, keywriter, radiocodes, seed, jailbreak |
| flash | FLASH        | flasher   | cflash, gpecunlock, efd, efd2bin, fwemul, vinprog, cdasession |
| live  | LIVE OBD     | obd       | uds-console, udsanalyzer, loganalyser |
| ref   | REFERENCE    | dumps     | backups, samples, workflow, investigation, alfaobd, alfaintel, binintel, dispatchcov, unlockcov, canuniverse, patterns, kg, sigdisc, cda6db, exttools |

All **49** workspace tabs map to exactly one job (verified 1:1, zero orphans).
`jobOf()` falls back to `ref`, so a newly-added tab can never go unreachable.

## What changed (stage 22 — rail + drawer)
- `CommandShell` derives BOTH the rail (was 8 arbitrary tabs with a *second*
  vocabulary) and the drawer's 6 sections from `JOBS`. One job = one name
  everywhere. Rail door stays lit while on any member tab (BCM keeps READ lit).

## What changed (stage 23 — mode strip + landing)
- `CommandShell.ModeStrip` — a per-job pill strip across the top of the
  workspace. The 8 KEYS / 10 READ duplicate tabs become **modes inside one
  screen** instead of N separate drawer entries. This is the piece that makes
  the duplication disappear on screen.
- `App.JobCards` — the six doors as a "what are you trying to do?" hero on the
  Diagnose landing, gated behind a new `DumpsTabV2 onOpenTab` prop (so the many
  DumpsTab unit tests render the landing unchanged).
- `MarrySyncTab` gets a stable `marry-sync-tab` root testid.

## Tests
Nav drift-guards rewritten to the job-flow model (`workspaceNav`,
`keyTransferNav`, `keyTransferTab`): rail doors open jobs (mode-strip assertion),
keyxfer reached via KEYS door + mode pill, drawer sample expands its collapsible
section first. **15 nav tests + 44 incl. DumpsTab green.**

Pre-existing suite failures (7 files: FcaModuleInspector.workspace, gpec2aImmo,
keyPhotoImport, keyProgWizard.rfhSec16Write, rfhubGen2SizeDetect,
checksum.fixtures, corruptReject) were confirmed failing on a clean pre-rebuild
tree — they are fixture/OCR/SEC16/generated-data issues, untouched by this work.

## Apply
Patches `0022-*.patch` and `0023-*.patch` in `patches/`. From the SaaS-Master
repo root: `git am saas-master-cleanup/patches/0022-*.patch saas-master-cleanup/patches/0023-*.patch`
(or `git apply` the diffs). Then `node scripts/generate-quickref-data.mjs` once
so `src/lib/attachedAssetMismatches.generated.json` exists before `pnpm test`.

## Stage 3 — dedicated HOME door (patch 0024)
`dumps` (Diagnose) is now a **HOME** button pinned above the six job doors,
removed from every job (`JOB_OF.dumps` is undefined) and from the drawer — so
landing on Diagnose lights HOME, not REFERENCE. REFERENCE's primary is now
`backups` (given a stable `backups-tab` root testid). Nav guard gains a HOME
test (16 nav tests green).

## Stage 4 — per-tab body density (patch 0025)
- **`components/Section.jsx`** (new, unit-tested) — reusable collapsible block.
  Default-open so adoption never breaks existing content/tests; the title stays
  visible while collapsed so a safety headline never hides behind a fold.
- **BcmConfigTab** — opens as a collapsed **index**: only the first of the ten
  themed categories expands on load; a live search force-opens every matching
  section. (It already had bespoke collapsible hero sections — this just changes
  the default + adds search-reveal.) Ten-banner scroll → one-screen index.
- **ProxiTab** — adopts `Section` for the "two panels — different write
  semantics" reference banner; safety headline stays in the collapsed header.

### Density rollout — next targets (mechanical, use `Section`)
Worst remaining flat-wall bodies: `KeyProgTab` (1306 ln), `FcaModuleInspector`
(1435 ln), `ModuleSync` (~2400-ln body — wrap its top-level card groups, run its
~8 test files after). Pattern: wrap secondary/reference regions in `<Section
defaultOpen={false}>`, keep the primary action above the fold.

## Test status
Full suite: **5843 passed**, +5 new (4 Section unit + 1 HOME nav). The 7
pre-existing failures (FcaModuleInspector.workspace, gpec2aImmoPanel,
keyPhotoImport, keyProgWizard.rfhSec16Write, rfhubGen2SizeDetect,
checksum.fixtures, corruptReject) were confirmed failing on a clean pre-rebuild
tree — fixture/OCR/SEC16/generated-data issues, untouched by any of this work.
