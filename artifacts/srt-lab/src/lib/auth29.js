// UDS 0x29 Authentication — detect + real challenge/response handshake.
//
// History:
//   - Task #567: detect-and-refuse stub. We probed 0x29 0x00 once when a
//     0x27 seed came back with NRC 0x33/0x34 so the operator saw a clear
//     "module requires 0x29" refusal instead of an opaque NRC loop.
//   - Task #572 (this file): real handshake. Implements the standard
//     ISO 14229-1:2020 §11.5 challenge-response mode using sub-functions
//     0x05 RequestChallengeForAuthentication and 0x06 VerifyProofOfOwnership
//     (unidirectional). The handshake is driven by a pluggable
//     "proof strategy" callback so a single state machine can serve every
//     module-specific cryptographic recipe (HMAC-SHA256, AES-CMAC, ECDSA
//     signatures, etc.). A built-in HMAC-SHA256 strategy is provided for
//     the FCA bench scripts that ship a per-tx-id symmetric secret.
//
// Wire diagram (challenge-response, the only mode we drive end-to-end):
//
//   Tester → ECU: 29 05 <authConfig> [<extra>]    requestChallenge
//   ECU → Tester: 69 05 <statusInfo> <challenge…> challenge bytes
//   Tester → ECU: 29 06 <proof…>                  verifyProofOfOwnership
//   ECU → Tester: 69 06 <statusInfo> [<sessKey…>] authenticated
//
// The handshake helper handles framing; callers supply the secret/cert
// material via a strategy function `(challenge, ctx) -> Promise<proofBytes>`.
// Every helper is pure / side-effect-free; only `runAuth29Handshake` and
// `detect0x29` actually drive the engine.

const SID_AUTH = 0x29;
const PRC_AUTH = 0x69;

// Sub-function IDs we care about from ISO 14229-1:2020 §11.5.2.
const SUB_DEAUTH               = 0x00;
const SUB_VERIFY_CERT_UNI      = 0x01;
const SUB_VERIFY_CERT_BI       = 0x02;
const SUB_PROOF_OF_OWNERSHIP   = 0x03;
const SUB_TRANSMIT_CERTIFICATE = 0x04;
const SUB_REQUEST_CHALLENGE    = 0x05;
const SUB_VERIFY_PROOF_UNI     = 0x06;
const SUB_VERIFY_PROOF_BI      = 0x07;
const SUB_AUTH_CONFIG          = 0x08;

// NRCs the classifier and handshake key off of (ISO 14229-1:2020 §A.1).
const NRC_SUBFUNCTION_NOT_SUPPORTED      = 0x12;
const NRC_SERVICE_NOT_SUPPORTED          = 0x11;
const NRC_SUBFN_NOT_SUPPORTED_IN_SESSION = 0x7E;
const NRC_SERVICE_NOT_SUPPORTED_SESSION  = 0x7F;

// authenticationReturnParameter values per §11.5.5.3 (table 414). We only
// react to the small handful that actually matter for unlock decisions.
const ARP_REQUEST_ACCEPTED   = 0x00;
const ARP_GENERAL_REJECT     = 0x01;
const ARP_AUTH_CONFIG_NEEDED = 0x02;
// Per §11.5.5.3, sub-function 0x06/0x07 success is reported with these
// vendor-friendly codes. The spec calls these "ownership verified" /
// "certificate verified, ownership verified, response correct" — both
// indicate the tester is authenticated and the session may proceed.
const ARP_OWNERSHIP_VERIFIED       = 0x10;
const ARP_CERT_AND_OWNERSHIP_OK    = 0x11;
const ARP_DEAUTH_SUCCESSFUL        = 0x12;

export const AUTH29 = Object.freeze({
  SID: SID_AUTH,
  PRC: PRC_AUTH,
  SUB_DEAUTHENTICATE:  SUB_DEAUTH,
  SUB_VERIFY_CERT_UNI: SUB_VERIFY_CERT_UNI,
  SUB_VERIFY_CERT_BI:  SUB_VERIFY_CERT_BI,
  SUB_PROOF_OF_OWNERSHIP:   SUB_PROOF_OF_OWNERSHIP,
  SUB_TRANSMIT_CERTIFICATE: SUB_TRANSMIT_CERTIFICATE,
  SUB_REQUEST_CHALLENGE:    SUB_REQUEST_CHALLENGE,
  SUB_VERIFY_PROOF_UNI:     SUB_VERIFY_PROOF_UNI,
  SUB_VERIFY_PROOF_BI:      SUB_VERIFY_PROOF_BI,
  SUB_AUTH_CONFIG:          SUB_AUTH_CONFIG,
  ARP_REQUEST_ACCEPTED,
  ARP_OWNERSHIP_VERIFIED,
  ARP_CERT_AND_OWNERSHIP_OK,
  ARP_DEAUTH_SUCCESSFUL,
});

