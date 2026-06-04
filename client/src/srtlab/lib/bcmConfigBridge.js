/**
 * bcmConfigBridge.js — drive a live BCM Configuration read/unlock/write
 * for DIDs 0xDE00..0xDE0C via the J2534 HTTP bridge daemon.
 *
 * Mirrors proxiBridge.js exactly:
 *
 *   10 03               DiagnosticSessionControl — extended
 *   22 DE nn            ReadDataByIdentifier  (per DID)
 *   27 01 / 27 02       SecurityAccess seed/key (cfBCM, shared with PROXI)
 *   2E DE nn [bytes]    WriteDataByIdentifier (per DID)
 *   11 01               ECUReset — hard
 *
 * The unlock helper is re-exported from proxiBridge so we share the
 * exact same cfBCM seed/key handshake — no second algorithm to
 * maintain. Tests can inject a fake `{ uds: async (tx,rx,frame) => ({ok,d}) }`
 * to exercise the full sequence without touching real hardware.
 */

import { createBridgeEngine } from './bridgeEngine.js';
import {
  unlockBcmForProxi,
  BCM_TX_DEFAULT,
  BCM_RX_DEFAULT,
} from './proxiBridge.js';
import {
  BCM_CONFIG_DIDS,
  didPayloadByteLength,
} from './bcmConfigCodec.js';

export { BCM_TX_DEFAULT, BCM_RX_DEFAULT, BCM_CONFIG_DIDS };
export const unlockBcmForConfig = unlockBcmForProxi;

function hx(n, w = 2) {
  return n.toString(16).toUpperCase().padStart(w, '0');
}

function nrcOf(d) {
  return d && d.length >= 3 && d[0] === 0x7F ? d[2] : null;
}

/**
 * Open the bridge channel (if not provided), enter extended session,
 * read one BCM Configuration DID. Returns
 * { ok, engine, payload?, did, tx, rx, error?, nrc? }.
 */
export async function readBcmConfigDid({
  addLog,
  bridgeUrl,
  tx = BCM_TX_DEFAULT,
  rx = BCM_RX_DEFAULT,
  did,
  engine: providedEngine = null,
  enterSession = true,
} = {}) {
  const log = (m, t = 'info') => { try { addLog && addLog(m, t); } catch {} };
  if (typeof did !== 'number') {
    return { ok: false, error: 'did required' };
  }

  let eng = providedEngine;
  if (!eng) {
    const br = await createBridgeEngine({ addLog, url: bridgeUrl });
    if (!br.ok) return { ok: false, error: br.error };
    eng = br.engine;
  }

  if (enterSession) {
    log('Entering extended session (10 03)...', 'info');
    const ds = await eng.uds(tx, rx, [0x10, 0x03]);
    if (!ds.ok || !ds.d) {
      return { ok: false, engine: eng, error: '10 03 no response: ' + (ds.raw || '') };
    }
    if (ds.d[0] === 0x7F) {
      return { ok: false, engine: eng, nrc: ds.d[2], error: '10 03 NRC 0x' + hx(ds.d[2]) };
    }
    if (ds.d[0] !== 0x50) {
      return { ok: false, engine: eng, error: 'Unexpected 10 03 opcode 0x' + hx(ds.d[0]) };
    }
  }

  const didHi = (did >> 8) & 0xFF;
  const didLo = did & 0xFF;
  log(`Reading 0x${hx(did, 4)} (22 ${hx(didHi)} ${hx(didLo)})...`, 'info');
  const r = await eng.uds(tx, rx, [0x22, didHi, didLo]);
  if (!r.ok || !r.d) {
    return { ok: false, engine: eng, did, tx, rx, error: `22 ${hx(didHi)} ${hx(didLo)} no response: ` + (r.raw || '') };
  }
  const nrc = nrcOf(r.d);
  if (nrc != null) {
    return { ok: false, engine: eng, nrc, did, tx, rx, error: `22 ${hx(didHi)} ${hx(didLo)} NRC 0x${hx(nrc)}` };
  }
  if (r.d[0] !== 0x62) {
    return { ok: false, engine: eng, did, tx, rx, error: 'Unexpected RDBI opcode 0x' + hx(r.d[0]) };
  }
  const payload = new Uint8Array(Array.from(r.d).slice(3));
  log(`✓ 0x${hx(did, 4)} ${payload.length} B`, 'rx');
  return { ok: true, engine: eng, payload, did, tx, rx };
}

/**
 * Read every BCM Configuration DID in one session. Returns
 * { ok, engine, results: { [did]: {ok, payload?, error?, nrc?} } }.
 */
