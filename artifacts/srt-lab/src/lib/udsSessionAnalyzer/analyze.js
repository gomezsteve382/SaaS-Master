/**
 * UDS Session Analyzer — session analysis engine
 *
 * Pairs requests with responses from parseTrace() output, decodes NRCs,
 * detects the 0x78 ResponsePending→silence timeout pattern, tracks
 * SecurityAccess state, and produces a session-level diagnosis with
 * recommended next steps.
 *
 * All NRC short names and descriptions come from @workspace/uds NRC_TABLE.
 * Plain-English cause strings extend those descriptions for actionability.
 */

import { serviceForSid, serviceForPosRsp, NRC_TABLE, didEntry, decodeDid } from '@workspace/uds';

const NRC_PLAIN_CAUSES = {
  0x10: 'Verify the service is appropriate for this module and that the request format is correct.',
  0x11: 'Check the SID and session type — the ECU does not recognise this service here.',
  0x12: 'Sub-function byte is not valid for this service on this ECU.',
  0x13: 'Message length is wrong — too many or too few payload bytes in the request.',
  0x21: 'ECU was busy and asked the tool to repeat the request. Usually transient on a loaded bus — retry the same request. If it persists, check for bus storms, a stuck module flooding the network, or a CAN load above the ECU\'s receive budget.',
  0x22: 'Preconditions not met: verify diagnostic session (usually 0x10 0x03 extended first), engine state (ignition on / engine off), and that any required prerequisite services already completed successfully.',
  0x24: 'Service called out of order. Typical fix: enter extended session → complete SecurityAccess seed/key → then retry the rejected service.',
  0x31: 'DID, routine ID, or parameter not supported in this session. Check the correct value for this ECU variant and verify the active session.',
  0x33: 'Security level not unlocked — perform the SecurityAccess (0x27) seed/key handshake first, then retry the rejected service.',
  0x35: 'Wrong key: the computed key does not match the ECU. Check the algorithm, S-box bytes, and byte order. Each wrong attempt increments the lockout counter.',
  0x36: 'Lockout active — too many wrong keys. Hard-reset the ECU (0x11 0x01) and wait the mandatory delay (often 10+ minutes in programming mode). Do not retry immediately or the timer resets.',
  0x37: 'Time delay not expired — the tool retried too quickly after a failed key attempt. Wait the P2-star / security delay (typically 5–10 s) before requesting a new seed.',
  0x70: 'Flash preconditions not met: check supply voltage (≥13.5 V), correct session (0x10 0x02 programming), and that ControlDTCSetting / CommunicationControl are set before RequestDownload.',
  0x71: 'Data transfer suspended. Re-establish the session and restart the full download sequence from RequestDownload.',
  0x72: 'General programming failure — erase or write to flash failed. Check voltage stability, block address/length alignment, and that the correct image version matches the ECU hardware variant.',
  0x73: 'TransferData block sequence counter is out of order. Restart the download from RequestDownload (0x34) and ensure every TransferData (0x36) block uses the next sequential counter without skipping or repeating. Do not resume mid-stream after any error — abort with RequestTransferExit (0x37) and start over.',
  0x7E: 'Sub-function rejected in this session — escalate to extended (0x10 0x03) or programming (0x10 0x02) session first.',
  0x7F: 'Service rejected in this session — escalate the diagnostic session (0x10 0x03 for extended) before retrying.',
};

function hx(b) { return b.toString(16).toUpperCase().padStart(2, '0'); }
function fmtBytes(bytes) { return bytes.map(hx).join(' '); }

function lookupNrc(code) {
  return NRC_TABLE.find(e => e.code === code);
}

function serviceName(bytes) {
  if (!bytes.length) return null;
  const first = bytes[0];
  if (first === 0x7F && bytes.length >= 2) {
    const svc = serviceForSid(bytes[1]);
    return svc ? svc.name : `SID_0x${hx(bytes[1])}`;
  }
  if (first >= 0x50) {
    const svc = serviceForPosRsp(first);
    return svc ? svc.name : `SID_0x${hx(first)}`;
  }
  const svc = serviceForSid(first);
  return svc ? svc.name : `SID_0x${hx(first)}`;
}

const HAS_SUBFUNC_SIDS = new Set([0x10, 0x11, 0x19, 0x27, 0x28, 0x29, 0x31, 0x3E, 0x83, 0x85, 0x86, 0x87]);

function getSubFunction(bytes) {
  if (bytes.length < 2) return null;
  return HAS_SUBFUNC_SIDS.has(bytes[0]) ? bytes[1] : null;
}

