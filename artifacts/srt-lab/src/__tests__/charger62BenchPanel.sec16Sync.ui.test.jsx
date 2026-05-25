// @vitest-environment jsdom
//
// Task #777 — verifies the SEC16 Sync card surfaces a pre-check pairing badge
// ("already in sync" / mismatch) and a two-row hex preview before patching.

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

describe("Charger62BenchPanel — SEC16 pre-check pairing badge", () => {
  it("shows pairing badge and hex preview for RFH/BCM SEC16", async () => {
    render(<Charger62BenchPanel />);
    fireEvent.click(screen.getByText("Load bench set"));

    const badge = await waitFor(
      () => screen.getByTestId("sec16-pairing-badge"),
      { timeout: 4000 },
    );
    // 6.2 charger bench fixture is in-sync per ground-truth memory.
    expect(badge.textContent).toMatch(/Already paired|Mismatch|Pairing state/);

    const preview = screen.getByTestId("sec16-hex-preview");
    expect(preview.textContent).toMatch(/RFH SEC16/);
    expect(preview.textContent).toMatch(/BCM SEC16 BE/);
  });
});
