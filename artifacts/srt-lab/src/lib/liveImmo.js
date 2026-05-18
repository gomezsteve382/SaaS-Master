/* liveImmo.js — Alfa-OBD–style live immobilizer service layer.
 *
 * Wraps the J2534 bridge engine (createBridgeEngine / bridgeEngine.js) into
 * a set of high-level operations for reading the immobilizer PIN and
 * programming / erasing transponder keys over a live OBD connection.
 *
 * All UDS exchanges use the bridge engine's `uds(tx, rx, data)` interface.
 * The engine must already be created by the caller (createBridgeEngine).
 *
 * CAN addressing — standard FCA ISO 15765-2 channels:
 *   RFHUB / SKREEM  TX 0x742  RX 0x762  (Chrysler LX/LC/WK/RT Hellcat/SRT)
 *   GPEC2A / PCM    TX 0x7E0  RX 0x7E8  (reference only — PCM not used here)
 *
 * PIN extraction:
 *   The 5-digit immobilizer PIN lives at bytes [14..15] of the 16-byte SEC16
 *   secret block.  pinDec = (raw[14] << 8) | raw[15], zero-padded to 5 digits.
 *   This matches the formula in rfhPcmPair.js#parseSec16 exactly.
 *
 * Security access — sub-function 0x01/0x02 (level 1, read-only),
 *   0x03/0x04 (level 3, write-enable).  The RFHUB uses either the standard
 *   Chrysler SBEC algorithm (seed*4+0x9018) or the SKREEM variant depending
 *   on firmware.  `securityAlgo` lets the caller pass in any `seed→key`
 *   function; defaults to the SBEC formula.
 */

/* ─── Module address presets ────────────────────────────────────────────── */
export const MODULE_ADDRS = {
  RFHUB:  { tx: 0x742, rx: 0x762, label: 'RFHUB/SKREEM' },
  SKREEM: { tx: 0x742, rx: 0x762, label: 'RFHUB/SKREEM' },
  GPEC2A: { tx: 0x7E0, rx: 0x7E8, label: 'GPEC2A/PCM' },
};
export const DEFAULT_ADDR = MODULE_ADDRS.RFHUB;

/* ─── Key slot count (mirrors rfhubKeySlots.js) ─────────────────────────── */
export const LIVE_KEY_SLOT_COUNT = 8;

/* ─── Immobilizer-specific NRC → plain-English messages ─────────────────── */
const IMMO_NRC_MAP = {
  0x10: 'General reject — module refused the request.',
  0x11: 'Service not supported by this module.',
  0x12: 'Subfunction not supported.',
  0x13: 'Incorrect message length.',
  0x21: 'Module is busy, please wait and retry.',
  0x22: 'Conditions not correct — check ignition state, engine off, key-in-slot requirement.',
  0x24: 'Request out of sequence — security access must be completed first.',
  0x31: 'Request out of range — DID or routine not supported on this module firmware.',
  0x33: 'Security access denied — wrong PIN or module is in lockout. Wait ~10 min.',
  0x34: 'Authentication required (UDS 0x29) — Secure Gateway blocking this module.',
  0x35: 'Invalid key — the seed/key response was rejected. Check unlock algorithm.',
  0x36: 'Exceeded number of attempts — module locked. Wait ~10 minutes before retrying.',
  0x37: 'Required time delay not expired — wait ~30 seconds, then retry.',
  0x70: 'Upload/download not accepted.',
  0x72: 'General programming failure.',
  0x78: 'Response pending — module is processing, waiting…',
  0x7E: 'Subfunction not supported in current session.',
  0x7F: 'Service not supported in current session — enter extended session first.',
};

export function immoNrcMsg(code) {
  if (code == null) return 'No response from module — check connections.';
  return IMMO_NRC_MAP[code]
    || `Unexpected module response (NRC 0x${code.toString(16).toUpperCase().padStart(2, '0')}) — check connections and retry.`;
}

/* ─── Additional slot-full / transponder-not-seen errors ────────────────── */
export const IMMO_ERR = {
  SLOTS_FULL:      'All key slots are full. Erase at least one slot before programming a new key.',
  NO_TRANSPONDER:  'No transponder detected within the timeout window. Insert the blank key and try again.',
  BRIDGE_OFFLINE:  'J2534 bridge not reachable. Start j2534_bridge.py and verify the cable is connected.',
  NOT_UNLOCKED:    'Security access not yet granted. Click Read PIN first to unlock the module.',
  TIMEOUT:         'Module did not respond within the timeout. Check CAN filter and retry.',
  SESSION_TIMEOUT: 'Diagnostic session timed out. Re-enter extended session and retry.',
};

