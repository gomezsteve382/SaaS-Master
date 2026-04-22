// @vitest-environment jsdom
//
// Regression tests: Task #278 + Task #282
//
// Task #278 — Verifies that the generation-highlight badge in BcmTab is cleared
// when the BCM dump is removed from the shared context via removeDump(), without
// going through closeInspect().  This covers the external-removal path (e.g. the
// FCA Analyzer tab calling removeDump on a shared dump) that bypasses the
// manual X-button in BcmTab.
//
// Task #282 — Extends coverage to the dump-switcher <select> dropdown.
// When the user picks a different dump from the dropdown the badge must update
// to match the newly-selected dump's generation, and must clear entirely when
// the dump carries no recognisable part-number family.
//
// Shared test flow:
//   1. Render BcmTab inside MasterVinProvider with a Challenger vehicle.
//   2. Simulate file-input change(s) that load BCM fixtures with known P/Ns.
//   3. Confirm the ✓ checkmark appears beside the correct generation badge.
//   4. Switch dump (via dropdown) or remove dump (via context) and re-assert.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import React, { useContext, useRef } from 'react';

import BcmTab from '../tabs/BcmTab.jsx';
import { MasterVinProvider, MasterVinContext } from '../lib/masterVinContext.jsx';
import { VEHICLES } from '../lib/vehicles.js';
import { makeBcm } from '../lib/__fixtures__/buildFixtures.js';

// ── BCM fixture helpers ───────────────────────────────────────────────────────
// parseBcmDumpPn() decodes the whole file as latin1 and scans for /68\d{6}/.
// Write the desired P/N as ASCII at a stable offset so it is always found.
function buildBcmBytesWithPn(pn) {
  const buf = makeBcm({ size: 65536 });
  if (pn) {
    const ascii = new TextEncoder().encode(pn);
    buf.set(ascii, 0x200); // well before any parsed field
  }
  return buf;
}

// A fixture with no part number that belongs to any known BCM family.
// makeBcm() places 'P68234567A' at 0x5818; 68234567 is NOT in BCM_KNOWN_PN so
// matchGeneration() returns null → detectedGen clears.
function buildBcmBytesUnknownPn() {
  return makeBcm({ size: 65536 });
}

const BCM_PN_LC2 = '68277389'; // Challenger 2015-2017 lc2
const BCM_PN_LC3 = '68396561'; // Challenger 2018-2023 lc3
const BCM_GEN_LABEL_LC2 = '2015–2017 LC';
const BCM_GEN_LABEL_LC3 = '2018–2023 LC';

// ── FileReader mocks ──────────────────────────────────────────────────────────
// Single-bytes variant (original test #278).
let restoreFileReader;

function installFileReaderMock(bytes) {
  const OriginalFileReader = global.FileReader;
  const MockFileReader = vi.fn(function () {
    const instance = {
      onload: null,
      readAsArrayBuffer: vi.fn(function () {
        Promise.resolve().then(() => {
          if (typeof instance.onload === 'function') {
            instance.onload({ target: { result: bytes.buffer } });
          }
        });
      }),
    };
    return instance;
  });
  global.FileReader = MockFileReader;
  return () => { global.FileReader = OriginalFileReader; };
}

// Sequence variant: each successive FileReader construction picks the next
// entry in bytesList (wraps to the last entry once exhausted).
function installSequenceFileReaderMock(bytesList) {
  const OriginalFileReader = global.FileReader;
  let callCount = 0;
  const MockFileReader = vi.fn(function () {
    const idx = callCount < bytesList.length ? callCount : bytesList.length - 1;
    callCount += 1;
    const bytes = bytesList[idx];
    const instance = {
      onload: null,
      readAsArrayBuffer: vi.fn(function () {
        Promise.resolve().then(() => {
          if (typeof instance.onload === 'function') {
            instance.onload({ target: { result: bytes.buffer } });
          }
        });
      }),
    };
    return instance;
  });
  global.FileReader = MockFileReader;
  return () => { global.FileReader = OriginalFileReader; };
}

// ── Shared utility: simulate a file being chosen in the hidden file input ─────
async function loadFileViaInput(bytes, filename = 'test_bcm.bin') {
  const fileInput = document.querySelector('input[type="file"]');
  expect(fileInput, 'file input must be present').toBeTruthy();
  const fakeFile = new File([bytes.buffer], filename, { type: 'application/octet-stream' });
  Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
  await act(async () => {
    fireEvent.change(fileInput);
    await new Promise(r => setTimeout(r, 60));
  });
}

