/* ============================================================================
 * rfhPflashIdentity.js — Best-Pick OS / PN / SERIAL extractor for RFH P-flash
 * dumps (Task #772).
 *
 * The competitor reference bench tool prints an "Identity" block per module:
 *
 *     OS:     AA30712804     (score 110)
 *     PN:     30712804BA     (score 110)
 *     SERIAL: 3060A8341IR00T (score 110)
 *
 * The fields are recovered by scanning the firmware image for printable-ASCII
 * runs, matching three field-specific regexes, and picking the highest-scoring
 * hit per field using the same `scoreCandidate` math the rest of SRT Lab uses.
 *
 * This module is intentionally read-only and parser-agnostic — callers pass a
 * raw Uint8Array and get back `{ os, pn, serial }`, each either `null` (no
 * candidate found) or a breakdown:
 *
 *     {
 *       value:    'AA30712804',
 *       offset:   0x0808,
 *       score:    110,
 *       useful:   10,
 *       ratio:    1.00,
 *       len:      10,
 *       pr:       1.00,
 *       bonus:    100,
 *       matchesCanonical: true,
 *     }
 *
 * Field shapes (mirrors the patterns the bench tool prints):
 *
 *   OS PN — 2 letters followed by 8–10 digits, optionally with a trailing
 *           2-letter revision (the reference shows both `AA30712804` and
 *           `AA40821703AA`-style variants). Stellantis OS PNs always start
 *           with two A–Z letters.
 *
 *   PN    — 8 digits + 2–3 letters (`30712804BA`, `30012001ADD`,
 *           `68356570AB`). Includes the Mopar `68xxxxxx` family used by
 *           bestPick.CANONICAL_PATTERNS.rfhPn.
 *
 *   SERIAL — 10–20 alphanumeric chars with at least one letter AND one
 *            digit (rules out pure-digit calibration tables and pure-letter
 *            ASCII headers). Optional `IR00T`-style supplier suffix is what
 *            the reference tool keys on but we don't require it because not
 *            every variant prints it.
 *
 * Scoring rationale: we route every candidate through bestPick.scoreCandidate
 * with `matchesCanonical:true` whenever the candidate also matches the
 * relevant bestPick canonical regex (rfhPn / serial), so a PN like
 * `68356570AB` lands at score 120 (10 useful + 10 pr + 100 bonus) and a
 * non-canonical PN like `93203001AK` lands at score 20 (10 useful + 10 pr).
 * That's the same ordering the reference tool produces.
 *
 * Boundary handling: the bench tool's runs are often concatenated mopar PNs
 * (`68356570AB68356571AB68356572AB...`), so we cannot rely on `\b` word
 * boundaries. The regexes use sticky / global scans without anchors and the
 * caller's per-run offset is added to the run-local match index so the
 * returned `offset` is the byte position in the full image.
 * ============================================================================ */

import { scoreCandidate, CANONICAL_PATTERNS } from './bestPick.js';

/* Printable-ASCII runs >= 6 bytes — the smallest meaningful identity field
 * (an OS PN of `AA` + 4 digits would already be 6 chars; nothing shorter is
 * worth surfacing). */
const PRINTABLE_RUN_RE = /[\x20-\x7E]{6,}/g;

/* Field regexes — global / non-anchored so concatenated runs split cleanly.
 * Each regex is sized so a longer real candidate wins on `useful` over a
 * shorter accidental substring (the scorer's tie-breaker is insertion order
 * via bestPick.pickBest, so length differences matter). */
const OS_RE     = /[A-Z]{2}\d{8,10}(?:[A-Z]{2})?/g;
const PN_RE     = /\d{8}[A-Z]{2,3}/g;
const SERIAL_RE = /[A-Z0-9]{10,20}/g;

/* Helper — does this candidate look like a serial number (mixed letters AND
 * digits)? Pure-digit runs are calibration tables, pure-letter runs are
 * ASCII headers; neither is a serial. */