/* ─── Default security algorithms ─────────────────────────────────────────
 * SBEC formula: key = (seed * 4 + 0x9018) & 0xFFFFFFFF
 * Used by ADCM / many Chrysler modules.  Callers may substitute any function
 * that takes a 32-bit seed number and returns a 32-bit key number. */
export function sbecAlgo(seed) {
  return ((seed * 4 + 0x9018) >>> 0);
}

/* ─── Internal helpers ───────────────────────────────────────────────────── */
function hx(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, '0'); }
function bytesToHex(arr) { return Array.from(arr).map(b => hx(b)).join(' '); }

function nrcFrom(d) {
  if (!d || d.length < 3) return null;
  return d[0] === 0x7F ? d[2] : null;
}

/* Wait for a positive response or surface a readable NRC/timeout error. */
async function expectPositive(engine, tx, rx, payload, description, timeoutMs) {
  const r = await engine.uds(tx, rx, payload, timeoutMs);
  if (!r.ok) {
    return { ok: false, error: `${description} — ${IMMO_ERR.TIMEOUT}` };
  }
  const nrc = nrcFrom(r.d);
  if (nrc !== null) {
    return { ok: false, nrc, error: `${description} refused: ${immoNrcMsg(nrc)}` };
  }
  return { ok: true, d: r.d };
}

/* ─── connectImmoModule ────────────────────────────────────────────────────
 * Open an extended diagnostic session with the RFHUB/SKREEM module and
 * confirm it is alive.  Must be called before any other operation.
 *
 * Returns { ok, moduleInfo? } where moduleInfo contains raw firmware ID bytes
 * if the module responded to a 0x1A 0x90 (ReadEcuId) probe. */
export async function connectImmoModule(engine, { tx, rx } = DEFAULT_ADDR) {
  const session = await expectPositive(engine, tx, rx, [0x10, 0x03],
    'Enter extended session (10 03)', 2000);
  if (!session.ok) return session;
  const id = await engine.uds(tx, rx, [0x1A, 0x90], 2000);
  const moduleInfo = (id.ok && id.d && id.d[0] !== 0x7F)
    ? bytesToHex(id.d) : null;
  return { ok: true, moduleInfo };
}

/* ─── performSecurityAccess ────────────────────────────────────────────────
 * Run the standard seed/key handshake (27 01 → 27 02) with the provided
 * algorithm function.  `level` is the security sub-function pair:
 *   1 → sub-fns 0x01/0x02  (read-only, used for PIN read)
 *   3 → sub-fns 0x03/0x04  (write-enable, used for key programming)
 *
 * Returns { ok, seed, key } or { ok:false, nrc, error }. */
export async function performSecurityAccess(engine, { tx, rx } = DEFAULT_ADDR, {
  level = 1,
  algoFn = sbecAlgo,
} = {}) {
  const seedSub = (level === 3) ? 0x03 : 0x01;
  const keySub  = (level === 3) ? 0x04 : 0x02;

  const seedRes = await expectPositive(engine, tx, rx, [0x27, seedSub],
    `Security access seed (27 ${hx(seedSub)})`, 4000);
  if (!seedRes.ok) return seedRes;

  const d = Array.from(seedRes.d);
  if (d.length < 3) {
    return { ok: false, error: 'Seed response too short — module may not support this security level.' };
  }
  const seedBytes = d.slice(1);
  let sv = 0;
  for (const b of seedBytes.slice(-4)) sv = ((sv << 8) | b) >>> 0;
  const key = (algoFn(sv) >>> 0);
  const keyBytes = [
    (key >> 24) & 0xFF,
    (key >> 16) & 0xFF,
    (key >> 8)  & 0xFF,
    key & 0xFF,
  ];
  const keyRes = await expectPositive(engine, tx, rx, [0x27, keySub, ...keyBytes],
    `Security access key (27 ${hx(keySub)})`, 4000);
  if (!keyRes.ok) return keyRes;

  return { ok: true, seed: sv, key };
}

