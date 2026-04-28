// @vitest-environment jsdom
//
// Task #475 — PCM file-size mismatch guards.
//
// The Module Sync workspace must surface byte-size + chip-variant badges
// on every loaded file, block Generate when the PCM source is not a
// clean 4 KB / 8 KB EXT EEPROM, ask the tech to confirm before resizing
// the PCM output to a different bench chip than the donor, stamp the
// actual byte length into the download filename + success toast, and
// show a "Programmer says 'File different size'?" help blurb so the
// tech can self-diagnose the rejection without leaving the page.
//
// We exercise the helpers (moduleSizeBadge, resizePcmForTargetChip)
// directly so the size + filename contract is locked at the unit level,
// then check the user-visible bits (badges on each upload zone, the
// always-on programmer-error help line) through the rendered workspace
// so the wiring can't silently regress in the JSX.

import React from "react";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

import ModuleSync, {
  moduleSizeBadge,
  resizePcmForTargetChip,
} from "../tabs/ModuleSync.jsx";
import { MasterVinProvider } from "../lib/masterVinContext.jsx";
import { makeBcm } from "../lib/__fixtures__/buildFixtures.js";

afterEach(() => cleanup());

describe("Task #475 — moduleSizeBadge helper", () => {
  it("returns the canonical 95320 / 95640 chip badge for a clean PCM size", () => {
    const b1 = moduleSizeBadge('pcm', 4096);
    expect(b1).toBeTruthy();
    expect(b1.label).toMatch(/95320/);
    expect(b1.canonical).toBe(true);
    expect(b1.dataKey).toBe('4kb');

    const b2 = moduleSizeBadge('pcm', 8192);
    expect(b2.label).toMatch(/95640/);
    expect(b2.canonical).toBe(true);
    expect(b2.dataKey).toBe('8kb');
  });

  it("flags a non-canonical PCM size as UNKNOWN CHIP with the raw byte count", () => {
    /* Task #486 — Module Sync, RFH↔PCM, and Dumps tab now share the
     * same chip-first wording for non-canonical PCM sizes ('UNKNOWN
     * CHIP' + raw byte count, amber) instead of the older red
     * '{kb} KB · OTHER' so techs don't second-guess whether 'OTHER'
     * on one tab and 'UNKNOWN CHIP' on another mean different things. */
    const b = moduleSizeBadge('pcm', 5000);
    expect(b).toBeTruthy();
    expect(b.label).toMatch(/UNKNOWN CHIP/);
    expect(b.label).toMatch(/5,000 B/);
    expect(b.canonical).toBe(false);
    expect(b.dataKey).toBe('unknown');
  });

  it("recognises the canonical BCM / RFH / EEP sizes", () => {
    expect(moduleSizeBadge('bcm', 65536).label).toMatch(/64 KB/);
    expect(moduleSizeBadge('bcm', 131072).label).toMatch(/128 KB/);
    expect(moduleSizeBadge('rfh', 2048).label).toMatch(/2 KB/);
    expect(moduleSizeBadge('rfh', 4096).label).toMatch(/4 KB/);
    expect(moduleSizeBadge('eep', 8192).label).toMatch(/8 KB/);
    expect(moduleSizeBadge('eep', 16384).label).toMatch(/16 KB/);
  });

  it("returns null when the byte count is not yet known", () => {
    expect(moduleSizeBadge('pcm', null)).toBeNull();
    expect(moduleSizeBadge('pcm', undefined)).toBeNull();
  });
});

