/**
 * Log-stream UDS reassembly + decode.
 *
 * Sits on top of `candump.ts` and `isotp.ts` and emits typed
 * request/response pairs ready for the SRT-Lab Log Analyser timeline.
 */

import type { CandumpFrame } from './candump.js';
import { IsoTpReceiver, frameType } from './isotp.js';
import { parseResponse } from './parse.js';
import { serviceForSid, serviceForPosRsp } from './services.js';
import { nrcEntry } from './nrc.js';
import { decodeDid, didEntry } from './dids.js';

/** A reassembled UDS PDU together with the contributing CAN frames. */
export interface ReassembledPdu {
  /** CAN ID this PDU was carried on. */
  id: number;
  ext: boolean;
  /** Capture timestamp of the first contributing CAN frame. */
  startTs: number;
  /** Capture timestamp of the last contributing CAN frame. */
  endTs: number;
  /** Number of CAN frames consumed (1 for SF, 1+N for FF+CF…). */
  frameCount: number;
  /** Reassembled UDS PDU bytes (PCI stripped). */
  payload: Uint8Array;
}

export interface ReassembleOptions {
  /** Tester→ECU CAN ID (request side). */
  tx: number;
  /** ECU→Tester CAN ID (response side). */
  rx: number;
  /** When true, swallow malformed sub-sequences instead of throwing. */
  lenient?: boolean;
}

interface PartialState {
  rx: IsoTpReceiver;
  startTs: number;
  frameCount: number;
}

/**
 * Walk a candump frame stream and pair Single-/First-/Consecutive-Frame
 * sub-sequences into reassembled UDS PDUs for the requested ID pair.
 *
 * Flow-control (FC) frames are recognised but not consumed into payloads.
 * Any frames whose ID is neither `tx` nor `rx` are skipped silently.
 *
 * In `lenient` mode (default) the receiver is reset on any sub-sequence
 * error so a corrupt block doesn't poison subsequent traffic.
 */
export function reassembleIsoTp(
  frames: readonly CandumpFrame[],
  opts: ReassembleOptions,
): { request: ReassembledPdu[]; response: ReassembledPdu[] } {
  const lenient = opts.lenient !== false;
  const partials: Record<'tx' | 'rx', PartialState | null> = { tx: null, rx: null };
  const out = { request: [] as ReassembledPdu[], response: [] as ReassembledPdu[] };

  const finishOnto = (which: 'tx' | 'rx', payload: Uint8Array, lastTs: number) => {
    const st = partials[which]!;
    const id = which === 'tx' ? opts.tx : opts.rx;
    const pdu: ReassembledPdu = {
      id, ext: id > 0x7FF,
      startTs: st.startTs, endTs: lastTs,
      frameCount: st.frameCount, payload,
    };
    (which === 'tx' ? out.request : out.response).push(pdu);
    partials[which] = null;
  };

  for (const f of frames) {
    let which: 'tx' | 'rx' | null = null;
    if (f.id === opts.tx) which = 'tx';
    else if (f.id === opts.rx) which = 'rx';
    if (!which) continue;
    if (f.rtr || f.data.length === 0) continue;

    // Flow-control: acknowledge but never reassemble.
    if (frameType(f.data[0]) === 'FC') continue;

    let st = partials[which];
    if (!st) {
      st = { rx: new IsoTpReceiver(), startTs: f.ts, frameCount: 0 };
      partials[which] = st;
    }
    st.frameCount++;
    try {
      const r = st.rx.push(f.data);
      if (r.done && r.payload) finishOnto(which, r.payload, f.ts);
    } catch (err) {
      if (!lenient) throw err;
      // Reset and try treating this frame as the start of a new sub-sequence.
      partials[which] = { rx: new IsoTpReceiver(), startTs: f.ts, frameCount: 1 };
      try {
        const r = partials[which]!.rx.push(f.data);
        if (r.done && r.payload) finishOnto(which, r.payload, f.ts);
      } catch {
        partials[which] = null;
      }
    }
  }

  return out;
}

// ── UDS session decode ───────────────────────────────────────────────

export interface DecodedRequest {
  kind: 'request';
  ts: number;
  sid: number;
  serviceName: string | null;
  subFunction: number | null;
  did: number | null;
  routineIdentifier: number | null;
  payload: Uint8Array;
  /** Raw UDS PDU bytes including SID. */
  raw: Uint8Array;
  human: string;
}

export interface DecodedResponse {
  kind: 'response';
  ts: number;
  sid: number | null;
  serviceName: string | null;
  ok: boolean;
  nrc: number | null;
  nrcName: string | null;
  did: number | null;
  decodedDid: string | null;
  subFunction: number | null;
  payload: Uint8Array;
  raw: Uint8Array;
  human: string;
}

export type DecodedUdsEvent = DecodedRequest | DecodedResponse;

const HEX = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const hexBytes = (d: Uint8Array) => Array.from(d).map(HEX).join(' ');

