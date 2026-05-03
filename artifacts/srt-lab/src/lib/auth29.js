// UDS 0x29 Authentication detect-and-refuse stub (Task #567).
//
// 2024+ FCA modules are starting to drop SecurityAccess (0x27) in
// favour of Authentication (0x29) per ISO 14229-1:2020. We do not
// implement the full 0x29 challenge/response handshake here. We just
// recognise when a module insists on 0x29 and let the caller surface
// a clear "not yet supported" message instead of looping on 0x27.
//
// The probe sends 0x29 0x00 (deAuthenticate). Per ISO 14229 a module
// that implements 0x29 must respond with either:
//   - 0x69 0x00 [...]                              → supports 0x29
//   - 0x7F 0x29 0x12 (subFunctionNotSupported)     → supports 0x29 service, just not the sub
//   - 0x7F 0x29 0x7E/0x7F (session/service-not-in-session) → supports 0x29
// A module that only knows 0x27 will reply with:
//   - 0x7F 0x29 0x11 (serviceNotSupported)         → rejects 0x29
//   - no response                                  → no-response
//
// Helpers are pure: builders return number[] frames, classifier accepts
// either Uint8Array or number[], detect() drives engine.uds() once and
// returns a structured result. The caller is responsible for deciding
// when to probe (typically only after seeing NRC 0x33 / 0x34 on 0x27).

const SID_AUTH = 0x29;
const SUB_DEAUTH = 0x00;
const PRC_AUTH = 0x69;

// NRC codes per ISO 14229. Kept here so the classifier reads cleanly.
const NRC_SUBFUNCTION_NOT_SUPPORTED      = 0x12;
const NRC_SERVICE_NOT_SUPPORTED          = 0x11;
const NRC_SUBFN_NOT_SUPPORTED_IN_SESSION = 0x7E;
const NRC_SERVICE_NOT_SUPPORTED_SESSION  = 0x7F;

export const AUTH29 = Object.freeze({
  SID: SID_AUTH,
  SUB_DEAUTHENTICATE: SUB_DEAUTH,
  PRC: PRC_AUTH,
});

/**
 * Build the deauthenticate probe frame: 0x29 0x00.
 * Sub-function 0x00 has no required arguments and is the safest probe
 * because it should never alter the module's authentication state when
 * the module is already unauthenticated.
 */
export function build0x29Probe(){
  return [SID_AUTH, SUB_DEAUTH];
}

/**
 * Classify a 0x29 0x00 reply. Returns one of:
 *   'supports'    → positive 0x69 echo OR an NRC that proves the
 *                   service exists (0x12 sub-not-supported, 0x7E
 *                   sub-not-in-session, 0x7F service-not-in-session)
 *   'rejects'     → NRC 0x11 (serviceNotSupported)
 *   'no-response' → no frame, empty frame, or a malformed reply we
 *                   can't reason about
 *   'unknown'     → some other NRC (e.g. 0x22 conditionsNotCorrect,
 *                   0x33 securityAccessDenied) — not enough signal to
 *                   decide. Treated by callers as "do not flag", since
 *                   the conservative default is "leave 0x27 alone".
 */
export function classify0x29Response(d){
  if (!d) return 'no-response';
  const arr = d instanceof Uint8Array ? d : (Array.isArray(d) ? d : null);
  if (!arr || arr.length === 0) return 'no-response';
  if (arr[0] === PRC_AUTH) return 'supports';
  if (arr[0] === 0x7F){
    if (arr.length < 3) return 'no-response';
    // arr[1] is the SID being rejected. If a module returns 0x7F for a
    // SID other than 0x29, treat it as "no-response" — the bus echoed
    // someone else's frame back at us.
    if (arr[1] !== SID_AUTH) return 'no-response';
    const nrc = arr[2];
    if (nrc === NRC_SERVICE_NOT_SUPPORTED) return 'rejects';
    if (
      nrc === NRC_SUBFUNCTION_NOT_SUPPORTED
      || nrc === NRC_SUBFN_NOT_SUPPORTED_IN_SESSION
      || nrc === NRC_SERVICE_NOT_SUPPORTED_SESSION
    ) return 'supports';
    return 'unknown';
  }
  return 'no-response';
}

/**
 * Drive a single 0x29 0x00 probe through engine.uds(tx, rx, ...).
 * Returns:
 *   {
 *     classification: 'supports' | 'rejects' | 'no-response' | 'unknown',
 *     supports:  boolean,    // shorthand: classification === 'supports'
 *     raw:       number[]|null,
 *     nrc:       number|null,
 *     error:     string|null,
 *   }
 *
 * Never throws. Transport failures collapse to classification
 * 'no-response' with the error message preserved so the caller can
 * include it in its log line.
 */
export async function detect0x29(engine, tx, rx){
  const out = { classification: 'no-response', supports: false, raw: null, nrc: null, error: null };
  if (!engine || typeof engine.uds !== 'function'){
    out.error = 'no engine';
    return out;
  }
  let r;
  try {
    r = await engine.uds(tx, rx, build0x29Probe());
  } catch (e){
    out.error = (e && e.message) ? e.message : String(e);
    return out;
  }
  if (!r || !r.ok){
    out.error = (r && r.error) || 'no response';
    return out;
  }
  const d = r.d || r.data;
  const arr = d ? (d instanceof Uint8Array ? Array.from(d) : Array.from(d)) : [];
  out.raw = arr;
  out.classification = classify0x29Response(arr);
  out.supports = out.classification === 'supports';
  if (arr.length >= 3 && arr[0] === 0x7F && arr[1] === SID_AUTH){
    out.nrc = arr[2];
  }
  return out;
}

/**
 * Decide whether a 0x27 negative response is the kind that warrants
 * a follow-up 0x29 probe. The signal is NRC 0x33 (securityAccessDenied)
 * or NRC 0x34 (authenticationRequired, ISO 14229-1:2020 §A.1).
 */
export function shouldProbe0x29ForNrc(nrc){
  return nrc === 0x33 || nrc === 0x34;
}

/**
 * Format the canonical user-facing abort message. Centralised so the
 * flasher, the unlock chain, and the UI banner all read identically.
 */
export function auth29RefusalMessage(){
  return 'module requires Authentication (0x29) — not yet supported';
}
