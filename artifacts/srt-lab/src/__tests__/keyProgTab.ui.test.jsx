// @vitest-environment jsdom
/* Task #343 UI test — drives the KeyProgTab through the React DOM:
 *   1. start with everything disabled,
 *   2. load the Cluster B BCM/RFH/PCM via the file inputs,
 *   3. type the wrong VIN (download blocked) then the right one,
 *   4. confirm the green checklist + enabled download buttons. */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, within, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeyProgTab from '../tabs/KeyProgTab.jsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTACHED = path.resolve(__dirname, '..', '..', '..', '..', 'attached_assets');

const SRC_BCM = '22CHARGER_REDEYE_6.2_797RFHUB_EEE_OGFILE_VIRGIN_1776900226655.bin';
const SRC_RFH = 'RFH_HERMANADO_20CHRGR6.2RFHUBFILE_EEE_OG_VIRGINSYCHNED_1776899205057.bin';
const SRC_PCM = 'FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2_1776899205055.bin';
const TARGET_VIN = '2C3CDXCT1HH652640';

function loadFile(name) {
  const buf = fs.readFileSync(path.join(ATTACHED, name));
  return new File([buf], name, { type: 'application/octet-stream' });
}

async function uploadInto(testId, file) {
  const input = screen.getByTestId(testId);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { fireEvent.change(input); });
  // Let the FileReader microtask settle so React state actually reflects the
  // upload before the next assertion runs.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function setVin(value) {
  const vinInput = screen.getByTestId('keyprog-vin-input');
  const user = userEvent.setup();
  await user.clear(vinInput);
  await user.type(vinInput, value);
  return vinInput;
}

// jsdom's FileReader.readAsArrayBuffer doesn't read Buffer-backed File blobs
// reliably. Provide a deterministic shim that resolves to the file's raw
// bytes via .arrayBuffer().
class StubFileReader {
  constructor() { this.onload = null; }
  readAsArrayBuffer(file) {
    file.arrayBuffer().then((buf) => {
      this.result = buf;
      if (this.onload) this.onload({ target: { result: buf } });
    });
  }
}

