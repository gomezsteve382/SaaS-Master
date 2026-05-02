#!/usr/bin/env node
/**
 * tools/asset-sweep/src/sweep.mjs
 *
 * Reproducible one-shot sweep of `attached_assets/`. See ./README.md for the
 * full output contract; the high-level flow is:
 *
 *   1. Walk attached_assets/ recursively. For every .zip (including nested
 *      ones inside other zips) read the central directory, decompress every
 *      entry into an in-memory buffer, and attach a virtual path of the
 *      form  attached_assets/<zip>!/<inner>!/<file>  so the inventory stays
 *      bijective with the on-disk source.
 *
 *   2. Classify every leaf file by extension and a small set of name
 *      patterns (canflash_unlocks/*.dll → "unlock_dll"; *_uds.py → "uds";
 *      *_seedkey*.py → "seedkey"; alfaobd_dids* → "did_map"; etc).
 *
 *   3. For Python AND JavaScript source files, run the seed-key / CRC /
 *      UDS extractors and compare against ground-truth comparators loaded
 *      from the live `artifacts/srt-lab/src/lib/` files. For decompiled-
 *      strings text dumps (`Pasted-*.txt`) scan for algorithm-name + magic-
 *      constant combinations. Anything already wired into the app is logged
 *      with `coverageStatus: 'already-implemented'`; anything matching a
 *      hand-port is verified against pinned vectors.
 *
 *   4. Emit:
 *        - tools/asset-sweep/inventory.json
 *        - tools/asset-sweep/findings.generated.json   ← NEW: normalized,
 *          one record per detection with coverageStatus
 *        - tools/asset-sweep/REPORT.md
 *        - artifacts/srt-lab/src/lib/extendedAlgorithms.generated.js
 *          (executable: each entry has `fn(seed)` + `vectors` and is
 *           auto-merged into the SeedTab dispatcher fallback)
 *        - artifacts/srt-lab/src/lib/extendedCrc.generated.js
 *        - artifacts/srt-lab/public/unlock_catalog_extended.json
 *
 *   5. With `--check` (CI mode), recompute every output and exit non-zero if
 *      any of them would change. Also exits non-zero if any hand-ported
 *      algorithm fails its pinned vector verification.
 */
import {createHash} from "node:crypto";
import {
  readFileSync, writeFileSync, readdirSync, statSync, existsSync,
  mkdirSync, rmSync,
} from "node:fs";
import {dirname, resolve, basename, extname, relative} from "node:path";
import {fileURLToPath} from "node:url";

import {readZip} from "./zip.mjs";
import {
  listPyFunctions, listJsFunctions, detectCrcPrimitive, detectSeedKeyPrimitive,
  extractUdsTables, extractDidMap, scanStringsForAlgorithms,
} from "./extractors.mjs";
import {
  loadKnownAlgorithmTags, loadKnownCrcSignatures, loadKnownUnlockDlls,
  canonical,
} from "./known.mjs";
import {PORTS, NON_CIPHER_FINDINGS, verifyAllPorts} from "./ports.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(TOOL_ROOT, "../..");
const ASSETS_DIR = resolve(REPO_ROOT, "attached_assets");
const CACHE_DIR = resolve(TOOL_ROOT, ".cache");

const OUT_INVENTORY = resolve(TOOL_ROOT, "inventory.json");
const OUT_FINDINGS = resolve(TOOL_ROOT, "findings.generated.json");
const OUT_REPORT = resolve(TOOL_ROOT, "REPORT.md");
const OUT_EXT_ALGOS = resolve(REPO_ROOT, "artifacts/srt-lab/src/lib/extendedAlgorithms.generated.js");
const OUT_EXT_CRC = resolve(REPO_ROOT, "artifacts/srt-lab/src/lib/extendedCrc.generated.js");
const OUT_EXT_CATALOG = resolve(REPO_ROOT, "artifacts/srt-lab/public/unlock_catalog_extended.json");

const CHECK_MODE = process.argv.includes("--check");

// Build a set of tags this sweep has hand-ported (executable JS + vectors).
// Detections matching one of these get `ported: true` in findings — their
// `coverageStatus` is still computed from the catalog comparators (and is
// almost always "new" since these tags weren't in algos.js before this
// sweep landed them in extendedAlgorithms.generated.js).
const PORTED_TAGS = new Set(PORTS.map((p) => p.tag));
const NON_CIPHER_TAGS = new Map(NON_CIPHER_FINDINGS.map((n) => [n.tag, n]));

// Suffixes a Python author commonly appends to a cipher's tag without
// changing what the cipher actually computes. When canonical(tag) misses
// the comparator set, stripping these and re-checking lets the sweep
// flag stem-collisions as `partial-match` instead of `new`.
const CANONICAL_STEM_SUFFIXES = [
  "_unlock", "_seedkey", "_seed_key", "_key", "_seed", "_algo", "_alg",
  "_cipher", "_calc", "_compute", "_derive", "_secret",
];

function partialMatchAgainst(tag, knownAlgoTags) {
  // Only flag a partial-match if the canonical tag isn't already a direct
  // hit (which `computeCoverageStatus` checks first) and a non-trivial
  // stem rewrite lands on one of the known tags.
  for (const sfx of CANONICAL_STEM_SUFFIXES) {
    if (tag.endsWith(sfx) && tag.length > sfx.length) {
      const stem = tag.slice(0, -sfx.length);
      if (knownAlgoTags.has(stem)) return stem;
    }
    // Inverse direction: catalog has `<tag>_unlock` but we found `<tag>`.
    const candidate = tag + sfx;
    if (knownAlgoTags.has(candidate)) return candidate;
  }
  return null;
}

// ── 1. Walk attached_assets, unpack zips recursively ─────────────────────

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Inventory hashing must be idempotent across runs. A handful of files in
 * `attached_assets/` are regenerated by `artifacts/srt-lab/scripts/build-
 * keyprog-bundle.mjs` and embed an ISO timestamp inside the
 * `VERIFY_KEYPROG_*.txt` manifest (and, transitively, inside the
 * `KEYPROG_*.zip` that wraps it). Hashing the raw bytes would make
 * `pnpm sweep:assets -- --check` fail any time the bundler ran since the
 * inventory was last committed, even when no real input changed.
 *
 * `normalizeForHash` returns a buffer whose SHA-256 stays stable across
 * those rebuilds:
 *   - VERIFY_KEYPROG_*.txt → strip the `Generated:` line.
 *   - KEYPROG_*.zip → reduce to a sorted (entry-name, normalized-content
 *                     hash) listing so the wrapper SHA stays stable when
 *                     only the inner manifest's timestamp changes.
 * For every other file the original buffer is returned unchanged.
 */
