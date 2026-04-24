// @vitest-environment jsdom
//
// Task #447 — UI smoke for the pre-share leak scanner panel.
//
// Locks the user-visible behaviour the task spec calls out:
//   1. Skip-don't-fail when no VIN is in scope: the scan button stays
//      disabled and a hint tells the user how to enable the scan.
//   2. A clean BCM buffer scanned with the user's known VIN renders the
//      "Clean — no leaks detected" affordance.
//   3. A BCM buffer with the donor VIN dropped at an undocumented offset
//      renders a "Leak found at 0xNNNN — kind" callout.
//   4. The module-type pre-selector picks BCM / RFHUB / PCM from the
//      filename of the dropped backup so the tech doesn't have to choose
//      manually for the common case.

import React from "react";
import { describe, it, afterEach, expect } from "vitest";
import { act, fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";

import LeakScanPanel from "../components/LeakScanPanel.jsx";
import { MasterVinProvider, useMasterVin } from "../lib/masterVinContext.jsx";
import {
  vinAsBytes, BCM_FULL_VIN_BASES, BCM_PARTIAL_VIN_OFFSETS, VIN_LEN,
} from "../lib/donorLeakScan.js";

const DONOR = "JC3CDXBT5HW123456";
const ANON  = "ZZZZZZZZZZZZZZZZZ";

afterEach(() => cleanup());

function buildCleanBcmBuffer() {
  const buf = new Uint8Array(0x10000).fill(0xFF);
  const anonBytes = vinAsBytes(ANON);
  for (const base of BCM_FULL_VIN_BASES) {
    const off = base + 8;
    for (let i = 0; i < VIN_LEN; i++) buf[off + i] = anonBytes[i];
  }
  const tail = anonBytes.slice(9);
  for (const po of BCM_PARTIAL_VIN_OFFSETS) {
    for (let i = 0; i < 8; i++) buf[po + i] = tail[i];
  }
  return buf;
}

async function dropFile(name, bytes) {
  const input = screen.getByTestId("leak-scan-file-input");
  const file = new File([bytes], name, { type: "application/octet-stream" });
  // jsdom won't let us assign FileList directly; redefine the getter.
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => ({
      0: file,
      length: 1,
      item: (i) => (i === 0 ? file : null),
    }),
  });
  await act(async () => { fireEvent.change(input); });
  // Allow the async `arrayBuffer()` read inside handleFile to settle so
  // the file display + module-type auto-pick paint before we assert.
  // The drop label flips from "Click to choose…" → showing the filename.
  await waitFor(() => {
    const drop = screen.getByTestId("leak-scan-file-drop");
    if (/Click to choose/.test(drop.textContent)) {
      throw new Error("file not yet loaded; current label: " + drop.textContent);
    }
  });
}

// Tiny helper that primes the MasterVin context with a starting VIN before
// the panel mounts; mirrors how the rest of the app feeds the same context.
function SeedVin({ vin, children }) {
  const ctx = useMasterVin();
  React.useEffect(() => { if (vin) ctx.setVin(vin); }, [vin, ctx]);
  return children;
}

function renderPanel(vin = "") {
  return render(
    <MasterVinProvider setPg={() => {}}>
      <SeedVin vin={vin}>
        <LeakScanPanel />
      </SeedVin>
    </MasterVinProvider>,
  );
}

describe("LeakScanPanel — task #447", () => {
  it("disables the scan button and shows the helper hint when no VIN is in scope", () => {
    renderPanel("");
    const btn = screen.getByTestId("leak-scan-run");
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Enter your Master VIN/i)).toBeTruthy();
  });

  it("auto-picks the BCM module type from a `BCM_…` filename", async () => {
    renderPanel(DONOR);
    await dropFile("BCM_SYNCED_ZZZZZZZZZZZZZZZZZ_20260424_120000.bin", buildCleanBcmBuffer());

    const bcmBtn = screen.getByTestId("leak-scan-mt-bcm");
    const rfhBtn = screen.getByTestId("leak-scan-mt-rfhub");
    // Active state colours the border with the accent (a2 = #00BFA5);
    // inactive ones use the neutral surface border (bd = #E8E4DE).
    expect(bcmBtn.style.borderColor.toLowerCase()).toBe("rgb(0, 191, 165)");
    expect(rfhBtn.style.borderColor.toLowerCase()).toBe("rgb(232, 228, 222)");
  });

  it("renders 'Clean — no leaks detected' for a fully-scrubbed BCM buffer", async () => {
    renderPanel(DONOR);
    await dropFile("BCM_SYNCED_ZZZZZZZZZZZZZZZZZ.bin", buildCleanBcmBuffer());

    const btn = screen.getByTestId("leak-scan-run");
    expect(btn.hasAttribute("disabled")).toBe(false);
    await act(async () => { fireEvent.click(btn); });

    const ok = await waitFor(() => screen.getByTestId("leak-scan-result-clean"));
    expect(ok.textContent).toMatch(/Clean — no leaks detected/i);
    expect(ok.textContent).toMatch(/JC3CDXBT5HW123456/);
  });

  it("renders 'Leak found at 0xNNNN — kind' when the donor VIN appears at an undocumented offset", async () => {
    const buf = buildCleanBcmBuffer();
    const donorBytes = vinAsBytes(DONOR);
    const leakOff = 0x1000;
    for (let i = 0; i < VIN_LEN; i++) buf[leakOff + i] = donorBytes[i];

    renderPanel(DONOR);
    await dropFile("BCM_SYNCED_DONOR.bin", buf);
    await act(async () => { fireEvent.click(screen.getByTestId("leak-scan-run")); });

    const bad = await waitFor(() => screen.getByTestId("leak-scan-result-leak"));
    expect(bad.textContent).toMatch(/Leak found at 0x1000/);
    expect(bad.textContent).toMatch(/donor-vin-forward/);
  });
});
