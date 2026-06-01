---
name: vehicleJobs kind discriminator + status vocab
description: vehicle_jobs.kind separates job consumers; status strings differ per tab; resume eligibility must use the saved target set, not recorded failures.
---

# vehicleJobs `kind` + status conventions

`vehicle_jobs` has a `kind` column. Each consuming tab owns its own kind AND its own status vocabulary — they are NOT shared.

- WorkflowTab (module-swap) → status vocab uses hyphens (`in-progress`/`complete`).
- ProgramAllTab (universal VIN batch) → status vocab uses underscores (`in_progress`/`completed`/`abandoned`).

**Why:** the two tabs were built independently; status is a free-form text column so both coexist. A list/filter query that assumes a shared status vocabulary will silently miss rows.

**How to apply:** when filtering or resuming jobs, always match on BOTH `kind` and the exact status string the *writing* tab uses.

## Cross-device resume eligibility (hard-won)
Resume eligibility must be judged against the batch's **intended target set** (saved in the job's `fixPlan`), not against whether any failure was recorded.

**Why:** a run interrupted after only *successful* modules has a result log full of `ok` and no failures — but the remaining selected modules were never written. Gating resume on "has a non-ok status" misses this common case and silently drops the untouched modules. Code review rejected the first attempt for exactly this.

**How to apply:** resumable ⇔ `okCount < selectedCount` (from the saved selection) OR any recorded non-ok status. Counts shown to the user ("N to retry") should likewise derive from `selectedCount - okCount`, since never-attempted modules don't appear in the reconstructed result log at all.
