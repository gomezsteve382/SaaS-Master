// @vitest-environment jsdom
//
// Task #503 — End-to-end UI coverage for the MODULE INSPECTOR tab inside the
// SRT Lab vehicle workspace.
//
// Task #496 added the FcaModuleInspector component and registered it as the
// `inspector` tab in the workspace tab registry. Task #530 retired the
// inspector-private parser (`parseInspectorModule` + helpers) so the live
// UI now runs entirely on the canonical `parseModule`; the realDumps ×
// parser coverage that used to live next to the inspector now asserts
// against `parseModule` directly in
// `src/lib/__tests__/parseModule.realDumps.test.js`. What that
// parser-only suite does NOT exercise is that the tab actually opens
// inside a workspace, accepts a loaded fixture, and renders the parsed
// module info to the DOM — a regression in the workspace tab routing or
// in the JSX rendering would not be caught by a parser-only suite.
//
// This suite mounts the full <App/>, navigates to a vehicle workspace,
// clicks the MODULE INSPECTOR tab, drops each of the three real-dump
// fixtures into the inspector's file input, and asserts:
//   1. The detected module name (e.g. "GPEC2A PCM" / "BCM DFLASH" /
//      "RFHUB EEE") is rendered in the module tile.
//   2. The first VIN row (`VIN: <17 chars>`) is rendered in the module
//      tile.
//   3. For the GPEC2A fixture only, the SKIM status string ("DISABLED")
//      is rendered in the module tile.
//
// Skip-don't-fail: if the realDumps manifest is missing the suite
// describe.skips so the build never breaks before fixtures are committed.

import React from 'react';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react';

import App from '../../App.jsx';
import { loadRealDumpFixtures } from '../../lib/__fixtures__/realDumps/loader.js';

const fixtures = loadRealDumpFixtures();

function bufferFile(name, bytes) {
  return new File([bytes], name, { type: 'application/octet-stream' });
}

// Walk into the workspace by clicking the first vehicle card on the
// landing page, then click the MODULE INSPECTOR tab in the workspace tab
// strip. Returns the inspector tab's hidden file <input> element so the
// caller can drop a fixture into it.
async function openInspectorTab() {
  // Landing page → click the CHARGER card. VEHICLE_LIST starts with
  // charger; the rendered card surfaces the vehicle name as visible
  // text inside a clickable wrapper div.
  const chargerLabel = await screen.findByText('CHARGER');
  // The card itself is the closest ancestor with an onClick — walk up
  // until we find an element whose role is implicitly clickable. The
  // simplest reliable approach is to click the label's nearest div
  // ancestor that has cursor:pointer. fireEvent.click bubbles, so
  // clicking the label dispatches through the wrapper's onClick handler.
  await act(async () => { fireEvent.click(chargerLabel); });

  // Workspace mounted → click the MODULE INSPECTOR tab button.
  const tabBtn = await screen.findByText('MODULE INSPECTOR');
  await act(async () => { fireEvent.click(tabBtn); });

  // The FcaModuleInspector body renders the file-drop card prompt
  // ("Drop .bin files here or click to load") only when the inspector
  // tab is active — wait for it as the readiness signal. (The earlier
  // fixture text "FCA Module Security Analyzer" no longer exists in
  // the rescued component; using the drop-card prompt is robust to
  // future copy changes in the hero.)
  await screen.findByText(/Drop \.bin files here/i);

  // The inspector's file input is a hidden <input type="file"
  // accept=".bin"> rendered inside the tab body. Other workspace tabs
  // are conditionally rendered (`{tab==='inspector' && ...}`), so when
  // the inspector tab is active this is the only `input[type="file"]`
  // in the DOM.
  const inputs = document.querySelectorAll('input[type="file"]');
  expect(inputs.length).toBeGreaterThan(0);
  // Pick the one that accepts .bin uploads (the inspector input). Other
  // file inputs in the workspace may match different accept patterns;
  // be defensive in case one ever leaks into the same render tree.
  const binInput = Array.from(inputs).find(i => (i.getAttribute('accept') || '').includes('.bin'));
  expect(binInput).toBeTruthy();
  return binInput;
}

