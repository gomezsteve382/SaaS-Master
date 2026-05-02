/**
 * Source-pattern extractors for the asset sweep.
 *
 * Each extractor takes a parsed virtual file (path, bytes, decoded text when
 * applicable) and returns structured records. Extractors are deliberately
 * conservative: they only emit something when they see a strong signature
 * (e.g. an XTEA delta constant + a 4-uint32 key array; a CRC poly + init
 * constant in a function whose body iterates 8 bits per input byte).
 *
 * The goal is "no false positives" — the report is meant to surface things
 * actually worth porting, not raw grep hits.
 *
 * Three input shapes are covered:
 *   1. Python source (`.py`) — `listPyFunctions` + `detectSeedKeyPrimitive`.
 *   2. JavaScript source (`.js`, `.mjs`) — `listJsFunctions` finds top-level
 *      `function` and `export function` declarations and reuses the same
 *      seed-key heuristic.
 *   3. Decompiled-strings text dumps (`Pasted-*.txt`, etc.) — `scanStringsForAlgorithms`
 *      looks for combinations of well-known algorithm names plus the
 *      4-byte hex constants their cipher bodies pin.
 */

const PY_DOC_RE = /^def\s+[A-Za-z_]\w*\s*\([^)]*\)\s*:\s*\n\s*(?:r?"""([\s\S]*?)"""|r?'''([\s\S]*?)''')/m;

// Constants that uniquely identify well-known crypto primitives.
const SIGNATURE_CONSTANTS = {
  XTEA_STD_DELTA: /\b0x9E3779B9\b/i,                 // standard XTEA / TEA
  XTEA_ALFAOBD_DELTA: /\b0x8F750A1D\b/i,             // AlfaOBD's custom XTEA
  CRC16_CCITT_POLY: /\b0x1021\b/,                    // CRC-16/CCITT-FALSE
  CRC8_42_POLY: /\b0x42\b[\s\S]{0,200}?\b0x2E\b/,    // 95640 EEPROM CRC
  CRC8_RFLECT_POLY: /\b0xA0\b[\s\S]{0,200}?\b0x54\b/,
  CRC8_65_POLY: /\b0x65\b[\s\S]{0,200}?\b0xBF\b/,
  GPEC_KEY_DAIM: /DAIMLERCHRYSLER/,
  SGW_XTEA_KEY_HEX: /BC474048A33B483A/i,
  ALFA_XTEA_KEY: /\b0x9B127D51\b/i,
  CDA6_MAGIC: /\b0x4B129F\b/i,
  // Canflash table-lookup family — cf*/ngc/venom 8-entry XOR tables hit
  // these. Detected via the recognisable starter constant of each table.
  NGC_ENGINE_TABLE_HEAD: /\b0x8[Aa]4[Ff]\b[\s\S]{0,40}?\b0x5245\b/,
  HUNTSVILLE_RADIO_TABLE_HEAD: /\b0x715[Ff]\b[\s\S]{0,40}?\b0x36[Bb][Dd]\b/,
  PTIM_LX_TABLE_HEAD: /\b0x[Dd]785\b[\s\S]{0,40}?\b0x[Dd]95[Bb]\b/,
  AISIN_STACK_HEAD: /\b0x2345\b[\s\S]{0,40}?\b0x6789\b/,
  CUMMINS_849_TABLE_HEAD: /\b0x1[Cc][Ee]32951\b/,
  EGS52_CONST: /\b0x5AA5A5A5\b/i,
  MITSUBISHI_RAR_CONST: /\b0x7368\b[\s\S]{0,80}?\b0x6974\b/,
  ALPINE_RADIO_CONST: /\b0x32[Aa]95[Bb]7[Ff]\b[\s\S]{0,80}?\b0x58[Cc]2\b/,
  DCX_PTCM_CONST: /\b0x[Ff]3[Dd][Dd]1133\b/,
  BCM_FCA_CONST: /\b0x[Aa][Bb][Cc][Dd][Ee][Ff]12\b/,
  BCM_STANDARD_CONST: /\bseed\s*\*\s*0x9[Dd]\b[\s\S]{0,40}?\b0x1234\b/,
};

/**
 * Detect well-known primitive signatures inside a text blob. Returns the set
 * of signature names that fired. Used to summarise what the asset-side ports
 * cover relative to the in-app catalogs.
 */
export function detectSignatures(text) {
  const hits = new Set();
  for (const [name, re] of Object.entries(SIGNATURE_CONSTANTS)) {
    if (re.test(text)) hits.add(name);
  }
  return hits;
}

/**
 * Walk every Python `def` in a file and return:
 *   { name, params, body, docstring, signatures: Set<string> }
 *
 * "body" is the raw text between the def and the next top-level def or EOF.
 * The body slice is best-effort — the goal is enough context to compute a
 * stable shape hash, not to round-trip the file.
 */
