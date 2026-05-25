---
name: BCM SEC16 blank gate
description: sec16Absent is true only when ALL candidates are structurally blank (all-FF/all-00); entropy counting is wrong.
---

# BCM SEC16 blank gate (Task #815)

## The rule
`resolveBcmSec16` (parseModule.js) and `engParseBcm` (ModuleSync.jsx) both set
`sec16Absent = true` **only when every candidate** (split records, mirror1,
mirror2, AND the flat 0x40C9 slice) is structurally blank — meaning all bytes
are 0xFF or all bytes are 0x00.

**Why:** An entropy-count approach (≥ N non-zero/non-FF bytes) was tried and
rejected. The 6.2 Charger bench set's real SEC16
`00 00 00 00 00 00 00 31 3E 00 10 00 18 00 0A 00` has only 5 non-zero bytes
but is the authoritative vehicle secret, confirmed by FCA SINCRO competitor
tool. Any entropy threshold below 16 will cause false negatives on real data.

**How to apply:** When adding new sec16Absent checks or variants, gate on
`allBlank` (structural blank), never on a byte-count threshold.

## Consequences of sec16Absent = true
- `bytes: null` returned (never surfaces the phantom bytes)
- `vehicleSecret` nulled in `info`
- crossValidate: RFHUB ↔ BCM rule replaced by "absent — not evaluable (ALERT_NO_SECURITY)" note pushed to `passed`
- crossValidate: BCM SEC16 → PCM SEC6 rule skipped entirely
- ModuleSync wizard: sends ALERT_NO_SECURITY note to Claude instead of phantom bytes
- KeyProgTab badge: source='none', blank='1'

## Test coverage
`src/lib/__tests__/bcmSec16Absent.test.js` (15 tests)
`src/lib/__tests__/bcmSec16Resolver.test.js` (updated 2 tests)
`src/__tests__/keyProgTab.ui.test.jsx` (updated 1 assertion)