/**
 * Pull the ordered list of 16-bit DIDs from a 0x22 ReadDataByIdentifier
 * request. Returns null for non-0x22, malformed, or odd-length payloads.
 * Single-DID requests come back as a 1-element array.
 */
function getRequestedDids(reqBytes) {
  if (reqBytes[0] !== 0x22) return null;
  if (reqBytes.length < 3 || (reqBytes.length - 1) % 2 !== 0) return null;
  const dids = [];
  for (let i = 1; i + 1 < reqBytes.length; i += 2) {
    dids.push((reqBytes[i] << 8) | reqBytes[i + 1]);
  }
  return dids;
}

/**
 * Pull the ordered list of 16-bit DIDs from a 0x2E WriteDataByIdentifier
 * request. Each DID is followed by `entry.length` data bytes, looked up
 * from the catalog. Returns null when any DID lacks a known length, or
 * when the bytes don't pack cleanly. Single-DID writes come back as a
 * 1-element array.
 */
function getWrittenDids(reqBytes) {
  if (reqBytes[0] !== 0x2E) return null;
  if (reqBytes.length < 4) return null;
  const dids = [];
  let off = 1;
  while (off < reqBytes.length) {
    if (off + 2 > reqBytes.length) return null;
    const did = (reqBytes[off] << 8) | reqBytes[off + 1];
    const entry = didEntry(did);
    if (!entry || typeof entry.length !== 'number') return null;
    off += 2;
    if (off + entry.length > reqBytes.length) return null;
    off += entry.length;
    dids.push(did);
  }
  if (off !== reqBytes.length) return null;
  return dids.length ? dids : null;
}

/**
 * Pull the candidate list of 16-bit RoutineIdentifiers from a 0x31
 * RoutineControl request. Bench tools that batch routines pack them as
 * `31 <type> RID1 RID2 RID3 ...` with no per-routine optionRecord, but
 * a normal single-routine request `31 <type> RID optionRecord` is
 * indistinguishable from a 2-RID batch on the wire. To avoid
 * misclassifying single-routine requests that carry option bytes, we
 * only treat the payload as a candidate batch when it contains at
 * least three potential RIDs (≥ 6 bytes, even-length) — and even then
 * we still require the positive response to confirm by splitting
 * cleanly before rendering multi-routine sub-rows. Returns null
 * otherwise.
 */
function getRequestedRoutines(reqBytes) {
  if (reqBytes[0] !== 0x31) return null;
  if (reqBytes.length < 8) return null; // type + at least 3 × 2-byte RIDs
  const payload = reqBytes.slice(2);
  if (payload.length === 0 || payload.length % 2 !== 0) return null;
  const rids = [];
  for (let i = 0; i + 1 < payload.length; i += 2) {
    rids.push((payload[i] << 8) | payload[i + 1]);
  }
  return rids.length >= 3 ? rids : null;
}

function didRow(did, decoded, dataBytes) {
  const entry = didEntry(did);
  return {
    did,
    label: `0x${hx((did >> 8) & 0xFF)}${hx(did & 0xFF)}`,
    name: entry ? entry.name : null,
    encoding: entry ? entry.encoding : null,
    decoded,
    bytes: dataBytes ? fmtBytes(dataBytes) : null,
  };
}

function routineRow(rid, status) {
  return {
    routineId: rid,
    label: `0x${hx((rid >> 8) & 0xFF)}${hx(rid & 0xFF)}`,
    status,
  };
}

/**
 * Split a 0x6E positive WriteDataByIdentifier response into one row per
 * written DID. Batched bench tools echo each written DID id back as
 * `6E DID1 DID2 …`. Returns null if the echoes don't line up with the
 * request so callers can fall back to a raw-hex verdict.
 *
 * @param {number[]} writtenDids  Ordered list of DIDs from the request
 * @param {number[]} payload      Response bytes after the 0x6E SID echo
 */
function splitMultiDidWriteResponse(writtenDids, payload) {
  if (payload.length !== writtenDids.length * 2) return null;
  for (let i = 0; i < writtenDids.length; i++) {
    const did = writtenDids[i];
    const hi = (did >> 8) & 0xFF;
    const lo = did & 0xFF;
    if (payload[i * 2] !== hi || payload[i * 2 + 1] !== lo) return null;
  }
  return writtenDids.map(d => didRow(d, 'written successfully'));
}

