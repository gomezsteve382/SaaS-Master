/* ============================================================================
 * rfhubPin.js — RFHUB key-fob PIN encoding resolver + lockout guard.
 *
 * Routine 0x0401 (program new key fob) expects the 4-digit PIN as a
 * `routineOptionRecord`, but the exact byte encoding is NOT documented in
 * any source file we have. RfhubTab historically auto-tried four common
 * FCA encodings blind. Three wrong PIN attempts permanently lock an RFHUB
 * (NRC 0x36 exceededNumberOfAttempts) — an irreversible, hardware-bricking
 * outcome — so blind multi-try with no cumulative budget is dangerous.
 *
 * This module is the single source of truth for:
 *   1. The four candidate PIN encodings (encode functions live here so the
 *      tab and tests share one implementation).
 *   2. resolvePinEncoding(moduleInfo) — best-known encoding per RFHUB
 *      hardware generation (Gen1 / Gen2 / XC2268) with a confidence level.
 *      Unknown generation returns a null encoding so the operator is forced
 *      to choose manually rather than firing blind.
 *   3. A sessionStorage-backed cumulative attempt counter keyed per RFHUB
 *      (serial / part number / address) and the gate that disables the
 *      blind "try all encodings" path after 2 cumulative attempts.
 *
 * IMPORTANT — confidence levels. None of the per-generation encodings are
 * bench-confirmed. The 0x0401 PIN format does not appear in
 * binaryIntel.generated.js (DID 0xAB02 "Key Fob Configuration Data" is
 * catalogued but its on-wire encoding is not), and the RFHUB test fixtures
 * (rfhPinnedRegistry.js / charger62 bench set) carry identity + SEC16
 * ground truth only — no captured PIN-burn traces. Every per-generation
 * entry is therefore confidence:'unverified' (a reasoned best guess, not
 * proof) and the UI must let the technician override before any frame goes
 * onto the bus. This mirrors the codebase's existing convention for
 * unverified intel (Dealer Lockout Bypass = "bench-pending", VILLAIN 0x61
 * = flag-gated).
 * ============================================================================ */

/* Hard ceiling: the RFHUB attempt counter trips a permanent lockout on the
 * third wrong PIN. We never let the operator past this many cumulative
 * attempts without a dealer-tool reset. */
export const MAX_PIN_ATTEMPTS = 3;

/* After this many cumulative attempts the blind "try all encodings" path is
 * disabled — the operator must commit to a single hand-picked encoding (or
 * abort) so the very last attempt before lockout isn't spent firing four
 * guesses in a row. */
export const BLIND_MULTITRY_LIMIT = 2;

/* ── PIN encodings ──────────────────────────────────────────────────────────
 * Each encoding turns a 4-character numeric PIN string into the byte array
 * used as the RoutineControl 0x0401 option record. `digits(pin)` is the raw
 * 0-9 array; encoders that need it derive from there. */
function digits(pin) {
  return String(pin || '').split('').map((c) => parseInt(c, 10));
}

export const PIN_ENCODINGS = Object.freeze({
  raw: {
    id: 'raw',
    name: '4 raw digit bytes',
    short: 'RAW',
    description: 'One byte per digit (0x00–0x09).',
    encode: (pin) => digits(pin),
  },
  bcd: {
    id: 'bcd',
    name: '2 BCD bytes',
    short: 'BCD',
    description: 'Two packed binary-coded-decimal bytes (high nibble = first digit).',
    encode: (pin) => {
      const d = digits(pin);
      return [((d[0] << 4) | d[1]) & 0xFF, ((d[2] << 4) | d[3]) & 0xFF];
    },
  },
  ascii: {
    id: 'ascii',
    name: '4 ASCII bytes',
    short: 'ASCII',
    description: 'One ASCII byte per digit (0x30–0x39).',
    encode: (pin) => String(pin || '').split('').map((c) => c.charCodeAt(0)),
  },
  none: {
    id: 'none',
    name: 'No PIN frame',
    short: 'NONE',
    description: 'Empty option record — module does not require a PIN for this routine.',
    encode: () => [],
  },
});

/* Canonical try order for the blind multi-try path — matches the historical
 * RfhubTab order so behaviour is unchanged below the new gate. */
export const PIN_ENCODING_ORDER = ['raw', 'bcd', 'ascii', 'none'];

/** Encode a PIN with a named encoding. Returns null for an unknown id. */
export function encodePin(encodingId, pin) {
  const enc = PIN_ENCODINGS[encodingId];
  return enc ? enc.encode(pin) : null;
}

