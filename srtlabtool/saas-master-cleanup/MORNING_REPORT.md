# Morning report — autonomous hardening toward the "ultimate machine"

Everything below is committed to **srtlabtool** (branch `claude/saas-master-repo-dagbth`)
as both git-am patches (`saas-master-cleanup/patches/`) and verification harnesses.
Apply any patch to your real SaaS-Master clone with:

```sh
git am < saas-master-cleanup/patches/<patch>.patch
```

## The guiding principle I held to
I did **not** "fix" any unverified algorithm by guessing a new formula — with no
bench data that risks bricking modules and would be worse than the honest gap.
"Ultimate machine" here = **a tool that never presents a guess as a fact, and
can't fire a destructive operation by accident.** So the work is: one honest
trust ledger, corrected provenance, hard safety gates, and a confidence signal
in the UI — while leaving the **bench-verified core** (your marry / parse /
secret-write path) exactly as solid as it already was.

## What landed tonight (all verified, all pushed)

| # | Patch | What it does | Verified by |
|---|-------|--------------|-------------|
| 0001 | immo-derivation-core | One leaf module `immoSecret.js` is now the single source of truth for the SEC16 reversal / SEC6 slice that was copy-pasted in 9 files (the brick-critical primitive). Added `deriveAllFromBcm()` for your BCM-as-source bench flow. | 1,000,003-case fuzz, byte-identical; 9-module import smoke |
| 0002 | stage-a-tab-regroup | The 51-tab drawer regrouped into your 6 categories (Modules / Marry & Keys / Flash & Firmware / Live & Diagnostics / Data & Workflow / Intel & Reference). Closed a latent bug where an uncategorized tab silently vanished. Front-page rail untouched. | tab verifier: all 51 reachable, categories valid |
| 0003 | trust-ledger | `algoProvenance.js` — single source of truth for how much each algorithm/writer can be trusted (bench-verified / grounded-extracted / unverified; unknowns default to unverified). Grounding attached to all 43 algorithms. Corrected overstated hint strings. | provenance verifier: 43/43 covered (0 bench, 21 extracted, 22 unverified) |
| 0004 | dealer-lockout-gate | The dealer-lockout bypass sends RoutineControl **0xFF00 — the generic ISO-14229 firmware-ERASE RID** — with an invented payload. It now **refuses to transmit unless `acknowledgeEraseRisk:true`**; RfhubTab gates that behind a `window.confirm`. Harmless probe steps still run. | runtime harness: without ack the 0x31/0xFF00 routine is never sent; with ack it runs. Test updated + refusal test added |
| 0005 | provenance-honesty | `canflashAlgos.js` header corrected (claimed "BYTE-VERIFIED / byte-identical to the factory DLL" — but the DLLs aren't in the repo and the self-test is never run). `tabReferences.js` user-facing labels downgraded from "VILLAIN confirmed". | esbuild parse; overstatement sweep clean |
| 0006 | seedtab-confidence-badge | Every algorithm in the Seed→Key picker now shows a green/amber/red **confidence dot** (bench / extracted / unverified) from the trust ledger, with a legend. You can't pick an unverified algorithm without seeing it flagged. | esbuild JSX parse |

Plus, earlier in the session: **`derive-gpec-patterns.mjs`** — a ready-to-run kit
that recovers the GPEC2A unlock patterns from a locked/unlocked file pair (the #1
extraction gap), self-tested against a synthetic pair.

## The honest state of the knowledge base (from the grounding audit)
- **No seed→key algorithm is bench-verified** — every "golden" test proves
  self-consistency, not correctness on a vehicle. This is now visible in the UI.
- **Trustworthy (bench-verified / extraction-grounded):** `parseModule` offsets,
  the SEC16/SEC6/RFHUB-Gen2 writers, `knownWorkingKeys`, the Charger key-table
  formula. **Your marry workflow sits on this solid layer.**
- **Riskiest guesses (now flagged, not silenced):** `cda6` (the default body-bus
  unlock — no extraction source), `xtea_sgw` (SGW auth is likely server-side),
  the canflash catalog, the GPEC q2/q3/q4 entries, `dealerLockoutBypass` (gated).

## What needs YOU (can't be done from this container)
1. **GPEC2A unlock patterns** — run `GPEC_Unlocker.exe` once on Windows on a
   locked GPEC2A file, save the unlocked output, then:
   `node derive-gpec-patterns.mjs <locked.bin> <unlocked.bin>` → paste the
   emitted constants into `gpec2aUnlocker.js` (flip `PATTERNS_AVAILABLE=true`).
   That activates the currently-inert GPEC2A File-Unlock tab.
2. **aemt.exe** — it's packed/encrypted; needs a Windows runtime memory dump to
   extract. Parked until you can capture that.
3. **Bench captures** — the one thing that upgrades any seed→key algorithm from
   amber/red to green is a live seed→key pair from a real ECU. With your bench,
   even a handful would let me pin real golden tests.

## Recommended next steps (for when you're back)
- **Stage B — `marryModule()` engine:** collapse the 10 scattered sync/marry code
  paths into one verified engine (pure logic, fully testable). I have the complete
  inventory ready; this is the next clean build.
- **Stage C — consolidate + retire tabs:** merge the 7 overlapping marry/sync/key
  tabs into one workspace and retire superseded ones. This changes user-facing
  workflows, so I'd want you awake to confirm as we go.
- Wire the same confidence dot into the other algorithm surfaces (unlock coverage,
  module unlock pickers).

Nothing destructive was done. The bench-verified core is untouched. Every change
is a patch you can review or drop independently.
