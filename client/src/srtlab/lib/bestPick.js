/* ============================================================================
 * SRT Lab — Best Pick scoring helper for module-extracted strings.
 *
 * Today, ModuleSync's per-module parsers gather candidate hits for fields
 * like Part Number, Supplier Serial, OS PN and Body PN, then silently pick
 * the first hit. The FCA SINCRO reference tool prints a transparent score
 * line per field so a tech can tell at a glance why a given candidate was
 * chosen over its neighbours.
 *
 * This file keeps the math in one place and away from the giant
 * ModuleSync.jsx render tree. It does not change which candidate is
 * actually written to the .bin output — it only ranks the candidates the
 * parser already gathered, so the UI can render a `PICK score X — useful
 * Y, ratio Z, len N, pr R` breakdown beneath each module panel.
 *
 * Scoring model
 * -------------
 *   useful = number of printable-ASCII (0x20..0x7E) bytes in the candidate
 *   ratio  = useful / candidate length (1.00 when the whole string is printable)
 *   len    = candidate length in bytes
 *   pr     = source-precedence rank (1.0 for canonical-offset hits,
 *            0.5 for fallback regex matches off non-canonical text scans)
 *   bonus  = +100 when the candidate matches the field's canonical regex
 *            (locks the scoring against drift if a future regex tweak
 *            changes the search universe but leaves the canonical PN intact)
 *
 *   score  = useful + 10·pr + bonus
 *
 *   For a canonical PN like "68331185AA" picked from the canonical offset:
 *     useful=10, ratio=1.00, len=10, pr=1.00, bonus=100
 *     score = 10 + 10 + 100 = 120
 *
 *   The fmt() helper renders the breakdown in the same order the
 *   reference tool prints it: "PICK score 120 — useful 10, ratio 1.00,
 *   len 10, pr 1.00".
 * ============================================================================ */

const PRINTABLE_RE = /[\x20-\x7E]/;

/* Canonical FCA / Stellantis field regexes — used to award the +100 bonus.
 * Mirrors the patterns engParseBcm / engParseRfh / engParsePcm already use
 * inside ModuleSync, kept here as a single export so the bestPick test can
 * pin scores without re-importing the whole module. */
export const CANONICAL_PATTERNS = {
  bcmPn:        /^68\d{6}$/,
  rfhPn:        /^68\d{6}[A-Z]{2}$/,
  rfhOsPn:      /^[A-Z]{2}\d{8,10}(?:[A-Z]{2})?$/,
  pcmBodyPn:    /^68\d{6}[A-Z]{2}$/,
  pcmOsPn:      /^0\d{7}[A-Z]{2}$/,
  pcmContPn:    /^A2C\d+$/,
  serial:       /^[A-Z0-9]{6,32}$/,
};

/* countPrintable — number of bytes (or chars) that fall in the printable
 * ASCII range. Accepts a string or a Uint8Array so callers can score
 * either the decoded text the parser handed back or the raw slice. */
export function countPrintable(input) {
  if (input == null) return 0;
  if (typeof input === 'string') {
    let n = 0;
    for (const ch of input) if (PRINTABLE_RE.test(ch)) n++;
    return n;
  }
  let n = 0;
  for (const b of input) if (b >= 0x20 && b <= 0x7E) n++;
  return n;
}

/* scoreCandidate — pure ranking function for a single candidate hit.
 *
 *   value          (string)        the decoded candidate
 *   length         (number, opt)   override for `len` (defaults to value.length)
 *   precedenceRank (number, opt)   1.0 for canonical, lower for fallback (def 1.0)
 *   matchesCanonical (bool, opt)   awards the +100 bonus when true
 *
 * Returns { score, useful, ratio, len, pr, bonus, value } so the caller
 * can both render the breakdown and feed `score` into a sort comparator. */
export function scoreCandidate({
  value,
  length,
  precedenceRank = 1.0,
  matchesCanonical = false,
} = {}) {
  const v = value == null ? '' : String(value);
  const useful = countPrintable(v);
  const len = length != null ? length : v.length;
  const ratio = len > 0 ? useful / len : 0;
  const pr = Number.isFinite(precedenceRank) ? precedenceRank : 0;
  const bonus = matchesCanonical ? 100 : 0;
  const score = useful + 10 * pr + bonus;
  return { value: v, score, useful, ratio, len, pr, bonus };
}

/* pickBest — given a list of candidates, score every one of them, sort
 * descending by score (stable on insertion order for ties — matches what
 * the reference tool does), and return { winner, ranked }.
 *
 * Each candidate may be passed as either a bare string or a config object
 * `{ value, precedenceRank, matchesCanonical, length }`. A `kind` field is
 * accepted on the candidate so the caller can use the same helper for
 * mixed-field lists (PN vs Serial vs OS) without losing field identity in
 * the returned object. */
export function pickBest(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { winner: null, ranked: [] };
  }
  const ranked = candidates.map((c, idx) => {
    const cfg = typeof c === 'string' ? { value: c } : (c || {});
    const breakdown = scoreCandidate(cfg);
    return { ...breakdown, kind: cfg.kind ?? null, _idx: idx };
  });
  ranked.sort((a, b) => (b.score - a.score) || (a._idx - b._idx));
  return { winner: ranked[0], ranked };
}

/* fmt — render a single breakdown to the dimmed line ModuleSync paints
 * underneath the module panels. Kept here so the test can lock the
 * exact wording. */
export function fmtPick(b) {
  if (!b) return '';
  const ratioStr = b.ratio.toFixed(2);
  const prStr    = b.pr.toFixed(2);
  return `PICK score ${b.score} — useful ${b.useful}, ratio ${ratioStr}, len ${b.len}, pr ${prStr}`;
}
