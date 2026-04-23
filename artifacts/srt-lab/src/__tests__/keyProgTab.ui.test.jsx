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
