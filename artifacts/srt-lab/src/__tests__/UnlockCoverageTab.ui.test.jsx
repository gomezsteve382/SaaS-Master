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

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(__dirname, "..", "..", "public", "unlock_catalog.json");
const CATALOG_RAW = readFileSync(CATALOG_PATH, "utf8");
const CATALOG = JSON.parse(CATALOG_RAW);

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

function setupFetch({ catalog = CATALOG, stats = DEFAULT_DISPATCHER_STATS } = {}) {
  global.fetch = vi.fn(async (url) => {
    if (typeof url === "string" && url.includes("/api/unlock-coverage/stats")) {
      if (stats === null) {
        return { ok: false, status: 503, json: async () => ({ error: "x" }) };
      }
      return { ok: true, status: 200, json: async () => stats };
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

  it("expanding a reversed row also surfaces the algorithm tag in details", async () => {
    render(<UnlockCoverageTab />);
    await waitFor(() => screen.getByTestId("unlock-coverage-tab"));
    const e = CATALOG.entries.find((x) => x.status === "reversed" && x.algorithm);
    expect(e).toBeTruthy();
    fireEvent.click(screen.getByTestId(`toggle-${e.module}`));
    const detail = await screen.findByTestId(`algo-detail-${e.module}`);
    // Raw tag shown in muted parens alongside the friendly label
    expect(detail.textContent).toContain(e.algorithm);
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
