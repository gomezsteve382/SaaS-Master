# Program All — Playwright e2e test plan

`src/tabs/ProgramAllTab.jsx` is the universal batch UI. Unit tests for the
underlying registry + programmer live in
`src/lib/__tests__/{moduleRegistry,vinProgrammer}.test.js`. The UI itself is
covered by an end-to-end Playwright run driven through the Replit testing
skill (`runTest()`), reproducible from the plan below.

## Test hook

When the dev URL carries `?testEngine=stop-on-fail-ecm`, `ProgramAllTab.jsx`
installs a stub UDS engine on `window.__SRT_TEST_ENGINE__` at module load:

- ECM (tx `0x7E0`) preflight read returns `{ok: false}` → ECM always fails.
- Every other tx returns positive `0x62 / 0x6E / 0x50 / 0x67` responses,
  and read-back replies echo the new VIN so verify-by-readback passes.

The runner picks the stub up in place of `initAdapter()` /
`createBridgeEngine()`. The hook is gated on `import.meta.env.DEV`, so it is
inert in production builds.

## Plan

```
1.  [New Context] Create a new browser context.
2.  [Browser] Navigate to /?testEngine=stop-on-fail-ecm
3.  [Verify] window.__SRT_TEST_ENGINE__.adapter === 'TEST_STUB'
4.  [Browser] Type "1C3CCBBG7HN500001" into data-testid="master-vin-input"
              (year code H = 2017 → no SGW)
5.  [Verify partition into the four reference panels]
    - data-testid="programall-tab" present
    - urow-{BCM,RFHUB,ECM,ADCM,TCM} present (writable bucket)
    - unovin-{BSM_RDR,TPMS_SENS,OCS_SENS} present (no-vin bucket)
    - "Unsupported (gateway / proxy)" subsection contains "SGW"
    - "Pending W7 cipher (task #145)" subsection contains "ECM_W7"
    - "▶ Program N modules" run button is enabled, no SGW banner.
6.  [Browser] Tick "stop on first fail"
7.  [Browser] Click "▶ Program N modules"; wait for completion.
8.  [Verify stop-on-fail freezes the rest of the list]
    - ustat-ECM contains "FAIL"
    - ustat-{BCM,RFHUB,TCM} contain "SKIPPED"
    - log panel contains "UNIVERSAL VIN BATCH" and "stop-on-fail enabled"
9.  [Browser] Replace the VIN with "1C3CCBBG7LN500001" (year code L = 2020)
10. [Verify SGW-blocked VINs disable the run button]
    - "SGW required" banner is visible
    - Run button is disabled (button.disabled === true)
```

## Re-running

From an agent session, call the testing skill with this plan:

```js
const result = await runTest({ testPlan, relevantTechnicalDocumentation });
```

The four claims under test mirror the four asks in task #157:
partition correctness, stop-on-fail freeze, SGW disable, and stubbed-engine
drive of the runner.