// ── RemoveDump helper ─────────────────────────────────────────────────────────
function RemoveDumpHelper({ actionRef }) {
  const { getDumpsByType, removeDump } = useContext(MasterVinContext);
  actionRef.current = () => {
    const bcmDumps = getDumpsByType('BCM');
    bcmDumps.forEach(d => removeDump(d.hash));
  };
  return null;
}

// ── Test suites ───────────────────────────────────────────────────────────────
describe('BcmTab generation highlight', () => {
  let bcmBytes;
  let removeHelper;

  beforeEach(() => {
    bcmBytes = buildBcmBytesWithPn(BCM_PN_LC2);
    removeHelper = { current: null };
    restoreFileReader = installFileReaderMock(bcmBytes);
  });

  afterEach(() => {
    cleanup();
    restoreFileReader?.();
    vi.restoreAllMocks();
  });

  // ── Task #278 ─────────────────────────────────────────────────────────────
  it('clears the generation highlight when the BCM dump is removed externally', async () => {
    const vehicle = VEHICLES.challenger;

    render(
      <MasterVinProvider>
        <RemoveDumpHelper actionRef={removeHelper} />
        <BcmTab vehicle={vehicle} />
      </MasterVinProvider>,
    );

    await loadFileViaInput(bcmBytes);

    // Confirm ✓ badge appears for the matched generation.
    await waitFor(() => {
      const allText = document.body.textContent || '';
      expect(
        allText.includes('✓'),
        'a ✓ checkmark should be visible next to the matched generation badge',
      ).toBe(true);
    }, { timeout: 3000 });

    await waitFor(() => {
      const allText = document.body.textContent || '';
      expect(
        allText.includes(BCM_PN_LC2),
        `detected P/N ${BCM_PN_LC2} should appear in the info row`,
      ).toBe(true);
    }, { timeout: 3000 });

    // Remove dump externally (simulating FCA Analyzer tab).
    await act(async () => {
      removeHelper.current?.();
      await new Promise(r => setTimeout(r, 50));
    });

    // ✓ badge must be gone.
    await waitFor(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const checkmarkSpans = spans.filter(s => s.textContent.trim() === '✓');
      expect(
        checkmarkSpans.length,
        'no ✓ checkmark should remain after the dump is removed',
      ).toBe(0);
    }, { timeout: 3000 });

    await waitFor(() => {
      const allText = document.body.textContent || '';
      expect(
        allText.includes('Detected:'),
        '"Detected:" info row should disappear after dump removal',
      ).toBe(false);
    }, { timeout: 3000 });
  });
});