/* ─── readPin ──────────────────────────────────────────────────────────────
 * Full Alfa-OBD–style PIN extraction flow:
 *   1. Enter extended session.
 *   2. Security access (read level).
 *   3. Read Data By Local Identifier 0x10 (RFHUB SEC16 block, 16 bytes).
 *      Fallback: Read Data By Common Identifier 0xF100.
 *   4. Extract PIN from bytes [14..15] (same formula as rfhPcmPair.js).
 *
 * Returns { ok, pinDec, sec16Raw, sec16Hex } or { ok:false, error }. */
export async function readPin(engine, { tx, rx } = DEFAULT_ADDR, { algoFn = sbecAlgo } = {}) {
  const conn = await connectImmoModule(engine, { tx, rx });
  if (!conn.ok) return conn;

  const sa = await performSecurityAccess(engine, { tx, rx }, { level: 1, algoFn });
  if (!sa.ok) return sa;

  let sec16Raw = null;

  const r1 = await engine.uds(tx, rx, [0x21, 0x10], 3000);
  if (r1.ok && r1.d && r1.d[0] !== 0x7F && r1.d.length >= 17) {
    sec16Raw = Array.from(r1.d).slice(1, 17);
  }

  if (!sec16Raw) {
    const r2 = await engine.uds(tx, rx, [0x22, 0xF1, 0x00], 3000);
    if (r2.ok && r2.d && r2.d[0] !== 0x7F && r2.d.length >= 18) {
      sec16Raw = Array.from(r2.d).slice(2, 18);
    }
  }

  if (!sec16Raw || sec16Raw.length < 16) {
    return { ok: false, error: 'Module did not return SEC16 data. The module may use a different DID — try a firmware-specific scan.' };
  }

  const blank = sec16Raw.every(b => b === 0xFF || b === 0x00);
  if (blank) {
    return { ok: false, error: 'SEC16 block is blank (all-FF/00) — module may be virgin or unpaired.' };
  }

  const pinDec = (((sec16Raw[14] << 8) | sec16Raw[15]) & 0xFFFF)
    .toString().padStart(5, '0');
  const sec16Hex = bytesToHex(sec16Raw);

  return { ok: true, pinDec, sec16Raw, sec16Hex };
}

/* ─── readKeySlots ─────────────────────────────────────────────────────────
 * Read current key slot occupancy from the live module without a dump.
 *   1. Enter extended session (re-use if already open).
 *   2. Read key slot status via Read Data By Local Identifier 0x11
 *      (RFHUB slot table, 1 byte per slot: 0x01=occupied, 0x00=empty).
 *      Fallback: 0x22 0xF1 0x01.
 *   3. Parse the response into a slot array.
 *
 * Returns { ok, slots: [{idx, occupied}] } or { ok:false, error }. */
export async function readKeySlots(engine, { tx, rx } = DEFAULT_ADDR) {
  const conn = await connectImmoModule(engine, { tx, rx });
  if (!conn.ok) return conn;

  let slotBytes = null;

  const r1 = await engine.uds(tx, rx, [0x21, 0x11], 3000);
  if (r1.ok && r1.d && r1.d[0] !== 0x7F && r1.d.length >= 2) {
    slotBytes = Array.from(r1.d).slice(1);
  }

  if (!slotBytes) {
    const r2 = await engine.uds(tx, rx, [0x22, 0xF1, 0x01], 3000);
    if (r2.ok && r2.d && r2.d[0] !== 0x7F && r2.d.length >= 3) {
      slotBytes = Array.from(r2.d).slice(2);
    }
  }

  if (!slotBytes) {
    const r3 = await engine.uds(tx, rx, [0x21, 0x01], 3000);
    if (r3.ok && r3.d && r3.d[0] !== 0x7F && r3.d.length >= 9) {
      const raw = Array.from(r3.d).slice(1);
      slotBytes = raw.slice(0, LIVE_KEY_SLOT_COUNT).map(b => (b === 0xAA ? 0x01 : 0x00));
    }
  }

  const slots = Array.from({ length: LIVE_KEY_SLOT_COUNT }, (_, i) => ({
    idx: i,
    occupied: slotBytes ? !!(slotBytes[i] & 0x01) : false,
    raw: slotBytes ? (slotBytes[i] ?? null) : null,
  }));

  const occupiedCount = slots.filter(s => s.occupied).length;
  return { ok: true, slots, occupiedCount, raw: slotBytes };
}

