/* CodeCard bench-pair harness (Task #828).
 *
 * Tests candidate 5-byte CodeCard tokens extracted from AlfaOBD.exe's
 * `SendCodeCardLogin` method (Method[1436]) against a recorded bench pair
 * `(seed, observed_key)` — i.e. the bytes that came back from a real
 * `27 03` → `67 03 <seed>` exchange and the `27 04 <key>` request that
 * the ECU subsequently accepted.
 *
 * Strictly off-line: this module never touches a transport. Input is
 * recorded bytes only. Output is a structured verdict per token.
 *
 * Three hypotheses are evaluated:
 *   (A) constant-key       — token IS the literal key bytes the ECU expects
 *                            regardless of the seed (i.e. the EXE shipped a
 *                            sample CodeCard that the ECU accepts blindly).
 *   (B) derivation-input   — token combines with the seed under a small set
 *                            of fixed transforms (XOR, ADD, reversed-XOR,
 *                            XOR with seed rotated 8 bits) to produce the
 *                            observed key. One positive match is suggestive,
 *                            not proof — caller is reminded of this.
 *   (C) seed-derivation    — token is somewhere inside the seed itself
 *                            (a chained challenge / cookie pattern).
 *
 * The verdict per token is one of:
 *   - 'confirmed-constant-key'        — hypothesis A matched
 *   - 'confirmed-derivation-input'    — hypothesis B matched on a
 *                                       non-degenerate pair
 *   - 'rejected'                      — none of A/B/C matched on a
 *                                       non-degenerate pair
 *   - 'inconclusive-need-more-pairs'  — pair is degenerate (seed all zero,
 *                                       key all zero, seed == key, all-FF,
 *                                       etc.) so any of the above could
 *                                       match coincidentally
 *
 * Multiple bench pairs can be passed: the harness aggregates per-pair
 * verdicts into a single overall verdict per token (A/B require every
 * pair to agree; one rejection downgrades the verdict).
 */

import { SEND_CODE_CARD_LOGIN_METHOD } from '../securityIntelFromExe.generated.js';

/** Strip whitespace + optional `0x` prefix and parse a hex string into a
 *  Uint8Array. Throws on odd-length input or non-hex characters. */