// ── Task #282: dump-switcher dropdown ────────────────────────────────────────
describe('BcmTab dump-switcher dropdown highlight', () => {
  afterEach(() => {
    cleanup();
    restoreFileReader?.();
    vi.restoreAllMocks();
  });

  it('updates the badge correctly when switching between two dumps with different P/Ns', async () => {
    const vehicle = VEHICLES.challenger;

    const bytesLc2 = buildBcmBytesWithPn(BCM_PN_LC2); // 2015-2017 LC
    const bytesLc3 = buildBcmBytesWithPn(BCM_PN_LC3); // 2018-2023 LC

    restoreFileReader = installSequenceFileReaderMock([bytesLc2, bytesLc3]);

    render(
      <MasterVinProvider>
        <BcmTab vehicle={vehicle} />
      </MasterVinProvider>,
    );

    // Load first dump (lc2 — 2015-2017 LC).
    await loadFileViaInput(bytesLc2, 'dump_lc2.bin');

    await waitFor(() => {
      expect(
        document.body.textContent.includes('✓'),
        'a ✓ should appear after loading the first dump',
      ).toBe(true);
    }, { timeout: 3000 });

    await waitFor(() => {
      expect(
        document.body.textContent.includes(BCM_GEN_LABEL_LC2),
        `"${BCM_GEN_LABEL_LC2}" badge should be highlighted`,
      ).toBe(true);
    }, { timeout: 3000 });

    // Load second dump (lc3 — 2018-2023 LC). The FileReader mock now returns bytesLc3.
    await loadFileViaInput(bytesLc3, 'dump_lc3.bin');

    // After loading the second dump bcmDumps.length becomes 2 → dropdown appears.
    await waitFor(() => {
      const sel = document.querySelector('select');
      expect(sel, 'dump-switcher <select> should appear with two dumps').toBeTruthy();
      expect(sel.options.length, 'dropdown should list exactly two dumps').toBe(2);
    }, { timeout: 3000 });

    // Currently the second dump (lc3) is active — verify its badge is highlighted.
    await waitFor(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const checked = spans.find(s => s.textContent.trim() === '✓');
      expect(checked, '✓ must exist for the active dump').toBeTruthy();
      // The parent/sibling text should contain the lc3 label.
      const row = checked?.parentElement?.textContent || '';
      expect(
        row.includes(BCM_GEN_LABEL_LC3),
        `✓ should be next to "${BCM_GEN_LABEL_LC3}" while the lc3 dump is selected`,
      ).toBe(true);
    }, { timeout: 3000 });

    // Switch back to the first dump (lc2) via the dropdown.
    const sel = document.querySelector('select');
    const firstOption = sel.options[0];
    await act(async () => {
      fireEvent.change(sel, { target: { value: firstOption.value } });
      await new Promise(r => setTimeout(r, 60));
    });

    // Badge must now show ✓ for the lc2 generation.
    await waitFor(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const checked = spans.find(s => s.textContent.trim() === '✓');
      expect(checked, '✓ must exist after switching back to the first dump').toBeTruthy();
      const row = checked?.parentElement?.textContent || '';
      expect(
        row.includes(BCM_GEN_LABEL_LC2),
        `✓ should be next to "${BCM_GEN_LABEL_LC2}" after switching back to the lc2 dump`,
      ).toBe(true);
    }, { timeout: 3000 });

    // lc3 badge must NOT have ✓.
    await waitFor(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const checkmarks = spans.filter(s => s.textContent.trim() === '✓');
      expect(checkmarks.length, 'exactly one ✓ should be visible').toBe(1);
    }, { timeout: 3000 });
  });

  it('clears the badge when switching to a dump with no known-family P/N', async () => {
    const vehicle = VEHICLES.challenger;

    const bytesLc2 = buildBcmBytesWithPn(BCM_PN_LC2);  // known P/N
    const bytesUnknown = buildBcmBytesUnknownPn();       // 68234567 — not in BCM family

    restoreFileReader = installSequenceFileReaderMock([bytesLc2, bytesUnknown]);

    render(
      <MasterVinProvider>
        <BcmTab vehicle={vehicle} />
      </MasterVinProvider>,
    );

    // Load the known-P/N dump first.
    await loadFileViaInput(bytesLc2, 'dump_known.bin');

    await waitFor(() => {
      expect(
        document.body.textContent.includes('✓'),
        '✓ should appear after loading the known-P/N dump',
      ).toBe(true);
    }, { timeout: 3000 });

    // Load the unknown-P/N dump second.
    await loadFileViaInput(bytesUnknown, 'dump_unknown.bin');

    await waitFor(() => {
      const sel = document.querySelector('select');
      expect(sel, 'dropdown should appear once two dumps are loaded').toBeTruthy();
    }, { timeout: 3000 });

    // The second dump (unknown P/N) is now active — no ✓ should be shown.
    await waitFor(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const checkmarks = spans.filter(s => s.textContent.trim() === '✓');
      expect(
        checkmarks.length,
        'no ✓ should appear for a dump with no known-family P/N',
      ).toBe(0);
    }, { timeout: 3000 });

    // Switch back to the known-P/N dump via the dropdown → ✓ must reappear.
    const sel = document.querySelector('select');
    const knownOption = sel.options[0]; // first-loaded = known P/N dump
    await act(async () => {
      fireEvent.change(sel, { target: { value: knownOption.value } });
      await new Promise(r => setTimeout(r, 60));
    });

    await waitFor(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const checkmarks = spans.filter(s => s.textContent.trim() === '✓');
      expect(
        checkmarks.length,
        '✓ should reappear after switching back to the known-P/N dump',
      ).toBe(1);
    }, { timeout: 3000 });

    // Now switch to the unknown dump again and confirm badge clears once more.
    const unknownOption = sel.options[1];
    await act(async () => {
      fireEvent.change(sel, { target: { value: unknownOption.value } });
      await new Promise(r => setTimeout(r, 60));
    });

    await waitFor(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const checkmarks = spans.filter(s => s.textContent.trim() === '✓');
      expect(
        checkmarks.length,
        '✓ must clear again when switching to the unknown-P/N dump',
      ).toBe(0);
    }, { timeout: 3000 });
  });
});