describe("Task #475 — resizePcmForTargetChip helper", () => {
  it("slices an 8 KB buffer to 4 KB when target chip is 4kb", () => {
    const inp = new Uint8Array(8192);
    for (let i = 0; i < 4096; i++) inp[i] = i & 0xFF;     /* meaningful first half */
    inp.fill(0xFF, 4096);                                 /* padded second half */
    const r = resizePcmForTargetChip(inp, '4kb');
    expect(r.bytes.length).toBe(4096);
    expect(r.suffix).toBe('_4KB');
    /* First half preserved byte-for-byte */
    for (let i = 0; i < 4096; i++) expect(r.bytes[i]).toBe(i & 0xFF);
  });

  it("0xFF-pads a 4 KB buffer to 8 KB when target chip is 8kb", () => {
    const inp = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) inp[i] = (i * 3) & 0xFF;
    const r = resizePcmForTargetChip(inp, '8kb');
    expect(r.bytes.length).toBe(8192);
    expect(r.suffix).toBe('_8KB');
    /* First half preserved, second half all 0xFF */
    for (let i = 0; i < 4096; i++) expect(r.bytes[i]).toBe((i * 3) & 0xFF);
    for (let i = 4096; i < 8192; i++) expect(r.bytes[i]).toBe(0xFF);
  });

  it("passes through when source already matches target chip size", () => {
    const inp4 = new Uint8Array(4096).fill(0x42);
    expect(resizePcmForTargetChip(inp4, '4kb').bytes).toBe(inp4);
    expect(resizePcmForTargetChip(inp4, '4kb').suffix).toBe('_4KB');

    const inp8 = new Uint8Array(8192).fill(0x99);
    expect(resizePcmForTargetChip(inp8, '8kb').bytes).toBe(inp8);
    expect(resizePcmForTargetChip(inp8, '8kb').suffix).toBe('_8KB');
  });

  it("emits the size-suffix even when chipKey is null and bytes are canonical", () => {
    /* Tech could land here when no donor was loaded but the suffix is
     * still wanted on a freshly-built output buffer. */
    expect(resizePcmForTargetChip(new Uint8Array(4096), null).suffix).toBe('_4KB');
    expect(resizePcmForTargetChip(new Uint8Array(8192), null).suffix).toBe('_8KB');
  });

  it("truncates a non-canonical buffer to 4 KB when target chip is 4kb", () => {
    /* Task #481 — the per-vehicle Dumps tab feeds non-canonical sources
     * (e.g. a partial / oversize EXT EEPROM dump) through this helper
     * so the on-disk file is always exactly 4 KB or 8 KB and bench
     * programmers don't reject with "File different size". */
    const inp = new Uint8Array(5000);
    for (let i = 0; i < 5000; i++) inp[i] = i & 0xFF;
    const r = resizePcmForTargetChip(inp, '4kb');
    expect(r.bytes.length).toBe(4096);
    expect(r.suffix).toBe('_4KB');
    /* First 4 KB preserved byte-for-byte from the input. */
    for (let i = 0; i < 4096; i++) expect(r.bytes[i]).toBe(i & 0xFF);
  });

  it("0xFF-pads a short non-canonical buffer to 8 KB when target chip is 8kb", () => {
    const inp = new Uint8Array(3000);
    for (let i = 0; i < 3000; i++) inp[i] = (i * 5) & 0xFF;
    const r = resizePcmForTargetChip(inp, '8kb');
    expect(r.bytes.length).toBe(8192);
    expect(r.suffix).toBe('_8KB');
    /* Original bytes preserved, tail filled with 0xFF. */
    for (let i = 0; i < 3000; i++) expect(r.bytes[i]).toBe((i * 5) & 0xFF);
    for (let i = 3000; i < 8192; i++) expect(r.bytes[i]).toBe(0xFF);
  });

  it("0xFF-pads a sub-4 KB buffer up to 4 KB when target chip is 4kb", () => {
    /* Lock the small-source corner: a 2 KB partial dump headed for a
     * 95320 chip must come out exactly 4096 bytes with the trailing
     * gap filled with 0xFF (Multi-PROG accepts erased-state padding). */
    const inp = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) inp[i] = (i * 7) & 0xFF;
    const r = resizePcmForTargetChip(inp, '4kb');
    expect(r.bytes.length).toBe(4096);
    expect(r.suffix).toBe('_4KB');
    for (let i = 0; i < 2048; i++) expect(r.bytes[i]).toBe((i * 7) & 0xFF);
    for (let i = 2048; i < 4096; i++) expect(r.bytes[i]).toBe(0xFF);
  });

  it("truncates an over-8 KB buffer down to 8 KB when target chip is 8kb", () => {
    /* Lock the oversize corner: a 12 KB combined dump headed for a
     * 95640 chip must come out exactly 8192 bytes, lower 8 KB preserved. */
    const inp = new Uint8Array(12000);
    for (let i = 0; i < 12000; i++) inp[i] = (i * 3) & 0xFF;
    const r = resizePcmForTargetChip(inp, '8kb');
    expect(r.bytes.length).toBe(8192);
    expect(r.suffix).toBe('_8KB');
    for (let i = 0; i < 8192; i++) expect(r.bytes[i]).toBe((i * 3) & 0xFF);
  });

  it("passes through with empty suffix when chipKey is null and input is non-canonical", () => {
    /* No chip target picked + odd input — leave bytes untouched. The
     * Module Sync workspace blocks Generate at this point, so this
     * branch only matters as a defensive default for direct callers. */
    const r = resizePcmForTargetChip(new Uint8Array(5000), null);
    expect(r.bytes.length).toBe(5000);
    expect(r.suffix).toBe('');
  });
});

describe("Task #475 — Module Sync UI surface", () => {
  it("renders the 'Programmer says \"File different size\"?' help blurb up-front", () => {
    render(
      <MasterVinProvider setPg={() => {}}>
        <ModuleSync />
      </MasterVinProvider>
    );
    const help = screen.getByTestId('modsync-programmer-size-help');
    expect(help.textContent).toMatch(/File different size/i);
    /* The blurb should also point the tech at the EXT EEPROM as the fix
     * — that's the diagnosis that turns "wrong file size" into a
     * resolvable problem. */
    expect(help.textContent).toMatch(/EXT EEPROM/i);
  });

  it("shows a byte-count + chip badge on the BCM upload zone after a fixture is loaded", async () => {
    const { container } = render(
      <MasterVinProvider setPg={() => {}}>
        <ModuleSync />
      </MasterVinProvider>
    );
    const inputs = container.querySelectorAll('input[type="file"]');
    expect(inputs.length).toBeGreaterThanOrEqual(4);
    const bcmBytes = makeBcm({ size: 65536 });
    const file = new File([bcmBytes], 'BCM.bin', { type: 'application/octet-stream' });
    await act(async () => {
      fireEvent.change(inputs[0], { target: { files: [file] } });
    });
    await waitFor(() => {
      const badge = screen.getByTestId('modsync-bcm-size-badge');
      expect(badge.textContent).toMatch(/64 KB/);
      expect(badge.getAttribute('data-size-key')).toBe('64kb');
      expect(badge.getAttribute('data-size-canonical')).toBe('1');
    });
    /* The visible byte count next to the badge is what the tech cross-
     * references with the bench reader's reported count. */
    const counter = container.querySelector('span[style*="rgb(90, 90, 90)"]');
    expect(counter?.textContent).toMatch(/65,?536/);
  });
});
