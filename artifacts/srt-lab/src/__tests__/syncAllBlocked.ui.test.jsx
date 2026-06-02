// @vitest-environment jsdom
//
// Task #1026 — Module Sync "SYNC ALL" pre-download safety gate, driven through
// the REAL component (not just the checkExportSafety unit).
//
// The brick this guards against: a "Sync all" run that ships an RFH whose
// SEC16 secret does not reconcile with the BCM it pairs with, labels both
// files _SYNCED, and reports success. Flashing a mismatched immobilizer pair
// locks the car. The tab accumulates every outgoing file, runs
// checkExportSafety over the whole set, and either flushes all of them or
// refuses the entire sync.
//
// This suite renders ModuleSync, loads synthetic BCM + RFH fixtures through
// the real DropZone file inputs, clicks the visible "SYNC ALL" button, and
// asserts the two endpoints of that gate:
//
//   1. NON-RECONCILABLE pair (BCM flat secret whose reverse != RFH SEC16):
//      no _SYNCED download fires AND the BLOCKED / MISMATCH log surfaces.
//   2. RECONCILABLE pair (BCM flat secret == reverse(RFH SEC16)):
//      both BCM_SYNCED and RFH_SYNCED files are exported.
//
// Driving the actual button (rather than checkExportSafety directly) locks the
// wiring: a future refactor that drops the gate, mislabels the files, or stops
// accumulating before the gate runs will break this test.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

import ModuleSync from "../tabs/ModuleSync.jsx";
import { MasterVinProvider } from "../lib/masterVinContext.jsx";
import { makeBcm, makeRfhubGen2 } from "../lib/__fixtures__/buildFixtures.js";

// RFHUB Gen2 default SEC16 secret (buildFixtures makeRfhubGen2).
const RFH_SECRET = [
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
];

// crossValidate compares reverse(resolved BCM SEC16) against the RFH secret, so
// a BCM whose flat slice == reverse(RFH secret) reconciles; the makeBcm default
// flat slice does not.
const RFH_SECRET_REVERSED = new Uint8Array([...RFH_SECRET].reverse());

/* makeBcm() writes the 17-char VIN as raw ASCII at the four canonical bases
 * 0x5320/0x5340/0x5360/0x5380, but two parsers read those slots differently:
 *
 *  - engParseBcm (the inspector that sets bcm.parsed.ok, gating the "SYNC ALL"
 *    card) only recognizes a VIN slot prefixed by a `00 46 <slotType> 00`
 *    header (slotType ∈ BCM_SLOT_TYPES). makeBcm writes no header, so no VIN
 *    parses and the action card never mounts.
 *  - checkExportSafety (the pre-download gate) reparses via parseModule, which
 *    reads each canonical slot directly and validates a CRC-16 at base+17.
 *    makeBcm writes no CRC, so the gate rejects every raw slot with
 *    "VIN slot ... checksum INVALID".
 *
 * Injecting the 4-byte header before ALL FOUR bases makes engParseBcm discover
 * all four slots, so engWriteBcmVin (run by SYNC ALL) restamps each one with a
 * valid CRC — satisfying the gate's VIN self-check. The absence of split/mirror
 * records keeps the BCM in the flat-only state the scenarios depend on
 * (sec16SyncOk false → SEC16 is never rewritten from the RFH, so the resolved
 * flat slice at 0x40C9 is what crossValidate compares).
 *
 * The flat secret must be written AFTER makeBcm: makeBcm's `vehicleSecret`
 * option fills 0x40C9 first, but its subsequent IMMO-record fill at 0x40C0
 * (record length 24) overwrites 0x40C9..0x40D8 entirely, so the option never
 * survives into the resolved flat. Stamping `flatSecret` here lands the bytes
 * the gate actually reads. */
function bcmFixture({ flatSecret = null, ...opts } = {}) {
  const buf = makeBcm({ size: 65536, ...opts });
  for (const base of [0x5320, 0x5340, 0x5360, 0x5380]) {
    const hdr = base - 4;
    buf[hdr] = 0x00;
    buf[hdr + 1] = 0x46;
    buf[hdr + 2] = 0x46;
    buf[hdr + 3] = 0x00;
  }
  if (flatSecret) {
    for (let i = 0; i < 16; i++) buf[0x40c9 + i] = flatSecret[i];
  }
  return buf;
}

