// @vitest-environment jsdom
//
// End-to-end UI test for the offline GPEC2A PCM immo-fix panel
// (Gpec2aImmoPanel.jsx) as it is actually wired into EcmTab.jsx.
//
// The pure analyzer logic already has unit coverage
// (src/lib/__tests__/gpec2aPcmAnalyzer.test.js); this file pins the
// React surface + EcmTab wiring that previously only typecheck touched:
//   1. Loading the real 4 KB bench dump (19gpec2a…bin) through the ECM
//      tab's file picker mounts the panel and renders the analysis cards,
//      the VIN-by-offset table, and the SEC6 / IMMO state.
//   2. A BCM donor parsed into the shared workspace surfaces its derived
//      PCM SEC6 secret (reverse(BCM SEC16)[0:6]) as the SEC6 placeholder
//      + a one-click "use donor" auto-fill.
//   3. The Apply-changes form drives applyGpec2aChanges and surfaces the
//      success status line.
//   4. "Just FIX IT" runs the donor-secret immo repair and surfaces the
//      "IMMO repaired (from BCM)" status line.
//   5. With no donor loaded, "Just FIX IT" is refused (button disabled).
//
// jsdom traps (see .agents/memory/modulesync-ui-test-* notes): we drive
// the panel through the REAL corpus fixture loaded via the file input
// (synthetic buffers don't parse as GPEC2A), and we re-query the file
// input for every load so a re-render between loads can't leave us
// firing change on a detached node. The download side-effect (dl() →
// URL.createObjectURL + <a>.click) is stubbed so the click path can't
// throw partway through and leave the status message unset.

import React from "react";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

import EcmTab from "../tabs/EcmTab.jsx";
import { parseModule } from "../lib/parseModule.js";
import { MasterVinProvider, MasterVinContext } from "../lib/masterVinContext.jsx";

const ASSETS = resolve(__dirname, "../../../..", "attached_assets");
const load = (n) => new Uint8Array(readFileSync(join(ASSETS, n)));

const PCM_FILE = "19gpec2a_eeprom_1780353765789.bin";
const BCM_DONOR =
  "BCM_HERMANADO_CHARGER_BCM_SYNCED_2C3CDXL92KH674464_17803513401_1780361110923.bin";

const EXPECTED_VIN = "2C3CDXL92KH674464";
// PCM SEC6 = reverse(BCM split SEC16)[0:6] for the synced Charger donor.
const DONOR_HEX = "F6 F4 25 6B 04 C6";

// jsdom ships neither URL.createObjectURL nor a working anchor download;
// stub them so Gpec2aImmoPanel's dl() helper can't throw mid-handler.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}

afterEach(() => cleanup());

// Seeds a parsed BCM donor into the shared workspace so EcmTab's
// donorMods (getDumpsByType('BCM')) picks it up — the same path a tech
// gets after loading a BCM in the BCM tab. The BCM never appears in the
// ECM inspector (it filters to GPEC2A), it is only used as a SEC6 donor.
function SeedDonor({ children }) {
  const { addDump } = React.useContext(MasterVinContext);
  React.useEffect(() => {
    addDump(parseModule(load(BCM_DONOR), BCM_DONOR), "test-donor");
  }, [addDump]);
  return children;
}

function renderEcm({ withDonor = true } = {}) {
  return render(
    <MasterVinProvider setPg={() => {}}>
      {withDonor ? (
        <SeedDonor>
          <EcmTab />
        </SeedDonor>
      ) : (
        <EcmTab />
      )}
    </MasterVinProvider>
  );
}

