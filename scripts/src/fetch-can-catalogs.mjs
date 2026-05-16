#!/usr/bin/env node
/**
 * fetch-can-catalogs.mjs — Task #618
 *
 * Downloads three upstream curated lists and parses them into a single
 * normalized JS module that the SRT Lab "CAN Universe" tab consumes:
 *
 *   1. iDoka/awesome-canbus           (CC0 — primary CAN bus catalog)
 *   2. eclipse-sdv-landscape/the-automotive-collection
 *                                     (CC-BY-SA-4.0 — broader OSS automotive)
 *   3. ariexi/the-automotive-collection
 *                                     (legacy redirect — older snapshot)
 *
 * Plus a tiny hand-curated `EXTRAS` block for entries the user pinged us
 * about directly (e.g. provrb/obdium).
 *
 * Output: artifacts/srt-lab/src/lib/awesomeCanbus.generated.js
 *
 * Each parsed entry is { id, source, category, subcategory, name, url,
 * description, tags[] }. `id` is `<source>:<sha1(url)[0..10]>`. Entries
 * are deduplicated across sources by URL — the FIRST occurrence wins,
 * but every source that listed it is recorded in `entry.sources[]`.
 *
 * Run:  pnpm -F @workspace/scripts run fetch:can-catalogs
 */

import { createHash } from "crypto";
import { writeFileSync } from "fs";
import { resolve } from "path";

const ROOT    = resolve(new URL("../..", import.meta.url).pathname);
const OUT     = resolve(ROOT, "artifacts/srt-lab/src/lib/awesomeCanbus.generated.js");

const SOURCES = [
  {
    id: "awesome-canbus",
    label: "iDoka/awesome-canbus",
    license: "CC0-1.0",
    url: "https://github.com/iDoka/awesome-canbus",
    raw: "https://raw.githubusercontent.com/iDoka/awesome-canbus/main/README.md",
    api: "https://api.github.com/repos/iDoka/awesome-canbus/commits?per_page=1",
  },
  {
    id: "automotive-collection",
    label: "eclipse-sdv-landscape/the-automotive-collection",
    license: "CC-BY-SA-4.0",
    url: "https://github.com/eclipse-sdv-landscape/the-automotive-collection",
    raw: "https://raw.githubusercontent.com/eclipse-sdv-landscape/the-automotive-collection/main/README.md",
    api: "https://api.github.com/repos/eclipse-sdv-landscape/the-automotive-collection/commits?per_page=1",
  },
  {
    id: "ariexi-automotive",
    label: "ariexi/the-automotive-collection (legacy)",
    license: "CC-BY-SA-4.0",
    url: "https://github.com/ariexi/the-automotive-collection",
    raw: "https://raw.githubusercontent.com/ariexi/the-automotive-collection/main/README.md",
    api: "https://api.github.com/repos/ariexi/the-automotive-collection/commits?per_page=1",
  },
];

// Hand-curated singletons — repos the user explicitly pinged us about
// while building this catalog. Keep this list small; bulk additions
// belong in upstream PRs to one of the awesome-* lists above.
const EXTRAS = [
  {
    source: "user-curated",
    category: "Hacking and Reverse Engineering tools",
    subcategory: null,
    name: "OBDium",
    url: "https://github.com/provrb/obdium",
    description: "Free, open-source on-board diagnostics software (Rust).",
    tags: ["rust", "obd-ii"],
  },
];

