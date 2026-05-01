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

    // Task #526 — the mirror case of the Task #519 undersized guard.
    // An OVERSIZED capture (e.g. a 64 KB padded read of a 4 KB GPEC2A
    // PCM, surfaced in the wild as JOVENTINO_GPEC2A_PCM_EEPROM_padded.bin)
    // is reclassified by parseModule via the filename hint into GPEC2A
    // with a populated `sizeWarn` (see the parseModule.test.js case
    // "64 KB padded GPEC2A (no BCM content) reclassifies via filename
    // hint and warns"). Pre-#526 the inspector silently added the
    // padded buffer to its module list without surfacing the size
    // mismatch, so a tech reading the tile saw "✓ parsed" with no clue
    // that the file was 16× the expected EEPROM image. This test pins
    // the contract: the SizeWarnBanner is rendered with the standard
    // re-dump guidance, and the file is still parsed and visible in
    // the module list (the warning is informational, not a rejection).
    it('64 KB padded GPEC2A capture renders the SizeWarnBanner but is still parsed', async () => {
      render(<App/>);
      const input = await openInspectorTab();
      // 64 KB all-FF buffer with a GPEC2A filename hint — parseModule
      // reclassifies this as GPEC2A (filename trumps the size-only BCM
      // fallback when looksLikeRealBcm() returns false) and attaches a
      // sizeWarn whose .expected is the nearest canonical size (8192).
      const padded = new Uint8Array(65536).fill(0xFF);
      const file = bufferFile('JOVENTINO_GPEC2A_PCM_EEPROM_padded.bin', padded);
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
      });
      // Banner present — same component the GPEC2A / BCM tabs use.
      const warn = await screen.findByTestId('inspector-size-warn');
      expect(warn).toBeTruthy();
      // Standard banner copy: the headline calls out the oversized
      // condition + the canonical "Unusual size" message from
      // buildSizeWarn (got 65,536 B, expected 8,192 B for GPEC2A).
      expect(within(warn).getByText(/OVERSIZED CAPTURE/i)).toBeTruthy();
      expect(within(warn).getByText(/65,536 B/)).toBeTruthy();
      expect(within(warn).getByText(/8,192 B/)).toBeTruthy();
      // Standard re-dump guidance is one of the bullets in the banner.
      expect(within(warn).getByText(/Re-dump.*real EEPROM size/i)).toBeTruthy();
      // The originating filename is rendered in the banner header so
      // the user can tell which capture is the oversized one when
      // multiple modules are loaded.
      expect(within(warn).getByText(/JOVENTINO_GPEC2A_PCM_EEPROM_padded\.bin/)).toBeTruthy();
      // The module is STILL parsed and added to the inspector — the
      // banner is informational, not a rejection. The module tile
      // surfaces the GPEC2A name so the user can inspect what was
      // recovered from the partial-but-usable payload.
      expect(screen.getByText('GPEC2A PCM')).toBeTruthy();
      // And the rejection card from Task #519 must NOT fire — this is
      // an oversized warning, not an undersized rejection.
      expect(screen.queryByTestId('inspector-too-small-card')).toBeNull();
    });

    // Task #538 — companion to the Task #526 sizeWarn case above. A 64 KB
    // capture with no filename hint that lets parseModule reclassify
    // (e.g. a padded GPEC2A / 95640 capture saved as `dump.bin`) lands in
    // the inspector typed as BCM purely on size, because parseModule's
    // size-only fallback maps the 64 KB / 128 KB family to BCM. Without
    // surfacing the contentWarn block, the BCM panel below would render
    // garbage VIN / IMMO / lock verdicts off random padding bytes and the
    // tech would have no warning attached. This test pins the contract
    // mirroring Task #526's sizeWarn assertion: the file IS still parsed
    // and added as a BCM module tile (so existing diff / hex flows keep
    // working), but the shared `ContentWarnBanner` is rendered with the
    // standard "DOESN'T LOOK LIKE A BCM" copy AND prefixed with the
    // inspector's module-type / filename header, the same way the
    // sizeWarn list above is, so users can tell which capture triggered
    // the warning when multiple modules are loaded.
    it('64 KB all-FF buffer (no filename hint) lands as BCM, surfaces the DOESN\'T LOOK LIKE A BCM banner with module-type header, and is still parsed', async () => {
      render(<App/>);
      const input = await openInspectorTab();
      // 64 KB of 0xFF with a neutral filename — no `gpec2a` / `95640`
      // hint that parseModule's filename trump could use to reclassify.
      // parseModule maps 65,536 B → BCM purely on size, then attaches
      // contentWarn because none of the BCM-defining structures are
      // present (VIN slots all 0xFF, immo bank blank, partial slots blank).
      const blank = new Uint8Array(65536).fill(0xff);
      const file = bufferFile('dump.bin', blank);
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
      });

      // (1) Still parsed/visible in the module list — the contract is
      //     "warn, don't reject", so the BCM tile must render.
      await waitFor(() => expect(screen.getByText('BCM DFLASH')).toBeTruthy());

      // (2) ContentWarnBanner is rendered for this dump — wrapped in the
      //     `inspector-content-warn` testid the inspector emits per
      //     warning entry.
      const banner = await screen.findByTestId('inspector-content-warn');
      expect(banner).toBeTruthy();

      // (3) Standard "DOESN'T LOOK LIKE A BCM" headline copy from the
      //     shared ContentWarnBanner component — same wording the BCM
      //     tab surfaces so the inspector matches the rest of the app.
      expect(within(banner).getByText(/DOESN'T LOOK LIKE A BCM/)).toBeTruthy();
      // The body copy explains the file is being parsed as a BCM purely
      // because of its size — confirms the size-only auto-detect path.
      expect(within(banner).getByText(/being parsed as a BCM/i)).toBeTruthy();

      // (4) The header above the banner uses the same `module-type ·
      //     filename` shape the sizeWarn list uses, so multi-module loads
      //     stay disambiguated. inspectorName('BCM') → 'BCM DFLASH'.
      expect(within(banner).getByText('BCM DFLASH', { exact: false })).toBeTruthy();
      expect(within(banner).getByText('dump.bin')).toBeTruthy();

      // (5) Sanity: the wrapper list testid is present, mirroring the
      //     sizeWarn list's `inspector-size-warn-list` wrapper. Pins the
      //     visual symmetry between the two warning families.
      expect(screen.getByTestId('inspector-content-warn-list')).toBeTruthy();

      // (6) The size-warn block must NOT fire here — 65,536 B is the
      //     canonical BCM size, so there is no sizeWarn to surface; the
      //     warning is content-only, not size-related.
      expect(screen.queryByTestId('inspector-size-warn')).toBeNull();
      // Same for the undersized rejection card.
      expect(screen.queryByTestId('inspector-too-small-card')).toBeNull();
    });
  }
);
