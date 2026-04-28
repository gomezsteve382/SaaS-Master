// GPEC2A bench-flasher state machine (Task #488).
//
// `flashEcm()` walks the standard Mopar UDS programming session:
//   1. Diagnostic Session Control 0x10 0x02 (programming session)
//   2. Security Access seed request 0x27 0x01
//   3. CDA6 key calculation
//   4. Security Access send key 0x27 0x02
//   5. RoutineControl erase memory 0x31 0x01 0xFF 0x00
//   6. Request Download 0x34
//   7. Transfer Data 0x36 (chunked, sequence counter wraps 0xFF -> 0x00)
//   8. Request Transfer Exit 0x37
//   9. RoutineControl checksum/verify 0x31 0x01 0xFF 0x01
//  10. ECU Reset 0x11 0x01
//
// The function returns an object with `start()` returning a Promise that
// resolves to a {ok, log, error, abortedAt} record. Progress and log
// events are emitted via the `onProgress`/`onLog` callbacks so the UI
// can stream them. The machine refuses to run unless `engine.isBridge`
// is truthy — the bench Autel bridge is the only engine that actually
// drives the cable.

import { cda6 } from './algos.js';
import { decodeNRC } from './nrc.js';

const ECM_ADDR = { tx: 0x7E0, rx: 0x7E8 };
const DEFAULT_CHUNK = 0x80; // 128 bytes — conservative for ISO-TP.

const PHASE = {
  CONNECT: 'connect',
  SESSION: 'session',
  SEED: 'seed',
  KEY: 'key',
  ERASE: 'erase',
  REQUEST_DOWNLOAD: 'request_download',
  TRANSFER: 'transfer',
  TRANSFER_EXIT: 'transfer_exit',
  CHECKSUM: 'checksum',
  RESET: 'reset',
  DONE: 'done',
  ABORTED: 'aborted',
  FAILED: 'failed',
};

function hex(n, w=2){
  return n.toString(16).toUpperCase().padStart(w, '0');
}

function explainNrc(d){
  if (!d || d.length < 3 || d[0] !== 0x7F) return null;
  const code = d[2];
  const meta = decodeNRC ? decodeNRC(code) : null;
  return { code, hex: '0x' + hex(code), text: (meta && meta.text) || (meta && meta.label) || ('NRC 0x' + hex(code)) };
}

// Decode the 0x74 RequestDownload positive response. The first nibble of
// the LFID byte tells us how many bytes encode `maxNumberOfBlockLength`.
function parseDownloadResponse(d){
  if (!d || d.length < 2 || d[0] !== 0x74) return null;
  const lfid = (d[1] >> 4) & 0x0F;
  if (lfid === 0 || d.length < 2 + lfid) return null;
  let max = 0;
  for (let i=0;i<lfid;i++) max = (max * 256) + d[2 + i];
  // `maxNumberOfBlockLength` includes the SID + sequence counter, so the
  // payload-per-frame is max - 2.
  const payload = Math.max(1, max - 2);
  return { maxNumberOfBlockLength: max, payloadPerFrame: payload };
}

// Build the 0x34 RequestDownload bytes: SID + dataFormatIdentifier +
// addressAndLengthFormatIdentifier + addr + len.
function buildRequestDownload(addr, length, dfi){
  const addrBytes = [(addr >>> 24) & 0xFF, (addr >>> 16) & 0xFF, (addr >>> 8) & 0xFF, addr & 0xFF];
  const lenBytes  = [(length >>> 24) & 0xFF, (length >>> 16) & 0xFF, (length >>> 8) & 0xFF, length & 0xFF];
  return [0x34, dfi & 0xFF, 0x44, ...addrBytes, ...lenBytes];
}

function buildEraseRoutine(addr, length, eraseRid){
  const rid = eraseRid != null ? eraseRid : 0xFF00;
  const addrBytes = [(addr >>> 24) & 0xFF, (addr >>> 16) & 0xFF, (addr >>> 8) & 0xFF, addr & 0xFF];
  const lenBytes  = [(length >>> 24) & 0xFF, (length >>> 16) & 0xFF, (length >>> 8) & 0xFF, length & 0xFF];
  return [0x31, 0x01, (rid >> 8) & 0xFF, rid & 0xFF, ...addrBytes, ...lenBytes];
}

