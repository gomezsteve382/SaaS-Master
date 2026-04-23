// @vitest-environment jsdom
//
// Task #376 regression — the Samples Library `onPreview` path must funnel
// through the workspace-level `loadF` size guard, so that picking an
// undersized fixture from the catalog surfaces the same structured
// "this isn't a full <module> dump" feedback we already render in the
// Dumps tab. The fixture must NOT be added to the workspace and the tab
// must NOT switch.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SampleLibraryTab from "../tabs/SampleLibraryTab.jsx";
import {
  detectModuleType,
  moduleTooSmall,
  MODULE_MIN_SIZES,
  MODULE_MIN_LABELS,
} from "../lib/parseModule.js";

// Stub the fixture loader so we don't depend on real .bin files at test time.
// We synthesize a 512-byte BCM fragment whose filename keeps the BCM/DFLASH
// hints `detectModuleType` keys off, so the workspace `loadF` will reject it
// the same way it would reject a real undersized capture.
vi.mock("../lib/sampleFixtures.js", async (importOriginal) => {
  const fragment = new Uint8Array(512);
  return {
    SAMPLE_FIXTURES: [
      {
        file: "SAMPLE_BCM_DFLASH_FRAGMENT.bin",
        kind: "BCM",
        size: 512,
        vin: null,
        role: "DEMO_OG",
        notes: "Synthesized BCM fragment for the size-guard regression test",
      },
    ],
    loadFixtureAsFile: vi.fn(async (name) =>
      new File([fragment], name, { type: "application/octet-stream" })
    ),
    loadFixtureBytes: vi.fn(async () => fragment),
  };
});

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Mirrors the wiring `VehicleWorkspace` sets up for `<SampleLibraryTab/>`:
// every preview funnels through the shared workspace `loadF`, which gates
// undersized files via `detectModuleType` + `moduleTooSmall` and returns
// `{acceptedFiles, rejected}` so the Samples Library can surface the same
// rejection feedback inline.
function makeWorkspaceOnPreview({ onTabSwitch, onAccepted } = {}) {
  return async (file /*, targetTab, fixture */) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const t = detectModuleType(bytes, file.name, undefined);
    const small = t ? moduleTooSmall(bytes, t, file.name) : null;
    if (small) {
      // Stay on Samples Library so the inline rejection feedback is visible.
      return { acceptedFiles: [], rejected: [{ name: file.name, ...small }] };
    }
    if (onAccepted) onAccepted(file);
    if (onTabSwitch) onTabSwitch();
    return { acceptedFiles: [file], rejected: [] };
  };
}

describe("SampleLibraryTab — undersized fixture rejection (Task #376)", () => {
  it("surfaces the workspace size-guard feedback and does not switch tabs when an undersized BCM fixture is previewed", async () => {
    const user = userEvent.setup();
    const onTabSwitch = vi.fn();
    const onAccepted = vi.fn();
    const onPreview = vi.fn(makeWorkspaceOnPreview({ onTabSwitch, onAccepted }));

    render(<SampleLibraryTab onPreview={onPreview} />);

    const previewBtn = await screen.findByRole("button", { name: /PREVIEW/ });
    await user.click(previewBtn);

    // Wait for the async fixture load + workspace gate.
    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(1));

    // Inline rejection feedback uses the same wording as the Dumps tab card.
    const errNode = await screen.findByText(/isn['’]t a full BCM dump/i);
    expect(errNode.textContent).toContain("SAMPLE_BCM_DFLASH_FRAGMENT.bin");
    expect(errNode.textContent).toContain("512");
    expect(errNode.textContent).toContain(MODULE_MIN_SIZES.BCM.toLocaleString());
    expect(errNode.textContent).toContain(MODULE_MIN_LABELS.BCM);
    expect(errNode.textContent).toMatch(/not loaded into the workspace/i);

    // The fixture must NOT have been accepted into the workspace, and the
    // workspace must NOT have switched tabs.
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onTabSwitch).not.toHaveBeenCalled();

    // The success "Loaded …" toast must not appear for a rejected fixture.
    expect(screen.queryByText(/^✓ Loaded /)).toBeNull();
  });
});
