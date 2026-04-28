// @vitest-environment jsdom
//
// VIN Programmer tab — single-file VIN write + checksum recompute UI.
//
// Coverage:
//   - empty-state dropzone renders.
//   - dropping a 4 KB GPEC2A PCM detects type, surfaces VIN slots, and
//     a valid VIN unlocks PATCH VIN.
//   - clicking PATCH VIN runs analyzeFile + patchFile, surfaces the
//     log lines, and arms a download with the new VIN suffix in the
//     filename.
//   - dropping a 4 KB Gen2 RFHUB shows the byte-reversed slots with
//     CRC8RF; PATCH VIN rewrites every slot AND its checksum so the
//     resulting bytes round-trip through analyzeFile with all CRC OK.
//   - FIX CHECKSUMS button rewrites stale CS bytes using the existing
//     in-file VIN (no VIN change), and the resulting bytes round-trip
//     through analyzeFile with all CRC OK.
//   - dropping an unrecognised file blocks both action buttons and
//     surfaces a clear "unknown module" message.
//   - check-digit failure on the new VIN keeps PATCH VIN disabled.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VinProgrammerTab from "../tabs/VinProgrammerTab.jsx";
import { MasterVinProvider } from "../lib/masterVinContext.jsx";
import { analyzeFile } from "../lib/fileUtils.js";
import { crc16, crc8rf, rfhGen2VinCs } from "../lib/crc.js";

const OLD_VIN = "2C3CDXGJ7JH123456";
const NEW_VIN = "2C3CDXCT1HH652640";

function renderTab() {
  return render(
    <MasterVinProvider>
      <VinProgrammerTab/>
    </MasterVinProvider>
  );
}

function buildGpec2a4k(vin) {
  // GPEC2A 4 KB — plain ASCII VIN at 0x0000 / 0x01F0 / 0x0224 / 0x0CE0.
  const data = new Uint8Array(4096).fill(0xFF);
  for (const off of [0x0000, 0x01F0, 0x0224, 0x0CE0]) {
    for (let i = 0; i < 17; i++) data[off + i] = vin.charCodeAt(i);
  }
  return data;
}

function buildRfhubGen2(vin) {
  // Gen2 RFHUB 4 KB — 4 byte-reversed VIN slots with crc8rf at +17.
  const data = new Uint8Array(4096).fill(0xFF);
  const vb = new TextEncoder().encode(vin);
  for (const off of [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1]) {
    const rev = new Uint8Array(17);
    for (let i = 0; i < 17; i++) rev[i] = vb[16 - i];
    for (let i = 0; i < 17; i++) data[off + i] = rev[i];
    data[off + 17] = crc8rf(rev);
  }
  return data;
}

function bufferFile(name, bytes) {
  const f = new File([bytes], name, { type: "application/octet-stream" });
  // jsdom's File implementation returns an ArrayBuffer for arrayBuffer(),
  // which is exactly what the tab expects.
  return f;
}

// Drop a file by populating the hidden <input type="file"> directly —
// less brittle than dispatching a synthetic DataTransfer drop event.
async function dropFile(file) {
  const input = await screen.findByTestId("vinprog-file-input");
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await waitFor(() => expect(screen.getByTestId("vinprog-detected-type")).toBeTruthy());
}

// Click the green DOWNLOAD button + capture the bytes URL.createObjectURL
// was handed, so we can re-analyze the patched binary in-memory.
function setupDownloadCapture() {
  const captured = { blobs: new Map(), lastFilename: null, lastBytes: null };
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let counter = 0;
  URL.createObjectURL = vi.fn((blob) => {
    counter += 1;
    const url = `blob:vinprog-test-${counter}`;
    captured.blobs.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn(() => {});
  // Patch HTMLAnchorElement#click so the auto-download anchor doesn't
  // try to navigate; capture filename + read the blob bytes.
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    captured.lastFilename = this.download;
    const blob = captured.blobs.get(this.href);
    if (blob) {
      // Synchronous arrayBuffer fallback for jsdom: read via FileReader.
      const reader = new FileReader();
      reader.onload = () => {
        captured.lastBytes = new Uint8Array(reader.result);
      };
      reader.readAsArrayBuffer(blob);
    }
  };
  return {
    captured,
    restore: () => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
      HTMLAnchorElement.prototype.click = origClick;
    },
  };
}

async function clickAndCaptureDownload(testId) {
  const dl = setupDownloadCapture();
  const btn = await screen.findByTestId(testId);
  await act(async () => {
    btn.click();
  });
  // FileReader resolves on next microtask in jsdom.
  await waitFor(() => expect(dl.captured.lastFilename).toBeTruthy());
  await waitFor(() => expect(dl.captured.lastBytes).toBeTruthy());
  dl.restore();
  return dl.captured;
}

