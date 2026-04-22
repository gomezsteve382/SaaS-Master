// @vitest-environment jsdom
//
// Tests for the "Load anyway (P/N not in registry)" override on the dumps tab.
// Covers two flows:
//   1. An unregistered P/N (68999999) shows the blocker; clicking "Load anyway"
//      flips the file to compatible and renders a yellow "P/N override" pill.
//   2. The newly-registered 68396563 dump loads cleanly into the Charger
//      workspace with no blocker at all.

import React, { useState } from "react";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DumpsTabV2 } from "../App.jsx";
import { VEHICLES } from "../lib/vehicles.js";

const enc = new TextEncoder();

function makeBcmFile(name, embeddedString) {
  const data = new Uint8Array(65536).fill(0xff);
  data.set(enc.encode(embeddedString), 0x100);
  return { name, size: data.length, type: "BCM", data };
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
});
afterEach(() => { cleanup(); });

describe("DumpsTabV2 — P/N override", () => {
  it("shows the blocker for an unregistered P/N and clears it when 'Load anyway' is clicked, attaching a pill to the file row", async () => {
    const user = userEvent.setup();
    const fakeFile = makeBcmFile("FAKE_BCM.bin", "68999999");
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[fakeFile]} />);

    // Blocker is rendered with the unregistered P/N.
    const blocker = await screen.findByTestId("dump-blocker");
    expect(within(blocker).getByText(/INCOMPATIBLE DUMP BLOCKED/)).toBeTruthy();
    expect(within(blocker).getByText("68999999")).toBeTruthy();

    // No pill yet.
    expect(screen.queryByTestId("pn-override-pill")).toBeNull();

    // Click "Load anyway".
    await user.click(within(blocker).getByText(/LOAD ANYWAY/));

    // Blocker disappears, pill appears on the file row.
    expect(screen.queryByTestId("dump-blocker")).toBeNull();
    const pill = await screen.findByTestId("pn-override-pill");
    expect(pill.textContent).toMatch(/NOT IN REGISTRY/);
  });

  it("loads a 68396563 dump into the Charger workspace with no blocker (newly registered P/N)", () => {
    const realFile = makeBcmFile("CHARGER_BCM_68396563.bin", "68396563");
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[realFile]} />);

    // No incompatibility blocker should ever surface.
    expect(screen.queryByTestId("dump-blocker")).toBeNull();
    // No override pill either — file loaded through the registered path.
    expect(screen.queryByTestId("pn-override-pill")).toBeNull();
  });

  it("still blocks 68396563 in the Trackhawk workspace (registration is scoped to LD/LC/WD only)", () => {
    const realFile = makeBcmFile("MISLOADED.bin", "68396563");
    render(<Harness vehicle={VEHICLES.trackhawk} initialFiles={[realFile]} />);

    const blocker = screen.getByTestId("dump-blocker");
    expect(within(blocker).getByText("68396563")).toBeTruthy();
  });
});
