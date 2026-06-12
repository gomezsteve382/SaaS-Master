# SaaS-Master (SRT Lab) cleanup — durable backup

This directory preserves cleanup work done against the **SaaS-Master / SRT Lab**
workbench. That repo is worked on in an ephemeral container, so the patches and
verification harnesses are mirrored here (in `srtlabtool`, a durable repo) so
nothing is lost when the container is reclaimed.

## How to use

Apply a patch to your real local SaaS-Master clone from its repo root:

```sh
git am < saas-master-cleanup/patches/0001-immo-derivation-core.patch
# or, without keeping the commit message:
git apply saas-master-cleanup/patches/0001-immo-derivation-core.patch
```

## Patches

### `0001-immo-derivation-core.patch` — Stage 1: one verified derivation core
Adds `artifacts/srt-lab/src/lib/immoSecret.js` as the single source of truth
for the BCM↔RFH↔PCM immobilizer-secret byte relationships, and routes all 9
files that previously hand-rolled the SEC16 reversal / SEC6 slice through it
(securityBytes, keyProgWizard, bcmPcmSync, gpec2aPcmAnalyzer, mpc5606bBcm,
rfhPcmPair, liveImmo, parseModule + a duplicate `reverse16()` in liveImmo).
Adds `deriveAllFromBcm()` — the BCM-as-source direction the bench marry
workflow uses. Proven byte-identical to the prior canonical function and the
old hand loops across 1,000,003 fuzzed inputs.

## Verification harnesses

- `verify-immo.mjs` — fuzzes the new core against the old canonical function
  and the old hand-rolled loops (1M+ cases). Run: `node verify-immo.mjs`
  (adjust the import paths at the top to point at your SaaS-Master clone).
- `smoke-immo.mjs` — imports every edited module and checks the derivation +
  PCM SEC6 write round-trip.