function normalizeForHash(virtPath, buf) {
  const base = basename(virtPath).toLowerCase();
  if (/^verify_keyprog_.*\.txt$/.test(base)) {
    const text = buf.toString("utf8")
      .replace(/^Generated:.*$/m, "Generated:            <stripped-by-asset-sweep>");
    return Buffer.from(text);
  }
  if (/^keyprog_.*\.zip$/.test(base)) {
    let entries;
    try { entries = readZip(buf); } catch { return buf; }
    const parts = [];
    for (const entry of entries
      .filter((e) => !e.isDir)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      let inner;
      try { inner = entry.read(); } catch { continue; }
      const innerNorm = normalizeForHash("attached_assets/" + entry.name, inner);
      parts.push(entry.name + "\0" + sha256(innerNorm));
    }
    return Buffer.from(parts.join("\n"));
  }
  return buf;
}

function classify(name, parentZips) {
  // Required kinds per task spec — keep these BEFORE the generic
  // extension buckets so e.g. CDA.swf is `swf` (not `other`) and the
  // analyst-pasted decompiler dumps land in `decompiled_strings`
  // (not the generic `text` bucket).
  const _bareTop = name.split("/").pop().toLowerCase();
  const _extTop = extname(name).toLowerCase();
  if (_extTop === ".swf") return "swf";
  // Decompiled-strings text dumps (analyst pastes, FCATool/villain `*_strings.txt`,
  // RABCDAsm/Ghidra/IDA output). Bucketed so the algorithm-name scanner
  // picks them up without grepping by filename.
  if (/^pasted-.*\.txt$/.test(_bareTop)
      || /\bdecomp(?:iled)?(?:_strings?)?\b/.test(_bareTop)
      || /\bstrings?_dump\b/.test(_bareTop)
      || /_strings\.txt$/.test(_bareTop)) {
    return "decompiled_strings";
  }
  if (/^alfaobd_algorithm_catalog.*\.json$/.test(_bareTop)) {
    return "alfaobd_algorithm_catalog";
  }

  const lower = name.toLowerCase();
  const ext = extname(lower);
  const bare = basename(lower);
  const path = parentZips.concat([name]).join("!/");
  if (ext === ".dll" && /canflash_unlocks\//.test(path)) return "unlock_dll";
  if (ext === ".dll") return "dll";
  if (ext === ".exe") return "exe";
  if (ext === ".bin") return "bin";
  if (ext === ".db" || ext === ".sqlite") return "sqlite";
  if (ext === ".zip") return "zip";
  if (ext === ".asm") return "asm";
  if (/_uds(?:_errors)?\.py$/.test(bare)) return "uds_source";
  if (/_seedkey.*\.py$/.test(bare) || /_algos.*\.py$/.test(bare)) return "seedkey_source";
  if (/_seedkey.*\.js$/.test(bare) || /_algos.*\.js$/.test(bare)) return "seedkey_source_js";
  if (/_crc.*\.py$/.test(bare)) return "crc_source";
  if (/_dids?\.json$/.test(bare)) return "did_map_json";
  if (/_dids?\.txt$/.test(bare)) return "did_map_text";
  if (/_ecu_types?\.txt$/.test(bare)) return "ecu_types";
  if (/_modules?\.txt$/.test(bare)) return "ecu_modules";
  if (ext === ".py") return "python";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs") return "javascript";
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".md") return "markdown";
  if (ext === ".csv" || ext === ".tsv") return "csv";
  if (ext === ".xlsx" || ext === ".xls" || ext === ".ods") return "spreadsheet";
  if (ext === ".docx" || ext === ".doc" || ext === ".odt" || ext === ".pdf") return "document";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".txt" || ext === ".log") return "text";
  if (ext === ".json" || ext === ".yaml" || ext === ".yml" || ext === ".toml") return "config";
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".webp") return "image";
  return "other";
}

// Map a virtual zip path (`attached_assets/foo.zip!/inner/bar.bin`) to a
// safe path inside `tools/asset-sweep/.cache/` for on-disk scratch unpack.
// Replaces the `!/` zip separator with a `__zip__/` segment and strips
// any `..` traversal so the unpack tree mirrors the corpus structure.
function cacheRelFor(virtPath) {
  const safe = virtPath
    .replace(/!\//g, "__zip__/")
    .split("/")
    .map((seg) => seg.replace(/\.\.+/g, "_"))
    .filter((seg) => seg.length > 0)
    .join("/");
  return safe;
}

function walkAssets() {
  const inventory = [];
  // Rebuild scratch tree each run so `ls tools/asset-sweep/.cache/` shows
  // exactly what the sweep unpacked, byte-stable for any given input set.
  if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, {recursive: true, force: true});
  mkdirSync(CACHE_DIR, {recursive: true});

  function writeScratch(virtPath, buf) {
    const rel = cacheRelFor(virtPath);
    const abs = resolve(CACHE_DIR, rel);
    mkdirSync(dirname(abs), {recursive: true});
    writeFileSync(abs, buf);
    return rel;
  }

  function visitFile(absPath, virtPath, parentZips) {
    const buf = readFileSync(absPath);
    visitBuffer(buf, virtPath, parentZips);
  }

  function visitBuffer(buf, virtPath, parentZips) {
    const kind = classify(virtPath, parentZips);
    // Mirror every visited buffer (top-level files AND zip-internal
    // entries at any depth) into the scratch tree so the recursive
    // unpack is observable on disk, not just in memory.
    let scratchRel = null;
    try { scratchRel = writeScratch(virtPath, buf); }
    catch { /* don't let a single unpacked file kill the sweep */ }
    const record = {
      path: virtPath,
      size: buf.length,
      sha256: sha256(normalizeForHash(virtPath, buf)),
      kind,
      depth: parentZips.length,
      cachePath: scratchRel,
      _bytes: () => buf,
    };
    inventory.push(record);
    if (kind === "zip" || (extname(virtPath).toLowerCase() === ".zip")) {
      let entries;
      try {
        entries = readZip(buf);
      } catch (err) {
        record.zipError = String(err.message || err);
        return;
      }
      for (const entry of entries) {
        if (entry.isDir) continue;
        let inner;
        try { inner = entry.read(); }
        catch (err) {
          inventory.push({
            path: virtPath + "!/" + entry.name,
            size: entry.size,
            sha256: null,
            kind: "decode_error",
            depth: parentZips.length + 1,
            cachePath: null,
            error: String(err.message || err),
            _bytes: () => Buffer.alloc(0),
          });
          continue;
        }
        visitBuffer(inner, virtPath + "!/" + entry.name, parentZips.concat([virtPath]));
      }
    }
  }

  for (const entry of readdirSync(ASSETS_DIR).sort()) {
    const abs = resolve(ASSETS_DIR, entry);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      walkDir(abs, ["attached_assets", entry], visitFile);
    } else if (st.isFile()) {
      visitFile(abs, "attached_assets/" + entry, []);
    }
  }
  return inventory;
}

