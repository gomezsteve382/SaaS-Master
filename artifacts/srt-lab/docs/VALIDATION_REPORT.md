# SRT Lab — Function Validation Report (2026-06-12)

Scope: every exported function in `src/lib` (173 modules, 500 exported
functions). Method: each claim below is tied to evidence we actually hold —
the passing test suite, real (anonymized) dump fixtures, and the grounded
findings docs. **Nothing here is asserted by assumption.** Where a function
cannot be validated from data alone (it needs a live module / J2534 bench),
it is listed as such rather than claimed working.

## 1. Headline result

| Check | Result | Evidence |
|---|---|---|
| Full vitest suite | **5843 pass**, 7 pre-existing fails, 0 introduced | `vitest run` |
| `node --test` suite | 186/187 (1 needs `pnpm -w run sweep:assets` first, then 18/18) | `node --test src/__tests__/*.test.mjs` |
| Module load smoke | **173/173 modules load** (162 under bare node + 11 under the real toolchain) | dynamic `import()` of every `src/lib/*.js` |
| Real-dump golden suites | **78 pass** | `*.realDump.golden.test.js`, `knownWorkingKeys.golden.test.js` |
| Function-level coverage | **370 / 500 (74%)** referenced by a test | static scan of all test files |

The 7 pre-existing suite failures are unchanged from the prior baseline and
were **not** introduced by this work: `gpec2aImmoPanel`, `keyPhotoImport`,
`keyProgWizard.rfhSec16Write`, `rfhubGen2SizeDetect`, `checksum.fixtures`,
`FcaModuleInspector.workspace`, `corruptReject`.

## 2. Grounded immo invariants — re-verified against real dumps

These are the load-bearing security claims. Each was re-checked directly, not
taken on faith.

1. **Marry algebra `PCM SEC6 = reverse(BCM SEC16)[0:6]`, marker `FF FF FF AA`.**
   PROVEN against the real anonymized married triple (donor 652640,
   `2C3CDXCT1HH600000`) in `bcmPcmSec6.realDump.golden.test.js`:
   `applyPcmFromBcm(pcm.before, bcm.after SEC16)` reproduces the captured
   `pcm.after` **byte-for-byte** — marker `FF FF FF AA @ 0x3C4`, SEC6
   `81 65 31 f7 cd e3 @ 0x3C8` — and the derived SEC6 equals the paired RFH
   SEC16[0:6]. Cross-checked live: `immoSecret.pcmSec6FromBcm(ed bd ff 7c …)`
   → `86 fa 72 37 76 60` = `reverse[0:6]`.

2. **`reverse16` is an involution** (`rev(rev(x)) === x`) — verified directly
   on real secret bytes; underpins `RFHUB SEC16 = reverse16(BCM SEC16)`.

3. **The shared constant is real and correctly flagged.** The
   `public/bench-sets/bcm_6.2charger.bin` secret resolves to exactly
   `00 00 00 00 00 00 00 31 3E 00 10 00 18 00 0A 00` (the documented donor
   constant), and the parser reports `immoSynced: false` — i.e. it is **not**
   treated as a confident per-car secret. Honesty flag working.

4. **`sec16Status` honesty flag working.** Both the donor bench RFHUB and the
   `SYNCED_VIRGIN` RFHUB report `sec16Status: unverified-layout` (Gen2 24C32)
   rather than a false "SEC16 INVALID/MISMATCH" — the exact behavior patch
   0026 was meant to deliver. `pcmSec6/skimStatus/keyConsistent` populate on
   the GPEC2A PCM as designed.

> Note: the `public/bench-sets/` files are a **donor/un-married** set, so they
> are the right evidence for the *honesty flags* but **cannot** re-prove the
> marry algebra. That proof lives in the matched-triple golden fixtures under
> `src/lib/__fixtures__/realDumps/` (item 1).

## 3. Coverage triage of the 130 untested functions

74% of functions are exercised by the suite. The remaining 130 break down by
**whether they can be validated from data at all**:

### [A] Hardware / live-transport — NOT validatable from dumps (44)
These drive a physical module over J2534 / a micro-pod bridge, or persist
live-session state. Correctness can only be confirmed on a bench with the
actual hardware; no dump can stand in for them. **Marked unverified by design,
not assumed working.**
`liveImmo.{connectImmoModule, performSecurityAccess, readPin, readKeySlots,
enterKeyLearn, confirmKeyLearned, exitKeyLearn, eraseAllKeys, appendLiveImmoAudit}`,
all `bridgeClient.*MicroPod*`, `bridgeEngine.{createMicroPodEngine,
createEngineForActiveTransport, reUnlockSeedKey, reUnlockAdcmRoutine}`,
`canRecorder.*`, `flasherStateMachine.flashEcuOffline`, `j2534Raw.passthruUdsRequest`,
`auth29State.*`, plus assorted `sgwUnlock`/`initAdapter` entry points.

> Pure helpers that happen to live in these modules WERE smoke-run and pass:
> `liveImmo.{immoNrcMsg, sbecAlgo, pinFromSec16}`, `isotp.parseFlowControl`,
> `flashSequencer.computeCrc16` (CRC of `01 02 03 04` → `0x89c3`),
> `sgwUnlock.requiresSgwUnlock`.

### [B] IO / PDF / persistence / UI — no data invariant to check (15)
`buildAnalysisPDF.*`, `buildOnePagerPDFBytes`, `buildQuickReferencePDF`,
`downloadAssets.*`, `audit.{saveBackup, saveBinaryRepairRecord, dispatchToast,
saveScanPlaceholders}`, `keyProgArchiveHistory.subscribeArchives`,
`charKeyAddVerification.upsertVerification`, `aemtImporter.buildAemtBackupStubs`.
These call browser APIs (PDF bytes, localStorage, fetch, toasts); they have no
byte-level invariant to validate and are low-risk. Recommend lightweight
jsdom/IO tests if formal coverage is wanted.

### [C] Pure / data — runnable and validatable from fixtures (71)
Deterministic functions over bytes/strings. A representative batch was
smoke-run live and executes correctly, e.g.
`immoSecret.{pcmSec6FromBcm, pcmSec6FromRfh, deriveAllFromRfh}`,
`rfhubKeySlots.{isRfhubBuffer, sec16OffsetsFor}`, `dtc.dtcStem`,
`zf8hp.containsObdstarFiller`, `algoProvenance.{isTrusted, confidenceBadge}`
(`{text:"UNVERIFIED", tone:"danger"}` for an ungrounded record — the trust
ledger is honest), `bcmConfigCodec.bcmDidName`. These are the best candidates
for closing the coverage gap with golden tests.

## 4. What this report does NOT claim

- It does **not** claim the live key-learn / security-access paths work — that
  needs a bench (see §3[A]).
- It does **not** independently re-derive a *new* married secret; the algebra
  proof rests on the existing matched-triple golden fixtures.
- The four open immo threads from the session handoff (592745 key job,
  resolving the donor constant, the `0x4098` short-VIN question) remain
  data-blocked — they need additional real dumps, not more code.

## 5. Reproduce

```
pnpm install
cd artifacts/srt-lab
node scripts/generate-quickref-data.mjs && node scripts/copy-unlock-catalog.mjs
pnpm -w run sweep:assets
pnpm exec vitest run --config vitest.config.ts
node --test src/__tests__/*.test.mjs
```
