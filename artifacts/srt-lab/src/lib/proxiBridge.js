/**
 * proxiBridge.js — drive a live PROXI read/unlock/write against the BCM
 * via the J2534 HTTP bridge daemon (j2534_bridge.py).
 *
 * Wraps the UDS sequence documented in docs/fca-proxi-reference.md §6:
 *
 *   10 03               DiagnosticSessionControl — extended
 *   22 FD 01            ReadDataByIdentifier — PROXI DID  (← read flow)
 *   27 01 / 27 02       SecurityAccess seed/key (cfBCM)
 *   2E FD 01 [bytes]    WriteDataByIdentifier — PROXI DID (← write flow)
 *   11 01               ECUReset — hard
 *
 * Pre-SGW BCMs use DID 0xFD01; SGW-protected (2019+) platforms use 0xFD20.
 * The caller picks the DID; this module just transports the bytes.
 *
 * Each helper takes the bridge engine returned by createBridgeEngine() (so
 * tests can inject a fake `{ uds: async (tx,rx,frame) => ({ok,d}) }` and
 * exercise the full sequence without touching real hardware).
 */

import { createBridgeEngine } from './bridgeEngine.js';
import { cfBCM, cfCall16 } from './canflashAlgos.js';
import { parseProxi, serializeProxi } from './fcaProxi.js';

// Standard Chrysler BCM CAN IDs from unlock_catalog_extended.json.
export const BCM_TX_DEFAULT = 0x790;
export const BCM_RX_DEFAULT = 0x798;

// Pre-SGW PROXI DID. SGW-protected platforms use 0xFD20 instead.
export const PROXI_DID_NONSGW = 0xFD01;
export const PROXI_DID_SGW = 0xFD20;

function hx(n, w = 2) {
  return n.toString(16).toUpperCase().padStart(w, '0');
}

function nrcOf(d) {
  return d && d.length >= 3 && d[0] === 0x7F ? d[2] : null;
}

/**
 * Open the bridge channel, enter extended session, and read the PROXI DID.
 * Returns { ok, engine, parsed?, raw?, did, tx, rx, error?, nrc? }.
 *
 * The engine is returned even on read failure so the caller can re-use it
 * (e.g. retry against the SGW DID, or close the channel cleanly).
 */
export async function readProxiFromBcm({
  addLog,
  bridgeUrl,
  tx = BCM_TX_DEFAULT,
  rx = BCM_RX_DEFAULT,
  did = PROXI_DID_NONSGW,
  engine: providedEngine = null,
} = {}) {
  const log = (m, t = 'info') => { try { addLog && addLog(m, t); } catch {} };

  let eng = providedEngine;
  if (!eng) {
    const br = await createBridgeEngine({ addLog, url: bridgeUrl });
    if (!br.ok) return { ok: false, error: br.error };
    eng = br.engine;
  }

  log('Entering extended session (10 03)...', 'info');
  const ds = await eng.uds(tx, rx, [0x10, 0x03]);
  if (!ds.ok || !ds.d) {
    return { ok: false, engine: eng, error: '10 03 no response: ' + (ds.raw || '') };
  }
  if (ds.d[0] === 0x7F) {
    const nrc = ds.d[2];
    return { ok: false, engine: eng, nrc, error: '10 03 NRC 0x' + hx(nrc) };
  }
  if (ds.d[0] !== 0x50) {
    return { ok: false, engine: eng, error: 'Unexpected 10 03 opcode 0x' + hx(ds.d[0]) };
  }

  log(`Reading PROXI (22 ${hx((did >> 8) & 0xFF)} ${hx(did & 0xFF)})...`, 'info');
  const r = await eng.uds(tx, rx, [0x22, (did >> 8) & 0xFF, did & 0xFF]);
  if (!r.ok || !r.d) {
    return { ok: false, engine: eng, error: 'PROXI read no response: ' + (r.raw || '') };
  }
  const nrc = nrcOf(r.d);
  if (nrc != null) {
    return { ok: false, engine: eng, nrc, error: `22 ${hx((did >> 8) & 0xFF)} ${hx(did & 0xFF)} NRC 0x${hx(nrc)}` };
  }
  if (r.d[0] !== 0x62) {
    return { ok: false, engine: eng, error: 'Unexpected RDBI opcode 0x' + hx(r.d[0]) };
  }
  // Strip 0x62 + DID-hi + DID-lo
  const bytes = new Uint8Array(Array.from(r.d).slice(3));
  const parsed = parseProxi(bytes);
  if (!parsed.ok) {
    return { ok: false, engine: eng, parsed, raw: bytes, did, tx, rx, error: 'PROXI parse failed: ' + parsed.error };
  }
  log(`✓ PROXI ${bytes.length} B · ${parsed.sectionCount} sections · CRC 0x${hx(parsed.recordCrc, 4)} OK`, 'rx');
  return { ok: true, engine: eng, parsed, raw: bytes, did, tx, rx };
}

/**
 * Run the BCM 27 01 / 27 02 seed/key handshake using the canflash-verified
 * cfBCM algorithm (huntsville_bcm.dll). Most pre-SGW BCMs return a 2-byte
 * seed; we tolerate longer seeds by taking the trailing 2 bytes.
 *
 * Returns { ok, alreadyUnlocked?, nrc?, error? }.
 */