function walkDir(absDir, virtSegs, visitFile) {
  for (const entry of readdirSync(absDir).sort()) {
    const abs = resolve(absDir, entry);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      walkDir(abs, virtSegs.concat([entry]), visitFile);
    } else if (st.isFile()) {
      visitFile(abs, virtSegs.concat([entry]).join("/"), []);
    }
  }
}

// ── 2. Extract algorithms / CRCs / UDS data from sources ─────────────────

function asText(buf) {
  return buf.toString("utf8");
}

function shapeHash(text) {
  const stripped = text
    .replace(/#[^\n]*/g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/r?"""[\s\S]*?"""/g, "")
    .replace(/r?'''[\s\S]*?'''/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, "");
  return sha256(Buffer.from(stripped)).slice(0, 16);
}

/**
 * Compute the per-detection coverageStatus. The status set is exactly the
 * three values the unlock-coverage contract specifies:
 *   - "already-implemented" — canonical tag is in the in-app catalogs OR
 *                             flagged by ports.NON_CIPHER_FINDINGS as
 *                             semantically present already.
 *   - "partial-match"       — canonical tag stem-matches a known tag (e.g.
 *                             we saw `huntsville_radio_seedkey` and the
 *                             catalog has `huntsville_radio`). Surfaced
 *                             so a reviewer can confirm the equivalence.
 *   - "new"                 — discovered but neither covered nor a
 *                             stem-match. Whether the sweep already ships
 *                             a hand-port is recorded separately on each
 *                             finding via the `ported` boolean.
 */
function computeCoverageStatus(tag, knownAlgoTags) {
  if (knownAlgoTags.has(tag)) return "already-implemented";
  if (NON_CIPHER_TAGS.has(tag)) return NON_CIPHER_TAGS.get(tag).coverageStatus;
  if (partialMatchAgainst(tag, knownAlgoTags)) return "partial-match";
  return "new";
}

function extractAll(inventory, knownAlgoTags, knownCrcSigs) {
  const seedKeyHits = [];
  const crcHits = [];
  const stringsHits = [];                  // {sourcePath, tag, evidence}
  const udsServiceTables = new Map();
  const udsNrcTables = new Map();
  const udsSessionTables = new Map();
  const didMaps = new Map();
  const ecuTypes = new Map();

  for (const rec of inventory) {
    const isPySource = rec.kind === "seedkey_source" || rec.kind === "uds_source"
      || rec.kind === "crc_source" || rec.kind === "python";
    const isJsSource = rec.kind === "seedkey_source_js"
      || (rec.kind === "javascript" && /seedkey|algos/.test(basename(rec.path).toLowerCase()));

    if (isPySource || isJsSource) {
      const text = asText(rec._bytes());
      const fns = isPySource ? listPyFunctions(text) : listJsFunctions(text);
      for (const fn of fns) {
        const sk = detectSeedKeyPrimitive(fn);
        if (sk) {
          const tag = canonical(fn.name);
          seedKeyHits.push({
            sourcePath: rec.path,
            sourceLang: fn.lang,
            name: fn.name,
            tag,
            params: fn.params,
            docstring: fn.docstring,
            signatures: Array.from(fn.signatures).sort(),
            shape: shapeHash(fn.body),
            already_in_app: knownAlgoTags.has(tag),
            coverageStatus: computeCoverageStatus(tag, knownAlgoTags),
            ported: PORTED_TAGS.has(tag),
            partialMatchOf: partialMatchAgainst(tag, knownAlgoTags),
          });
        }
        // CRC detection is python-only (the corpus has no JS CRC ports).
        if (isPySource) {
          const crc = detectCrcPrimitive(fn);
          if (crc) {
            const initMatch = /=\s*0x([0-9A-Fa-f]+)/.exec(fn.body);
            const init = initMatch ? "0x" + initMatch[1].toUpperCase() : null;
            const polyU = (crc.poly || "").replace(/^0X/i, "0x").toLowerCase();
            const polyDisplay = "0x" + polyU.replace(/^0x/, "").toUpperCase();
            crcHits.push({
              sourcePath: rec.path,
              name: fn.name,
              poly: polyDisplay,
              init,
              docstring: fn.docstring,
              already_in_app: [...knownCrcSigs].some(
                (k) => k.toLowerCase().includes(polyU)
              ),
            });
          }
        }
      }
      // UDS tables are python-side only.
      if (isPySource) {
        const tables = extractUdsTables(text);
        for (const t of tables) {
          const target = /SERVICE/i.test(t.name) ? udsServiceTables
            : /(NRC|NEG_RESP)/i.test(t.name) ? udsNrcTables
            : /SESSION/i.test(t.name) ? udsSessionTables
            : null;
          if (target) {
            const key = t.name + "@" + rec.path;
            target.set(key, {sourcePath: rec.path, name: t.name, entries: t.entries});
          }
        }
      }
    }

    // Algorithm-name scanner over every classified text dump (analyst
    // notes AND nested FCATool `*_strings.txt`). Bounded by file size to
    // keep work proportional to the corpus.
    if (rec.kind === "decompiled_strings"
        || (rec.kind === "text"
            && /attached_assets\/(?:Pasted|notes|README|VERIFY|TASK|FIX|TEST|MIGRATION|MERGE|FINAL)/i.test(rec.path))) {
      const text = asText(rec._bytes());
      if (text.length < 256 * 1024) {
        const hits = scanStringsForAlgorithms(text);
        for (const h of hits) {
          stringsHits.push({
            sourcePath: rec.path,
            tag: h.tag,
            evidence: h.evidence,
            coverageStatus: computeCoverageStatus(h.tag, knownAlgoTags),
            ported: PORTED_TAGS.has(h.tag),
          });
        }
      }
    }

    // alfaobd_algorithm_catalog_*.json — flat top-level map of algorithm
    // family tags ("w6", "w7", "f", "ht", …) to nested variant→[hex,…]
    // parameter tables. Surface every (family, variant) row as a finding
    // so coverageStatus is attributed against the in-app catalogs and
    // novel variants are visible in the report.
    if (rec.kind === "alfaobd_algorithm_catalog") {
      const text = asText(rec._bytes());
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* malformed → skip */ }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [family, variants] of Object.entries(parsed)) {
          if (!variants || typeof variants !== "object") continue;
          const tag = canonical(family);
          const variantNames = Object.keys(variants);
          seedKeyHits.push({
            sourcePath: rec.path,
            sourceLang: "alfaobd_catalog_json",
            name: family,
            tag,
            params: {variants: variantNames.length},
            docstring: `AlfaOBD algorithm-catalog row '${family}' (${variantNames.length} variants).`,
            signatures: variantNames.slice(0, 8).sort(),
            shape: sha256(Buffer.from(JSON.stringify(variants))).slice(0, 16),
            already_in_app: knownAlgoTags.has(tag),
            coverageStatus: computeCoverageStatus(tag, knownAlgoTags),
            ported: PORTED_TAGS.has(tag),
            partialMatchOf: partialMatchAgainst(tag, knownAlgoTags),
          });
        }
      }
    }

    if (rec.kind === "did_map_json" || rec.kind === "did_map_text") {
      const text = asText(rec._bytes());
      const dids = extractDidMap(text, rec.path);
      if (dids.length) didMaps.set(rec.path, dids);
    }
    if (rec.kind === "ecu_types" || rec.kind === "ecu_modules") {
      const text = asText(rec._bytes());
      ecuTypes.set(rec.path, text.length);
    }
  }

  return {
    seedKeyHits, crcHits, stringsHits,
    udsServiceTables, udsNrcTables, udsSessionTables,
    didMaps, ecuTypes,
  };
}