/* ─── enterKeyLearn ────────────────────────────────────────────────────────
 * Enter key-learn mode after security access.  Sequence:
 *   1. Enter extended session.
 *   2. Security access (write level, 0x03/0x04).
 *   3. Start routine 0x0203 (SKREEM/RFHUB key-learn entry).
 *
 * Returns { ok } or { ok:false, error }. */
export async function enterKeyLearn(engine, { tx, rx } = DEFAULT_ADDR, {
  algoFn = sbecAlgo,
} = {}) {
  const conn = await connectImmoModule(engine, { tx, rx });
  if (!conn.ok) return conn;

  const sa = await performSecurityAccess(engine, { tx, rx }, { level: 3, algoFn });
  if (!sa.ok) return sa;

  const r = await expectPositive(engine, tx, rx,
    [0x31, 0x01, 0x02, 0x03],
    'Start key-learn routine (31 01 02 03)', 5000);
  if (!r.ok) return r;

  return { ok: true };
}

/* ─── confirmKeyLearned ────────────────────────────────────────────────────
 * Poll the module for a new-transponder-detected acknowledgement.
 * The module responds with 71 02 03 xx where xx encodes which slot was used.
 *
 * `timeoutMs` is the total window to wait for the ignition cycle +
 * transponder presentation (default 30 s — operator needs time). */
export async function confirmKeyLearned(engine, { tx, rx } = DEFAULT_ADDR, {
  timeoutMs = 30000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.min(3000, deadline - Date.now());
    if (remaining <= 0) break;
    const r = await engine.uds(tx, rx, [0x31, 0x03, 0x02, 0x03], remaining);
    if (r.ok && r.d && r.d[0] !== 0x7F) {
      const d = Array.from(r.d);
      if (d[0] === 0x71 && d.length >= 4) {
        const slotIdx = d[3] & 0x0F;
        return { ok: true, slotIdx };
      }
      if (d[0] === 0x71) {
        return { ok: true, slotIdx: null };
      }
    }
    await new Promise(res => setTimeout(res, 500));
  }
  return { ok: false, error: IMMO_ERR.NO_TRANSPONDER };
}

/* ─── exitKeyLearn ─────────────────────────────────────────────────────────
 * Stop the key-learn routine and exit back to a normal session. */
export async function exitKeyLearn(engine, { tx, rx } = DEFAULT_ADDR) {
  const r = await engine.uds(tx, rx, [0x31, 0x02, 0x02, 0x03], 3000);
  await engine.uds(tx, rx, [0x10, 0x01], 1000);
  if (!r.ok) return { ok: false, error: 'Exit key-learn routine did not acknowledge — module may have already exited.' };
  const nrc = nrcFrom(r.d);
  if (nrc !== null) return { ok: false, nrc, error: immoNrcMsg(nrc) };
  return { ok: true };
}

/* ─── eraseAllKeys ─────────────────────────────────────────────────────────
 * Erase all programmed transponders.  Sequence:
 *   1. Extended session + write-level security access.
 *   2. Start routine 0x0204 (SKREEM/RFHUB erase-all).
 *   3. Wait for positive response.
 *
 * WARNING: this is irreversible without a backup.  The caller MUST show
 * a confirmation dialog before calling this function. */
export async function eraseAllKeys(engine, { tx, rx } = DEFAULT_ADDR, {
  algoFn = sbecAlgo,
} = {}) {
  const conn = await connectImmoModule(engine, { tx, rx });
  if (!conn.ok) return conn;

  const sa = await performSecurityAccess(engine, { tx, rx }, { level: 3, algoFn });
  if (!sa.ok) return sa;

  const r = await expectPositive(engine, tx, rx,
    [0x31, 0x01, 0x02, 0x04],
    'Erase all keys routine (31 01 02 04)', 8000);
  if (!r.ok) return r;

  return { ok: true };
}