/* ── Generation resolution ──────────────────────────────────────────────────
 * Map a parseModule() result to an RFHUB hardware generation. Returns null
 * when the module isn't a recognised RFHUB so the caller forces a manual
 * choice instead of guessing. */
export function resolveRfhubGeneration(moduleInfo) {
  if (!moduleInfo || !moduleInfo.type) return null;
  if (moduleInfo.type === 'XC2268_RFHUB') return 'XC2268';
  if (moduleInfo.type === 'RFHUB') {
    const sz = moduleInfo.size || (moduleInfo.data ? moduleInfo.data.length : 0);
    if (sz === 2048) return 'GEN1';
    if (sz === 4096 || sz === 8192) return 'GEN2';
    // Unknown RFHUB image size — treat as unresolved so the UI prompts.
    return null;
  }
  return null;
}

/* Per-generation best-known encoding table. `recommended` is the encoding
 * pre-selected in the UI; `candidates` is the ordered fallback list used by
 * the (gated) blind multi-try path. See the module header for why every
 * entry is confidence:'unverified'. */
export const RFHUB_PIN_GENERATIONS = Object.freeze({
  GEN1: {
    generation: 'GEN1',
    label: 'Gen1 RFHUB (24C16, 2 KB EEPROM)',
    recommended: 'bcd',
    confidence: 'unverified',
    candidates: ['bcd', 'raw', 'ascii', 'none'],
    source:
      'Gen1/Gen2 EEPROM RFHUBs store the PIN as packed BCD (the DID extract ' +
      'path in RfhubTab reads it as nibble pairs), so BCD is the most likely ' +
      '0x0401 option-record format. Not bench-confirmed against a PIN burn.',
  },
  GEN2: {
    generation: 'GEN2',
    label: 'Gen2 RFHUB (24C32, 4 KB EEPROM)',
    recommended: 'bcd',
    confidence: 'unverified',
    candidates: ['bcd', 'raw', 'ascii', 'none'],
    source:
      'Same EEPROM PIN storage as Gen1 — BCD is the most likely format. ' +
      'Not bench-confirmed against a PIN burn.',
  },
  XC2268: {
    generation: 'XC2268',
    label: 'XC2268 RFHUB (2019+ Infineon internal flash, 64 KB)',
    recommended: 'raw',
    confidence: 'unverified',
    candidates: ['raw', 'bcd', 'ascii', 'none'],
    source:
      'No PIN-burn capture exists for the 2019+ internal-flash family. The ' +
      'raw 4-byte option record is the conservative first guess; treat as ' +
      'unverified and override from a known-good bench capture when available.',
  },
});

/**
 * Resolve the best-known PIN encoding for a loaded RFHUB module.
 *
 * @param {object|null} moduleInfo — a parseModule() result (or null).
 * @returns {{
 *   generation: string|null,
 *   label: string,
 *   encodingId: string|null,
 *   encoding: object|null,
 *   confidence: 'unverified'|'unknown',
 *   candidates: string[],
 *   source: string,
 * }}
 * When the generation can't be resolved, `encodingId`/`encoding` are null
 * (force a manual choice) and `confidence` is 'unknown'.
 */
export function resolvePinEncoding(moduleInfo) {
  const generation = resolveRfhubGeneration(moduleInfo);
  if (!generation) {
    return {
      generation: null,
      label: 'Unknown RFHUB generation',
      encodingId: null,
      encoding: null,
      confidence: 'unknown',
      // Blind fallback list is still offered, but only behind the manual gate.
      candidates: [...PIN_ENCODING_ORDER],
      source:
        'No RFHUB dump loaded (or unrecognised image) — generation could not ' +
        'be resolved. Select an encoding manually before programming.',
    };
  }
  const g = RFHUB_PIN_GENERATIONS[generation];
  return {
    generation: g.generation,
    label: g.label,
    encodingId: g.recommended,
    encoding: PIN_ENCODINGS[g.recommended] || null,
    confidence: g.confidence,
    candidates: [...g.candidates],
    source: g.source,
  };
}

/* ── Cumulative attempt counter (sessionStorage-backed) ──────────────────────
 * Keyed per RFHUB so swapping modules on the bench doesn't leak one module's
 * attempt budget onto the next. Serial wins (globally unique), then part
 * number, then the CAN address as a last resort. All storage access is
 * wrapped in try/catch — sessionStorage may be unavailable (private mode,
 * SSR, tests). */
