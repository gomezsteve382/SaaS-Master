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
import { render, screen, cleanup, fireEvent, act, waitFor, within } from "@testing-library/react";

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

// The patched-buffer refresh path (onBcmPatched): the BCM ImmoVIN panel
// runs a safety-gated export and hands the patched bytes back to the
// parent's onPatched. VinProgrammerTab re-parses that buffer in place and
// swaps it in as the new bcmMod, so the sub-tab now reflects the patched
// result (new dominant VIN + patched filename) without a manual reload.
describe("BCM sub-tab — patched-buffer refresh (onBcmPatched)", () => {
  const NEW_VIN = "2C3CDXL97LH237142"; // differs from the corpus VIN
  const ORIG_VIN = "2C3CDXL90MH582899";

  it("re-parses the panel's patched buffer in place after a VIN re-stamp", async () => {
    renderTab();
    await clickSubtab("bcm");
    await loadInto("vinprog-bcm", bcmBytes(), BCM_SYNCED);
    await waitFor(() => expect(screen.getByTestId("bcm-immo-panel")).toBeTruthy());

    // Sanity: the freshly loaded dump shows the original corpus VIN and
    // its original filename in the dropzone.
    const subtab = within(screen.getByTestId("vinprog-bcm-subtab"));
    expect(subtab.getByTestId("vinprog-bcm-filename").textContent).toBe(BCM_SYNCED);
    expect(subtab.getByText(new RegExp("Dominant VIN: " + ORIG_VIN))).toBeTruthy();

    // Re-stamp the BCM with a new VIN through the shared panel and apply.
    await act(async () => {
      fireEvent.change(subtab.getByTestId("bcm-immo-vin-input"), { target: { value: NEW_VIN } });
    });
    await act(async () => {
      fireEvent.click(subtab.getByTestId("bcm-immo-apply-btn"));
    });

    // The panel's onPatched fired → VinProgrammerTab re-parsed the patched
    // buffer and swapped it in as the new bcmMod. The sub-tab now shows the
    // patched filename and the panel re-analyzes to the NEW dominant VIN.
    await waitFor(() =>
      expect(screen.getByTestId("vinprog-bcm-filename").textContent).toMatch(/_vin\.bin$/)
    );
    expect(
      within(screen.getByTestId("vinprog-bcm-subtab")).getByText(new RegExp("Dominant VIN: " + NEW_VIN))
    ).toBeTruthy();
  });
});

// ECM sub-tab patched-buffer push-back (onEcmPatched):
// After the GPEC2A panel produces a patched buffer (Just FIX IT), clicking
// "ADD PATCHED DUMP TO WORKSPACE & RE-ANALYZE" fires onPushBack → onEcmPatched
// in VinProgrammerTab → parseModule re-parse → setEcmMod. The ECM sub-tab
// then shows the patched filename without any manual reload.
describe("ECM sub-tab — push-back round-trip (onEcmPatched + gpec2a-pushback-btn)", () => {
  it("re-parses the patched GPEC2A buffer in place after Just FIX IT + push-back", async () => {
    renderTab();

    // Load a BCM donor in the BCM sub-tab so the GPEC2A panel has a SEC6
    // source (without a donor, Just FIX IT is disabled).
    await clickSubtab("bcm");
    await loadInto("vinprog-bcm", bcmBytes(), BCM_SYNCED);
    await waitFor(() => expect(screen.getByTestId("bcm-immo-panel")).toBeTruthy());

    // Switch to the ECM sub-tab and load the real GPEC2A bench dump.
    await clickSubtab("ecm");
    // Re-query the input — a prior render between sub-tab switches can
    // detach the old node (modulesync-ui-test-fixtures memory note).
    await loadInto("vinprog-ecm", gpecBytes(), PCM_FILE);
    await waitFor(() => expect(screen.getByTestId("gpec2a-immo-panel")).toBeTruthy());

    const subtab = within(screen.getByTestId("vinprog-ecm-subtab"));

    // Sanity: the freshly loaded dump shows the original filename.
    expect(subtab.getByTestId("vinprog-ecm-filename").textContent).toBe(PCM_FILE);

    // Run Just FIX IT — the donor SEC6 is available from the BCM sub-tab, so
    // the button is enabled. Clicking it produces the patched buffer and
    // reveals the push-back card.
    const panel = within(screen.getByTestId("gpec2a-immo-panel"));
    const justFix = panel.getByRole("button", { name: /ONLY FIX IMMO AND DOWNLOAD/i });
    expect(justFix.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(justFix);
    });

    // The push-back button is now present (patched state is set + onPatched prop wired).
    await waitFor(() => expect(screen.getByTestId("gpec2a-pushback-btn")).toBeTruthy());

    // Click the push-back button → onPushBack → onEcmPatched → parseModule →
    // setEcmMod. The ECM sub-tab dropzone should flip to the patched filename.
    await act(async () => {
      fireEvent.click(screen.getByTestId("gpec2a-pushback-btn"));
    });

    // The patched filename ends with "_immoFix.bin" (Gpec2aImmoPanel.onJustFix
    // sets fname = baseName + "_immoFix.bin").
    await waitFor(() =>
      expect(screen.getByTestId("vinprog-ecm-filename").textContent).toMatch(/_immoFix\.bin$/)
    );

    // The push-back button disappears once pushed (patched state cleared).
    expect(screen.queryByTestId("gpec2a-pushback-btn")).toBeNull();
  });
});

