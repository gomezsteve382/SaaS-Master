/* unlockBudget — turn the unlock engine from "spray keys until the module locks"
   into "fire ONE informed shot". FCA modules lock after ~3 bad keys (NRC 0x36),
   so auto-detect sweeping a long chain can trip the final lockout on a customer's
   only module before the right algorithm is ever reached (audit #8).

   From ONE captured seed we compute EVERY candidate key OFFLINE and rank them, so
   the operator can pick the top candidate(s) instead of blindly walking a chain.

   Guarantees:
     - rankCandidates is a SUPERSET re-ordering of pickUnlockChain — it never drops
       a 'verified:*' factory id or the module-preferred id; it only omits ids whose
       key can't be derived from THIS seed (those are not usable shots anyway).
     - Ranking signals (high -> low): a remembered winning algo for THIS tx, then
       'verified:*' factory algorithms, then the SA-level family prior, then the
       original chain order as a stable tiebreak.

   The module's REMAINING attempt count cannot be read over the bus (FCA exposes no
   counter DID — only a clearable counter via the dealer-lockout routine), so the
   budget is INFERRED: a pre-flight seed request that returns 0x36/0x37 means the
   module is already locked, and we fire zero keys. */

import { pickUnlockChain, unlockKeyBytes, SA_DISPATCH } from './algos.js';

const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');

/* Read the remembered winning algo for a tx (same key format as
   J2534UdsConsoleTab's saStorageKey: `sa_algo_0x<tx-hex>`). Safe when there is no
   localStorage (Node/tests) — returns null. */
function rememberedFor(tx) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(`sa_algo_0x${(tx >>> 0).toString(16)}`) || null;
  } catch { return null; }
}

/* Compute + rank candidate keys from one seed.
   Returns [{ id, keyBytes, keyHex, priority, reasons:[...] }] sorted best-first.
   `remembered` can be passed explicitly (for tests); otherwise it's read from
   localStorage. */
export function rankCandidates({ seed, tx, code, saLevel, remembered } = {}) {
  const seedBytes = Array.from(seed || []);
  const base = pickUnlockChain(tx, code) || [];
  const rem = remembered !== undefined ? remembered : rememberedFor(tx);
  const saFamily = (saLevel != null) ? SA_DISPATCH[saLevel & 0xFF] : undefined;

  const out = [];
  base.forEach((id, idx) => {
    let keyBytes = null;
    try { keyBytes = unlockKeyBytes(id, seedBytes); } catch { keyBytes = null; }
    if (!keyBytes) return;                       // can't compute from this seed -> not a shot
    const reasons = [];
    let priority = -idx;                          // keep base order as the stable tiebreak
    if (rem && id === rem) { priority += 1000; reasons.push('remembered'); }
    if (id.startsWith('verified:')) { priority += 500; reasons.push('verified'); }
    if (saFamily && (id === saFamily || id.startsWith(saFamily))) { priority += 200; reasons.push('sa-prior'); }
    const bytes = Array.from(keyBytes);
    out.push({ id, keyBytes: bytes, keyHex: bytes.map(hex2).join(' '), priority, reasons });
  });
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

/* The single best shot — for "fire ONE key" flows. */
export function bestCandidate(args) {
  const ranked = rankCandidates(args);
  return ranked.length ? ranked[0] : null;
}

/* Map a pre-flight seed-request NRC to a budget verdict. 0x36 (exceededAttempts)
   or 0x37 (requiredTimeDelayNotExpired) on the SEED request means the module is
   already locked — fire ZERO keys and route to recovery instead. */
export function budgetFromSeedNrc(nrc) {
  if (nrc === 0x36) return { locked: true, reason: 'exceededAttempts', advise: 'dealer-lockout-bypass' };
  if (nrc === 0x37) return { locked: true, reason: 'requiredTimeDelayNotExpired', advise: 'wait-or-bypass' };
  return { locked: false, reason: null, advise: null };
}
