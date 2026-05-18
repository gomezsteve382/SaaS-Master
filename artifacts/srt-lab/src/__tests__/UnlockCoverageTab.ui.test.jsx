// @vitest-environment jsdom
//
// Mounts the UnlockCoverageTab against the real public/unlock_catalog.json
// fixture and confirms the headline counts, status filter, and details
// expansion all wire up. Catches regressions where a future renaming of
// fields (status → state, etc.) silently breaks the view.

import React from "react";
import { describe, it, afterEach, beforeEach, expect, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import UnlockCoverageTab from "../tabs/UnlockCoverageTab.jsx";
import { ALGO_FRIENDLY } from "../lib/algoFriendly.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(__dirname, "..", "..", "public", "unlock_catalog.json");
const CATALOG_RAW = readFileSync(CATALOG_PATH, "utf8");
const CATALOG = JSON.parse(CATALOG_RAW);
const TASK634_PATH = resolve(__dirname, "..", "..", "public", "task634_entries.json");
const TASK634 = JSON.parse(readFileSync(TASK634_PATH, "utf8"));

// The component now hits two endpoints:
//   1. ${BASE_URL}unlock_catalog.json  (static catalog, parsed by Zod)
//   2. /api/unlock-coverage/stats      (live dispatcher counts)
// Most tests only care about the catalog, so the default mock supplies the
// catalog for (1) and a dispatcher payload that mirrors the catalog for
// (2). Tests that need to override either path call setupFetch() with the
// shape they want.
const DEFAULT_DISPATCHER_STATS = {
  schema_version: CATALOG.schema_version,
  entry_count: CATALOG.entry_count,
  native_count: CATALOG.reversed_count,
  emulated_count: CATALOG.dll_only_count,
  algo_family_count: new Set(
    CATALOG.entries.map((e) => e.algorithm).filter(Boolean),
  ).size,
  source: "dispatcher",
};

function setupFetch({ catalog = CATALOG, stats = DEFAULT_DISPATCHER_STATS, task634 = null } = {}) {
  global.fetch = vi.fn(async (url) => {
    if (typeof url === "string" && url.includes("/api/unlock-coverage/stats")) {
      if (stats === null) {
        return { ok: false, status: 503, json: async () => ({ error: "x" }) };
      }
      return { ok: true, status: 200, json: async () => stats };
    }
    if (typeof url === "string" && url.includes("task634_entries.json")) {
      if (task634 === null) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => task634 };
    }
    return { ok: true, status: 200, json: async () => catalog };
  });
}

beforeEach(() => {
  setupFetch();
});

afterEach(() => {
  cleanup();
  delete global.fetch;
  // Reset URL state so the chip-filter URL sync from one test cannot leak
  // into the initial state of the next test (the component seeds its
  // algoFilter from window.location.search on mount).
  try { window.history.replaceState(null, "", "/"); } catch { /* jsdom only */ }
  // Task #643 — clear the remembered operator/verifications between tests
  // so one test's POST doesn't pre-fill the next test's form.
  try { window.localStorage.clear(); } catch { /* jsdom only */ }
});

