// @vitest-environment jsdom
//
// Task #1025 — warn before exporting a virginized RFHUB that won't pair
// without re-keying.
//
// "Virginize RFH SEC16" deliberately wipes the RFHUB SEC16, so the
// exported BCM and RFHUB no longer share an immobilizer secret — flashing
// the pair as-is leaves a car that won't crank until the RFHUB is re-keyed
// on the bench (RoutineControl 0x0401 on the RFHUB tab). Task #1022 added a
// loud log line + the RFH_VIRGIN_ filename, but a tech can still miss it.
// This test locks the explicit pre-download confirm that fronts every
// virginized sync: it must spell out the no-shared-secret trade-off, point
// at the bench re-key flow, abort cleanly on Cancel, and proceed on
// Acknowledge. The non-virginize path must NOT raise the modal.

import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

import ModuleSync from "../tabs/ModuleSync.jsx";
import { MasterVinProvider } from "../lib/masterVinContext.jsx";

afterEach(() => cleanup());

/* doSync ships the patched bins via URL.createObjectURL + a temporary
 * <a>.click(). jsdom doesn't implement createObjectURL, so stub the pair
 * to keep the Acknowledge path from throwing mid-download. */
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}

/* Real-shape fixtures from the smoke-test corpus — the synthetic
 * buildFixtures BCM/RFH don't carry the slot markers engParseRfh /
 * resolveBcmSec16 scan for, so they never reach parsed.ok and the
 * workspace never flips to bothReady (which is what mounts the Sync
 * Actions card, the VIN sync buttons and the virginize checkbox).
 * This SYNCED BCM + SYNCED-VIRGIN RFH pair (same VIN) is the same one
 * moduleSyncGuidesAndReset uses to drive a live BCM VIN → RFH sync. */
const __dir = dirname(fileURLToPath(import.meta.url));
const realFixture = name => new Uint8Array(readFileSync(join(__dir, "fixtures", name)));

function renderModuleSync() {
  return render(
    <MasterVinProvider setPg={() => {}}>
      <ModuleSync />
    </MasterVinProvider>
  );
}

/* Load BCM + RFH so the workspace flips to bothReady and the VIN sync
 * buttons + virginize checkbox both mount. The DropZone reads each File
 * via f.arrayBuffer(). The first load re-renders the workspace (the
 * inspection panel mounts), which detaches the original input nodes, so
 * re-query the file inputs before loading the RFH. */
async function loadBcmAndRfh(container) {
  const bcm = new File([realFixture("SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin")], "bcm.bin", { type: "application/octet-stream" });
  const rfh = new File([realFixture("SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin")], "rfh.bin", { type: "application/octet-stream" });
  let inputs = container.querySelectorAll('input[type="file"]');
  expect(inputs.length).toBeGreaterThanOrEqual(2);
  await act(async () => {
    fireEvent.change(inputs[0], { target: { files: [bcm] } });
  });
  await waitFor(() => {
    expect(screen.getByTestId("vehicle-family-select")).toBeTruthy();
  });
  inputs = container.querySelectorAll('input[type="file"]');
  await act(async () => {
    fireEvent.change(inputs[1], { target: { files: [rfh] } });
  });
  /* The VIN sync buttons only mount once bothReady (BCM + RFH parsed). */
  await waitFor(() => {
    expect(screen.getByText("⬅ BCM VIN → RFH")).toBeTruthy();
  });
}

function checkVirginize() {
  const checkbox = screen
    .getByText(/VIRGINIZE RFH SEC16/i)
    .closest("label")
    .querySelector('input[type="checkbox"]');
  expect(checkbox).toBeTruthy();
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(true);
}

describe("Task #1025 — virginize pre-download confirm", () => {
  it("raises the confirm modal before a virginized BCM→RFH export", async () => {
    const { container } = renderModuleSync();
    await loadBcmAndRfh(container);
    checkVirginize();

    fireEvent.click(screen.getByText("⬅ BCM VIN → RFH"));

    const modal = await screen.findByTestId("virginize-confirm");
    /* The trade-off must be spelled out: no shared secret + bench re-key. */
    expect(modal.textContent).toMatch(/share no immobilizer secret|no immobilizer secret|not a matched immobilizer pair/i);
    expect(modal.textContent).toMatch(/re-key/i);
    expect(modal.textContent).toMatch(/0x0401/);
    expect(modal.textContent).toMatch(/RFHUB tab/i);
    expect(screen.getByTestId("virginize-confirm-btn")).toBeTruthy();
    expect(screen.getByTestId("virginize-cancel")).toBeTruthy();
  });

  it("aborts the export when the tech cancels the confirm", async () => {
    const { container } = renderModuleSync();
    await loadBcmAndRfh(container);
    checkVirginize();

    fireEvent.click(screen.getByText("⬅ BCM VIN → RFH"));
    await screen.findByTestId("virginize-confirm");
    fireEvent.click(screen.getByTestId("virginize-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("virginize-confirm")).toBeNull();
    });
    /* Cancellation surfaces a status line and writes nothing. */
    expect(await screen.findByText(/Sync cancelled — virginize/i)).toBeTruthy();
    expect(screen.queryByText(/Pre-download safety gate PASSED/i)).toBeNull();
  });

  it("proceeds with the export after Acknowledge & Download", async () => {
    const { container } = renderModuleSync();
    await loadBcmAndRfh(container);
    checkVirginize();

    fireEvent.click(screen.getByText("⬅ BCM VIN → RFH"));
    await screen.findByTestId("virginize-confirm");

    await act(async () => {
      fireEvent.click(screen.getByTestId("virginize-confirm-btn"));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("virginize-confirm")).toBeNull();
    });
    /* The acknowledgement is logged and the sync runs through its gate. */
    expect(await screen.findByText(/exported RFHUB is VIRGIN/i)).toBeTruthy();
  });

  it("does NOT raise the confirm when virginize is unchecked", async () => {
    const { container } = renderModuleSync();
    await loadBcmAndRfh(container);

    await act(async () => {
      fireEvent.click(screen.getByText("⬅ BCM VIN → RFH"));
    });

    /* No virginize → the modal must never mount; the normal sync runs to
     * completion. Match the single PASSED line (the "Downloaded:" line is a
     * separate span, so an alternation would match two nodes and throw). */
    expect(await screen.findByText(/Pre-download safety gate PASSED/i)).toBeTruthy();
    expect(screen.queryByTestId("virginize-confirm")).toBeNull();
  });
});
