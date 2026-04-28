// @vitest-environment jsdom
//
// Task #481 — per-vehicle Dumps tab SYNC ALL must always emit a
// chip-shaped PCM file (exactly 4 KB / 95320 or 8 KB / 95640) so the
// bench programmer (Multi-PROG / CGDI / Xhorse) accepts it. Before
// this task the path shipped the patched PCM at the same byte count
// as the source dump, which produced "File different size / Data
// Writing failed!" rejections whenever the source happened to be an
// odd size (partial EXT EEPROM, INT FLASH read, etc.).
//
// Coverage:
//   - target-chip selector renders + persists per vehicle.id
//   - PCM size badge mirrors the Module Sync chip catalog
//     (95320 / 95640 / red OTHER)
//   - the always-on "File different size?" help blurb is visible
//   - SYNC ALL emits exactly 4096 / 8192 bytes regardless of source
//     size, with the `_4KB` / `_8KB` suffix in the filename

import React, { useState } from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DumpsTabV2 } from "../App.jsx";
import { VEHICLES } from "../lib/vehicles.js";

const enc = new TextEncoder();
const VALID_VIN = "2C3CDXGJ7JH123456";

function makeBcm(name, embeddedPn) {
  const data = new Uint8Array(65536).fill(0xff);
  data.set(enc.encode(embeddedPn), 0x100);
  return { name, size: data.length, type: "BCM", data };
}
function makePcm(name, size) {
  const data = new Uint8Array(size).fill(0xff);
  /* Sprinkle a recognisable byte pattern in the lower 4 KB so the
   * resize behaviour is observable byte-for-byte (truncate keeps the
   * pattern, FF-pad keeps the pattern + appends 0xFF). */
  for (let i = 0; i < Math.min(size, 4096); i++) data[i] = i & 0xFF;
  return { name, size, type: "PCM", data };
}

function Harness({ vehicle, initialFiles }) {
  const [files, setFiles] = useState(initialFiles);
  return (
    <DumpsTabV2
      vehicle={vehicle}
      files={files}
      setFiles={setFiles}
      loadF={() => {}}
      onGoSync={() => {}}
    />
  );
}

/* Capture every Blob handed to URL.createObjectURL + every download
 * filename / blob URL the SYNC handler triggers. The handler builds
 * a temporary <a>, sets .download + .href, calls .click() and revokes
 * the URL — so we shim createObjectURL to mint a tag we can look up
 * later and we shim anchor.click to record (download, href). */