// ── 3. DLL coverage delta ────────────────────────────────────────────────

function computeDllCoverage(inventory, knownDlls) {
  const seen = new Map();
  for (const rec of inventory) {
    if (rec.kind !== "unlock_dll") continue;
    const fname = basename(rec.path);
    const cur = seen.get(fname);
    if (cur) {
      cur.paths.push(rec.path);
      if (cur.sha256 !== rec.sha256) cur.sha_mismatch = true;
    } else {
      seen.set(fname, {sha256: rec.sha256, size: rec.size, paths: [rec.path]});
    }
  }

  const newDlls = [];
  const verified = [];
  for (const [fname, info] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (knownDlls.has(fname)) {
      verified.push({file: fname, sha256: info.sha256, size_bytes: info.size,
        existing_status: knownDlls.get(fname).status,
        existing_algorithm: knownDlls.get(fname).algorithm});
    } else {
      newDlls.push({
        file: fname, sha256: info.sha256, size_bytes: info.size,
        paths: info.paths.sort(),
      });
    }
  }
  return {seen, newDlls, verified};
}

// ── 4. Render the generated artifacts ────────────────────────────────────

function renderInventoryJson(inventory) {
  const sanitized = inventory.map(({_bytes, ...rest}) => rest);
  sanitized.sort((a, b) => a.path.localeCompare(b.path));
  const counts = {};
  for (const rec of sanitized) counts[rec.kind] = (counts[rec.kind] || 0) + 1;
  return JSON.stringify({
    schema_version: 1,
    generated_by: "tools/asset-sweep/src/sweep.mjs",
    file_count: sanitized.length,
    counts_by_kind: Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
    ),
    files: sanitized,
  }, null, 2) + "\n";
}

/**
 * Emit the executable extended-algorithms file. Each port from
 * tools/asset-sweep/src/ports.mjs is materialized as:
 *   - a top-level `function <pythonName>(seed) { ... }` declaration
 *     (verbatim from `Function.prototype.toString` of the port's `fn`)
 *   - an entry in the `EXTENDED_ALGORITHMS` array carrying the function
 *     reference, pinned vectors, source paths from the sweep, doc, etc.
 *
 * The companion `EXTENDED_FN_BY_TAG` map is consumed by SeedTab's
 * dispatcher fallback so the picker can compute keys for these
 * algorithms without any further wiring.
 */