describe('KeyProgTab UI (Task #343)', () => {
  let originalFR;
  beforeEach(() => {
    originalFR = globalThis.FileReader;
    globalThis.FileReader = StubFileReader;
  });
  afterEach(() => {
    globalThis.FileReader = originalFR;
    cleanup();
  });

  it('keeps download disabled until all three files + VIN are valid, then enables it', async () => {
    render(<KeyProgTab />);

    // Sanity: nothing rendered yet (no result block).
    expect(screen.queryByTestId('keyprog-result')).toBeNull();

    // Load the three modules through the per-slot file inputs.
    await uploadInto('keyprog-slot-bcm-input', loadFile(SRC_BCM));
    await uploadInto('keyprog-slot-rfh-input', loadFile(SRC_RFH));
    await uploadInto('keyprog-slot-pcm-input', loadFile(SRC_PCM));

    // Wait for the three slots to render their filenames.
    await waitFor(() => {
      expect(within(screen.getByTestId('keyprog-slot-bcm')).getByText(SRC_BCM)).toBeTruthy();
      expect(within(screen.getByTestId('keyprog-slot-rfh')).getByText(SRC_RFH)).toBeTruthy();
      expect(within(screen.getByTestId('keyprog-slot-pcm')).getByText(SRC_PCM)).toBeTruthy();
    });

    // Wrong-length VIN → no result block yet (wizard requires 17 chars).
    await setVin('TOOSHORT');
    expect(screen.queryByTestId('keyprog-result')).toBeNull();

    // Correct VIN → result block appears with green checklist + enabled buttons.
    await setVin(TARGET_VIN);
    await waitFor(() => expect(screen.getByTestId('keyprog-result')).toBeTruthy());

    const dlAll = screen.getByTestId('keyprog-download-all');
    const dlBcm = screen.getByTestId('keyprog-download-bcm');
    expect(dlAll.disabled).toBe(false);
    expect(dlBcm.disabled).toBe(false);

    // Every check in the checklist must be a pass.
    const checklist = screen.getByTestId('keyprog-checklist');
    const checks = checklist.querySelectorAll('[data-testid^="keyprog-check-"]');
    expect(checks.length).toBeGreaterThan(0);
    for (const el of checks) {
      expect(el.getAttribute('data-check-pass')).toBe('1');
    }

    // The BEFORE/AFTER table must show the target VIN in every "after" cell
    // (4 full VINs + 2 partial tails are colored greenish when matching).
    const table = screen.getByTestId('keyprog-vin-table');
    const afterCells = within(table).getAllByText(TARGET_VIN);
    expect(afterCells.length).toBeGreaterThanOrEqual(4);
  });

  it('shows a ZIP summary (filenames, byte sizes, SHA-256) after Download all (Task #352)', async () => {
    const { unzipSync } = await import('fflate');
    const { createHash } = await import('node:crypto');

    // Capture the bytes the dl() helper hands to the browser.
    let capturedZip = null;
    const realCreateObjectURL = globalThis.URL.createObjectURL;
    globalThis.URL.createObjectURL = (blob) => {
      blob.arrayBuffer().then((buf) => { capturedZip = new Uint8Array(buf); });
      return 'blob:stub';
    };
    globalThis.URL.revokeObjectURL = () => {};
    // Stub the anchor click so we don't try to actually navigate.
    const realCreateElement = document.createElement.bind(document);
    document.createElement = (tag) => {
      const el = realCreateElement(tag);
      if (tag === 'a') el.click = () => {};
      return el;
    };

    try {
      render(<KeyProgTab />);
      await uploadInto('keyprog-slot-bcm-input', loadFile(SRC_BCM));
      await uploadInto('keyprog-slot-rfh-input', loadFile(SRC_RFH));
      await uploadInto('keyprog-slot-pcm-input', loadFile(SRC_PCM));
      await setVin(TARGET_VIN);
      await waitFor(() => expect(screen.getByTestId('keyprog-download-all')).toBeTruthy());

      // No summary before clicking Download all.
      expect(screen.queryByTestId('keyprog-zip-summary')).toBeNull();

      const dlAll = screen.getByTestId('keyprog-download-all');
      await act(async () => { fireEvent.click(dlAll); });

      // Summary panel must appear with one row per ZIP entry.
      await waitFor(() => expect(screen.getByTestId('keyprog-zip-summary')).toBeTruthy());

      // Wait for the captured ZIP from the blob promise.
      await waitFor(() => expect(capturedZip).not.toBeNull());
      const unpacked = unzipSync(capturedZip);
      const entryNames = Object.keys(unpacked);
      expect(entryNames.length).toBeGreaterThan(0);

      // Each row's SHA-256 must match the bytes actually packaged into the ZIP.
      const table = screen.getByTestId('keyprog-zip-summary-table');
      for (let i = 0; i < entryNames.length; i++) {
        const shaCell = within(table).getByTestId('keyprog-zip-summary-sha-' + i);
        const rowName = within(table).getByTestId('keyprog-zip-summary-row-' + i)
          .querySelector('td').textContent;
        const expected = createHash('sha256').update(unpacked[rowName]).digest('hex');
        expect(shaCell.textContent.trim()).toBe(expected);
      }
    } finally {
      globalThis.URL.createObjectURL = realCreateObjectURL;
      document.createElement = realCreateElement;
    }
  });

  it('re-verifies a saved preset on Load and surfaces a green banner (Task #358)', async () => {
    window.localStorage.clear();
    render(<KeyProgTab />);
    await uploadInto('keyprog-slot-bcm-input', loadFile(SRC_BCM));
    await uploadInto('keyprog-slot-rfh-input', loadFile(SRC_RFH));
    await uploadInto('keyprog-slot-pcm-input', loadFile(SRC_PCM));
    await setVin(TARGET_VIN);
    await waitFor(() => expect(screen.getByTestId('keyprog-result')).toBeTruthy());

    // Save a preset (checks-all-green path).
    const nameInput = screen.getByTestId('keyprog-preset-name');
    const user = userEvent.setup();
    await user.type(nameInput, 'Cluster B trio');
    const saveBtn = screen.getByTestId('keyprog-preset-save');
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    await act(async () => { fireEvent.click(saveBtn); });

    // Clear all three slots so we know Load is what restores them.
    await act(async () => { fireEvent.click(screen.getByTestId('keyprog-slot-bcm-clear')); });
    await act(async () => { fireEvent.click(screen.getByTestId('keyprog-slot-rfh-clear')); });
    await act(async () => { fireEvent.click(screen.getByTestId('keyprog-slot-pcm-clear')); });
    await waitFor(() => expect(screen.queryByTestId('keyprog-result')).toBeNull());

    // No banner yet, then click Load via the per-preset testid.
    expect(screen.queryByTestId('keyprog-preset-verify-banner')).toBeNull();
    const loadBtn = document.querySelector('[data-testid^="keyprog-preset-load-"]');
    expect(loadBtn).not.toBeNull();
    await act(async () => { fireEvent.click(loadBtn); });

    // Banner appears and resolves to green after re-verification.
    await waitFor(() => expect(screen.getByTestId('keyprog-preset-verify-banner')).toBeTruthy());
    await waitFor(() => {
      const banner = screen.getByTestId('keyprog-preset-verify-banner');
      expect(banner.getAttribute('data-verify-status')).toBe('green');
    });

    // Dismiss button removes the banner.
    await act(async () => { fireEvent.click(screen.getByTestId('keyprog-preset-verify-dismiss')); });
    expect(screen.queryByTestId('keyprog-preset-verify-banner')).toBeNull();
  });

  it('flags an old (no-checks-snapshot) preset as verified-on-load (Task #358)', async () => {
    // Seed an "old" preset directly via the storage helper, omitting the
    // checks snapshot — simulates a preset captured before Task #354.
    const { savePreset, STORAGE_KEY } = await import('../lib/keyProgPresets.js');
    const bcmBytes = new Uint8Array(fs.readFileSync(path.join(ATTACHED, SRC_BCM)));
    const rfhBytes = new Uint8Array(fs.readFileSync(path.join(ATTACHED, SRC_RFH)));
    const pcmBytes = new Uint8Array(fs.readFileSync(path.join(ATTACHED, SRC_PCM)));
    window.localStorage.clear();
    savePreset({
      name: 'Legacy preset',
      vin: TARGET_VIN,
      files: {
        BCM: { name: SRC_BCM, data: bcmBytes },
        RFH: { name: SRC_RFH, data: rfhBytes },
        PCM: { name: SRC_PCM, data: pcmBytes },
      },
      // intentionally no `checks`
    });
    // Confirm the stored preset has no check snapshot.
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    expect(stored.presets[0].checksTotal).toBeUndefined();

    render(<KeyProgTab />);
    const loadBtn = await waitFor(() => {
      const el = document.querySelector('[data-testid^="keyprog-preset-load-"]');
      if (!el) throw new Error('load button not yet rendered');
      return el;
    });
    await act(async () => { fireEvent.click(loadBtn); });

    // Banner shows "Older preset" verbiage and resolves to green
    // (the trio still matches the VIN).
    await waitFor(() => {
      const banner = screen.getByTestId('keyprog-preset-verify-banner');
      expect(banner.getAttribute('data-verify-status')).toBe('green');
      expect(banner.textContent).toMatch(/Older preset/);
    });
  });

  it('shows a dismissed-preset note when inputs change after a Load (Task #371)', async () => {
    window.localStorage.clear();
    render(<KeyProgTab />);
    await uploadInto('keyprog-slot-bcm-input', loadFile(SRC_BCM));
    await uploadInto('keyprog-slot-rfh-input', loadFile(SRC_RFH));
    await uploadInto('keyprog-slot-pcm-input', loadFile(SRC_PCM));
    await setVin(TARGET_VIN);
    await waitFor(() => expect(screen.getByTestId('keyprog-result')).toBeTruthy());

    // Save a preset.
    const nameInput = screen.getByTestId('keyprog-preset-name');
    const user = userEvent.setup();
    await user.type(nameInput, 'Cluster B trio');
    const saveBtn = screen.getByTestId('keyprog-preset-save');
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    await act(async () => { fireEvent.click(saveBtn); });

    // Load it back. Wait for green verification.
    const loadBtn = document.querySelector('[data-testid^="keyprog-preset-load-"]');
    await act(async () => { fireEvent.click(loadBtn); });
    await waitFor(() => {
      const banner = screen.getByTestId('keyprog-preset-verify-banner');
      expect(banner.getAttribute('data-verify-status')).toBe('green');
    });

    // No dismissed-note yet.
    expect(screen.queryByTestId('keyprog-preset-dismissed-note')).toBeNull();

    // Mutate the inputs (clear the BCM slot) → banner should vanish AND a
    // transient note should appear naming the preset that was discarded.
    await act(async () => { fireEvent.click(screen.getByTestId('keyprog-slot-bcm-clear')); });
    await waitFor(() => {
      expect(screen.queryByTestId('keyprog-preset-verify-banner')).toBeNull();
      const note = screen.getByTestId('keyprog-preset-dismissed-note');
      expect(note.textContent).toMatch(/Cluster B trio/);
    });

    // The note's own dismiss button removes it.
    await act(async () => { fireEvent.click(screen.getByTestId('keyprog-preset-dismissed-note-dismiss')); });
    expect(screen.queryByTestId('keyprog-preset-dismissed-note')).toBeNull();
  });

  it('does NOT show a dismissed-preset note when the user clicks the banner dismiss button (Task #371)', async () => {
    window.localStorage.clear();
    render(<KeyProgTab />);
    await uploadInto('keyprog-slot-bcm-input', loadFile(SRC_BCM));
    await uploadInto('keyprog-slot-rfh-input', loadFile(SRC_RFH));
    await uploadInto('keyprog-slot-pcm-input', loadFile(SRC_PCM));
    await setVin(TARGET_VIN);
    await waitFor(() => expect(screen.getByTestId('keyprog-result')).toBeTruthy());

    const nameInput = screen.getByTestId('keyprog-preset-name');
    const user = userEvent.setup();
    await user.type(nameInput, 'Cluster B trio');
    const saveBtn = screen.getByTestId('keyprog-preset-save');
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    await act(async () => { fireEvent.click(saveBtn); });

    const loadBtn = document.querySelector('[data-testid^="keyprog-preset-load-"]');
    await act(async () => { fireEvent.click(loadBtn); });
    await waitFor(() => {
      const banner = screen.getByTestId('keyprog-preset-verify-banner');
      expect(banner.getAttribute('data-verify-status')).toBe('green');
    });

    // Clicking the banner's own Dismiss button is an explicit acknowledgement —
    // we should NOT also surface the "inputs changed" toast.
    await act(async () => { fireEvent.click(screen.getByTestId('keyprog-preset-verify-dismiss')); });
    expect(screen.queryByTestId('keyprog-preset-verify-banner')).toBeNull();
    expect(screen.queryByTestId('keyprog-preset-dismissed-note')).toBeNull();
  });

  it('disables download when promoteBank is on (forbidden region check fails)', async () => {
    render(<KeyProgTab />);
    await uploadInto('keyprog-slot-bcm-input', loadFile(SRC_BCM));
    await uploadInto('keyprog-slot-rfh-input', loadFile(SRC_RFH));
    await uploadInto('keyprog-slot-pcm-input', loadFile(SRC_PCM));
    await waitFor(() => {
      expect(within(screen.getByTestId('keyprog-slot-bcm')).getByText(SRC_BCM)).toBeTruthy();
    });
    await setVin(TARGET_VIN);
    await waitFor(() => expect(screen.getByTestId('keyprog-result')).toBeTruthy());

    // Flip the toggle on → result re-runs with promoteBank=true → forbidden
    // region guard fails → download is disabled.
    const checkbox = screen.getByTestId('keyprog-promote-toggle').querySelector('input[type=checkbox]');
    await act(async () => { fireEvent.click(checkbox); });
    await waitFor(() => {
      expect(screen.getByTestId('keyprog-download-all').disabled).toBe(true);
    });
  });
});
