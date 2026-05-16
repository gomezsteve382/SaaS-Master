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

  it("merges task634_entries.json on top of the generated catalog (task #635)", async () => {
    // Smoke test: with the hand-curated task-634 file fetched alongside
    // the generated catalog, every task-634 entry must surface as its
    // own table row AND the canonical catalog rows must still render —
    // i.e. the merge is additive, not a replacement.
    setupFetch({ task634: TASK634 });
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    // One row per hand-curated entry, tagged with the TASK 634 chip.
    expect(TASK634.entries.length).toBeGreaterThan(0);
    await waitFor(() => {
      for (const e of TASK634.entries) {
        const row = screen.getByTestId(`row-task634_${e.id}`);
        expect(row).toBeTruthy();
        expect(row.getAttribute("data-provenance")).toBe("task-634");
      }
    });
    expect(
      screen.getByTestId(`provenance-chip-task634_${TASK634.entries[0].id}`),
    ).toBeTruthy();

    // Canonical catalog row is still there — additive merge, not a swap.
    const canonical = CATALOG.entries[0];
    expect(screen.getByTestId(`row-${canonical.module}`)).toBeTruthy();

    // Total merged count = canonical + task-634 (no asset-sweep delta in
    // the test mock since the extended catalog mock returns the
    // canonical catalog, which fails the {entries, uds} shape check).
    const expectedTotal = CATALOG.entries.length + TASK634.entries.length;
    // "Showing X of Y entries" — Y is in a separate text node from the
    // surrounding chrome because filtered.length is wrapped in <strong>,
    // so match against the combined textContent of the counter line.
    const counter = screen.getByText(/of\s+\d+\s+entries/i);
    expect(counter.textContent.replace(/\s+/g, " ")).toContain(
      `of ${expectedTotal} entries`,
    );
  });

  it("task-634 entries are filterable by family and search (task #635)", async () => {
    setupFetch({ task634: TASK634 });
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));

    // Family dropdown should expose every task634_<category> bucket.
    const familySelect = screen.getByTestId("family-filter");
    const familyOptions = Array.from(familySelect.querySelectorAll("option")).map(
      (o) => o.getAttribute("value"),
    );
    for (const e of TASK634.entries) {
      const expected = e.category ? `task634_${e.category}` : "task634";
      expect(familyOptions).toContain(expected);
    }

    // Search picks up the label text from a hand-curated entry.
    const labelTarget = TASK634.entries.find((e) => e.label);
    fireEvent.change(screen.getByTestId("catalog-search"), {
      target: { value: labelTarget.label.slice(0, 8) },
    });
    await waitFor(() => {
      expect(screen.getByTestId(`row-task634_${labelTarget.id}`)).toBeTruthy();
    });

    // The expanded row surfaces the synthesized "lib:" pointer so a
    // bench operator can jump straight to the implementation file.
    fireEvent.click(screen.getByTestId(`toggle-task634_${labelTarget.id}`));
    if (labelTarget.lib) {
      expect(
        await screen.findByText(new RegExp(labelTarget.lib.replace(/\//g, "\\/"))),
      ).toBeTruthy();
    }
  });

  it("ignores task634 fetch failures without breaking the canonical catalog (task #635)", async () => {
    // Defensive: a 404 / network failure on the optional hand-curated
    // file must never blank out the main coverage tab.
    setupFetch({ task634: null });
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    expect(screen.getByTestId("total-count").textContent).toBe(
      String(CATALOG.entry_count),
    );
    // No task634 rows surfaced.
    expect(screen.queryByTestId(`row-task634_${TASK634.entries[0].id}`)).toBeNull();
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
