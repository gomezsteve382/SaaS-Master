// GPEC2A bench-flasher state machine (Task #488, etiquette in #563).
//
// `flashEcm()` walks the FCA UDS programming session per Task #488 spec:
//   1. Diagnostic Session Control 0x10 0x03 (extended)
//   2. Pre-flash etiquette (Task #563), with the SAME NRC handling as
//      the rest of the flash (a 0x7F NRC or transport failure aborts
//      the run before erase/transfer ever begin):
//        - ControlDTCSetting   0x85 0x02         on target ECU
//        - CommunicationControl 0x28 0x03 0x03  on broadcast 0x7DF
//   3. Diagnostic Session Control 0x10 0x02 (programming)
//   4. (background) Tester Present keep-alive 0x3E 0x80 every keepAliveIntervalMs
//   5. Security Access seed request — subfunction defaults to 0x09 per
//      spec (programming-session CDA6 / GPEC TEA), overridable to 0x01.
//   6. Compute key with the caller-supplied `algoFn(seedU32) -> keyU32`.
//   7. Security Access send key — subfunction 0x0A (paired with 0x09)
//      or 0x02 (paired with 0x01).
//   8. RoutineControl erase memory 0x31 0x01 0xFF 0x00 (RID overridable).
//   9. Request Download 0x34 dataFormatIdentifier addressAndLengthFormatIdentifier
//      addr len. Default ALFID 0x00 (no compression / no encryption — the
//      ECM bootloader decrypts PowerCal payloads in-place during 0x36).
//  10. Transfer Data 0x36 chunked, sequence counter wraps 0xFF -> 0x00
//      per ISO 14229. Resume from a saved chunk index is supported via
//      `resumeFromChunk`.
//  11. Request Transfer Exit 0x37.
//  12. RoutineControl checksum/verify 0x31 0x01 0xFF 0x01 (RID overridable).
//  13. ECU Reset 0x11 0x01.
//  14. Post-flash etiquette (Task #563): restore both controls. On the
//      success path these use the same strict NRC handling as the rest
//      of the flow. On the failure/abort path the finally block also
//      attempts the restore, but tolerates errors so it does not mask
//      the original abort/failure reason.
//        - ControlDTCSetting   0x85 0x01         on target ECU
//        - CommunicationControl 0x28 0x00 0x00  on broadcast 0x7DF
//
// On stop (AbortSignal), if the machine is mid-transfer or past the
// RequestDownload phase, it makes one best-effort attempt to send 0x37
// to close the transfer cleanly before reporting `aborted`. Pre-flash
// etiquette restores are also fired in the finally block so DTC
// logging and bus comms always come back up, even on failure paths.
//
// The function returns a controller `{start, result}` whose `start()`
// resolves to the `result` record. Progress and log events are emitted
// via the `onProgress`/`onLog` callbacks. The machine refuses to run
// unless `engine.isBridge` is truthy — only the bench Autel bridge can
// move 1–4 MB through 0x36 reliably.

import { cda6 } from './algos.js';
import { decodeNRC } from './nrc.js';

const ECM_ADDR = { tx: 0x7E0, rx: 0x7E8 };
const DEFAULT_CHUNK = 0x80; // 128 bytes — conservative for ISO-TP.
const BROADCAST_TX = 0x7DF; // ISO 15765 functional broadcast.