function installBlobCaptureHarness() {
  const blobsByUrl = new Map();
  let blobCounter = 0;
  const downloads = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const origClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => {
    const tag = `blob:fake-${++blobCounter}`;
    blobsByUrl.set(tag, blob);
    return tag;
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href && blobsByUrl.has(this.href)) {
      downloads.push({ download: this.download, blob: blobsByUrl.get(this.href) });
    }
  };
  const restore = () => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    HTMLAnchorElement.prototype.click = origClick;
  };
  return { downloads, restore };
}

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DumpsTabV2 — Task #481 PCM target-chip resize", () => {
  it("renders the target-chip selector with the 4 KB default and the help blurb", () => {
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[]} />);
    const selector = screen.getByTestId("dumps-pcm-target-chip-selector");
    expect(selector).toBeTruthy();
    const opt4 = screen.getByTestId("dumps-pcm-target-chip-4kb");
    const opt8 = screen.getByTestId("dumps-pcm-target-chip-8kb");
    expect(opt4.getAttribute("data-active")).toBe("1");
    expect(opt8.getAttribute("data-active")).toBe("0");
    const help = screen.getByTestId("dumps-programmer-size-help");
    expect(help.textContent).toMatch(/File different size/i);
    expect(help.textContent).toMatch(/4 KB/);
    expect(help.textContent).toMatch(/8 KB/);
  });

  it("persists the chip pick per vehicle.id and re-reads it on mount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness vehicle={VEHICLES.charger} initialFiles={[]} />);
    await user.click(screen.getByTestId("dumps-pcm-target-chip-8kb"));
    expect(window.localStorage.getItem("srtlab:dumps:pcmTargetChip:charger")).toBe("8kb");
    unmount();
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[]} />);
    expect(screen.getByTestId("dumps-pcm-target-chip-8kb").getAttribute("data-active")).toBe("1");
    expect(screen.getByTestId("dumps-pcm-target-chip-4kb").getAttribute("data-active")).toBe("0");
  });

  it("keeps separate persisted defaults per vehicle", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness vehicle={VEHICLES.charger} initialFiles={[]} />);
    await user.click(screen.getByTestId("dumps-pcm-target-chip-8kb"));
    unmount();
    render(<Harness vehicle={VEHICLES.challenger} initialFiles={[]} />);
    /* Challenger has no persisted pick yet — should fall back to 4kb. */
    expect(screen.getByTestId("dumps-pcm-target-chip-4kb").getAttribute("data-active")).toBe("1");
  });

  it("auto-snaps the in-memory selector to the source chip when PCM is 4 KB", async () => {
    /* Persist 8kb first, then load a clean 4 KB PCM — the selector
     * should snap to 4kb so SYNC emits a 4 KB file by default. */
    window.localStorage.setItem("srtlab:dumps:pcmTargetChip:charger", "8kb");
    const bcm = makeBcm("BCM_OK.bin", "68396563");
    const pcm = makePcm("PCM_4K.bin", 4096);
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm]} />);
    await waitFor(() => {
      expect(screen.getByTestId("dumps-pcm-target-chip-4kb").getAttribute("data-active")).toBe("1");
    });
  });

  it("auto-snaps to 8 KB when source PCM is 8 KB", async () => {
    const bcm = makeBcm("BCM_OK.bin", "68396563");
    const pcm = makePcm("PCM_8K.bin", 8192);
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm]} />);
    await waitFor(() => {
      expect(screen.getByTestId("dumps-pcm-target-chip-8kb").getAttribute("data-active")).toBe("1");
    });
  });

  it("auto-snap does NOT overwrite the persisted preference", async () => {
    /* Persist 8kb, then load a clean 4 KB PCM. The in-memory selector
     * should snap to 4kb so SYNC emits a 4 KB file by default, but the
     * persisted preference must still read '8kb' so a tech who clears
     * the workspace and reloads gets their original choice back. */
    window.localStorage.setItem("srtlab:dumps:pcmTargetChip:charger", "8kb");
    const bcm = makeBcm("BCM_OK.bin", "68396563");
    const pcm = makePcm("PCM_4K.bin", 4096);
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm]} />);
    await waitFor(() => {
      expect(screen.getByTestId("dumps-pcm-target-chip-4kb").getAttribute("data-active")).toBe("1");
    });
    /* localStorage still holds the user's last explicit choice. */
    expect(window.localStorage.getItem("srtlab:dumps:pcmTargetChip:charger")).toBe("8kb");
  });

  it("renders the canonical 95320 / 95640 chip badge on the PCM upload tile", async () => {
    /* Task #485 — pin the full chip-badge text for both canonical
     * sizes so a regression in PCM_CHIPS labels (or a swap back to
     * the old size-only badge) trips the test instead of silently
     * shipping a less-informative tile. */
    const bcm = makeBcm("BCM_OK.bin", "68396563");
    const pcm4 = makePcm("PCM_4K.bin", 4096);
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm4]} />);
    let badge = await screen.findByTestId("dumps-pcm-size-badge");
    expect(badge.textContent).toBe("95320 · 4 KB");
    expect(badge.getAttribute("data-size-canonical")).toBe("1");
    expect(badge.getAttribute("data-size-key")).toBe("4kb");

    cleanup();
    const pcm8 = makePcm("PCM_8K.bin", 8192);
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm8]} />);
    badge = await screen.findByTestId("dumps-pcm-size-badge");
    expect(badge.textContent).toBe("95640 · 8 KB");
    expect(badge.getAttribute("data-size-canonical")).toBe("1");
    expect(badge.getAttribute("data-size-key")).toBe("8kb");
  });

  it("flags a non-canonical PCM size as UNKNOWN CHIP with the actual byte count", async () => {
    /* Task #485 — non-canonical sources (INT FLASH read, partial /
     * padded EXT EEPROM dump, etc.) get an amber "UNKNOWN CHIP"
     * badge that surfaces the raw byte count, so the tech sees at a
     * glance that the source dump doesn't match either bench chip
     * before clicking SYNC. */
    const bcm = makeBcm("BCM_OK.bin", "68396563");
    const pcm = makePcm("PCM_5K.bin", 5000);
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm]} />);
    const badge = await screen.findByTestId("dumps-pcm-size-badge");
    expect(badge.textContent).toMatch(/UNKNOWN CHIP/);
    expect(badge.textContent).toMatch(/5,000 B/);
    expect(badge.getAttribute("data-size-canonical")).toBe("0");
    expect(badge.getAttribute("data-size-key")).toBe("unknown");
  });
});

