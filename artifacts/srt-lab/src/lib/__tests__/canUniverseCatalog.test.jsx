// @vitest-environment jsdom
/* canUniverseCatalog.test.jsx — Task #618
 *
 * Smoke tests for the generated awesome-canbus / Eclipse SDV catalog and
 * for the CanUniverseTab UI. The generated module ships ~485 entries;
 * we assert structural invariants (every entry has name + http(s) URL,
 * categories non-empty, the known top-level sections were parsed) and a
 * single mounted-component test for the search/filter behaviour.
 */
import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  CATALOG_ENTRIES,
  CATALOG_CATEGORIES,
  CATALOG_SOURCES,
  CATALOG_GENERATED_AT,
} from "../awesomeCanbus.generated.js";
import CanUniverseTab from "../../tabs/CanUniverseTab.jsx";

describe("awesomeCanbus.generated.js — structural invariants", () => {
  it("ships a healthy number of entries and categories", () => {
    expect(CATALOG_ENTRIES.length).toBeGreaterThan(300);
    expect(CATALOG_CATEGORIES.length).toBeGreaterThan(5);
    expect(CATALOG_SOURCES.length).toBeGreaterThanOrEqual(3);
    expect(typeof CATALOG_GENERATED_AT).toBe("string");
  });

  it("every entry has a non-empty name and a well-formed http(s) URL", () => {
    for (const e of CATALOG_ENTRIES) {
      expect(typeof e.name).toBe("string");
      expect(e.name.length).toBeGreaterThan(0);
      expect(typeof e.url).toBe("string");
      let parsed;
      expect(() => { parsed = new URL(e.url); }).not.toThrow();
      expect(["http:", "https:"]).toContain(parsed.protocol);
      expect(typeof e.id).toBe("string");
      expect(Array.isArray(e.sources)).toBe(true);
      expect(e.sources.length).toBeGreaterThan(0);
    }
  });

  it("entry ids are unique (URL-based dedupe worked)", () => {
    const ids = CATALOG_ENTRIES.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const urls = CATALOG_ENTRIES.map(e => e.url.replace(/\/+$/, "").toLowerCase());
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("captured the known awesome-canbus top-level sections", () => {
    const names = new Set(CATALOG_CATEGORIES.map(c => c.name.toLowerCase()));
    // Snapshot the sections we explicitly want surfaced to the user.
    expect([...names].some(n => n.includes("hacking"))).toBe(true);
    expect([...names].some(n => n.includes("hardware"))).toBe(true);
    expect([...names].some(n => n.includes("protocol") || n.includes("uds") || n.includes("obd"))).toBe(true);
  });

  it("category counts match the entry distribution", () => {
    for (const cat of CATALOG_CATEGORIES) {
      const actual = CATALOG_ENTRIES.filter(e => e.category === cat.name).length;
      expect(actual).toBe(cat.count);
      expect(actual).toBeGreaterThan(0);
    }
  });

  it("includes the user-curated obdium entry", () => {
    const obd = CATALOG_ENTRIES.find(e => /obdium/i.test(e.name));
    expect(obd).toBeTruthy();
    expect(obd.url).toMatch(/provrb\/obdium/);
  });

  it("includes a representative awesome-canbus entry (Caring Caribou)", () => {
    const cc = CATALOG_ENTRIES.find(e => /caring caribou/i.test(e.name));
    expect(cc).toBeTruthy();
  });
});

describe("CanUniverseTab — smoke", () => {
  beforeEach(() => { localStorage.clear(); });

  it("mounts, lists entries, and filters by search", () => {
    render(<CanUniverseTab />);
    // Header banner is present.
    expect(screen.getByText(/CAN UNIVERSE/i)).toBeTruthy();

    const results = screen.getByTestId("canuniverse-results");
    // Initially many entries — at least one well-known one is rendered.
    const before = within(results).getAllByRole("link").length;
    expect(before).toBeGreaterThan(20);

    // Type a very specific search and assert the result count drops.
    const search = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(search, { target: { value: "savvycan" } });
    const after = within(results).getAllByRole("link");
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(before);
    expect(after.some(a => /savvycan/i.test(a.textContent))).toBe(true);
  });
});
