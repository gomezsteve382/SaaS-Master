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

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => CATALOG,
  }));
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
    const select = screen.getByTestId("status-filter");
    fireEvent.change(select, { target: { value: "reversed" } });
    const reversed = CATALOG.entries.filter((e) => e.status === "reversed");
    const dllOnly = CATALOG.entries.filter((e) => e.status === "dll_only");
    expect(reversed.length).toBeGreaterThan(0);
    // a reversed-status row stays
    expect(screen.queryByTestId(`row-${reversed[0].module}`)).toBeTruthy();
    // a dll_only-status row, if any exist, is filtered away
    if (dllOnly.length > 0) {
      expect(screen.queryByTestId(`row-${dllOnly[0].module}`)).toBeNull();
    }
  });

  it("expanding a dll_only row shows its reason", async () => {
    const dllOnly = CATALOG.entries.find((e) => e.status === "dll_only");
    if (!dllOnly) {
      // Catalog is fully reversed (no dll_only entries) — nothing to expand.
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
});