/* ─── SEC16 live-write recipes (Task #678) ─────────────────────────────────
 * Each recipe describes how a specific module family accepts a SEC16
 * write over UDS. The `build(sec16)` callback assembles the request
 * frame; `verify` (optional) builds a read-back request and `extract`
 * pulls the 16-byte SEC16 out of the positive response so writeSec16()
 * can confirm the new bytes are actually live on the module before
 * declaring success. The recipes are listed here (not inline in
 * writeSec16) so the UI can offer the operator an explicit picker —
 * we never want to auto-guess a recipe and write the wrong frame to a
 * production ECU.
 *
 *   RFHUB_GEN2_DID_F102      Gen2 24C32 RFHUB — WriteDataByIdentifier
 *                            0x2E F1 02 + 16 bytes. Read-back via 0x22.
 *   RFHUB_XC2268_ROUTINE     2019+ Ram XC2268N RFHUB — RoutineControl
 *                            0x31 01 02 10 + 16 bytes. No standard
 *                            read-back DID; pre/post compare not done
 *                            here (caller must verify via key-program
 *                            attempt).
 *   BCM_DID_5320             BCM split-record SEC16 — WriteDataByIdentifier
 *                            0x2E 53 20 + 16 bytes BCM-form (reverse of
 *                            RFHUB SEC16). Read-back via 0x22 53 20.
 *   E95640_BLOCK_0838        95640 external EEPROM SEC16 @ 0x838 —
 *                            WriteMemoryByAddress 0x3D <addr...> + 16
 *                            bytes BCM-form. Read-back via 0x23.
 *
 * These payloads are derived from the existing offline writers in
 * securityBytes.js + the standard FCA UDS/0x27 vocabulary. They are
 * NOT bench-verified end-to-end; the writeSec16() flow surfaces every
 * tx/rx byte so a tech can pause before committing and the
 * `bench-override` UI gate is the second line of defence. */

function reverse16(arr) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = arr[15 - i];
  return out;
}

export const SEC16_WRITE_RECIPES = {
  RFHUB_GEN2_DID_F102: {
    id: 'RFHUB_GEN2_DID_F102',
    label: 'RFHUB Gen2 — DID 0xF102 (WriteDataByIdentifier)',
    target: 'RFHUB',
    securityLevel: 3, /* standard 0x27 0x03/0x04 */
    sec16Form: 'rfh',
    build(sec16) {
      return new Uint8Array([0x2E, 0xF1, 0x02, ...sec16]);
    },
    verify: {
      build() { return new Uint8Array([0x22, 0xF1, 0x02]); },
      extract(resp) {
        if (!resp || resp.length < 19 || resp[0] !== 0x62) return null;
        return Array.from(resp).slice(3, 19);
      },
    },
  },
  RFHUB_XC2268_ROUTINE: {
    id: 'RFHUB_XC2268_ROUTINE',
    label: '2019+ Ram XC2268 RFHUB — Routine 0x0210 (live-only platform)',
    target: 'RFHUB',
    securityLevel: 3, /* XC2268N uses the same 0x27 0x03/0x04 pair */
    sec16Form: 'rfh',
    build(sec16) {
      return new Uint8Array([0x31, 0x01, 0x02, 0x10, ...sec16]);
    },
    verify: null,
  },
  BCM_DID_5320: {
    id: 'BCM_DID_5320',
    label: 'BCM — DID 0x5320 (WriteDataByIdentifier, BCM-form)',
    target: 'BCM',
    securityLevel: 3, /* BCM SEC16 write is a level-3 protected DID */
    sec16Form: 'bcm',
    build(sec16) {
      const bcmForm = reverse16(sec16);
      return new Uint8Array([0x2E, 0x53, 0x20, ...bcmForm]);
    },
    verify: {
      build() { return new Uint8Array([0x22, 0x53, 0x20]); },
      extract(resp) {
        if (!resp || resp.length < 19 || resp[0] !== 0x62) return null;
        /* BCM returns BCM-form; reverse back to RFH-form for compare. */
        const bcm = Array.from(resp).slice(3, 19);
        return reverse16(new Uint8Array(bcm));
      },
    },
  },
  E95640_BLOCK_0838: {
    id: 'E95640_BLOCK_0838',
    label: '95640 EEPROM — WriteMemoryByAddress @ 0x0838 (BCM-form)',
    target: '95640',
    /* 95640 raw block uses the alternate level 0x27 0x0B / 0x0C
     * unlock — this is the path required by the WK2/WD service-port
     * write tools when the BCM is in its programming session. */
    securityLevel: 0x0B,
    sec16Form: 'bcm',
    build(sec16) {
      const bcmForm = reverse16(sec16);
      /* AddressAndLengthFormatIdentifier 0x14 = 1-byte length, 4-byte address. */
      return new Uint8Array([0x3D, 0x14, 0x00, 0x00, 0x08, 0x38, 0x10, ...bcmForm]);
    },
    verify: {
      build() { return new Uint8Array([0x23, 0x14, 0x00, 0x00, 0x08, 0x38, 0x10]); },
      extract(resp) {
        if (!resp || resp.length < 17 || resp[0] !== 0x63) return null;
        const bcm = Array.from(resp).slice(1, 17);
        return reverse16(new Uint8Array(bcm));
      },
    },
  },
};