// RFHUB sub-tab patched-buffer refresh (onRfhubPatched):
// After the XC2268 panel stamps a new VIN and calls onPatched, VinProgrammerTab
// re-parses the result via onRfhubPatched → parseModule → setRfhubMod. The
// RFHUB sub-tab dropzone should switch to the patched filename without any
// manual reload.
describe("RFHUB sub-tab — patched-buffer refresh (onRfhubPatched)", () => {
  it("re-parses the XC2268 patched buffer in place after a VIN re-stamp", async () => {
    renderTab();
    await clickSubtab("rfhub");
    await loadInto("vinprog-rfhub", xcBytes(), "rfhub_xc2268.bin");
    await waitFor(() => expect(screen.getByTestId("rfhub-immo-panel")).toBeTruthy());

    const subtab = within(screen.getByTestId("vinprog-rfhub-subtab"));

    // Sanity: the freshly loaded dump shows the original filename.
    expect(subtab.getByTestId("vinprog-rfhub-filename").textContent).toBe("rfhub_xc2268.bin");

    // Enter a new VIN and click APPLY — patchXc2268Vin + runGatedExport →
    // onPatched(res.bytes, "rfhub_xc2268_vin.bin") → onRfhubPatched.
    const panel = within(screen.getByTestId("rfhub-immo-panel"));
    await act(async () => {
      fireEvent.change(panel.getByTestId("rfhub-immo-vin-input"), {
        target: { value: XC_VIN },
      });
    });
    await act(async () => {
      fireEvent.click(panel.getByTestId("rfhub-immo-apply-btn"));
    });

    // VinProgrammerTab re-parsed the patched bytes and updated rfhubMod.
    // The dropzone now shows the patched filename ("rfhub_xc2268_vin.bin").
    await waitFor(() =>
      expect(screen.getByTestId("vinprog-rfhub-filename").textContent).toMatch(/_vin\.bin$/)
    );

    // The panel re-analyzed the patched image: the VIN appears in at least
    // one analysis card / slot row (VIN Consensus + per-slot rows all agree).
    expect(panel.getAllByText(XC_VIN).length).toBeGreaterThanOrEqual(1);
  });
});

// The cross-sub-tab donor chain: a BCM (or RFHUB) loaded in a sibling
// sub-tab feeds the GPEC2A immo panel's donorMods, so the ECM sub-tab can
// offer the BCM-derived PCM SEC6 secret (reverse(BCM SEC16)[0:6]) without
// the donor ever living in the shared workspace.
describe("ECM sub-tab — donor SEC6 from a sibling sub-tab (donorMods)", () => {
  it("offers the BCM-derived SEC6 in the GPEC2A panel after loading a BCM donor", async () => {
    renderTab();

    // Load a BCM donor in the BCM sub-tab.
    await clickSubtab("bcm");
    await loadInto("vinprog-bcm", bcmBytes(), BCM_SYNCED);
    await waitFor(() => expect(screen.getByTestId("bcm-immo-panel")).toBeTruthy());

    // Switch to the ECM sub-tab and load the GPEC2A bench dump.
    await clickSubtab("ecm");
    await loadInto("vinprog-ecm", gpecBytes(), PCM_FILE);
    await waitFor(() => expect(screen.getByTestId("gpec2a-immo-panel")).toBeTruthy());

    // donorMods reached Gpec2aImmoPanel: the donor secret is surfaced as
    // the SEC6 placeholder + a "use donor" auto-fill.
    const panel = within(screen.getByTestId("gpec2a-immo-panel"));
    expect(panel.getByText(/Donor secret available/i)).toBeTruthy();

    const sec6Input = panel.getByTestId("gpec2a-sec6-input");
    const donorHex = sec6Input.getAttribute("placeholder");
    expect(donorHex).toMatch(/^([0-9A-F]{2} ){5}[0-9A-F]{2}$/); // 6 hex bytes

    await act(async () => {
      fireEvent.click(panel.getByRole("button", { name: /use donor/i }));
    });
    expect(sec6Input.value).toBe(donorHex);
  });
});