describe("UnlockCoverageTab — UI", () => {
  it("renders headline coverage stats from the catalog", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    expect(screen.getByTestId("reversed-count").textContent).toBe(String(CATALOG.reversed_count));
    expect(screen.getByTestId("total-count").textContent).toBe(String(CATALOG.entry_count));
    expect(screen.getByTestId("dll-only-count").textContent).toBe(String(CATALOG.dll_only_count));
  });

  it("renders one row per catalog entry by default", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    for (const e of CATALOG.entries.slice(0, 5)) {
      expect(screen.getByTestId(`row-${e.module}`)).toBeTruthy();
    }
  });

  it("status filter narrows the row set", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    const reversed = CATALOG.entries.filter((e) => e.status === "reversed");
    expect(reversed.length).toBeGreaterThan(0);

    // 'dll_only' filter — every row should be filtered out when 100% native
    fireEvent.change(screen.getByTestId("status-filter"), {
      target: { value: "dll_only" },
    });
    expect(screen.queryByTestId(`row-${reversed[0].module}`)).toBeNull();
    expect(
      screen.getByText(/no entries match the current filter/i),
    ).toBeTruthy();

    // Switch back to 'reversed' — a known reversed-status row reappears
    fireEvent.change(screen.getByTestId("status-filter"), {
      target: { value: "reversed" },
    });
    expect(screen.queryByTestId(`row-${reversed[0].module}`)).toBeTruthy();
  });

  it("expanding a dll_only row (when one exists) shows its reason", async () => {
    const dllOnly = CATALOG.entries.find((e) => e.status === "dll_only");
    if (!dllOnly) {
      // 100% native — no dll_only rows to expand. Confirmed by the absence of
      // the dll_only banner copy and the headline showing 0 emulated.
      render(<UnlockCoverageTab />);
      await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
      expect(screen.getByTestId("dll-only-count").textContent).toBe("0");
      return;
    }
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    fireEvent.click(screen.getByTestId(`toggle-${dllOnly.module}`));
    expect(await screen.findByText(dllOnly.reason)).toBeTruthy();
  });

  it("expanding a reversed row shows its python_function name", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    const reversed = CATALOG.entries.find((e) => e.status === "reversed");
    expect(reversed).toBeTruthy();
    fireEvent.click(screen.getByTestId(`toggle-${reversed.module}`));
    expect(await screen.findByText(`${reversed.python_function}()`)).toBeTruthy();
  });

  it("renders the algorithm-family badge for each row", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    const sample = CATALOG.entries
      .filter((e) => e.algorithm)
      .slice(0, 5);
    expect(sample.length).toBeGreaterThan(0);
    for (const e of sample) {
      const cell = screen.getByTestId(`algo-${e.module}`);
      expect(cell.textContent || "").not.toBe("");
      expect(cell.textContent).not.toBe("—");
    }
  });

  it("renders algorithm friendly badge for known tag", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    // Every algorithm tag actually present in the catalog must have a
    // friendly mapping — the map and the catalog are kept in sync. This
    // catches new tags being added to the python coverage tables without
    // a matching entry in algoFriendly.js.
    const tagsInCatalog = new Set(
      CATALOG.entries.map((e) => e.algorithm).filter(Boolean),
    );
    for (const tag of tagsInCatalog) {
      expect(ALGO_FRIENDLY[tag], `missing friendly entry for ${tag}`).toBeTruthy();
      expect(ALGO_FRIENDLY[tag].label).toBeTruthy();
      expect(ALGO_FRIENDLY[tag].description).toBeTruthy();
    }

    // Spot-check that known well-formed tags render the friendly LABEL on
    // the badge — not the raw tag — and carry the description in the
    // tooltip plus the raw tag in a data attribute for filing bug reports.
    const wellFormed = ["hitag2_lfsr48", "crc32_feistel_8round", "lcg_pair", "t8_xor"];
    for (const tag of wellFormed) {
      const entry = CATALOG.entries.find((e) => e.algorithm === tag);
      if (!entry) continue;
      const cell = screen.getByTestId(`algo-${entry.module}`);
      const badge = cell.querySelector(`[data-algo-tag="${tag}"]`);
      expect(badge, `badge for ${tag}`).toBeTruthy();
      expect(badge.textContent).toBe(ALGO_FRIENDLY[tag].label);
      expect(badge.getAttribute("title")).toContain(ALGO_FRIENDLY[tag].description);
      expect(badge.getAttribute("title")).toContain(tag);
      expect(badge.getAttribute("data-placeholder")).toBe("false");
      // raw tag must NOT be the visible label for these well-formed tags
      expect(badge.textContent).not.toBe(tag);
    }

    // Placeholder tags ("unfit", "bitpack" alone, "cummins-style?",
    // "~s*K", "imul+t8", "t8_xor (32-bit)") are the ones that previously
    // looked cryptic. They must each have a friendly mapping; whichever
    // ones happen to be in the catalog must render either as the muted
    // "uncategorized" pill (for true placeholders) or with their friendly
    // label (for ones that now have a real name).
    const previouslyCryptic = [
      "cummins-style?",
      "unfit",
      "bitpack",
      "~s*K",
      "imul+t8",
      "t8_xor (32-bit)",
    ];
    for (const tag of previouslyCryptic) {
      expect(ALGO_FRIENDLY[tag], `missing friendly entry for ${tag}`).toBeTruthy();
      const entry = CATALOG.entries.find((e) => e.algorithm === tag);
      if (!entry) continue;
      const cell = screen.getByTestId(`algo-${entry.module}`);
      const badge = cell.querySelector(`[data-algo-tag="${tag}"]`);
      expect(badge, `badge for ${tag}`).toBeTruthy();
      expect(badge.textContent).toBe(ALGO_FRIENDLY[tag].label);
      // The raw cryptic tag must never be the visible label any more.
      expect(badge.textContent).not.toBe(tag);
      const expectedPlaceholder = ALGO_FRIENDLY[tag].placeholder ? "true" : "false";
      expect(badge.getAttribute("data-placeholder")).toBe(expectedPlaceholder);
    }
  });

  it("expanding a reversed row also surfaces the algorithm tag in details", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    const e = CATALOG.entries.find(
      (x) => x.status === "reversed" && x.algorithm && ALGO_FRIENDLY[x.algorithm],
    );
    expect(e).toBeTruthy();
    fireEvent.click(screen.getByTestId(`toggle-${e.module}`));
    const detail = await screen.findByTestId(`algo-detail-${e.module}`);
    const friendly = ALGO_FRIENDLY[e.algorithm];
    // Raw tag shown in muted parens alongside the friendly label
    expect(detail.textContent).toContain(e.algorithm);
    // Friendly label and full tooltip description are both visible
    expect(detail.textContent).toContain(friendly.label);
    expect(detail.textContent).toContain(friendly.description);
  });

  it("celebrates 100%-native milestone with a banner pulled from the catalog", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    const fullyNative =
      CATALOG.dll_only_count === 0 &&
      CATALOG.reversed_count === CATALOG.entry_count &&
      CATALOG.entry_count > 0;
    if (fullyNative) {
      const banner = screen.getByTestId("all-native-banner");
      expect(banner).toBeTruthy();
      expect(screen.getByTestId("native-count").textContent).toBe(
        String(CATALOG.reversed_count),
      );
      expect(screen.getByTestId("emulated-count").textContent).toBe(
        String(CATALOG.dll_only_count),
      );
      const fams = new Set(
        CATALOG.entries.map((e) => e.algorithm).filter(Boolean),
      );
      expect(screen.getByTestId("algo-family-count").textContent).toBe(
        String(fams.size),
      );
    } else {
      expect(screen.queryByTestId("all-native-banner")).toBeNull();
    }
  });

  it("prefers live dispatcher counts over catalog counts when the endpoint responds", async () => {
    // Simulate the dispatcher reporting a different mix than the static
    // catalog — the banner / header MUST display the dispatcher numbers
    // and mark its source attribute as 'dispatcher'.
    setupFetch({
      stats: {
        schema_version: 1,
        entry_count: 90,
        native_count: 88,
        emulated_count: 2,
        algo_family_count: 35,
        source: "dispatcher",
      },
    });
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    await waitFor(() => {
      expect(screen.getByTestId("reversed-count").textContent).toBe("88");
    });
    expect(screen.getByTestId("total-count").textContent).toBe("90");
    expect(screen.getByTestId("dll-only-count").textContent).toBe("2");
    expect(
      screen.getByTestId("coverage-header").getAttribute("data-stats-source"),
    ).toBe("dispatcher");
  });

  it("renders an algorithm-family chip per distinct tag with module counts", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    // Compute the expected per-algorithm counts from the catalog.
    const counts = new Map();
    for (const e of CATALOG.entries) {
      if (!e.algorithm) continue;
      counts.set(e.algorithm, (counts.get(e.algorithm) || 0) + 1);
    }
    expect(counts.size).toBeGreaterThan(0);

    // The "All" chip is always present and shows the sum of tagged modules.
    const all = screen.getByTestId("algo-chip-all");
    expect(all).toBeTruthy();
    const totalTagged = Array.from(counts.values()).reduce((s, n) => s + n, 0);
    expect(screen.getByTestId("algo-chip-all-count").textContent).toBe(
      String(totalTagged),
    );

    // Each distinct algorithm tag becomes a chip with its count badge.
    for (const [algo, n] of counts.entries()) {
      const chip = screen.getByTestId(`algo-chip-${algo}`);
      expect(chip).toBeTruthy();
      expect(screen.getByTestId(`algo-chip-${algo}-count`).textContent).toBe(
        String(n),
      );
    }
  });

  it("clicking an algorithm chip filters the table to just that family", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    // Pick an algorithm with at least one module and at least one *other*
    // module that uses a different algorithm — so we can prove the filter
    // both keeps in-family rows and removes out-of-family rows.
    const inEntry = CATALOG.entries.find((e) => e.algorithm);
    expect(inEntry).toBeTruthy();
    const outEntry = CATALOG.entries.find(
      (e) => e.algorithm && e.algorithm !== inEntry.algorithm,
    );
    expect(outEntry).toBeTruthy();

    // Sanity: both rows are visible before filtering.
    expect(screen.getByTestId(`row-${inEntry.module}`)).toBeTruthy();
    expect(screen.getByTestId(`row-${outEntry.module}`)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`algo-chip-${inEntry.algorithm}`));

    // In-family row is still rendered, out-of-family row is gone.
    expect(screen.getByTestId(`row-${inEntry.module}`)).toBeTruthy();
    expect(screen.queryByTestId(`row-${outEntry.module}`)).toBeNull();

    // The chip itself is marked active for visual emphasis.
    expect(
      screen
        .getByTestId(`algo-chip-${inEntry.algorithm}`)
        .getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen.getByTestId("algo-chip-all").getAttribute("data-active"),
    ).toBe("false");
  });

  it("clicking the active chip again clears the filter", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    const inEntry = CATALOG.entries.find((e) => e.algorithm);
    const outEntry = CATALOG.entries.find(
      (e) => e.algorithm && e.algorithm !== inEntry.algorithm,
    );

    const chip = screen.getByTestId(`algo-chip-${inEntry.algorithm}`);
    fireEvent.click(chip);
    expect(screen.queryByTestId(`row-${outEntry.module}`)).toBeNull();

    // Toggle off — full table comes back, chip is no longer active.
    fireEvent.click(chip);
    expect(screen.getByTestId(`row-${outEntry.module}`)).toBeTruthy();
    expect(chip.getAttribute("data-active")).toBe("false");
    expect(
      screen.getByTestId("algo-chip-all").getAttribute("data-active"),
    ).toBe("true");
  });

  it("the All chip resets an active filter", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    const inEntry = CATALOG.entries.find((e) => e.algorithm);
    const outEntry = CATALOG.entries.find(
      (e) => e.algorithm && e.algorithm !== inEntry.algorithm,
    );

    fireEvent.click(screen.getByTestId(`algo-chip-${inEntry.algorithm}`));
    expect(screen.queryByTestId(`row-${outEntry.module}`)).toBeNull();

    fireEvent.click(screen.getByTestId("algo-chip-all"));
    expect(screen.getByTestId(`row-${outEntry.module}`)).toBeTruthy();
    expect(
      screen.getByTestId("algo-chip-all").getAttribute("data-active"),
    ).toBe("true");
  });

  it("reflects the active chip in the URL via ?algo= and rehydrates from it", async () => {
    // Seed the URL before mounting to verify the initial-state hydration.
    const target = CATALOG.entries.find((e) => e.algorithm);
    const other = CATALOG.entries.find(
      (e) => e.algorithm && e.algorithm !== target.algorithm,
    );
    window.history.replaceState(null, "", `/?algo=${encodeURIComponent(target.algorithm)}`);

    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    // The chip pre-selected from the URL is active and the table is filtered.
    expect(
      screen
        .getByTestId(`algo-chip-${target.algorithm}`)
        .getAttribute("data-active"),
    ).toBe("true");
    expect(screen.queryByTestId(`row-${other.module}`)).toBeNull();

    // Clicking another chip updates the URL.
    fireEvent.click(screen.getByTestId(`algo-chip-${other.algorithm}`));
    await waitFor(() => {
      const sp = new URLSearchParams(window.location.search);
      expect(sp.get("algo")).toBe(other.algorithm);
    });

    // Clicking "All" clears the URL parameter.
    fireEvent.click(screen.getByTestId("algo-chip-all"));
    await waitFor(() => {
      const sp = new URLSearchParams(window.location.search);
      expect(sp.get("algo")).toBeNull();
    });

    // Cleanup — leave the URL in a neutral state for sibling tests.
    window.history.replaceState(null, "", "/");
  });

  it("the algorithm chip filter does not affect the 100% native banner counts", async () => {
    const fullyNative =
      CATALOG.dll_only_count === 0 &&
      CATALOG.reversed_count === CATALOG.entry_count &&
      CATALOG.entry_count > 0;
    if (!fullyNative) return;
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    const target = CATALOG.entries.find((e) => e.algorithm);
    fireEvent.click(screen.getByTestId(`algo-chip-${target.algorithm}`));

    // Banner still shows the full catalog counts even though the table is
    // filtered. The chip filter is a view concern, not a coverage rollup.
    expect(screen.getByTestId("native-count").textContent).toBe(
      String(CATALOG.reversed_count),
    );
    expect(screen.getByTestId("emulated-count").textContent).toBe(
      String(CATALOG.dll_only_count),
    );
    expect(screen.getByTestId("reversed-count").textContent).toBe(
      String(CATALOG.reversed_count),
    );
    expect(screen.getByTestId("total-count").textContent).toBe(
      String(CATALOG.entry_count),
    );
  });

  it("active-chip status text renders the friendly LABEL string (not [object Object])", async () => {
    // Regression test for the Task #551/#552 merge bug where the chip-row
    // status line and the chip label both rendered the friendlyAlgo()
    // return object directly as a React child, crashing every test in
    // this file with "Objects are not valid as a React child". The
    // contract: "Filtering by …" must show the friendly *label string*
    // and the underlying tag must NOT appear as visible text there.
    const target = CATALOG.entries.find(
      (e) => e.algorithm && ALGO_FRIENDLY[e.algorithm] && !ALGO_FRIENDLY[e.algorithm].placeholder,
    );
    expect(target, "need a real-family entry to test against").toBeTruthy();
    const friendly = ALGO_FRIENDLY[target.algorithm];

    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    // Default state shows the "N families across M modules" hint.
    const chipRow = screen.getByTestId("algo-chip-row");
    expect(chipRow.textContent).toMatch(/families across/);

    fireEvent.click(screen.getByTestId(`algo-chip-${target.algorithm}`));

    // After activation the status line must read "Filtering by <label>"
    // and must NOT contain the cursed [object Object] string nor the
    // raw algorithm tag (which would mean we lost the friendly mapping).
    expect(chipRow.textContent).toContain(`Filtering by ${friendly.label}`);
    expect(chipRow.textContent).not.toContain("[object Object]");
    expect(chipRow.textContent).not.toMatch(
      new RegExp(`Filtering by ${target.algorithm}\\b`),
    );
  });

  it("each algorithm chip exposes the friendly description as its tooltip", async () => {
    // Parity with the AlgoBadge tooltip behaviour (Task #551): hovering an
    // inactive chip should show a one-sentence explanation of the family,
    // not just the raw tag. This locks the contract so tooltip copy can't
    // silently regress to the bare "algorithm tag: foo" string.
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    const sample = CATALOG.entries
      .filter((e) => e.algorithm && ALGO_FRIENDLY[e.algorithm])
      .slice(0, 4);
    expect(sample.length).toBeGreaterThan(0);

    for (const e of sample) {
      const chip = screen.getByTestId(`algo-chip-${e.algorithm}`);
      const title = chip.getAttribute("title") || "";
      const friendly = ALGO_FRIENDLY[e.algorithm];
      expect(title, `chip title for ${e.algorithm}`).toContain(friendly.description);
      expect(title).toContain(e.algorithm);
    }
  });

  it("renders task634 entries in their own dedicated card (task #640)", async () => {
    // The hand-curated task-634 entries now live in a dedicated
    // "Competitor-parity additions" card with its own count badge,
    // separate from the main DLL coverage table. This keeps the DLL
    // coverage percentage from being skewed by non-DLL rows.
    setupFetch({ task634: TASK634 });
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    // Card is present with a count badge reflecting the entry count.
    expect(TASK634.entries.length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByTestId("task634-card")).toBeTruthy();
    });
    expect(screen.getByTestId("task634-count").textContent).toContain(
      String(TASK634.entries.length),
    );

    // One row per hand-curated entry inside the card.
    for (const e of TASK634.entries) {
      const row = screen.getByTestId(`task634-row-${e.id}`);
      expect(row).toBeTruthy();
      expect(row.getAttribute("data-provenance")).toBe("task-634");
    }

    // Task-634 entries must NOT appear in the main coverage table any
    // more — they are intentionally excluded so the DLL stats stay clean.
    for (const e of TASK634.entries) {
      expect(screen.queryByTestId(`row-task634_${e.id}`)).toBeNull();
    }

    // Canonical catalog row is still in the main table.
    const canonical = CATALOG.entries[0];
    expect(screen.getByTestId(`row-${canonical.module}`)).toBeTruthy();

    // The "Showing X of Y entries" counter reflects only the canonical
    // DLL catalog, not the task-634 additions.
    const counter = screen.getByText(/of\s+\d+\s+entries/i);
    expect(counter.textContent.replace(/\s+/g, " ")).toContain(
      `of ${CATALOG.entries.length} entries`,
    );

    // Headline stats remain pinned to the DLL catalog rollup.
    expect(screen.getByTestId("total-count").textContent).toBe(
      String(CATALOG.entry_count),
    );
  });

  it("task634 card is collapsible and surfaces lib/ui source links (task #640)", async () => {
    setupFetch({ task634: TASK634 });
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    await waitFor(() => screen.getByTestId("task634-card"));

    // Each entry with a `lib` field exposes it as a clickable link
    // pointing at the source path.
    for (const e of TASK634.entries) {
      if (e.lib) {
        const link = screen.getByTestId(`task634-lib-${e.id}`);
        expect(link.tagName).toBe("A");
        expect(link.getAttribute("href")).toBe(`/${e.lib}`);
        expect(link.textContent).toBe(e.lib);
      }
      if (e.ui) {
        const link = screen.getByTestId(`task634-ui-${e.id}`);
        expect(link.tagName).toBe("A");
        expect(link.getAttribute("href")).toBe(`/${e.ui}`);
        expect(link.textContent).toBe(e.ui);
      }
    }

    // Toggle button collapses the body, hiding the rows.
    const firstId = TASK634.entries[0].id;
    expect(screen.getByTestId(`task634-row-${firstId}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("task634-toggle"));
    expect(screen.queryByTestId(`task634-row-${firstId}`)).toBeNull();
    // Count badge stays visible while collapsed.
    expect(screen.getByTestId("task634-count").textContent).toContain(
      String(TASK634.entries.length),
    );
    // Re-expanding brings the rows back.
    fireEvent.click(screen.getByTestId("task634-toggle"));
    expect(screen.getByTestId(`task634-row-${firstId}`)).toBeTruthy();
  });

  it("does not render the task634 card when the fetch fails (task #640)", async () => {
    // Defensive: a 404 / network failure on the optional hand-curated
    // file must never blank out the main coverage tab and must not
    // render an empty competitor-parity card.
    setupFetch({ task634: null });
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    expect(screen.getByTestId("total-count").textContent).toBe(
      String(CATALOG.entry_count),
    );
    expect(screen.queryByTestId("task634-card")).toBeNull();
    for (const e of TASK634.entries) {
      expect(screen.queryByTestId(`task634-row-${e.id}`)).toBeNull();
    }
  });

  it("verify panel captures operator, VIN, notes and surfaces them on the badge + summary (task #643)", async () => {
    // Override fetch so we can capture the POST body the form sends and
    // simulate the server's authoritative response.
    const postBodies = [];
    global.fetch = vi.fn(async (url, init) => {
      if (typeof url === "string" && url.includes("/api/unlock-coverage/stats")) {
        return { ok: true, status: 200, json: async () => DEFAULT_DISPATCHER_STATS };
      }
      if (typeof url === "string" && url.includes("task634_entries.json")) {
        return { ok: true, status: 200, json: async () => TASK634 };
      }
      if (typeof url === "string" && url.includes("/api/task634-verifications")) {
        if (init && init.method === "POST") {
          const body = JSON.parse(init.body);
          postBodies.push(body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              verification: {
                entryId: body.entryId,
                vin: body.vin,
                notes: body.notes,
                operator: body.operator,
                verifiedAt: "2026-05-17T12:34:56.000Z",
              },
            }),
          };
        }
        // GET — start with nothing verified.
        return { ok: true, status: 200, json: async () => ({ verifications: [] }) };
      }
      return { ok: true, status: 200, json: async () => CATALOG };
    });

    const target = TASK634.entries[0];
    const entryId = target.id;

    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    fireEvent.click(screen.getByTestId(`toggle-task634_${entryId}`));

    // Initial state: button visible, no form, no summary.
    const openBtn = await screen.findByTestId(`verify-btn-${entryId}`);
    expect(openBtn.getAttribute("data-verified")).toBe("false");
    expect(screen.queryByTestId(`verify-form-${entryId}`)).toBeNull();

    // Open the form, type in metadata, save.
    fireEvent.click(openBtn);
    const opInput = await screen.findByTestId(`verify-operator-input-${entryId}`);
    const vinInput = screen.getByTestId(`verify-vin-input-${entryId}`);
    const notesInput = screen.getByTestId(`verify-notes-input-${entryId}`);
    fireEvent.change(opInput, { target: { value: "K. Pierce" } });
    fireEvent.change(vinInput, { target: { value: "2c3cdzc97kh123456" } });
    fireEvent.change(notesInput, { target: { value: "Demon, ran clean on second seed" } });

    fireEvent.click(screen.getByTestId(`verify-save-${entryId}`));

    // POST went out with the right body (VIN uppercased + stripped).
    await waitFor(() => expect(postBodies.length).toBe(1));
    expect(postBodies[0]).toMatchObject({
      entryId,
      operator: "K. Pierce",
      vin: "2C3CDZC97KH123456",
      notes: "Demon, ran clean on second seed",
    });
    expect(typeof postBodies[0].clientVerifiedAt).toBe("string");

    // Form closes, summary now surfaces operator + VIN + a formatted time.
    await waitFor(() => {
      expect(screen.queryByTestId(`verify-form-${entryId}`)).toBeNull();
      expect(screen.getByTestId(`verify-operator-${entryId}`).textContent).toBe("K. Pierce");
      expect(screen.getByTestId(`verify-vin-${entryId}`).textContent).toBe("2C3CDZC97KH123456");
      expect(screen.getByTestId(`verify-notes-${entryId}`).textContent).toMatch(
        /Demon, ran clean on second seed/,
      );
    });

    // Status badge in the row tooltip echoes the same provenance.
    const badge = screen
      .getByTestId(`task634-row-${entryId}`)
      .querySelector('[data-status="verified"]');
    expect(badge).toBeTruthy();
    const title = badge.getAttribute("title") || "";
    expect(title).toMatch(/K\. Pierce/);
    expect(title).toMatch(/2C3CDZC97KH123456/);
    expect(title).toMatch(/Demon, ran clean/);
  });

  it("verify form refuses to save without an operator name (task #643)", async () => {
    setupFetch({ task634: TASK634 });
    const entryId = TASK634.entries[0].id;
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    fireEvent.click(screen.getByTestId(`toggle-task634_${entryId}`));
    fireEvent.click(await screen.findByTestId(`verify-btn-${entryId}`));
    const saveBtn = await screen.findByTestId(`verify-save-${entryId}`);
    expect(saveBtn.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId(`verify-operator-input-${entryId}`), {
      target: { value: "tech-1" },
    });
    expect(
      screen.getByTestId(`verify-save-${entryId}`).hasAttribute("disabled"),
    ).toBe(false);
  });

  // Task #646 — single-screen audit log of every bench verification.
  describe("Verifications log (task #646)", () => {
    function setupFetchWithVerifications(verifications) {
      global.fetch = vi.fn(async (url) => {
        if (typeof url === "string" && url.includes("/api/task634-verifications")) {
          return { ok: true, status: 200, json: async () => ({ verifications }) };
        }
        if (typeof url === "string" && url.includes("/api/unlock-coverage/stats")) {
          return { ok: true, status: 200, json: async () => DEFAULT_DISPATCHER_STATS };
        }
        if (typeof url === "string" && url.includes("task634_entries.json")) {
          return { ok: true, status: 200, json: async () => TASK634 };
        }
        return { ok: true, status: 200, json: async () => CATALOG };
      });
    }

    it("renders empty-state copy when no verifications exist", async () => {
      render(<UnlockCoverageTab />);
      await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
      expect(screen.getByTestId("verifications-log-card")).toBeTruthy();
      expect(screen.getByTestId("verifications-log-empty")).toBeTruthy();
      expect(screen.getByTestId("verifications-log-export").hasAttribute("disabled")).toBe(true);
    });

    // Task #652 — banner reflects whether the rows came from the API or
    // the local cache, and offers a manual retry when the GET fails.
    it("shows a LIVE banner when the verifications GET succeeds", async () => {
      setupFetchWithVerifications([]);
      render(<UnlockCoverageTab />);
      const banner = await screen.findByTestId("verifications-log-source-banner");
      await waitFor(() => {
        expect(banner.getAttribute("data-source")).toBe("live");
      });
      expect(screen.getByTestId("verifications-log-source-label").textContent).toBe("LIVE");
      expect(screen.queryByTestId("verifications-log-source-retry")).toBeNull();
      expect(screen.getByTestId("verifications-log-source-refresh")).toBeTruthy();
    });

    it("shows an OFFLINE banner with retry when the GET fails, and recovers on retry", async () => {
      // Seed localStorage with a previous successful sync so the cached
      // audit log is non-empty even though the API is offline.
      const e0 = TASK634.entries[0].id;
      window.localStorage.setItem(
        "srtlab.task634.verified.v1",
        JSON.stringify([e0]),
      );
      window.localStorage.setItem(
        "srtlab.task634.verifications.v1",
        JSON.stringify({
          [e0]: {operator: "K. Pierce", vin: "VIN_AAA", notes: "cached row", verifiedAt: "2026-05-15T18:00:00.000Z"},
        }),
      );
      window.localStorage.setItem(
        "srtlab.task634.verifications.syncedAt.v1",
        "2026-05-15T18:00:00.000Z",
      );

      let call = 0;
      global.fetch = vi.fn(async (url) => {
        if (typeof url === "string" && url.includes("/api/task634-verifications")) {
          call += 1;
          if (call === 1) throw new Error("network down");
          return {ok: true, status: 200, json: async () => ({verifications: [
            {entryId: e0, operator: "K. Pierce", vin: "VIN_AAA", notes: "fresh", verifiedAt: "2026-05-18T10:00:00.000Z"},
          ]})};
        }
        if (typeof url === "string" && url.includes("/api/unlock-coverage/stats")) {
          return {ok: true, status: 200, json: async () => DEFAULT_DISPATCHER_STATS};
        }
        if (typeof url === "string" && url.includes("task634_entries.json")) {
          return {ok: true, status: 200, json: async () => TASK634};
        }
        return {ok: true, status: 200, json: async () => CATALOG};
      });

      render(<UnlockCoverageTab />);
      const banner = await screen.findByTestId("verifications-log-source-banner");
      await waitFor(() => {
        expect(banner.getAttribute("data-source")).toBe("cache");
      });
      expect(screen.getByTestId("verifications-log-source-label").textContent).toBe("OFFLINE");
      // Cached row is still shown so the bench operator can see history
      // even when the API is unreachable.
      expect(screen.getByTestId(`verifications-log-row-${e0}`)).toBeTruthy();
      // The banner must not promise behavior the code doesn't implement
      // (there is no deferred-write queue yet — see follow-up #663).
      const offlineMsg = screen.getByTestId("verifications-log-source-msg").textContent || "";
      expect(offlineMsg).not.toMatch(/queue|re-?sync|auto-?sync|automatically/i);
      expect(offlineMsg).toMatch(/device only/i);

      // Manual retry now succeeds and the banner flips to LIVE.
      fireEvent.click(screen.getByTestId("verifications-log-source-retry"));
      await waitFor(() => {
        expect(
          screen.getByTestId("verifications-log-source-banner").getAttribute("data-source"),
        ).toBe("live");
      });
    });

    it("lists rows sorted desc by verifiedAt and supports operator + VIN + notes filters", async () => {
      const e0 = TASK634.entries[0].id;
      const e1 = TASK634.entries[1].id;
      const e2 = TASK634.entries[2].id;
      setupFetchWithVerifications([
        { entryId: e0, operator: "K. Pierce", vin: "2C3CDZC97KH123456", notes: "Demon, clean", verifiedAt: "2026-05-15T18:00:00.000Z" },
        { entryId: e1, operator: "M. Wong",   vin: "1C4RJFAG7LC000000", notes: "Hellcat seed retry", verifiedAt: "2026-05-17T09:30:00.000Z" },
        { entryId: e2, operator: "K. Pierce", vin: "2C3CDZC97KH123456", notes: "Redeye, no issues", verifiedAt: "2026-05-10T12:00:00.000Z" },
      ]);
      render(<UnlockCoverageTab />);
      await waitFor(() => screen.getByTestId("verifications-log-table"));
      // Sorted desc by verifiedAt: e1 (May 17), e0 (May 15), e2 (May 10)
      const rows = screen.getAllByTestId(/^verifications-log-row-/);
      expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
        `verifications-log-row-${e1}`,
        `verifications-log-row-${e0}`,
        `verifications-log-row-${e2}`,
      ]);
      expect(screen.getByTestId("verifications-log-count").textContent).toBe("3 of 3");

      // Filter by operator
      fireEvent.change(screen.getByTestId("verifications-log-operator"), {
        target: { value: "K. Pierce" },
      });
      expect(screen.queryByTestId(`verifications-log-row-${e1}`)).toBeNull();
      expect(screen.getByTestId("verifications-log-count").textContent).toBe("2 of 3");

      // Add notes search
      fireEvent.change(screen.getByTestId("verifications-log-search"), {
        target: { value: "redeye" },
      });
      expect(screen.queryByTestId(`verifications-log-row-${e0}`)).toBeNull();
      expect(screen.getByTestId(`verifications-log-row-${e2}`)).toBeTruthy();

      // Clear restores everything
      fireEvent.click(screen.getByTestId("verifications-log-clear"));
      expect(screen.getAllByTestId(/^verifications-log-row-/).length).toBe(3);

      // VIN filter narrows down
      fireEvent.change(screen.getByTestId("verifications-log-vin"), {
        target: { value: "1C4RJFAG7LC000000" },
      });
      expect(screen.getAllByTestId(/^verifications-log-row-/).length).toBe(1);
      expect(screen.getByTestId(`verifications-log-row-${e1}`)).toBeTruthy();
    });

    it("filters by From/To date range and CLEAR resets the range", async () => {
      const e0 = TASK634.entries[0].id;
      const e1 = TASK634.entries[1].id;
      const e2 = TASK634.entries[2].id;
      setupFetchWithVerifications([
        { entryId: e0, operator: "K. Pierce", vin: "VIN_A", notes: "alpha", verifiedAt: "2026-05-15T18:00:00.000Z" },
        { entryId: e1, operator: "M. Wong",   vin: "VIN_B", notes: "beta",  verifiedAt: "2026-05-17T09:30:00.000Z" },
        { entryId: e2, operator: "K. Pierce", vin: "VIN_A", notes: "gamma", verifiedAt: "2026-05-10T12:00:00.000Z" },
      ]);
      render(<UnlockCoverageTab />);
      await waitFor(() => screen.getByTestId("verifications-log-table"));

      // From-only narrows to rows on/after the date
      fireEvent.change(screen.getByTestId("verifications-log-from"), {
        target: { value: "2026-05-15" },
      });
      expect(screen.queryByTestId(`verifications-log-row-${e2}`)).toBeNull();
      expect(screen.getByTestId(`verifications-log-row-${e0}`)).toBeTruthy();
      expect(screen.getByTestId(`verifications-log-row-${e1}`)).toBeTruthy();
      expect(screen.getByTestId("verifications-log-count").textContent).toBe("2 of 3");

      // Add To upper bound — inclusive on the same day
      fireEvent.change(screen.getByTestId("verifications-log-to"), {
        target: { value: "2026-05-15" },
      });
      expect(screen.getAllByTestId(/^verifications-log-row-/).length).toBe(1);
      expect(screen.getByTestId(`verifications-log-row-${e0}`)).toBeTruthy();

      // CLEAR resets date range alongside the other filters
      fireEvent.click(screen.getByTestId("verifications-log-clear"));
      expect(screen.getByTestId("verifications-log-from").value).toBe("");
      expect(screen.getByTestId("verifications-log-to").value).toBe("");
      expect(screen.getAllByTestId(/^verifications-log-row-/).length).toBe(3);
    });

    it("'Today' preset sets both From and To to today's local date", async () => {
      const e0 = TASK634.entries[0].id;
      setupFetchWithVerifications([
        { entryId: e0, operator: "K. Pierce", vin: "VIN_A", notes: "alpha", verifiedAt: "2026-05-15T18:00:00.000Z" },
      ]);
      render(<UnlockCoverageTab />);
      await waitFor(() => screen.getByTestId("verifications-log-table"));

      fireEvent.click(screen.getByTestId("verifications-log-preset-today"));
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, "0");
      const d = String(today.getDate()).padStart(2, "0");
      const ymd = `${y}-${m}-${d}`;
      expect(screen.getByTestId("verifications-log-from").value).toBe(ymd);
      expect(screen.getByTestId("verifications-log-to").value).toBe(ymd);
    });

    it("persists filters across remount and clears the stored payload on CLEAR (task #661)", async () => {
      const e0 = TASK634.entries[0].id;
      const e1 = TASK634.entries[1].id;
      setupFetchWithVerifications([
        { entryId: e0, operator: "K. Pierce", vin: "VIN_A", notes: "alpha", verifiedAt: "2026-05-15T18:00:00.000Z" },
        { entryId: e1, operator: "M. Wong",   vin: "VIN_B", notes: "beta",  verifiedAt: "2026-05-17T09:30:00.000Z" },
      ]);
      const KEY = "srtlab.task661.verificationsLogFilters.v1";

      const first = render(<UnlockCoverageTab />);
      await waitFor(() => screen.getByTestId("verifications-log-table"));

      fireEvent.change(screen.getByTestId("verifications-log-operator"), {
        target: { value: "M. Wong" },
      });
      fireEvent.change(screen.getByTestId("verifications-log-search"), {
        target: { value: "beta" },
      });
      fireEvent.change(screen.getByTestId("verifications-log-from"), {
        target: { value: "2026-05-16" },
      });
      fireEvent.change(screen.getByTestId("verifications-log-to"), {
        target: { value: "2026-05-18" },
      });

      // localStorage was updated synchronously through the effect.
      await waitFor(() => {
        const raw = window.localStorage.getItem(KEY);
        expect(raw).toBeTruthy();
        const v = JSON.parse(raw);
        expect(v.operatorFilter).toBe("M. Wong");
        expect(v.notesQ).toBe("beta");
        expect(v.fromDate).toBe("2026-05-16");
        expect(v.toDate).toBe("2026-05-18");
      });

      // Unmount + remount = simulates the user switching tabs or
      // reloading the page. The filter inputs come back populated.
      first.unmount();
      render(<UnlockCoverageTab />);
      await waitFor(() => screen.getByTestId("verifications-log-table"));
      expect(screen.getByTestId("verifications-log-operator").value).toBe("M. Wong");
      expect(screen.getByTestId("verifications-log-search").value).toBe("beta");
      expect(screen.getByTestId("verifications-log-from").value).toBe("2026-05-16");
      expect(screen.getByTestId("verifications-log-to").value).toBe("2026-05-18");

      // CLEAR drops every field and the stored payload follows.
      fireEvent.click(screen.getByTestId("verifications-log-clear"));
      await waitFor(() => {
        const v = JSON.parse(window.localStorage.getItem(KEY));
        expect(v).toEqual({
          operatorFilter: "all", vinFilter: "all", notesQ: "",
          fromDate: "", toDate: "",
        });
      });
    });

    it("CSV export honors the active date range", async () => {
      const e0 = TASK634.entries[0].id;
      const e1 = TASK634.entries[1].id;
      setupFetchWithVerifications([
        { entryId: e0, operator: "K. Pierce", vin: "VIN_A", notes: "alpha", verifiedAt: "2026-05-15T18:00:00.000Z" },
        { entryId: e1, operator: "M. Wong",   vin: "VIN_B", notes: "beta",  verifiedAt: "2026-05-17T09:30:00.000Z" },
      ]);
      let capturedBlob = null;
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn((blob) => { capturedBlob = blob; return "blob:mock"; });
      URL.revokeObjectURL = vi.fn();
      try {
        render(<UnlockCoverageTab />);
        await waitFor(() => screen.getByTestId("verifications-log-table"));
        fireEvent.change(screen.getByTestId("verifications-log-from"), {
          target: { value: "2026-05-16" },
        });
        fireEvent.click(screen.getByTestId("verifications-log-export"));
        expect(capturedBlob).toBeTruthy();
        const csv = await capturedBlob.text();
        const lines = csv.split("\r\n");
        expect(lines.length).toBe(2);
        expect(lines[1]).toContain("M. Wong");
        expect(lines[1]).not.toContain("K. Pierce");
      } finally {
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
      }
    });

    it("CSV export builds a blob whose contents honor the active filter", async () => {
      const e0 = TASK634.entries[0].id;
      const e1 = TASK634.entries[1].id;
      setupFetchWithVerifications([
        { entryId: e0, operator: "K. Pierce", vin: "VIN_AAA", notes: "alpha", verifiedAt: "2026-05-15T18:00:00.000Z" },
        { entryId: e1, operator: "M. Wong",   vin: "VIN_BBB", notes: 'has "quote" and,comma', verifiedAt: "2026-05-17T09:30:00.000Z" },
      ]);

      // Capture the Blob handed to URL.createObjectURL so we can assert on
      // the CSV body without round-tripping a real download.
      let capturedBlob = null;
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn((blob) => { capturedBlob = blob; return "blob:mock"; });
      URL.revokeObjectURL = vi.fn();

      try {
        render(<UnlockCoverageTab />);
        await waitFor(() => screen.getByTestId("verifications-log-table"));
        fireEvent.change(screen.getByTestId("verifications-log-operator"), {
          target: { value: "M. Wong" },
        });
        fireEvent.click(screen.getByTestId("verifications-log-export"));

        expect(capturedBlob).toBeTruthy();
        const csv = await capturedBlob.text();
        const lines = csv.split("\r\n");
        expect(lines[0]).toBe('"verifiedAt","operator","vin","capability","entryId","notes"');
        // Only M. Wong row remains after filter — and embedded quote is
        // doubled per RFC 4180.
        expect(lines.length).toBe(2);
        expect(lines[1]).toContain('"M. Wong"');
        expect(lines[1]).toContain('"VIN_BBB"');
        expect(lines[1]).toContain('"has ""quote"" and,comma"');
        expect(lines[1]).not.toContain("K. Pierce");
      } finally {
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
      }
    });
  });

  // Task #674 — side-by-side merge dialog for offline-vs-server conflicts.
  describe("Conflict merge dialog (task #674)", () => {
    // Helper: prime localStorage with a queued outbox op and an offline
    // banner, then return a fetch mock that serves a 409 on POST flush.
    function primeOutbox(entryId, payload, clientVerifiedAt) {
      window.localStorage.setItem(
        "srtlab.task634.outbox.v1",
        JSON.stringify([{
          id: "op_test_1",
          kind: "verify",
          entryId,
          payload,
          clientVerifiedAt,
          queuedAt: clientVerifiedAt,
        }]),
      );
    }
    function buildConflictFetch(entryId, {serverRow, postOk = null}) {
      let postCalls = 0;
      const fn = vi.fn(async (url, opts) => {
        if (typeof url === "string" && url.includes("/api/task634-verifications")) {
          const method = (opts && opts.method) || "GET";
          if (method === "GET") {
            return {ok: true, status: 200, json: async () => ({verifications: []})};
          }
          if (method === "POST") {
            postCalls += 1;
            if (postOk) {
              return {
                ok: true, status: 200,
                json: async () => ({ok: true, verification: postOk}),
              };
            }
            return {
              ok: false, status: 409,
              json: async () => ({
                error: "conflict",
                conflict: {
                  clientVerifiedAt: JSON.parse(opts.body).clientVerifiedAt,
                  server: serverRow,
                },
              }),
            };
          }
        }
        if (typeof url === "string" && url.includes("/api/unlock-coverage/stats")) {
          return {ok: true, status: 200, json: async () => DEFAULT_DISPATCHER_STATS};
        }
        if (typeof url === "string" && url.includes("task634_entries.json")) {
          return {ok: true, status: 200, json: async () => TASK634};
        }
        return {ok: true, status: 200, json: async () => CATALOG};
      });
      // Expose the call counter for assertions.
      fn.getPostCalls = () => postCalls;
      return fn;
    }

    it("REVIEW opens a dialog with side-by-side local vs server values", async () => {
      const entryId = TASK634.entries[0].id;
      primeOutbox(entryId, {operator: "K. Pierce", vin: "VINLOCAL", notes: "local note"}, "2026-05-18T10:00:00.000Z");
      global.fetch = buildConflictFetch(entryId, {
        serverRow: {entryId, operator: "M. Wong", vin: "VINSERVER", notes: "server note", verifiedAt: "2026-05-18T10:05:00.000Z"},
      });

      render(<UnlockCoverageTab />);
      await waitFor(() => screen.getByTestId(`verifications-log-conflict-review-${entryId}`), { timeout: 3000 });
      fireEvent.click(screen.getByTestId(`verifications-log-conflict-review-${entryId}`));

      const dialog = await screen.findByTestId("verifications-conflict-merge-dialog");
      expect(dialog).toBeTruthy();
      // Local cells render the queued payload; server cells render the row from the 409 response.
      expect(screen.getByTestId("verifications-conflict-merge-pick-operator-local").textContent).toContain("K. Pierce");
      expect(screen.getByTestId("verifications-conflict-merge-pick-operator-server").textContent).toContain("M. Wong");
      expect(screen.getByTestId("verifications-conflict-merge-pick-vin-local").textContent).toContain("VINLOCAL");
      expect(screen.getByTestId("verifications-conflict-merge-pick-vin-server").textContent).toContain("VINSERVER");
      expect(screen.getByTestId("verifications-conflict-merge-pick-notes-local").textContent).toContain("local note");
      expect(screen.getByTestId("verifications-conflict-merge-pick-notes-server").textContent).toContain("server note");
    });

    it("KEEP MINE & OVERWRITE re-POSTs the merged payload with a fresh clientVerifiedAt", async () => {
      const entryId = TASK634.entries[0].id;
      primeOutbox(entryId, {operator: "K. Pierce", vin: "VINLOCAL", notes: "local note"}, "2026-05-18T10:00:00.000Z");

      let lastBody = null;
      let phase = "conflict";
      const fn = vi.fn(async (url, opts) => {
        if (typeof url === "string" && url.includes("/api/task634-verifications")) {
          const method = (opts && opts.method) || "GET";
          if (method === "GET") {
            return {ok: true, status: 200, json: async () => ({verifications: []})};
          }
          if (method === "POST") {
            lastBody = JSON.parse(opts.body);
            if (phase === "conflict") {
              phase = "ok";
              return {
                ok: false, status: 409,
                json: async () => ({
                  conflict: {
                    clientVerifiedAt: lastBody.clientVerifiedAt,
                    server: {entryId, operator: "M. Wong", vin: "VINSERVER", notes: "server note", verifiedAt: "2026-05-18T10:05:00.000Z"},
                  },
                }),
              };
            }
            return {
              ok: true, status: 200,
              json: async () => ({ok: true, verification: {
                entryId, operator: lastBody.operator, vin: lastBody.vin, notes: lastBody.notes,
                verifiedAt: "2026-05-18T10:10:00.000Z",
              }}),
            };
          }
        }
        if (typeof url === "string" && url.includes("/api/unlock-coverage/stats")) {
          return {ok: true, status: 200, json: async () => DEFAULT_DISPATCHER_STATS};
        }
        if (typeof url === "string" && url.includes("task634_entries.json")) {
          return {ok: true, status: 200, json: async () => TASK634};
        }
        return {ok: true, status: 200, json: async () => CATALOG};
      });
      global.fetch = fn;

      render(<UnlockCoverageTab />);
      await waitFor(() => screen.getByTestId(`verifications-log-conflict-review-${entryId}`));
      fireEvent.click(screen.getByTestId(`verifications-log-conflict-review-${entryId}`));
      await screen.findByTestId("verifications-conflict-merge-dialog");

      // Flip VIN field to server, keep operator+notes local.
      fireEvent.click(screen.getByTestId("verifications-conflict-merge-pick-vin-server"));
      const firstClientVerifiedAt = lastBody?.clientVerifiedAt;
      fireEvent.click(screen.getByTestId("verifications-conflict-merge-keep-mine"));

      await waitFor(() => {
        expect(screen.queryByTestId("verifications-conflict-merge-dialog")).toBeNull();
      });
      // The follow-up POST must carry the merged payload + a strictly newer clientVerifiedAt.
      expect(lastBody.operator).toBe("K. Pierce");
      expect(lastBody.vin).toBe("VINSERVER");
      expect(lastBody.notes).toBe("local note");
      expect(lastBody.entryId).toBe(entryId);
      expect(typeof lastBody.clientVerifiedAt).toBe("string");
      expect(lastBody.clientVerifiedAt).not.toBe(firstClientVerifiedAt);
      // Conflict is cleared from the banner once the overwrite succeeds.
      expect(screen.queryByTestId(`verifications-log-conflict-${entryId}`)).toBeNull();
    });

    it("REVIEW ALL appears when 2+ conflicts queue, and walks through each", async () => {
      const e0 = TASK634.entries[0].id;
      const e1 = TASK634.entries[1].id;
      window.localStorage.setItem(
        "srtlab.task634.outbox.v1",
        JSON.stringify([
          {id: "op_1", kind: "verify", entryId: e0, payload: {operator: "K. Pierce", vin: null, notes: null}, clientVerifiedAt: "2026-05-18T10:00:00.000Z", queuedAt: "2026-05-18T10:00:00.000Z"},
          {id: "op_2", kind: "verify", entryId: e1, payload: {operator: "K. Pierce", vin: null, notes: null}, clientVerifiedAt: "2026-05-18T10:01:00.000Z", queuedAt: "2026-05-18T10:01:00.000Z"},
        ]),
      );
      global.fetch = vi.fn(async (url, opts) => {
        if (typeof url === "string" && url.includes("/api/task634-verifications")) {
          const method = (opts && opts.method) || "GET";
          if (method === "GET") return {ok: true, status: 200, json: async () => ({verifications: []})};
          if (method === "POST") {
            const body = JSON.parse(opts.body);
            return {
              ok: false, status: 409,
              json: async () => ({conflict: {
                clientVerifiedAt: body.clientVerifiedAt,
                server: {entryId: body.entryId, operator: "M. Wong", vin: "VINSRV", notes: "srv", verifiedAt: "2026-05-18T10:05:00.000Z"},
              }}),
            };
          }
        }
        if (typeof url === "string" && url.includes("/api/unlock-coverage/stats")) return {ok: true, status: 200, json: async () => DEFAULT_DISPATCHER_STATS};
        if (typeof url === "string" && url.includes("task634_entries.json")) return {ok: true, status: 200, json: async () => TASK634};
        return {ok: true, status: 200, json: async () => CATALOG};
      });

      render(<UnlockCoverageTab />);
      const reviewAll = await screen.findByTestId("verifications-log-conflicts-review-all");
      fireEvent.click(reviewAll);
      const dialog = await screen.findByTestId("verifications-conflict-merge-dialog");
      expect(dialog).toBeTruthy();
      // Bulk progress indicator + both bulk-resolve buttons are present.
      expect(screen.getByTestId("verifications-conflict-merge-bulk-progress").textContent).toMatch(/of 2/);
      expect(screen.getByTestId("verifications-conflict-merge-use-server-all")).toBeTruthy();
      expect(screen.getByTestId("verifications-conflict-merge-keep-mine-all")).toBeTruthy();

      // Click USE SERVER FOR ALL — both conflicts should clear and the dialog close.
      fireEvent.click(screen.getByTestId("verifications-conflict-merge-use-server-all"));
      await waitFor(() => {
        expect(screen.queryByTestId("verifications-conflict-merge-dialog")).toBeNull();
      });
      expect(screen.queryByTestId(`verifications-log-conflict-${e0}`)).toBeNull();
      expect(screen.queryByTestId(`verifications-log-conflict-${e1}`)).toBeNull();
    });
  });

  it("falls back to catalog counts when the dispatcher endpoint is unavailable", async () => {
    setupFetch({ stats: null });
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    // catalog counts are used and the source attribute reflects the fallback
    expect(screen.getByTestId("reversed-count").textContent).toBe(
      String(CATALOG.reversed_count),
    );
    expect(screen.getByTestId("total-count").textContent).toBe(
      String(CATALOG.entry_count),
    );
    expect(
      screen.getByTestId("coverage-header").getAttribute("data-stats-source"),
    ).toBe("catalog");
    if (
      CATALOG.dll_only_count === 0 &&
      CATALOG.reversed_count === CATALOG.entry_count &&
      CATALOG.entry_count > 0
    ) {
      const banner = screen.getByTestId("all-native-banner");
      expect(banner.getAttribute("data-stats-source")).toBe("catalog");
      expect(screen.getByTestId("stats-source").textContent).toMatch(
        /catalog \(dispatcher offline/,
      );
    }
  });
});
