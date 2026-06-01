// @vitest-environment jsdom
//
// Task #931 — vault-side corrupt-fill scan.
//
// The upload-time guard only fires on new drops. Files that were stored in
// the workspace before the guard existed (e.g. the seven OBDSTAR6 BCM dumps
// from the incident report) are already in the `files` array and will never
// be re-uploaded. This suite pins down the retroactive scan that runs
// detectCorruptFill on every loaded buffer whenever the Dumps tab renders.

import React, { useState } from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DumpsTabV2 } from "../App.jsx";
import { VEHICLES } from "../lib/vehicles.js";

// Build a Uint8Array of `size` bytes tiled with `pattern`.
function makeFill(pattern, size) {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = pattern[i % pattern.length];
  return buf;
}

function ascii(str) {
  return Uint8Array.from(str, c => c.charCodeAt(0));
}

// Construct a file object that looks like it came out of analyzeFile / loadF
// (the workspace state shape: {name, size, type, data}).
function makeStoredFile(name, type, data) {
  return { name, size: data.length, type, data };
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ─── Badge rendering ──────────────────────────────────────────────────────────

describe("DumpsTabV2 vault — corrupt fill badge (Task #931)", () => {
  it("shows the corrupt badge for a BCM filled with OBDSTAR6 pattern already in the vault", async () => {
    const data = makeFill(ascii("OBDSTAR6"), 131072);
    const file = makeStoredFile("BCM_OBDSTAR6.bin", "BCM", data);
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[file]} />);

    const badge = await screen.findByTestId("dumps-corrupt-fill-badge");
    expect(badge.textContent).toContain("Corrupt capture");
    expect(badge.textContent).toContain("BCM_OBDSTAR6.bin");
  });

  it("badge carries data-corrupt-reason attribute identifying the fill type", async () => {
    const data = makeFill(ascii("OBDSTAR6"), 131072);
    const file = makeStoredFile("BCM_BAD.bin", "BCM", data);
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[file]} />);

    const badge = await screen.findByTestId("dumps-corrupt-fill-badge");
    expect(badge.getAttribute("data-corrupt-reason")).toBe("repeated ASCII string");
  });

  it("badge carries data-file-index pointing to the correct slot", async () => {
    const cleanData = new Uint8Array(65536).fill(0xFF);
    const cleanFile = makeStoredFile("CLEAN_BCM.bin", "BCM", cleanData);
    const corruptData = makeFill(ascii("OBDSTAR6"), 131072);
    const corruptFile = makeStoredFile("CORRUPT_BCM.bin", "BCM", corruptData);
    // Corrupt file at index 1.
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[cleanFile, corruptFile]} />);

    const badge = await screen.findByTestId("dumps-corrupt-fill-badge");
    expect(badge.getAttribute("data-file-index")).toBe("1");
  });

  it("shows one badge per corrupt entry when multiple corrupt files are loaded", async () => {
    const corruptBcm = makeStoredFile("BCM_BAD.bin", "BCM", makeFill(ascii("OBDSTAR6"), 131072));
    const corruptRfh = makeStoredFile("RFH_BAD.bin", "RFHUB", makeFill(ascii("NO DATA"), 65536));
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[corruptBcm, corruptRfh]} />);

    const badges = await screen.findAllByTestId("dumps-corrupt-fill-badge");
    expect(badges).toHaveLength(2);
  });

  it("shows NO badge for a clean BCM with varied bytes", () => {
    const buf = new Uint8Array(65536);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 97 + 13) & 0xFF;
    const file = makeStoredFile("CLEAN_BCM.bin", "BCM", buf);
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[file]} />);

    expect(screen.queryByTestId("dumps-corrupt-fill-badge")).toBeNull();
  });

  it("shows NO badge for an all-0xFF buffer (legitimate virgin module)", () => {
    const file = makeStoredFile("VIRGIN_BCM.bin", "BCM", new Uint8Array(65536).fill(0xFF));
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[file]} />);

    expect(screen.queryByTestId("dumps-corrupt-fill-badge")).toBeNull();
  });

  it("shows the corrupt badge for a 0x55-fill (OBDSTAR tool error byte pattern)", async () => {
    const file = makeStoredFile("BCM_55FILL.bin", "BCM", new Uint8Array(131072).fill(0x55));
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[file]} />);

    const badge = await screen.findByTestId("dumps-corrupt-fill-badge");
    expect(badge.getAttribute("data-corrupt-reason")).toBe("single-byte fill");
    expect(badge.textContent).toContain("BCM_55FILL.bin");
  });
});

// ─── SYNC ALL MODULES disabled ────────────────────────────────────────────────

describe("DumpsTabV2 vault — SYNC ALL disabled for corrupt core module", () => {
  it("disables SYNC ALL MODULES when a corrupt BCM is in the slot", () => {
    const corruptBcm = makeStoredFile("BCM_BAD.bin", "BCM", makeFill(ascii("OBDSTAR6"), 131072));
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[corruptBcm]} />);

    const syncBtn = screen.getByText(/SYNC ALL MODULES/).closest("button");
    expect(syncBtn.hasAttribute("disabled")).toBe(true);
  });

  it("puts an explanatory tooltip on the disabled SYNC ALL button", () => {
    const corruptBcm = makeStoredFile("BCM_BAD.bin", "BCM", makeFill(ascii("OBDSTAR6"), 131072));
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[corruptBcm]} />);

    const syncBtn = screen.getByText(/SYNC ALL MODULES/).closest("button");
    const title = syncBtn.getAttribute("title");
    expect(title).not.toBeNull();
    expect(title).toMatch(/corrupt/i);
  });
});

// ─── REMOVE button ────────────────────────────────────────────────────────────

describe("DumpsTabV2 vault — REMOVE button on corrupt badge", () => {
  it("removes the corrupt file from the vault when REMOVE is clicked", async () => {
    const user = userEvent.setup();
    const corruptBcm = makeStoredFile("BCM_OBDSTAR6.bin", "BCM", makeFill(ascii("OBDSTAR6"), 131072));
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[corruptBcm]} />);

    const badge = await screen.findByTestId("dumps-corrupt-fill-badge");
    const removeBtn = within(badge).getByRole("button", { name: /REMOVE/i });
    await user.click(removeBtn);

    // After removal the badge must disappear.
    expect(screen.queryByTestId("dumps-corrupt-fill-badge")).toBeNull();
  });

  it("removes only the targeted corrupt file when two are loaded", async () => {
    const user = userEvent.setup();
    const corruptBcm = makeStoredFile("BCM_BAD.bin", "BCM", makeFill(ascii("OBDSTAR6"), 131072));
    const corruptRfh = makeStoredFile("RFH_BAD.bin", "RFHUB", makeFill(ascii("NO DATA"), 65536));
    render(<Harness vehicle={VEHICLES.charger} initialFiles={[corruptBcm, corruptRfh]} />);

    const badges = await screen.findAllByTestId("dumps-corrupt-fill-badge");
    expect(badges).toHaveLength(2);

    // Remove the first one.
    const firstRemove = within(badges[0]).getByRole("button", { name: /REMOVE/i });
    await user.click(firstRemove);

    // Only one badge should remain.
    const remaining = screen.getAllByTestId("dumps-corrupt-fill-badge");
    expect(remaining).toHaveLength(1);
  });
});
