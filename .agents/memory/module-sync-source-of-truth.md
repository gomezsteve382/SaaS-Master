---
name: Module Sync source-of-truth contract
description: The pairing-chain rule SYNC ALL MODULES must obey, and the preview/write-drift bug class
---

SYNC ALL MODULES (the BCM/RFH/PCM security pairing chain) treats the **BCM as the
single source of truth**. The contract, identical to keyProgWizard.runKeyProgPatch
+ securityBytes.js:

- RFH SEC16 = reverse(BCM SEC16)
- PCM SEC6  = reverse(BCM SEC16)[0:6]
- BCM SEC16 is **never** written.

**Gating that must match between the live-preview (ModuleSummary) and the actual
writer (runFullSync):**
- A virgin/blank BCM SEC16 (all-FF or all-00) is NOT a usable source — security
  sync is skipped, VIN-only. Both sides gate on this "real secret" check.
- RFH SEC16 is rewritten only when the RFH is **Gen2** (the only RFH SEC16 writer);
  a Gen1 RFH gets VIN-only. PCM SEC6 is written whenever the BCM secret is real
  (not gated on RFH generation).

**Why:** the reported bug was twofold — (1) the writer once derived everything FROM
the RFH (so a foreign/unpaired donor RFH overwrote the BCM's correct secret and
shipped a mismatched PCM), and (2) the preview promised pairing fixes the writer
would never perform (e.g. "WILL BE FIXED ON SYNC" for a Gen1 RFH, or for a blank
BCM). Preview/write drift IS the bug class here.

**How to apply:** any change to one side (preview eligibility or writer gating) must
be mirrored on the other. Never let the preview claim a fix the write path skips.
Regression coverage lives in syncAllBcmSourceContract.test.js (real OG Charger
triple, BCM is Gen2-split, RFH is Gen1 → exercises the VIN-only RFH + PCM-from-BCM
paths and the foreign-RFH negative case).

**SYNC ALL refuses a virgin/blank engine module** (consistency with
runKeyProgPatch). A blank-SEC6 GPEC2A carries no pairing to verify against, so
pairing it would fabricate one — same reason runKeyProgPatch refuses via its
"PCM SEC6 is prefix of shared secret" check. **Why:** the SYNC-ALL-pairs-blank
vs wizard-refuses-blank inconsistency was the bug. **How to apply:** same drift
class as the BCM-source gating above — the blank-engine refusal must be enforced
by ONE shared predicate used by both the button gating and the writer; never let
preview and write disagree. The refusal is currently scoped to the sync-all path
only (the sec16-only path is a known gap).