describe("VIN Programmer tab", () => {
  afterEach(() => cleanup());

  it("renders the empty dropzone with no file loaded", () => {
    renderTab();
    expect(screen.getByTestId("vinprog-tab")).toBeTruthy();
    expect(screen.getByTestId("vinprog-dropzone")).toBeTruthy();
    expect(screen.queryByTestId("vinprog-detected-type")).toBeNull();
    // Action buttons not visible when no file is loaded.
    expect(screen.queryByTestId("vinprog-patch")).toBeNull();
  });

  it("detects a 4 KB GPEC2A PCM, lists 4 VIN slots, and unlocks PATCH VIN with a valid new VIN", async () => {
    renderTab();
    await dropFile(bufferFile("PCM_GPEC2A_4K.bin", buildGpec2a4k(OLD_VIN)));
    expect(screen.getByTestId("vinprog-detected-type").textContent).toMatch(/GPEC2A|PCM/i);
    expect(screen.getByTestId("vinprog-detected-size").textContent).toMatch(/4 KB/);
    // Slot count line: 4 full · 0 partial.
    expect(screen.getByTestId("vinprog-slot-counts").textContent).toMatch(/4 full/);
    // PATCH VIN starts disabled until a valid 17-char VIN is typed.
    const patchBtn = screen.getByTestId("vinprog-patch");
    expect(patchBtn.disabled).toBe(true);
    const input = screen.getByTestId("vinprog-new-vin");
    await act(async () => {
      fireEvent.change(input, { target: { value: NEW_VIN } });
    });
    await waitFor(() => expect(screen.getByTestId("vinprog-patch").disabled).toBe(false));
  });

  it("PATCH VIN on a GPEC2A PCM rewrites every slot and the downloaded file round-trips", async () => {
    renderTab();
    await dropFile(bufferFile("PCM_GPEC2A_4K.bin", buildGpec2a4k(OLD_VIN)));
    const input = screen.getByTestId("vinprog-new-vin");
    await act(async () => {
      fireEvent.change(input, { target: { value: NEW_VIN } });
    });
    await waitFor(() => expect(screen.getByTestId("vinprog-patch").disabled).toBe(false));
    await act(async () => {
      screen.getByTestId("vinprog-patch").click();
    });
    const captured = await clickAndCaptureDownload("vinprog-download");
    expect(screen.getByTestId("vinprog-result-vin").textContent).toBe(NEW_VIN);
    expect(captured.lastFilename).toMatch(new RegExp(`_VIN_${NEW_VIN}\\.bin$`));
    // Re-analyze the downloaded bytes — every slot must now read NEW_VIN
    // (GPEC2A has no checksum, just plain ASCII, so all slots are "ok").
    const re = analyzeFile(captured.lastBytes, captured.lastFilename);
    const vins = re.vins.map(v => v.vin);
    expect(vins.every(v => v === NEW_VIN)).toBe(true);
    expect(re.vins.length).toBe(4);
  });

  it("PATCH VIN on a Gen2 RFHUB rewrites every byte-reversed slot AND its CRC8RF", async () => {
    renderTab();
    await dropFile(bufferFile("RFHUB_GEN2_4K.bin", buildRfhubGen2(OLD_VIN)));
    expect(screen.getByTestId("vinprog-detected-type").textContent).toMatch(/RFHUB/i);
    const input = screen.getByTestId("vinprog-new-vin");
    await act(async () => {
      fireEvent.change(input, { target: { value: NEW_VIN } });
    });
    await act(async () => {
      screen.getByTestId("vinprog-patch").click();
    });
    const captured = await clickAndCaptureDownload("vinprog-download");
    const re = analyzeFile(captured.lastBytes, captured.lastFilename);
    expect(re.type).toBe("RFHUB");
    expect(re.vins.length).toBe(4);
    for (const v of re.vins) {
      expect(v.vin).toBe(NEW_VIN);
      // CS recomputation must hold — sc (stored) === cc (computed).
      expect(v.sc).toBe(v.cc);
      expect(v.ok).toBe(true);
    }
  });

  it("FIX CHECKSUMS rewrites stale CS bytes using the in-file VIN", async () => {
    // Build a Gen2 RFHUB where slots #2/#3/#4 have intentionally bad
    // CS bytes. Slot #1 stays correct so the analyzer's magic
    // auto-detect (which derives the magic constant from the first
    // non-virgin slot) picks the real magic — otherwise corrupting
    // every slot identically would just train the auto-detector on
    // the corruption and the slots would falsely read "OK".
    const data = buildRfhubGen2(OLD_VIN);
    for (const off of [0x0EB9, 0x0ECD, 0x0EE1]) {
      data[off + 17] ^= 0x01;
    }
    // Sanity: pre-fix analyze finds slot #1 OK (as designed) and the
    // remaining three flagged BAD.
    const pre = analyzeFile(data, "RFHUB_BAD_CS.bin");
    const okSlots = pre.vins.filter(v => v.ok).length;
    const badSlots = pre.vins.filter(v => !v.ok).length;
    expect(okSlots).toBe(1);
    expect(badSlots).toBe(3);

    renderTab();
    await dropFile(bufferFile("RFHUB_BAD_CS.bin", data));
    // FIX CHECKSUMS is enabled even with no new VIN entered.
    const fixBtn = screen.getByTestId("vinprog-fix-cs");
    expect(fixBtn.disabled).toBe(false);
    await act(async () => {
      fixBtn.click();
    });
    const captured = await clickAndCaptureDownload("vinprog-download");
    expect(captured.lastFilename).toMatch(/_FIXCS\.bin$/);
    const post = analyzeFile(captured.lastBytes, captured.lastFilename);
    expect(post.vins.length).toBe(4);
    for (const v of post.vins) {
      expect(v.vin).toBe(OLD_VIN);
      expect(v.ok).toBe(true); // CS now matches.
    }
  });

  it("FIX CHECKSUMS refuses to act when the file has two different VINs across slots", async () => {
    // Build a GPEC2A 4 KB dump where slot #1 has OLD_VIN and slots
    // #2/#3/#4 have NEW_VIN — a partially-reprogrammed mess. FIX
    // CHECKSUMS would otherwise normalize all four slots to OLD_VIN
    // (the first slot's VIN), silently destroying the other three.
    const data = new Uint8Array(4096).fill(0xFF);
    for (let i = 0; i < 17; i++) data[0x0000 + i] = OLD_VIN.charCodeAt(i);
    for (const off of [0x01F0, 0x0224, 0x0CE0]) {
      for (let i = 0; i < 17; i++) data[off + i] = NEW_VIN.charCodeAt(i);
    }
    renderTab();
    await dropFile(bufferFile("PCM_MIXED.bin", data));
    // Both VINs should show in the slot list — sanity check.
    expect(screen.getByTestId("vinprog-slot-counts").textContent).toMatch(/4 full/);
    const fixBtn = screen.getByTestId("vinprog-fix-cs");
    expect(fixBtn.disabled).toBe(false); // Button is enabled — the guard runs on click.
    await act(async () => {
      fixBtn.click();
    });
    // No download should have been triggered: result card stays absent
    // and a clear refusal is surfaced naming both VINs.
    expect(screen.queryByTestId("vinprog-result-card")).toBeNull();
    const errors = screen.getAllByText((_, el) => {
      if (!el || el.tagName === 'SCRIPT') return false;
      const t = el.textContent || '';
      return t.includes(OLD_VIN) && t.includes(NEW_VIN) && /different VINs/i.test(t);
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("blocks PATCH VIN when the entered VIN fails the standard check digit", async () => {
    renderTab();
    await dropFile(bufferFile("PCM_GPEC2A_4K.bin", buildGpec2a4k(OLD_VIN)));
    const input = screen.getByTestId("vinprog-new-vin");
    // Same VIN with a deliberately wrong check digit at position 9 ('9' instead of '1').
    const badVin = "2C3CDXCT9HH652640";
    await act(async () => {
      fireEvent.change(input, { target: { value: badVin } });
    });
    expect(screen.getByTestId("vinprog-patch").disabled).toBe(true);
    // FIX CHECKSUMS still works regardless of new-VIN field state.
    expect(screen.getByTestId("vinprog-fix-cs").disabled).toBe(false);
  });

  it("refuses to act on an unrecognised binary and surfaces a clear refusal", async () => {
    renderTab();
    // 333-byte random buffer — undersized, no canonical type.
    const junk = new Uint8Array(333);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 31) & 0xFF;
    await dropFile(bufferFile("garbage.bin", junk));
    expect(screen.getByTestId("vinprog-detected-type").textContent).toMatch(/UNKNOWN|—/i);
    expect(screen.queryByTestId("vinprog-patch")).toBeNull();
    expect(screen.queryByTestId("vinprog-fix-cs")).toBeNull();
  });
});