// Loads the real GPEC2A bench dump through the ECM DUMP INSPECTOR file
// input (onInspectFile → FileReader → parseModule → addDump). Re-queries
// the input on every call so a prior render can't leave us pointing at a
// stale node. Resolves once the panel has mounted.
async function loadGpec2a(container) {
  const input = container.querySelector('input[type="file"]');
  expect(input).toBeTruthy();
  const file = new File([load(PCM_FILE)], PCM_FILE, { type: "application/octet-stream" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  return screen.findByTestId("gpec2a-immo-panel");
}

describe("Gpec2aImmoPanel via EcmTab — analysis read-out", () => {
  it("renders the analysis cards, VIN-by-offset table, and SEC6 / IMMO state", async () => {
    const { container } = renderEcm();
    const panel = within(await loadGpec2a(container));

    // Header + analysis section.
    expect(panel.getByText(/PCM GPEC2A IMMO ANALYZER/i)).toBeTruthy();
    expect(panel.getByText(/ANALYSIS RESULT/i)).toBeTruthy();
    expect(panel.getByText(/VINs BY OFFSET/i)).toBeTruthy();

    // Three valid VIN slots all read the consensus VIN.
    expect(panel.getAllByText(EXPECTED_VIN).length).toBeGreaterThanOrEqual(3);

    // SEC6 blank (FF FF FF FF FF FF) → EMPTY_FF; IMMO not synced
    // (current FF FF FF FF, expected family marker FF FF FF AA).
    expect(panel.getAllByText("EMPTY_FF").length).toBeGreaterThan(0);
    expect(panel.getByText("FF FF FF FF")).toBeTruthy();
    expect(panel.getByText("FF FF FF AA")).toBeTruthy();
  });
});

describe("Gpec2aImmoPanel via EcmTab — donor SEC6 auto-fill", () => {
  it("surfaces the BCM-derived SEC6 as placeholder + 'use donor' auto-fill", async () => {
    const { container } = renderEcm();
    const panel = within(await loadGpec2a(container));

    expect(panel.getByText(/Donor secret available/i)).toBeTruthy();
    expect(panel.getByText(DONOR_HEX)).toBeTruthy();

    const sec6Input = panel.getByTestId("gpec2a-sec6-input");
    expect(sec6Input.getAttribute("placeholder")).toBe(DONOR_HEX);

    await act(async () => {
      fireEvent.click(panel.getByRole("button", { name: /use donor/i }));
    });
    expect(sec6Input.value).toBe(DONOR_HEX);
  });
});

describe("Gpec2aImmoPanel via EcmTab — apply form", () => {
  it("drives applyGpec2aChanges and surfaces the Applied status line", async () => {
    const { container } = renderEcm();
    const panel = within(await loadGpec2a(container));

    const vinInput = panel.getByTestId("gpec2a-vin-input");
    await act(async () => {
      fireEvent.change(vinInput, { target: { value: "2C3CDXL92KH000001" } });
    });
    expect(vinInput.value).toBe("2C3CDXL92KH000001");

    // Supply the matching donor SEC6 so the export guard (resulting SEC6 must
    // equal the BCM-derived secret) is satisfied. Without it the panel CORRECTLY
    // refuses — that safety guard is covered by gpec2aImmoExportGuard.test.js.
    await act(async () => {
      fireEvent.click(panel.getByRole("button", { name: /use donor/i }));
    });

    await act(async () => {
      fireEvent.click(panel.getByRole("button", { name: /APPLY CHANGES AND DOWNLOAD/i }));
    });

    const status = await screen.findByTestId("gpec2a-immo-status");
    expect(status.textContent).toMatch(/Applied:/);
    expect(status.textContent).toMatch(/downloaded/);
  });
});

describe("Gpec2aImmoPanel via EcmTab — Just FIX IT", () => {
  it("runs the donor immo repair and surfaces 'IMMO repaired (from BCM)'", async () => {
    const { container } = renderEcm();
    const panel = within(await loadGpec2a(container));

    const justFix = panel.getByRole("button", { name: /ONLY FIX IMMO AND DOWNLOAD/i });
    expect(justFix.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(justFix);
    });

    const status = await screen.findByTestId("gpec2a-immo-status");
    expect(status.textContent).toMatch(/IMMO repaired \(from BCM\)/);
    expect(status.textContent).toContain(DONOR_HEX);
    expect(status.textContent).toContain("FF FF FF AA");
  });

  it("refuses Just FIX IT when no donor is loaded (button disabled)", async () => {
    const { container } = renderEcm({ withDonor: false });
    const panel = within(await loadGpec2a(container));

    expect(panel.getByText(/No BCM \/ RFHUB donor loaded/i)).toBeTruthy();
    const justFix = panel.getByRole("button", { name: /ONLY FIX IMMO AND DOWNLOAD/i });
    expect(justFix.disabled).toBe(true);
  });
});