function looksLikeSerial(s) {
  let hasLetter = false;
  let hasDigit  = false;
  for (const ch of s) {
    if (ch >= 'A' && ch <= 'Z') hasLetter = true;
    else if (ch >= '0' && ch <= '9') hasDigit = true;
    if (hasLetter && hasDigit) return true;
  }
  return false;
}

/* Helper — bytes -> ASCII string. Assumes the slice has already been
 * checked to contain only printable bytes (caller does this via the
 * PRINTABLE_RUN_RE scan). */
function bytesToAscii(data, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[start + i]);
  return s;
}

/* Score a single field hit. Pulls the matchesCanonical flag from a per-field
 * canonical regex (the bestPick patterns) so we don't double-define them. */
function scoreFieldHit(value, offset, canonicalRe) {
  const matchesCanonical = canonicalRe ? canonicalRe.test(value) : false;
  const b = scoreCandidate({
    value,
    precedenceRank: 1.0,
    matchesCanonical,
  });
  return { ...b, offset, matchesCanonical };
}

/* Pick the top-scoring hit out of a per-field hit list. Stable on insertion
 * order for ties, so the earliest offset wins when scores are identical —
 * matches the reference tool's "first hit wins" tie-break. */
function topPick(hits) {
  if (hits.length === 0) return null;
  let best = hits[0];
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].score > best.score) best = hits[i];
  }
  return best;
}

/**
 * Extract OS / PN / SERIAL best-picks from a raw firmware image.
 *
 * @param {Uint8Array|ArrayBuffer} buf — raw image bytes
 * @returns {{
 *   os:     ({ value, offset, score, useful, ratio, len, pr, bonus, matchesCanonical }|null),
 *   pn:     ({ value, offset, score, useful, ratio, len, pr, bonus, matchesCanonical }|null),
 *   serial: ({ value, offset, score, useful, ratio, len, pr, bonus, matchesCanonical }|null),
 *   scanned: { runs: number, bytes: number },
 * }}
 */
export function extractRfhPflashIdentity(buf) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const osHits = [];
  const pnHits = [];
  const serHits = [];

  // Decode the buffer to a Latin-1 string ONCE — re-decoding inside the
  // regex loop condition would force the 384 KB chunked-fromCharCode pass
  // on every iteration (measured ~1.6 s of needless work in the bench
  // fixture).
  const text = data.length > 0 ? bufferToString(data) : '';

  // Scan for printable-ASCII runs; each run is then walked with the three
  // field regexes against the run-local substring so concatenated PNs like
  // 68356570AB68356571AB still split cleanly.
  let m;
  PRINTABLE_RUN_RE.lastIndex = 0;
  while ((m = PRINTABLE_RUN_RE.exec(text)) !== null) {
    const runText = m[0];
    const runOffset = m.index;

    OS_RE.lastIndex = 0;
    let mm;
    while ((mm = OS_RE.exec(runText)) !== null) {
      osHits.push(scoreFieldHit(mm[0], runOffset + mm.index, null));
    }
    PN_RE.lastIndex = 0;
    while ((mm = PN_RE.exec(runText)) !== null) {
      pnHits.push(scoreFieldHit(mm[0], runOffset + mm.index, CANONICAL_PATTERNS.rfhPn));
    }
    SERIAL_RE.lastIndex = 0;
    while ((mm = SERIAL_RE.exec(runText)) !== null) {
      if (!looksLikeSerial(mm[0])) continue;
      serHits.push(scoreFieldHit(mm[0], runOffset + mm.index, CANONICAL_PATTERNS.serial));
    }
  }

  return {
    os:     topPick(osHits),
    pn:     topPick(pnHits),
    serial: topPick(serHits),
    scanned: { hitCount: osHits.length + pnHits.length + serHits.length, bytes: data.length },
  };
}

/* Decode a Uint8Array to a Latin-1 string so regex scans see one char per
 * byte. We keep this in a local helper so a future swap to TextDecoder('
 * latin1') is a one-line change. */
function bufferToString(data) {
  // String.fromCharCode.apply has a per-call argument cap (~64K on most
  // engines); for a 384 KB image we chunk to stay below it.
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < data.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, data.subarray(i, Math.min(i + CHUNK, data.length)));
  }
  return s;
}
