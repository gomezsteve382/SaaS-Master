// @vitest-environment jsdom
//
// Task #419 — pins the FF FF FF AA marker @ 0x03C4 surfacing on the
// Security tab cards. Task #417 mirrored the marker indicator + the
// "secret bytes present but marker missing" hint from ModuleFieldsPanel
// into SecurityTab (overview table, security cards, RFH→PCM tools card).
// `pcmSec6Marker.ui.test.jsx` already pins the same UI on
// ModuleFieldsPanel, but SecurityTab itself had no render-based UI test
// — a future refactor could silently drop the marker row again.
//
// This test:
//   1. Renders SecurityTab with a GPEC2A whose SEC6 bytes are populated
//      but the canonical FF FF FF AA marker @ 0x3C4 is stomped, and
//      asserts both the ✗ MISSING tag and the explanatory hint appear
//      in the per-module Security cards (Security sub-tab).
//   2. Renders SecurityTab with an intact GPEC2A and asserts the green
//      ✓ FF FF FF AA marker tag appears, and the hint does NOT.

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
  // The dropzone wraps the "Drop Module Files" Card. We fire the drop
  // event on the headline element — React's synthetic event system bubbles
  // it up to the wrapper div that carries the actual onDrop handler.
  const headline = await screen.findByText(/Drop Module Files/i);
  const file = new File([bytes.buffer], filename, { type: "application/octet-stream" });
  await act(async () => {
    fireEvent.drop(headline, {
      dataTransfer: { files: [file], items: [], types: ["Files"] },
    });
    // Let the FileReader microtask + React state updates flush.
    await new Promise(r => setTimeout(r, 60));
  });
}

// ── Helper: toggle Advanced + click Security sub-tab ──────────────────────────
async function openSecuritySubTab() {
  // Toggle advanced (the wrapping label has data-testid="security-advanced-toggle").
  const advLabel = await screen.findByTestId("security-advanced-toggle");
  const advCheckbox = advLabel.querySelector('input[type="checkbox"]');
  expect(advCheckbox, "advanced checkbox should exist").toBeTruthy();
  // Only flip if not already on — SecurityTab persists Advanced via
  // localStorage, so a stale "true" would otherwise be toggled OFF and
  // hide the sub-tab buttons. (beforeEach clears localStorage, but be
  // defensive in case test ordering or future helpers prime it.)
  await act(async () => {
    if (!advCheckbox.checked) fireEvent.click(advCheckbox);
    await new Promise(r => setTimeout(r, 20));
  });

  // Click the "Security" sub-tab button. There may be other elements
  // containing the word "Security" on the page, so look specifically for
  // a <button> whose trimmed text content is exactly "Security".
  await waitFor(() => {
    const btn = Array.from(document.querySelectorAll("button"))
      .find(b => b.textContent.trim() === "Security");
    expect(btn, "Security sub-tab button must render once Advanced is on").toBeTruthy();
  }, { timeout: 3000 });
  const securityBtn = Array.from(document.querySelectorAll("button"))
    .find(b => b.textContent.trim() === "Security");
  await act(async () => {
    fireEvent.click(securityBtn);
    await new Promise(r => setTimeout(r, 20));
  });
}

beforeEach(() => {
  // SecurityTab persists the Advanced toggle state to localStorage via
  // loadAdvanced/saveAdvanced('security'). Without clearing localStorage
  // between tests, a previous test that flipped Advanced on would leak
  // into the next test (where clicking the toggle would flip it OFF and
  // hide the sub-tab buttons we need to click).
  try { window.localStorage.clear(); } catch {}
});

afterEach(() => {
  cleanup();
  restoreFileReader?.();
  vi.restoreAllMocks();
});

describe("SecurityTab — PCM SEC6 marker surfacing on Security cards", () => {
  it("shows ✗ MISSING tag AND the explanatory hint when SEC6 is populated but the marker is stomped", async () => {
    // Build a GPEC2A buffer with intact SEC6 then stomp the FF FF FF AA marker @ 0x3C4.
    const buf = makeGpec2a({});
    buf[0x3C4] = 0x00; buf[0x3C5] = 0x00; buf[0x3C6] = 0x00; buf[0x3C7] = 0x00;
    restoreFileReader = installFileReaderMock(buf);

    render(<SecurityTab />);
    await dropFile(buf, "pcm-no-marker.bin");
    await openSecuritySubTab();

    // The Security sub-tab card carries the marker label "PCM marker @0x3C4"
    // (note the per-card label — the overview table uses "@0x03C4" instead).
    await waitFor(() => {
      expect(screen.getAllByText(/PCM marker @0x3C4/).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    // ✗ MISSING tag must appear on the Security card.
    expect(screen.getAllByText(/✗ MISSING/).length).toBeGreaterThan(0);

    // The "Secret bytes present but marker missing" hint must appear, with
    // the "BCM→PCM SEC6 sync to restamp" call to action.
    expect(screen.getAllByText(/Secret bytes present but marker missing/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/BCM→PCM SEC6 sync to restamp/i).length).toBeGreaterThan(0);

    // Sanity: no green ✓ FF FF FF AA tag should be present for this GPEC2A.
    expect(screen.queryByText(/✓ FF FF FF AA/)).toBeNull();
  });

  it("shows the green ✓ FF FF FF AA marker tag and NO explanatory hint when the marker is intact", async () => {
    const buf = makeGpec2a({}); // canonical FF FF FF AA marker stamped by fixture
    restoreFileReader = installFileReaderMock(buf);

    render(<SecurityTab />);
    await dropFile(buf, "pcm-ok.bin");
    await openSecuritySubTab();

    // Marker label is rendered on each card.
    await waitFor(() => {
      expect(screen.getAllByText(/PCM marker @0x3C4/).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    // Green ✓ FF FF FF AA tag must appear.
    expect(screen.getAllByText(/✓ FF FF FF AA/).length).toBeGreaterThan(0);

    // ✗ MISSING must NOT appear and neither should the explanatory hint —
    // the marker is intact so the IMMO_DAMAGED call-to-action is suppressed.
    expect(screen.queryByText(/✗ MISSING/)).toBeNull();
    expect(screen.queryByText(/Secret bytes present but marker missing/i)).toBeNull();
  });
});
