// @vitest-environment jsdom
//
// Locks the Connection Guides row inside the Mismatch Wizard (Task #468).
// The row also lives at the top of the Module Sync workspace (#464); when
// the tech opens the wizard the same row must surface inside the modal so
// they can pick the right programmer BEFORE they wire anything up. Both
// the link count (driven by MODULE_CONNECTION_GUIDES) and the popup
// hardening (target="_blank" + rel="noopener noreferrer") are pinned here
// the same way moduleSyncGuidesAndReset.ui.test.jsx pins them on the tab
// — if a future refactor of MismatchWizard.jsx quietly drops the row or
// loosens the rel pair, this test fails loudly.

import React from "react";
import { describe, it, afterEach, beforeEach, expect } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

import MismatchWizard from "../components/MismatchWizard.jsx";
import { MODULE_CONNECTION_GUIDES, PROGRAMMERS } from "../lib/programmerData.js";

afterEach(() => cleanup());

beforeEach(() => {
  /* The wizard's Advanced toggle persists via loadAdvanced/saveAdvanced
   * (localStorage). Clear it between tests so the row-visibility cases
   * always start from the canonical "simple" default and don't bleed
   * state from a prior test that flipped the toggle. */
  try { localStorage.clear(); } catch {}
});

/* Advanced mode mounts ChatPanel, which auto-scrolls via
 * `bottomRef.current.scrollIntoView({ behavior: 'smooth' })` on every
 * messages update. jsdom doesn't ship that DOM method, so we stub it on
 * the prototype to keep the effect from throwing during the
 * Final-Checklist visibility walk. */
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}

function renderWizard(overrides = {}) {
  return render(
    <MismatchWizard
      issues={[]}
      warnings={[]}
      modules={[]}
      hexSnippets={[]}
      stepActions={[]}
      onClose={() => {}}
      onAction={() => {}}
      {...overrides}
    />
  );
}

describe("MismatchWizard — Connection Guides anchors (Task #468)", () => {
  it("renders one anchor per (module, programmer) pair from MODULE_CONNECTION_GUIDES", () => {
    renderWizard();
    const row = screen.getByTestId("wizard-connection-guides");
    /* Total expected = sum of guides across all modules. For the LX path
     * the registry stamps BCM=2, PCM=1, RFH=3 → 6 anchors. Computing the
     * expected count from the registry (not hard-coding 6) keeps the
     * lock useful when a new programmer is added later — the workspace
     * row's test does the same. */
    const expectedCount = MODULE_CONNECTION_GUIDES.reduce(
      (sum, g) => sum + g.guides.length, 0
    );
    expect(expectedCount).toBe(6); /* sanity-check the LX baseline */
    const anchors = row.querySelectorAll("a");
    expect(anchors.length).toBe(expectedCount);
  });

  it("opens every guide link in a new tab with the noopener+noreferrer rel pair", () => {
    renderWizard();
    const row = screen.getByTestId("wizard-connection-guides");
    const anchors = row.querySelectorAll("a");
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute("target")).toBe("_blank");
      const rel = (a.getAttribute("rel") || "").split(/\s+/);
      /* Both tokens are required — `noopener` alone still leaks the
       * Referer header to the bench-tool vendor's site, and `noreferrer`
       * implies noopener in modern browsers but the explicit pair is
       * the convention the rest of the codebase follows. */
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
    }
  });

  it("renders the same per-module rows as the Module Sync workspace, with vendor URLs and labels intact", () => {
    renderWizard();
    /* Per-module sub-rows must exist — keys mirror the workspace row's
     * `modsync-guides-<module>` testids so future registry additions
     * automatically extend both surfaces in lock-step. */
    for (const group of MODULE_CONNECTION_GUIDES) {
      const sub = screen.getByTestId(`wizard-guides-${group.module.toLowerCase()}`);
      expect(sub).toBeTruthy();
      for (const g of group.guides) {
        const anchor = screen.getByTestId(
          `wizard-guide-link-${group.module.toLowerCase()}-${g.programmer.toLowerCase()}`
        );
        expect(anchor.getAttribute("href")).toBe(g.url);
        expect(anchor.textContent).toBe(PROGRAMMERS[g.programmer].label);
      }
    }
  });

  it("hides the Connection Guides row on the post-action Final Checklist (Advanced mode)", () => {
    /* Pass a real issue so the wizard has at least one resolution step
     * — without it the Advanced flow short-circuits past 'steps' and
     * the View-Checklist button never gates correctly. */
    renderWizard({ issues: ["VIN MISMATCH between BCM and RFHUB"], modules: ["BCM", "RFHUB"] });

    /* Default Simple flow: row is visible. */
    expect(screen.getByTestId("wizard-connection-guides")).toBeTruthy();

    /* Flip to Advanced — still in 'summary' phase, row stays visible
     * because the tech is about to pick a tool. */
    const toggle = screen.getByTestId("wizard-advanced-toggle").querySelector("input");
    act(() => { fireEvent.click(toggle); });
    expect(screen.getByTestId("wizard-connection-guides")).toBeTruthy();

    /* Walk Summary → Steps via the SummaryScreen's "START WIZARD →"
     * button. */
    const startBtn = screen.getByRole("button", { name: /START WIZARD/i });
    act(() => { fireEvent.click(startBtn); });
    expect(screen.getByTestId("wizard-connection-guides")).toBeTruthy();

    /* Walk Steps → Final via "View Checklist". With a single-issue
     * fixture there's only one step, so the next-button is the
     * checklist trigger directly. */
    const finalBtn = screen.getByRole("button", { name: /View Checklist/i });
    act(() => { fireEvent.click(finalBtn); });

    /* Final phase: the row must be gone — the tech has already flashed
     * and no longer needs to pick a programmer. */
    expect(screen.queryByTestId("wizard-connection-guides")).toBeNull();
  });
});
