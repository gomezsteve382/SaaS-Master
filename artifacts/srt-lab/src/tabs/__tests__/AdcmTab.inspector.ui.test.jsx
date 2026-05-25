// @vitest-environment jsdom
//
// Task #793 — click-through coverage for the new ADCM tab dump inspector.
//
// AdcmTab grew an inline file picker (Task #783). Unlike EcmTab the
// picker accepts any of three buckets (FW / GPEC2A / BCM) because ADCM
// dumps don't have a dedicated parseModule type — the floor guard runs
// against the smallest of the three, and anything that parses outside
// the trio is rejected with a friendly message. On success the parsed
// module is pushed into MasterVinContext tagged "ADCM tab" and the
// shared IdentityCard mounts.
//
// The asserts here freeze the user-visible contract for each branch
// so a regression in the picker, the wrong-type rejection, or the
// IdentityCard + provenance chip wiring shows up immediately.

import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import AdcmTab from "../AdcmTab.jsx";
import { MasterVinProvider } from "../../lib/masterVinContext.jsx";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = name =>
  new Uint8Array(readFileSync(join(__dir, "..", "..", "__tests__", "fixtures", name)));

function mount() {
  return render(
    <MasterVinProvider setPg={() => {}}>
      <AdcmTab />
    </MasterVinProvider>
  );
}

function getPicker(container) {
  // The inspector picker is the only <input type="file"> in the tab.
  const inputs = container.querySelectorAll('input[type="file"]');
  expect(inputs.length).toBeGreaterThan(0);
  return inputs[inputs.length - 1];
}

afterEach(() => cleanup());

describe("AdcmTab — dump inspector (Task #793)", () => {
  it("rejects an undersized .bin with the too-small card", async () => {
    const user = userEvent.setup();
    const { container } = mount();

    // 1 KB stub — below the 4 KB floor (smallest accepted = GPEC2A).
    const tiny = new Uint8Array(1024).fill(0xFF);
    const file = new File([tiny], "tiny.bin", { type: "application/octet-stream" });
    await user.upload(getPicker(container), file);

    await waitFor(() =>
      expect(screen.getByText(/this isn't a full adcm dump/i)).toBeTruthy()
    );
    expect(screen.getByText(/1,024 bytes/)).toBeTruthy();
    expect(screen.getByText(/4 KB GPEC2A \/ 64 KB BCM-style ADCM image/i)).toBeTruthy();
    expect(screen.queryByText(/OS \/ PN \/ SERIAL/i)).toBeNull();
  });

  it("rejects a wrong-type .bin (95640) with the friendly FW/GPEC2A/BCM message", async () => {
    const user = userEvent.setup();
    const { container } = mount();

    // 8 KB 95640 EEPROM — clears the 4 KB floor but parseModule returns
    // '95640', which is not in the ADCM_OK_TYPES trio.
    const bytes = fixture("SAMPLE_95640_EXT_EEPROM_18TH_BAMA_OG.bin");
    const file = new File([bytes], "donor_95640.bin", { type: "application/octet-stream" });
    await user.upload(getPicker(container), file);

    await waitFor(() =>
      expect(
        screen.getByText(
          /Selected file is 95640, not an ADCM-shaped dump \(expected FW \/ GPEC2A \/ BCM\)\./i
        )
      ).toBeTruthy()
    );
    expect(screen.queryByText(/this isn't a full adcm dump/i)).toBeNull();
    expect(screen.queryByText(/OS \/ PN \/ SERIAL/i)).toBeNull();
  });

  it("loads a valid BCM-shaped fixture, renders the IdentityCard, and tags the provenance chip", async () => {
    const user = userEvent.setup();
    const { container } = mount();

    // 64 KB BCM dump — BCM is one of the three accepted ADCM buckets.
    const bytes = fixture("SAMPLE_BCM_DFLASH_18TH_OG.bin");
    const file = new File([bytes], "donor_adcm_bcm.bin", { type: "application/octet-stream" });
    await user.upload(getPicker(container), file);

    await waitFor(() =>
      expect(screen.getByText(/OS \/ PN \/ SERIAL BEST-PICK/i)).toBeTruthy()
    );
    expect(screen.getByText(/Loaded from ADCM tab/i)).toBeTruthy();
    expect(screen.queryByText(/this isn't a full adcm dump/i)).toBeNull();
    expect(screen.queryByText(/not an ADCM-shaped dump/i)).toBeNull();
  });
});
