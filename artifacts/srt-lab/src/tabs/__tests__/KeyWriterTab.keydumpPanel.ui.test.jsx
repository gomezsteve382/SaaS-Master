// @vitest-environment jsdom
/* ============================================================================
 * KeyWriterTab.keydumpPanel.ui.test.jsx — Task #988 click-through for the
 * standalone KeyDumpPanel capture surface (the `keydump-*` testids added in
 * Task #985), mirroring the sibling inline-card coverage in
 * KeyWriterTab.keydump.ui.test.jsx (Task #987).
 *
 * The library helpers (validateKeyRecord / cloneKeyRecord / buildKeyDump*)
 * already have unit coverage in src/lib/__tests__/keyDump.test.js — this test
 * walks the actual React panel to catch wiring regressions between the inputs,
 * the refuse-on-doubt validation gate, the "Copy to new key" record selector,
 * the export buttons, and the "Prefill UID from RFHUB slot" convenience button.
 *
 * KeyDumpPanel is mounted directly with a stub `prefillSlot`/`prefillSec16` so
 * we don't need a real RFHUB binary fixture just to surface the prefill row —
 * the panel works with no dump loaded by design.
 * ========================================================================== */

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

import KeyDumpPanel from '../KeyDumpPanel.jsx';

// jsdom's FileReader doesn't reliably read Buffer-backed File blobs; mirror the
// shim used by the sibling burn-pipeline / inline-card tests. The panel mounted
// here has no upload path, but we keep the stub in place for parity so the
// surrounding harness matches the sibling suites exactly.
class StubFileReader {
  constructor() { this.onload = null; }
  readAsArrayBuffer(file) {
    file.arrayBuffer().then((buf) => {
      this.result = buf;
      if (this.onload) this.onload({ target: { result: buf } });
    });
  }
}

// A stub RFHUB slot for the "Prefill UID from RFHUB slot" button. With the
// default pcf7953 chip family (uidBytes = 4), onPrefillUid takes the first 4
// bytes of idBytes — so the UID field should read "437C2C9F" after the click.
const STUB_SLOT = {
  idx: 0,
  occupied: true,
  idMapped: true,
  idBytes: new Uint8Array([0x43, 0x7c, 0x2c, 0x9f, 0xde, 0xad, 0xbe, 0xef]),
};
const STUB_SEC16 = new Uint8Array(16).fill(0xaa);

describe('KeyDumpPanel standalone UI (Task #988)', () => {
  let originalFR;
  let originalCreate;
  let originalRevoke;
  let createSpy;
  let revokeSpy;
  beforeEach(() => {
    originalFR = globalThis.FileReader;
    globalThis.FileReader = StubFileReader;
    // jsdom lacks URL.createObjectURL — triggerDownload needs it.
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    createSpy = vi.fn(() => 'blob:stub');
    revokeSpy = vi.fn();
    URL.createObjectURL = createSpy;
    URL.revokeObjectURL = revokeSpy;
  });
  afterEach(() => {
    cleanup();
    globalThis.FileReader = originalFR;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('gates JSON/bin export on record validity', async () => {
    render(<KeyDumpPanel />);

    // The standalone panel is present.
    expect(screen.getByTestId('key-dump-panel')).toBeTruthy();

    // Refuse-on-doubt: an empty record (no UID/SK) leaves both exports disabled
    // and surfaces the error line.
    expect(screen.getByTestId('keydump-export-json').disabled).toBe(true);
    expect(screen.getByTestId('keydump-export-bin').disabled).toBe(true);
    expect(screen.queryByTestId('keydump-error')).not.toBeNull();

    // Fill a valid pcf7953 record: 4-byte UID + 6-byte SK.
    await act(async () => {
      fireEvent.change(screen.getByTestId('keydump-label'), { target: { value: 'spare fob' } });
      fireEvent.change(screen.getByTestId('keydump-uid'), { target: { value: '00 77 A2 9B' } });
      fireEvent.change(screen.getByTestId('keydump-sk'), { target: { value: '4F 4E 4D 49 4B 52' } });
      fireEvent.click(screen.getByTestId('keydump-locked'));
    });

    // Now the record validates → JSON/bin export enable, error clears.
    await waitFor(() => {
      expect(screen.queryByTestId('keydump-valid')).not.toBeNull();
      expect(screen.getByTestId('keydump-export-json').disabled).toBe(false);
      expect(screen.getByTestId('keydump-export-bin').disabled).toBe(false);
    });

    // The exports actually fire a download (triggerDownload → URL.createObjectURL).
    await act(async () => { fireEvent.click(screen.getByTestId('keydump-export-json')); });
    await act(async () => { fireEvent.click(screen.getByTestId('keydump-export-bin')); });
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls.every(([arg]) => arg instanceof Blob)).toBe(true);

    // A bad UID (odd nibble count) re-trips the refuse-on-doubt gate.
    await act(async () => {
      fireEvent.change(screen.getByTestId('keydump-uid'), { target: { value: 'XYZ' } });
    });
    await waitFor(() => {
      expect(screen.getByTestId('keydump-export-json').disabled).toBe(true);
      expect(screen.getByTestId('keydump-export-bin').disabled).toBe(true);
      expect(screen.queryByTestId('keydump-error')).not.toBeNull();
    });
  });

  it('"Copy to new key" adds a new record tab carrying the cloned fields', async () => {
    render(<KeyDumpPanel />);

    // Only one record tab to start.
    expect(screen.getByTestId('keydump-record-0')).toBeTruthy();
    expect(screen.queryByTestId('keydump-record-1')).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByTestId('keydump-label'), { target: { value: 'spare fob' } });
      fireEvent.change(screen.getByTestId('keydump-uid'), { target: { value: '00 77 A2 9B' } });
      fireEvent.change(screen.getByTestId('keydump-sk'), { target: { value: '4F 4E 4D 49 4B 52' } });
    });

    await act(async () => { fireEvent.click(screen.getByTestId('keydump-copy')); });

    // A second record tab now exists, active and labelled with the "(copy)" hint.
    await waitFor(() => expect(screen.queryByTestId('keydump-record-1')).not.toBeNull());
    expect(screen.getByTestId('keydump-record-1').textContent || '').toMatch(/spare fob \(copy\)/);

    // The clone carried over the editable label + UID and stays valid.
    expect(screen.getByTestId('keydump-label').value).toBe('spare fob (copy)');
    expect(screen.getByTestId('keydump-uid').value.replace(/\s/g, '')).toBe('0077A29B');
    expect(screen.queryByTestId('keydump-valid')).not.toBeNull();
  });

  it('"Prefill UID from RFHUB slot" populates keydump-uid from the slot', async () => {
    render(<KeyDumpPanel prefillSlot={STUB_SLOT} prefillSec16={STUB_SEC16} prefillChipId="pcf7953" />);

    // UID starts empty.
    expect(screen.getByTestId('keydump-uid').value).toBe('');

    // The prefill button is surfaced because a slot with idBytes was passed.
    const prefillBtn = screen.getByTestId('keydump-prefill');
    expect(prefillBtn.textContent || '').toMatch(/Prefill UID from RFHUB slot 1/);

    await act(async () => { fireEvent.click(prefillBtn); });

    // UID is filled from the first 4 bytes of the slot (pcf7953 uidBytes = 4).
    await waitFor(() => {
      expect(screen.getByTestId('keydump-uid').value.replace(/\s/g, '')).toBe('437C2C9F');
    });
  });
});
