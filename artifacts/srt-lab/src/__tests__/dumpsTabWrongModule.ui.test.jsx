// @vitest-environment jsdom
//
// Task #484 — wrong-module guard, end-to-end via the per-vehicle Dumps tab.
//
// The slot-aware classifier added in Task #483 only flips the type when
// the buffer size is canonical for the slot's family (e.g. 4 KB / 8 KB
// into the PCM slot). A 64 KB BCM dropped into the PCM slot bypassed
// both the slot override AND `moduleTooSmall`, so the file silently
// landed in workspace state typed as a BCM. This test pins down the
// new wrong-module rejection card for the three documented mistake
// scenarios.

import React, { useState } from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DumpsTabV2 } from "../App.jsx";
import { VEHICLES } from "../lib/vehicles.js";

function Harness({ vehicle, loadF }) {
  const [files, setFiles] = useState([]);
  return (
    <DumpsTabV2
      vehicle={vehicle}
      files={files}
      setFiles={setFiles}
      loadF={loadF}
      onGoSync={() => {}}
    />
  );
}

function makeFile(name, size, fill = 0x00) {
  const buf = new Uint8Array(size).fill(fill);
  return new File([buf], name, { type: "application/octet-stream" });
}

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DumpsTabV2 — wrong-module guard (Task #484)", () => {
  it("rejects a 64 KB BCM dropped into the PCM slot before reaching loadF", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn(() => Promise.resolve({ acceptedFiles: [], rejected: [] }));
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const file = makeFile("BCM_DUMP.bin", 65536);
    const input = document.getElementById("u-PCM / GPEC2A");
    await user.upload(input, file);

    const card = await screen.findByTestId("dumps-wrong-module-card");
    expect(card.getAttribute("data-detected-type")).toBe("BCM");
    expect(card.getAttribute("data-slot-type")).toBe("PCM");
    expect(card.textContent).toMatch(/looks like a BCM/);
    expect(card.textContent).toContain("BCM_DUMP.bin");
    expect(card.textContent).toContain("65,536 bytes");
    // The matching too-small card must NOT also fire — the wrong-module
    // guard short-circuits the `moduleTooSmall` fallback.
    expect(screen.queryByTestId("dumps-too-small-card")).toBeNull();

    // And the file must not have been added to workspace state.
    await new Promise(r => setTimeout(r, 0));
    expect(loadF).not.toHaveBeenCalled();
  });

  it("rejects an 8 KB 95640 dropped into the BCM slot before reaching loadF", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn(() => Promise.resolve({ acceptedFiles: [], rejected: [] }));
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    // Generic filename so the wrong-module guard has to rely on size +
    // slot context, not a filename hint.
    const file = makeFile("dump.bin", 8192, 0xFF);
    const input = document.getElementById("u-BCM");
    await user.upload(input, file);

    const card = await screen.findByTestId("dumps-wrong-module-card");
    expect(card.getAttribute("data-detected-type")).toBe("95640");
    expect(card.getAttribute("data-slot-type")).toBe("BCM");
    // 8 KB matches BOTH 95640 and GPEC2A — both should appear in the
    // candidates listing for transparency.
    expect(card.textContent).toMatch(/95640.*GPEC2A|95640 \/ GPEC2A/);
    expect(card.textContent).toContain("dump.bin");
    expect(card.textContent).toContain("8,192 bytes");
    expect(screen.queryByTestId("dumps-too-small-card")).toBeNull();

    await new Promise(r => setTimeout(r, 0));
    expect(loadF).not.toHaveBeenCalled();
  });

  it("rejects a 2 KB Gen1 RFHUB dropped into the PCM slot before reaching loadF", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn(() => Promise.resolve({ acceptedFiles: [], rejected: [] }));
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const file = makeFile("rfh_gen1.bin", 2048, 0xFF);
    const input = document.getElementById("u-PCM / GPEC2A");
    await user.upload(input, file);

    const card = await screen.findByTestId("dumps-wrong-module-card");
    expect(card.getAttribute("data-detected-type")).toBe("RFHUB");
    expect(card.getAttribute("data-slot-type")).toBe("PCM");
    expect(card.textContent).toMatch(/looks like a RFHUB/);
    expect(card.textContent).toContain("rfh_gen1.bin");
    expect(card.textContent).toContain("2,048 bytes");
    expect(screen.queryByTestId("dumps-too-small-card")).toBeNull();

    await new Promise(r => setTimeout(r, 0));
    expect(loadF).not.toHaveBeenCalled();
  });

  it("does NOT flag a canonical 4 KB PCM dropped into the PCM slot", async () => {
    // Sanity check — the wrong-module guard must stay quiet for valid
    // slot-correct uploads so it doesn't shadow the existing #483
    // happy path.
    const user = userEvent.setup();
    const loadF = vi.fn(() => Promise.resolve({ acceptedFiles: [], rejected: [] }));
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const file = makeFile("donor_pcm.bin", 4096, 0xFF);
    const input = document.getElementById("u-PCM / GPEC2A");
    await user.upload(input, file);

    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByTestId("dumps-wrong-module-card")).toBeNull();
    expect(screen.queryByTestId("dumps-too-small-card")).toBeNull();
    expect(loadF).toHaveBeenCalledTimes(1);
    const [accepted, slotType] = loadF.mock.calls[0];
    expect(slotType).toBe("PCM");
    expect(accepted).toHaveLength(1);
  });
});
