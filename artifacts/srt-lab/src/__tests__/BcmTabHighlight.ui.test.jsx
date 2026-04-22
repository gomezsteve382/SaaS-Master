// @vitest-environment jsdom
//
// Regression test: Task #278
// Verifies that the generation-highlight badge in BcmTab is cleared when the
// BCM dump is removed from the shared context via removeDump(), without going
// through closeInspect().  This covers the external-removal path (e.g. the
// FCA Analyzer tab calling removeDump on a shared dump) that bypasses the
// manual X-button in BcmTab.
//
// Flow:
//   1. Render BcmTab inside MasterVinProvider with a Challenger vehicle.
//   2. Simulate a file-input change that loads a BCM fixture embedding P/N
//      68277389 (Challenger lx2 gen, 2015-2017).
//   3. Confirm the ✓ checkmark appears beside the matched generation badge.
//   4. Call removeDump() on the context from outside BcmTab (external path).
//   5. Assert the ✓ checkmark is gone and detectedGen has been cleared.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import React, { useContext, useRef } from 'react';

import BcmTab from '../tabs/BcmTab.jsx';
import { MasterVinProvider, MasterVinContext } from '../lib/masterVinContext.jsx';
import { VEHICLES } from '../lib/vehicles.js';
import { makeBcm } from '../lib/__fixtures__/buildFixtures.js';

// ── BCM fixture that embeds a real known part number ─────────────────────────
// parseBcmDumpPn() decodes the whole file as latin1 and scans for /68\d{6}/.
// Write '68277389' (Challenger 2015-17 lx2) as ASCII at a stable offset so it
// is always found as the primary P/N.
function buildBcmBytesWithPn(pn) {
  const buf = makeBcm({ size: 65536 });
  const ascii = new TextEncoder().encode(pn);
  buf.set(ascii, 0x200); // well before any parsed field
  return buf;
}

const BCM_PN = '68277389';
const BCM_GEN_LABEL = '2015–2017 LC'; // Challenger lx2

// ── FileReader mock ──────────────────────────────────────────────────────────
// jsdom's FileReader.readAsArrayBuffer works for real File objects but may be
// async-unreliable across environments.  We install a controlled mock that
// fires onload synchronously in the next microtask.
let restoreFileReader;

function installFileReaderMock(bytes) {
  const OriginalFileReader = global.FileReader;
  const MockFileReader = vi.fn(function () {
    const instance = {
      onload: null,
      readAsArrayBuffer: vi.fn(function () {
        // Fire in a microtask so React state updates settle normally.
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

// ── RemoveDump helper ─────────────────────────────────────────────────────────
// Renders invisibly inside the Provider and exposes a callback ref that the
// test can invoke to call removeDump on the shared context.
function RemoveDumpHelper({ actionRef }) {
  const { getDumpsByType, removeDump } = useContext(MasterVinContext);
  actionRef.current = () => {
    const bcmDumps = getDumpsByType('BCM');
    bcmDumps.forEach(d => removeDump(d.hash));
  };
  return null;
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe('BcmTab generation highlight', () => {
  let bcmBytes;
  let removeHelper;

  beforeEach(() => {
    bcmBytes = buildBcmBytesWithPn(BCM_PN);
    removeHelper = { current: null };
    restoreFileReader = installFileReaderMock(bcmBytes);
  });

  afterEach(() => {
    cleanup();
    restoreFileReader?.();
    vi.restoreAllMocks();
  });

  it('clears the generation highlight when the BCM dump is removed externally', async () => {
    const vehicle = VEHICLES.challenger;

    render(
      <MasterVinProvider>
        <RemoveDumpHelper actionRef={removeHelper} />
        <BcmTab vehicle={vehicle} />
      </MasterVinProvider>,
    );

    // ── Step 1: simulate a file being chosen in the hidden file input ─────────
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput, 'file input must be present').toBeTruthy();

    const fakeFile = new File([bcmBytes.buffer], 'test_bcm.bin', {
      type: 'application/octet-stream',
    });
    Object.defineProperty(fileInput, 'files', {
      value: [fakeFile],
      configurable: true,
    });

    await act(async () => {
      fireEvent.change(fileInput);
      // Allow the FileReader mock's microtask to resolve.
      await new Promise(r => setTimeout(r, 50));
    });

    // ── Step 2: confirm the ✓ badge appears for the matched generation ─────────
    await waitFor(() => {
      const allText = document.body.textContent || '';
      expect(
        allText.includes('✓'),
        'a ✓ checkmark should be visible next to the matched generation badge',
      ).toBe(true);
    }, { timeout: 3000 });

    // Also verify the detected-P/N info row appears (belt-and-suspenders).
    await waitFor(() => {
      const allText = document.body.textContent || '';
      expect(
        allText.includes(BCM_PN),
        `detected P/N ${BCM_PN} should appear in the info row`,
      ).toBe(true);
    }, { timeout: 3000 });

    // ── Step 3: remove the dump externally (simulating FCA Analyzer tab) ──────
    await act(async () => {
      removeHelper.current?.();
      await new Promise(r => setTimeout(r, 50));
    });

    // ── Step 4: assert the ✓ badge is gone ────────────────────────────────────
    await waitFor(() => {
      // The generation badges are still rendered (they're always shown when a
      // vehicle is selected), but none should have a ✓ prefix anymore.
      const spans = Array.from(document.querySelectorAll('span'));
      const checkmarkSpans = spans.filter(
        s => s.textContent.trim() === '✓',
      );
      expect(
        checkmarkSpans.length,
        'no ✓ checkmark should remain after the dump is removed',
      ).toBe(0);
    }, { timeout: 3000 });

    // The detected P/N info row should also be gone.
    await waitFor(() => {
      // The "Detected:" row (rendered when detectedPn is set) should not appear.
      const allText = document.body.textContent || '';
      expect(
        allText.includes('Detected:'),
        '"Detected:" info row should disappear after dump removal',
      ).toBe(false);
    }, { timeout: 3000 });
  });
});
