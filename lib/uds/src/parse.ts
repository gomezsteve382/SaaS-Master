/**
 * ISO 14229-1 generic response parser.
 *
 * parse.response(frame) decodes any UDS response frame into a structured
 * result, performing NRC lookup and sub-function echo detection. All
 * byte-level work is done here so callers never need to poke at raw bytes.
 */

import { serviceForPosRsp } from './services.js';
import { nrcEntry } from './nrc.js';

export interface ParsedResponse {
  /** true = positive response, false = negative response or unrecognised frame. */
  ok: boolean;
  /** Service identifier echoed in the positive response (posRsp - 0x40). */
  sid: number | null;
  /** Positive response SID byte (first byte of a positive response). */
  posRsp: number | null;
  /** Human-readable service name, if known. */
  serviceName: string | null;
  /** Sub-function echo, if present (byte immediately after the PRS SID for services that echo it). */
  subFunction: number | null;
  /** Payload bytes after the SID (and optional sub-function echo). */
  payload: Uint8Array;
  /** NRC code for a negative response, null for positive. */
  nrc: number | null;
  /** Short NRC name (e.g. 'SAD', 'IK'). */
  nrcName: string | null;
  /** Full NRC description. */
  nrcDescription: string | null;
  /** true when NRC is a temporary/pending condition — caller should retry. */
  nrcIsPending: boolean;
}

/**
 * Positive-response SID values where the ECU echoes the request sub-function
 * byte (with the suppressPosRspMsgIndicationBit masked off) as the first byte
 * after the PRS SID.  Derived from ISO 14229-1 §10 for each service.
 */
const ECHO_SUBFUNC_POSRSP: ReadonlySet<number> = new Set([
  0x50, // DiagnosticSessionControl
  0x51, // ECUReset
  0x59, // ReadDTCInformation — sub-function echo precedes DTC data
  0x67, // SecurityAccess — echoes sub-function (seed byte(s) follow)
  0x68, // CommunicationControl
  0x69, // Authentication — sub-function echo precedes response record
  0x6C, // DynamicallyDefineDataIdentifier — sub-function echo + target DDDID
  0x71, // RoutineControl — sub-function echo + routineIdentifier follow
  0x7E, // TesterPresent
  0xC3, // AccessTimingParameter
  0xC5, // ControlDTCSetting
  0xC6, // ResponseOnEvent — sub-function echo precedes event window/record
  0xC7, // LinkControl
]);

/**
 * Decode a raw UDS response frame.
 *
 * Accepts: Uint8Array | number[] | ArrayBuffer | ArrayLike<number>.
 * Returns a fully-populated ParsedResponse. Never throws.
 */
export function parseResponse(frame: Uint8Array | number[] | ArrayLike<number>): ParsedResponse {
  const d = frame instanceof Uint8Array ? frame : new Uint8Array(Array.from(frame as number[]));

  const empty: ParsedResponse = {
    ok: false, sid: null, posRsp: null, serviceName: null,
    subFunction: null, payload: new Uint8Array(0),
    nrc: null, nrcName: null, nrcDescription: null, nrcIsPending: false,
  };

  if (!d || d.length === 0) return empty;

  const first = d[0];

  // ── Negative response: 0x7F <SID> <NRC> ──────────────────────────────
  if (first === 0x7F) {
    const sid  = d.length >= 2 ? d[1] : null;
    const code = d.length >= 3 ? d[2] : null;
    const entry = code !== null ? nrcEntry(code) : undefined;
    return {
      ...empty,
      ok: false,
      sid,
      posRsp: null,
      serviceName: null,
      nrc: code,
      nrcName: entry?.shortName ?? null,
      nrcDescription: entry?.description ?? null,
      nrcIsPending: entry?.isPending ?? false,
      payload: d.length > 3 ? d.slice(3) : new Uint8Array(0),
    };
  }

  // ── Guard: positive response SIDs are always >= 0x50 (request SID | 0x40).
  // The minimum valid UDS request SID is 0x10, so the minimum valid positive
  // response SID is 0x10 | 0x40 = 0x50. Bytes 0x01–0x4F are either request
  // SIDs or the reserved/impossible range 0x40–0x4F — reject all of them so
  // we never produce a negative or implausible SID value.
  if (first < 0x50) return empty;

  // ── Positive response ─────────────────────────────────────────────────
  const posRsp = first;
  const sid = posRsp - 0x40;  // ISO 14229: posRsp = sid | 0x40; guaranteed >= 0
  const service = serviceForPosRsp(posRsp);
  const serviceName = service?.name ?? null;

  // Determine sub-function echo presence
  let subFunction: number | null = null;
  let payloadStart = 1;
  if (ECHO_SUBFUNC_POSRSP.has(posRsp) && d.length >= 2) {
    subFunction = d[1] & 0x7F; // strip suppress-bit
    payloadStart = 2;
  }

  const payload = d.slice(payloadStart);

  return {
    ok: true,
    sid,
    posRsp,
    serviceName,
    subFunction,
    payload,
    nrc: null,
    nrcName: null,
    nrcDescription: null,
    nrcIsPending: false,
  };
}

// ─── Service-specific parsers ─────────────────────────────────────────

