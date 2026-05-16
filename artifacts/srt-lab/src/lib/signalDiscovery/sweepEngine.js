// Signal Discovery — sweep engine.
//
// Drives @workspace/uds builders/parsers through whatever transport
// engine the OBD/UDS tabs already use (createEngineForActiveTransport).
// Pure async generator: callers are responsible for streaming results
// to the API server and to the UI.

import { build } from "@workspace/uds";
import { bytesToHex } from "./decoder.js";

/** Decode a UDS RDBI 0x62 response into the raw value bytes (DID stripped). */
export function extractDidValue(resp) {
  if (!resp || resp.length < 3) return null;
  if (resp[0] !== 0x62) return null;
  return resp.slice(3);
}

/**
 * Detect whether a response is a Negative Response (0x7F) and return
 * its NRC byte, or null when the frame is positive / missing.
 */
export function nrcOf(resp) {
  if (!resp || resp.length < 3) return null;
  if (resp[0] !== 0x7f) return null;
  return resp[2] & 0xff;
}

/**
 * Sweep one ECU for DIDs in the given range. Yields one event per DID:
 *
 *   { kind: 'did', did, length, sample, nrc }
 *   { kind: 'progress', done, total, etaMs }
 *
 * `delayMs` paces the bus to avoid 0x21 BusyRepeatRequest from chatty
 * ECUs. `signal` is an optional AbortSignal so the UI can cancel.
 * `pauseRef` is an optional `{current: boolean}` ref for pause/resume.
 * `cursorStart` lets the caller resume mid-range after a crash.
 */
