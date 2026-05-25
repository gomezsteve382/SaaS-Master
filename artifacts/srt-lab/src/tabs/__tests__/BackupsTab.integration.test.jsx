// @vitest-environment jsdom
//
/* BackupsTab.integration.test.jsx
 *
 * Integration smoke tests for the real BackupsTab component with all
 * external dependencies stubbed.  Verifies the complete multi-select
 * → Diff flow end-to-end:
 *
 *   1. Backup list renders both entries returned by getBackupList()
 *   2. Selecting one entry shows the "N more needed" hint
 *   3. Selecting two entries enables the Diff button
 *   4. Clicking Diff calls getBackupAsync for both selected keys
 *   5. compareAnalyses runs and AnalysisDiffView renders in the DOM
 *   6. The diff view's onClose callback dismisses it
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import React from "react";

/* ──────────────────────────────────────────────────────────────────────
 * FIXTURE DATA
 * Declared first so the vi.mock factories below can close over them.
 * ────────────────────────────────────────────────────────────────────── */

const KEY_1 = "backup_BCM_1AAAVVVVVVVVVVVVV_1000";
const KEY_2 = "backup_BCM_1BBBVVVVVVVVVVVVV_2000";

const META_1 = {
  key: KEY_1, id: KEY_1, module: "BCM", vin: "1AAAVVVVVVVVVVVVV",
  timestamp: new Date("2024-01-15T10:00:00Z").toISOString(),
  didCount: 2, tx: "7B0", rx: "7B8", checksum: null, snapshotKind: "pre-write",
};
const META_2 = {
  key: KEY_2, id: KEY_2, module: "BCM", vin: "1BBBVVVVVVVVVVVVV",
  timestamp: new Date("2024-02-20T10:00:00Z").toISOString(),
  didCount: 2, tx: "7B0", rx: "7B8", checksum: null, snapshotKind: "post-write",
};

const FULL_1 = {
  ...META_1,
  dids: {
    61840: { name: "VIN",   hex: "41 41 41 41", ascii: "AAAA", critical: true,  missing: false, bytes: [0x41, 0x41, 0x41, 0x41] },
    20360: { name: "SEC16", hex: "AA BB CC 11", ascii: "",     critical: true,  missing: false, bytes: [0xAA, 0xBB, 0xCC, 0x11] },
  },
};
const FULL_2 = {
  ...META_2,
  dids: {
    61840: { name: "VIN",   hex: "42 42 42 42", ascii: "BBBB", critical: true,  missing: false, bytes: [0x42, 0x42, 0x42, 0x42] },
    20360: { name: "SEC16", hex: "AA BB CC 22", ascii: "",     critical: true,  missing: false, bytes: [0xAA, 0xBB, 0xCC, 0x22] },
  },
};

/* ──────────────────────────────────────────────────────────────────────
 * MOCKS — all vi.mock calls are hoisted before imports by Vitest.
 * Factories close over the module-level fixtures above which are
 * initialised by the time any factory is actually invoked.
 * ────────────────────────────────────────────────────────────────────── */

vi.mock("../../lib/audit.js", () => ({
  getBackupList: vi.fn(() => [META_1, META_2]),
  getBackup: vi.fn(() => null),
  getBackupAsync: vi.fn(async (key) => {
    if (key === KEY_1) return FULL_1;
    if (key === KEY_2) return FULL_2;
    return null;
  }),
  deleteBackup: vi.fn(),
  clearBackups: vi.fn(),
  restoreModule: vi.fn(),
  subscribeAudit: vi.fn(() => () => {}),
  refreshBackupsFromServer: vi.fn(async () => []),
  getBackupStorageUsage: vi.fn(() => ({ used: 0, quota: 5_000_000, count: 2, percent: 0, max: 50 })),
  pruneNonCriticalBackups: vi.fn(() => ({ prunedCount: 0, freedBytes: 0 })),
  subscribeToast: vi.fn(() => () => {}),
  formatBytes: vi.fn((n) => n + "B"),
  BACKUP_WARN_PERCENT: 70,
  exportAllBackups: vi.fn(() => ({ count: 0, json: "{}" })),
  importBackups: vi.fn(),
  saveAemtPlaceholders: vi.fn(),
  encryptArchive: vi.fn(async (a) => a),
  decryptArchive: vi.fn(async (a) => a),
  ENCRYPTED_ARCHIVE_TYPE: "srtlab-encrypted-backup",
}));

vi.mock("../../lib/diffReports.js", () => ({
  listDiffReports: vi.fn(() => []),
  getDiffReport: vi.fn(() => null),
  getDiffReportAsync: vi.fn(async () => null),
  deleteDiffReport: vi.fn(),
  clearDiffReports: vi.fn(),
  subscribeDiffReports: vi.fn(() => () => {}),
  exportDiffReportPDF: vi.fn(),
  fmtScanStamp: vi.fn(() => ""),
  refreshDiffReportsFromServer: vi.fn(async () => []),
  fetchDiffReportStats: vi.fn(async () => null),
  exportAllDiffReports: vi.fn(() => ({ count: 0 })),
  importDiffReports: vi.fn(),
}));

vi.mock("../../lib/obdEngine.js", () => ({
  createObdEngine: vi.fn(() => ({
    connect: vi.fn(async () => true),
    disconnect: vi.fn(async () => {}),
    uds: vi.fn(async () => ({ ok: false, error: "stub" })),
  })),
}));

