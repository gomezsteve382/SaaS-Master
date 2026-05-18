# `_unverified/` Quarantine Directory

## Policy

Everything in this directory is **unverified third-party intel**.

- Files here are **never imported** by any application code, tab, or library
  outside this directory. Any import from `../`, `../../`, or any path outside
  `_unverified/` is a policy violation and must be blocked in code review.
- Files here may be imported by test files inside `__tests__/` within this same
  directory — that is their only allowed consumer until graduation.
- An algorithm or constant **graduates** from this directory only after the full
  Phase 3 integration checklist in
  `artifacts/srt-lab/docs/villain-unpack-workflow.md` passes and receives
  peer-review sign-off.

## Rationale

Algorithms extracted from third-party proprietary binaries require independent
bench verification before they can be trusted. Quarantining them here makes the
separation visible and enforceable: any grep for an import path containing
`_unverified` immediately flags a potential policy violation.

## Contents

| File | Description |
|------|-------------|
| `villain27_61.candidate.js` | Candidate `CalculateSecurityKey_0x61` implementation from VILLAIN binary intel (Steps 1–4 complete; S-box is a placeholder pending extraction from the unpacked binary) |
| `__tests__/villain27_61.candidate.test.js` | Self-consistency tests + fixture-driven bench-pair verification harness |
| `__tests__/bench-pairs.json` | Captured seed/key pairs from real bench ECUs (initially empty; tests skip when empty) |

## Bench-Pair Fixture Schema

`bench-pairs.json` is a JSON array. Each element:

```json
{
  "seed":  "A1B2C3D4E5F60708",
  "key":   "F1E2D3C4B5A69788",
  "date":  "YYYY-MM-DD",
  "ecu":   "free-text ECU description",
  "notes": "optional free-text"
}
```

- `seed` and `key`: uppercase hex strings, no spaces, exactly 16 characters (8 bytes each).
- `date`: ISO 8601 date of capture.
- `ecu`: enough detail to identify the bench unit (year, model, module, part number).
- `notes`: any relevant capture context (bench harness, live vehicle, etc.).

When the array is empty the fixture-driven tests are skipped automatically so CI
stays green while no real pairs have been captured yet.

## Graduation Checklist (summary)

See `artifacts/srt-lab/docs/villain-unpack-workflow.md §Phase 3` for the full
checklist. Short form:

1. ≥ 3 independent bench seed/key pairs recorded and passing
2. Real 256-byte S-box extracted and replacing the placeholder constant
3. All harness tests passing (zero skips)
4. No imports of these files from outside `_unverified/`
5. Peer review sign-off
6. Audit log entry
7. `algos.js` integration behind feature flag (separate PR)
