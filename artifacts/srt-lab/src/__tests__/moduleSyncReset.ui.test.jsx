// @vitest-environment jsdom
//
// Locks the Module Sync workspace's "Clean / Reset" gesture (Task #464).
//
// The intent of the Reset button is to give a tech a fast clean-slate
// without forcing a page refresh: every loaded module slot, the diff
// table, the originals snapshots, the target VIN field, and the on-screen
// log must all clear — but the vehicle family selection must stay put,
// because that's a registry pick rather than per-file state and a tech
// loading a second car of the same family shouldn't have to re-pick.
//
// This test exercises the visible button rather than the internal
// callback so a future refactor of handleReset can't quietly drop the
// "preserve vehicle family" branch.

import React from "react";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

import ModuleSync from "../tabs/ModuleSync.jsx";
import { MasterVinProvider } from "../lib/masterVinContext.jsx";
import { makeBcm } from "../lib/__fixtures__/buildFixtures.js";

afterEach(() => cleanup());

function renderModuleSync() {
  return render(
    <MasterVinProvider setPg={() => {}}>
      <ModuleSync />
    </MasterVinProvider>
  );
}

/* Load a real BCM fixture into the BCM dropzone. The DropZone reads the
 * dropped file via `f.arrayBuffer()`, so we hand it a File whose bytes
 * come straight out of the buildFixtures helper that the rest of the
 * suite already uses. After the change-event drains the FileReader path
 * the workspace flips to the loaded state and renders the inspection
 * panel (where the vehicle family selector lives). */
async function loadBcmFixture(container) {
  const fileInput = container.querySelector('input[type="file"]');
  expect(fileInput).toBeTruthy();
  const bytes = makeBcm({ size: 65536 });
  const file = new File([bytes], "bcm-fixture.bin", { type: "application/octet-stream" });
  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [file] } });
  });
  /* DropZone resolves f.arrayBuffer() asynchronously — wait for the inspection
   * panel to mount so we know the parser has run and state is in place. */
  await waitFor(() => {
    expect(screen.getByTestId("vehicle-family-select")).toBeTruthy();
  });
}

describe("ModuleSync — Clean / Reset button (Task #464)", () => {
  it("renders the Reset button with the descriptive title", () => {
    renderModuleSync();
    const btn = screen.getByTestId("modsync-reset-btn");
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("title")).toMatch(/clear all loaded modules/i);
    expect(btn.getAttribute("title")).toMatch(/vehicle family stays selected/i);
  });

  it("does not crash when clicked from an empty workspace (idempotent reset)", () => {
    renderModuleSync();
    const btn = screen.getByTestId("modsync-reset-btn");
    expect(() => fireEvent.click(btn)).not.toThrow();
    /* Button stays mounted because Reset is a UI-state gesture, not navigation. */
    expect(screen.getByTestId("modsync-reset-btn")).toBeTruthy();
  });

  it("preserves the vehicle family selection across a Reset click", async () => {
    const { container } = renderModuleSync();
    await loadBcmFixture(container);

    /* Vehicle family selector is now mounted — pick the first non-blank entry. */
    const select = screen.getByTestId("vehicle-family-select");
    const firstReal = Array.from(select.options).find(o => o.value !== "");
    expect(firstReal).toBeTruthy();
    await act(async () => {
      fireEvent.change(select, { target: { value: firstReal.value } });
    });
    expect(select.value).toBe(firstReal.value);

    fireEvent.click(screen.getByTestId("modsync-reset-btn"));

    /* After Reset the inspection panel unmounts (no modules loaded) so the
     * select element disappears. The vehicleFamily state itself must NOT
     * have been cleared — we re-load the fixture and confirm the picker
     * comes back already pointing at the previously chosen family rather
     * than reverting to the blank "— select vehicle family —" option. */
    await waitFor(() => {
      expect(screen.queryByTestId("vehicle-family-select")).toBeNull();
    });
    await loadBcmFixture(container);
    const reborn = screen.getByTestId("vehicle-family-select");
    expect(reborn.value).toBe(firstReal.value);
  });

  it("removes any previously-shown module cards after reset", async () => {
    const { container } = renderModuleSync();
    await loadBcmFixture(container);
    /* Once a BCM is loaded, the inspection panel + at least one BCM-shaped
     * card (small or full) must be present. */
    expect(screen.getByTestId("vehicle-family-select")).toBeTruthy();

    fireEvent.click(screen.getByTestId("modsync-reset-btn"));

    /* The whole inspection card unmounts when no modules are loaded. */
    await waitFor(() => {
      expect(screen.queryByTestId("vehicle-family-select")).toBeNull();
    });
    expect(screen.queryByTestId("bcm-too-small-card")).toBeNull();
    expect(screen.queryByTestId("rfh-too-small-card")).toBeNull();
    expect(screen.queryByTestId("pcm-too-small-card")).toBeNull();
    expect(screen.queryByTestId("bcm-pn-pick")).toBeNull();
  });
});