describe("DumpsTabV2 — Task #481 SYNC ALL emits chip-sized PCM", () => {
  it("emits exactly 4096 bytes with _4KB suffix when target = 4kb (non-canonical source)", async () => {
    const cap = installBlobCaptureHarness();
    try {
      const user = userEvent.setup();
      const bcm = makeBcm("BCM_OK.bin", "68396563");
      const pcm = makePcm("CHARGER_PCM.bin", 5000);
      render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm]} />);

      /* Default after install is 4kb (no localStorage, no canonical
       * source to auto-snap onto). */
      expect(screen.getByTestId("dumps-pcm-target-chip-4kb").getAttribute("data-active")).toBe("1");

      const vinInput = screen.getByPlaceholderText(/Enter customer .* VIN/i);
      await user.type(vinInput, VALID_VIN);
      await act(async () => {
        await user.click(screen.getByText(/SYNC ALL MODULES/));
      });

      const pcmDl = cap.downloads.find(d => /PCM_SYNCED/.test(d.download));
      expect(pcmDl).toBeTruthy();
      expect(pcmDl.download).toMatch(/_4KB_/);
      const buf = new Uint8Array(await pcmDl.blob.arrayBuffer());
      expect(buf.length).toBe(4096);
      /* Lower 4 KB pattern preserved (PCM VIN write may have flipped a
       * handful of bytes inside the 17-byte VIN slots, so we just
       * verify the size — that's the contract the bench programmer
       * cares about). */
    } finally { cap.restore(); }
  });

  it("emits exactly 8192 bytes with _8KB suffix when the tech picks 8kb on a non-canonical source", async () => {
    const cap = installBlobCaptureHarness();
    try {
      const user = userEvent.setup();
      const bcm = makeBcm("BCM_OK.bin", "68396563");
      const pcm = makePcm("CHARGER_PCM.bin", 5000);
      render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm]} />);

      await user.click(screen.getByTestId("dumps-pcm-target-chip-8kb"));
      expect(screen.getByTestId("dumps-pcm-target-chip-8kb").getAttribute("data-active")).toBe("1");

      const vinInput = screen.getByPlaceholderText(/Enter customer .* VIN/i);
      await user.type(vinInput, VALID_VIN);
      await act(async () => {
        await user.click(screen.getByText(/SYNC ALL MODULES/));
      });

      const pcmDl = cap.downloads.find(d => /PCM_SYNCED/.test(d.download));
      expect(pcmDl).toBeTruthy();
      expect(pcmDl.download).toMatch(/_8KB_/);
      const buf = new Uint8Array(await pcmDl.blob.arrayBuffer());
      expect(buf.length).toBe(8192);
    } finally { cap.restore(); }
  });

  it("emits exactly 4096 bytes when the source is already a clean 4 KB dump", async () => {
    const cap = installBlobCaptureHarness();
    try {
      const user = userEvent.setup();
      const bcm = makeBcm("BCM_OK.bin", "68396563");
      const pcm = makePcm("CHARGER_PCM_4K.bin", 4096);
      render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm]} />);

      const vinInput = screen.getByPlaceholderText(/Enter customer .* VIN/i);
      await user.type(vinInput, VALID_VIN);
      await act(async () => {
        await user.click(screen.getByText(/SYNC ALL MODULES/));
      });

      const pcmDl = cap.downloads.find(d => /PCM_SYNCED/.test(d.download));
      expect(pcmDl).toBeTruthy();
      expect(pcmDl.download).toMatch(/_4KB_/);
      const buf = new Uint8Array(await pcmDl.blob.arrayBuffer());
      expect(buf.length).toBe(4096);
    } finally { cap.restore(); }
  });

  it("emits exactly 8192 bytes when the source is already a clean 8 KB dump", async () => {
    const cap = installBlobCaptureHarness();
    try {
      const user = userEvent.setup();
      const bcm = makeBcm("BCM_OK.bin", "68396563");
      const pcm = makePcm("CHARGER_PCM_8K.bin", 8192);
      render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, pcm]} />);

      const vinInput = screen.getByPlaceholderText(/Enter customer .* VIN/i);
      await user.type(vinInput, VALID_VIN);
      await act(async () => {
        await user.click(screen.getByText(/SYNC ALL MODULES/));
      });

      const pcmDl = cap.downloads.find(d => /PCM_SYNCED/.test(d.download));
      expect(pcmDl).toBeTruthy();
      expect(pcmDl.download).toMatch(/_8KB_/);
      const buf = new Uint8Array(await pcmDl.blob.arrayBuffer());
      expect(buf.length).toBe(8192);
    } finally { cap.restore(); }
  });
});
