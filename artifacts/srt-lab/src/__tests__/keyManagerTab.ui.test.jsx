// @vitest-environment jsdom
/* Task #407 — UI test for the dual-pane RFHub Key Manager.
 * Drives the tab end-to-end through the React DOM:
 *   1. Load File A (Gen2, 2 fobs) and File B (Gen2, 0 fobs).
 *   2. Send slot #0 from A → B; B becomes dirty and slot 0 occupied.
 *   3. Add Manually on B fills the next free slot (#1).
 *   4. Delete slot #0 on B clears the AA-50 marker.
 *   5. Save B downloads a patched bin (capture via URL.createObjectURL).
 *   6. Refusal path: cross-gen mismatch banner blocks Send / Copy Master.
 */
import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import KeyManagerTab from '../tabs/KeyManagerTab.jsx';
import { makeRfhubGen2, makeRfhubGen1 } from '../lib/__fixtures__/buildFixtures.js';

class StubFileReader {
  constructor() { this.onload = null; }
  readAsArrayBuffer(file) {
    file.arrayBuffer().then((buf) => {
      this.result = buf;
      if (this.onload) this.onload({ target: { result: buf } });
    });
  }
}

function bytesToFile(name, bytes) {
  return new File([bytes], name, { type: 'application/octet-stream' });
}

async function uploadInto(testId, file) {
  const input = screen.getByTestId(testId);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { fireEvent.change(input); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('KeyManagerTab UI (Task #407)', () => {
  let originalFR;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;
  let downloads;

  beforeEach(() => {
    originalFR = globalThis.FileReader;
    globalThis.FileReader = StubFileReader;
    downloads = [];
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob) => {
      // Capture the blob so the save assertion can verify it ran.
      downloads.push({ size: blob.size, type: blob.type });
      return 'blob:stub-' + downloads.length;
    });
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    globalThis.FileReader = originalFR;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    cleanup();
  });

  it('drives the full transfer / add / delete / save loop with two Gen2 dumps', async () => {
    render(<KeyManagerTab />);

    // Layout-honesty banner is always visible.
    expect(screen.getByTestId('keymgr-layout-banner')).toBeTruthy();

    // Both panes start as drop zones.
    expect(screen.getByTestId('keymgr-pane-A-drop')).toBeTruthy();
    expect(screen.getByTestId('keymgr-pane-B-drop')).toBeTruthy();

    // Load A (Gen2, 2 fobs).
    const aBytes = makeRfhubGen2({ fobikSlots: 2 });
    await uploadInto('keymgr-pane-A-input', bytesToFile('source_A.bin', aBytes));
    await waitFor(() => expect(screen.getByTestId('keymgr-pane-A-loaded')).toBeTruthy());

    // Load B (Gen2, 0 fobs).
    const bBytes = makeRfhubGen2({ fobikSlots: 0 });
    await uploadInto('keymgr-pane-B-input', bytesToFile('target_B.bin', bBytes));
    await waitFor(() => expect(screen.getByTestId('keymgr-pane-B-loaded')).toBeTruthy());

    // Initial state: A slot 0 occupied, B slot 0 empty.
    expect(screen.getByTestId('keymgr-slot-A-0').getAttribute('data-occupied')).toBe('1');
    expect(screen.getByTestId('keymgr-slot-B-0').getAttribute('data-occupied')).toBe('0');

    // SEND A→B slot 0. The button lives on the source-row of pane A.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-slot-A-0-send')); });
    await waitFor(() => {
      expect(screen.getByTestId('keymgr-slot-B-0').getAttribute('data-occupied')).toBe('1');
    });

    // Save B should now be enabled (B is dirty).
    const saveB = screen.getByTestId('keymgr-pane-B-save');
    expect(saveB.disabled).toBe(false);

    // Add Manually on B → fills next free slot (#1).
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-B-add-manual')); });
    await waitFor(() => {
      expect(screen.getByTestId('keymgr-slot-B-1').getAttribute('data-occupied')).toBe('1');
    });

    // Delete slot #0 on B.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-slot-B-0-delete')); });
    await waitFor(() => {
      expect(screen.getByTestId('keymgr-slot-B-0').getAttribute('data-occupied')).toBe('0');
    });

    // Copy Master from A → B. A pane's "copy-master" button copies FROM B INTO A
    // (label says "Copy Master ← B"); we need pane B's button which copies from A.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-B-copy-master')); });

    // Save B → triggers downloadBin → URL.createObjectURL captured.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-B-save')); });
    expect(downloads.length).toBe(1);
    expect(downloads[0].size).toBe(bBytes.length);

    // Activity log carries pass / error rows.
    const logRows = screen.getAllByTestId(/^keymgr-log-row-/);
    expect(logRows.length).toBeGreaterThan(0);
    const passRows = logRows.filter(r => r.getAttribute('data-log-type') === 'pass');
    expect(passRows.length).toBeGreaterThan(0);
  });

  it('refuses Send / Copy Master across Gen1 ↔ Gen2 and surfaces the mismatch banner', async () => {
    render(<KeyManagerTab />);

    await uploadInto('keymgr-pane-A-input', bytesToFile('gen2.bin', makeRfhubGen2({})));
    await uploadInto('keymgr-pane-B-input', bytesToFile('gen1.bin', makeRfhubGen1()));

    await waitFor(() => expect(screen.getByTestId('keymgr-gen-mismatch')).toBeTruthy());

    // Send button on A is disabled when other pane is loaded with mismatched gen.
    const sendA0 = screen.getByTestId('keymgr-slot-A-0-send');
    expect(sendA0.disabled).toBe(true);

    // Copy Master button is also disabled.
    const copyMasterB = screen.getByTestId('keymgr-pane-B-copy-master');
    expect(copyMasterB.disabled).toBe(true);
  });

  it('logs KEYMOD REFUSED in red when adding to an already-occupied slot', async () => {
    render(<KeyManagerTab />);
    await uploadInto('keymgr-pane-A-input', bytesToFile('a.bin', makeRfhubGen2({ fobikSlots: 4 })));
    await waitFor(() => expect(screen.getByTestId('keymgr-pane-A-loaded')).toBeTruthy());

    // All 4 slots occupied → Add Manually has no free slot.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-A-add-manual')); });
    const errRows = screen.getAllByTestId(/^keymgr-log-row-/).filter(r => r.getAttribute('data-log-type') === 'error');
    expect(errRows.length).toBeGreaterThan(0);
    expect(errRows[0].textContent).toMatch(/KEYMOD REFUSED/);
  });
});
