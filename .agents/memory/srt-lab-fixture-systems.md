---
name: SRT Lab two fixture systems
description: sample-picker fixtures vs golden-test fixtures live in different dirs; adding sample fixtures won't affect fixtures:check
---

SRT Lab has two independent on-disk fixture systems — don't confuse them:

- **Sample-picker fixtures**: `artifacts/srt-lab/src/__tests__/fixtures/`, registered
  in `src/lib/sampleFixtures.js` (`SAMPLE_FIXTURES` array, `getBenchPairs()`,
  `getFixturesByKind()`). These are what the in-app sample pickers load.
  `sampleFixtures.js` discovers the `.bin` files via Vite `import.meta.glob`, so it
  **cannot be imported by plain `node`** (`(intermediate value).glob is not a
  function`) — exercise it through vitest, not `node -e`.
- **Golden-test fixtures**: `src/lib/__fixtures__/realDumps/`. The
  `fixtures:check` script (anonymizeRealDump / realDumps.anonymization /
  realDumps.helperLeakScan / securityBytes.realDump.golden tests) scans THIS dir,
  NOT the sample-picker dir.

**Consequence:** adding/removing sample-picker fixtures does not change
`fixtures:check` results. To make a BCM↔PCM pair auto-load together in the pairing
tab, give both entries the SAME `pair:` key and matching anon VIN; `getBenchPairs()`
groups by pair key (needs a 65536 BCM + a 4096/8192 GPEC_EXT).

**Why:** Task #1118 scratchpad initially worried added sample fixtures might break
`fixtures:check`; they don't, because the two systems read different directories.