function renderExtendedAlgosJs(seedKeyHits, portReport) {
  // Map ported tag → list of sourcePaths the sweep saw it in.
  const sourcesByTag = new Map();
  for (const h of seedKeyHits) {
    if (!sourcesByTag.has(h.tag)) sourcesByTag.set(h.tag, new Set());
    sourcesByTag.get(h.tag).add(h.sourcePath);
  }

  const lines = [];
  lines.push("/* AUTO-GENERATED by tools/asset-sweep — DO NOT EDIT. */");
  lines.push("/* Re-run with `pnpm sweep:assets`. */");
  lines.push("/* Source-of-truth: tools/asset-sweep/src/ports.mjs (hand-ported");
  lines.push("   from the canonical Python in srtlab_canflash_algos.py). */");
  lines.push("");
  lines.push("/**");
  lines.push(" * Extended seed-key catalog: algorithm primitives discovered in");
  lines.push(" * attached_assets/ that are NOT already implemented in algos.js,");
  lines.push(" * canflashAlgos.js, or alfaobdAlgorithms.generated.js.");
  lines.push(" *");
  lines.push(" * Each entry exposes:");
  lines.push(" *   - `tag`            — canonical, snake-case identifier");
  lines.push(" *   - `label`          — human-readable name for the SeedTab picker");
  lines.push(" *   - `params`         — original Python signature");
  lines.push(" *   - `docstring`      — Python docstring (first line)");
  lines.push(" *   - `signatures`     — magic-constant signature tags from the sweep");
  lines.push(" *   - `sourcePaths`    — every path in attached_assets/ where it was");
  lines.push(" *                        detected (asset corpus dedup'd to virt paths)");
  lines.push(" *   - `coverageStatus` — one of `\"already-implemented\"` /");
  lines.push(" *                        `\"partial-match\"` / `\"new\"` (per the");
  lines.push(" *                        unlock-coverage contract). Hand-ported");
  lines.push(" *                        entries are typically `\"new\"` and carry");
  lines.push(" *                        `ported: true` so the UI can flag them.");
  lines.push(" *   - `ported`         — `true` for entries below (the file's");
  lines.push(" *                        whole reason for existence is to ship");
  lines.push(" *                        executable JS for them).");
  lines.push(" *   - `vectors`        — pinned (seed, key) pairs verifying `fn`");
  lines.push(" *   - `fn(seedU32)`    — JavaScript port, returns key as u32 number");
  lines.push(" *");
  lines.push(" * SeedTab merges `EXTENDED_FN_BY_TAG` into its dispatcher fallback so");
  lines.push(" * any tag here is selectable in the picker; `tools/asset-sweep` re-");
  lines.push(" * verifies every `vectors` entry on every run and refuses to emit if");
  lines.push(" * any port drifts.");
  lines.push(" */");
  lines.push("");

  // Function declarations — verbatim Function.prototype.toString().
  for (const p of PORTS) {
    const src = p.fn.toString();
    lines.push(src);
    lines.push("");
  }

  lines.push("export const EXTENDED_ALGORITHMS = [");
  for (const p of PORTS) {
    const sources = [...(sourcesByTag.get(p.tag) || [])].sort();
    lines.push("  {");
    lines.push(`    tag: ${JSON.stringify(p.tag)},`);
    lines.push(`    label: ${JSON.stringify(p.label)},`);
    lines.push(`    pythonName: ${JSON.stringify(p.pythonName)},`);
    lines.push(`    params: ${JSON.stringify(p.params)},`);
    lines.push(`    docstring: ${JSON.stringify(p.doc)},`);
    lines.push(`    signatures: ${JSON.stringify(p.signatures)},`);
    lines.push(`    sourcePaths: ${JSON.stringify(sources)},`);
    lines.push(`    coverageStatus: ${JSON.stringify("new")},`);
    lines.push(`    ported: true,`);
    lines.push(`    fn: ${p.fn.name},`);
    lines.push("    vectors: [");
    for (const v of p.vectors) {
      lines.push(`      {seed: 0x${v.seed.toString(16).toUpperCase().padStart(8, "0")}, key: 0x${v.key.toString(16).toUpperCase().padStart(8, "0")}},`);
    }
    lines.push("    ],");
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  lines.push("export const EXTENDED_ALGORITHMS_COUNT = EXTENDED_ALGORITHMS.length;");
  lines.push("");
  lines.push("/**");
  lines.push(" * tag → fn(seedU32) lookup, used by SeedTab to extend its picker");
  lines.push(" * without modifying the curated `ALGOS` list in algos.js.");
  lines.push(" */");
  lines.push("export const EXTENDED_FN_BY_TAG = Object.freeze(");
  lines.push("  Object.fromEntries(EXTENDED_ALGORITHMS.map((a) => [a.tag, a.fn]))");
  lines.push(");");
  lines.push("");
  lines.push("/**");
  lines.push(" * Vector-verification self-test result captured at sweep time.");
  lines.push(" * Every `failed` array is empty when this file is committed —");
  lines.push(" * `pnpm sweep:assets` refuses to emit otherwise.");
  lines.push(" */");
  lines.push("export const EXTENDED_VERIFICATION = " + JSON.stringify(portReport, null, 2) + ";");
  lines.push("");
  return lines.join("\n");
}

function renderExtendedCrcJs(crcHits) {
  const novel = crcHits.filter((h) => !h.already_in_app)
    .sort((a, b) =>
      a.sourcePath.localeCompare(b.sourcePath) || a.name.localeCompare(b.name));
  const uniq = new Map();
  for (const h of novel) {
    const k = `${h.poly}:${h.init || "?"}`;
    if (!uniq.has(k)) uniq.set(k, []);
    uniq.get(k).push(h);
  }

  const lines = [];
  lines.push("/* AUTO-GENERATED by tools/asset-sweep — DO NOT EDIT. */");
  lines.push("/* Re-run with `pnpm sweep:assets`. */");
  lines.push("");
  lines.push("/**");
  lines.push(" * Extended CRC catalog: CRC / checksum primitives discovered in");
  lines.push(" * attached_assets/ that are NOT already implemented in crc.js.");
  lines.push(" * Keyed by `<poly>:<init>` so duplicate definitions across the");
  lines.push(" * asset corpus collapse to a single entry. Cross-references the");
  lines.push(" * source paths so an operator can audit before porting.");
  lines.push(" */");
  lines.push("export const EXTENDED_CRC_PRIMITIVES = [");
  for (const [key, hits] of [...uniq.entries()].sort()) {
    const first = hits[0];
    lines.push("  {");
    lines.push(`    key: ${JSON.stringify(key)},`);
    lines.push(`    poly: ${JSON.stringify(first.poly)},`);
    lines.push(`    init: ${JSON.stringify(first.init)},`);
    lines.push(`    name: ${JSON.stringify(first.name)},`);
    lines.push(`    docstring: ${JSON.stringify(first.docstring)},`);
    lines.push(`    sourcePaths: ${JSON.stringify(hits.map((h) => h.sourcePath).sort())},`);
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  lines.push("export const EXTENDED_CRC_COUNT = EXTENDED_CRC_PRIMITIVES.length;");
  lines.push("");
  return lines.join("\n");
}

function renderExtendedCatalog({newDlls, verified, udsServiceTables, udsNrcTables,
  udsSessionTables, didMaps, ecuTypes}) {
  // Extension entries — DLLs the asset sweep found that the in-repo
  // generator did not. Each carries `provenance: "asset_sweep"` so the UI
  // can paint the SWEEP chip on its row.
  const extensionEntries = newDlls.map((d) => ({
    file: d.file,
    sha256: d.sha256,
    size_bytes: d.size_bytes,
    paths: d.paths,
    status: "dll_only",
    reason: "Discovered in attached_assets/ via asset-sweep; not present in"
      + " tools/python-bridge/tools/canflash_unlocks/. No native port yet —"
      + " seed→key must be emulated under Unicorn or reverse-engineered.",
    provenance: "asset_sweep",
  })).sort((a, b) => a.file.localeCompare(b.file));

  // Read the canonical catalog and tag each entry with `provenance:
  // "unlock_catalog"` so this file is a true superset — every row from
  // the canonical catalog plus every extension row from the sweep, in a
  // single array. Consumers that want only the sweep-discovered rows
  // read `extension_entries` instead.
  const baseCatalogPath = resolve(REPO_ROOT, "artifacts/srt-lab/public/unlock_catalog.json");
  const baseEntries = existsSync(baseCatalogPath)
    ? (JSON.parse(readFileSync(baseCatalogPath, "utf8")).entries || [])
        .map((e) => ({...e, provenance: e.provenance || "unlock_catalog"}))
    : [];
  const baseFiles = new Set(baseEntries.map((e) => e.file));
  const dedupedExtension = extensionEntries.filter((e) => !baseFiles.has(e.file));
  const supersetEntries = [...baseEntries, ...dedupedExtension]
    .sort((a, b) => a.file.localeCompare(b.file));

  function pickCanonical(tables) {
    let best = null;
    for (const v of tables.values()) {
      if (!best || v.entries.length > best.entries.length
        || (v.entries.length === best.entries.length
          && /uds_errors/i.test(v.sourcePath) && !/uds_errors/i.test(best.sourcePath))) {
        best = v;
      }
    }
    return best;
  }

  const services = pickCanonical(udsServiceTables);
  const nrcs = pickCanonical(udsNrcTables);
  const sessions = pickCanonical(udsSessionTables);

  function dictify(t) {
    if (!t) return null;
    const out = {};
    for (const e of t.entries.sort((a, b) => a.code - b.code)) {
      const key = "0x" + e.code.toString(16).toUpperCase().padStart(2, "0");
      out[key] = e.value;
    }
    return {sourcePath: t.sourcePath, name: t.name, codes: out};
  }

  const didMapList = [...didMaps.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sourcePath, list]) => {
      const entries = list.map((d) => ({
        did: "0x" + d.did.toString(16).toUpperCase().padStart(4, "0"),
        value: d.value,
      }));
      return {
        sourcePath,
        count: list.length,
        sample: entries.slice(0, 8),
        entries,
      };
    });

  return JSON.stringify({
    schema_version: 1,
    generated_by: "tools/asset-sweep/src/sweep.mjs",
    provenance: "asset_sweep",
    description:
      "True superset of /unlock_catalog.json. `entries` contains every row"
      + " from the canonical catalog (provenance: 'unlock_catalog') plus"
      + " every DLL the asset sweep discovered that the canonical catalog"
      + " did not (provenance: 'asset_sweep'). Consumers wanting only the"
      + " sweep-side delta should iterate `extension_entries` instead;"
      + " UnlockCoverageTab does this so the SWEEP chip only appears on"
      + " the new rows. UDS service/NRC/session dictionaries and DID maps"
      + " are consumed by the same tab's reference panel.",
    entry_count: supersetEntries.length,
    base_entry_count: baseEntries.length,
    extension_count: dedupedExtension.length,
    dll_only_count: dedupedExtension.length,
    entries: supersetEntries,
    extension_entries: dedupedExtension,
    uds: {
      services: dictify(services),
      negative_response_codes: dictify(nrcs),
      sessions: dictify(sessions),
      did_maps: didMapList,
    },
    ecu_type_dumps: [...ecuTypes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, size]) => ({sourcePath: path, size_bytes: size})),
    dll_coverage_summary: {
      sweep_total: newDlls.length + verified.length,
      already_in_unlock_catalog: verified.length,
      new_in_extended_catalog: dedupedExtension.length,
    },
  }, null, 2) + "\n";
}

