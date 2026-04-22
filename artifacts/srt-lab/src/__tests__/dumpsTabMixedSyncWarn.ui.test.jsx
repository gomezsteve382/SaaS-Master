// @vitest-environment jsdom
//
// Task #334: warn before running a sync that mixes registry-checked and
// override files. Covers the runFullSync path on the Dumps tab.

import React, { useState } from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
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
function makeRfh(name) {
  const data = new Uint8Array(32768).fill(0xff);
  return { name, size: data.length, type: "RFHUB", data };
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

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  // Stub the file-download path so the JSDOM env doesn't choke on URL.createObjectURL
  if (!URL.createObjectURL) URL.createObjectURL = () => "blob:fake";
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {};
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DumpsTabV2 — mixed-sync warning (Task #334)", () => {
  it("does NOT prompt when every loaded file is registry-checked", async () => {
    const user = userEvent.setup();
    const bcm = makeBcm("BCM_OK.bin", "68396563");
    const rfh = makeRfh("RFH_OK.bin");
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, rfh]} />);

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const vinInput = screen.getByPlaceholderText(/Enter customer .* VIN/i);
    await user.type(vinInput, VALID_VIN);
    await user.click(screen.getByText(/SYNC ALL MODULES/));

    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("prompts and aborts when one file is override and another is registry-checked, and the user clicks Cancel", async () => {
    const user = userEvent.setup();
    // BCM is unregistered → user will Load Anyway (override).
    const bcm = makeBcm("BCM_FAKE.bin", "68999999");
    // RFHUB has no P/N analysis path — counts as registry-checked (no override).
    const rfh = makeRfh("RFH_OK.bin");
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, rfh]} />);

    // Apply the override on BCM.
    const blocker = await screen.findByTestId("dump-blocker");
    await user.click(within(blocker).getByText(/LOAD ANYWAY/));
    await screen.findByTestId("pn-override-pill");

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const vinInput = screen.getByPlaceholderText(/Enter customer .* VIN/i);
    await user.type(vinInput, VALID_VIN);
    await user.click(screen.getByText(/SYNC ALL MODULES/));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const promptText = confirmSpy.mock.calls[0][0];
    expect(promptText).toMatch(/Mixed sync warning/);
    expect(promptText).toMatch(/BCM/);
    expect(promptText).toMatch(/RFHUB/);
    // Cancellation should surface a status message instead of running the sync.
    expect(await screen.findByText(/Sync cancelled/i)).toBeTruthy();
  });

  it("prompts and proceeds when the user clicks OK on the warning", async () => {
    const user = userEvent.setup();
    const bcm = makeBcm("BCM_FAKE.bin", "68999999");
    const rfh = makeRfh("RFH_OK.bin");
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[bcm, rfh]} />);

    const blocker = await screen.findByTestId("dump-blocker");
    await user.click(within(blocker).getByText(/LOAD ANYWAY/));

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const vinInput = screen.getByPlaceholderText(/Enter customer .* VIN/i);
    await user.type(vinInput, VALID_VIN);
    await user.click(screen.getByText(/SYNC ALL MODULES/));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // No "cancelled" message because the user accepted.
    expect(screen.queryByText(/Sync cancelled/i)).toBeNull();
  });
});