const ATTEMPT_KEY_PREFIX = 'srtlab:rfhub:pinattempts:';

/**
 * Build a stable sessionStorage key for a given RFHUB identity.
 * @param {{serial?:string, pn?:string, tx?:number}} ident
 */
export function pinAttemptStorageKey(ident) {
  const i = ident || {};
  const serial = i.serial && String(i.serial).trim();
  const pn = i.pn && String(i.pn).trim();
  if (serial) return ATTEMPT_KEY_PREFIX + 'sn:' + serial;
  if (pn) return ATTEMPT_KEY_PREFIX + 'pn:' + pn;
  if (typeof i.tx === 'number') return ATTEMPT_KEY_PREFIX + 'addr:' + i.tx.toString(16).toUpperCase();
  return ATTEMPT_KEY_PREFIX + 'unknown';
}

function storage() {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage;
  } catch { /* sessionStorage access can throw in sandboxed iframes */ }
  return null;
}

/** Read the cumulative attempt count for a key. Returns 0 on any failure. */
export function readPinAttempts(key) {
  const s = storage();
  if (!s) return 0;
  try {
    const raw = s.getItem(key);
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

/** Persist an explicit attempt count for a key. */
export function writePinAttempts(key, n) {
  const s = storage();
  if (!s) return;
  try { s.setItem(key, String(Math.max(0, n | 0))); } catch { /* ignore */ }
}

/** Increment and persist the attempt count; returns the new value. */
export function incrementPinAttempts(key) {
  const next = readPinAttempts(key) + 1;
  writePinAttempts(key, next);
  return next;
}

/** Clear the attempt count for a key (e.g. after a confirmed success). */
export function resetPinAttempts(key) {
  const s = storage();
  if (!s) return;
  try { s.removeItem(key); } catch { /* ignore */ }
}

/**
 * Compute the gate state for a cumulative attempt count.
 *
 * @param {number} attempts
 * @returns {{
 *   attempts: number,
 *   remaining: number,
 *   locked: boolean,          // hit the hard lockout ceiling
 *   blindAllowed: boolean,    // "try all encodings" path permitted
 *   singleAllowed: boolean,   // a single hand-picked attempt permitted
 *   critical: boolean,        // one attempt away from lockout
 * }}
 */
export function pinAttemptGate(attempts) {
  const a = Math.max(0, attempts | 0);
  const locked = a >= MAX_PIN_ATTEMPTS;
  return {
    attempts: a,
    remaining: Math.max(0, MAX_PIN_ATTEMPTS - a),
    locked,
    blindAllowed: a < BLIND_MULTITRY_LIMIT,
    singleAllowed: !locked,
    critical: !locked && a >= BLIND_MULTITRY_LIMIT,
  };
}

/**
 * Plan exactly which PIN encodings may be transmitted on a single "program"
 * click, given how many cumulative hardware attempts have already been spent.
 *
 * This is the single safety chokepoint: EVERY transmitted 0x0401 frame with a
 * PIN is a real, irreversible hardware attempt, and the third wrong attempt
 * permanently bricks the RFHUB. The planner therefore never returns a sequence
 * that could reach the lockout ceiling:
 *   - single (deliberate) mode: at most one frame, and only while not locked.
 *   - blind multi-try: stops the moment another frame would cross the blind
 *     limit, so it can never consume the operator's final deliberate attempt.
 *
 * Because the count is re-evaluated per element against the live gate, the
 * returned list is the authoritative "these and only these will be sent" set —
 * the caller increments the persistent counter once per element as it sends.
 *
 * @param {{blind:boolean, currentAttempts:number, candidateIds:string[]}} opts
 * @returns {string[]} ordered, validated encoding ids that are safe to send.
 */
export function planPinSends({ blind, currentAttempts, candidateIds } = {}) {
  const ids = Array.isArray(candidateIds)
    ? candidateIds.filter((id) => PIN_ENCODINGS[id])
    : [];
  const ordered = blind ? ids : ids.slice(0, 1);
  const out = [];
  let a = Math.max(0, currentAttempts | 0);
  for (const id of ordered) {
    const gate = pinAttemptGate(a);
    if (gate.locked) break;            // never reach the brick ceiling
    if (blind && !gate.blindAllowed) break; // preserve the final deliberate try
    out.push(id);
    a += 1;
  }
  return out;
}