/**
 * Split a 0x71 positive RoutineControl response into one row per
 * routine. Response payload after `71 <type>` is a sequence of
 * `RID statusRecord…` blocks. The status record for each routine is
 * variable-length, so we bound it by scanning forward for the next
 * requested RID; the last routine consumes the remainder. Returns null
 * when alignment fails.
 *
 * @param {number[]} routineIds  Ordered list of RIDs from the request
 * @param {number[]} payload     Response bytes after the 0x71 + type bytes
 */
function splitMultiRoutineResponse(routineIds, payload) {
  const rows = [];
  let off = 0;
  for (let i = 0; i < routineIds.length; i++) {
    const rid = routineIds[i];
    const hi = (rid >> 8) & 0xFF;
    const lo = rid & 0xFF;
    if (off + 2 > payload.length || payload[off] !== hi || payload[off + 1] !== lo) {
      return null;
    }
    off += 2;
    let dataLen;
    if (i + 1 < routineIds.length) {
      const nextRid = routineIds[i + 1];
      const nHi = (nextRid >> 8) & 0xFF;
      const nLo = nextRid & 0xFF;
      let found = -1;
      for (let k = off; k + 1 < payload.length; k++) {
        if (payload[k] === nHi && payload[k + 1] === nLo) {
          found = k;
          break;
        }
      }
      if (found < 0) return null;
      dataLen = found - off;
    } else {
      dataLen = payload.length - off;
    }
    if (dataLen < 0 || off + dataLen > payload.length) return null;
    const statusBytes = payload.slice(off, off + dataLen);
    off += dataLen;
    const status = statusBytes.length
      ? `completed (status: ${fmtBytes(statusBytes)})`
      : 'completed';
    rows.push(routineRow(rid, status));
  }
  if (off !== payload.length) return null;
  return rows;
}

/**
 * Split a 0x62 positive ReadDataByIdentifier response into one row per
 * requested DID. The response stream is `62 <DID hi> <DID lo> <data> ...`
 * concatenated for each requested DID. Fixed-length DIDs use the catalog
 * `length` hint; variable-length DIDs are bounded by scanning forward for
 * the next requested DID identifier (the last DID consumes the remainder).
 *
 * Returns null when alignment fails, so callers can fall back to a raw-hex
 * verdict instead of producing misleading sub-rows.
 *
 * @param {number[]} requestedDids  Ordered list of DIDs from the request
 * @param {number[]} payload        Response bytes after the 0x62 SID echo
 */
function splitMultiDidResponse(requestedDids, payload) {
  const rows = [];
  let offset = 0;
  for (let i = 0; i < requestedDids.length; i++) {
    const did = requestedDids[i];
    const hi = (did >> 8) & 0xFF;
    const lo = did & 0xFF;
    if (offset + 2 > payload.length || payload[offset] !== hi || payload[offset + 1] !== lo) {
      return null;
    }
    offset += 2;
    const entry = didEntry(did);
    let dataLen;
    if (entry && typeof entry.length === 'number') {
      dataLen = entry.length;
    } else if (i + 1 < requestedDids.length) {
      const nextDid = requestedDids[i + 1];
      const nHi = (nextDid >> 8) & 0xFF;
      const nLo = nextDid & 0xFF;
      let found = -1;
      for (let k = offset; k + 1 < payload.length; k++) {
        if (payload[k] === nHi && payload[k + 1] === nLo) {
          found = k;
          break;
        }
      }
      if (found < 0) return null;
      dataLen = found - offset;
    } else {
      dataLen = payload.length - offset;
    }
    if (dataLen < 0 || offset + dataLen > payload.length) return null;
    const data = payload.slice(offset, offset + dataLen);
    offset += dataLen;
    const decoded = data.length ? decodeDid(did, data) : '(empty)';
    rows.push(didRow(did, decoded, data));
  }
  if (offset !== payload.length) return null;
  return rows;
}

function isTesterPresentSuppressed(bytes) {
  return bytes[0] === 0x3E && bytes.length >= 2 && (bytes[1] & 0x80) !== 0;
}

