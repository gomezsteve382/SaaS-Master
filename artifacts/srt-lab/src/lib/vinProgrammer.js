/* vinProgrammer — universal VIN-write engine.

   programVin({eng, row, vin, addLog, makeBackup}) drives one module
   end-to-end:
     1. Verifies preflight: a successful 0x22 F190 (or row.vinDids[0]) read.
        We MUST see a positive response from the target before issuing
        any 0x2E — burning the wrong ECU is the worst possible outcome.
     2. Opens an extended diagnostic session (0x10 0x03).
     3. Runs the unlock chain via tryUnlock(). The chain is derived from
        pickUnlockChain(tx, code) when row.unlockId is absent, otherwise
        the row's unlockId is used as the preferred algorithm.
     4. (optional) Backs up the module via makeBackup if provided.
     5. Writes the VIN to every DID in row.vinDids (or vinWriteDids(code)
        when absent). Each write is verified by reading the same DID back
        and comparing via vinReadbackOk.
     6. Returns a structured result.

   The engine is pure JS, takes the uds engine as an argument, and never
   touches React state directly. The caller (Program-All UI or a
   per-module tab) is responsible for wiring the result into the UI.

   Result shape:
     {
       ok: boolean,                   // every step succeeded
       reason: string|null,           // one of 'preflight'|'unlock'|'write'|'verify'|null
       beforeVin: string|null,        // VIN read before the write
       afterVin: string|null,         // VIN read after the write (F190)
       unlockAlgo: string|true|false, // result of tryUnlock
       didResults: [                  // one entry per row.vinDids
         { did, wrote: boolean, readback: string, match: boolean }
       ],
       backupKey: string|null,        // key returned by makeBackup, if any
       errors: string[],              // structured error messages
     }
*/

import {
  encodeDid,
  vinWriteDids,
  vinFromReadResponse,
  vinReadbackOk,
  pickUnlockChain,
  tryUnlock,
  MOD_UNLOCK,
} from './algos.js';
import {decodeNRC} from './nrc.js';

const EXTENDED_SESSION = [0x10, 0x03];

// Read DID and return the trailing-17 ASCII chars (or 8 for tail-only DIDs)
// using vinFromReadResponse, which knows about both 16-bit and 24-bit DIDs.
async function readDid(uds, tx, rx, did) {
  const r = await uds(tx, rx, [0x22, ...encodeDid(did)]);
  if (!r || !r.ok || !r.d) return { ok: false, raw: r?.raw || '', value: '' };
  if (r.d[0] !== 0x62) return { ok: false, raw: r.raw || '', value: '', d: r.d };
  return { ok: true, raw: r.raw || '', value: vinFromReadResponse(r.d, did), d: r.d };
}

// Issue a 0x2E WriteDataByIdentifier and classify the response. Returns
// { ok, nrc, raw } — ok is true only on a 0x6E positive ack.
async function writeDid(uds, tx, rx, did, vin, addLog, label) {
  const vb = Array.from(vin).map(c => c.charCodeAt(0));
  const req = [0x2E, ...encodeDid(did), ...vb];
  const r = await uds(tx, rx, req);
  if (!r || !r.ok || !r.d) return { ok: false, nrc: null, raw: r?.raw || '' };
  if (r.d[0] === 0x6E) return { ok: true, nrc: null, raw: r.raw || '' };
  if (r.d[0] === 0x7F) {
    const nrc = r.d[2] || 0;
    addLog && addLog(`${label} 0x2E DID 0x${did.toString(16).toUpperCase()} NRC: ${decodeNRC(nrc)}`, 'warn');
    return { ok: false, nrc, raw: r.raw || '' };
  }
  return { ok: false, nrc: null, raw: r.raw || '' };
}