function buildCheckRoutine(checkRid){
  const rid = checkRid != null ? checkRid : 0xFF01;
  return [0x31, 0x01, (rid >> 8) & 0xFF, rid & 0xFF];
}

function abortError(){
  const e = new Error('Aborted by user');
  e.aborted = true;
  return e;
}

function checkAborted(signal){
  if (signal && signal.aborted) throw abortError();
}

// Convert a payload (Uint8Array | number[] | ArrayBuffer) to Uint8Array.
function toBytes(p){
  if (!p) return new Uint8Array(0);
  if (p instanceof Uint8Array) return p;
  if (p instanceof ArrayBuffer) return new Uint8Array(p);
  if (Array.isArray(p)) return new Uint8Array(p);
  if (p.buffer instanceof ArrayBuffer) return new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength);
  throw new Error('Unsupported payload type for flashEcm');
}

// Public entry point. Synchronous setup; returns a controller with an
// async `start()` that streams progress.
export function flashEcm(opts){
  const {
    engine,
    payload,
    address = 0x00000000,
    chunkSize = DEFAULT_CHUNK,
    eraseAddress,
    eraseLength,
    eraseRid = 0xFF00,
    checkRid = 0xFF01,
    dataFormatIdentifier = 0x00,
    onProgress = () => {},
    onLog = () => {},
    signal,
    addr = ECM_ADDR,
  } = opts || {};

  const result = {
    ok: false,
    phase: PHASE.CONNECT,
    error: null,
    aborted: false,
    seed: null,
    key: null,
    bytesSent: 0,
    chunksSent: 0,
    maxNumberOfBlockLength: null,
    log: [],
  };

  function log(msg, level='info'){
    const entry = { t: Date.now(), level, msg };
    result.log.push(entry);
    try { onLog(entry); } catch {}
  }

  function progress(extra){
    try { onProgress({ ...extra, phase: result.phase, bytesSent: result.bytesSent, chunksSent: result.chunksSent }); } catch {}
  }

  function setPhase(p){ result.phase = p; progress({}); }

  async function call(bytes, label){
    checkAborted(signal);
    log(`TX ${label}: ${bytes.map(b => hex(b)).join(' ')}`, 'tx');
    const r = await engine.uds(addr.tx, addr.rx, bytes);
    if (!r || !r.ok){
      const err = new Error(`${label} failed: ${(r && r.error) || 'no response'}`);
      err.phase = result.phase;
      throw err;
    }
    const d = r.d || r.data || new Uint8Array(0);
    const arr = d instanceof Uint8Array ? d : new Uint8Array(d);
    log(`RX ${label}: ${Array.from(arr).map(b => hex(b)).join(' ')}`, 'rx');
    const nrc = explainNrc(arr);
    if (nrc){
      const err = new Error(`${label} negative: ${nrc.text}`);
      err.phase = result.phase;
      err.nrc = nrc.code;
      throw err;
    }
    return arr;
  }

  async function start(){
    try {
      if (!engine || typeof engine.uds !== 'function'){
        throw new Error('No engine provided');
      }
      if (engine.isBridge !== true){
        throw new Error('Bench-only flasher refuses non-bridge engine');
      }
      const data = toBytes(payload);
      if (data.length === 0){
        throw new Error('Payload is empty');
      }

      setPhase(PHASE.CONNECT);
      log(`Bench flash starting · ${data.length} bytes · chunk ${chunkSize}`, 'info');

      setPhase(PHASE.SESSION);
      await call([0x10, 0x02], 'DiagnosticSessionControl 0x10 02');

      setPhase(PHASE.SEED);
      const seedResp = await call([0x27, 0x01], 'SecurityAccess seed 0x27 01');
      if (seedResp.length < 6 || seedResp[0] !== 0x67 || seedResp[1] !== 0x01){
        throw new Error('Malformed seed response');
      }
      const seedBytes = seedResp.subarray(2, 6);
      const seed = ((seedBytes[0] << 24) | (seedBytes[1] << 16) | (seedBytes[2] << 8) | seedBytes[3]) >>> 0;
      result.seed = '0x' + hex(seed, 8);
      const key = cda6(seed) >>> 0;
      result.key = '0x' + hex(key, 8);
      log(`CDA6 seed=${result.seed} key=${result.key}`, 'info');

      setPhase(PHASE.KEY);
      await call([0x27, 0x02, (key >>> 24) & 0xFF, (key >>> 16) & 0xFF, (key >>> 8) & 0xFF, key & 0xFF], 'SecurityAccess key 0x27 02');

      setPhase(PHASE.ERASE);
      const eAddr = (eraseAddress != null ? eraseAddress : address) >>> 0;
      const eLen  = (eraseLength  != null ? eraseLength  : data.length) >>> 0;
      await call(buildEraseRoutine(eAddr, eLen, eraseRid), `RoutineControl erase 0x31 01 ${hex((eraseRid>>8)&0xFF)} ${hex(eraseRid&0xFF)}`);

      setPhase(PHASE.REQUEST_DOWNLOAD);
      const dlResp = await call(buildRequestDownload(address >>> 0, data.length >>> 0, dataFormatIdentifier), 'RequestDownload 0x34');
      const dl = parseDownloadResponse(dlResp);
      if (!dl){
        throw new Error('Could not parse RequestDownload response');
      }
      result.maxNumberOfBlockLength = dl.maxNumberOfBlockLength;
      const negotiated = Math.max(1, Math.min(chunkSize, dl.payloadPerFrame));
      log(`maxNumberOfBlockLength=${dl.maxNumberOfBlockLength} (payload=${dl.payloadPerFrame}); using chunk=${negotiated}`, 'info');

      setPhase(PHASE.TRANSFER);
      let seq = 1;
      let off = 0;
      while (off < data.length){
        checkAborted(signal);
        const end = Math.min(off + negotiated, data.length);
        const slice = data.subarray(off, end);
        const frame = new Array(2 + slice.length);
        frame[0] = 0x36;
        frame[1] = seq & 0xFF;
        for (let i=0;i<slice.length;i++) frame[2 + i] = slice[i];
        const resp = await call(frame, `TransferData 0x36 seq=0x${hex(seq & 0xFF)} (${off}-${end})`);
        if (resp[0] !== 0x76 || resp[1] !== (seq & 0xFF)){
          throw new Error(`TransferData echo mismatch at seq 0x${hex(seq & 0xFF)}`);
        }
        off = end;
        result.bytesSent = off;
        result.chunksSent++;
        // Sequence counter wraps 0xFF -> 0x00 -> 0x01... per ISO 14229.
        seq = (seq + 1) & 0xFF;
        progress({ pct: data.length ? off / data.length : 1 });
      }

      setPhase(PHASE.TRANSFER_EXIT);
      await call([0x37], 'RequestTransferExit 0x37');

      setPhase(PHASE.CHECKSUM);
      await call(buildCheckRoutine(checkRid), `RoutineControl checksum 0x31 01 ${hex((checkRid>>8)&0xFF)} ${hex(checkRid&0xFF)}`);

      setPhase(PHASE.RESET);
      await call([0x11, 0x01], 'ECUReset 0x11 01');

      setPhase(PHASE.DONE);
      result.ok = true;
      log('Bench flash complete', 'info');
      progress({ pct: 1 });
      return result;
    } catch (err) {
      if (err && err.aborted){
        result.aborted = true;
        result.phase = PHASE.ABORTED;
        result.error = 'Aborted';
        log('Aborted by user', 'warn');
      } else {
        result.error = err && err.message ? err.message : String(err);
        if (!result.phase || result.phase === PHASE.CONNECT){
          // Pre-flight error.
          result.phase = PHASE.FAILED;
        } else {
          // Keep the phase that failed for the UI to surface.
          result.phase = result.phase;
        }
        log(`Flash failed at ${result.phase}: ${result.error}`, 'error');
      }
      progress({});
      result.ok = false;
      return result;
    }
  }

  return { start, result };
}

export { PHASE as FLASH_PHASES, parseDownloadResponse, buildRequestDownload, buildEraseRoutine, buildCheckRoutine };