/**
 * Normalized findings file — one record per detection, with explicit
 * `coverageStatus`. Lets a reviewer (or a CI job) join sweep output with
 * any other coverage tracker by tag without re-deriving "already covered?"
 * from the live source files.
 */
function renderFindingsJson(extracts, knownAlgoTags, dllCoverage, portReport) {
  // Group seed-key detections by tag → all source paths + per-source lang.
  const byTag = new Map();
  for (const h of extracts.seedKeyHits) {
    if (!byTag.has(h.tag)) {
      byTag.set(h.tag, {
        tag: h.tag,
        coverageStatus: h.coverageStatus,
        ported: h.ported,
        partialMatchOf: h.partialMatchOf,
        params: h.params,
        docstring: h.docstring,
        signatures: new Set(h.signatures),
        detections: [],
      });
    }
    const e = byTag.get(h.tag);
    e.detections.push({
      sourcePath: h.sourcePath,
      lang: h.sourceLang,
      pythonName: h.name,
      shape: h.shape,
    });
    for (const s of h.signatures) e.signatures.add(s);
  }
  // Decorate ported entries with verification + vectors metadata.
  for (const p of PORTS) {
    const e = byTag.get(p.tag);
    if (!e) continue;
    const ver = portReport.find((r) => r.tag === p.tag);
    e.ported = true;
    e.port = {
      label: p.label,
      vectorCount: p.vectors.length,
      verified: ver ? ver.failed.length === 0 : false,
      failed: ver ? ver.failed : null,
    };
  }
  // Add NON-CIPHER findings (never have a `port` block — they exist purely
  // to document why the sweep skipped them).
  for (const n of NON_CIPHER_FINDINGS) {
    const e = byTag.get(n.tag);
    if (e) {
      e.coverageStatus = n.coverageStatus;
      e.rationale = n.rationale;
    }
  }

  const algorithmFindings = [...byTag.values()]
    .map((e) => ({
      ...e,
      signatures: [...e.signatures].sort(),
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag));

  // Decompiled-strings hits: cite the file + tag + status. These do NOT
  // contribute to "novelty" counts (they're just corroboration), but the
  // reviewer asked for visibility into where each algorithm is named.
  const stringsFindings = extracts.stringsHits
    .map((h) => ({
      sourcePath: h.sourcePath,
      tag: h.tag,
      coverageStatus: h.coverageStatus,
      evidence: h.evidence,
    }))
    .sort((a, b) =>
      a.sourcePath.localeCompare(b.sourcePath) || a.tag.localeCompare(b.tag));

  const dllFindings = [
    ...dllCoverage.verified.map((d) => ({
      file: d.file, sha256: d.sha256, size_bytes: d.size_bytes,
      coverageStatus: "already-implemented",
      existing_status: d.existing_status,
      existing_algorithm: d.existing_algorithm,
    })),
    ...dllCoverage.newDlls.map((d) => ({
      file: d.file, sha256: d.sha256, size_bytes: d.size_bytes,
      coverageStatus: "new",
      paths: d.paths,
    })),
  ].sort((a, b) => a.file.localeCompare(b.file));

  // Roll-up counts so a reviewer can sanity-check at a glance.
  // `coverageStatus` is the canonical 3-value contract; `ported` is an
  // orthogonal boolean — a single algorithm can be `coverageStatus: "new"`
  // AND `ported: true`, meaning we found it AND we shipped a JS port for it.
  const counts = {
    algorithms: {
      "already-implemented": algorithmFindings.filter((e) => e.coverageStatus === "already-implemented").length,
      "partial-match": algorithmFindings.filter((e) => e.coverageStatus === "partial-match").length,
      "new": algorithmFindings.filter((e) => e.coverageStatus === "new").length,
      "ported_in_sweep": algorithmFindings.filter((e) => e.ported === true).length,
    },
    dlls: {
      "already-implemented": dllFindings.filter((d) => d.coverageStatus === "already-implemented").length,
      "new": dllFindings.filter((d) => d.coverageStatus === "new").length,
    },
    decompiled_strings_hits: stringsFindings.length,
  };

  return JSON.stringify({
    schema_version: 1,
    generated_by: "tools/asset-sweep/src/sweep.mjs",
    description:
      "Normalized findings — one record per detection. `coverageStatus` is"
      + " one of 'already-implemented' / 'partial-match' / 'new' (the"
      + " unlock-coverage contract). The orthogonal `ported` boolean marks"
      + " entries this sweep ships an executable JS port for in"
      + " extendedAlgorithms.generated.js (joined by `tag`).",
    counts,
    algorithms: algorithmFindings,
    decompiled_strings: stringsFindings,
    unlock_dlls: dllFindings,
  }, null, 2) + "\n";
}

function dedupeBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, {key: k, first: item, sources: new Set(), count: 0});
    const e = map.get(k);
    e.count++;
    if (item.sourcePath) e.sources.add(item.sourcePath);
  }
  return [...map.values()]
    .map((e) => ({...e, sources: [...e.sources].sort()}))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function renderReport(inventory, extracts, dllCoverage, knownAlgoTags, knownCrcSigs, portReport) {
  const counts = {};
  for (const rec of inventory) counts[rec.kind] = (counts[rec.kind] || 0) + 1;
  const totalFiles = inventory.length;
  const zipCount = inventory.filter((r) => r.kind === "zip" || extname(r.path).toLowerCase() === ".zip").length;
  const ext = extracts;
  const novelAlgos = ext.seedKeyHits.filter((h) => !h.already_in_app);
  const knownAlgos = ext.seedKeyHits.filter((h) => h.already_in_app);
  const novelCrcs = ext.crcHits.filter((h) => !h.already_in_app);
  const portedAlgos = novelAlgos.filter((h) => h.ported);
  const partialAlgos = novelAlgos.filter((h) => h.coverageStatus === "partial-match");
  const newAlgos = novelAlgos.filter((h) => h.coverageStatus === "new");

  const lines = [];
  lines.push("# attached_assets/ sweep report");
  lines.push("");
  lines.push("Generated by `tools/asset-sweep/src/sweep.mjs` — re-run with `pnpm sweep:assets`.");
  lines.push("");
  lines.push("## File inventory");
  lines.push("");
  lines.push(`Total files (including nested zip entries): **${totalFiles}**`);
  lines.push(`ZIP archives recursed into: **${zipCount}**`);
  lines.push("");
  lines.push("| Kind | Count |");
  lines.push("| --- | ---: |");
  for (const [kind, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| \`${kind}\` | ${count} |`);
  }
  lines.push("");

  lines.push("## Seed-key algorithms");
  lines.push("");
  const novelByTag = dedupeBy(novelAlgos, (h) => h.tag);
  const knownByTag = dedupeBy(knownAlgos, (h) => h.tag);
  lines.push(`Distinct tags: **${novelByTag.length + knownByTag.length}**`);
  lines.push(`Already wired into SRT Lab (algos.js / canflashAlgos.js / alfaobdAlgorithms.generated.js): **${knownByTag.length}** distinct tags (${knownAlgos.length} raw hits)`);
  lines.push(`**Partial-match** — canonical tag stem-matches a known tag, flagged for human review: **${dedupeBy(partialAlgos, (h) => h.tag).length}** distinct tags`);
  lines.push(`**New** — neither covered nor a stem-match: **${dedupeBy(newAlgos, (h) => h.tag).length}** distinct tags`);
  lines.push(`**Ported in this sweep** — orthogonal flag: executable JS + pinned vectors in \`extendedAlgorithms.generated.js\` for **${dedupeBy(portedAlgos, (h) => h.tag).length}** distinct tags`);
  lines.push("");

  // Three explicit per-status sections, each with file references — the
  // unlock-coverage contract requires that a reviewer can see, by name,
  // which sources contributed each `already-implemented` / `partial-match`
  // / `new` finding without opening findings.generated.json.
  const novelNewByTag = dedupeBy(newAlgos, (h) => h.tag);
  const novelPartialByTag = dedupeBy(partialAlgos, (h) => h.tag);

  function renderTagListWithSources(label, rows, opts = {}) {
    lines.push(`### ${label} (${rows.length})`);
    lines.push("");
    if (!rows.length) {
      lines.push("_None._");
      lines.push("");
      return;
    }
    if (opts.withVectors) {
      lines.push("| Tag | Ported? | Sources (file refs) |");
      lines.push("| --- | --- | --- |");
    } else {
      lines.push("| Tag | Sources (file refs) |");
      lines.push("| --- | --- |");
    }
    for (const h of rows) {
      const sources = h.sources.map((s) => `\`${s}\``).join("<br>");
      if (opts.withVectors) {
        const port = PORTS.find((p) => p.tag === h.key);
        const ver = port ? portReport.find((r) => r.tag === h.key) : null;
        const portCol = port
          ? `${ver && ver.failed.length === 0 ? "✓" : "✗"} ${port.vectors.length} vectors`
          : "—";
        lines.push(`| \`${h.key}\` | ${portCol} | ${sources} |`);
      } else {
        lines.push(`| \`${h.key}\` | ${sources} |`);
      }
    }
    lines.push("");
  }

  renderTagListWithSources(
    "`already-implemented` — tag is in algos.js / canflashAlgos.js / alfaobdAlgorithms.generated.js",
    knownByTag);
  renderTagListWithSources(
    "`partial-match` — canonical stem matches a known tag (review for equivalence)",
    novelPartialByTag);
  renderTagListWithSources(
    "`new` — neither covered nor a stem-match",
    novelNewByTag,
    {withVectors: true});

  // Combined breakdown (unchanged) — useful when a reviewer wants every
  // novel detection in one table with the full status / signatures view.
  if (novelByTag.length) {
    lines.push("### All novel detections — combined view");
    lines.push("");
    lines.push("| Tag | Status | First source | Copies | Vectors | Signatures |");
    lines.push("| --- | --- | --- | ---: | ---: | --- |");
    for (const h of novelByTag) {
      const port = PORTS.find((p) => p.tag === h.key);
      const ver = port ? portReport.find((r) => r.tag === h.key) : null;
      const status = h.first.coverageStatus;
      const vectorCol = port
        ? `${ver && ver.failed.length === 0 ? "✓" : "✗"} ${port.vectors.length}`
        : "—";
      const sigs = h.first.signatures || [];
      lines.push(`| \`${h.key}\` | ${status} | \`${h.sources[0]}\` | ${h.sources.length} | ${vectorCol} | ${sigs.length ? sigs.map((s) => `\`${s}\``).join(", ") : "—"} |`);
    }
    lines.push("");
  } else if (!knownByTag.length) {
    lines.push("_No seed-key primitives detected at all._");
    lines.push("");
  }

  // Decompiled-strings corroboration.
  if (ext.stringsHits.length) {
    lines.push("### Decompiled-strings corroboration");
    lines.push("");
    lines.push(`${ext.stringsHits.length} algorithm-name references in \`attached_assets/Pasted-*.txt\` notes / decompiled-strings dumps.`);
    lines.push("");
    lines.push("| Tag | Status | Source |");
    lines.push("| --- | --- | --- |");
    const sliced = ext.stringsHits.slice(0, 30);
    for (const h of sliced) {
      lines.push(`| \`${h.tag}\` | ${h.coverageStatus} | \`${h.sourcePath}\` |`);
    }
    if (ext.stringsHits.length > 30) {
      lines.push(`| _…${ext.stringsHits.length - 30} more in findings.generated.json_ | | |`);
    }
    lines.push("");
  }

  lines.push("## Hand-port verification");
  lines.push("");
  lines.push("All entries in `extendedAlgorithms.generated.js` are validated");
  lines.push("against pinned vectors before the file is emitted. The sweep");
  lines.push("refuses to write the file if any vector fails.");
  lines.push("");
  lines.push("| Tag | Vectors | Failed |");
  lines.push("| --- | ---: | ---: |");
  for (const r of portReport) {
    lines.push(`| \`${r.tag}\` | ${r.total} | ${r.failed.length} |`);
  }
  lines.push("");

  lines.push("## CRC / checksum primitives");
  lines.push("");
  lines.push(`Discovered: **${ext.crcHits.length}**`);
  lines.push(`Already in \`crc.js\`: **${ext.crcHits.length - novelCrcs.length}**`);
  lines.push(`**New** — surfaced via \`extendedCrc.generated.js\`: **${novelCrcs.length}**`);
  lines.push("");
  if (novelCrcs.length) {
    const novelCrcByKey = dedupeBy(novelCrcs, (h) => `${h.poly}:${h.init || "?"}`);
    lines.push(`Distinct (poly, init) signatures new to SRT Lab: **${novelCrcByKey.length}**`);
    lines.push("");
    lines.push("| Poly:Init | Function (first) | First source | Copies |");
    lines.push("| --- | --- | --- | ---: |");
    for (const h of novelCrcByKey) {
      lines.push(`| \`${h.key}\` | \`${h.first.name}\` | \`${h.sources[0]}\` | ${h.sources.length} |`);
    }
    lines.push("");
  }

  lines.push("## UDS coverage");
  lines.push("");
  function pickBest(map, label) {
    let best = null;
    for (const v of map.values()) {
      if (!best || v.entries.length > best.entries.length) best = v;
    }
    return best ? `**${label}**: ${best.entries.length} codes from \`${best.sourcePath}\` (\`${best.name}\`)` : `**${label}**: none found`;
  }
  lines.push("- " + pickBest(ext.udsServiceTables, "UDS Services (ISO 14229-1)"));
  lines.push("- " + pickBest(ext.udsNrcTables, "Negative Response Codes"));
  lines.push("- " + pickBest(ext.udsSessionTables, "Session types"));
  lines.push(`- **DID maps**: ${ext.didMaps.size} source files`);
  for (const [path, list] of [...ext.didMaps.entries()].sort()) {
    lines.push(`  - \`${path}\` — ${list.length} DIDs`);
  }
  lines.push(`- **ECU type / module dumps**: ${ext.ecuTypes.size} source files`);
  for (const [path, size] of [...ext.ecuTypes.entries()].sort()) {
    lines.push(`  - \`${path}\` — ${size} bytes`);
  }
  lines.push("");

  lines.push("## Unlock DLL coverage");
  lines.push("");
  lines.push(`Total unique \`canflash_unlocks/*.dll\` filenames in attached_assets/: **${dllCoverage.seen.size}**`);
  lines.push(`Already covered by \`public/unlock_catalog.json\` (81 entries): **${dllCoverage.verified.length}**`);
  lines.push(`**New** — surfaced via \`unlock_catalog_extended.json\` as \`status: dll_only\`, merged inline into UnlockCoverageTab with a purple provenance chip: **${dllCoverage.newDlls.length}**`);
  lines.push("");
  if (dllCoverage.newDlls.length) {
    lines.push("| DLL | Size | sha256 (first 16) |");
    lines.push("| --- | ---: | --- |");
    for (const d of dllCoverage.newDlls) {
      lines.push(`| \`${d.file}\` | ${d.size_bytes} | \`${d.sha256.slice(0, 16)}…\` |`);
    }
    lines.push("");
  } else {
    lines.push("_No new DLLs. The 81-entry unlock catalog is exhaustive for this corpus._");
    lines.push("");
  }

  lines.push("## Already-in-app sanity check");
  lines.push("");
  lines.push(`Algorithm tags currently known to SRT Lab: **${knownAlgoTags.size}**`);
  lines.push(`CRC signatures currently known to SRT Lab: **${knownCrcSigs.size}**`);
  lines.push("");
  lines.push("If the Reuse counts above ever drop, that means a generated catalog");
  lines.push("entry was promoted into the in-app source — the next sweep will");
  lines.push("automatically remove it from the extended catalog. No manual sync needed.");
  lines.push("");

  return lines.join("\n");
}

