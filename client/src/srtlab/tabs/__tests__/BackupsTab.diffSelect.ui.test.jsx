// @vitest-environment jsdom
//
/* BackupsTab.diffSelect.ui.test.jsx
 *
 * UI smoke tests for the multi-select → diff flow:
 *
 *  Part 1 — AnalysisDiffView render tests
 *    Renders the diff view component directly (minimal deps), covering:
 *    metadata panel, field table, byte regions, programmer block copy
 *    button, and close button.
 *
 *  Part 2 — Two-selection cap logic (isolated stub)
 *    A minimal SelectionController stub that mirrors the Set-based
 *    diffSelection state from BackupsTab, verifying:
 *      – max-2 cap
 *      – Diff button only appears when size === 2
 *      – deselect clears the cap
 */

import React, { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { compareAnalyses, buildProgrammerBlock } from "../../lib/analysisDiff.js";
import AnalysisDiffView from "../AnalysisDiffView.jsx";

afterEach(cleanup);

/* ── Stubs for AnalysisDiffView's only dep: constants.js ─────────────── */
vi.mock("../../lib/constants.js", () => ({
  C: {
    bg: "#F4F1EC", bd: "#E0DDD6", ts: "#1A1A1A", tm: "#666666",
    a1: "#D32F2F", a2: "#B71C1C", a3: "#2979FF", tx: "#1A1A1A",
  },
}));

/* ── Fixture helpers ─────────────────────────────────────────────────── */

const VIN_DID    = 61840;
const SEC16_DID  = 20360;

function makeBackup(suffix, module = "BCM") {
  return {
    module,
    vin: `1C4RJFLG5JC2000${suffix}`,
    timestamp: new Date(2024, 0, 1).toISOString(),
    dids: {
      [VIN_DID]:   { hex: `31 43 34 ${suffix}`, ascii: `1C4${suffix}`, name: "VIN",   critical: true, missing: false },
      [SEC16_DID]: { hex: `AA BB CC ${suffix}`,  ascii: null,           name: "SEC16", critical: true, missing: false },
    },
  };
}

const BACKUP_A    = makeBackup("11");
const BACKUP_B    = makeBackup("22");
const DIFF_RESULT = compareAnalyses(BACKUP_A, BACKUP_B);
const SAME_RESULT = compareAnalyses(BACKUP_A, BACKUP_A);

/* ══════════════════════════════════════════════════════════════════════
 * Part 1 — AnalysisDiffView rendering
 * ══════════════════════════════════════════════════════════════════════ */

describe("AnalysisDiffView component", () => {
  it("renders without crashing when given a diff result", () => {
    render(<AnalysisDiffView diffResult={DIFF_RESULT} backupA={BACKUP_A} backupB={BACKUP_B} />);
    expect(screen.getByTestId("analysis-diff-view")).toBeTruthy();
  });

  it("renders loading state when diffResult is null", () => {
    render(<AnalysisDiffView diffResult={null} backupA={BACKUP_A} backupB={BACKUP_B} />);
    expect(screen.queryByTestId("analysis-diff-view")).toBeNull();
    expect(document.body.textContent).toContain("Computing diff");
  });

  it("shows the ANALYSIS DIFF header", () => {
    render(<AnalysisDiffView diffResult={DIFF_RESULT} backupA={BACKUP_A} backupB={BACKUP_B} />);
    expect(document.body.textContent).toContain("ANALYSIS DIFF");
  });

  it("shows SNAPSHOT A and SNAPSHOT B labels", () => {
    render(<AnalysisDiffView diffResult={DIFF_RESULT} backupA={BACKUP_A} backupB={BACKUP_B} />);
    expect(document.body.textContent).toContain("SNAPSHOT A");
    expect(document.body.textContent).toContain("SNAPSHOT B");
  });

  it("shows ANALYSIS METADATA panel with named fields", () => {
    render(<AnalysisDiffView diffResult={DIFF_RESULT} backupA={BACKUP_A} backupB={BACKUP_B} />);
    expect(document.body.textContent).toContain("ANALYSIS METADATA");
  });

  it("shows differing field table when there are differences", () => {
    render(<AnalysisDiffView diffResult={DIFF_RESULT} backupA={BACKUP_A} backupB={BACKUP_B} />);
    expect(screen.getByTestId("diff-field-table")).toBeTruthy();
  });

  it("shows programmer block copy button when fields differ", () => {
    render(<AnalysisDiffView diffResult={DIFF_RESULT} backupA={BACKUP_A} backupB={BACKUP_B} />);
    expect(screen.getByTestId("copy-programmer-block")).toBeTruthy();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<AnalysisDiffView diffResult={DIFF_RESULT} backupA={BACKUP_A} backupB={BACKUP_B} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("analysis-diff-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders BYTE REGIONS tab content when switched", () => {
    render(<AnalysisDiffView diffResult={DIFF_RESULT} backupA={BACKUP_A} backupB={BACKUP_B} />);
    const regionsBtn = screen.getAllByRole("button").find((b) => b.textContent.includes("BYTE REGIONS"));
    expect(regionsBtn).toBeTruthy();
    fireEvent.click(regionsBtn);
    expect(screen.getByTestId("diff-regions")).toBeTruthy();
  });

  it("shows 'Identical' badge and no copy button when snapshots match", () => {
    render(<AnalysisDiffView diffResult={SAME_RESULT} backupA={BACKUP_A} backupB={BACKUP_A} />);
    expect(document.body.textContent).toContain("Identical");
    expect(screen.queryByTestId("copy-programmer-block")).toBeNull();
  });

  it("programmer block rows have type: 'uds_did_write'", () => {
    const block = buildProgrammerBlock(DIFF_RESULT);
    expect(block.length).toBeGreaterThan(0);
    block.forEach((row) => {
      expect(row.type).toBe("uds_did_write");
    });
  });

  /* ── Regression: raw-region hex tokenization (spaced hex strings) ──
   * compareRawBytes produces space-separated hex strings ("AA BB CC").
   * RawByteRegionRow must split on whitespace — NOT /.{2}/g which
   * produces corrupted tokens ("AA", " B", "B ", "CC") when spaces
   * are present.  This test asserts the correct cell values render. */
  it("RAW BINARY tab renders space-separated hex tokens as correct byte cells", () => {
    /* Build a synthetic diffResult carrying rawByteRegions with spaced hex. */
    const rawResult = {
      ...DIFF_RESULT,
      rawByteRegions: [
        {
          offset:     0,
          offsetHex:  "0x000000",
          length:     3,
          aHex:       "AA BB CC",
          bHex:       "11 22 33",
          diffIndices: [0, 1, 2],
        },
      ],
      summary: {
        ...DIFF_RESULT.summary,
        hasRawDiff:       true,
        totalRawDiffBytes: 3,
      },
    };

    render(<AnalysisDiffView diffResult={rawResult} backupA={BACKUP_A} backupB={BACKUP_B} />);

    /* Switch to the RAW BINARY tab. */
    const rawBtn = screen.getAllByRole("button").find((b) => b.textContent.includes("RAW BINARY"));
    expect(rawBtn).toBeTruthy();
    fireEvent.click(rawBtn);

    /* The raw binary panel should be visible. */
    expect(screen.getByTestId("diff-raw-binary")).toBeTruthy();
    expect(screen.getByTestId("diff-raw-region-list")).toBeTruthy();

    /* Assert correct tokenization within the region list only.
     * We scope to diff-raw-region-list to avoid false positives from
     * header text like "RAW BINARY" which itself contains " B". */
    const regionList = screen.getByTestId("diff-raw-region-list");
    const regionText = regionList.textContent;

    /* Correct byte values must appear. */
    expect(regionText).toContain("AA");
    expect(regionText).toContain("BB");
    expect(regionText).toContain("CC");
    expect(regionText).toContain("11");
    expect(regionText).toContain("22");
    expect(regionText).toContain("33");

    /* The old /.{2}/g bug on "AA BB CC" produces " B" and "B " as tokens.
     * The span textContent would concatenate them as "AA B B CC".
     * The correct split(/\s+/) produces "AA" "BB" "CC" → "AABBCC" (no spaces).
     * Confirm the rendered byte sequence is tightly packed (no space-between-char noise). */
    const aBytes = regionList.querySelectorAll("span[title]");
    const titles  = [...aBytes].map((s) => s.title);
    /* Every title should be of the form "File offset 0xNNN" — no corrupt token like " B". */
    titles.forEach((t) => {
      expect(t).toMatch(/^File offset 0x[0-9A-F]+$/i);
    });
    /* The byte value displayed in each span should be exactly 2 hex chars. */
    const byteVals = [...aBytes].map((s) => s.textContent.trim());
    byteVals.forEach((v) => {
      expect(v).toMatch(/^[0-9A-Fa-f]{2}$/);
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * Part 2 — Two-selection cap logic (isolated stub)
 * ══════════════════════════════════════════════════════════════════════ */

/** Minimal component mirroring BackupsTab's diffSelection Set-based state. */
function SelectionController({ items }) {
  const [selection, setSelection] = useState(new Set());

  const toggle = (key) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else if (next.size < 2) {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div>
      {items.map((item) => (
        <div key={item}>
          <input
            type="checkbox"
            data-testid={"cb-" + item}
            checked={selection.has(item)}
            disabled={selection.size >= 2 && !selection.has(item)}
            onChange={() => toggle(item)}
          />
          <label>{item}</label>
        </div>
      ))}
      {selection.size === 2 && (
        <button data-testid="diff-btn">Diff ({selection.size}/2)</button>
      )}
      {selection.size > 0 && selection.size < 2 && (
        <span data-testid="select-hint">Select {2 - selection.size} more</span>
      )}
    </div>
  );
}

const ITEMS = ["backup-1", "backup-2", "backup-3"];

describe("multi-select two-selection cap (BackupsTab diffSelection logic)", () => {
  it("nothing selected initially — Diff button absent", () => {
    render(<SelectionController items={ITEMS} />);
    expect(screen.queryByTestId("diff-btn")).toBeNull();
  });

  it("after selecting one — shows hint, Diff still absent", () => {
    render(<SelectionController items={ITEMS} />);
    fireEvent.click(screen.getByTestId("cb-backup-1"));
    expect(screen.queryByTestId("select-hint")).not.toBeNull();
    expect(screen.queryByTestId("diff-btn")).toBeNull();
  });

  it("after selecting two — Diff button appears", () => {
    render(<SelectionController items={ITEMS} />);
    fireEvent.click(screen.getByTestId("cb-backup-1"));
    fireEvent.click(screen.getByTestId("cb-backup-2"));
    expect(screen.getByTestId("diff-btn")).toBeTruthy();
    expect(screen.getByTestId("diff-btn").textContent).toContain("2/2");
  });

  it("third checkbox is disabled once two are selected", () => {
    render(<SelectionController items={ITEMS} />);
    fireEvent.click(screen.getByTestId("cb-backup-1"));
    fireEvent.click(screen.getByTestId("cb-backup-2"));
    expect(screen.getByTestId("cb-backup-3").disabled).toBe(true);
  });

  it("deselecting one re-enables further selection", () => {
    render(<SelectionController items={ITEMS} />);
    fireEvent.click(screen.getByTestId("cb-backup-1"));
    fireEvent.click(screen.getByTestId("cb-backup-2"));
    fireEvent.click(screen.getByTestId("cb-backup-2")); // deselect
    expect(screen.getByTestId("cb-backup-3").disabled).toBe(false);
    expect(screen.queryByTestId("diff-btn")).toBeNull();
  });

  it("cannot exceed 2 selections — third click has no effect", () => {
    render(<SelectionController items={ITEMS} />);
    fireEvent.click(screen.getByTestId("cb-backup-1"));
    fireEvent.click(screen.getByTestId("cb-backup-2"));
    fireEvent.click(screen.getByTestId("cb-backup-3")); // disabled — no effect
    expect(screen.getByTestId("diff-btn").textContent).toContain("2/2");
    expect(screen.getByTestId("cb-backup-3").checked).toBe(false);
  });
});