function bytesEqual16(a, b) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return false;
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

import { logSec16Sync } from './sec16SyncLog.js';
import { classifyPlatform } from './sec16Platforms.js';

/* ─── writeSec16 ────────────────────────────────────────────────────────────
 * Task #678 — live SEC16 writer with module-specific recipe.
 *
 * Flow:
 *   1. Connect (extended session) on the supplied address.
 *   2. Security access at write level (0x03/0x04) with the supplied algo.
 *   3. Optional read-back BEFORE the write so the caller can audit the
 *      pre-state ("before").
 *   4. Send the recipe-built write frame; surface raw tx/rx bytes + NRC.
 *   5. Optional read-back AFTER the write; compare against the requested
 *      SEC16 (in RFH-form). If the recipe has no verify, returns
 *      `verified:'unverified'` so the caller can decide whether to trust
 *      the positive write response or require a separate bench check.
 *
 * Inputs
 *   engine        — bridge engine with .uds(tx,rx,bytes,timeout)
 *   { tx, rx }    — module address pair
 *   {
 *     sec16        Uint8Array(16) — target SEC16 in RFH form
 *     recipe       SEC16_WRITE_RECIPES[*] (or its id string)
 *     algoFn       seed→key function for 0x27 0x03/0x04
 *     timeoutMs    per-frame timeout (default 5000)
 *   }
 *
 * Returns
 *   {
 *     ok, error?, nrc?,
 *     recipeId,
 *     before:   Uint8Array(16)|null,
 *     written:  Uint8Array(16),
 *     after:    Uint8Array(16)|null,
 *     verified: 'match'|'mismatch'|'unverified'|'read-error',
 *     txFrame:  Uint8Array,
 *     rxFrame:  Uint8Array,
 *   }
 */
