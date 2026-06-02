// @vitest-environment jsdom
//
// VIN + CHECKSUM tab — ECM / BCM / RFHUB sub-tabs (Task #1049).
//
// The tab now hosts a sub-tab bar: the original single-file PATCHER plus
// one ImmoVIN sub-tab per module. Each module sub-tab loads + parses its
// own .bin and renders the SAME shared panel the per-module main tabs use
// (Gpec2aImmoPanel / BcmImmoSection / RfhubImmoSection). This file pins:
//   - the sub-tab bar renders all four sub-tabs, PATCHER is the default
//     and keeps every existing patcher testid working.
//   - loading the real BCM corpus dump into the BCM sub-tab mounts
//     bcm-immo-panel; the XC2268 fixture mounts rfhub-immo-panel; the
//     GPEC2A bench dump mounts gpec2a-immo-panel.
//   - a type-mismatched file is refused before any panel mounts.
//   - switching sub-tabs preserves each module's loaded dump (the panels
//     stay mounted — visibility is toggled, not unmounted).
//
// jsdom traps (see .agents/memory/modulesync-ui-test-* notes): drive the
// panels through the REAL corpus / fixture buffers loaded via each
// sub-tab's file input (synthetic buffers don't parse as a real module),
// and re-query the file input before each load. URL.createObjectURL is
// stubbed so a panel export click can't throw mid-handler.

import React from "react";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, afterEach, beforeAll, expect } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

import VinProgrammerTab from "../tabs/VinProgrammerTab.jsx";
import { MasterVinProvider } from "../lib/masterVinContext.jsx";
import { makeXc2268Fixture } from "../lib/xc2268Rfhub.js";

const FIX = resolve(__dirname, "fixtures");
const ASSETS = resolve(__dirname, "../../../..", "attached_assets");
const BCM_SYNCED = "SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin";
const PCM_FILE = "19gpec2a_eeprom_1780353765789.bin";
const XC_VIN = "1C6RR7LT5KS123456";

const bcmBytes = () => new Uint8Array(readFileSync(join(FIX, BCM_SYNCED)));
const gpecBytes = () => new Uint8Array(readFileSync(join(ASSETS, PCM_FILE)));
const xcBytes = () => makeXc2268Fixture({ vin: XC_VIN, variant: 0x01 });

beforeAll(() => {
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
  }
});
afterEach(() => cleanup());

function renderTab() {
  return render(
    <MasterVinProvider>
      <VinProgrammerTab />
    </MasterVinProvider>
  );
}

async function clickSubtab(id) {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`vinprog-subtab-${id}`));
  });
}

async function loadInto(testidPrefix, bytes, name) {
  const input = screen.getByTestId(`${testidPrefix}-file-input`);
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([bytes], name, { type: "application/octet-stream" })] } });
  });
}

describe("VIN + CHECKSUM sub-tab bar", () => {
  it("renders all four sub-tabs and defaults to PATCHER with the original flow intact", () => {
    renderTab();
    expect(screen.getByTestId("vinprog-subtab-bar")).toBeTruthy();
    for (const id of ["patch", "ecm", "bcm", "rfhub"]) {
      expect(screen.getByTestId(`vinprog-subtab-${id}`)).toBeTruthy();
    }
    // PATCHER is the default sub-tab: the original single-file dropzone is
    // present and the module sub-tabs are not yet showing their loaders.
    expect(screen.getByTestId("vinprog-dropzone")).toBeTruthy();
  });
});

describe("BCM sub-tab", () => {
  it("loads the BCM corpus dump and mounts the shared BCM ImmoVIN panel", async () => {
    renderTab();
    await clickSubtab("bcm");
    await loadInto("vinprog-bcm", bcmBytes(), BCM_SYNCED);
    await waitFor(() => expect(screen.getByTestId("bcm-immo-panel")).toBeTruthy());
  });

  it("refuses a non-BCM file before any panel mounts", async () => {
    renderTab();
    await clickSubtab("bcm");
    await loadInto("vinprog-bcm", gpecBytes(), PCM_FILE);
    expect(screen.queryByTestId("bcm-immo-panel")).toBeNull();
    // A refusal naming the expected module is surfaced.
    expect(
      screen.getByTestId("vinprog-bcm-subtab").textContent
    ).toMatch(/load a BCM dump/i);
  });
});

describe("RFHUB sub-tab", () => {
  it("loads the XC2268 fixture and mounts the shared RFHUB ImmoVIN panel", async () => {
    renderTab();
    await clickSubtab("rfhub");
    await loadInto("vinprog-rfhub", xcBytes(), "rfhub_xc2268.bin");
    await waitFor(() => expect(screen.getByTestId("rfhub-immo-panel")).toBeTruthy());
  });
});

describe("ECM sub-tab", () => {
  it("loads the GPEC2A bench dump and mounts the shared GPEC2A immo panel", async () => {
    renderTab();
    await clickSubtab("ecm");
    await loadInto("vinprog-ecm", gpecBytes(), PCM_FILE);
    await waitFor(() => expect(screen.getByTestId("gpec2a-immo-panel")).toBeTruthy());
  });
});

describe("sub-tab state isolation", () => {
  it("preserves each module's loaded dump when switching sub-tabs", async () => {
    renderTab();

    await clickSubtab("bcm");
    await loadInto("vinprog-bcm", bcmBytes(), BCM_SYNCED);
    await waitFor(() => expect(screen.getByTestId("bcm-immo-panel")).toBeTruthy());

    await clickSubtab("rfhub");
    await loadInto("vinprog-rfhub", xcBytes(), "rfhub_xc2268.bin");
    await waitFor(() => expect(screen.getByTestId("rfhub-immo-panel")).toBeTruthy());

    // Go back to PATCHER and then to BCM — the BCM panel is still mounted
    // (state survived because sub-tabs are visibility-toggled, not torn
    // down) and the patcher is still available.
    await clickSubtab("patch");
    expect(screen.getByTestId("vinprog-dropzone")).toBeTruthy();
    expect(screen.getByTestId("bcm-immo-panel")).toBeTruthy();
    expect(screen.getByTestId("rfhub-immo-panel")).toBeTruthy();
  });
});
