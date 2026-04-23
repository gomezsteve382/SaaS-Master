// @vitest-environment jsdom
//
// Task #374 — End-to-end UI regression for the size-guard ("too small") cards.
//
// Task #372 added unit tests that locked down the parser short-circuits for
// undersized RFHUB / PCM / GPEC2A dumps, but did NOT verify that the
// inspector cards actually render with the wording techs see. This suite
// loads a 1 KB fragment into each slot and asserts the data-testid card is
// visible with the size, required-min and detected-extension lines, so a
// future styling refactor cannot quietly remove the card while the parser
// still returns `tooSmall: true`.
//
// Coverage:
//   - Sincro inspector (ModuleSync): RFHUB slot  → rfh-too-small-card
//   - Sincro inspector (ModuleSync): PCM slot    → pcm-too-small-card
//   - Standalone RFHUB inspector (RfhubTab)      → rfh-too-small-card
//   - Standalone GPEC2A inspector (Gpec2aTab)    → gpec2a-too-small-card

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import React from 'react';

import ModuleSync from '../tabs/ModuleSync.jsx';
import RfhubTab from '../tabs/RfhubTab.jsx';
import Gpec2aTab from '../tabs/Gpec2aTab.jsx';
import { MasterVinProvider } from '../lib/masterVinContext.jsx';

// ── Helpers ──────────────────────────────────────────────────────────────────
const FRAGMENT_SIZE = 1024;          // 1 KB fragment — well below every floor
const FRAGMENT_NAME = 'fragment.bin'; // → detected ext '.bin'

function makeFragmentFile(name = FRAGMENT_NAME, size = FRAGMENT_SIZE) {
  const bytes = new Uint8Array(size);
  return new File([bytes], name, { type: 'application/octet-stream' });
}

// FileReader mock for tabs that go through `new FileReader().readAsArrayBuffer`
// (RfhubTab and Gpec2aTab). ModuleSync's DropZone uses File.arrayBuffer()
// directly so it does not need this mock.
let restoreFileReader = null;
function installFileReaderMock() {
  const Original = global.FileReader;
  const Mock = vi.fn(function () {
    const inst = {
      onload: null,
      readAsArrayBuffer(file) {
        // jsdom's File supports .arrayBuffer() → use it to faithfully mirror
        // the bytes the production handlers would read.
        Promise.resolve(file.arrayBuffer()).then(buf => {
          if (typeof inst.onload === 'function') {
            inst.onload({ target: { result: buf } });
          }
        });
      },
    };
    return inst;
  });
  global.FileReader = Mock;
  return () => { global.FileReader = Original; };
}

async function loadFileIntoInput(input, file) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
    // FileReader / arrayBuffer() resolve on a microtask — give them a tick
    // plus a render frame to flush state updates into the DOM.
    await new Promise(r => setTimeout(r, 80));
  });
}

function expectTooSmallCardContent(card, { moduleLabel, size = FRAGMENT_SIZE, ext = '.bin' }) {
  // The header wording is shared across every variant (Task #370/#372 design
  // decision) so the regression is visible regardless of which slot triggered
  // it.
  expect(card.textContent).toContain(`This isn't a full ${moduleLabel} dump`);
  // Size line — formatted with locale separators (e.g. "1,024 bytes").
  expect(card.textContent).toContain(`${size.toLocaleString()} bytes`);
  // Required-min line — every variant labels it "Required min".
  expect(card.textContent).toMatch(/Required min/i);
  // Detected-extension line.
  expect(card.textContent).toMatch(/Detected ext/i);
  expect(card.textContent).toContain(ext);
}

// ── Sincro inspector (ModuleSync): RFHUB + PCM slots ─────────────────────────
describe('ModuleSync size-guard cards', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the RFHUB too-small card when a 1 KB fragment is dropped into the RFHUB slot', async () => {
    render(
      <MasterVinProvider>
        <ModuleSync />
      </MasterVinProvider>,
    );

    // DropZone order in ModuleSync.jsx: BCM (0), RFHUB (1), PCM (2), 95640 (3).
    const inputs = document.querySelectorAll('input[type="file"]');
    expect(inputs.length).toBeGreaterThanOrEqual(4);

    await loadFileIntoInput(inputs[1], makeFragmentFile());

    const card = await screen.findByTestId('rfh-too-small-card', {}, { timeout: 3000 });
    expect(card).toBeTruthy();
    expectTooSmallCardContent(card, { moduleLabel: 'RFHUB' });
  });

  it('renders the PCM too-small card when a 1 KB fragment is dropped into the PCM slot', async () => {
    render(
      <MasterVinProvider>
        <ModuleSync />
      </MasterVinProvider>,
    );

    const inputs = document.querySelectorAll('input[type="file"]');
    expect(inputs.length).toBeGreaterThanOrEqual(4);

    await loadFileIntoInput(inputs[2], makeFragmentFile());

    const card = await screen.findByTestId('pcm-too-small-card', {}, { timeout: 3000 });
    expect(card).toBeTruthy();
    expectTooSmallCardContent(card, { moduleLabel: 'PCM' });
  });
});

// ── Standalone RFHUB inspector tab ───────────────────────────────────────────
describe('Standalone RfhubTab size-guard card', () => {
  beforeEach(() => { restoreFileReader = installFileReaderMock(); });
  afterEach(() => { cleanup(); restoreFileReader?.(); vi.restoreAllMocks(); });

  it('renders rfh-too-small-card when a 1 KB fragment is loaded into the inspector', async () => {
    render(
      <MasterVinProvider>
        <RfhubTab />
      </MasterVinProvider>,
    );

    // RfhubTab has a single hidden file input inside the inspector card.
    const input = document.querySelector('input[type="file"]');
    expect(input, 'RFHUB inspector file input must be present').toBeTruthy();

    await loadFileIntoInput(input, makeFragmentFile());

    const card = await screen.findByTestId('rfh-too-small-card', {}, { timeout: 3000 });
    expect(card).toBeTruthy();
    expectTooSmallCardContent(card, { moduleLabel: 'RFHUB' });
  });
});

// ── Standalone GPEC2A inspector tab ──────────────────────────────────────────
describe('Standalone Gpec2aTab size-guard card', () => {
  beforeEach(() => { restoreFileReader = installFileReaderMock(); });
  afterEach(() => { cleanup(); restoreFileReader?.(); vi.restoreAllMocks(); });

  it('renders gpec2a-too-small-card when a 1 KB fragment is loaded into File 1', async () => {
    render(
      <MasterVinProvider>
        <Gpec2aTab />
      </MasterVinProvider>,
    );

    // Gpec2aTab exposes two file inputs (File 1 + File 2 for diff). The first
    // one is the primary slot the size-guard guards.
    const inputs = document.querySelectorAll('input[type="file"]');
    expect(inputs.length).toBeGreaterThanOrEqual(2);

    await loadFileIntoInput(inputs[0], makeFragmentFile());

    const card = await screen.findByTestId('gpec2a-too-small-card', {}, { timeout: 3000 });
    expect(card).toBeTruthy();
    expectTooSmallCardContent(card, { moduleLabel: 'GPEC2A' });
  });
});
