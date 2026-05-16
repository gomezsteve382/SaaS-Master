/* canCatalogMerge.mjs — pure helpers extracted from fetch-can-catalogs.mjs
 * so the URL normaliser, the merge/dedupe rule, and the summary line can
 * be unit-tested without spinning up a real fetch.
 *
 * Task #622: ajouatom/canbus-tools is a fork of iDoka/awesome-canbus, so
 * its entries are merged into iDoka's by canonical repo URL. The fork
 * occasionally carries entries the upstream doesn't, plus minor edits to
 * descriptions/tags. We want the union without silently dropping the
 * fork's wording.
 */

import { createHash } from "crypto";

/* ── URL normalisation ───────────────────────────────────────────────── */

/**
 * Canonicalise a repo URL so that obvious variants of the same target
 * collapse onto one dedupe key. The returned string is a key, not a
 * user-visible URL — entries keep their original `url` field intact.
 *
 * Rules (chosen to match the four common variants we see across iDoka
 * and ajouatom): lowercase host, strip a leading `www.`, drop a trailing
 * `.git`, drop trailing slashes, lowercase the whole thing.
 */
export function normalizeRepoUrl(input) {
  if (typeof input !== "string") return "";
  const raw = input.trim();
  if (!raw) return "";
  let parsed;
  try { parsed = new URL(raw); }
  catch { return raw.replace(/\/+$/, "").toLowerCase(); }
  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  let path = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  return `${parsed.protocol}//${host}${path}`.toLowerCase();
}

function shortHash(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

/* ── Merge / dedupe ──────────────────────────────────────────────────── */

/**
 * Merge a flat list of source-tagged entries into deduped catalog
 * records. Entries with the same `normalizeRepoUrl(url)` are collapsed
 * into one record. The FIRST entry seen for a given URL wins the
 * visible fields (name, description, category, subcategory) — callers
 * should pass entries in priority order (iDoka before ajouatom).
 *
 * When a later source also matches:
 *   - its `source` id is appended to `sources[]` (no duplicates),
 *   - its tags are unioned into the record's tags,
 *   - if its description differs from the primary description, it is
 *     captured in `notes` (semicolon-joined when more than one source
 *     contributes) so nothing is silently dropped.
 *
 * @param {Array} entries - flat list of { source, category, subcategory,
 *                          name, url, description, tags }
 * @returns {Array} deduped catalog records sorted by category/sub/name
 */
export function mergeEntries(entries) {
  const byKey = new Map();
  for (const e of entries) {
    if (!e || !e.url) continue;
    const key = normalizeRepoUrl(e.url);
    if (!key) continue;
    const prev = byKey.get(key);
    if (prev) {
      if (!prev.sources.includes(e.source)) prev.sources.push(e.source);
      // Union tags.
      for (const t of (e.tags || [])) {
        if (!prev.tags.includes(t)) prev.tags.push(t);
      }
      // Description fallback — only used if primary was blank.
      if (!prev.description && e.description) prev.description = e.description;
      // Capture a meaningfully-different secondary description in notes.
      const secDesc = (e.description || "").trim();
      const primDesc = (prev.description || "").trim();
      if (secDesc && secDesc.toLowerCase() !== primDesc.toLowerCase()) {
        const note = `${e.source}: ${secDesc}`;
        if (!prev.notes) prev.notes = note;
        else if (!prev.notes.includes(secDesc)) prev.notes = `${prev.notes}; ${note}`;
      }
      continue;
    }
    byKey.set(key, {
      id: `${e.source}:${shortHash(key)}`,
      source: e.source,
      sources: [e.source],
      category: e.category,
      subcategory: e.subcategory,
      name: e.name,
      url: e.url,
      description: e.description,
      tags: [...(e.tags || [])],
      notes: null,
      license: null,
    });
  }
  const out = [...byKey.values()];
  out.sort((a, b) =>
    (a.category || "").localeCompare(b.category || "")
    || (a.subcategory || "").localeCompare(b.subcategory || "")
    || a.name.localeCompare(b.name),
  );
  return out;
}

/* ── Summary line ────────────────────────────────────────────────────── */

/**
 * Build the self-describing one-liner that prints after a merge run.
 * Compares two named source ids (e.g. "awesome-canbus" and "ajouatom")
 * and reports how many entries each contributed, the union size, and
 * how many are exclusive to each side.
 *
 * Example:
 *   `iDoka 485 + ajouatom 487 → 491 unique (3 ajouatom-only, 1 iDoka-only)`
 */
export function summarizePairMerge(mergedEntries, leftSourceId, rightSourceId, labels = {}) {
  const leftLabel  = labels[leftSourceId]  || leftSourceId;
  const rightLabel = labels[rightSourceId] || rightSourceId;
  let leftTotal = 0, rightTotal = 0, both = 0, leftOnly = 0, rightOnly = 0;
  for (const e of mergedEntries) {
    const hasL = e.sources.includes(leftSourceId);
    const hasR = e.sources.includes(rightSourceId);
    if (hasL) leftTotal++;
    if (hasR) rightTotal++;
    if (hasL && hasR) both++;
    else if (hasL && !hasR) leftOnly++;
    else if (hasR && !hasL) rightOnly++;
  }
  const union = leftOnly + rightOnly + both;
  return `${leftLabel} ${leftTotal} + ${rightLabel} ${rightTotal} → ${union} unique (${rightOnly} ${rightLabel}-only, ${leftOnly} ${leftLabel}-only)`;
}