export function parseHexBytes(hex) {
  if (typeof hex !== 'string') throw new Error('hex must be a string');
  const clean = hex.replace(/\s+/g, '').replace(/^0x/i, '');
  if (!clean.length) return new Uint8Array(0);
  if (clean.length % 2 !== 0) throw new Error('hex string has odd length');
  if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error('non-hex characters in input');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function fmtHex(bytes) {
  return Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A bench pair is "degenerate" when one or both of seed/key are all-zero
 *  or all-FF, or when seed === key. Any transform trivially matches in
 *  those cases, so we refuse to draw a positive conclusion. */
export function isDegeneratePair(seed, key) {
  if (!seed.length || !key.length) return true;
  const allEq = (arr, v) => arr.every(b => b === v);
  if (allEq(seed, 0x00) || allEq(seed, 0xFF)) return true;
  if (allEq(key, 0x00) || allEq(key, 0xFF)) return true;
  if (seed.length === key.length && bytesEqual(seed, key)) return true;
  return false;
}

/** Tile/truncate `src` to exactly `len` bytes so byte-wise transforms with
 *  mismatched seed/key widths still have a defined meaning. */
function fitLen(src, len) {
  const out = new Uint8Array(len);
  if (!src.length) return out;
  for (let i = 0; i < len; i++) out[i] = src[i % src.length];
  return out;
}

/* ── Hypothesis A: constant key ─────────────────────────────────────── */

function evaluateConstantKey(token, key) {
  const match = bytesEqual(token, key);
  return {
    name: 'constant-key',
    matched: match,
    detail: match
      ? `key == token literally (${fmtHex(token)})`
      : `key (${fmtHex(key)}) != token (${fmtHex(token)})`,
  };
}

/* ── Hypothesis B: derivation input ─────────────────────────────────── */

function xorBytes(a, b) {
  const n = Math.max(a.length, b.length);
  const af = fitLen(a, n);
  const bf = fitLen(b, n);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = af[i] ^ bf[i];
  return out;
}

function addBytesMod256(a, b) {
  const n = Math.max(a.length, b.length);
  const af = fitLen(a, n);
  const bf = fitLen(b, n);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (af[i] + bf[i]) & 0xFF;
  return out;
}

function reverseBytes(b) {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i];
  return out;
}

function rotateByteLeft(b, count) {
  if (!b.length) return new Uint8Array(0);
  const n = b.length;
  const c = ((count % n) + n) % n;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = b[(i + c) % n];
  return out;
}

const DERIVATION_TRANSFORMS = [
  { id: 'token_xor_seed',     describe: 'token XOR seed (byte-wise, tiled)',          run: (t, s) => xorBytes(t, s) },
  { id: 'token_add_seed',     describe: 'token + seed mod 256 (byte-wise, tiled)',    run: (t, s) => addBytesMod256(t, s) },
  { id: 'token_xor_rev_seed', describe: 'token XOR reversed(seed)',                   run: (t, s) => xorBytes(t, reverseBytes(s)) },
  { id: 'token_xor_rot_seed', describe: 'token XOR rotateLeft(seed, 1)',              run: (t, s) => xorBytes(t, rotateByteLeft(s, 1)) },
  { id: 'seed_xor_token',     describe: 'seed XOR token (commutative check)',          run: (t, s) => xorBytes(s, t) },
];

function evaluateDerivationInput(token, seed, key) {
  for (const tf of DERIVATION_TRANSFORMS) {
    const candidate = tf.run(token, seed);
    if (candidate.length === key.length && bytesEqual(candidate, key)) {
      return {
        name: 'derivation-input',
        matched: true,
        transform: tf.id,
        detail: `${tf.describe} → ${fmtHex(candidate)} matches observed key`,
      };
    }
  }
  return {
    name: 'derivation-input',
    matched: false,
    transform: null,
    detail: `no transform in {${DERIVATION_TRANSFORMS.map(t => t.id).join(', ')}} produced the observed key`,
  };
}

/* ── Hypothesis C: seed-derivation (token appears inside seed) ──────── */

function findSubarray(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function evaluateSeedDerivation(token, seed) {
  const idx = findSubarray(seed, token);
  if (idx >= 0) {
    return {
      name: 'seed-derivation',
      matched: true,
      detail: `token appears inside seed at offset ${idx} — consistent with a chained-challenge / cookie scheme`,
    };
  }
  return {
    name: 'seed-derivation',
    matched: false,
    detail: 'token does not appear inside the seed bytes',
  };
}

/* ── Per-pair evaluator ─────────────────────────────────────────────── */

/**
 * Evaluate a single token against a single bench pair.
 *
 * @param {Uint8Array|number[]|string} token  candidate 5-byte token
 * @param {Uint8Array|number[]|string} seed   seed bytes from 67 03
 * @param {Uint8Array|number[]|string} key    key bytes from 27 04
 * @returns {{
 *   verdict: 'confirmed-constant-key' | 'confirmed-derivation-input'
 *          | 'rejected' | 'inconclusive-need-more-pairs',
 *   degenerate: boolean,
 *   hypotheses: Array<{ name: string, matched: boolean, detail: string, transform?: string }>,
 *   token: string, seed: string, key: string,
 * }}
 */
export function evaluateBenchPair(token, seed, key) {
  const t = token instanceof Uint8Array ? token
          : Array.isArray(token) ? Uint8Array.from(token)
          : parseHexBytes(String(token));
  const s = seed instanceof Uint8Array ? seed
          : Array.isArray(seed) ? Uint8Array.from(seed)
          : parseHexBytes(String(seed));
  const k = key instanceof Uint8Array ? key
          : Array.isArray(key) ? Uint8Array.from(key)
          : parseHexBytes(String(key));

  const degenerate = isDegeneratePair(s, k);
  const a = evaluateConstantKey(t, k);
  const b = evaluateDerivationInput(t, s, k);
  const c = evaluateSeedDerivation(t, s);
  const hypotheses = [a, b, c];

  let verdict;
  if (a.matched) {
    verdict = degenerate ? 'inconclusive-need-more-pairs' : 'confirmed-constant-key';
  } else if (b.matched) {
    verdict = degenerate ? 'inconclusive-need-more-pairs' : 'confirmed-derivation-input';
  } else if (degenerate) {
    verdict = 'inconclusive-need-more-pairs';
  } else {
    verdict = 'rejected';
  }

  return {
    verdict,
    degenerate,
    hypotheses,
    token: fmtHex(t),
    seed: fmtHex(s),
    key: fmtHex(k),
  };
}

/**
 * Aggregate per-pair verdicts for one token across N bench pairs.
 *
 * Rules:
 *   - if any pair returns 'rejected'                       → overall 'rejected'
 *   - else if every non-degenerate pair returns the same
 *     'confirmed-*' verdict                                → that verdict
 *   - else if all pairs are degenerate                     → 'inconclusive-need-more-pairs'
 *   - else (mix of confirmed verdicts)                     → 'rejected'
 *
 * @param {Uint8Array|number[]|string} token
 * @param {Array<{ seed: any, key: any }>} pairs
 */
export function evaluateToken(token, pairs) {
  const perPair = (pairs || []).map(p => evaluateBenchPair(token, p.seed, p.key));
  if (!perPair.length) {
    return {
      overall: 'inconclusive-need-more-pairs',
      perPair: [],
      reason: 'no bench pairs supplied',
    };
  }

  const verdicts = perPair.map(r => r.verdict);
  if (verdicts.includes('rejected')) {
    return { overall: 'rejected', perPair, reason: 'at least one bench pair did not match any hypothesis' };
  }
  const confirmed = verdicts.filter(v => v === 'confirmed-constant-key' || v === 'confirmed-derivation-input');
  if (confirmed.length === 0) {
    return { overall: 'inconclusive-need-more-pairs', perPair, reason: 'every supplied pair was degenerate (all-zero, all-FF, or seed == key)' };
  }
  const unique = Array.from(new Set(confirmed));
  if (unique.length > 1) {
    return { overall: 'rejected', perPair, reason: `pairs disagreed on hypothesis (${unique.join(' vs ')})` };
  }
  return {
    overall: unique[0],
    perPair,
    reason: `${confirmed.length} of ${perPair.length} bench pair(s) matched ${unique[0]}; ${perPair.length - confirmed.length} were degenerate`,
  };
}

/** Convenience: evaluate every candidate token from the AlfaOBD intel
 *  extract against the supplied bench pairs. Used by AlfaObdIntelTab. */
export function evaluateAllCandidateTokens(pairs) {
  const tokens = SEND_CODE_CARD_LOGIN_METHOD.candidate_codecard_keys_5byte || [];
  return tokens.map(tk => ({
    token: tk,
    result: evaluateToken(parseHexBytes(tk.hex), pairs),
  }));
}

/**
 * Find the most recent SecurityAccess seed/key pair in an array of
 * parseTrace() lines. Looks for the last `27 03` request whose response
 * is a positive `67 03 <seed>`, and the subsequent `27 04 <key>` request.
 *
 * Returns null when no complete pair is present.
 *
 * @param {Array<{ dir: string, bytes: number[] }>} parsedLines
 * @returns {{ seed: Uint8Array, key: Uint8Array, seedIndex: number, keyIndex: number } | null}
 */
export function findLastSeedKeyPair(parsedLines) {
  if (!Array.isArray(parsedLines) || !parsedLines.length) return null;
  // Scan backwards for a 27 04 <key> request first, then back up to find
  // the matching 27 03 seed response that preceded it.
  for (let k = parsedLines.length - 1; k >= 0; k--) {
    const kl = parsedLines[k];
    if (!kl || !kl.bytes || kl.bytes.length < 3) continue;
    if (kl.dir !== 'req') continue;
    if (kl.bytes[0] !== 0x27 || kl.bytes[1] !== 0x04) continue;

    // Find the seed response (67 03 <seed>) immediately preceding.
    for (let s = k - 1; s >= 0; s--) {
      const sl = parsedLines[s];
      if (!sl || !sl.bytes || sl.bytes.length < 3) continue;
      if (sl.dir !== 'resp') continue;
      if (sl.bytes[0] !== 0x67 || sl.bytes[1] !== 0x03) continue;
      return {
        seed: Uint8Array.from(sl.bytes.slice(2)),
        key:  Uint8Array.from(kl.bytes.slice(2)),
        seedIndex: s,
        keyIndex: k,
      };
    }
  }
  return null;
}

export const __testing = {
  xorBytes, addBytesMod256, reverseBytes, rotateByteLeft,
  DERIVATION_TRANSFORMS,
};