function buildExchange(reqLine, respLine, hadPending, pendingCount) {
  const sid = reqLine.bytes[0];
  const svcName = serviceName(reqLine.bytes) || `SID_0x${hx(sid)}`;
  const subFunction = getSubFunction(reqLine.bytes);
  const reqBytes = fmtBytes(reqLine.bytes);

  let didInfo = null;
  const requestedDids = sid === 0x22 ? getRequestedDids(reqLine.bytes) : null;
  const writtenDids = sid === 0x2E ? getWrittenDids(reqLine.bytes) : null;
  const requestedRoutines = sid === 0x31 ? getRequestedRoutines(reqLine.bytes) : null;
  if ((sid === 0x22 || sid === 0x2E) && reqLine.bytes.length >= 3) {
    const num = (reqLine.bytes[1] << 8) | reqLine.bytes[2];
    const entry = didEntry(num);
    didInfo = {
      did: num,
      label: `0x${hx(reqLine.bytes[1])}${hx(reqLine.bytes[2])}`,
      name: entry ? entry.name : null,
      encoding: entry ? entry.encoding : null,
      decoded: null,
    };
  }
  let dids = null;
  let routines = null;

  if (!respLine) {
    if (isTesterPresentSuppressed(reqLine.bytes)) {
      return {
        request: reqLine, response: null,
        severity: 'OK', service: svcName, subFunction,
        requestBytes: reqBytes, responseBytes: '',
        verdict: 'TesterPresent with suppress-positive-response bit set — no response expected.',
        type: 'suppress', nrcCode: null, did: didInfo, dids, routines,
      };
    }
    if (requestedDids && requestedDids.length > 1) {
      dids = requestedDids.map(d => didRow(d, null));
    } else if (writtenDids && writtenDids.length > 1) {
      dids = writtenDids.map(d => didRow(d, null));
    }
    // 0x31 batch detection is response-confirmed only — see the OK branch
    // below. We don't populate `routines` for no-response / pending cases.
    if (hadPending) {
      return {
        request: reqLine, response: null,
        severity: 'FAIL', service: svcName, subFunction,
        requestBytes: reqBytes, responseBytes: '',
        verdict: `ResponsePending (NRC 0x78) received ${pendingCount} time(s) but no final response arrived — ECU timed out mid-operation. Increase the P2-star timeout, ensure TesterPresent keep-alive is running, and retry.`,
        type: 'pending_timeout', nrcCode: null, did: didInfo, dids, routines,
      };
    }
    return {
      request: reqLine, response: null,
      severity: 'WARN', service: svcName, subFunction,
      requestBytes: reqBytes, responseBytes: '',
      verdict: 'No response received — possible CAN addressing mismatch, ECU not present on bus, or module sleeping. Verify TX/RX CAN IDs and module power/ground.',
      type: 'no_response', nrcCode: null, did: didInfo, dids, routines,
    };
  }

  const respBytes = respLine.bytes;

  if (respBytes[0] === 0x7F) {
    const nrcCode = respBytes.length >= 3 ? respBytes[2] : null;
    const entry = nrcCode !== null ? lookupNrc(nrcCode) : null;
    const nrcName = entry ? entry.shortName : (nrcCode !== null ? `0x${hx(nrcCode)}` : '?');
    const nrcDesc = entry ? entry.description : 'Unknown NRC';
    const cause = nrcCode !== null ? NRC_PLAIN_CAUSES[nrcCode] : null;
    const isPending = entry?.isPending ?? false;

    const parts = [`NRC 0x${nrcCode !== null ? hx(nrcCode) : '??'} (${nrcName}) — ${nrcDesc}.`];
    if (cause) parts.push(cause);
    if (hadPending) parts.push(`Preceded by ${pendingCount} ResponsePending (0x78) frame(s).`);

    if (requestedDids && requestedDids.length > 1) {
      dids = requestedDids.map(d => didRow(d, null));
    } else if (writtenDids && writtenDids.length > 1) {
      const nrcStatus = `NRC 0x${hx(nrcCode ?? 0)} (${nrcName})`;
      dids = writtenDids.map(d => didRow(d, nrcStatus));
    }
    // Note: we intentionally do NOT attach per-routine NRC sub-rows.
    // A 0x31 request alone cannot be unambiguously classified as a batch
    // (option records and RID lists look identical on the wire) and the
    // NRC response gives us no extra evidence either way.
    return {
      request: reqLine, response: respLine,
      severity: isPending ? 'WARN' : 'FAIL',
      service: svcName, subFunction,
      requestBytes: reqBytes, responseBytes: fmtBytes(respBytes),
      verdict: parts.join(' '),
      type: 'nrc', nrcCode, nrcName, did: didInfo, dids, routines,
    };
  }

  const parts = [];
  if (hadPending) parts.push(`Completed after ${pendingCount} ResponsePending frame(s).`);

  if (sid === 0x27) {
    const sf = reqLine.bytes[1] ?? 0;
    if (sf % 2 === 1) {
      const seed = respBytes.slice(2);
      parts.push(`Seed received: ${fmtBytes(seed)}.`);
    } else {
      parts.push('SecurityAccess key accepted — level unlocked.');
    }
  } else if (sid === 0x10) {
    parts.push(`Session 0x${hx(reqLine.bytes[1] ?? 0)} confirmed.`);
  } else if (sid === 0x22 && reqLine.bytes.length >= 3 && didInfo && requestedDids) {
    const payloadAfterSid = respBytes[0] === 0x62 ? respBytes.slice(1) : null;
    const split = payloadAfterSid ? splitMultiDidResponse(requestedDids, payloadAfterSid) : null;
    if (split && split.length >= 1) {
      dids = split;
      didInfo.decoded = split[0].decoded;
      if (split.length === 1) {
        const row = split[0];
        if (row.name) parts.push(`DID ${row.label} ${row.name}: ${row.decoded}`);
        else parts.push(`DID ${row.label}: ${row.decoded}`);
      } else {
        const lines = split.map(r => r.name
          ? `${r.label} ${r.name}: ${r.decoded}`
          : `${r.label}: ${r.decoded}`);
        parts.push(`Multi-DID read (${split.length} DIDs): ${lines.join(' | ')}`);
      }
    } else {
      const payload = respBytes.slice(3);
      const decoded = payload.length ? decodeDid(didInfo.did, payload) : '(empty)';
      didInfo.decoded = decoded;
      if (requestedDids.length > 1) {
        dids = requestedDids.map(d => didRow(d, null));
        const labels = dids.map(r => r.name ? `${r.label} ${r.name}` : r.label).join(', ');
        parts.push(`Multi-DID read response could not be split (${labels}); raw payload: ${fmtBytes(respBytes.slice(1))}`);
      } else if (didInfo.name) {
        parts.push(`DID ${didInfo.label} ${didInfo.name}: ${decoded}`);
      } else {
        parts.push(`DID ${didInfo.label}: ${decoded}`);
      }
    }
  } else if (sid === 0x2E && reqLine.bytes.length >= 3 && didInfo) {
    const payloadAfterSid = respBytes[0] === 0x6E ? respBytes.slice(1) : null;
    const split = (payloadAfterSid && writtenDids)
      ? splitMultiDidWriteResponse(writtenDids, payloadAfterSid)
      : null;
    if (split && split.length > 1) {
      dids = split;
      const lines = split.map(r => r.name
        ? `${r.label} ${r.name}: written successfully`
        : `${r.label}: written successfully`);
      parts.push(`Multi-DID write (${split.length} DIDs): ${lines.join(' | ')}`);
    } else if (writtenDids && writtenDids.length > 1) {
      dids = writtenDids.map(d => didRow(d, null));
      const labels = dids.map(r => r.name ? `${r.label} ${r.name}` : r.label).join(', ');
      parts.push(`Multi-DID write response could not be split (${labels}); raw payload: ${fmtBytes(respBytes.slice(1))}`);
    } else {
      parts.push(didInfo.name
        ? `DID ${didInfo.label} ${didInfo.name} written successfully.`
        : `DID ${didInfo.label} written successfully.`);
    }
  } else if (sid === 0x31 && reqLine.bytes.length >= 4) {
    const typeByte = reqLine.bytes[1];
    const payloadAfterSid = (respBytes[0] === 0x71 && respBytes.length >= 2 && respBytes[1] === typeByte)
      ? respBytes.slice(2)
      : null;
    // Batch detection is response-confirmed: only render multi-routine
    // when the candidate RID list (3+ RIDs) splits cleanly against the
    // response payload. Otherwise fall through to legacy single-routine
    // rendering — never emit a misleading "could not be split" verdict
    // for what may simply be a normal single-routine response.
    const split = (payloadAfterSid && requestedRoutines)
      ? splitMultiRoutineResponse(requestedRoutines, payloadAfterSid)
      : null;
    if (split && split.length > 1) {
      routines = split;
      const lines = split.map(r => `${r.label}: ${r.status}`);
      parts.push(`Multi-routine (${split.length} routines, type 0x${hx(typeByte)}): ${lines.join(' | ')}`);
    } else {
      const rid = `0x${hx(reqLine.bytes[2])}${hx(reqLine.bytes[3])}`;
      parts.push(`Routine ${rid} type 0x${hx(typeByte)} completed.`);
    }
  } else if (sid === 0x11) {
    parts.push('ECU reset acknowledged.');
  } else if (sid === 0x14) {
    parts.push('DTCs cleared.');
  } else if (sid === 0x3E) {
    parts.push('Keep-alive acknowledged.');
  }

  if (!parts.length) parts.push('Positive response received.');

  return {
    request: reqLine, response: respLine,
    severity: 'OK', service: svcName, subFunction,
    requestBytes: reqBytes, responseBytes: fmtBytes(respBytes),
    verdict: parts.join(' '),
    type: 'ok', nrcCode: null, did: didInfo, dids, routines,
  };
}