export interface ReadDbiParsedResult {
  ok: boolean;
  /** Parsed DID entries (positive response). */
  entries: Array<{ did: number; data: Uint8Array }>;
  nrc: number | null;
}

/**
 * Parse a 0x62 ReadDataByIdentifier positive response, splitting it into
 * per-DID records. Requires the list of requested DIDs in order (the spec
 * doesn't encode per-DID lengths — forward scanning is required).
 */
export function parseReadDataByIdentifierResponse(
  frame: Uint8Array | number[],
  requestedDids: number[]
): ReadDbiParsedResult {
  const d = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (!d.length) return { ok: false, entries: [], nrc: null };
  if (d[0] === 0x7F) return { ok: false, entries: [], nrc: d[2] ?? null };
  if (d[0] !== 0x62) return { ok: false, entries: [], nrc: null };
  const body = d.slice(1);
  const positions: Array<{ did: number; pos: number }> = [];
  let cursor = 0;
  for (const did of requestedDids) {
    const hi = (did >> 8) & 0xFF, lo = did & 0xFF;
    let pos = -1;
    for (let i = cursor; i + 1 < body.length; i++) {
      if (body[i] === hi && body[i + 1] === lo) { pos = i; break; }
    }
    positions.push({ did, pos });
    if (pos >= 0) cursor = pos + 2;
  }
  const entries: Array<{ did: number; data: Uint8Array }> = positions.map((entry, i) => {
    if (entry.pos < 0) return { did: entry.did, data: new Uint8Array(0) };
    const start = entry.pos + 2;
    let end = body.length;
    for (let j = i + 1; j < positions.length; j++) {
      if (positions[j].pos >= 0) { end = positions[j].pos; break; }
    }
    return { did: entry.did, data: body.slice(start, end) };
  });
  return { ok: true, entries, nrc: null };
}

export interface SecurityAccessSeedResult {
  ok: boolean;
  subFunction: number | null;
  seedBytes: Uint8Array;
  nrc: number | null;
}

/** Parse a 0x67 SecurityAccess seed response (sub-function + seed bytes). */
export function parseSecurityAccessSeedResponse(frame: Uint8Array | number[]): SecurityAccessSeedResult {
  const d = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (!d.length) return { ok: false, subFunction: null, seedBytes: new Uint8Array(0), nrc: null };
  if (d[0] === 0x7F) return { ok: false, subFunction: null, seedBytes: new Uint8Array(0), nrc: d[2] ?? null };
  if (d[0] !== 0x67 || d.length < 2) return { ok: false, subFunction: null, seedBytes: new Uint8Array(0), nrc: null };
  return { ok: true, subFunction: d[1], seedBytes: d.slice(2), nrc: null };
}

export interface RoutineControlParsedResult {
  ok: boolean;
  controlType: number | null;
  routineIdentifier: number | null;
  statusRecord: Uint8Array;
  nrc: number | null;
}

/** Parse a 0x71 RoutineControl positive response. */
export function parseRoutineControlResponse(frame: Uint8Array | number[]): RoutineControlParsedResult {
  const d = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (!d.length) return { ok: false, controlType: null, routineIdentifier: null, statusRecord: new Uint8Array(0), nrc: null };
  if (d[0] === 0x7F) return { ok: false, controlType: null, routineIdentifier: null, statusRecord: new Uint8Array(0), nrc: d[2] ?? null };
  if (d[0] !== 0x71 || d.length < 4) return { ok: false, controlType: null, routineIdentifier: null, statusRecord: new Uint8Array(0), nrc: null };
  return {
    ok: true,
    controlType: d[1],
    routineIdentifier: (d[2] << 8) | d[3],
    statusRecord: d.slice(4),
    nrc: null,
  };
}

export interface RequestDownloadParsedResult {
  ok: boolean;
  /** Length format identifier (high nibble = maxNumberOfBlockLength byte count). */
  lengthFormatIdentifier: number | null;
  /** Maximum number of bytes per TransferData block (derived from response). */
  maxBlockLength: number | null;
  nrc: number | null;
}

/**
 * Alias for parseResponse — exposed as `parse.response(frame)` via the
 * `export * as parse` namespace re-export in index.ts.
 */
export const response = parseResponse;

/** Parse a 0x74 RequestDownload positive response to extract maxBlockLength. */
export function parseRequestDownloadResponse(frame: Uint8Array | number[]): RequestDownloadParsedResult {
  const d = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (!d.length) return { ok: false, lengthFormatIdentifier: null, maxBlockLength: null, nrc: null };
  if (d[0] === 0x7F) return { ok: false, lengthFormatIdentifier: null, maxBlockLength: null, nrc: d[2] ?? null };
  if (d[0] !== 0x74 || d.length < 2) return { ok: false, lengthFormatIdentifier: null, maxBlockLength: null, nrc: null };
  const lfi = d[1];
  const maxLenBytes = (lfi >> 4) & 0x0F;
  let maxBlockLength = 0;
  for (let i = 0; i < maxLenBytes && 2 + i < d.length; i++) {
    maxBlockLength = (maxBlockLength << 8) | d[2 + i];
  }
  return { ok: true, lengthFormatIdentifier: lfi, maxBlockLength, nrc: null };
}
