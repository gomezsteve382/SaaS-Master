// @vitest-environment jsdom
//
// Task #422 — pins the FF FF FF AA marker @ 0x03C4 surfacing in the
// Overview sub-tab table on SecurityTab. Task #417 mirrored the marker
// row + the "secret bytes present but marker missing" explanatory row
// from ModuleFieldsPanel into the SecurityTab Overview table (rows
// ~line 320 + ~line 322 of `SecurityTab.jsx`). Task #419 covered the
// per-module Security cards via `securityTabPcmSec6Marker.ui.test.jsx`,
// but the Overview table row was still uncovered and could be silently
// regressed by a future refactor.
//
// This test:
//   1. Renders SecurityTab on the default Overview sub-tab with a
//      GPEC2A whose SEC6 bytes are populated but the canonical
//      FF FF FF AA marker @ 0x3C4 is stomped, and asserts the table
//      row "0x03C4 / PCM-MARK / ✗ MISSING" plus the explanatory
//      "Secret bytes present but marker missing" cell render.
//   2. Renders SecurityTab with an intact GPEC2A and asserts the row
//      shows ✓ FF FF FF AA and the explanatory cell does NOT render.
//
// Helpers (dropFile + Advanced toggle) mirror the per-card test in
// `securityTabPcmSec6Marker.ui.test.jsx` so the two tests stay in sync.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

import SecurityTab from "../tabs/SecurityTab.jsx";
import { makeGpec2a } from "../lib/__fixtures__/buildFixtures.js";

// ── FileReader mock ───────────────────────────────────────────────────────────
let restoreFileReader;
function installFileReaderMock(bytes) {
  const Original = global.FileReader;
  function Mock() {
    const inst = {
      onload: null,
      readAsArrayBuffer() {
        Promise.resolve().then(() => {
          if (typeof inst.onload === "function") {
            inst.onload({ target: { result: bytes.buffer } });
          }
        });
      },
    };
    return inst;
  }
  global.FileReader = Mock;
  return () => { global.FileReader = Original; };
}

// ── Helper: drop a file on the SecurityTab dropzone ───────────────────────────
async function dropFile(bytes, filename = "pcm.bin") {
  const headline = await screen.findByText(/Drop Module Files/i);
  const file = new File([bytes.buffer], filename, { type: "application/octet-stream" });
  await act(async () => {
    fireEvent.drop(headline, {
      dataTransfer: { files: [file], items: [], types: ["Files"] },
    });
    await new Promise(r => setTimeout(r, 60));
  });
}

// ── Helper: turn on Advanced (Overview is the default sub-tab) ────────────────
async function enableAdvanced() {
  const advLabel = await screen.findByTestId("security-advanced-toggle");
  const advCheckbox = advLabel.querySelector('input[type="checkbox"]');
  expect(advCheckbox, "advanced checkbox should exist").toBeTruthy();
  await act(async () => {
    if (!advCheckbox.checked) fireEvent.click(advCheckbox);
    await new Promise(r => setTimeout(r, 20));
  });
}

beforeEach(() => {
  // SecurityTab persists Advanced via localStorage; clear so prior runs
  // don't leave the toggle pre-flipped (which would cause our click to
  // turn it OFF and hide the Overview content).
  try { window.localStorage.clear(); } catch {}
});

afterEach(() => {
  cleanup();
  restoreFileReader?.();
  vi.restoreAllMocks();
});

describe("SecurityTab — PCM SEC6 marker surfacing in Overview table", () => {
  it("shows the 0x03C4 / PCM-MARK / ✗ MISSING row AND the explanatory cell when the marker is stomped", async () => {
    const buf = makeGpec2a({});
    buf[0x3C4] = 0x00; buf[0x3C5] = 0x00; buf[0x3C6] = 0x00; buf[0x3C7] = 0x00;
    restoreFileReader = installFileReaderMock(buf);

    render(<SecurityTab />);
    await dropFile(buf, "pcm-no-marker.bin");
    await enableAdvanced();

    // The Overview table row carries an Offset cell of "0x03C4", a
    // PCM-MARK tag, and a ✗ MISSING detail cell. Find the PCM-MARK tag
    // and walk up to its row to assert all three cells live together.
    await waitFor(() => {
      expect(screen.getAllByText("PCM-MARK").length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const markTag = screen.getAllByText("PCM-MARK")[0];
    const row = markTag.closest("tr");
    expect(row, "PCM-MARK tag must live inside a <tr>").toBeTruthy();
    expect(row.textContent).toMatch(/0x03C4/);
    expect(row.textContent).toMatch(/✗ MISSING/);

    // The explanatory row "Secret bytes present but marker missing" must
    // render in the Overview table when the marker is missing but the
    // SEC6 bytes are populated.
    expect(
      screen.getAllByText(/Secret bytes present but marker missing/i).length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/BCM→PCM SEC6 sync to restamp/i).length
    ).toBeGreaterThan(0);

    // No green ✓ FF FF FF AA marker tag should appear for this GPEC2A.
    expect(screen.queryByText(/✓ FF FF FF AA/)).toBeNull();
  });

  it("shows the ✓ FF FF FF AA row and NO explanatory cell when the marker is intact", async () => {
    const buf = makeGpec2a({}); // canonical FF FF FF AA marker stamped by fixture
    restoreFileReader = installFileReaderMock(buf);

    render(<SecurityTab />);
    await dropFile(buf, "pcm-ok.bin");
    await enableAdvanced();

    await waitFor(() => {
      expect(screen.getAllByText("PCM-MARK").length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const markTag = screen.getAllByText("PCM-MARK")[0];
    const row = markTag.closest("tr");
    expect(row, "PCM-MARK tag must live inside a <tr>").toBeTruthy();
    expect(row.textContent).toMatch(/0x03C4/);
    expect(row.textContent).toMatch(/✓ FF FF FF AA/);

    // ✗ MISSING and the explanatory hint must NOT appear when the
    // marker is intact.
    expect(screen.queryByText(/✗ MISSING/)).toBeNull();
    expect(screen.queryByText(/Secret bytes present but marker missing/i)).toBeNull();
  });
});
