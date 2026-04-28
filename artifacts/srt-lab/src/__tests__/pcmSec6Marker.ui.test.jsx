// @vitest-environment jsdom
//
// Task #405 — locks the visual surfacing of the FF FF FF AA marker @ 0x3C4
// in the PCM card. When SEC6 hex matches the BCM but the marker is missing,
// the operator must see a clear ✗ next to the marker row plus a "secret
// bytes present but marker missing — apply BCM→PCM SEC6 sync to restamp"
// hint. Without this the IMMO_DAMAGED diagnosis looks identical to a true
// SEC6 mismatch and sends techs down the wrong rabbit hole.

import React from "react";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import ModuleFieldsPanel from "../components/ModuleFieldsPanel.jsx";
import { parseModule } from "../lib/parseModule.js";
import { makeGpec2a } from "../lib/__fixtures__/buildFixtures.js";

afterEach(() => cleanup());

describe("PCM SEC6 marker — UI surfacing in ModuleFieldsPanel", () => {
  it("shows the marker row with a green check when the canonical FF FF FF AA marker is present", () => {
    const mod = parseModule(makeGpec2a({}), "pcm.bin");
    expect(mod.type).toBe("GPEC2A");
    expect(mod.pcmSec6.markerOk).toBe(true);
    expect(mod.pcmSec6.markerHex).toBe("FF FF FF AA");

    render(<ModuleFieldsPanel mod={mod} onSyncImmo={() => {}} />);

    expect(screen.getByText("PCM marker @0x03C4")).toBeTruthy();
    expect(screen.getByText(/✓ FF FF FF AA/)).toBeTruthy();
    // No "secret bytes present but marker missing" hint when marker is OK.
    expect(screen.queryByText(/Secret bytes present but marker missing/i)).toBeNull();
  });

  it("shows the marker row with a red cross AND the explanatory hint when SEC6 is populated but marker is missing", () => {
    // Hand-craft a buffer where SEC6 @ 0x3C8 is populated but the marker
    // bytes @ 0x3C4 are NOT FF FF FF AA — exactly the IMMO_DAMAGED scenario
    // the task is targeting.
    const buf = makeGpec2a({});
    // Stomp the marker — leave SEC6 hex intact.
    buf[0x3C4] = 0x00; buf[0x3C5] = 0x00; buf[0x3C6] = 0x00; buf[0x3C7] = 0x00;
    const mod = parseModule(buf, "pcm-no-marker.bin");

    expect(mod.pcmSec6.markerOk).toBe(false);
    expect(mod.pcmSec6.classification.populated).toBe(true);
    expect(mod.pcmSec6.immoState).toBe("IMMO_DAMAGED");

    render(<ModuleFieldsPanel mod={mod} onSyncImmo={() => {}} />);

    expect(screen.getByText("PCM marker @0x03C4")).toBeTruthy();
    expect(screen.getByText(/✗ MISSING/)).toBeTruthy();
    expect(screen.getByText(/Secret bytes present but marker missing/i)).toBeTruthy();
    expect(screen.getByText(/BCM→PCM SEC6 sync to restamp/i)).toBeTruthy();
  });

  it("does NOT render the explanatory hint when SEC6 is blank (true virgin) — marker missing is expected there", () => {
    const buf = makeGpec2a({ pcmSec6Damaged: true });
    const mod = parseModule(buf, "pcm-virgin.bin");
    expect(mod.pcmSec6.markerOk).toBe(false);
    expect(mod.pcmSec6.blank).toBe(true);

    render(<ModuleFieldsPanel mod={mod} onSyncImmo={() => {}} />);

    expect(screen.getByText(/✗ MISSING/)).toBeTruthy();
    // The "populated but marker missing" call-to-action is only meaningful
    // when SEC6 itself is populated; on a true virgin we keep it quiet.
    expect(screen.queryByText(/Secret bytes present but marker missing/i)).toBeNull();
  });
});
