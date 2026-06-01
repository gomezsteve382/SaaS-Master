// @vitest-environment jsdom
/* ============================================================================
 * KeyDumpPanel.ui.test.jsx — Task #985
 *
 * Verifies the standalone key-dump capture panel:
 *   1. Renders with no RFHUB dump loaded (props omitted).
 *   2. Refuses export while the record is blank/incomplete.
 *   3. Enables export once a valid UID + SK are entered.
 *   4. Copy-to-new-key appends a second editable record.
 * ========================================================================== */

import React from 'react';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

import KeyDumpPanel from '../KeyDumpPanel.jsx';

describe('KeyDumpPanel UI (Task #985)', () => {
  beforeEach(() => {
    // jsdom lacks URL.createObjectURL — stub so export clicks don't throw.
    if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:stub';
    if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
  });
  afterEach(() => cleanup());

  it('renders standalone and gates export on a valid record', async () => {
    render(<KeyDumpPanel />);

    // Panel is present without any RFHUB dump.
    expect(screen.getByTestId('key-dump-panel')).toBeTruthy();

    // Blank record → refusal + disabled export.
    expect(screen.getByTestId('keydump-error')).toBeTruthy();
    expect(screen.getByTestId('keydump-export-json').disabled).toBe(true);
    expect(screen.getByTestId('keydump-export-bin').disabled).toBe(true);

    // Enter a valid pcf7953 read.
    await act(async () => {
      fireEvent.change(screen.getByTestId('keydump-uid'), { target: { value: '437C2C9F' } });
      fireEvent.change(screen.getByTestId('keydump-sk'), { target: { value: '4F4E4D494B52' } });
    });

    expect(screen.queryByTestId('keydump-error')).toBeNull();
    expect(screen.getByTestId('keydump-valid')).toBeTruthy();
    expect(screen.getByTestId('keydump-export-json').disabled).toBe(false);
    expect(screen.getByTestId('keydump-export-bin').disabled).toBe(false);
  });

  it('refuses a wrong-length UID with a clear message', async () => {
    render(<KeyDumpPanel />);
    await act(async () => {
      fireEvent.change(screen.getByTestId('keydump-uid'), { target: { value: '437C' } });
      fireEvent.change(screen.getByTestId('keydump-sk'), { target: { value: '4F4E4D494B52' } });
    });
    expect(screen.getByTestId('keydump-error').textContent).toMatch(/UID length/i);
    expect(screen.getByTestId('keydump-export-json').disabled).toBe(true);
  });

  it('copy-to-new-key appends a second record', async () => {
    render(<KeyDumpPanel />);
    // One record to start.
    expect(screen.getByTestId('keydump-record-0')).toBeTruthy();
    expect(screen.queryByTestId('keydump-record-1')).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByTestId('keydump-label'), { target: { value: 'Key A' } });
      fireEvent.change(screen.getByTestId('keydump-uid'), { target: { value: '437C2C9F' } });
      fireEvent.change(screen.getByTestId('keydump-sk'), { target: { value: '4F4E4D494B52' } });
    });
    await act(async () => { fireEvent.click(screen.getByTestId('keydump-copy')); });

    // A second record now exists and is selected; UID carried over.
    expect(screen.getByTestId('keydump-record-1')).toBeTruthy();
    expect(screen.getByTestId('keydump-uid').value).toBe('437C2C9F');
  });

  it('prefills UID from a supplied RFHUB slot and surfaces SEC16', async () => {
    const slot = { idx: 0, idBytes: new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]) };
    const sec16 = new Uint8Array(16).fill(0xab);
    render(<KeyDumpPanel prefillSlot={slot} prefillSec16={sec16} prefillChipId="pcf7953" />);

    await act(async () => { fireEvent.click(screen.getByTestId('keydump-prefill')); });
    // UID filled from the first 4 bytes of the slot id block.
    expect(screen.getByTestId('keydump-uid').value).toBe('11223344');
    // SEC16 surfaced for reference — never injected into the SK field.
    expect(screen.getByTestId('keydump-sk').value).toBe('');
  });
});
