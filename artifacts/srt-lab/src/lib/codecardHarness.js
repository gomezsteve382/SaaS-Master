/**
 * CodeCard bench-pair harness.
 *
 * Evaluates three hypotheses against the 5-byte CodeCard candidates from
 * SEND_CODE_CARD_LOGIN_METHOD.candidate_codecard_keys_5byte:
 *   H1 CONSTANT_KEY      — the 5 bytes ARE the literal 27 04 <key> sent in response to a seed
 *   H2 DERIVATION_INPUT  — the 5 bytes are an INPUT to a key-derivation function
 *                          (e.g. fed alongside seed bytes into a transform)
 *   H3 REJECTED          — bench evidence exists but no hypothesis matched
 *
 * INTERPRETATION CAVEATS (verbatim from securityIntelFromExe.generated.js):
 *   ⚠ INTERPRETATION CAVEATS:
 *   - The 5-byte hex strings (`4083618902`, `3E07860DAD`) are NOT confirmed to be
 *     live cryptographic keys. They could be sample CodeCards baked in for testing,
 *     expected-response patterns, or key-derivation inputs. Do not use as active
 *     crypto material without bench-verification against a real ECU.
 *   - The registry-credential storage path is verified-by-IL-string but the
 *     in-registry data is per-installation, not extracted from this binary.
 *
 * Harness output is REPORT-ONLY. Verdicts are NEVER auto-applied to any
 * live UDS flow, key derivation path, or persisted credential store.
 */

import { SEND_CODE_CARD_LOGIN_METHOD } from './securityIntelFromExe.generated.js';

export const HYPOTHESIS = {
  CONSTANT_KEY: 'H1',
  DERIVATION_INPUT: 'H2',
  REJECTED: 'H3',
};

function parseHexBytes(input) {
  if (Array.isArray(input)) return input.map((b) => b & 0xff);
  if (typeof input !== 'string') return [];
  const cleaned = input.replace(/\s+/g, '');
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return [];
  const out = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    const v = parseInt(cleaned.slice(i, i + 2), 16);
    if (Number.isNaN(v)) return [];
    out.push(v & 0xff);
  }
  return out;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if ((a[i] & 0xff) !== (b[i] & 0xff)) return false;
  }
  return true;
}

function tryXor(seed, candidate) {
  if (!seed || !candidate || seed.length === 0 || candidate.length === 0) return null;
  const n = Math.min(seed.length, candidate.length);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (seed[i] ^ candidate[i]) & 0xff;
  return out;
}

function tryConcatSuffix(seed, candidate, n) {
  const combined = [...seed, ...candidate];
  if (combined.length < n) return null;
  return combined.slice(-n);
}

function tryAddMod256(seed, candidate) {
  if (!seed || !candidate || seed.length === 0 || candidate.length === 0) return null;
  const n = Math.min(seed.length, candidate.length);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (seed[i] + candidate[i]) & 0xff;
  return out;
}

/**
 * Evaluate a single candidate against a list of bench pairs.
 * @param {{ hex?: string, bytes?: string|number[] }} candidate
 * @param {Array<{ seed: number[], expectedKey: number[], subFunction?: number }>} benchPairs
 */
export function evaluateCandidate(candidate, benchPairs) {
  const candidateBytes = parseHexBytes(candidate?.bytes ?? candidate?.hex ?? []);
  const candidateHex = candidateBytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

  if (!Array.isArray(benchPairs) || benchPairs.length === 0) {
    return {
      candidateHex,
      verdict: 'INSUFFICIENT_DATA',
      matchedPairs: [],
      confidence: 'none',
      summary: 'No bench pairs supplied; cannot evaluate any hypothesis.',
    };
  }

  const matchedPairs = [];
  let sawH1 = false;
  let sawH2 = false;

  benchPairs.forEach((pair, pairIndex) => {
    const seed = Array.isArray(pair?.seed) ? pair.seed.map((b) => b & 0xff) : [];
    const expectedKey = Array.isArray(pair?.expectedKey) ? pair.expectedKey.map((b) => b & 0xff) : [];

    if (expectedKey.length === 0) return;

    if (arraysEqual(expectedKey, candidateBytes)) {
      sawH1 = true;
      matchedPairs.push({
        pairIndex,
        hypothesis: HYPOTHESIS.CONSTANT_KEY,
        note: 'expectedKey === candidate bytes (literal match)',
      });
      return;
    }

    const xor = tryXor(seed, candidateBytes);
    if (xor && arraysEqual(xor, expectedKey)) {
      sawH2 = true;
      matchedPairs.push({
        pairIndex,
        hypothesis: HYPOTHESIS.DERIVATION_INPUT,
        note: 'transform=xor(seed, candidate) reproduces expectedKey',
      });
      return;
    }

    const suffix = tryConcatSuffix(seed, candidateBytes, expectedKey.length);
    if (suffix && arraysEqual(suffix, expectedKey)) {
      sawH2 = true;
      matchedPairs.push({
        pairIndex,
        hypothesis: HYPOTHESIS.DERIVATION_INPUT,
        note: `transform=concat(seed, candidate).slice(-${expectedKey.length}) reproduces expectedKey`,
      });
      return;
    }

    const added = tryAddMod256(seed, candidateBytes);
    if (added && arraysEqual(added, expectedKey)) {
      sawH2 = true;
      matchedPairs.push({
        pairIndex,
        hypothesis: HYPOTHESIS.DERIVATION_INPUT,
        note: 'transform=add-mod-256(seed, candidate) reproduces expectedKey',
      });
    }
  });

  if (sawH1) {
    const h1Count = matchedPairs.filter((m) => m.hypothesis === HYPOTHESIS.CONSTANT_KEY).length;
    return {
      candidateHex,
      verdict: HYPOTHESIS.CONSTANT_KEY,
      matchedPairs,
      confidence: h1Count >= 2 ? 'high' : 'medium',
      summary: `H1 CONSTANT_KEY: candidate equals expectedKey on ${h1Count} of ${benchPairs.length} pair(s). REPORT ONLY — not auto-applied.`,
    };
  }

  if (sawH2) {
    const h2Count = matchedPairs.filter((m) => m.hypothesis === HYPOTHESIS.DERIVATION_INPUT).length;
    return {
      candidateHex,
      verdict: HYPOTHESIS.DERIVATION_INPUT,
      matchedPairs,
      confidence: h2Count >= 2 ? 'medium' : 'low',
      summary: `H2 DERIVATION_INPUT: a documented transform reproduced expectedKey on ${h2Count} of ${benchPairs.length} pair(s). REPORT ONLY — not auto-applied.`,
    };
  }

  return {
    candidateHex,
    verdict: HYPOTHESIS.REJECTED,
    matchedPairs,
    confidence: 'none',
    summary: `H3 REJECTED: ${benchPairs.length} pair(s) supplied, no hypothesis (constant-key, xor, concat-suffix, add-mod-256) matched. REPORT ONLY.`,
  };
}

/**
 * Evaluate every candidate listed in SEND_CODE_CARD_LOGIN_METHOD.
 * @param {Array<{ seed: number[], expectedKey: number[], subFunction?: number }>} benchPairs
 */
export function evaluateAllCandidates(benchPairs) {
  const candidates = SEND_CODE_CARD_LOGIN_METHOD?.candidate_codecard_keys_5byte ?? [];
  return candidates.map((c) => evaluateCandidate(c, benchPairs));
}