vi.mock("../../lib/checksum.js", () => ({
  sha256Hex: vi.fn(async () => "cafebabe00"),
  backupDidsToBytes: vi.fn(() => new Uint8Array([])),
}));

vi.mock("../../lib/readFirstModal.jsx", () => ({ default: () => null }));
vi.mock("../../components/LeakScanPanel.jsx", () => ({ default: () => null }));
vi.mock("../../lib/VinChargerSubtitle.jsx", () => ({ default: () => null }));
vi.mock("../../components/AemtImportModal.jsx", () => ({ default: () => null }));

vi.mock("../../lib/aemtImporter.js", () => ({
  importAemtBundle: vi.fn(),
  AemtImportError: class AemtImportError extends Error {},
}));
vi.mock("../../lib/keyProgPresets.js", () => ({ saveRawPreset: vi.fn() }));
vi.mock("../../lib/dids.js", () => ({ getDidDescription: vi.fn(() => null) }));

/* ── Component under test — imported AFTER vi.mock declarations ── */
import BackupsTab from "../BackupsTab.jsx";

afterEach(cleanup);

/* ──────────────────────────────────────────────────────────────────────
 * HELPERS
 * ────────────────────────────────────────────────────────────────────── */

async function renderTab() {
  let utils;
  await act(async () => { utils = render(<BackupsTab />); });
  return utils;
}

async function selectBothAndDiff() {
  await renderTab();
  fireEvent.click(screen.getByTestId(`diff-checkbox-${KEY_1}`));
  fireEvent.click(screen.getByTestId(`diff-checkbox-${KEY_2}`));
  const diffBtn = screen.getByTestId("diff-selected-btn");
  await act(async () => { fireEvent.click(diffBtn); });
}

/* ──────────────────────────────────────────────────────────────────────
 * TESTS
 * ────────────────────────────────────────────────────────────────────── */

describe("BackupsTab integration — backup list rendering", () => {
  it("renders the module name for each backup from getBackupList()", async () => {
    await renderTab();
    const bcmNodes = screen.getAllByText("BCM");
    expect(bcmNodes.length).toBeGreaterThanOrEqual(2);
  });

  it("renders a diff checkbox for each backup row", async () => {
    await renderTab();
    expect(screen.getByTestId(`diff-checkbox-${KEY_1}`)).toBeTruthy();
    expect(screen.getByTestId(`diff-checkbox-${KEY_2}`)).toBeTruthy();
  });

  it("no Diff button visible when nothing is selected", async () => {
    await renderTab();
    expect(screen.queryByTestId("diff-selected-btn")).toBeNull();
  });
});

describe("BackupsTab integration — two-selection → Diff flow", () => {
  it("selecting one backup shows the hint banner", async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId(`diff-checkbox-${KEY_1}`));
    expect(document.body.textContent).toMatch(/1 more needed/i);
  });

  it("Diff button appears and is disabled after selecting only one backup", async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId(`diff-checkbox-${KEY_1}`));
    const btn = screen.getByTestId("diff-selected-btn");
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it("Diff button becomes enabled after selecting two backups", async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId(`diff-checkbox-${KEY_1}`));
    fireEvent.click(screen.getByTestId(`diff-checkbox-${KEY_2}`));
    const btn = screen.getByTestId("diff-selected-btn");
    expect(btn.disabled).toBe(false);
  });

  it("hint banner says 'ready to diff' when both are selected", async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId(`diff-checkbox-${KEY_1}`));
    fireEvent.click(screen.getByTestId(`diff-checkbox-${KEY_2}`));
    expect(document.body.textContent).toMatch(/ready to diff/i);
  });

  it("clicking Diff calls getBackupAsync for both selected keys", async () => {
    const { getBackupAsync } = await import("../../lib/audit.js");
    await selectBothAndDiff();
    expect(getBackupAsync).toHaveBeenCalledWith(KEY_1);
    expect(getBackupAsync).toHaveBeenCalledWith(KEY_2);
  });

  it("clicking Diff renders AnalysisDiffView in the DOM", async () => {
    await selectBothAndDiff();
    await waitFor(() => {
      expect(screen.getByTestId("analysis-diff-view")).toBeTruthy();
    });
  });

  it("diff view shows ANALYSIS DIFF heading", async () => {
    await selectBothAndDiff();
    await waitFor(() => {
      expect(document.body.textContent).toContain("ANALYSIS DIFF");
    });
  });

  it("diff view shows SNAPSHOT A and SNAPSHOT B labels", async () => {
    await selectBothAndDiff();
    await waitFor(() => {
      expect(document.body.textContent).toContain("SNAPSHOT A");
      expect(document.body.textContent).toContain("SNAPSHOT B");
    });
  });

  it("diff view shows the field comparison table", async () => {
    await selectBothAndDiff();
    await waitFor(() => {
      expect(screen.getByTestId("diff-field-table")).toBeTruthy();
    });
  });

  it("diff view close button dismisses the view", async () => {
    await selectBothAndDiff();
    await waitFor(() => screen.getByTestId("analysis-diff-view"));
    const closeBtn = screen.getByTestId("analysis-diff-close");
    await act(async () => { fireEvent.click(closeBtn); });
    expect(screen.queryByTestId("analysis-diff-view")).toBeNull();
  });
});
