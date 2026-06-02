// @vitest-environment jsdom
//
// UI tests for the two new in-tab ImmoVIN workbench sections that render
// through the shared ImmoChecksumPanel:
//   - BcmImmoSection  (wired into BcmTab's BCM DUMP INSPECTOR)
//   - RfhubImmoSection (wired into RfhubTab's inspector, XC2268 only)
//
// Both are presentational/controlled components driven entirely by their
// `mod` prop ({data, filename, size}), so we render them directly with a
// real corpus fixture (BCM) / synthetic XC2268 fixture rather than driving
// the whole tab — this keeps the test off the jsdom file-input / stale-node
// traps documented in .agents/memory/modulesync-ui-test-* while still
// exercising the shared panel model, the apply path, and the safety gate.
//
// The download side-effect (runGatedExport → dl → URL.createObjectURL +
// <a>.click) is stubbed so a clean gate verdict can't throw mid-handler.

import React from "react";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, afterEach, beforeAll, expect } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

import BcmImmoSection from "../components/BcmImmoSection.jsx";
import RfhubImmoSection from "../components/RfhubImmoSection.jsx";
import { makeXc2268Fixture } from "../lib/xc2268Rfhub.js";

const FIX = resolve(__dirname, "fixtures");
const BCM_SYNCED = "SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin";
const BCM_VIN = "2C3CDXL90MH582899";
const XC_VIN = "1C6RR7LT5KS123456";

function bcmMod() {
  const data = new Uint8Array(readFileSync(join(FIX, BCM_SYNCED)));
  return { data, filename: BCM_SYNCED, size: data.length };
}
function xcMod() {
  const data = makeXc2268Fixture({ vin: XC_VIN, variant: 0x01 });
  return { data, filename: "rfhub_xc2268.bin", size: data.length };
}

beforeAll(() => {
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
  }
});
afterEach(() => cleanup());

describe("BcmImmoSection — shared panel render", () => {
  it("renders the panel, analysis cards, VIN-by-offset table and SEC16 section", () => {
    render(<BcmImmoSection mod={bcmMod()} />);
    const panel = within(screen.getByTestId("bcm-immo-panel"));

    expect(panel.getByText(/BCM IMMO \/ VIN WORKBENCH/i)).toBeTruthy();
    expect(panel.getByText(/BCM ANALYSIS/i)).toBeTruthy();
    expect(panel.getByText(/VINs BY OFFSET/i)).toBeTruthy();
    expect(panel.getByText(/SEC16 RECORDS \/ VERDICTS/i)).toBeTruthy();

    // The synced Charger BCM resolves its VIN across multiple slots.
    expect(panel.getAllByText(BCM_VIN).length).toBeGreaterThanOrEqual(2);
  });

  it("re-stamps a new VIN and surfaces the gated-download success status", async () => {
    render(<BcmImmoSection mod={bcmMod()} />);
    const panel = within(screen.getByTestId("bcm-immo-panel"));

    const vinInput = panel.getByTestId("bcm-immo-vin-input");
    await act(async () => {
      fireEvent.change(vinInput, { target: { value: "2C3CDXL90MH000001" } });
    });
    expect(vinInput.value).toBe("2C3CDXL90MH000001");

    await act(async () => {
      fireEvent.click(panel.getByTestId("bcm-immo-apply-btn"));
    });

    const status = screen.getByTestId("bcm-immo-status");
    expect(status.textContent).toMatch(/BCM re-stamped/);
    expect(status.textContent).toMatch(/passed safety gate/);
  });

  it("rejects a short VIN before any export", async () => {
    render(<BcmImmoSection mod={bcmMod()} />);
    const panel = within(screen.getByTestId("bcm-immo-panel"));

    await act(async () => {
      fireEvent.change(panel.getByTestId("bcm-immo-vin-input"), { target: { value: "TOOSHORT" } });
    });
    await act(async () => {
      fireEvent.click(panel.getByTestId("bcm-immo-apply-btn"));
    });

    expect(screen.getByTestId("bcm-immo-status").textContent).toMatch(/17-character VIN/i);
  });
});

describe("RfhubImmoSection — XC2268 only", () => {
  it("renders the XC2268 panel, VIN table and re-stamps a VIN through the gate", async () => {
    render(<RfhubImmoSection mod={xcMod()} />);
    const panel = within(screen.getByTestId("rfhub-immo-panel"));

    expect(panel.getByText(/RFHUB IMMO \/ VIN WORKBENCH/i)).toBeTruthy();
    expect(panel.getByText(/RFHUB ANALYSIS/i)).toBeTruthy();
    expect(panel.getAllByText(XC_VIN).length).toBeGreaterThanOrEqual(3);

    await act(async () => {
      fireEvent.change(panel.getByTestId("rfhub-immo-vin-input"), { target: { value: "1C6RR7LT5LS654321" } });
    });
    await act(async () => {
      fireEvent.click(panel.getByTestId("rfhub-immo-apply-btn"));
    });

    expect(screen.getByTestId("rfhub-immo-status").textContent).toMatch(/RFHUB re-stamped/);
    expect(screen.getByTestId("rfhub-immo-status").textContent).toMatch(/passed safety gate/);
  });

  it("renders nothing for a non-XC2268 RFHUB image", () => {
    const data = new Uint8Array(0x10000).fill(0xAA);
    const { container } = render(<RfhubImmoSection mod={{ data, filename: "legacy.bin", size: data.length }} />);
    expect(container.firstChild).toBeNull();
  });
});