let clickSpy;

beforeEach(() => {
  // jsdom implements neither URL.createObjectURL nor anchor downloads; stub the
  // blob plumbing and count anchor clicks as "a file hit disk".
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  // No PCM is loaded, so SYNC ALL never opens a confirm; stub defensively.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderModuleSync() {
  return render(
    <MasterVinProvider setPg={() => {}}>
      <ModuleSync />
    </MasterVinProvider>
  );
}

/* Drop a fixture buffer into a DropZone file input. The DropZone reads the
 * file via f.arrayBuffer() asynchronously, so the change-event is flushed
 * inside act() and the microtask settle is awaited inside act() as well.
 *
 * The file inputs are looked up fresh by index on every call: loading the BCM
 * re-renders the tab (the inspection panel mounts), which replaces DOM nodes,
 * so a NodeList captured once goes stale and a change fired on the old RFH node
 * is silently dropped. Re-querying guarantees the live node. */
async function loadInto(container, index, bytes, name) {
  const inputs = container.querySelectorAll('input[type="file"]');
  expect(inputs.length).toBeGreaterThan(index);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  await act(async () => {
    fireEvent.change(inputs[index], { target: { files: [file] } });
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/* Load a BCM + RFH pair (DropZone order: [0]=BCM, [1]=RFH) and wait for the
 * "SYNC ALL" action button to mount (only renders once both are parsed). */
async function loadPair(container, { bcmBytes, rfhBytes }) {
  await loadInto(container, 0, bcmBytes, "bcm-fixture.bin");
  await loadInto(container, 1, rfhBytes, "rfh-fixture.bin");
  let btn;
  await waitFor(() => {
    btn = screen.getByRole("button", { name: /SYNC ALL/i });
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });
  return btn;
}

describe("ModuleSync — SYNC ALL pre-download safety gate (Task #1026)", () => {
  it("REFUSES a non-reconcilable BCM/RFH pair: no _SYNCED download, BLOCKED log surfaces", async () => {
    const { container } = renderModuleSync();
    // No flatSecret: the resolved flat at 0x40C9 is makeBcm's IMMO-record fill
    // pattern, whose reverse != RFH secret [01..10] → crossValidate MISMATCH.
    const syncBtn = await loadPair(container, {
      bcmBytes: bcmFixture(),
      rfhBytes: makeRfhubGen2(),
    });

    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // The abort line is the contract: the whole set is refused, nothing written.
    await waitFor(() => {
      expect(
        screen.getByText(/Sync aborted — no files were written/i, { exact: false })
      ).toBeTruthy();
    });
    // The blocking reason must be the immobilizer-secret mismatch.
    expect(screen.queryAllByText(/MISMATCH/i, { exact: false }).length).toBeGreaterThan(0);

    // No _SYNCED file may have shipped — neither a logged download nor an
    // actual anchor click.
    expect(screen.queryByText(/^Downloaded:/i, { exact: false })).toBeNull();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("EXPORTS both BCM_SYNCED and RFH_SYNCED for a reconcilable pair (BCM secret = reverse(RFH secret))", async () => {
    const { container } = renderModuleSync();
    // BCM flat slice == reverse(RFH secret) → reverse(BCM) == RFH secret → MATCH.
    const syncBtn = await loadPair(container, {
      bcmBytes: bcmFixture({ flatSecret: RFH_SECRET_REVERSED }),
      rfhBytes: makeRfhubGen2(),
    });

    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // Both modules must export, with the canonical _SYNCED names.
    await waitFor(() => {
      expect(
        screen.getByText(/^Downloaded: BCM_SYNCED/i, { exact: false })
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/^Downloaded: RFH_SYNCED/i, { exact: false })
    ).toBeTruthy();

    // Two files actually hit disk; the gate passed rather than aborting.
    expect(clickSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Sync aborted/i, { exact: false })).toBeNull();
    expect(
      screen.getByText(/safety gate PASSED/i, { exact: false })
    ).toBeTruthy();
  });
});
