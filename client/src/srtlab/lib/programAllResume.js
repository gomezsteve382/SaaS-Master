// Pure helpers for the Program All cross-device batch resume.
//
// These are factored out of ProgramAllTab.jsx so the resume decision logic
// (which modules still need writing after an interruption) can be unit-tested
// without mounting the whole React tab. All functions are side-effect free.

// Rebuild the per-module result map from a job's append-only event log.
//
// Events arrive newest-first (the API orders by ts desc), so the FIRST
// `module.*` event seen for a given tx is the latest and wins. Non-module
// events (e.g. batch.completed) are ignored.
export function reconstructBatchResults(events) {
  const out = {};
  if (!Array.isArray(events)) return out;
  for (const ev of events) {
    if (typeof ev?.kind !== 'string' || !ev.kind.startsWith('module.')) continue;
    const p = ev.payload || {};
    const tx = p.tx;
    if (tx == null || tx in out) continue;
    out[tx] = {
      status: p.status || ev.kind.slice('module.'.length),
      reason: p.reason,
      before: p.before,
      after: p.after,
      unlockAlgo: p.unlockAlgo,
      errors: p.errors,
    };
  }
  return out;
}

// Tx addresses selected for the batch, taken from the job's saved fixPlan.
export function selectedTxList(selection) {
  if (!selection || typeof selection !== 'object') return [];
  return Object.keys(selection).filter(tx => selection[tx]);
}

// Decide whether an in-progress job is worth resuming.
//
// Eligibility is judged against the batch's INTENDED target set (fixPlan
// selection), NOT merely whether a failure was recorded. A run interrupted
// after only successful modules has a result log full of `ok` and no failures,
// yet the remaining selected modules were never written — that is still
// incomplete and must offer resume. Legacy jobs with no saved selection fall
// back to "any prior progress exists".
export function isJobResumable(prior, selection) {
  const results = prior || {};
  const selectedTxs = selectedTxList(selection);
  const okCount = Object.keys(results).filter(tx => results[tx]?.status === 'ok').length;
  const hasNonOk = Object.keys(results).some(tx => {
    const st = results[tx]?.status;
    return st && st !== 'ok';
  });
  if (selectedTxs.length) {
    return okCount < selectedTxs.length || hasNonOk;
  }
  return Object.keys(results).length > 0;
}

// Counts for the resume banner. `toRetry` derives from the intended selection
// so modules that were never attempted before the interruption are counted as
// still-to-do (they don't appear in the reconstructed result log at all). Falls
// back to the recorded non-ok count for legacy jobs without a saved selection.
export function computeResumeCounts(prior, selection) {
  const results = prior || {};
  const c = { ok: 0, fail: 0, pending: 0, skipped: 0, other: 0 };
  for (const tx of Object.keys(results)) {
    const st = results[tx]?.status;
    if (st in c) c[st]++; else c.other++;
  }
  const recordedNonOk = c.fail + c.pending + c.skipped + c.other;
  const selectedTxs = selectedTxList(selection);
  const toRetry = selectedTxs.length ? Math.max(selectedTxs.length - c.ok, 0) : recordedNonOk;
  return { ...c, toRetry };
}