function asArray(d){
  if (!d) return [];
  if (d instanceof Uint8Array) return Array.from(d);
  if (Array.isArray(d)) return d.slice();
  if (d.buffer instanceof ArrayBuffer) return Array.from(new Uint8Array(d.buffer, d.byteOffset || 0, d.byteLength));
  return [];
}

// ---------------------------------------------------------------------------
// Detect-and-refuse helpers (Task #567 — preserved verbatim for callers).
// ---------------------------------------------------------------------------

/**
 * Build the deauthenticate probe frame: 0x29 0x00. Sub-function 0x00 has
 * no required arguments and is the safest probe because it should never
 * alter the module's authentication state when the module is already
 * unauthenticated.
 */
export function build0x29Probe(){
  return [SID_AUTH, SUB_DEAUTH];
}

/**
 * Classify a 0x29 0x00 reply. See file header for the contract.
 */
export function classify0x29Response(d){
  if (!d) return 'no-response';
  const arr = d instanceof Uint8Array ? d : (Array.isArray(d) ? d : null);
  if (!arr || arr.length === 0) return 'no-response';
  if (arr[0] === PRC_AUTH) return 'supports';
  if (arr[0] === 0x7F){
    if (arr.length < 3) return 'no-response';
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
 * Returns { classification, supports, raw, nrc, error }. Never throws.
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
  const arr = d ? asArray(d) : [];
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
 * Format the canonical user-facing abort message used when no strategy
 * is registered for a module that *does* support 0x29.
 */
export function auth29RefusalMessage(){
  return 'module requires Authentication (0x29) — not yet supported';
}

// ---------------------------------------------------------------------------
// Challenge-response handshake (Task #572).
// ---------------------------------------------------------------------------

/**
 * Build a 0x29 0x05 RequestChallengeForAuthentication frame.
 *
 * Per ISO 14229-1:2020 §11.5.5.2 the request body for sub-function 0x05
 * is at minimum:
 *   29 05 <communicationConfiguration>
 * Many FCA modules also accept an additional `authenticationType` byte
 * after the configuration byte to disambiguate which key slot to use.
 * The optional `extra` array is appended verbatim so vendor-specific
 * payload (challenge nonce, key identifier, etc.) can be tacked on.
 */
export function buildRequestChallenge(communicationConfiguration = 0x00, extra = []){
  const cfg = communicationConfiguration & 0xFF;
  const tail = Array.isArray(extra) ? extra.map((b) => b & 0xFF)
             : (extra instanceof Uint8Array ? Array.from(extra) : []);
  return [SID_AUTH, SUB_REQUEST_CHALLENGE, cfg, ...tail];
}

/**
 * Build a 0x29 0x06 VerifyProofOfOwnership (unidirectional) frame.
 * `proof` is the strategy-computed response over the module's challenge.
 */
export function buildVerifyProof(proof, sub = SUB_VERIFY_PROOF_UNI){
  const bytes = proof instanceof Uint8Array ? Array.from(proof)
              : (Array.isArray(proof) ? proof.map((b) => b & 0xFF) : []);
  return [SID_AUTH, sub & 0xFF, ...bytes];
}

/**
 * Parse a 0x69 0x05 RequestChallenge response. ISO 14229-1:2020 §11.5.5.3
 * minimum positive response shape:
 *   69 05 <statusInfo> <challengeServer…>
 * Some modules prefix the challenge with a 2-byte length; we accept both
 * variants — a length is honoured when (a) the high bytes are 0 and (b)
 * len matches the remainder of the frame, otherwise the rest of the
 * frame is treated as the challenge verbatim.
 */
export function parseChallengeResponse(d){
  const arr = asArray(d);
  if (arr.length < 3) return { ok: false, error: 'truncated' };
  if (arr[0] !== PRC_AUTH || arr[1] !== SUB_REQUEST_CHALLENGE){
    if (arr[0] === 0x7F && arr[1] === SID_AUTH){
      return { ok: false, nrc: arr.length >= 3 ? arr[2] : null, error: 'NRC' };
    }
    return { ok: false, error: 'unexpected-frame' };
  }
  const statusInfo = arr[2];
  let challenge = arr.slice(3);
  // Optional 2-byte length prefix some modules emit.
  if (challenge.length >= 2){
    const declared = (challenge[0] << 8) | challenge[1];
    if (declared > 0 && declared === challenge.length - 2){
      challenge = challenge.slice(2);
    }
  }
  return { ok: true, statusInfo, challenge };
}

/**
 * Parse a 0x69 0x06 / 0x69 0x07 VerifyProof response. ISO 14229-1:2020
 * §11.5.5.3 success is signalled by authenticationReturnParameter in
 * { 0x00 requestAccepted, 0x10 ownershipVerified, 0x11 certAndOwnershipOK }.
 * Anything else (or a 0x7F NRC) is treated as failure.
 */
export function parseVerifyProofResponse(d){
  const arr = asArray(d);
  if (arr.length < 3) return { ok: false, error: 'truncated' };
  if (arr[0] === 0x7F && arr[1] === SID_AUTH){
    return { ok: false, nrc: arr.length >= 3 ? arr[2] : null, error: 'NRC' };
  }
  if (arr[0] !== PRC_AUTH) return { ok: false, error: 'unexpected-frame' };
  if (arr[1] !== SUB_VERIFY_PROOF_UNI && arr[1] !== SUB_VERIFY_PROOF_BI){
    return { ok: false, error: 'wrong-sub' };
  }
  const statusInfo = arr[2];
  const accepted = (
    statusInfo === ARP_REQUEST_ACCEPTED
    || statusInfo === ARP_OWNERSHIP_VERIFIED
    || statusInfo === ARP_CERT_AND_OWNERSHIP_OK
  );
  return { ok: accepted, statusInfo, sessionKey: arr.slice(3) };
}

/**
 * Drive the 3-step challenge-response handshake against a module.
 *
 *   strategy: async (challenge: number[], ctx) => proof: number[]|Uint8Array
 *   ctx     : { tx, rx, statusInfo, communicationConfiguration }
 *
 * Returns:
 *   { ok: true,  statusInfo, challenge, proof, sessionKey }
 *   { ok: false, phase: 'request'|'strategy'|'verify', nrc?, error, raw? }
 *
 * The function does not deauthenticate first — callers that want to
 * force a clean state should send 0x29 0x00 themselves before calling
 * this. (The probe in detect0x29 above already serves that purpose for
 * the standard "saw 0x33 → probe → handshake" path.)
 */
export async function runAuth29Handshake(engine, tx, rx, strategy, opts = {}){
  if (!engine || typeof engine.uds !== 'function'){
    return { ok: false, phase: 'request', error: 'no engine' };
  }
  if (typeof strategy !== 'function'){
    return { ok: false, phase: 'strategy', error: 'no strategy' };
  }
  const cfg   = (opts.communicationConfiguration ?? 0x00) & 0xFF;
  const extra = opts.requestExtra || [];
  const verifySub = (opts.bidirectional ? SUB_VERIFY_PROOF_BI : SUB_VERIFY_PROOF_UNI);

  // 1) RequestChallenge.
  let r;
  try {
    r = await engine.uds(tx, rx, buildRequestChallenge(cfg, extra));
  } catch (e){
    return { ok: false, phase: 'request', error: (e && e.message) || String(e) };
  }
  if (!r || !r.ok){
    return { ok: false, phase: 'request', error: (r && r.error) || 'no response' };
  }
  const reqRaw = asArray(r.d || r.data);
  const reqParsed = parseChallengeResponse(reqRaw);
  if (!reqParsed.ok){
    return { ok: false, phase: 'request', nrc: reqParsed.nrc ?? null, error: reqParsed.error || 'bad request reply', raw: reqRaw };
  }

  // 2) Strategy → proof bytes.
  let proof;
  try {
    proof = await strategy(reqParsed.challenge.slice(), {
      tx, rx,
      statusInfo: reqParsed.statusInfo,
      communicationConfiguration: cfg,
    });
  } catch (e){
    return { ok: false, phase: 'strategy', error: (e && e.message) || String(e) };
  }
  const proofBytes = proof instanceof Uint8Array ? Array.from(proof)
                   : (Array.isArray(proof) ? proof.map((b) => b & 0xFF) : null);
  if (!proofBytes || proofBytes.length === 0){
    return { ok: false, phase: 'strategy', error: 'strategy returned no proof' };
  }

  // 3) VerifyProofOfOwnership.
  let v;
  try {
    v = await engine.uds(tx, rx, buildVerifyProof(proofBytes, verifySub));
  } catch (e){
    return { ok: false, phase: 'verify', error: (e && e.message) || String(e) };
  }
  if (!v || !v.ok){
    return { ok: false, phase: 'verify', error: (v && v.error) || 'no response' };
  }
  const verRaw = asArray(v.d || v.data);
  const verParsed = parseVerifyProofResponse(verRaw);
  if (!verParsed.ok){
    return {
      ok: false, phase: 'verify',
      nrc: verParsed.nrc ?? null,
      statusInfo: verParsed.statusInfo ?? null,
      error: verParsed.error || ('statusInfo 0x' + ((verParsed.statusInfo ?? 0) & 0xFF).toString(16)),
      raw: verRaw,
    };
  }
  return {
    ok: true,
    statusInfo: verParsed.statusInfo,
    challenge: reqParsed.challenge,
    proof: proofBytes,
    sessionKey: verParsed.sessionKey,
  };
}

// ---------------------------------------------------------------------------
// Strategy registry — module-tx-id → proof callback.
// ---------------------------------------------------------------------------

const STRATEGIES = new Map();

/**
 * Register a proof strategy for a particular module CAN tx-id. The
 * handshake driver will look this up after a 0x29-supports detection.
 * Calling with a falsy `fn` clears the entry.
 */
export function registerAuth29Strategy(tx, fn){
  const key = (tx | 0) >>> 0;
  if (typeof fn === 'function'){
    STRATEGIES.set(key, fn);
  } else {
    STRATEGIES.delete(key);
  }
}

export function getAuth29Strategy(tx){
  return STRATEGIES.get((tx | 0) >>> 0) || null;
}

export function clearAuth29Strategies(){
  STRATEGIES.clear();
}

// ---------------------------------------------------------------------------
// Built-in HMAC-SHA256 strategy. Most FCA bench scripts shipped with a
// 256-bit symmetric secret per module; the proof is HMAC(secret, challenge)
// truncated to the first `proofLen` bytes (defaults to the full 32). The
// implementation prefers the WebCrypto subtle API (browsers, Node 18+),
// then falls back to a pure-JS SHA-256 so unit tests under bare `node`
// still resolve a real proof without needing crypto polyfills.
// ---------------------------------------------------------------------------

function getSubtleCrypto(){
  if (typeof globalThis !== 'undefined'){
    if (globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto.subtle;
  }
  return null;
}

/**
 * Pure-JS SHA-256 (FIPS 180-4). ~50 LOC, no allocations on the hot path
 * beyond the message schedule. Used as a deterministic fallback when
 * WebCrypto is unavailable.
 */
function sha256(bytes){
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  // Pad: append 0x80, then zeros, then 64-bit big-endian length in bits.
  const bitLen = bytes.length * 8;
  const padLen = (56 - ((bytes.length + 1) % 64) + 64) % 64;
  const total = bytes.length + 1 + padLen + 8;
  const m = new Uint8Array(total);
  m.set(bytes, 0);
  m[bytes.length] = 0x80;
  // 64-bit length, but we only need the low 53 bits since JS numbers max out there.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  m[total - 8] = (hi >>> 24) & 0xFF; m[total - 7] = (hi >>> 16) & 0xFF;
  m[total - 6] = (hi >>>  8) & 0xFF; m[total - 5] =  hi         & 0xFF;
  m[total - 4] = (lo >>> 24) & 0xFF; m[total - 3] = (lo >>> 16) & 0xFF;
  m[total - 2] = (lo >>>  8) & 0xFF; m[total - 1] =  lo         & 0xFF;
  const W = new Uint32Array(64);
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
  for (let i = 0; i < total; i += 64){
    for (let t = 0; t < 16; t++){
      const j = i + t * 4;
      W[t] = ((m[j] << 24) | (m[j+1] << 16) | (m[j+2] << 8) | m[j+3]) >>> 0;
    }
    for (let t = 16; t < 64; t++){
      const s0 = rotr(W[t-15], 7) ^ rotr(W[t-15], 18) ^ (W[t-15] >>> 3);
      const s1 = rotr(W[t-2], 17) ^ rotr(W[t-2], 19) ^ (W[t-2] >>> 10);
      W[t] = (W[t-16] + s0 + W[t-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let t = 0; t < 64; t++){
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ ((~e) & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]+a)>>>0; H[1] = (H[1]+b)>>>0; H[2] = (H[2]+c)>>>0; H[3] = (H[3]+d)>>>0;
    H[4] = (H[4]+e)>>>0; H[5] = (H[5]+f)>>>0; H[6] = (H[6]+g)>>>0; H[7] = (H[7]+h)>>>0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++){
    out[i*4]   = (H[i] >>> 24) & 0xFF;
    out[i*4+1] = (H[i] >>> 16) & 0xFF;
    out[i*4+2] = (H[i] >>>  8) & 0xFF;
    out[i*4+3] =  H[i]         & 0xFF;
  }
  return out;
}

function hmacSha256JsFallback(key, data){
  const BLOCK = 64;
  let k = key.length > BLOCK ? sha256(key) : key;
  if (k.length < BLOCK){
    const padded = new Uint8Array(BLOCK);
    padded.set(k, 0);
    k = padded;
  }
  const okp = new Uint8Array(BLOCK), ikp = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++){
    okp[i] = k[i] ^ 0x5C;
    ikp[i] = k[i] ^ 0x36;
  }
  const inner = new Uint8Array(BLOCK + data.length);
  inner.set(ikp, 0);
  inner.set(data, BLOCK);
  const innerHash = sha256(inner);
  const outer = new Uint8Array(BLOCK + innerHash.length);
  outer.set(okp, 0);
  outer.set(innerHash, BLOCK);
  return sha256(outer);
}

async function hmacSha256(secret, data){
  const subtle = getSubtleCrypto();
  if (subtle && typeof subtle.importKey === 'function'){
    try {
      const key = await subtle.importKey(
        'raw', secret,
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign'],
      );
      const sig = await subtle.sign('HMAC', key, data);
      return new Uint8Array(sig);
    } catch {
      // fall through to JS implementation
    }
  }
  return hmacSha256JsFallback(secret, data);
}

/**
 * Build a strategy that proves ownership of `secret` by HMAC-SHA256 over
 * the challenge bytes the module sent. The optional `proofLen` truncates
 * the MAC to the first N bytes — useful when a module expects only a
 * 16-byte tag rather than the full 32. `prefix` is prepended to the
 * MAC input (some FCA recipes salt the challenge with a fixed header).
 */
export function makeHmacSha256Strategy(secretBytes, { proofLen = 32, prefix = [] } = {}){
  const secret = secretBytes instanceof Uint8Array
    ? secretBytes : new Uint8Array(secretBytes || []);
  const pre = prefix instanceof Uint8Array ? prefix : new Uint8Array(prefix || []);
  return async (challenge /* , ctx */) => {
    const ch = challenge instanceof Uint8Array ? challenge : new Uint8Array(challenge || []);
    const input = new Uint8Array(pre.length + ch.length);
    input.set(pre, 0); input.set(ch, pre.length);
    const mac = await hmacSha256(secret, input);
    const n = Math.max(1, Math.min(proofLen | 0, mac.length));
    return Array.from(mac.subarray(0, n));
  };
}

/**
 * Convenience: probe → handshake in one call. Returns:
 *   { authenticated: true,  via: 'handshake', statusInfo, ... }
 *   { authenticated: false, via: 'no-strategy' | 'rejects' | 'no-support', reason }
 *   { authenticated: false, via: 'handshake-failed', phase, nrc?, error }
 *
 * Prefers `opts.strategy` when provided; otherwise falls back to the
 * registry. `opts.deauth` (default true) sends a 0x29 0x00 first to
 * leave the module in a known state before requesting the challenge.
 */
export async function attemptAuth29Unlock(engine, tx, rx, opts = {}){
  const strategy = (typeof opts.strategy === 'function') ? opts.strategy : getAuth29Strategy(tx);
  if (opts.deauth !== false){
    try { await engine.uds(tx, rx, build0x29Probe()); } catch { /* best effort */ }
  }
  if (!strategy){
    return { authenticated: false, via: 'no-strategy', reason: auth29RefusalMessage() };
  }
  const r = await runAuth29Handshake(engine, tx, rx, strategy, opts);
  if (r.ok){
    return {
      authenticated: true, via: 'handshake',
      statusInfo: r.statusInfo, sessionKey: r.sessionKey,
      challenge: r.challenge, proof: r.proof,
    };
  }
  return { authenticated: false, via: 'handshake-failed', phase: r.phase, nrc: r.nrc ?? null, error: r.error };
}

/**
 * Format a successful-unlock log line. Centralised so the flasher,
 * `reUnlockSeedKey`, and `tryUnlockWithChain` all read identically.
 */
export function auth29UnlockedMessage(){
  return 'module unlocked via Authentication (0x29) handshake';
}