export async function readAllBcmConfigDids({
  addLog,
  bridgeUrl,
  tx = BCM_TX_DEFAULT,
  rx = BCM_RX_DEFAULT,
  engine: providedEngine = null,
  dids = BCM_CONFIG_DIDS,
} = {}) {
  const results = {};
  let eng = providedEngine;
  if (!eng) {
    const br = await createBridgeEngine({ addLog, url: bridgeUrl });
    if (!br.ok) return { ok: false, error: br.error, results };
    eng = br.engine;
  }
  let first = true;
  for (const did of dids) {
    // eslint-disable-next-line no-await-in-loop
    const r = await readBcmConfigDid({
      addLog, tx, rx, did, engine: eng, enterSession: first,
    });
    first = false;
    if (r.engine) eng = r.engine;
    results[did] = r.ok
      ? { ok: true, payload: r.payload }
      : { ok: false, error: r.error, nrc: r.nrc };
  }
  return { ok: true, engine: eng, results };
}

/**
 * Write a single BCM Configuration DID (assumes BCM is already unlocked).
 * Optionally issues an ECU reset afterwards. Returns
 * { ok, written?, nrc?, error?, resetResult? }.
 *
 * Refuses to send a payload whose length does not match the catalog —
 * this prevents truncated writes that would silently zero half the
 * DID's bits.
 */
export async function writeBcmConfigDid(eng, did, payload, {
  addLog,
  tx = BCM_TX_DEFAULT,
  rx = BCM_RX_DEFAULT,
  reset = false,
  enforceLength = true,
} = {}) {
  const log = (m, t = 'info') => { try { addLog && addLog(m, t); } catch {} };
  if (!eng || typeof eng.uds !== 'function') return { ok: false, error: 'no engine' };
  if (typeof did !== 'number') return { ok: false, error: 'did required' };
  if (!payload || !(payload instanceof Uint8Array)) {
    return { ok: false, error: 'payload must be Uint8Array' };
  }
  if (enforceLength) {
    const want = didPayloadByteLength(did);
    if (want > 0 && payload.length !== want) {
      return {
        ok: false,
        error: `payload length ${payload.length} ≠ catalog ${want} B for 0x${hx(did, 4)}`,
      };
    }
  }

  const didHi = (did >> 8) & 0xFF;
  const didLo = did & 0xFF;
  log(`Writing 0x${hx(did, 4)} (2E ${hx(didHi)} ${hx(didLo)}, ${payload.length} B)...`, 'info');
  const frame = [0x2E, didHi, didLo, ...Array.from(payload)];
  const r = await eng.uds(tx, rx, frame);
  if (!r.ok || !r.d) {
    return { ok: false, written: payload, error: '2E no response: ' + (r.raw || '') };
  }
  const nrc = nrcOf(r.d);
  if (nrc != null) {
    return { ok: false, written: payload, nrc, error: `2E NRC 0x${hx(nrc)}` };
  }
  if (r.d[0] !== 0x6E) {
    return { ok: false, written: payload, error: 'unexpected WDBI opcode 0x' + hx(r.d[0]) };
  }
  log(`✓ 0x${hx(did, 4)} write accepted (6E)`, 'rx');

  let resetResult = null;
  if (reset) {
    log('Sending ECU reset (11 01)...', 'info');
    const rr = await eng.uds(tx, rx, [0x11, 0x01]);
    if (!rr.ok || !rr.d) {
      const msg = '11 01 reset: no response: ' + (rr.raw || '');
      log('⚠ ' + msg, 'warn');
      resetResult = { ok: false, error: msg };
      return { ok: false, written: payload, resetResult, error: msg };
    }
    const rNrc = nrcOf(rr.d);
    if (rNrc != null) {
      const msg = '11 01 reset NRC 0x' + hx(rNrc);
      log('⚠ ' + msg, 'warn');
      resetResult = { ok: false, nrc: rNrc, error: msg };
      return { ok: false, written: payload, resetResult, error: msg };
    }
    if (rr.d[0] !== 0x51) {
      const msg = 'unexpected reset opcode 0x' + hx(rr.d[0]);
      log('⚠ ' + msg, 'warn');
      resetResult = { ok: false, error: msg };
      return { ok: false, written: payload, resetResult, error: msg };
    }
    resetResult = { ok: true };
    log('✓ Reset accepted (51 01) — wait ~3 s for BCM to come back', 'rx');
  }
  return { ok: true, written: payload, resetResult };
}
