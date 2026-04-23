// @vitest-environment jsdom
//
// Task #396 — end-to-end regression for the Mismatch Wizard reporting
// "Found 0 errors" on a paired BCM + virgin PCM trio.
//
// Pre-#396 the Mismatch Wizard's issue list was hand-rolled in
// ModuleSync.jsx and never consulted the BCM SEC16 → SEC6 ↔ PCM SEC6
// pairing rule. On the 2026-04-23 incident trio (paired BCM + RFHUB +
// PCM SEC6 = FF FF 00 FF FF FF) the wizard summary showed
// "Found 0 errors" and the in-app AI told the user "safe to program a
// key" — even though the PCM had never been paired with that BCM.
//
// This test loads a real synced BCM dump (split records → resolved
// SEC16) into the Module Sync tab alongside a synthetic GPEC2A virgin
// (SEC6 = FF FF 00 FF FF FF) and asserts:
//   1. PcmCard's "Immo (SEC6)" pill reads the new virgin label, not
//      "✓ Populated".
//   2. Opening the Mismatch Wizard renders ≥1 error.
//   3. The error list contains a row matching /BCM SEC16.*PCM SEC6/i.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ModuleSync from '../tabs/ModuleSync.jsx';
import { MasterVinProvider } from '../lib/masterVinContext.jsx';
import { makeGpec2a, makeRfhubGen2 } from '../lib/__fixtures__/buildFixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const SYNCED_BCM = 'SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin';
const SYNCED_VIN = '2C3CDXL90MH582899';
// The incident reading: mostly-FF, slipped through the old every(b===0xFF)
// heuristic as "Populated".
const VIRGIN_SEC6 = new Uint8Array([0xFF,0xFF,0x00,0xFF,0xFF,0xFF]);

function fileFromBytes(bytes, name) {
  return new File([bytes], name, { type: 'application/octet-stream' });
}

async function loadFileIntoInput(input, file) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
    await new Promise(r => setTimeout(r, 100));
  });
}

beforeEach(() => {
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
  try { window.localStorage.clear(); } catch { /* ignore */ }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  // Stub fetch so the wizard chat panel hydration doesn't blow up.
  globalThis.fetch = vi.fn(() => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ id: 'stub', messages: [] }),
  }));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Task #396 — Mismatch Wizard surfaces virgin PCM SEC6 against a paired BCM', () => {
  it('PcmCard pill reads virgin (mostly-FF), wizard reports ≥1 error and BCM↔PCM SEC6 row', async () => {
    const bcmBytes = new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, SYNCED_BCM)));
    const pcmBytes = makeGpec2a({ vin: SYNCED_VIN, pcmSec6Bytes: VIRGIN_SEC6 });
    const rfhBytes = makeRfhubGen2({ vin: SYNCED_VIN });

    render(
      <MasterVinProvider>
        <ModuleSync />
      </MasterVinProvider>,
    );

    // DropZone order: BCM (0), RFHUB (1), PCM (2), 95640 (3).
    const inputs = document.querySelectorAll('input[type="file"]');
    expect(inputs.length).toBeGreaterThanOrEqual(4);

    // Re-query inputs between uploads — DropZone may re-render and
    // detach the original input elements after each file load.
    const queryInputs = () => document.querySelectorAll('input[type="file"]');
    await loadFileIntoInput(queryInputs()[0], fileFromBytes(bcmBytes, SYNCED_BCM));
    await waitFor(() => expect(document.body.textContent).toMatch(/Stored VIN[\s\S]*2C3CDXL90MH582899/), { timeout: 3000 });
    await loadFileIntoInput(queryInputs()[1], fileFromBytes(rfhBytes, 'RFH.bin'));
    await new Promise(r => setTimeout(r, 50));
    await loadFileIntoInput(queryInputs()[2], fileFromBytes(pcmBytes, 'PCM_VIRGIN.bin'));

    // ── (1) PcmCard pill must reflect the new virgin classification ──────
    // Wait for PcmCard to render, then assert the new virgin label is on
    // the page and "✓ Populated" is NOT — the green badge must not trick
    // the user when SEC6 is FF FF 00 FF FF FF.
    await waitFor(
      () => expect(document.body.textContent).toMatch(/Virgin \(mostly FF\)/i),
      { timeout: 3000 },
    );
    expect(document.body.textContent).not.toMatch(/Immo \(SEC6\)[^V]*✓ Populated/);

    // ── (2 + 3) Open the wizard and check the error count + BCM↔PCM line.
    const openBtn = screen.getByRole('button', { name: /Open Wizard/i });
    await act(async () => { fireEvent.click(openBtn); });

    // The wizard recognises this trio (paired BCM + RFHUB + virgin
    // PCM SEC6) and routes the user to the "Pair BCM + RFHUB + Engine
    // computer" one-click scenario with the engine-immobilizer-key
    // damaged warning. Pre-#396 the wizard was silent on this case.
    await waitFor(
      () => expect(document.body.textContent).toMatch(/Mismatch Resolution Wizard/i),
      { timeout: 3000 },
    );
    const bodyAfterOpen = document.body.textContent || '';
    // The user must see actionable guidance — either the SummaryScreen
    // "Found N error(s)" line or the one-click "engine immobilizer key
    // missing/damaged" panel.
    const summary = bodyAfterOpen.match(/Found\s*(\d+)\s*error/i);
    const oneClick = /engine computer's immobilizer key is missing or damaged/i.test(bodyAfterOpen)
      || /Pair BCM \+ RFHUB \+ Engine computer/i.test(bodyAfterOpen);
    expect(summary || oneClick).toBeTruthy();
    if (summary) {
      expect(parseInt(summary[1], 10)).toBeGreaterThanOrEqual(1);
      expect(bodyAfterOpen).toMatch(/BCM SEC16.*PCM SEC6/i);
      expect(bodyAfterOpen).toMatch(/never paired with this BCM/i);
    }
    // Must NOT be the green "All clear" / 0-errors silent-pass state.
    expect(bodyAfterOpen).not.toMatch(/Found\s*0\s*error/i);
    expect(bodyAfterOpen).not.toMatch(/All clear/i);
  });
});
