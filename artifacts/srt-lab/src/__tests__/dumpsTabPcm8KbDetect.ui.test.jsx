// @vitest-environment jsdom
//
// Task #483 regression — an 8 KB GPEC2A PCM dropped into the per-vehicle
// Dumps tab's PCM slot must be classified as PCM/GPEC2A (not 95640) so
// it ends up as the loaded `pcm` workspace file and the SYNC ALL MODULES
// PCM resize path (Task #481) actually applies the target-chip selector.
//
// Pre-fix: `analyzeFile` classified any 8 KB buffer as 95640 unless the
// filename or signature said otherwise, and `typeFromFilename` didn't
// recognise plain "PCM" names. So an 8 KB GPEC2A donor named e.g.
// "donor_PCM.bin" became a 95640 file in workspace state and the
// target-chip selector never fired.

import React, { useState } from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DumpsTabV2 } from "../App.jsx";
import { VEHICLES } from "../lib/vehicles.js";
import { analyzeFile } from "../lib/fileUtils.js";
import { typeFromFilename } from "../lib/parseModule.js";

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

// Build an 8 KB Continental GPEC2A buffer with valid VIN bytes at the
// canonical PCM slots so analyzeFile's GPEC2A branch surfaces parsed
// VINs (proves the slot-aware classification took effect end-to-end).
function makeGpec2a8Kb({ vin = "1C3CDZBG0FH123456" } = {}) {
  const buf = new Uint8Array(8192).fill(0xFF);
  // PCM_VIN_OFFSETS_GPEC2A = [0x0000, 0x01F0, 0x0224, 0x0CE0]
  for (const off of [0x0000, 0x01F0, 0x0224, 0x0CE0]) {
    for (let i = 0; i < 17; i++) buf[off + i] = vin.charCodeAt(i);
  }
  return buf;
}

function makeFile(name, bytes) {
  return new File([bytes], name, { type: "application/octet-stream" });
}

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DumpsTabV2 — 8 KB PCM upload classification (Task #483)", () => {
  it("classifies an 8 KB PCM via the PCM slot as GPEC2A and forwards slotType to loadF", async () => {
    const user = userEvent.setup();
    const loadF = vi.fn(() => Promise.resolve({ acceptedFiles: [], rejected: [] }));
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const bytes = makeGpec2a8Kb();
    const file = makeFile("donor_PCM.bin", bytes);
    const input = document.getElementById("u-PCM / GPEC2A");
    await user.upload(input, file);

    // Wait for the FileReader chain inside gatedLoadF to settle.
    await new Promise(r => setTimeout(r, 0));

    expect(loadF).toHaveBeenCalledTimes(1);
    const [accepted, slotType] = loadF.mock.calls[0];
    expect(slotType).toBe("PCM");
    expect(accepted).toHaveLength(1);
    expect(accepted[0].name).toBe("donor_PCM.bin");
    expect(accepted[0].size).toBe(8192);
  });

  it("rejects undersized PCM via the PCM slot before reaching loadF", async () => {
    // Sanity check that the slot-aware size guard still fires for the
    // small-file path that already had coverage in dumpsTabUploaderTooSmall.
    const user = userEvent.setup();
    const loadF = vi.fn(() => Promise.resolve({ acceptedFiles: [], rejected: [] }));
    render(<Harness vehicle={VEHICLES.charger} loadF={loadF} />);

    const file = makeFile("PCM_FRAGMENT.bin", new Uint8Array(1024));
    const input = document.getElementById("u-PCM / GPEC2A");
    await user.upload(input, file);

    await new Promise(r => setTimeout(r, 0));
    expect(loadF).not.toHaveBeenCalled();
  });
});

describe("analyzeFile — slot context override (Task #483)", () => {
  it("classifies an 8 KB GPEC2A buffer as GPEC2A when slotType='PCM' is supplied", () => {
    const bytes = makeGpec2a8Kb();
    // Without slot context: 8 KB → 95640 by size alone.
    const noSlot = analyzeFile(bytes.buffer, "donor.bin");
    expect(noSlot.type).toBe("95640");
    // With slot context: PCM slot → GPEC2A regardless of name.
    const withSlot = analyzeFile(bytes.buffer, "donor.bin", "PCM");
    expect(withSlot.type).toBe("GPEC2A");
    // GPEC2A VIN parsing should now run and surface the seeded VINs.
    expect(withSlot.vins.length).toBeGreaterThan(0);
    expect(withSlot.vins[0].vin).toBe("1C3CDZBG0FH123456");
    // GPEC2A `sec` block is populated (PCM SEC6 + key fields), not the
    // 95640 `sec` block.
    expect(withSlot.sec && withSlot.sec.t).toBe("gpec2a");
  });

  it("classifies a 4 KB GPEC2A buffer as GPEC2A when slotType='PCM' is supplied", () => {
    const bytes = new Uint8Array(4096).fill(0xFF);
    const vin = "1C3CDZBG0FH123456";
    for (const off of [0x0000, 0x01F0, 0x0224, 0x0CE0]) {
      for (let i = 0; i < 17; i++) bytes[off + i] = vin.charCodeAt(i);
    }
    const r = analyzeFile(bytes.buffer, "donor.bin", "PCM");
    expect(r.type).toBe("GPEC2A");
  });

  it("does not relabel a 64 KB BCM dropped (by mistake) into the PCM slot — slot override only fires for canonical PCM sizes", () => {
    // 64 KB is not a canonical GPEC2A size, so the slot override is a
    // no-op and the size-based BCM detection stands. (The Dumps tab's
    // upstream `moduleTooSmall` guard wouldn't reject this either since
    // 65536 ≥ PCM min 4096 — that's a separate concern; this test just
    // pins down the slot-override scope.)
    const bytes = new Uint8Array(65536).fill(0x00);
    const r = analyzeFile(bytes.buffer, "bcm.bin", "PCM");
    expect(r.type).toBe("BCM");
  });
});

describe("typeFromFilename — recognises plain PCM names (Task #483)", () => {
  it("returns GPEC2A for plain 'PCM' filenames", () => {
    expect(typeFromFilename("donor_PCM.bin")).toBe("GPEC2A");
    expect(typeFromFilename("PCM_dump.bin")).toBe("GPEC2A");
    expect(typeFromFilename("redeye_pcm_8kb.eep")).toBe("GPEC2A");
  });

  it("does not match PCM as a sub-string of unrelated tokens", () => {
    // Word-boundary anchors prevent false hits on random letter runs.
    expect(typeFromFilename("PCMUPGRADE.bin")).toBe(null);
    expect(typeFromFilename("HPCMARK.bin")).toBe(null);
  });

  it("still prefers more specific GPEC hint when both are present", () => {
    expect(typeFromFilename("GPEC2A_PCM.bin")).toBe("GPEC2A");
  });
});
