// @vitest-environment jsdom
//
// Task #373 regression — the shared Dumps tab uploader (DumpsTabV2) must
// reject undersized module files at upload time using `moduleTooSmall`,
// instead of routing them into the workspace where per-tab inspectors
// are now the only thing catching them.

import React, { useState } from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DumpsTabV2 } from "../App.jsx";
import { VEHICLES } from "../lib/vehicles.js";
import { MODULE_MIN_SIZES, MODULE_MIN_LABELS } from "../lib/parseModule.js";

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

function makeFile(name, size) {
  return new File([new Uint8Array(size)], name, { type: "application/octet-stream" });
}

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DumpsTabV2 — upload-time size guard (Task #373)", () => {
  it("rejects an undersized RFHUB fragment with the structured card and does not call loadF", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn();
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const fragment = makeFile("RFH_FRAGMENT.bin", 512);
    const input = document.getElementById("u-RFHUB");
    await user.upload(input, fragment);

    const card = await screen.findByTestId("dumps-too-small-card");
    expect(card.textContent).toMatch(/isn['’]t a full RFHUB dump/i);
    expect(card.textContent).toContain("RFH_FRAGMENT.bin");
    expect(card.textContent).toContain("512 bytes");
    expect(card.textContent).toContain(MODULE_MIN_SIZES.RFHUB.toLocaleString());
    expect(card.textContent).toContain(MODULE_MIN_LABELS.RFHUB);

    expect(loadF).not.toHaveBeenCalled();
  });

  it("rejects an undersized PCM fragment with the structured card and does not call loadF", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn();
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const fragment = makeFile("PCM_FRAGMENT.bin", 1024);
    const input = document.getElementById("u-PCM / GPEC2A");
    await user.upload(input, fragment);

    const card = await screen.findByTestId("dumps-too-small-card");
    expect(card.textContent).toMatch(/isn['’]t a full PCM dump/i);
    expect(card.textContent).toContain("PCM_FRAGMENT.bin");
    expect(card.textContent).toContain("1,024 bytes");
    expect(card.textContent).toContain(MODULE_MIN_SIZES.PCM.toLocaleString());

    expect(loadF).not.toHaveBeenCalled();
  });

  it("rejects an undersized fragment with a generic filename when uploaded through the RFHUB slot (slot type is authoritative)", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn();
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    // Generic filename — no module hint. Should still be rejected because
    // the RFHUB slot itself names the intended module.
    const fragment = makeFile("dump.bin", 256);
    const input = document.getElementById("u-RFHUB");
    await user.upload(input, fragment);

    const card = await screen.findByTestId("dumps-too-small-card");
    expect(card.textContent).toMatch(/isn['’]t a full RFHUB dump/i);
    expect(card.textContent).toContain("dump.bin");
    expect(card.textContent).toContain("256 bytes");

    expect(loadF).not.toHaveBeenCalled();
  });

  it("rejects an undersized fragment with a generic filename when uploaded through the PCM slot (slot type is authoritative)", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn();
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const fragment = makeFile("misc.eep", 1024);
    const input = document.getElementById("u-PCM / GPEC2A");
    await user.upload(input, fragment);

    const card = await screen.findByTestId("dumps-too-small-card");
    expect(card.textContent).toMatch(/isn['’]t a full PCM dump/i);
    expect(card.textContent).toContain("misc.eep");
    expect(card.textContent).toContain("1,024 bytes");
    expect(card.textContent).toContain(".eep");

    expect(loadF).not.toHaveBeenCalled();
  });

  it("forwards a full-sized BCM file through to loadF without rendering a rejection card", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn();
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const fullBcm = makeFile("BCM_FULL.bin", 65536);
    const input = document.getElementById("u-BCM");
    await user.upload(input, fullBcm);

    // Wait for the async FileReader chain to settle.
    await new Promise(r => setTimeout(r, 0));

    expect(screen.queryByTestId("dumps-too-small-card")).toBeNull();
    expect(loadF).toHaveBeenCalledTimes(1);
    const passed = loadF.mock.calls[0][0];
    expect(passed.length).toBe(1);
    expect(passed[0].name).toBe("BCM_FULL.bin");
  });
});