export async function unlockBcmForProxi(eng, {
  addLog,
  tx = BCM_TX_DEFAULT,
  rx = BCM_RX_DEFAULT,
} = {}) {
  const log = (m, t = 'info') => { try { addLog && addLog(m, t); } catch {} };
  if (!eng || typeof eng.uds !== 'function') return { ok: false, error: 'no engine' };

  log('Requesting BCM seed (27 01)...', 'info');
  const s = await eng.uds(tx, rx, [0x27, 0x01]);
  if (!s.ok || !s.d) return { ok: false, error: '27 01 no response: ' + (s.raw || '') };
  const sNrc = nrcOf(s.d);
  if (sNrc != null) return { ok: false, nrc: sNrc, error: '27 01 NRC 0x' + hx(sNrc) };
  if (s.d[0] !== 0x67 || s.d.length < 4) {
    return { ok: false, error: 'bad seed framing: ' + Array.from(s.d).map(b => hx(b)).join(' ') };
  }
  const seedBytes = Array.from(s.d).slice(2);
  if (!seedBytes.some(b => b !== 0)) {
    log('BCM already unlocked (zero seed)', 'rx');
    return { ok: true, alreadyUnlocked: true };
  }

  // cfBCM is 16-bit: take the last 2 bytes of whatever the module returned
  // (BCMs typically return exactly 2; SGW-style longer seeds also fit this
  // contract for the field-edit path documented in fca-proxi-reference.md §5).
  const seedPair = seedBytes.length === 2 ? seedBytes : seedBytes.slice(-2);
  const keyBytes = cfCall16(cfBCM, seedPair);
  log(`Sending BCM key (27 02 ${keyBytes.map(b => hx(b)).join(' ')})...`, 'info');
  const k = await eng.uds(tx, rx, [0x27, 0x02, ...keyBytes]);
  if (!k.ok || !k.d) return { ok: false, error: '27 02 no response: ' + (k.raw || '') };
  const kNrc = nrcOf(k.d);
  if (kNrc != null) return { ok: false, nrc: kNrc, error: '27 02 NRC 0x' + hx(kNrc) };
  if (k.d[0] !== 0x67) return { ok: false, error: 'bad key response opcode 0x' + hx(k.d[0]) };

  log('✓ BCM unlocked (cfBCM)', 'rx');
  return { ok: true };
}

/**
 * Serialize the (possibly-edited) PROXI object and write it back via
 * 0x2E + DID. Issues an ECU reset (0x11 0x01) afterwards so the BCM
 * latches the new configuration the same way the FCA tool does.
 *
 * Returns { ok, written?, nrc?, error? }.
 */
export async function writeProxiToBcm(eng, parsed, {
  addLog,
  tx = BCM_TX_DEFAULT,
  rx = BCM_RX_DEFAULT,
  did = PROXI_DID_NONSGW,
  reset = true,
} = {}) {
  const log = (m, t = 'info') => { try { addLog && addLog(m, t); } catch {} };
  if (!eng || typeof eng.uds !== 'function') return { ok: false, error: 'no engine' };
  if (!parsed || !Array.isArray(parsed.sections)) return { ok: false, error: 'no parsed PROXI to write' };

  const bytes = serializeProxi(parsed);
  log(`Writing PROXI (2E ${hx((did >> 8) & 0xFF)} ${hx(did & 0xFF)}, ${bytes.length} B)...`, 'info');
  const frame = [0x2E, (did >> 8) & 0xFF, did & 0xFF, ...Array.from(bytes)];
  const r = await eng.uds(tx, rx, frame);
  if (!r.ok || !r.d) return { ok: false, written: bytes, error: '2E no response: ' + (r.raw || '') };
  const nrc = nrcOf(r.d);
  if (nrc != null) return { ok: false, written: bytes, nrc, error: '2E NRC 0x' + hx(nrc) };
  if (r.d[0] !== 0x6E) return { ok: false, written: bytes, error: 'unexpected WDBI opcode 0x' + hx(r.d[0]) };

  log('✓ PROXI write accepted (6E)', 'rx');
  let resetResult = null;
  if (reset) {
    log('Sending ECU reset (11 01)...', 'info');
    const rr = await eng.uds(tx, rx, [0x11, 0x01]);
    if (!rr.ok || !rr.d) {
      // Write itself succeeded — surface the reset failure but do not
      // pretend the whole sequence was clean. Tech may need to power-
      // cycle the BCM manually.
      const msg = '11 01 reset: no response: ' + (rr.raw || '');
      log('⚠ ' + msg, 'warn');
      resetResult = { ok: false, error: msg };
      return { ok: false, written: bytes, resetResult, error: msg };
    }
    const rNrc = nrcOf(rr.d);
    if (rNrc != null) {
      const msg = '11 01 reset NRC 0x' + hx(rNrc);
      log('⚠ ' + msg, 'warn');
      resetResult = { ok: false, nrc: rNrc, error: msg };
      return { ok: false, written: bytes, resetResult, error: msg };
    }
    if (rr.d[0] !== 0x51) {
      const msg = 'unexpected reset opcode 0x' + hx(rr.d[0]);
      log('⚠ ' + msg, 'warn');
      resetResult = { ok: false, error: msg };
      return { ok: false, written: bytes, resetResult, error: msg };
    }
    resetResult = { ok: true };
    log('✓ Reset accepted (51 01) — wait ~3 s for BCM to come back', 'rx');
  }
  return { ok: true, written: bytes, resetResult };
}