export async function programVin({ eng, row, vin, addLog, makeBackup } = {}) {
  const log = (m, t = 'info') => { try { addLog && addLog(m, t); } catch { /* ignore */ } };
  const result = {
    ok: false,
    reason: null,
    beforeVin: null,
    afterVin: null,
    unlockAlgo: null,
    didResults: [],
    backupKey: null,
    errors: [],
  };

  if (!eng || typeof eng.uds !== 'function') {
    result.reason = 'preflight';
    result.errors.push('No uds engine provided');
    return result;
  }
  if (!row || typeof row.tx !== 'number' || typeof row.rx !== 'number') {
    result.reason = 'preflight';
    result.errors.push('Invalid registry row');
    return result;
  }
  if (typeof vin !== 'string' || vin.length !== 17) {
    result.reason = 'preflight';
    result.errors.push('VIN must be exactly 17 chars');
    return result;
  }
  if (row.kind === 'unsupported' || row.kind === 'no-vin') {
    result.reason = 'preflight';
    result.errors.push(`Module ${row.code} is ${row.kind}; refusing to write`);
    return result;
  }
  if (row.unlockStatus === 'pending-w7') {
    result.reason = 'unlock';
    result.errors.push(`Module ${row.code} requires W7 cipher (translation pending — task #145)`);
    return result;
  }

  const lbl = row.code || ('0x' + row.tx.toString(16).toUpperCase());
  const dids = (row.vinDids && row.vinDids.length) ? row.vinDids : vinWriteDids(row.code);

  // Step 1 — preflight read. Refuses to proceed unless the module
  // responds with a positive 0x62 frame on the first VIN DID. Prevents
  // burning the wrong ECU when the bus address is misconfigured.
  log(`${lbl} preflight read 0x${dids[0].toString(16).toUpperCase()}…`, 'info');
  const pre = await readDid(eng.uds, row.tx, row.rx, dids[0]);
  if (!pre.ok) {
    result.reason = 'preflight';
    result.errors.push(`${lbl} preflight read failed (${pre.raw || 'no response'})`);
    log(`${lbl} ✗ preflight read failed — aborting (no write attempted)`, 'error');
    return result;
  }
  result.beforeVin = pre.value || null;
  log(`${lbl} current VIN: ${result.beforeVin || '(empty)'}`, 'rx');

  // Step 2 — extended session. Failures here are non-fatal; the unlock
  // step will catch a hostile ECU.
  await eng.uds(row.tx, row.rx, EXTENDED_SESSION);

  // Step 3 — unlock chain.
  if (row.unlockId) {
    // The registry's preferred unlockId trumps MOD_UNLOCK[code]. We
    // synthesize a fresh chain that starts with row.unlockId and
    // overlays whatever pickUnlockChain would have returned. Anything
    // already in the chain is de-duped.
    const baseChain = pickUnlockChain(row.tx, row.code);
    const chain = [row.unlockId, ...baseChain.filter(id => id !== row.unlockId)];
    // Patch MOD_UNLOCK ephemerally so tryUnlock picks our preferred
    // algo first. We never persist it — restored in finally.
    const prev = MOD_UNLOCK[row.code];
    MOD_UNLOCK[row.code] = row.unlockId;
    try {
      result.unlockAlgo = await tryUnlock(eng.uds, row.tx, row.rx, row.code, addLog, lbl);
    } finally {
      if (prev === undefined) delete MOD_UNLOCK[row.code]; else MOD_UNLOCK[row.code] = prev;
    }
    // chain is computed for diagnostics; not enforced beyond MOD_UNLOCK
    // override above.
    void chain;
  } else {
    result.unlockAlgo = await tryUnlock(eng.uds, row.tx, row.rx, row.code, addLog, lbl);
  }

  if (result.unlockAlgo === false) {
    result.reason = 'unlock';
    result.errors.push(`${lbl} all unlock algorithms exhausted`);
    return result;
  }

  // Step 4 — optional backup.
  if (typeof makeBackup === 'function') {
    try {
      const bk = await makeBackup({ uds: eng.uds, tx: row.tx, rx: row.rx, code: row.code, addLog: log });
      result.backupKey = bk?.key || null;
    } catch (e) {
      log(`${lbl} backup failed: ${e?.message || e} — continuing`, 'warn');
    }
  }

  // Step 5 — write each DID, then verify by re-read.
  let allWroteOk = true;
  let allVerifiedOk = true;
  for (const did of dids) {
    const w = await writeDid(eng.uds, row.tx, row.rx, did, vin, log, lbl);
    if (!w.ok) {
      allWroteOk = false;
      result.errors.push(`${lbl} write DID 0x${did.toString(16).toUpperCase()} failed (NRC ${w.nrc != null ? '0x' + w.nrc.toString(16).toUpperCase() : 'none'})`);
    }
    const rb = await readDid(eng.uds, row.tx, row.rx, did);
    const value = rb.value || '';
    const match = vinReadbackOk(did, value, vin);
    if (!match) {
      allVerifiedOk = false;
      log(`${lbl} ✗ verify DID 0x${did.toString(16).toUpperCase()}: read '${value}' (expected '${vin}')`, 'warn');
    } else {
      log(`${lbl} ✓ verify DID 0x${did.toString(16).toUpperCase()}`, 'rx');
    }
    result.didResults.push({ did, wrote: w.ok, readback: value, match });
  }

  // Step 6 — final F190 readback for the summary card.
  const fin = await readDid(eng.uds, row.tx, row.rx, dids[0]);
  result.afterVin = fin.value || null;

  if (!allWroteOk) result.reason = 'write';
  else if (!allVerifiedOk) result.reason = 'verify';
  else result.ok = true;

  return result;
}

export { readDid, writeDid };