export function listPyFunctions(text) {
  const defs = [];
  const lines = text.split("\n");

  // Find indices of all top-level defs (column 0). Async / decorators are
  // outside our corpus.
  const defLines = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/.exec(lines[i]);
    if (m) defLines.push({i, name: m[1], params: m[2]});
  }

  for (let k = 0; k < defLines.length; k++) {
    const start = defLines[k].i;
    const end = k + 1 < defLines.length ? defLines[k + 1].i : lines.length;
    const body = lines.slice(start, end).join("\n");
    const docMatch = PY_DOC_RE.exec(body);
    const doc = docMatch ? (docMatch[1] || docMatch[2] || "").trim() : "";
    defs.push({
      name: defLines[k].name,
      params: defLines[k].params.trim(),
      body,
      docstring: doc,
      signatures: detectSignatures(body),
      lang: "python",
    });
  }
  return defs;
}

/**
 * Walk every top-level `function` / `export function` declaration in a JS
 * source file and return the same shape as `listPyFunctions`. Arrow
 * functions assigned to const exports are NOT picked up — the asset corpus
 * consistently uses `function` declarations for the seed-key entry points
 * (see `attached_assets/alfaobd_seedkey_*.js`), so the simpler regex
 * matches without false positives from nested arrows in helper bodies.
 */
export function listJsFunctions(text) {
  const defs = [];
  const lines = text.split("\n");
  const fnLines = [];
  for (let i = 0; i < lines.length; i++) {
    // `function name(args)` and `export function name(args)`
    const m = /^(?:export\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)/.exec(lines[i]);
    if (m) fnLines.push({i, name: m[1], params: m[2]});
  }
  for (let k = 0; k < fnLines.length; k++) {
    const start = fnLines[k].i;
    const end = k + 1 < fnLines.length ? fnLines[k + 1].i : lines.length;
    const body = lines.slice(start, end).join("\n");
    // Pull a JSDoc-style block above the function as the docstring when
    // present (rough — only the `@description`-equivalent first line is
    // captured for the report). Falls back to "" when absent.
    let doc = "";
    for (let j = start - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (t === "" || t.startsWith("//")) continue;
      if (t.endsWith("*/")) {
        const open = lines.lastIndexOf("/**", j);
        if (open >= 0) {
          doc = lines.slice(open, j + 1).join("\n")
            .replace(/^\s*\/\*\*|\*\/\s*$/g, "")
            .replace(/^\s*\*\s?/gm, "")
            .trim()
            .split("\n").map((s) => s.trim()).filter(Boolean).join(" ")
            .slice(0, 200);
        }
      }
      break;
    }
    defs.push({
      name: fnLines[k].name,
      params: fnLines[k].params.trim(),
      body,
      docstring: doc,
      signatures: detectSignatures(body),
      lang: "javascript",
    });
  }
  return defs;
}

/**
 * Detect dictionaries in Python source whose values look like UDS service
 * IDs / NRC codes / DID lookup tables. Specifically:
 *   - SERVICES = { 0xNN: ... }
 *   - NRCS / NEG_RESP / NRC_DESCRIPTIONS = { 0xNN: ... }
 *   - SESSIONS / Session class fields
 *
 * Returns parsed entries when the pattern is unambiguous; otherwise returns
 * an empty array. The goal is to give the report a reliable count without
 * inventing a half-broken Python parser.
 */
export function extractUdsTables(text) {
  const tables = [];
  const reTable =
    /^([A-Z][A-Z_0-9]*)\s*=\s*\{\s*\n([\s\S]*?)^\}/gm;
  let m;
  while ((m = reTable.exec(text)) !== null) {
    const name = m[1];
    const inner = m[2];
    const entries = [];
    const reEntry =
      /^\s*0x([0-9a-fA-F]{1,4})\s*:\s*(.+?)\s*,\s*$/gm;
    let e;
    while ((e = reEntry.exec(inner)) !== null) {
      entries.push({code: parseInt(e[1], 16), value: e[2].trim()});
    }
    if (entries.length >= 4) {
      tables.push({name, entries});
    }
  }
  return tables;
}

/**
 * Find DID (Data Identifier) maps. Both `DIDS = { 0xNNNN: "name" }` style and
 * JSON-formatted `*_dids.json` payloads appear in the corpus.
 */
export function extractDidMap(text, filename) {
  if (filename && filename.endsWith(".json")) {
    try {
      const obj = JSON.parse(text);
      if (Array.isArray(obj)) {
        const entries = [];
        for (const r of obj) {
          if (!r || typeof r !== "object") continue;
          const idStr = r.did_id ?? r.did ?? r.id;
          if (typeof idStr !== "string" && typeof idStr !== "number") continue;
          const did = typeof idStr === "number" ? idStr : parseInt(idStr, 10);
          if (!Number.isFinite(did)) continue;
          const desc = r.description || r.name || "";
          entries.push({did, value: desc});
        }
        if (entries.length >= 8) return entries;
      } else if (obj && typeof obj === "object") {
        const entries = [];
        for (const [k, v] of Object.entries(obj)) {
          const m = /^(?:0x)?([0-9a-fA-F]+)$/.exec(k);
          if (m && (typeof v === "string" || typeof v === "object")) {
            entries.push({
              did: parseInt(m[1], 16),
              value: typeof v === "string" ? v : JSON.stringify(v),
            });
          }
        }
        if (entries.length >= 8) return entries;
      }
    } catch {
      // Not JSON; fall through to text-pattern extraction.
    }
  }
  if (filename && /_dids?\.txt$/.test(filename)) {
    const entries = [];
    const re = /^#(\d{4,6})/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      entries.push({did: parseInt(m[1], 10), value: ""});
    }
    if (entries.length >= 8) return entries;
  }
  const entries = [];
  const re = /\b0x([0-9a-fA-F]{4})\s*:\s*['"]([^'"\n]{1,80})['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    entries.push({did: parseInt(m[1], 16), value: m[2]});
  }
  return entries;
}

