---
name: RFHUB key-fob PIN lockout safety
description: Non-obvious safety rules for RFHUB Routine 0x0401 key-fob PIN programming in srt-lab
---

# RFHUB key-fob PIN lockout safety

Every transmitted `startRoutine 0x0401` frame carrying a PIN is an **irreversible
hardware attempt**. The 3rd wrong PIN permanently bricks the RFHUB (dealer-only
reset). Treat the attempt budget as life-or-death.

## Rules (must stay consistent)
- **Count one attempt PER TRANSMITTED frame**, the instant it leaves the host —
  not once per button click. A wrong PIN is spent on the module whether or not
  the reply is seen. Helpers + counter live in `src/lib/rfhubPin.js`
  (sessionStorage, keyed serial > PN > CAN address).
- **Blind "try all encodings" must be capped to the remaining budget.** Sending
  all 4 encodings in one click guarantees a brick. The pure planner
  `planPinSends({blind,currentAttempts,candidateIds})` is the single chokepoint:
  single mode ≤1 frame; blind mode stops at `BLIND_MULTITRY_LIMIT` (2) so a final
  deliberate attempt is always preserved. Re-check the live gate before each send.
- **Dry Run must be read-only.** Never send a `startRoutine 0x0401` with a dummy
  PIN payload — the module may count it as a wrong attempt. Dry Run instead
  previews the frame that *would* be sent (no transmit) and probes liveness with
  `requestRoutineResults` (`31 03 04 01`, subfunction 0x03, no PIN), which cannot
  burn an attempt.
- Stop the chain immediately on lockout NRC `0x36`/`0x37`; reset the counter only
  on a confirmed success (71 to the routine-results query).

**Why:** code review rejected an earlier version twice — per-run counting +
blind multi-try + a dummy-PIN dry run could each brick a customer's RFHUB in a
single click. These three rules close every path to the ceiling.

**How to apply:** any change to `programNewKey` in `RfhubTab.jsx` or to the
gate/planner in `rfhubPin.js` must preserve all four rules. Per-generation PIN
encodings in `RFHUB_PIN_GENERATIONS` are all `confidence: 'unverified'` until a
real bench PIN-burn capture confirms them.
