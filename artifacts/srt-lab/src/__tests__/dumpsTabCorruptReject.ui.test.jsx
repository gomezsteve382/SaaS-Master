// @vitest-environment jsdom
//
// Task #946 — the shared Dumps tab uploader (DumpsTabV2) must refuse a
// corrupt-fill capture at upload time, before it is forwarded to `loadF`
// (which persists it into the workspace via addDump). A tool-error capture
// stored as a dump could later be re-loaded into a real module slot without
// the per-tab guard re-running, so the file must never reach loadF.

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

// A 0x55-filled buffer — the OBDSTAR single-byte tool-error pattern. Sized
// large enough to clear the BCM minimum-size guard so the corrupt-fill guard
// is the branch that fires, not the too-small one.
function makeCorruptFile(name, size = 131072, byte = 0x55) {
  return new File([new Uint8Array(size).fill(byte)], name, { type: "application/octet-stream" });
}

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DumpsTabV2 — corrupt file is refused, not persisted (Task #946)", () => {
  it("rejects a single-byte-fill BCM capture and never calls loadF", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn();
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const corrupt = makeCorruptFile("BCM_55FILL.bin");
    const input = document.getElementById("u-BCM");
    await user.upload(input, corrupt);

    const card = await screen.findByTestId("dumps-corrupt-card");
    expect(card.textContent).toMatch(/Corrupt capture/i);
    expect(card.textContent).toContain("BCM_55FILL.bin");
    expect(card.getAttribute("data-corrupt-reason")).toBe("single-byte fill");

    // The corrupt file must never reach loadF (which persists via addDump).
    expect(loadF).not.toHaveBeenCalled();
    // It must not have rendered the too-small card (a different branch).
    expect(screen.queryByTestId("dumps-too-small-card")).toBeNull();
  });

  it("rejects a repeated-ASCII-error capture (OBDSTAR6) and never calls loadF", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn();
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const data = new Uint8Array(131072);
    const pat = Uint8Array.from("OBDSTAR6", c => c.charCodeAt(0));
    for (let i = 0; i < data.length; i++) data[i] = pat[i % pat.length];
    const corrupt = new File([data], "BCM_OBDSTAR6.bin", { type: "application/octet-stream" });

    const input = document.getElementById("u-BCM");
    await user.upload(input, corrupt);

    const card = await screen.findByTestId("dumps-corrupt-card");
    expect(card.getAttribute("data-corrupt-reason")).toBe("repeated ASCII string");
    expect(loadF).not.toHaveBeenCalled();
  });

  it("forwards a clean varied-byte BCM through to loadF without a corrupt card", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn();
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const buf = new Uint8Array(65536);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 97 + 13) & 0xFF;
    const clean = new File([buf], "BCM_CLEAN.bin", { type: "application/octet-stream" });

    const input = document.getElementById("u-BCM");
    await user.upload(input, clean);
    await new Promise(r => setTimeout(r, 0));

    expect(screen.queryByTestId("dumps-corrupt-card")).toBeNull();
    expect(loadF).toHaveBeenCalledTimes(1);
  });
});