/**
 * Detect a CRC primitive: a function whose body contains a polynomial
 * constant (top of file or inline) plus the canonical 8-iteration loop.
 * Returns at most one hit per function.
 */
export function detectCrcPrimitive(fn) {
  const body = fn.body;
  if (!/for\s+\w+\s+in\s+range\(8\)/.test(body)) return null;
  const polyMatch =
    /(?:0x1021|0x42|0xA0|0x65|0x589B|0x8C5B|0x535D|0x71DE|0x1189|0x5F08)\b/i
      .exec(body);
  if (!polyMatch) return null;
  return {
    name: fn.name,
    params: fn.params,
    poly: polyMatch[0],
    docstring: fn.docstring,
  };
}

/**
 * Detect a seed-key primitive: a function that takes a `seed` parameter and
 * returns a key. Most asset-side ports name their result `key` or return a
 * computed integer; the caller decides what to do with the hit.
 *
 * Works for both Python and JavaScript inputs (the lang field is informational).
 */
export function detectSeedKeyPrimitive(fn) {
  if (!/^seed\b/.test(fn.params)) return null;
  if (fn.name.startsWith("_")) return null;
  if (!/return\b/.test(fn.body)) return null;
  return {
    name: fn.name,
    params: fn.params,
    docstring: fn.docstring,
    signatures: Array.from(fn.signatures).sort(),
    lang: fn.lang || "python",
  };
}

// Decompiled-strings algorithm hints. Each entry: a "tag" the algorithm
// would use plus the regexes that, when ALL match a text blob, give
// strong evidence the blob references that algorithm. Used to surface
// algorithm names mentioned in `attached_assets/Pasted-*.txt`-style
// reverse-engineering notes / IDA decompiled strings dumps.
const STRINGS_HINTS = [
  {tag: "ngc_engine", needs: [/NGC_ENGINE_TABLE|ngc_engine_unlock/, /0x537[Ee]/]},
  {tag: "ngc_transmission", needs: [/NGC_TRANS_TABLE|ngc_transmission_unlock/, /0x1[Ee][Aa]4/]},
  {tag: "venom_pcm", needs: [/VENOM_TABLE|venom_pcm_unlock/, /0xAB56/i]},
  {tag: "gpec", needs: [/DAIMLERCHRYSLER/, /gpec_unlock|GPEC_KEY/]},
  {tag: "huntsville_radio", needs: [/HUNTSVILLE_RADIO_TABLE|huntsville_radio_unlock/, /0xCA59/i]},
  {tag: "alpine_rak", needs: [/alpine_rak_unlock/, /0x4E2B/i]},
  {tag: "alpine_radio", needs: [/alpine_radio_unlock/, /0x58C2/i]},
  {tag: "dcx_ptcm", needs: [/dcx_ptcm_unlock/, /0xF3DD1133/i]},
  {tag: "egs52", needs: [/egs52_unlock/, /0x5AA5A5A5/i]},
  {tag: "aisin_tcm", needs: [/aisin_tcm_unlock|_AISIN_STACK/]},
  {tag: "ptim_lx", needs: [/ptim_lx_unlock|PTIM_LX_TABLE/]},
  {tag: "cummins_849", needs: [/cummins_849_unlock|CUMMINS_849_TABLE/]},
  {tag: "mitsubishi_rar", needs: [/mitsubishi_rar_unlock/, /0x7368/]},
  {tag: "bcm_standard", needs: [/algo_bcm_standard|bcm_standard/, /0x9D/, /0x1234/]},
  {tag: "bcm_fca", needs: [/algo_bcm_fca|bcm_fca/, /0xABCDEF12/i]},
];

/**
 * Scan a free-text "decompiled strings" / notes blob for references to
 * known seed-key algorithms. Returns `[{tag, evidence: [reMatch, ...]}]`
 * — one entry per algorithm whose hint set fully fires.
 *
 * Used by sweep.mjs to flag e.g. an IDA strings dump that mentions
 * `cummins_849_unlock` so the report doesn't claim the algorithm is
 * "only seen in the canonical python source".
 */
export function scanStringsForAlgorithms(text) {
  const hits = [];
  for (const h of STRINGS_HINTS) {
    if (h.needs.every((re) => re.test(text))) {
      const ev = h.needs.map((re) => {
        const m = re.exec(text);
        return m ? m[0].slice(0, 60) : null;
      }).filter(Boolean);
      hits.push({tag: h.tag, evidence: ev});
    }
  }
  return hits;
}
