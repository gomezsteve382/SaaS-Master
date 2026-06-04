// @vitest-environment jsdom
//
// Task #793 — click-through coverage for the new ECM tab dump inspector.
//
// EcmTab grew an inline file picker (Task #783) that runs the per-type
// `moduleTooSmall` guard, rejects wrong-type dumps with a friendly
// message, and on success pushes the parsed module into the shared
// MasterVinContext workspace tagged "ECM tab". A regression in any of
// those three branches (too-small card, wrong-type message, or the
// IdentityCard + "Loaded from …" provenance chip wiring) would slip
// through CI today, since the tab had no component tests at all.
//
// The asserts here freeze the user-visible contract for each branch.

import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EcmTab from "../EcmTab.jsx";
import { MasterVinProvider } from "../../lib/masterVinContext.jsx";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = name =>
  new Uint8Array(readFileSync(join(__dir, "..", "..", "__tests__", "fixtures", name)));

function mount() {
  return render(
    <MasterVinProvider setPg={() => {}}>
      <EcmTab />
    </MasterVinProvider>
  );
}

function getPicker(container) {
  // The picker is a hidden <input type="file"> inside the inspector card.
  const input = container.querySelector('input[type="file"]');
  expect(input).toBeTruthy();
  return input;
}

afterEach(() => cleanup());

describe("EcmTab — dump inspector (Task #793)", () => {
  it("rejects an undersized .bin with the too-small card", async () => {
    const user = userEvent.setup();
    const { container } = mount();

    // 1 KB stub — well below the 4 KB GPEC2A floor.
    const tiny = new Uint8Array(1024).fill(0xFF);
    const file = new File([tiny], "tiny.bin", { type: "application/octet-stream" });
    await user.upload(getPicker(container), file);

    await waitFor(() =>
      expect(screen.getByText(/this isn't a full ecm dump/i)).toBeTruthy()
    );
    expect(screen.getByText(/1,024 bytes/)).toBeTruthy();
    expect(screen.getByText(/4 KB Continental GPEC2A/i)).toBeTruthy();
    // No identity card on the failure branch.
    expect(screen.queryByText(/OS \/ PN \/ SERIAL/i)).toBeNull();
  });

  it("rejects a wrong-type .bin with the friendly GPEC2A message", async () => {
    const user = userEvent.setup();
    const { container } = mount();

    // A real 64 KB BCM dump — passes the size floor but parseModule
    // returns type 'BCM', so the GPEC2A-only ECM picker should reject.
    const bytes = fixture("SAMPLE_BCM_DFLASH_18TH_OG.bin");
    const file = new File([bytes], "donor_bcm.bin", { type: "application/octet-stream" });
    await user.upload(getPicker(container), file);

    await waitFor(() =>
      expect(
        screen.getByText(
          /Selected file is BCM, not GPEC2A — load a 4 KB Continental GPEC2A ECM dump\./i
        )
      ).toBeTruthy()
    );
    expect(screen.queryByText(/this isn't a full ecm dump/i)).toBeNull();
    expect(screen.queryByText(/OS \/ PN \/ SERIAL/i)).toBeNull();
  });

  it("loads a valid GPEC2A fixture, renders the IdentityCard, and tags the provenance chip", async () => {
    const user = userEvent.setup();
    const { container } = mount();

    const bytes = fixture("SAMPLE_GPEC2A_EXT_EEPROM_4KB_RESCUED_VIN_CRC_1C4RJFN9XJC309165_628f7b3c.bin");
    const file = new File([bytes], "donor_gpec2a.bin", { type: "application/octet-stream" });
    await user.upload(getPicker(container), file);

    // IdentityCard mounts on success (shared OS / PN / SERIAL best-pick).
    await waitFor(() =>
      expect(screen.getByText(/OS \/ PN \/ SERIAL BEST-PICK/i)).toBeTruthy()
    );
    // Provenance chip from MasterVinContext (`addDump(m, 'ECM tab')`).
    expect(screen.getByText(/Loaded from ECM tab/i)).toBeTruthy();
    // No rejection branches.
    expect(screen.queryByText(/this isn't a full ecm dump/i)).toBeNull();
    expect(screen.queryByText(/not GPEC2A/i)).toBeNull();
  });
});