// ── 5. Drive ─────────────────────────────────────────────────────────────

function writeOrCheck(filePath, content) {
  if (CHECK_MODE) {
    const cur = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
    if (cur !== content) {
      console.error(
        `[asset-sweep] ${relative(REPO_ROOT, filePath)} would change. Run \`pnpm sweep:assets\` to refresh.`
      );
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(dirname(filePath), {recursive: true});
  writeFileSync(filePath, content);
  console.log(`[asset-sweep] wrote ${relative(REPO_ROOT, filePath)} (${content.length} bytes)`);
}

function main() {
  if (!existsSync(ASSETS_DIR)) {
    console.error(`[asset-sweep] attached_assets/ not found at ${ASSETS_DIR}`);
    process.exit(2);
  }
  const t0 = Date.now();
  console.log(`[asset-sweep] walking ${ASSETS_DIR} …`);
  const inventory = walkAssets();
  console.log(`[asset-sweep]   ${inventory.length} virtual files (depth ${Math.max(...inventory.map((r) => r.depth))})`);

  // Verify hand-ports BEFORE doing anything else. If any vector fails,
  // refuse to emit — the operator must reconcile ports.mjs against the
  // python source before the sweep can produce trustworthy output.
  const portReport = verifyAllPorts();
  const failedPorts = portReport.filter((r) => r.failed.length > 0);
  if (failedPorts.length) {
    for (const r of failedPorts) {
      console.error(`[asset-sweep] PORT VERIFICATION FAILED: ${r.tag}`);
      for (const f of r.failed) {
        console.error(`  seed=0x${f.seed.toString(16).padStart(8, "0")} expected=0x${f.expected.toString(16).padStart(8, "0")} got=0x${f.got.toString(16).padStart(8, "0")}`);
      }
    }
    process.exit(3);
  }
  console.log(`[asset-sweep]   verified ${portReport.length} ports against ${portReport.reduce((s, r) => s + r.total, 0)} pinned vectors`);

  const knownAlgoTags = loadKnownAlgorithmTags(REPO_ROOT);
  const knownCrcSigs = loadKnownCrcSignatures(REPO_ROOT);
  const knownDlls = loadKnownUnlockDlls(REPO_ROOT);
  console.log(`[asset-sweep]   comparators: ${knownAlgoTags.size} algo tags, ${knownCrcSigs.size} CRCs, ${knownDlls.size} DLLs known`);

  const extracts = extractAll(inventory, knownAlgoTags, knownCrcSigs);
  const dllCoverage = computeDllCoverage(inventory, knownDlls);
  console.log(`[asset-sweep]   extracted: ${extracts.seedKeyHits.length} seed-key hits, ${extracts.crcHits.length} CRC hits, ${extracts.stringsHits.length} strings-corroborations, ${extracts.didMaps.size} DID maps, ${dllCoverage.newDlls.length} new DLLs`);

  writeOrCheck(OUT_INVENTORY, renderInventoryJson(inventory));
  writeOrCheck(OUT_FINDINGS, renderFindingsJson(extracts, knownAlgoTags, dllCoverage, portReport));
  writeOrCheck(OUT_EXT_ALGOS, renderExtendedAlgosJs(extracts.seedKeyHits, portReport));
  writeOrCheck(OUT_EXT_CRC, renderExtendedCrcJs(extracts.crcHits));
  writeOrCheck(OUT_EXT_CATALOG, renderExtendedCatalog({
    ...dllCoverage,
    udsServiceTables: extracts.udsServiceTables,
    udsNrcTables: extracts.udsNrcTables,
    udsSessionTables: extracts.udsSessionTables,
    didMaps: extracts.didMaps,
    ecuTypes: extracts.ecuTypes,
  }));
  writeOrCheck(OUT_REPORT, renderReport(inventory, extracts, dllCoverage, knownAlgoTags, knownCrcSigs, portReport));

  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[asset-sweep] done in ${dt}s${CHECK_MODE ? " (check mode)" : ""}.`);
}

main();