const PHASE = {
  CONNECT: 'connect',
  SESSION_EXT: 'session_extended',
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

// Decode the 0x74 RequestDownload positive response. The high nibble of
// byte 1 (LFID) tells us how many bytes encode `maxNumberOfBlockLength`.
function parseDownloadResponse(d){
  if (!d || d.length < 2 || d[0] !== 0x74) return null;
  const lfid = (d[1] >> 4) & 0x0F;
  if (lfid === 0 || lfid > 4) return null;
  if (d.length < 2 + lfid) return null;
  let max = 0;
  for (let i=0;i<lfid;i++) max = (max * 256) + d[2 + i];
  // `maxNumberOfBlockLength` includes the SID + sequence counter, so the
  // payload-per-frame is max - 2. Refuse anything below 3 (1 SID + 1 seq
  // + at least 1 data byte) so the caller never enters a zero-length
  // transfer loop.
  if (max < 3) return null;
  const payload = max - 2;
  return { maxNumberOfBlockLength: max, payloadPerFrame: payload };
}

// Build the 0x34 RequestDownload bytes: SID + dataFormatIdentifier +
// addressAndLengthFormatIdentifier + addr + len.
function buildRequestDownload(addr, length, dfi, alfid){
  const a = alfid != null ? alfid : 0x44;
  const aLen = a & 0x0F;       // low nibble = address bytes
  const lLen = (a >> 4) & 0x0F; // high nibble = length bytes
  const addrBytes = [];
  for (let i=aLen-1;i>=0;i--) addrBytes.push((addr >>> (i*8)) & 0xFF);
  const lenBytes = [];
  for (let i=lLen-1;i>=0;i--) lenBytes.push((length >>> (i*8)) & 0xFF);
  return [0x34, dfi & 0xFF, a, ...addrBytes, ...lenBytes];
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

/**
 * Validate a RoutineControl positive response and its routine status byte.
 * ISO 14229 §9.4 reply shape for sub-function 0x01:
 *   71 01 <RID hi> <RID lo> [routineStatusRecord ...]
 * The first byte of the status record is the routine result/status. We reject
 * any reply that does not echo (0x71, 0x01, RID_hi, RID_lo) AND we reject any
 * non-zero status byte. A zero status (or, for ECMs that omit the status
 * record, a bare positive echo) is the only thing we accept as success.
 *
 * Returns { ok: true, status } on success, { ok: false, reason } on failure.
 */
function checkRoutinePositive(resp, rid){
  if (!resp || resp.length < 4){
    return { ok: false, reason: `Truncated RoutineControl response (len=${resp ? resp.length : 0})` };
  }
  if (resp[0] !== 0x71 || resp[1] !== 0x01){
    return { ok: false, reason: `Unexpected RoutineControl reply header 0x${hex(resp[0])} 0x${hex(resp[1])}` };
  }
  const ridHi = (rid >> 8) & 0xFF, ridLo = rid & 0xFF;
  if (resp[2] !== ridHi || resp[3] !== ridLo){
    return { ok: false, reason: `RoutineControl RID mismatch: got 0x${hex(resp[2])}${hex(resp[3])}, expected 0x${hex(ridHi)}${hex(ridLo)}` };
  }
  if (resp.length >= 5){
    const status = resp[4];
    if (status !== 0x00){
      return { ok: false, reason: `RoutineControl reported non-zero status 0x${hex(status)}`, status };
    }
    return { ok: true, status };
  }
  // ECU returned a bare positive echo with no status record — accept it.
  return { ok: true, status: null };
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

// Public entry point. Returns a controller `{start, result}`.
export function flashEcm(opts){
  const {
    engine,
    payload,
    address = 0x00000000,
    chunkSize = DEFAULT_CHUNK,
    algoFn = cda6,
    algoLabel = 'CDA6',
    seedSubfn = 0x09,
    keySubfn = 0x0A,
    eraseAddress,
    eraseLength,
    eraseRid = 0xFF00,
    checkRid = 0xFF01,
    dataFormatIdentifier = 0x00,
    addressAndLengthFormatIdentifier = 0x44,
    resumeFromChunk = 0,
    keepAlive = false,
    keepAliveIntervalMs = 2000,
    onProgress = () => {},
    onLog = () => {},
    signal,
    addr = ECM_ADDR,
    broadcastTx = BROADCAST_TX,
  } = opts || {};

  const startedAt = Date.now();
  const result = {
    ok: false,
    phase: PHASE.CONNECT,
    error: null,
    nrc: null,
    aborted: false,
    seed: null,
    key: null,
    bytesSent: 0,
    chunksSent: 0,
    nextChunk: 0,        // for resume-from-chunk affordance
    elapsedMs: 0,
    throughputKBs: 0,
    maxNumberOfBlockLength: null,
    log: [],
    algoLabel,
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

  async function rawCallOn(tx, rx, bytes, label, expectResp=true){
    log(`TX ${label}: ${bytes.map(b => hex(b)).join(' ')}`, 'tx');
    const r = await engine.uds(tx, rx, bytes);
    if (!r || !r.ok){
      if (!expectResp) return null;
      const err = new Error(`${label} failed: ${(r && r.error) || 'no response'}`);
      err.phase = result.phase;
      throw err;
    }
    const d = r.d || r.data || new Uint8Array(0);
    const arr = d instanceof Uint8Array ? d : new Uint8Array(d);
    log(`RX ${label}: ${Array.from(arr).map(b => hex(b)).join(' ')}`, 'rx');
    if (!expectResp) return arr;
    const nrc = explainNrc(arr);
    if (nrc){
      const err = new Error(`${label} negative response: ${nrc.text}`);
      err.phase = result.phase;
      err.nrc = nrc.code;
      result.nrc = nrc.code;
      throw err;
    }
    return arr;
  }

  async function rawCall(bytes, label, expectResp=true){
    return rawCallOn(addr.tx, addr.rx, bytes, label, expectResp);
  }

  async function call(bytes, label){
    checkAborted(signal);
    return rawCall(bytes, label, true);
  }

  async function callOn(tx, rx, bytes, label){
    checkAborted(signal);
    return rawCallOn(tx, rx, bytes, label, true);
  }

  // Background TesterPresent keep-alive loop. Sends `0x3E 0x80` (suppress
  // positive response per ISO 14229) every keepAliveIntervalMs. Errors
  // are logged but never throw — we never want keep-alive to abort the
  // primary flow.
  // Pre/post-flash etiquette (Task #563). On the primary success path
  // both halves use the same strict call()/NRC handling as the rest of
  // the flow — a negative response or transport failure aborts the run.
  // The finally block calls etiquettePostSafe() instead, which still
  // attempts the restore frames but tolerates errors so a restore
  // failure cannot mask the real abort/failure reason. The
  // `etiquetteApplied` flag guards the post half so the finally block
  // never double-restores after the success path already ran it.
  let etiquetteApplied = false;
  let etiquettePostRan = false;
  async function etiquettePre(){
    log('Pre-flash etiquette · suppressing DTC logging and silencing bus chatter', 'info');
    // Mark restore-needed BEFORE the first frame goes out. If the first
    // frame succeeds and the second one fails, the finally block still
    // needs to attempt both restores — guarding on "both pre frames
    // succeeded" would leave DTC logging suppressed on the bus.
    etiquetteApplied = true;
    // 0x85 0x02 = ControlDTCSetting OFF on the target ECU.
    await call([0x85, 0x02], 'ControlDTCSetting 0x85 02 (DTC logging suppressed)');
    // 0x28 0x03 0x03 = CommunicationControl disableRxAndTx for normal +
    // network management messages, addressed functionally to broadcast.
    await callOn(broadcastTx, addr.rx, [0x28, 0x03, 0x03], `CommunicationControl 0x28 03 03 (Bus chatter silenced) → 0x${hex(broadcastTx, 3)}`);
  }
  async function etiquettePost(){
    if (!etiquetteApplied || etiquettePostRan) return;
    etiquettePostRan = true;
    log('Post-flash etiquette · restoring DTC logging and bus comms', 'info');
    // Restore frames intentionally use rawCallOn (no abort check) so
    // that an aborted run still gets DTC + bus comms back. NRC/transport
    // failures still throw — the finally-path wrapper catches them.
    // 0x28 0x00 0x00 = CommunicationControl enableRxAndTx (normal), broadcast.
    await rawCallOn(broadcastTx, addr.rx, [0x28, 0x00, 0x00], `CommunicationControl 0x28 00 00 (Bus chatter restored) → 0x${hex(broadcastTx, 3)}`, true);
    // 0x85 0x01 = ControlDTCSetting ON on the target ECU.
    await rawCallOn(addr.tx, addr.rx, [0x85, 0x01], 'ControlDTCSetting 0x85 01 (DTC logging restored)', true);
  }
  async function etiquettePostSafe(){
    if (!etiquetteApplied || etiquettePostRan) return;
    try { await etiquettePost(); }
    catch (e) {
      log(`Post-flash etiquette restore did not complete cleanly: ${e && e.message ? e.message : e} — continuing teardown`, 'warn');
    }
  }

  let keepAliveTimer = null;
  function startKeepAlive(){
    if (!keepAlive) return;
    if (keepAliveTimer) return;
    log(`TesterPresent keep-alive started · 3E 80 every ${keepAliveIntervalMs}ms`, 'info');
    const tick = async () => {
      if (signal && signal.aborted) return;
      try {
        await engine.uds(addr.tx, addr.rx, [0x3E, 0x80]);
      } catch (e) {
        log('Keep-alive 3E 80 hiccup: ' + (e && e.message ? e.message : e), 'warn');
      }
    };
    keepAliveTimer = setInterval(tick, keepAliveIntervalMs);
  }
  function stopKeepAlive(){
    if (keepAliveTimer){ clearInterval(keepAliveTimer); keepAliveTimer = null; }
  }

  async function start(){
    try {
      if (!engine || typeof engine.uds !== 'function'){
        throw new Error('No engine provided');
      }
      if (engine.isBridge !== true){
        throw new Error('Bench-only flasher refuses non-bridge engine');
      }
      if (typeof algoFn !== 'function'){
        throw new Error('algoFn must be a function (seedU32) -> keyU32');
      }
      const data = toBytes(payload);
      if (data.length === 0){
        throw new Error('Payload is empty');
      }

      setPhase(PHASE.CONNECT);
      log(`Bench flash starting · ${data.length} bytes · chunk ${chunkSize} · algo ${algoLabel}`, 'info');

      // 1) Extended diagnostic session, then programming session.
      setPhase(PHASE.SESSION_EXT);
      await call([0x10, 0x03], 'DiagnosticSessionControl 0x10 03 (extended)');

      // 1a) Pre-flash etiquette (Task #563). Runs in extended session
      // because 0x85 typically requires a non-default session, and we
      // want both controls in place before 0x10 0x02 starts erasing.
      // Uses the standard NRC handling — a 0x7F here aborts the run.
      await etiquettePre();

      setPhase(PHASE.SESSION);
      await call([0x10, 0x02], 'DiagnosticSessionControl 0x10 02 (programming)');

      // 2) Security access (seed/key).
      setPhase(PHASE.SEED);
      const seedResp = await call([0x27, seedSubfn & 0xFF], `SecurityAccess seed 0x27 ${hex(seedSubfn & 0xFF)}`);
      if (seedResp.length < 6 || seedResp[0] !== 0x67 || seedResp[1] !== (seedSubfn & 0xFF)){
        throw new Error('Malformed seed response');
      }
      const seedBytes = seedResp.subarray(2, 6);
      const seed = ((seedBytes[0] << 24) | (seedBytes[1] << 16) | (seedBytes[2] << 8) | seedBytes[3]) >>> 0;
      result.seed = '0x' + hex(seed, 8);
      const key = (algoFn(seed) >>> 0);
      result.key = '0x' + hex(key, 8);
      log(`${algoLabel} seed=${result.seed} key=${result.key}`, 'info');

      setPhase(PHASE.KEY);
      await call([0x27, keySubfn & 0xFF, (key >>> 24) & 0xFF, (key >>> 16) & 0xFF, (key >>> 8) & 0xFF, key & 0xFF], `SecurityAccess key 0x27 ${hex(keySubfn & 0xFF)}`);

      // 3) Start TesterPresent keep-alive now that we have unlock.
      startKeepAlive();

      // 4) Erase memory.
      setPhase(PHASE.ERASE);
      const eAddr = (eraseAddress != null ? eraseAddress : address) >>> 0;
      const eLen  = (eraseLength  != null ? eraseLength  : data.length) >>> 0;
      const eraseRidEff = (eraseRid != null ? eraseRid : 0xFF00) & 0xFFFF;
      const eraseResp = await call(buildEraseRoutine(eAddr, eLen, eraseRid), `RoutineControl erase 0x31 01 ${hex((eraseRidEff>>8)&0xFF)} ${hex(eraseRidEff&0xFF)}`);
      const eraseChk = checkRoutinePositive(eraseResp, eraseRidEff);
      if (!eraseChk.ok){
        if (typeof eraseChk.status === 'number') result.eraseStatus = eraseChk.status;
        throw new Error(`Erase routine failed: ${eraseChk.reason}`);
      }
      result.eraseStatus = eraseChk.status;

      // 5) Request download.
      setPhase(PHASE.REQUEST_DOWNLOAD);
      const dlResp = await call(buildRequestDownload(address >>> 0, data.length >>> 0, dataFormatIdentifier, addressAndLengthFormatIdentifier), 'RequestDownload 0x34');
      const dl = parseDownloadResponse(dlResp);
      if (!dl){
        throw new Error('Could not parse RequestDownload response (malformed LFID or maxNumberOfBlockLength < 3)');
      }
      result.maxNumberOfBlockLength = dl.maxNumberOfBlockLength;
      const negotiated = Math.max(1, Math.min(chunkSize, dl.payloadPerFrame));
      log(`maxNumberOfBlockLength=${dl.maxNumberOfBlockLength} (payload=${dl.payloadPerFrame}); using chunk=${negotiated}`, 'info');

      // 6) Transfer data.
      setPhase(PHASE.TRANSFER);
      const startChunk = Math.max(0, resumeFromChunk | 0);
      let off = Math.min(startChunk * negotiated, data.length);
      let seq = ((1 + startChunk) & 0xFF) || 0; // chunk #1 → seq 0x01, wraps with off
      result.bytesSent = off;
      result.chunksSent = startChunk;
      result.nextChunk = startChunk;
      if (startChunk > 0) log(`Resuming transfer from chunk #${startChunk} (offset 0x${hex(off, 8)}, seq 0x${hex(seq)})`, 'info');
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
        result.nextChunk = result.chunksSent;
        // Sequence counter wraps 0xFF -> 0x00 -> 0x01... per ISO 14229.
        seq = (seq + 1) & 0xFF;
        const ms = Math.max(1, Date.now() - startedAt);
        result.elapsedMs = ms;
        result.throughputKBs = (off / 1024) / (ms / 1000);
        progress({ pct: data.length ? off / data.length : 1 });
      }

      // 7) Transfer exit.
      setPhase(PHASE.TRANSFER_EXIT);
      await call([0x37], 'RequestTransferExit 0x37');

      // 8) Verify checksum.
      setPhase(PHASE.CHECKSUM);
      const checkRidEff = (checkRid != null ? checkRid : 0xFF01) & 0xFFFF;
      const checkResp = await call(buildCheckRoutine(checkRid), `RoutineControl checksum 0x31 01 ${hex((checkRidEff>>8)&0xFF)} ${hex(checkRidEff&0xFF)}`);
      const checkChk = checkRoutinePositive(checkResp, checkRidEff);
      if (!checkChk.ok){
        if (typeof checkChk.status === 'number') result.verifyStatus = checkChk.status;
        throw new Error(`Verify routine failed: ${checkChk.reason}`);
      }
      result.verifyStatus = checkChk.status;

      // 9) ECU reset.
      setPhase(PHASE.RESET);
      await call([0x11, 0x01], 'ECUReset 0x11 01');

      // 9a) Post-flash etiquette (Task #563). Restore DTC + bus comms
      // before returning success. The finally block will not re-run
      // this thanks to etiquettePostRan.
      await etiquettePost();

      setPhase(PHASE.DONE);
      result.ok = true;
      result.elapsedMs = Date.now() - startedAt;
      result.throughputKBs = result.elapsedMs ? (result.bytesSent / 1024) / (result.elapsedMs / 1000) : 0;
      log(`Bench flash complete · ${result.bytesSent} B in ${result.chunksSent} chunks · ${result.elapsedMs} ms · ${result.throughputKBs.toFixed(2)} KB/s`, 'info');
      progress({ pct: 1 });
      return result;
    } catch (err) {
      if (err && err.aborted){
        result.aborted = true;
        result.error = 'Aborted';
        // Best-effort clean exit: if we are mid-transfer or past the
        // RequestDownload phase, send a single 0x37 so the ECM tears
        // down its download window cleanly. We swallow any error from
        // this attempt — the user already asked us to stop.
        const phaseAt = result.phase;
        if (phaseAt === PHASE.TRANSFER || phaseAt === PHASE.REQUEST_DOWNLOAD || phaseAt === PHASE.TRANSFER_EXIT){
          try {
            log('Stop requested · attempting clean 0x37 transfer exit', 'warn');
            await rawCall([0x37], 'RequestTransferExit 0x37 (stop)', false);
          } catch (e){
            log('Clean 0x37 exit failed: ' + (e && e.message ? e.message : e), 'warn');
          }
        }
        result.phase = PHASE.ABORTED;
        log(`Aborted at ${phaseAt} · resume from chunk #${result.nextChunk} possible`, 'warn');
      } else {
        result.error = err && err.message ? err.message : String(err);
        if (err && err.nrc != null) result.nrc = err.nrc;
        if (!result.phase || result.phase === PHASE.CONNECT){
          result.phase = PHASE.FAILED;
        }
        log(`Flash failed at ${result.phase}: ${result.error}`, 'error');
      }
      progress({});
      result.ok = false;
      result.elapsedMs = Date.now() - startedAt;
      return result;
    } finally {
      // Always try to restore etiquette before tearing down keep-alive.
      // If etiquettePre never ran (early failure) the post helper
      // no-ops, and if the success path already ran it the guard
      // prevents a double restore. The Safe variant tolerates errors
      // here so a restore hiccup cannot mask the real abort/failure.
      await etiquettePostSafe();
      stopKeepAlive();
    }
  }

  return { start, result };
}

export { PHASE as FLASH_PHASES, parseDownloadResponse, buildRequestDownload, buildEraseRoutine, buildCheckRoutine };
