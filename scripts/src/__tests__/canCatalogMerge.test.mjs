/* canCatalogMerge.test.mjs — Task #622 unit tests for the pure helpers
 * that back the multi-source merge in fetch-can-catalogs.mjs.
 *
 * Run with:  node --test src/__tests__/canCatalogMerge.test.mjs
 * (wired into `pnpm -F @workspace/scripts run test:can-catalogs`)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRepoUrl,
  mergeEntries,
  summarizePairMerge,
} from "../canCatalogMerge.mjs";

describe("normalizeRepoUrl — collapses the four common variants", () => {
  const variants = [
    "https://github.com/Foo/Bar",
    "https://github.com/Foo/Bar/",
    "https://github.com/Foo/Bar.git",
    "https://www.github.com/foo/bar",
  ];
  test("all four variants normalise to the same key", () => {
    const keys = new Set(variants.map(normalizeRepoUrl));
    assert.equal(keys.size, 1, `expected 1 key, got ${[...keys].join(", ")}`);
  });
  test("trailing slash + .git combined", () => {
    assert.equal(
      normalizeRepoUrl("https://github.com/foo/bar.git/"),
      normalizeRepoUrl("https://github.com/foo/bar"),
    );
  });
  test("different repos do NOT collapse", () => {
    assert.notEqual(
      normalizeRepoUrl("https://github.com/foo/bar"),
      normalizeRepoUrl("https://github.com/foo/baz"),
    );
  });
  test("non-URL strings fall back to lowercase/trim", () => {
    assert.equal(normalizeRepoUrl("Not a URL/"), "not a url");
    assert.equal(normalizeRepoUrl(""), "");
    assert.equal(normalizeRepoUrl(null), "");
  });
});

describe("mergeEntries — dedupes and records every source", () => {
  test("iDoka-only entry keeps a single-element sources array", () => {
    const out = mergeEntries([
      { source: "idoka", category: "Hardware", subcategory: null,
        name: "Solo", url: "https://github.com/solo/repo", description: "i", tags: ["a"] },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].sources, ["idoka"]);
    assert.equal(out[0].notes, null);
  });

  test("ajouatom-only entry keeps a single-element sources array", () => {
    const out = mergeEntries([
      { source: "ajouatom", category: "Tools", subcategory: null,
        name: "ForkOnly", url: "https://github.com/fork/only", description: "x", tags: [] },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].sources, ["ajouatom"]);
  });

  test("entry in both feeds with different descriptions: iDoka wins name/description, ajouatom contributes notes + tag union", () => {
    const input = [
      { source: "idoka", category: "Hacking", subcategory: null,
        name: "SavvyCAN", url: "https://github.com/collin80/savvycan",
        description: "Native cross platform Qt-based CAN analyzer.",
        tags: ["c++", "qt"] },
      { source: "ajouatom", category: "Hacking", subcategory: null,
        name: "SavvyCAN (fork notes)", url: "https://github.com/collin80/SavvyCAN.git/",
        description: "Cross-platform CAN bus reverse-engineering GUI.",
        tags: ["qt", "gui"] },
    ];
    const out = mergeEntries(input);
    assert.equal(out.length, 1, "the two URLs should dedupe to one entry");
    const e = out[0];
    assert.equal(e.name, "SavvyCAN", "iDoka wins the visible name");
    assert.match(e.description, /Native cross platform Qt-based/);
    assert.deepEqual(e.sources, ["idoka", "ajouatom"]);
    // Tag union, order preserved (iDoka's first, then new ones).
    assert.deepEqual(e.tags, ["c++", "qt", "gui"]);
    assert.ok(e.notes && e.notes.includes("ajouatom:"),
      "ajouatom's description must be captured in notes");
    assert.ok(e.notes.includes("reverse-engineering"),
      "the fork's wording must survive verbatim in notes");
  });

  test("same description in both feeds → no notes entry", () => {
    const out = mergeEntries([
      { source: "idoka", category: "X", subcategory: null,
        name: "Same", url: "https://github.com/x/same", description: "Identical text.", tags: [] },
      { source: "ajouatom", category: "X", subcategory: null,
        name: "Same", url: "https://github.com/x/same/", description: "Identical text.", tags: [] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].notes, null);
    assert.deepEqual(out[0].sources, ["idoka", "ajouatom"]);
  });

  test("sources array shape: single-source vs multi-source", () => {
    const out = mergeEntries([
      { source: "idoka", category: "C", subcategory: null,
        name: "A", url: "https://github.com/a/a", description: "", tags: [] },
      { source: "ajouatom", category: "C", subcategory: null,
        name: "B", url: "https://github.com/b/b", description: "", tags: [] },
      { source: "idoka", category: "C", subcategory: null,
        name: "AB", url: "https://github.com/ab/ab", description: "", tags: [] },
      { source: "ajouatom", category: "C", subcategory: null,
        name: "AB", url: "https://github.com/ab/ab.git", description: "", tags: [] },
    ]);
    const byName = Object.fromEntries(out.map(e => [e.name, e]));
    assert.deepEqual(byName.A.sources, ["idoka"]);
    assert.deepEqual(byName.B.sources, ["ajouatom"]);
    assert.deepEqual(byName.AB.sources, ["idoka", "ajouatom"]);
    for (const e of out) {
      assert.ok(Array.isArray(e.sources));
      assert.ok(e.sources.length >= 1);
    }
  });
});

describe("summarizePairMerge — union counts log line", () => {
  test("matches the documented shape", () => {
    // 3 ajouatom-only, 1 iDoka-only, 2 both
    const merged = [
      { sources: ["awesome-canbus"] },
      { sources: ["ajouatom"] },
      { sources: ["ajouatom"] },
      { sources: ["ajouatom"] },
      { sources: ["awesome-canbus", "ajouatom"] },
      { sources: ["awesome-canbus", "ajouatom"] },
    ];
    const line = summarizePairMerge(merged, "awesome-canbus", "ajouatom", {
      "awesome-canbus": "iDoka",
      "ajouatom": "ajouatom",
    });
    // iDoka contributes 1 + 2 = 3; ajouatom contributes 3 + 2 = 5; union = 6
    assert.equal(
      line,
      "iDoka 3 + ajouatom 5 → 6 unique (3 ajouatom-only, 1 iDoka-only)",
    );
  });

  test("entries from a third unrelated source don't pollute the pair counts", () => {
    const merged = [
      { sources: ["awesome-canbus"] },
      { sources: ["ajouatom"] },
      { sources: ["automotive-collection"] }, // unrelated
      { sources: ["awesome-canbus", "ajouatom"] },
    ];
    const line = summarizePairMerge(merged, "awesome-canbus", "ajouatom", {
      "awesome-canbus": "iDoka",
      "ajouatom": "ajouatom",
    });
    assert.equal(
      line,
      "iDoka 2 + ajouatom 2 → 3 unique (1 ajouatom-only, 1 iDoka-only)",
    );
  });
});
