// Task #663 — pure outbox helpers for UnlockCoverageTab.
//
// Extracted so the queue-coalescing rules and the replay/conflict
// state machine can be exercised in tests without spinning up the
// whole tab. UnlockCoverageTab.jsx imports both `coalesceOutbox` and
// `replayOutbox` and wraps them with React state setters.
//
// Outbox entry shape:
//   { id: string, kind: "verify"|"clear", entryId: string,
//     payload?: { operator?, vin?, notes? },
//     clientVerifiedAt: ISO string,
//     queuedAt: ISO string,
//     lastError?: string }
//
// clientVerifiedAt is the operator-perceived "saved at" time — the
// server uses it for an optimistic-concurrency check (POST returns
// 409 with the authoritative row when somebody else verified the
// same entry after this op was queued).

export const OUTBOX_KEY = "srtlab.task634.outbox.v1";

/**
 * Append `op` to `queue`, dropping any existing op for the same
 * entryId first. Last-write-wins per entryId keeps the queue compact
 * when a tech taps Save → Clear → Save while offline.
 *
 * Pure: returns a new array; never mutates `queue`.
 */
export function coalesceOutbox(queue, op) {
  if (!op || typeof op.entryId !== "string") return queue.slice();
  const filtered = queue.filter((o) => o.entryId !== op.entryId);
  filtered.push(op);
  return filtered;
}

/**
 * Drain `queue` in order against the server. Stops at the first
 * network / non-conflict server error (keeps the failing op at the
 * head of the queue with `lastError` recorded). 409 responses
 * capture a conflict and drop the op from the queue — they don't
 * block following ops.
 *
 * Side effects are surfaced through optional callbacks so the
 * component can mirror them into React state + localStorage:
 *   - onApplyVerification(entryId, verification, clientVerifiedAt)
 *       called when a verify op POSTs successfully
 *   - onApplyClear(entryId)
 *       called when a clear op DELETEs successfully (or 404)
 *
 * Returns { remaining, drained, conflicts }.
 */
export async function replayOutbox(queue, opts = {}) {
  const {
    fetchImpl = typeof fetch === "function" ? fetch : null,
    onApplyVerification,
    onApplyClear,
  } = opts;
  if (typeof fetchImpl !== "function") {
    throw new Error("replayOutbox: no fetch implementation available");
  }
  const remaining = queue.slice();
  const conflicts = [];
  let drained = 0;
  while (remaining.length > 0) {
    const op = remaining[0];
    try {
      if (op.kind === "verify") {
        const r = await fetchImpl("/api/task634-verifications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entryId: op.entryId,
            operator: op.payload?.operator ?? null,
            vin: op.payload?.vin ?? null,
            notes: op.payload?.notes ?? null,
            clientVerifiedAt: op.clientVerifiedAt,
          }),
        });
        if (r.status === 409) {
          let data = null;
          try { data = await r.json(); } catch { /* ignore */ }
          if (data && data.conflict) {
            // Preserve the operator's local payload alongside the server
            // row so the ConflictMergeDialog (task #674) can render a
            // true side-by-side local-vs-server picker without having
            // to re-fetch / re-derive what the tech originally typed.
            conflicts.push({
              entryId: op.entryId,
              ...data.conflict,
              local: {
                operator: op.payload?.operator ?? null,
                vin: op.payload?.vin ?? null,
                notes: op.payload?.notes ?? null,
                verifiedAt: op.clientVerifiedAt,
              },
            });
          }
          remaining.shift();
          drained += 1;
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        let data = null;
        try { data = await r.json(); } catch { /* ignore */ }
        if (data && data.verification && typeof onApplyVerification === "function") {
          onApplyVerification(op.entryId, data.verification, op.clientVerifiedAt);
        }
      } else if (op.kind === "clear") {
        const r = await fetchImpl(
          `/api/task634-verifications/${encodeURIComponent(op.entryId)}`,
          { method: "DELETE" },
        );
        if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
        if (typeof onApplyClear === "function") onApplyClear(op.entryId);
      } else {
        // Unknown op kinds are dropped silently so a stale localStorage
        // entry from a future version doesn't permanently block the queue.
        remaining.shift();
        drained += 1;
        continue;
      }
      remaining.shift();
      drained += 1;
    } catch (e) {
      remaining[0] = { ...op, lastError: e?.message || "send failed" };
      break;
    }
  }
  return { remaining, drained, conflicts };
}