/* ── fetch helpers ───────────────────────────────────────────────────── */

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "srt-lab-catalog-fetch" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function fetchSha(api) {
  try {
    const res = await fetch(api, { headers: { "User-Agent": "srt-lab-catalog-fetch", Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j) && j[0]?.sha ? j[0].sha : null;
  } catch { return null; }
}

/* ── markdown → entries ──────────────────────────────────────────────── */

const HEADING_RE = /^(#{2,4})\s+(.+?)\s*$/;
// Capture the FIRST [name](url) on a list line, plus everything after as
// the description. Stripping markdown emphasis from the name happens
// downstream.
const ENTRY_RE   = /^\s*[*\-+]\s+(?:🔝\s*)?\[([^\]]+)\]\(([^)]+)\)\s*[-—:]?\s*(.*)$/;

function cleanText(s) {
  return (s || "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([_*`])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/* Headings sometimes carry markdown links, trailing setext-style `###`
 * closers, and even a free-text description after ` - `. Strip all of
 * those down to the bare section name so the sidebar shows clean labels
 * (Task #618 review feedback). */
function cleanHeading(s) {
  let t = cleanText(s);
  // Strip Markdown link wrappers: "[label](url)" → "label".
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Strip emoji shortcodes like ":car:" / ":wrench:".
  t = t.replace(/^:[a-z0-9_+-]+:\s*/i, "");
  // Strip trailing setext closers ("### Foo ###" → "Foo").
  t = t.replace(/\s*#+\s*$/, "");
  // Strip a trailing free-text description ("Foo - some prose" → "Foo").
  // Only strip when the prefix looks like a real section name (≤ 8 words).
  const dashIdx = t.search(/\s[-—:]\s/);
  if (dashIdx > 0) {
    const head = t.slice(0, dashIdx).trim();
    if (head.split(/\s+/).length <= 8) t = head;
  }
  return t.trim();
}

function cleanName(s) {
  return cleanText(s).replace(/^~+|~+$/g, "").trim();
}

function isHttpUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

function inferTags(name, desc, url) {
  const tags = new Set();
  const hay  = `${name} ${desc} ${url}`.toLowerCase();
  const langs = [
    ["python", /\bpython\b|\.py\b/],
    ["c",      /\b(c\s*language|in\s+c\b|c\s*lib|c\s*library)\b/],
    ["c++",    /\bc\+\+|cpp\b/],
    ["rust",   /\brust\b/],
    ["go",     /\bgolang\b|\bgo\s*(library|package|lib)\b/],
    ["java",   /\bjava\b(?!script)/],
    ["c#",     /\bc#|\bdotnet\b|\.net\b/],
    ["dart",   /\bdart\b|flutter/],
    ["js",     /\b(javascript|node\.?js|typescript)\b/],
    ["arduino",/\barduino\b/],
    ["esp32",  /\besp32|esp8266\b/],
    ["linux",  /\blinux\b|socketcan/],
    ["windows",/\bwindows\b/],
    ["qt",     /\bqt\b|qml/],
    ["gui",    /\bgui\b|graphical/],
    ["cli",    /\bcli\b|command[- ]line/],
  ];
  for (const [t, re] of langs) if (re.test(hay)) tags.add(t);
  return [...tags];
}

function shortHash(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

/** Parse one README into a list of entries. */
function parseReadme(md, sourceId) {
  const lines = md.split(/\r?\n/);
  let h2 = null, h3 = null;
  let inToc = false;
  const out = [];
  for (let raw of lines) {
    // Skip code fences entirely.
    if (/^\s*```/.test(raw)) { /* toggle ignored — fences are rare in these READMEs */ continue; }

    const headM = raw.match(HEADING_RE);
    if (headM) {
      const depth = headM[1].length;
      const title = cleanHeading(headM[2]);
      // The "Contents" / "Table of Contents" section is bullet links only — skip.
      inToc = /^(contents?|table of contents)$/i.test(title);
      if (!title) continue;
      if (depth === 2) { h2 = title; h3 = null; }
      else if (depth === 3) { h3 = title; }
      else if (depth === 4) { h3 = `${h3 || ""}${h3 ? " · " : ""}${title}`; }
      continue;
    }
    if (inToc) continue;
    if (!h2) continue; // entries before the first real H2 are intro

    const m = raw.match(ENTRY_RE);
    if (!m) continue;
    const name = cleanName(m[1]);
    const url  = m[2].trim();
    const desc = cleanText(m[3]);
    if (!name || !isHttpUrl(url)) continue;
    out.push({
      source: sourceId,
      category: h2,
      subcategory: h3,
      name,
      url,
      description: desc,
      tags: inferTags(name, desc, url),
    });
  }
  return out;
}

/* ── main ────────────────────────────────────────────────────────────── */

async function main() {
  const fetchedAt = new Date().toISOString();
  const sourceMeta = [];
  const allEntries = [];

  for (const s of SOURCES) {
    console.error(`fetch ${s.label} …`);
    let md, sha = null;
    try {
      [md, sha] = await Promise.all([fetchText(s.raw), fetchSha(s.api)]);
    } catch (e) {
      console.error(`  WARN: ${e.message} — skipping`);
      sourceMeta.push({ ...s, commit: null, fetchedAt, entryCount: 0, error: e.message });
      continue;
    }
    const entries = parseReadme(md, s.id);
    console.error(`  parsed ${entries.length} entries`);
    sourceMeta.push({ id: s.id, label: s.label, license: s.license, url: s.url, commit: sha, fetchedAt, entryCount: entries.length });
    allEntries.push(...entries);
  }

  // Inject EXTRAS as their own pseudo-source.
  sourceMeta.push({
    id: "user-curated",
    label: "User-curated additions",
    license: "various",
    url: null,
    commit: null,
    fetchedAt,
    entryCount: EXTRAS.length,
  });
  for (const e of EXTRAS) allEntries.push({ ...e, tags: e.tags || inferTags(e.name, e.description, e.url) });

  // Dedupe by URL — first occurrence wins, but record every source that listed it.
  const byUrl = new Map();
  for (const e of allEntries) {
    const key = e.url.replace(/\/+$/, "").toLowerCase();
    const prev = byUrl.get(key);
    if (prev) {
      if (!prev.sources.includes(e.source)) prev.sources.push(e.source);
      // Prefer a non-empty description if the first one was blank.
      if (!prev.description && e.description) prev.description = e.description;
      // Union tags.
      for (const t of e.tags) if (!prev.tags.includes(t)) prev.tags.push(t);
      continue;
    }
    byUrl.set(key, {
      id: `${e.source}:${shortHash(key)}`,
      source: e.source,
      sources: [e.source],
      category: e.category,
      subcategory: e.subcategory,
      name: e.name,
      url: e.url,
      description: e.description,
      tags: [...e.tags],
      license: null, // populated below from the originating source meta
    });
  }
  // Hydrate per-entry license from the FIRST source that listed it.
  // Per-entry license metadata isn't available in the upstream READMEs
  // (each is a curated list, not a SPDX index), so the best we can do is
  // record which curated list's license terms apply to that listing.
  const sourceLicense = Object.fromEntries(sourceMeta.map(s => [s.id, s.license]));
  for (const e of byUrl.values()) {
    e.license = sourceLicense[e.sources[0]] || null;
  }

  const entries = [...byUrl.values()].sort((a, b) => {
    return (a.category || "").localeCompare(b.category || "")
        || (a.subcategory || "").localeCompare(b.subcategory || "")
        || a.name.localeCompare(b.name);
  });

  // Categories with counts, in first-seen order from the primary source.
  const catOrder = [];
  const catSeen = new Set();
  for (const e of entries) {
    if (!catSeen.has(e.category)) { catSeen.add(e.category); catOrder.push(e.category); }
  }
  const categories = catOrder.map((cat) => {
    const subCounts = new Map();
    let count = 0;
    for (const e of entries) {
      if (e.category !== cat) continue;
      count++;
      const sub = e.subcategory || "(uncategorized)";
      subCounts.set(sub, (subCounts.get(sub) || 0) + 1);
    }
    const subcategories = [...subCounts.entries()]
      .map(([name, n]) => ({ name, count: n }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { name: cat, count, subcategories };
  });

  const header = `/* AUTO-GENERATED by scripts/src/fetch-can-catalogs.mjs — do not edit by hand.
 *
 * Aggregated CAN bus / automotive OSS catalog used by the "CAN Universe"
 * tab (Task #618). Sources:
${sourceMeta.map(s => ` *   - ${s.label}  (${s.license})  commit=${s.commit || "n/a"}`).join("\n")}
 *
 * Fetched: ${fetchedAt}
 * Total entries (deduped by URL): ${entries.length}
 *
 * Regenerate with:  pnpm -F @workspace/scripts run fetch:can-catalogs
 *
 * Upstream licenses are preserved per-entry via \`sources\`. The user-facing
 * tab footer credits each source repo with its commit + license. */
`;

  const body = [
    "export const CATALOG_GENERATED_AT = " + JSON.stringify(fetchedAt) + ";",
    "export const CATALOG_SOURCES = " + JSON.stringify(sourceMeta, null, 2) + ";",
    "export const CATALOG_CATEGORIES = " + JSON.stringify(categories, null, 2) + ";",
    "export const CATALOG_ENTRIES = " + JSON.stringify(entries, null, 2) + ";",
    "export default CATALOG_ENTRIES;",
    "",
  ].join("\n\n");

  writeFileSync(OUT, header + "\n" + body);
  console.error(`wrote ${OUT}  (${entries.length} entries, ${categories.length} categories)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