function decodeRequest(pdu: ReassembledPdu): DecodedRequest {
  const d = pdu.payload;
  const sid = d[0] ?? 0;
  const svc = serviceForSid(sid);
  let subFunction: number | null = null;
  let did: number | null = null;
  let routineIdentifier: number | null = null;
  // Service-specific structural decode for the common requests we care about.
  switch (sid) {
    case 0x10: // DiagnosticSessionControl
    case 0x11: // ECUReset
    case 0x28: // CommunicationControl
    case 0x3E: // TesterPresent
    case 0x85: // ControlDTCSetting
      subFunction = d[1] ?? null;
      break;
    case 0x27: // SecurityAccess
      subFunction = d[1] ?? null;
      break;
    case 0x22: // ReadDataByIdentifier
    case 0x2E: // WriteDataByIdentifier
      if (d.length >= 3) did = (d[1] << 8) | d[2];
      break;
    case 0x31: // RoutineControl
      subFunction = d[1] ?? null;
      if (d.length >= 4) routineIdentifier = (d[2] << 8) | d[3];
      break;
    case 0x14: // ClearDiagnosticInformation
      break;
  }
  let human = svc?.name ?? `Unknown SID 0x${HEX(sid)}`;
  if (subFunction != null) human += ` (sub=0x${HEX(subFunction)})`;
  if (did != null) {
    const e = didEntry(did);
    human += ` DID 0x${did.toString(16).toUpperCase().padStart(4, '0')}`;
    if (e) human += ` (${e.name})`;
  }
  if (routineIdentifier != null) {
    human += ` RID 0x${routineIdentifier.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  if (sid === 0x2E && did != null && d.length > 3) {
    human += ` ← ${hexBytes(d.slice(3))}`;
  }
  return {
    kind: 'request', ts: pdu.startTs, sid,
    serviceName: svc?.name ?? null,
    subFunction, did, routineIdentifier,
    payload: d.slice(1), raw: d, human,
  };
}

function decodeResponse(pdu: ReassembledPdu, lastReq: DecodedRequest | null): DecodedResponse {
  const d = pdu.payload;
  const parsed = parseResponse(d);
  let did: number | null = null;
  let decodedDid: string | null = null;
  let human: string;
  if (parsed.ok) {
    const svc = parsed.posRsp != null ? serviceForPosRsp(parsed.posRsp) : null;
    human = (svc?.name ?? `posRsp 0x${HEX(parsed.posRsp ?? 0)}`) + ' OK';
    // Extract DID echo for 0x62/0x6E.
    if ((parsed.posRsp === 0x62 || parsed.posRsp === 0x6E) && d.length >= 3) {
      did = (d[1] << 8) | d[2];
      const body = d.slice(3);
      if (parsed.posRsp === 0x62 && body.length) {
        decodedDid = decodeDid(did, body);
      }
      const e = didEntry(did);
      human += ` DID 0x${did.toString(16).toUpperCase().padStart(4, '0')}`;
      if (e) human += ` (${e.name})`;
      if (decodedDid) human += ` = ${decodedDid}`;
    } else if (parsed.subFunction != null) {
      human += ` sub=0x${HEX(parsed.subFunction)}`;
    }
  } else {
    if (parsed.nrc != null) {
      const e = nrcEntry(parsed.nrc);
      const reqSid = parsed.sid != null ? `0x${HEX(parsed.sid)}` : '??';
      human = `NRC for ${reqSid}: 0x${HEX(parsed.nrc)} ${e?.shortName ?? ''} — ${e?.description ?? 'unknown NRC'}`;
    } else {
      human = `Unparsed response: ${hexBytes(d)}`;
    }
  }
  // If the most recent request was a 0x22 RDBI for a known DID and this is a
  // bare positive response without DID echo, fall back to that DID for decode.
  if (parsed.ok && parsed.posRsp === 0x62 && did == null && lastReq && lastReq.sid === 0x22 && lastReq.did != null) {
    did = lastReq.did;
    if (d.length > 1) decodedDid = decodeDid(did, d.slice(1));
  }
  return {
    kind: 'response', ts: pdu.startTs,
    sid: parsed.sid, serviceName: parsed.serviceName,
    ok: parsed.ok, nrc: parsed.nrc, nrcName: parsed.nrcName,
    did, decodedDid,
    subFunction: parsed.subFunction,
    payload: parsed.payload, raw: d, human,
  };
}

/**
 * Decode a request/response stream into a flat, time-ordered timeline of
 * UDS events. Pairing context (last request before each response) is used
 * to back-fill DID decode for bare 0x62 responses.
 */
export function decodeUdsSession(
  pairs: { request: ReassembledPdu[]; response: ReassembledPdu[] },
): DecodedUdsEvent[] {
  const tagged: Array<{ ts: number; pdu: ReassembledPdu; side: 'req' | 'resp' }> = [];
  for (const r of pairs.request) tagged.push({ ts: r.startTs, pdu: r, side: 'req' });
  for (const r of pairs.response) tagged.push({ ts: r.startTs, pdu: r, side: 'resp' });
  tagged.sort((a, b) => a.ts - b.ts);
  const out: DecodedUdsEvent[] = [];
  let lastReq: DecodedRequest | null = null;
  for (const t of tagged) {
    if (t.side === 'req') {
      const req = decodeRequest(t.pdu);
      lastReq = req;
      out.push(req);
    } else {
      out.push(decodeResponse(t.pdu, lastReq));
    }
  }
  return out;
}

// ── Common ID-pair suggestions ────────────────────────────────────────

/** Well-known FCA / Stellantis (and ISO-15765-4) tester→ECU pairs. */
export const COMMON_ID_PAIRS: ReadonlyArray<{ tx: number; rx: number; label: string }> = [
  { tx: 0x7E0, rx: 0x7E8, label: 'ECM (PCM)' },
  { tx: 0x7E1, rx: 0x7E9, label: 'TCM' },
  { tx: 0x7E2, rx: 0x7EA, label: 'ABS' },
  { tx: 0x714, rx: 0x71C, label: 'BCM (FCA legacy 714/71C)' },
  { tx: 0x714, rx: 0xF1A, label: 'BCM (FCA 714/F1A)' },
  { tx: 0x74F, rx: 0x76F, label: 'TIPM/Body' },
  { tx: 0x750, rx: 0x758, label: 'BCM (alt)' },
  { tx: 0x75F, rx: 0x767, label: 'RFHUB' },
];

/** Suggest likely ID pairs that appear in the captured frame stream. */
export function suggestIdPairs(frames: readonly CandumpFrame[]): typeof COMMON_ID_PAIRS {
  const seen = new Set<number>();
  for (const f of frames) seen.add(f.id);
  return COMMON_ID_PAIRS.filter(p => seen.has(p.tx) || seen.has(p.rx));
}

// ── BCM proposal extractor ────────────────────────────────────────────

export interface BcmProposal {
  did: number;
  /** Bytes from the "before" capture. */
  beforeBytes: Uint8Array;
  /** Bytes from the "after" capture. */
  afterBytes: Uint8Array;
  /** Offset of the first differing byte within the payload. */
  firstDiffOffset: number;
  /** Suggested human-readable field name (heuristic, ALL CAPS snake). */
  suggestedFieldName: string;
}

function lastWriteByDid(events: DecodedUdsEvent[]): Map<number, Uint8Array> {
  // Walk requests in order; for each WriteDataByIdentifier (0x2E) preceded by
  // a positive 0x6E (or unmatched) keep the most recent payload by DID.
  const map = new Map<number, Uint8Array>();
  for (const ev of events) {
    if (ev.kind === 'request' && ev.sid === 0x2E && ev.did != null) {
      map.set(ev.did, ev.payload.slice(2));
    }
  }
  return map;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function suggestName(did: number, before: Uint8Array, after: Uint8Array): string {
  const e = didEntry(did);
  const tag = e ? e.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') : `DID_${did.toString(16).toUpperCase().padStart(4, '0')}`;
  // Single-bit toggles get a `_BIT_<n>` suffix to make the proposal review
  // hint at "this looks like a feature flag" vs "this is a multi-byte payload".
  if (before.length === after.length) {
    let firstDiffByte = -1;
    let xorMask = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
        if (firstDiffByte < 0) { firstDiffByte = i; xorMask = before[i] ^ after[i]; }
        else { firstDiffByte = -2; break; }
      }
    }
    if (firstDiffByte >= 0 && (xorMask & (xorMask - 1)) === 0) {
      let bit = 0;
      while ((xorMask >>> bit) > 1) bit++;
      return `${tag}_BYTE_${firstDiffByte}_BIT_${bit}`;
    }
  }
  return tag;
}

/**
 * Compare the WriteDataByIdentifier payloads observed in two captures
 * (typically a "before toggle" and "after toggle" recording around a
 * single BCM feature change in the cluster) and emit candidate proposal
 * rows for human review. Never produces direct catalog edits.
 */
export function bcmDiffToProposals(
  beforeEvents: DecodedUdsEvent[],
  afterEvents: DecodedUdsEvent[],
): BcmProposal[] {
  const before = lastWriteByDid(beforeEvents);
  const after = lastWriteByDid(afterEvents);
  const out: BcmProposal[] = [];
  const dids = new Set<number>([...before.keys(), ...after.keys()]);
  for (const did of Array.from(dids).sort((a, b) => a - b)) {
    const b = before.get(did) ?? new Uint8Array(0);
    const a = after.get(did) ?? new Uint8Array(0);
    if (bytesEqual(b, a)) continue;
    let firstDiff = 0;
    const min = Math.min(b.length, a.length);
    while (firstDiff < min && b[firstDiff] === a[firstDiff]) firstDiff++;
    out.push({
      did,
      beforeBytes: b, afterBytes: a,
      firstDiffOffset: firstDiff,
      suggestedFieldName: suggestName(did, b, a),
    });
  }
  return out;
}
