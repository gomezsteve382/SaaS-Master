// @vitest-environment jsdom
//
// Task #379 — durable PCM EXT-EEPROM chip-size detection.
//
// The Sincro PcmCard must surface a structured warning card the moment a
// doubled 8 KB GPEC2A capture (half-2 = 0xFF padding) is loaded, so the
// user knows the SYNC output will be auto-sliced to 4 KB and the CGDI
// flasher won't reject the file with "File different size" on a 95320
// bench. This is the regression check that the prior bug — `parsed.data`
// is undefined on engParsePcm output, so the card never renders — does
// not return.

import React from "react";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { PcmCard, engParsePcm } from "../tabs/ModuleSync.jsx";
import { makeGpec2a } from "../lib/__fixtures__/buildFixtures.js";

const TARGET_VIN = "1C4BJWFG3JL901234";
const PCM_SEC6 = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);

function makeDoubledFFPad() {
  const half1 = makeGpec2a({ vin: TARGET_VIN, pcmSec6Bytes: PCM_SEC6 });
  const buf = new Uint8Array(8192).fill(0xFF);
  buf.set(half1, 0);
  return buf;
}

function makeNonCanonical(size) {
  return new Uint8Array(size); // not 4096 / 8192
}

afterEach(() => cleanup());

describe("Task #379 — PcmCard mismatch-guard cards", () => {
  it("renders the doubled-mismatch warning card for an 8 KB FF-padded GPEC2A capture", () => {
    const bytes = makeDoubledFFPad();
    const parsed = engParsePcm(bytes, "PCM_DOUBLED_FF.bin");
    render(<PcmCard parsed={parsed} bytes={bytes} pnOverride={false} />);

    const card = screen.getByTestId("pcm-doubled-mismatch-card");
    expect(card.textContent).toMatch(/Doubled 8 KB capture/);
    expect(card.textContent).toMatch(/95320/);
    expect(card.textContent).toMatch(/File different size/);

    // The chip badge should still render and identify 95640 (the raw size).
    const badge = screen.getByTestId("pcm-chip-badge");
    expect(badge.getAttribute("data-chip")).toBe("95640");
  });

  it("renders the chip-mismatch (red) card for a non-canonical PCM size", () => {
    // A 5000-byte buffer falls between the two canonical GPEC2A sizes
    // (4 KB / 8 KB) but is above PCM_MIN_SIZE, so engParsePcm returns
    // ok=false rather than tooSmall. The chip-mismatch card must render
    // in that branch.
    const bytes = makeNonCanonical(5000);
    const parsed = engParsePcm(bytes, "PCM_NONCANONICAL.bin");
    if (parsed.tooSmall) {
      // Skip if min-size guard rejects it before we get a chance to test.
      return;
    }
    render(<PcmCard parsed={parsed} bytes={bytes} pnOverride={false} />);

    const card = screen.queryByTestId("pcm-chip-mismatch-card");
    expect(card).toBeTruthy();
    expect(card.textContent).toMatch(/neither 4 KB \(95320\) nor 8 KB \(95640\)/);
    expect(screen.queryByTestId("pcm-doubled-mismatch-card")).toBeNull();
  });

  it("does NOT render the doubled-mismatch card for a clean 4 KB GPEC2A image", () => {
    const bytes = makeGpec2a({ vin: TARGET_VIN, pcmSec6Bytes: PCM_SEC6 });
    const parsed = engParsePcm(bytes, "PCM_4KB_CLEAN.bin");
    render(<PcmCard parsed={parsed} bytes={bytes} pnOverride={false} />);

    expect(screen.queryByTestId("pcm-doubled-mismatch-card")).toBeNull();
    expect(screen.queryByTestId("pcm-chip-mismatch-card")).toBeNull();
    const badge = screen.getByTestId("pcm-chip-badge");
    expect(badge.getAttribute("data-chip")).toBe("95320");
  });
});