/**
 * Analyze a parsed trace and produce exchanges, summary, and diagnosis.
 *
 * @param {ReturnType<import('./parser.js').parseTrace>['lines']} parsedLines
 * @returns {{
 *   exchanges: object[],
 *   summary: object,
 *   diagnosis: object[],
 * }}
 */
export function analyzeSession(parsedLines) {
  const exchanges = [];

  let saState = {
    seen: false,
    unlocked: false,
    level: null,
    wrongKeyCount: 0,
    lockoutActive: false,
  };

  let currentSession = 0x01;
  let firstFailure = null;
  let pendingTimeouts = 0;
  let sessionEscalated = false;

  const used = new Set();

  for (let i = 0; i < parsedLines.length; i++) {
    if (used.has(i)) continue;
    const line = parsedLines[i];

    if (line.isFF || line.isCF) {
      const kind = line.isFF
        ? 'First Frame buffered but not enough Consecutive Frames arrived to complete the message'
        : 'Orphan Consecutive Frame — no matching First Frame on this stream';
      exchanges.push({
        request: line, response: null,
        severity: 'WARN', service: 'Multi-Frame (incomplete)',
        subFunction: null, requestBytes: fmtBytes(line.bytes), responseBytes: '',
        verdict: `${kind}. Payload was truncated or frames arrived out of order — review the raw capture for the missing CF(s).`,
        type: 'multiframe', nrcCode: null,
      });
      used.add(i);
      continue;
    }

    if (line.dir !== 'req') {
      if (!used.has(i) && line.dir === 'resp') {
        exchanges.push({
          request: null, response: line,
          severity: 'WARN', service: serviceName(line.bytes) || 'Unknown',
          subFunction: null, requestBytes: '', responseBytes: fmtBytes(line.bytes),
          verdict: 'Response without a matching request in this trace — partial capture or functional broadcast reply.',
          type: 'orphan_resp', nrcCode: null,
        });
        used.add(i);
      }
      continue;
    }

    used.add(i);

    // Stamp the SecurityAccess state observed BEFORE this request is issued.
    // Used by buildDiagnosis to flag secured services (0x31 / 0x2E / 0x34)
    // attempted while still locked, independent of how the ECU responded.
    const saSeenAtRequest = saState.seen;
    const saUnlockedAtRequest = saState.unlocked;

    const pendingNrcs = [];
    let respIdx = -1;

    for (let j = i + 1; j < parsedLines.length; j++) {
      if (used.has(j)) continue;
      const cand = parsedLines[j];

      if (cand.dir === 'req') {
        if (cand.bytes[0] === 0x3E) continue;
        break;
      }

      if (cand.dir === 'resp' || cand.dir === 'unknown') {
        if (
          cand.bytes[0] === 0x7F &&
          cand.bytes.length >= 3 &&
          cand.bytes[2] === 0x78
        ) {
          pendingNrcs.push(j);
          used.add(j);
          continue;
        }
        respIdx = j;
        used.add(j);
        break;
      }
    }

    const respLine = respIdx >= 0 ? parsedLines[respIdx] : null;
    const hadPending = pendingNrcs.length > 0;
    if (hadPending && !respLine) pendingTimeouts++;

    const exchange = buildExchange(line, respLine, hadPending, pendingNrcs.length);
    exchange.saSeenAtRequest = saSeenAtRequest;
    exchange.saUnlockedAtRequest = saUnlockedAtRequest;
    exchanges.push(exchange);

    if (line.bytes[0] === 0x27) {
      const sf = line.bytes[1] ?? 0;
      if (sf % 2 === 1) {
        saState.seen = true;
        saState.level = Math.ceil(sf / 2);
      } else {
        if (exchange.nrcCode === 0x35) saState.wrongKeyCount++;
        else if (exchange.nrcCode === 0x36) saState.lockoutActive = true;
        else if (exchange.severity === 'OK') saState.unlocked = true;
      }
    }

    if (line.bytes[0] === 0x10 && exchange.severity === 'OK' && line.bytes.length >= 2) {
      currentSession = line.bytes[1];
      if (line.bytes[1] !== 0x01) sessionEscalated = true;
    }

    if (exchange.severity === 'FAIL' && !firstFailure) {
      firstFailure = exchange;
    }
  }

  const diagnosis = buildDiagnosis(exchanges, saState, sessionEscalated, pendingTimeouts);

  const summary = {
    messageCount: parsedLines.length,
    exchangeCount: exchanges.filter(e => e.type !== 'multiframe' && e.type !== 'orphan_resp').length,
    securityAccessSeen: saState.seen,
    securityAccessUnlocked: saState.unlocked,
    securityAccessLevel: saState.level,
    wrongKeyCount: saState.wrongKeyCount,
    lockoutActive: saState.lockoutActive,
    firstFailure: firstFailure ? firstFailure.service : null,
    firstFailureNrc: firstFailure ? firstFailure.nrcCode : null,
    pendingTimeouts,
    noResponseCount: exchanges.filter(e => e.type === 'no_response').length,
    sessionEscalated,
    currentSession,
  };

  return { exchanges, summary, diagnosis };
}