// Drop a fixture into the inspector's hidden file input and wait for the
// module tile to render. The tile is keyed on the module's `name`
// (e.g. "GPEC2A PCM"), which only appears in the DOM after
// FileReader → parseModule → addDump has resolved.
async function loadFixtureInto(input, name, bytes, expectedModuleName) {
  const file = bufferFile(name, bytes);
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await waitFor(() => expect(screen.getByText(expectedModuleName)).toBeTruthy());
  // Module tile is the element whose direct text is the module name.
  // Walk up to the tile container so the caller can scope queries to it.
  const nameEl = screen.getByText(expectedModuleName);
  return nameEl.parentElement;
}

(fixtures ? describe : describe.skip)(
  'Task #503 — MODULE INSPECTOR tab end-to-end UI flow inside workspace',
  () => {
    beforeEach(() => {
      if (!fixtures) {
        throw new Error('realDumps manifest missing — cannot run inspector UI suite');
      }
    });
    afterEach(() => cleanup());

    (fixtures.pcm ? it : it.skip)(
      'GPEC2A PCM fixture: tab opens, fixture loads, module name + VIN + SKIM render',
      async () => {
        render(<App/>);
        const input = await openInspectorTab();
        const tile = await loadFixtureInto(
          input,
          'pcm.after.bin',
          fixtures.pcm.after,
          'GPEC2A PCM',
        );

        // (1) Detected module name — already asserted by loadFixtureInto's
        //     getByText('GPEC2A PCM'), but pin it explicitly here too so
        //     the assertion list reads top-to-bottom against the spec.
        expect(within(tile).getByText('GPEC2A PCM')).toBeTruthy();

        // (2) First VIN row — the tile renders "VIN: <17 chars>" for
        //     m.vins[0]. The pcm.after.bin VIN at byte 0 is the
        //     anonymized 2C3CDXCT1HH600000 per the fixtures suite.
        expect(within(tile).getByText(/VIN:\s*2C3CDXCT1HH600000/)).toBeTruthy();

        // (3) SKIM status — pcm.after.bin has SKIM=0x00 ("DISABLED")
        //     per the manifest's anonymized capture. The tile renders
        //     "SKIM: <status>" only for GPEC2A modules.
        expect(within(tile).getByText(/SKIM:\s*DISABLED/)).toBeTruthy();
      }
    );

    (fixtures.bcm ? it : it.skip)(
      'BCM DFLASH fixture: tab opens, fixture loads, module name + VIN render',
      async () => {
        render(<App/>);
        const input = await openInspectorTab();
        const tile = await loadFixtureInto(
          input,
          'bcm.after.bin',
          fixtures.bcm.after,
          'BCM DFLASH',
        );

        expect(within(tile).getByText('BCM DFLASH')).toBeTruthy();
        // bcm.after.bin's first VIN row (offset 0x5328) is the
        // anonymized 2C3CDXL90MH582899 per the fixtures suite.
        expect(within(tile).getByText(/VIN:\s*2C3CDXL90MH582899/)).toBeTruthy();
        // BCM tiles have no SKIM line — only GPEC2A populates m.skimStatus.
        expect(within(tile).queryByText(/SKIM:/)).toBeNull();
      }
    );

    (fixtures.rfhub ? it : it.skip)(
      'RFHUB EEE fixture: tab opens, fixture loads, module name + VIN render',
      async () => {
        render(<App/>);
        const input = await openInspectorTab();
        const tile = await loadFixtureInto(
          input,
          'rfhub.after.bin',
          fixtures.rfhub.after,
          'RFHUB EEE',
        );

        expect(within(tile).getByText('RFHUB EEE')).toBeTruthy();
        // rfhub.after.bin stores VIN bytes in reversed order at 0x0EA5.
        // Task #518 routes inspector loads through the canonical
        // `parseModule`, which matches every other tab and un-reverses
        // the bytes for display, so the rendered first VIN is the
        // decoded 2C3CDXCT1HH600000 (not the verbatim 000006HH1TCXDC3C2
        // the now-retired legacy inspector parser would have produced).
        expect(within(tile).getByText(/VIN:\s*2C3CDXCT1HH600000/)).toBeTruthy();
        // RFHUB tiles have no SKIM line.
        expect(within(tile).queryByText(/SKIM:/)).toBeNull();
      }
    );

    // Task #527 — a 64 KB capture that is NOT actually a BCM (no VINs at
    // the canonical 0x5320..0x5380 slots, no immo records at 0x40C0 /
    // 0x2000, no partial VINs at 0x4098 / 0x40B0) gets auto-detected as
    // BCM purely on size. Without surfacing parseModule's contentWarn the
    // inspector would silently render garbage VIN / IMMO / lock fields
    // off random padding bytes. This test pins the UI contract: the
    // inspector still parses the file (so existing diff / hex flows keep
    // working) but renders the same `ContentWarnBanner` the BCM tab uses
    // so the tech sees a "doesn't look like a BCM" hint before trusting
    // any of the BCM-panel output.
    it('64 KB blank/padded buffer renders the ContentWarnBanner before BCM-panel output', async () => {
      render(<App/>);
      const input = await openInspectorTab();
      // 64 KB of 0xFF — same shape as a padded GPEC2A or 95640 capture
      // that collided with the BCM size. Hits the BCM branch in
      // parseModule (`sz===65536` → type='BCM') but populates
      // `mod.contentWarn` because none of the BCM-defining structures
      // are present.
      const blank = new Uint8Array(65536).fill(0xff);
      const file = bufferFile('padded.bin', blank);
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
      });
      // The module tile still appears (the file is still parsed) — the
      // contract is "warn, don't reject".
      await waitFor(() => expect(screen.getByText('BCM DFLASH')).toBeTruthy());
      // The banner rendered by ContentWarnBanner carries the "DOESN'T
      // LOOK LIKE A BCM" heading and names the file size in bytes.
      const banner = await screen.findByTestId('inspector-content-warn');
      expect(banner).toBeTruthy();
      expect(within(banner).getByText(/DOESN'T LOOK LIKE A BCM/)).toBeTruthy();
      // "65,536" appears in both the heading line and the body copy of
      // the banner, so use getAllByText and assert at least one hit.
      expect(within(banner).getAllByText(/65,536/).length).toBeGreaterThan(0);
      expect(within(banner).getByText('padded.bin')).toBeTruthy();
    });

    // Task #527 — companion negative case: a real BCM dump must NOT
    // show the content-warn banner. Pins that the warning is gated on
    // parseModule's `contentWarn` (populated only when the BCM-defining
    // structures are blank), not on file size or filename alone.
    (fixtures.bcm ? it : it.skip)(
      'real BCM fixture does NOT render the ContentWarnBanner',
      async () => {
        render(<App/>);
        const input = await openInspectorTab();
        await loadFixtureInto(
          input,
          'bcm.after.bin',
          fixtures.bcm.after,
          'BCM DFLASH',
        );
        expect(screen.queryByTestId('inspector-content-warn')).toBeNull();
        expect(screen.queryByText(/DOESN'T LOOK LIKE A BCM/)).toBeNull();
      }
    );

    // Task #519 — undersized fragment is rejected with the structured
    // size-warn card instead of being silently parsed as an RFHUB. The
    // pre-#519 detector silently labeled anything 1..8192 B (except
    // 4096) as RFHUB and surfaced fake VIN/key output for partial
    // captures; the new component-level guard pairs the detected type
    // with `moduleTooSmall` from parseModule.js so the upload is
    // refused at the entry point. This test pins the UI-level contract
    // (banner present, no module tile added, no RFHUB-derived fields
    // shown) so the fix can't silently regress.
    it('1 KB fragment is rejected with the size-warn card and never parsed as RFHUB', async () => {
      render(<App/>);
      const input = await openInspectorTab();
      const frag = new Uint8Array(1024); // all-zero 1 KB slice
      const file = bufferFile('fragment.bin', frag);
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
      });
      // The reject card carries a stable testid for this exact case.
      const card = await screen.findByTestId('inspector-too-small-card');
      expect(card).toBeTruthy();
      // The banner names the fragment, the actual size, and the required
      // minimum — same shape as the GPEC2A tab's too-small card.
      expect(within(card).getByText(/fragment\.bin/)).toBeTruthy();
      expect(within(card).getByText(/1,024 bytes/)).toBeTruthy();
      expect(within(card).getByText(/2,048 bytes/)).toBeTruthy();
      // No module tile rendered → the inspector did NOT silently label
      // the fragment as an RFHUB EEE and never produced fake VIN output.
      expect(screen.queryByText('RFHUB EEE')).toBeNull();
      expect(screen.queryByText(/FOBIK:/)).toBeNull();
    });
  }
);
