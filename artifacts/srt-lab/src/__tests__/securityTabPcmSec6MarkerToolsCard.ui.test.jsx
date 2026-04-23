// @vitest-environment jsdom
//
// Task #421 — pins the FF FF FF AA marker indicator AND the
// "Secret bytes present but marker missing" hint on SecurityTab's
// per-module Tools sub-tab card (the RFH → PCM SEC6 Import card,
// ~line 510-525 of SecurityTab.jsx). Sibling test
// `securityTabPcmSec6Marker.ui.test.jsx` covers the Security sub-tab
// cards; without this companion test a refactor could quietly drop the
// marker indicator + hint from the Tools panel without anything failing.
//
// The Tools card only renders the marker info when an RFHUB dump is
// also loaded (otherwise the card short-circuits with an "Also load an
// RFHUB" notice), so each test case loads BOTH a GPEC2A and an RFHUB.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

import SecurityTab from "../tabs/SecurityTab.jsx";
import { makeGpec2a, makeRfhubGen2 } from "../lib/__fixtures__/buildFixtures.js";

// ── FileReader mock — keyed by filename so each dropped file gets its bytes ──
const fileMap = new Map();
let restoreFileReader = null;
function installFileReaderMock() {
  const Original = global.FileReader;
  function Mock() {
    const inst = {
      onload: null,
      readAsArrayBuffer(blob) {
        Promise.resolve().then(() => {
          if (typeof inst.onload === "function") {
            const bytes = fileMap.get(blob.name);
            inst.onload({ target: { result: bytes.buffer } });
          }
        });
      },
    };
    return inst;
  }
  global.FileReader = Mock;
  return () => { global.FileReader = Original; fileMap.clear(); };
}

// ── Helper: drop one or more files on the SecurityTab dropzone ───────────────
async function dropFiles(files) {
  const headline = await screen.findByText(/Drop Module Files/i);
  const fileList = files.map(({ bytes, filename }) => {
    fileMap.set(filename, bytes);
    return new File([bytes.buffer], filename, { type: "application/octet-stream" });
  });
  await act(async () => {
    fireEvent.drop(headline, {
      dataTransfer: { files: fileList, items: [], types: ["Files"] },
    });
    await new Promise(r => setTimeout(r, 100));
  });
}

// ── Helper: toggle Advanced + click Tools sub-tab + select GPEC2A target ─────
async function openToolsSubTabWithGpecTarget() {
  const advLabel = await screen.findByTestId("security-advanced-toggle");
  const advCheckbox = advLabel.querySelector('input[type="checkbox"]');
  expect(advCheckbox, "advanced checkbox should exist").toBeTruthy();
  await act(async () => {
    if (!advCheckbox.checked) fireEvent.click(advCheckbox);
    await new Promise(r => setTimeout(r, 20));
  });

  await waitFor(() => {
    const btn = Array.from(document.querySelectorAll("button"))
      .find(b => b.textContent.trim() === "Tools");
    expect(btn, "Tools sub-tab button must render once Advanced is on").toBeTruthy();
  }, { timeout: 3000 });
  const toolsBtn = Array.from(document.querySelectorAll("button"))
    .find(b => b.textContent.trim() === "Tools");
  await act(async () => {
    fireEvent.click(toolsBtn);
    await new Promise(r => setTimeout(r, 20));
  });

  // Pick the GPEC2A entry from the Target <select>. Its option text is
  // "<filename> (<TL[type]>)" — for GPEC2A the human label rendered is
  // "PCM (GPEC2A)" via TL.
  await waitFor(() => {
    const sel = document.querySelector('select');
    expect(sel, "Tools target <select> must render").toBeTruthy();
    const opts = Array.from(sel.options);
    const gpecIdx = opts.findIndex(o => /pcm/i.test(o.textContent));
    expect(gpecIdx, "GPEC2A option must exist in Tools target select").toBeGreaterThanOrEqual(0);
  }, { timeout: 3000 });
  const sel = document.querySelector('select');
  const opts = Array.from(sel.options);
  const gpecIdx = opts.findIndex(o => /pcm/i.test(o.textContent));
  await act(async () => {
    fireEvent.change(sel, { target: { value: opts[gpecIdx].value } });
    await new Promise(r => setTimeout(r, 20));
  });
}

beforeEach(() => {
  try { window.localStorage.clear(); } catch {}
  restoreFileReader = installFileReaderMock();
});

afterEach(() => {
  cleanup();
  restoreFileReader?.();
  restoreFileReader = null;
  vi.restoreAllMocks();
});

describe("SecurityTab — PCM SEC6 marker surfacing on Tools card", () => {
  it("shows ✗ MISSING tag AND the explanatory hint on the Tools card when SEC6 is populated but the marker is stomped", async () => {
    const pcm = makeGpec2a({});
    pcm[0x3C4] = 0x00; pcm[0x3C5] = 0x00; pcm[0x3C6] = 0x00; pcm[0x3C7] = 0x00;
    const rfh = makeRfhubGen2({});

    render(<SecurityTab />);
    await dropFiles([
      { bytes: pcm, filename: "pcm-no-marker.bin" },
      { bytes: rfh, filename: "rfh.bin" },
    ]);
    await openToolsSubTabWithGpecTarget();

    await waitFor(() => {
      expect(screen.getAllByText(/PCM marker @0x3C4/).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    expect(screen.getAllByText(/✗ MISSING/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Secret bytes present but marker missing/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/BCM→PCM SEC6 sync to restamp/i).length).toBeGreaterThan(0);

    expect(screen.queryByText(/✓ FF FF FF AA/)).toBeNull();
  });

  it("shows the green ✓ FF FF FF AA marker tag and NO hint on the Tools card when the marker is intact", async () => {
    const pcm = makeGpec2a({});
    const rfh = makeRfhubGen2({});

    render(<SecurityTab />);
    await dropFiles([
      { bytes: pcm, filename: "pcm-ok.bin" },
      { bytes: rfh, filename: "rfh.bin" },
    ]);
    await openToolsSubTabWithGpecTarget();

    await waitFor(() => {
      expect(screen.getAllByText(/PCM marker @0x3C4/).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    expect(screen.getAllByText(/✓ FF FF FF AA/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/✗ MISSING/)).toBeNull();
    expect(screen.queryByText(/Secret bytes present but marker missing/i)).toBeNull();
  });
});