function buildDiagnosis(exchanges, saState, sessionEscalated, pendingTimeouts) {
  const items = [];

  const noRespCount = exchanges.filter(e => e.type === 'no_response').length;
  if (noRespCount > 0) {
    items.push({
      code: 'NO_RESPONSE', severity: 'FAIL',
      message: `${noRespCount} request(s) received no response.`,
      recommendation: 'Verify TX/RX CAN IDs for the target module. Check that the module has power and is on the CAN bus (try TesterPresent to functional broadcast 0x7DF). Confirm bit rate and bus termination.',
    });
  }

  const sadList = exchanges.filter(e => e.nrcCode === 0x33);
  if (sadList.length > 0) {
    items.push({
      code: 'SAD', severity: 'FAIL',
      message: `SecurityAccess denied (NRC 0x33) on ${sadList.length} service(s): ${sadList.map(e => e.service).join(', ')}.`,
      recommendation: 'The rejected service requires a security unlock first. Complete the 0x27 seed/key handshake before retrying.',
    });
  }

  if (saState.wrongKeyCount > 0) {
    items.push({
      code: 'IK', severity: 'FAIL',
      message: `SecurityAccess key rejected (NRC 0x35) ${saState.wrongKeyCount} time(s).`,
      recommendation: 'Verify the algorithm selection (check module part number and year), S-box bytes if applicable, seed byte order (big-endian vs little-endian), and that the key sub-function is exactly seed sub-function + 1.',
    });
  }

  if (saState.lockoutActive) {
    items.push({
      code: 'ENOA', severity: 'FAIL',
      message: 'SecurityAccess lockout active (NRC 0x36) — too many wrong keys.',
      recommendation: 'Hard-reset the module (0x11 0x01) and wait the mandatory delay (often 10+ minutes in programming mode). Do not retry immediately — the delay timer resets on each attempt.',
    });
  }

  const rtdneList = exchanges.filter(e => e.nrcCode === 0x37);
  if (rtdneList.length > 0) {
    items.push({
      code: 'RTDNE', severity: 'WARN',
      message: `Required time delay not expired (NRC 0x37) seen ${rtdneList.length} time(s).`,
      recommendation: 'The tool is retrying too quickly after a failed key attempt. Add a wait of at least 5–10 s (or the ECU-specified P2-star timeout) before requesting a new seed.',
    });
  }

  const cncList = exchanges.filter(e => e.nrcCode === 0x22);
  if (cncList.length > 0) {
    items.push({
      code: 'CNC', severity: 'FAIL',
      message: `Conditions not correct (NRC 0x22) on: ${cncList.map(e => e.service).join(', ')}.`,
      recommendation: 'Preconditions not met. Common causes: wrong session type, engine running when it should be off, vehicle speed not zero, or a prerequisite service (e.g. CommunicationControl, ControlDTCSetting) not yet invoked.',
    });
  }

  const rseList = exchanges.filter(e => e.nrcCode === 0x24);
  if (rseList.length > 0) {
    items.push({
      code: 'RSE', severity: 'FAIL',
      message: `Request sequence error (NRC 0x24) on: ${rseList.map(e => e.service).join(', ')}.`,
      recommendation: 'A service was called before its prerequisites. Standard flow: DiagnosticSessionControl (extended/programming) → SecurityAccess seed/key → WriteDataByIdentifier / RoutineControl. Ensure each step fully succeeds before advancing.',
    });
  }

  const roorList = exchanges.filter(e => e.nrcCode === 0x31);
  if (roorList.length > 0) {
    items.push({
      code: 'ROOR', severity: 'FAIL',
      message: `Request out of range (NRC 0x31) on: ${roorList.map(e => e.service).join(', ')}.`,
      recommendation: 'The DID or routine ID is not supported in this session or ECU variant. Try a different session or cross-reference the correct DID/routine for this part number.',
    });
  }

  const gpfList = exchanges.filter(e => e.nrcCode === 0x72);
  if (gpfList.length > 0) {
    items.push({
      code: 'GPF', severity: 'FAIL',
      message: `General programming failure (NRC 0x72) on: ${gpfList.map(e => e.service).join(', ')}.`,
      recommendation: 'Flash write/erase failed. Ensure supply voltage ≥13.5 V, block address/length alignment is correct, firmware image matches ECU hardware variant, and CommunicationControl + ControlDTCSetting were invoked before download.',
    });
  }

  if (pendingTimeouts > 0) {
    items.push({
      code: 'RCRRP_TIMEOUT', severity: 'FAIL',
      message: `${pendingTimeouts} request(s) sent ResponsePending (0x78) but never returned a final result.`,
      recommendation: 'ECU started a long operation (flash erase, routine) but communication timed out. Increase the J2534 P2-star timeout. Run TesterPresent keep-alive at 1–2 s intervals. Check for bus collisions on slow physical layers.',
    });
  }

  const snsiasExchanges = exchanges.filter(e => e.nrcCode === 0x7F);
  if (snsiasExchanges.length > 0) {
    items.push({
      code: 'SNSIAS', severity: 'FAIL',
      message: `Service not supported in active session (NRC 0x7F) for: ${snsiasExchanges.map(e => e.service).join(', ')}.`,
      recommendation: 'Escalate the session: use 0x10 0x03 for extended (config reads/writes) or 0x10 0x02 for programming (flash operations).',
    });
  }

  // Secured service attempted before SecurityAccess unlocked. Catches the
  // case the Python reference flags where the ECU returns NRC 0x22 / 0x24
  // / silence (or even a positive response in a permissive mode) and the
  // real underlying cause is that the unlock step was skipped. Independent
  // of whether the NRC happened to be 0x33.
  const SECURED_SIDS = new Set([0x31, 0x2E, 0x34]);
  const securedWithoutUnlock = exchanges.filter(e =>
    e.request &&
    SECURED_SIDS.has(e.request.bytes[0]) &&
    e.saUnlockedAtRequest === false,
  );
  if (securedWithoutUnlock.length > 0) {
    const anySeen = securedWithoutUnlock.some(e => e.saSeenAtRequest);
    const anyActuallyFailed = securedWithoutUnlock.some(e => e.severity === 'FAIL');
    const services = Array.from(new Set(securedWithoutUnlock.map(e => e.service))).join(', ');
    const subCase = anySeen
      ? 'SecurityAccess was requested in this trace but no successful unlock (positive 0x67 to an even sub-function) was observed before the secured service was attempted.'
      : 'No SecurityAccess (0x27) request was issued at all in this trace before the secured service was attempted.';
    // FAIL when at least one secured request actually failed (NRC). Downgrade
    // to WARN when every matched request returned a positive response — the
    // trace may simply be missing the earlier unlock (e.g. unlock happened
    // before logging started), so flag it but don't escalate to a failure.
    items.push({
      code: 'SECURED_WITHOUT_UNLOCK',
      severity: anyActuallyFailed ? 'FAIL' : 'WARN',
      message: `Secured service(s) attempted without a completed SecurityAccess unlock: ${services}.`,
      recommendation: `${subCase} 0x31 / 0x2E / 0x34 typically require an unlocked security level. Run the seed/key handshake (0x27 sub-function odd → ECU returns seed → 0x27 next sub-function with computed key → positive 0x67) in the same session, then retry. If the unlock occurred before this trace started, capture from the unlock step to confirm.`,
    });
  }

  const hasFails = exchanges.some(e => e.severity === 'FAIL');
  if (hasFails && !sessionEscalated) {
    const didTrySession = exchanges.some(e => e.request?.bytes[0] === 0x10 && e.severity === 'OK');
    if (!didTrySession) {
      items.push({
        code: 'NO_SESSION', severity: 'WARN',
        message: 'No successful DiagnosticSessionControl observed — session may still be in Default (0x01).',
        recommendation: 'Most write/routine/security services require extended (0x10 0x03) or programming (0x10 0x02) session. Add an explicit session escalation step at the start of the sequence.',
      });
    }
  }

  if (items.length === 0) {
    items.push({
      code: 'CLEAN', severity: 'OK',
      message: 'No issues detected — all exchanges completed successfully.',
      recommendation: 'Session looks healthy.',
    });
  }

  return items;
}
