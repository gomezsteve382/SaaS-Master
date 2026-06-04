// UDS 0x83 AccessTimingParameter helpers (Task #566).
//
// Per the bench spec we use:
//   0x83 0x01 — readExtendedTimingParameterSet (the module's defaults)
//   0x83 0x02 — readCurrentlyActiveTimingParameters
//   0x83 0x03 — setTimingParametersToGivenValues (4 bytes: P2_hi P2_lo P2*_hi P2*_lo)
//
// Positive response shape (matches FCA modules on the bench):
//   0xC3 <sub> <P2_hi> <P2_lo> <P2*_hi> <P2*_lo>
//
// P2 and P2* are sent and parsed as big-endian uint16 milliseconds.
// Modules that internally scale P2* by 10 ms still echo the same 4 raw
// bytes, so callers can read-cache-restore round-trip without knowing
// the unit scaling.
//
// All helpers are pure: builders return a number[] frame; parsers
// accept a Uint8Array | number[] response and return a plain object
// or null when the frame is not a positive 0xC3 reply for the
// requested sub-function.

const SID            = 0x83;
const PRC            = 0xC3;
const SUB_READ_DEF   = 0x01;
const SUB_READ_CUR   = 0x02;
const SUB_SET_VALUES = 0x03;

export const TIMING_SUB = Object.freeze({
  READ_DEFAULTS: SUB_READ_DEF,
  READ_CURRENT:  SUB_READ_CUR,
  SET_VALUES:    SUB_SET_VALUES,
});

function clampU16(ms){
  const n = Math.max(0, Math.min(0xFFFF, Math.round(Number(ms) || 0)));
  return n & 0xFFFF;
}

export function buildReadTimingDefaults(){
  return [SID, SUB_READ_DEF];
}

export function buildReadTimingCurrent(){
  return [SID, SUB_READ_CUR];
}

/**
 * Build the 0x83 0x03 set-timing request.
 *   p2Ms: per-call P2 timeout in milliseconds (uint16, BE)
 *   p2StarMs: extended P2* timeout in milliseconds (uint16, BE)
 * Both are clamped to [0, 0xFFFF]. Caller is responsible for picking
 * sane caps — the bench flasher uses 5000 ms / 30000 ms by default.
 */
export function buildSetTimingValues(p2Ms, p2StarMs){
  const p2  = clampU16(p2Ms);
  const p2s = clampU16(p2StarMs);
  return [SID, SUB_SET_VALUES, (p2 >> 8) & 0xFF, p2 & 0xFF, (p2s >> 8) & 0xFF, p2s & 0xFF];
}

/**
 * Parse a 0xC3 positive response. Accepts the response for any of the
 * three sub-functions we use. Returns:
 *   { sub, p2Ms, p2StarMs, raw: number[] }
 * or null when the frame is not a recognizable positive timing reply.
 */
export function parseTimingResponse(d){
  if (!d || d.length < 6) return null;
  const arr = d instanceof Uint8Array ? d : new Uint8Array(d);
  if (arr[0] !== PRC) return null;
  const sub = arr[1];
  if (sub !== SUB_READ_DEF && sub !== SUB_READ_CUR && sub !== SUB_SET_VALUES) return null;
  const p2Ms     = (arr[2] << 8) | arr[3];
  const p2StarMs = (arr[4] << 8) | arr[5];
  return { sub, p2Ms, p2StarMs, raw: Array.from(arr.subarray(2, 6)) };
}

/**
 * High-level helper: drives engine.uds through a single 0x83 round
 * trip. Returns { ok, sub, p2Ms, p2StarMs, raw, nrc, error }.
 *
 * `kind` is one of 'defaults' | 'current' | 'set'. For 'set' the
 * caller must pass `{ p2Ms, p2StarMs }`.
 */
export async function accessTimingParameter(engine, tx, rx, kind, opts = {}){
  if (!engine || typeof engine.uds !== 'function'){
    return { ok: false, error: 'no engine' };
  }
  let frame;
  if (kind === 'defaults')      frame = buildReadTimingDefaults();
  else if (kind === 'current')  frame = buildReadTimingCurrent();
  else if (kind === 'set')      frame = buildSetTimingValues(opts.p2Ms, opts.p2StarMs);
  else return { ok: false, error: `unknown 0x83 kind: ${kind}` };
  const r = await engine.uds(tx, rx, frame);
  if (!r || !r.ok){
    return { ok: false, error: (r && r.error) || 'no response' };
  }
  const d = r.d || r.data;
  if (!d || !d.length) return { ok: false, error: 'empty response' };
  if (d[0] === 0x7F){
    return { ok: false, nrc: d.length > 2 ? d[2] : null, error: '0x83 negative response' };
  }
  const parsed = parseTimingResponse(d);
  if (!parsed){
    return { ok: false, error: 'malformed 0x83 response' };
  }
  return { ok: true, ...parsed };
}