export async function writeSec16(engine, { tx, rx } = DEFAULT_ADDR, {
  sec16,
  recipe,
  algoFn = sbecAlgo,
  timeoutMs = 5000,
  vin = null,
  operator = null,
  notes = null,
} = {}) {
  if (!sec16 || sec16.length !== 16) {
    return { ok: false, error: 'sec16 must be a 16-byte Uint8Array (RFH form).' };
  }
  const target = sec16 instanceof Uint8Array ? sec16 : new Uint8Array(sec16);
  const r = (typeof recipe === 'string') ? SEC16_WRITE_RECIPES[recipe] : recipe;
  if (!r || typeof r.build !== 'function') {
    return { ok: false, error: 'Unknown SEC16 write recipe — pick one from SEC16_WRITE_RECIPES.' };
  }

  /* Task #678 — fire-and-forget audit on EVERY attempt (success or
   * failure). Pre-bound so each early return below can call it. */
  const auditFail = (stage, extra = {}) => logSec16Sync({
    vin,
    platform: vin ? classifyPlatform({ vin }).platform : null,
    actionId: 'live-sec16-write',
    target: r.target || 'RFHUB',
    recipeId: r.id,
    verified: 'read-error',
    operator,
    notes: notes ? `${notes} | failed @ ${stage}` : `failed @ ${stage}`,
    detail: { stage, ...extra },
  });

  const conn = await connectImmoModule(engine, { tx, rx });
  if (!conn.ok) { void auditFail('connect', { error: conn.error || null }); return { ...conn, recipeId: r.id }; }

  /* Per-recipe security level — falls back to 3 for legacy recipes that
   * predate the field. 95640 uses the 0x0B/0x0C alternate level. */
  const saLevel = (typeof r.securityLevel === 'number') ? r.securityLevel : 3;
  const sa = await performSecurityAccess(engine, { tx, rx }, { level: saLevel, algoFn });
  if (!sa.ok) { void auditFail('security-access', { error: sa.error || null, nrc: sa.nrc ?? null, level: saLevel }); return { ...sa, recipeId: r.id }; }

  /* Pre-write read-back (best-effort — failures here do not abort). */
  let before = null;
  if (r.verify) {
    const rbReq = r.verify.build();
    const rb = await engine.uds(tx, rx, Array.from(rbReq), timeoutMs);
    if (rb.ok && rb.d) {
      const extracted = r.verify.extract(rb.d);
      if (extracted) before = new Uint8Array(extracted);
    }
  }

  /* Write. */
  const txFrame = r.build(target);
  const w = await engine.uds(tx, rx, Array.from(txFrame), timeoutMs);
  const rxFrame = (w && w.d) ? new Uint8Array(w.d) : new Uint8Array();
  if (!w.ok) {
    void auditFail('write-timeout', { txFrame: Array.from(txFrame) });
    return {
      ok: false,
      error: `SEC16 write timed out — ${IMMO_ERR.TIMEOUT}`,
      recipeId: r.id, before, written: target, after: null,
      verified: 'read-error', txFrame, rxFrame,
    };
  }
  const nrc = nrcFrom(rxFrame);
  if (nrc !== null) {
    void auditFail('write-nrc', { nrc, txFrame: Array.from(txFrame), rxFrame: Array.from(rxFrame) });
    return {
      ok: false, nrc,
      error: `SEC16 write refused: ${immoNrcMsg(nrc)}`,
      recipeId: r.id, before, written: target, after: null,
      verified: 'read-error', txFrame, rxFrame,
    };
  }

  /* Post-write read-back + compare. */
  let after = null;
  let verified = 'unverified';
  if (r.verify) {
    const rbReq = r.verify.build();
    const rb = await engine.uds(tx, rx, Array.from(rbReq), timeoutMs);
    if (rb.ok && rb.d) {
      const extracted = r.verify.extract(rb.d);
      if (extracted) {
        after = new Uint8Array(extracted);
        verified = bytesEqual16(after, target) ? 'match' : 'mismatch';
      } else {
        verified = 'read-error';
      }
    } else {
      verified = 'read-error';
    }
  }

  /* Task #678 — fire-and-forget audit log. Never blocks the writer
   * result; the helper swallows all errors. */
  void logSec16Sync({
    vin,
    platform: vin ? classifyPlatform({ vin }).platform : null,
    actionId: 'live-sec16-write',
    target: r.target || 'RFHUB',
    recipeId: r.id,
    verified,
    operator,
    notes,
    detail: {
      txFrame: Array.from(txFrame),
      rxFrame: Array.from(rxFrame),
      written: Array.from(target),
      before: before ? Array.from(before) : null,
      after: after ? Array.from(after) : null,
    },
  });

  return {
    ok: verified !== 'mismatch',
    recipeId: r.id,
    before,
    written: target,
    after,
    verified,
    txFrame,
    rxFrame,
    error: verified === 'mismatch'
      ? 'SEC16 write returned a positive response but read-back does not match the target bytes.'
      : undefined,
  };
}

/* ─── Shared PIN-from-SEC16 helper ─────────────────────────────────────────
 * Accepts a raw 16-byte array (same layout as rfhPcmPair.js parseSec16) and
 * returns the 5-digit PIN string. Exported so both dump-based and live paths
 * can share this single function. */
export function pinFromSec16(raw) {
  if (!raw || raw.length < 16) return null;
  const pin = (((raw[14] << 8) | raw[15]) & 0xFFFF)
    .toString().padStart(5, '0');
  return pin;
}

/* ─── Audit helper ──────────────────────────────────────────────────────────
 * Write a live-immo audit entry into the same localStorage ring buffer the
 * dump-based Key Manager uses (srt-lab.keymgr.audit.v1) so all immo events
 * show up in the History audit trail. */
export function appendLiveImmoAudit(entry) {
  try {
    const KEY = 'srt-lab.keymgr.audit.v1';
    const LIMIT = 500;
    const raw = globalThis.localStorage?.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push({ ts: new Date().toISOString(), source: 'live-immo', ...entry });
    while (arr.length > LIMIT) arr.shift();
    globalThis.localStorage?.setItem(KEY, JSON.stringify(arr));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('srtlab:audit', { detail: entry }));
    }
  } catch { /* localStorage may be denied — silent ok */ }
}
