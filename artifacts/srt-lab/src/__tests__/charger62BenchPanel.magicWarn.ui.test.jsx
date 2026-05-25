// @vitest-environment jsdom
//
// Mounts Charger62BenchPanel against the real 6.2 Charger bench fixture and
// verifies the panel renders a user-facing "SINCRO: Checksum ERROR" badge on
// every RFHUB_EEE VIN row when the derived Gen2 VIN magic is off-spec
// (not in {0xDB, 0x87}).  Guards Task #773's user-facing outcome — a
// regression that hides the badge would silently re-introduce false
// "CRC OK" confidence on files SINCRO rejects.

import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Charger62BenchPanel from "../components/Charger62BenchPanel.jsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, "..", "..", "..", "..", "attached_assets");
const load = (n) => readFileSync(join(ASSETS, n));

// Map publicPath → bytes from real attached_assets fixtures.
const FILE_MAP = {
  "bench-sets/bcm_6.2charger.bin": load("196.2charger_BCMDFLASH_NEWVIN_1779734554788.bin"),
  "bench-sets/rfhubeee_6.2charger.bin": load("19charger6,2_rfhubeee_1779733960311.bin"),
  "bench-sets/rfhubpflash_6.2charger.bin": load("19charger6.2_rfhubP-flash_1779733960317.bin"),
  "bench-sets/pcm_6.2charger.bin": load("6.2CHARGER_NEEDTOUSE_immoFix_1779733593578.bin"),
};

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url) => {
    const key = Object.keys(FILE_MAP).find((k) => String(url).endsWith(k));
    if (!key) return { ok: false, status: 404 };
    const buf = FILE_MAP[key];
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  });
});

afterEach(() => {
  cleanup();
  delete globalThis.fetch;
});

describe("Charger62BenchPanel — RFH off-spec magic warning", () => {
  it("renders one ⚠ SINCRO warning per RFHUB_EEE VIN row on the 6.2 bench fixture (magic 0x3E)", async () => {
    render(<Charger62BenchPanel />);

    fireEvent.click(screen.getByText("Load bench set"));

    // After load + expand, four RFH_EEE warnings should appear (one per slot).
    const warnings = await waitFor(
      () => {
        const w = screen.getAllByTestId("rfh-magic-warning");
        if (w.length < 4) throw new Error(`only ${w.length} warning(s) so far`);
        return w;
      },
      { timeout: 4000 },
    );
    expect(warnings.length).toBe(4);
    for (const w of warnings) {
      expect(w.textContent).toMatch(/SINCRO/);
      expect(w.textContent).toMatch(/0x3E/);
    }
  });
});
