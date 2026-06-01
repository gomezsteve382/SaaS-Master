// @vitest-environment jsdom
//
// Task #948 — warn when an already-loaded dump turns out to be corrupt.
//
// The upload-time corrupt-fill guard rejects bad captures before they enter
// the workspace, but per-module inspectors (ECM/ADCM/BCM/RFHUB) can still
// render buffers that were loaded before that guard existed (or restored from
// an older backup). CorruptDumpBanner turns a parsed module's `corruptFill`
// flag into a consistent, red, blocking warning that those tabs drop in
// unconditionally. This suite freezes that contract: it renders nothing for a
// clean module, and a labelled warning carrying the corrupt reason otherwise.

import React from "react";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import CorruptDumpBanner from "../CorruptDumpBanner.jsx";

afterEach(() => cleanup());

describe("CorruptDumpBanner (Task #948)", () => {
  it("renders nothing for a clean module", () => {
    const { container } = render(<CorruptDumpBanner mod={{ type: "BCM", vin: "X" }} testid="t" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("t")).toBeNull();
  });

  it("renders nothing when no module is supplied", () => {
    const { container } = render(<CorruptDumpBanner mod={null} testid="t" />);
    expect(container.firstChild).toBeNull();
  });

  it("warns and surfaces file/module/reason when the module is corrupt", () => {
    const mod = {
      type: "RFHUB",
      filename: "RFHUB_BAD.bin",
      size: 65536,
      corruptFill: { reason: "repeated ASCII string", detail: "98% 'OBDSTAR6'" },
    };
    render(<CorruptDumpBanner mod={mod} testid="rfhub-corrupt-dump-banner" />);

    const banner = screen.getByTestId("rfhub-corrupt-dump-banner");
    expect(banner).toBeTruthy();
    expect(banner.getAttribute("data-corrupt-reason")).toBe("repeated ASCII string");
    expect(banner.textContent).toMatch(/looks corrupt/i);
    expect(banner.textContent).toContain("RFHUB_BAD.bin");
    expect(banner.textContent).toContain("RFHUB");
    expect(banner.textContent).toContain("repeated ASCII string");
  });

  it("uses the testid passed by each tab so the 4 inspectors stay distinguishable", () => {
    const mod = { type: "BCM", corruptFill: { reason: "single-byte fill" } };
    render(<CorruptDumpBanner mod={mod} testid="bcm-corrupt-dump-banner" />);
    expect(screen.getByTestId("bcm-corrupt-dump-banner")).toBeTruthy();
  });
});
