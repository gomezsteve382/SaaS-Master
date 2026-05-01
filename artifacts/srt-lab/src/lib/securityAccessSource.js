/* SecurityAccessSource — pluggable interface for unlocking modules during the
   Workflow Runner (Task #501).

   The runner does not call algos.js directly. Instead it goes through one of
   these implementations so the same step ("ensure module X is at SecAccess
   level Y") works for:
     • LocalAlgoOverJ2534  — default. Computes seeds locally with the existing
                              tryUnlockWithChain pipeline (the only impl that
                              ships today).
     • Future BenchKeyServer / RemoteHsm impls — drop-in replacements that
       hand the seed to a hardware HSM or a network service and return a key.

   Every impl returns the same shape:
     { ok: boolean, algo?: string, key?: number[]|Uint8Array,
       nrc?: number, reason?: string, lockoutUntil?: number, retryAfterMs?: number }

   `requestSeed(target, level, transport)` wraps the wire-level 27 SEEDSF
   exchange. `computeKey(target, level, seed)` derives the key bytes from the
   seed. Implementations are free to combine the two into one call. The
   workflow runner uses `unlock()` as the high-level entry point.
*/

import { tryUnlockWithChain, pickUnlockChain } from "./algos.js";

/* ───── shared error helpers ───── */

export const NRC = Object.freeze({
  EXCEEDED_NUMBER_OF_ATTEMPTS: 0x36,
  REQUIRED_TIME_DELAY_NOT_EXPIRED: 0x37,
  INVALID_KEY: 0x35,
});

/**
 * Default implementation: compute keys locally using the existing seed→key
 * algorithms in algos.js, talking to the bench/J2534 transport via the
 * `uds(tx, rx, bytes) → {ok, d}` callback the rest of the codebase already
 * uses.
 *
 * @param {object} cfg
 * @param {Function} cfg.uds      — `uds(tx, rx, bytes) → Promise<{ok, d:Uint8Array}>`
 * @param {Function} [cfg.addLog] — optional logger forwarded to tryUnlockWithChain
 */
export function LocalAlgoOverJ2534({ uds, addLog }) {
  if (typeof uds !== "function") {
    throw new Error("LocalAlgoOverJ2534: uds(tx,rx,bytes) callback is required");
  }
  return {
    kind: "LocalAlgoOverJ2534",
    /**
     * Drive the full 27 SF exchange for a target, returning a structured
     * result so the workflow runner can show the right banner (success,
     * algo-walked-fallback, NRC 0x36 lockout, NRC 0x37 retry-after).
     *
     * @param {object} target  — { tx, rx, code, label }
     * @param {number} [accessLevel=0x01]
     */
    async unlock(target, accessLevel = 0x01) {
      const { tx, rx, code, label } = target || {};
      if (typeof tx !== "number" || typeof rx !== "number") {
        return { ok: false, reason: "missing tx/rx" };
      }
      const lbl = label || code || "0x" + tx.toString(16).toUpperCase();
      const chain = pickUnlockChain(tx, code);
      const out = { calls: [] };
      const log = (msg, kind) => {
        out.calls.push({ msg, kind });
        if (typeof addLog === "function") addLog(msg, kind);
      };
      const res = await tryUnlockWithChain(uds, tx, rx, chain, log, lbl, accessLevel);
      if (res === false) {
        // tryUnlockWithChain stamps the last NRC encountered onto the log
        // stream; surface it (and any 0x36/0x37 metadata) to the caller.
        const lastNrc = out.calls
          .map((c) => /NRC 0x([0-9A-F]+)/.exec(c.msg || ""))
          .filter(Boolean)
          .map((m) => parseInt(m[1], 16))
          .pop();
        const lockout = out.calls.find((c) => /lockout until/.test(c.msg || ""));
        const retry = out.calls.find((c) => /retry-after/.test(c.msg || ""));
        return {
          ok: false,
          algo: null,
          nrc: lastNrc ?? null,
          reason:
            lastNrc === NRC.EXCEEDED_NUMBER_OF_ATTEMPTS
              ? "Module is locked out (NRC 0x36)"
              : lastNrc === NRC.REQUIRED_TIME_DELAY_NOT_EXPIRED
                ? "Required delay not yet expired (NRC 0x37)"
                : "Unlock failed",
          lockoutUntil: lockout ? Date.now() : null,
          retryAfterMs: retry ? extractRetryMs(retry.msg) : null,
          log: out.calls,
        };
      }
      if (res === true) {
        return { ok: true, algo: "already-unlocked", log: out.calls };
      }
      return { ok: true, algo: res, log: out.calls };
    },
  };
}

function extractRetryMs(msg) {
  const m = /retry-after\s+(\d+)\s*ms/.exec(msg || "");
  return m ? parseInt(m[1], 10) : null;
}

/**
 * In-memory fake used by unit tests + the offline preview workflow.
 * `script` is a list of canned responses keyed by `${tx}:${level}`.
 */
export function FakeSecurityAccessSource(script = {}) {
  return {
    kind: "FakeSecurityAccessSource",
    async unlock(target, accessLevel = 0x01) {
      const key = `${target.tx}:${accessLevel}`;
      const canned = script[key] || script[String(target.tx)] || script.default;
      if (typeof canned === "function") return canned(target, accessLevel);
      return canned || { ok: false, reason: "no script for " + key };
    },
  };
}