export async function* sweepDidRange(engine, tx, rx, {
  start = 0xf100,
  end = 0xf1ff,
  delayMs = 25,
  signal = null,
  pauseRef = null,
  cursorStart = null,
} = {}) {
  const realStart = cursorStart != null ? cursorStart : start;
  const total = end - start + 1;
  let done = realStart - start;
  const t0 = Date.now();
  for (let did = realStart; did <= end; did++) {
    if (signal && signal.aborted) return;
    while (pauseRef && pauseRef.current) {
      if (signal && signal.aborted) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    const r = await engine.uds(tx, rx, build.readDataByIdentifier({ dids: [did] }));
    done++;
    if (r && r.ok && r.d) {
      const nrc = nrcOf(r.d);
      if (nrc !== null) {
        // 0x31 (requestOutOfRange) is the "DID does not exist" answer
        // — drop the noise, keep everything else for diagnosis.
        if (nrc !== 0x31) {
          yield { kind: "did", did, length: 0, sample: null, nrc, cursor: did };
        }
      } else {
        const value = extractDidValue(r.d);
        if (value) {
          yield {
            kind: "did",
            did,
            length: value.length,
            sample: bytesToHex(value),
            nrc: null,
            cursor: did,
          };
        }
      }
    }
    if ((done & 0x07) === 0) {
      const elapsed = Date.now() - t0;
      const rate = done / Math.max(1, elapsed); // items/ms
      const remaining = total - done;
      const etaMs = rate > 0 ? Math.round(remaining / rate) : null;
      yield { kind: "progress", done, total, etaMs, cursor: did };
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  yield { kind: "progress", done, total, etaMs: 0, cursor: end };
}

/**
 * Per-ECU UDS service discovery — sends a one-byte SID for each
 * commonly-supported diagnostic service and classifies the response
 * as 'positive', 'nrc:<hex>', or 'timeout'. Provides a fingerprint
 * of which UDS services the ECU implements without unlocking anything.
 */
/**
 * Plan a chunked DID sweep across a wide range. Returns an ordered
 * array of `{start, end}` chunks so the UI can sweep, persist, and
 * checkpoint each chunk independently. The TUMFTM paper recommends
 * always covering the standard 0xF1xx identification block first
 * (cheap, high-value DIDs like VIN/PN/SW), then the broad
 * 0x0100–0xFFFF default range in user-sized chunks.
 */
export function planDidChunks({
  includeStandardBlock = true,
  fullRange = false,
  start = 0xf100,
  end = 0xf1ff,
  chunkSize = 0x100,
} = {}) {
  const chunks = [];
  if (includeStandardBlock) {
    chunks.push({ start: 0xf100, end: 0xf1ff, label: "F1xx ident" });
  }
  if (fullRange) {
    for (let s = 0x0100; s <= 0xffff; s += chunkSize) {
      const e = Math.min(0xffff, s + chunkSize - 1);
      // Skip the F1xx block if already queued above.
      if (includeStandardBlock && s >= 0xf100 && e <= 0xf1ff) continue;
      chunks.push({ start: s, end: e, label: `0x${s.toString(16).toUpperCase()}–0x${e.toString(16).toUpperCase()}` });
    }
  } else if (!includeStandardBlock || start !== 0xf100 || end !== 0xf1ff) {
    chunks.push({ start, end, label: `0x${start.toString(16).toUpperCase()}–0x${end.toString(16).toUpperCase()}` });
  }
  return chunks;
}

export const DISCOVERABLE_SERVICES = [
  { sid: 0x10, name: "DiagnosticSessionControl",  payload: [0x10, 0x01] },
  { sid: 0x11, name: "ECUReset",                  payload: [0x11, 0x00] }, // sub 0 = reserved → expect NRC
  { sid: 0x14, name: "ClearDTCs",                 payload: [0x14, 0xff, 0xff, 0xff] },
  { sid: 0x19, name: "ReadDTCInformation",        payload: [0x19, 0x02, 0xff] },
  { sid: 0x22, name: "ReadDataByIdentifier",      payload: [0x22, 0xf1, 0x90] },
  { sid: 0x27, name: "SecurityAccess",            payload: [0x27, 0x00] }, // sub 0 = invalid → expect NRC
  { sid: 0x28, name: "CommunicationControl",      payload: [0x28, 0x00, 0x00] },
  { sid: 0x2e, name: "WriteDataByIdentifier",     payload: [0x2e, 0x00, 0x00] },
  { sid: 0x2f, name: "InputOutputControl",        payload: [0x2f, 0x00, 0x00, 0x00] },
  { sid: 0x31, name: "RoutineControl",            payload: [0x31, 0x01, 0x00, 0x00] },
  { sid: 0x34, name: "RequestDownload",           payload: [0x34, 0x00, 0x44, 0x00, 0x00] },
  { sid: 0x3e, name: "TesterPresent",             payload: [0x3e, 0x00] },
  { sid: 0x85, name: "ControlDTCSetting",         payload: [0x85, 0x01] },
];

export async function* discoverServices(engine, tx, rx, { delayMs = 30, signal = null } = {}) {
  for (const svc of DISCOVERABLE_SERVICES) {
    if (signal && signal.aborted) return;
    const r = await engine.uds(tx, rx, svc.payload, { timeoutMs: 200 });
    let result;
    if (!r || !r.ok || !r.d || r.d.length === 0) {
      result = { sid: svc.sid, name: svc.name, status: "timeout", nrc: null };
    } else {
      const nrc = nrcOf(r.d);
      if (nrc !== null) {
        // NRC 0x11 (serviceNotSupported) ⇒ ECU does NOT implement.
        // Anything else (including 0x13/0x33/0x7f) means it does.
        result = {
          sid: svc.sid,
          name: svc.name,
          status: nrc === 0x11 ? "unsupported" : "supported-nrc",
          nrc,
        };
      } else {
        result = { sid: svc.sid, name: svc.name, status: "positive", nrc: null };
      }
    }
    yield result;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
}

/**
 * Probe a single tester address for liveness. Sends a tester-present
 * (0x3E 00) and reports whether the ECU answered (positive or NRC).
 */
export async function probeEcu(engine, tx, rx, { timeoutMs = 200 } = {}) {
  const r = await engine.uds(tx, rx, build.testerPresent({ suppressResponse: false }), {
    timeoutMs,
  });
  if (!r || !r.ok || !r.d || r.d.length === 0) return false;
  // 0x7E is the positive tester-present response; an NRC also confirms
  // the address is alive.
  return r.d[0] === 0x7e || r.d[0] === 0x7f;
}
