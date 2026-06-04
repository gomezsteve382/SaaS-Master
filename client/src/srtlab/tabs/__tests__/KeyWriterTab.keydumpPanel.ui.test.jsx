// @vitest-environment jsdom
/* ============================================================================
 * KeyWriterTab.keydumpPanel.ui.test.jsx — Task #996 click-through for the
 * "Import into this key" overwrite guard on the Key Dump card.
 *
 * Importing a saved dump (KDMP .bin or srt-lab-key-dump JSON) replaces the
 * ACTIVE record in place. When that record already carries a UID / SK / label,
 * the import must confirm first so an accidental click doesn't silently wipe
 * unsaved edits; cancelling leaves the record untouched. An empty/fresh record
 * imports straight through with no prompt.
 *
 * The real buildKeyDumpBin helper mints the import fixture so the test exercises
 * the genuine parse path; window.confirm is stubbed per-case to drive both the
 * confirm and cancel branches.
 * ========================================================================== */

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

import KeyWriterTab from '../KeyWriterTab.jsx';
import { buildKeyDumpBin } from '../../lib/keyWriter/autelExport.js';

// jsdom's FileReader doesn't reliably read Buffer-backed File blobs, but the
// import path uses File.arrayBuffer() directly, so no FileReader shim is needed.
async function uploadInto(testId, file) {
  const input = screen.getByTestId(testId);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { fireEvent.change(input); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// A valid KDMP .bin for an id46 chip (4-byte UID, 6-byte SK) carrying a label-
// free dump — the imported label falls back to the active record's label.
function makeImportBin() {
  return buildKeyDumpBin({
    uid: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
    sk: new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50, 0x60]),
    flags: { locked: true },
    chipId: 'id46',
  });
}

function fileFrom(bytes, name = 'import.bin') {
  return new File([bytes], name, { type: 'application/octet-stream' });
}

describe('KeyWriterTab Key Dump import overwrite guard (Task #996)', () => {
  let confirmSpy;
  beforeEach(() => {
    confirmSpy = vi.spyOn(window, 'confirm');
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch { /* ignore */ }
  });
  afterEach(() => {
    cleanup();
    confirmSpy.mockRestore();
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch { /* ignore */ }
  });

  it('imports straight into an empty record with no confirmation prompt', async () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);
    confirmSpy.mockReturnValue(true);

    // Fresh record: no UID/SK/label entered.
    expect(screen.getByTestId('key-dump-uid').value).toBe('');

    await uploadInto('key-dump-import-input', fileFrom(makeImportBin()));

    // No prompt fired, fields populated from the dump.
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('key-dump-uid').value.replace(/\s/g, '')).toBe('DEADBEEF');
    });
    expect(screen.getByTestId('key-dump-sk').value.replace(/\s/g, '')).toBe('102030405060');
    expect(screen.getByTestId('key-dump-flag-locked').checked).toBe(true);
    // Still a single record — import replaces in place, never adds a tab.
    expect(screen.queryByTestId('key-dump-tab-1')).toBeNull();
  });

  it('cancelling the overwrite prompt leaves the edited record untouched', async () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);
    confirmSpy.mockReturnValue(false);

    // Operator has unsaved edits in the active record.
    await act(async () => {
      fireEvent.change(screen.getByTestId('key-dump-label'), { target: { value: 'work in progress' } });
      fireEvent.change(screen.getByTestId('key-dump-uid'), { target: { value: '00 77 A2 9B' } });
      fireEvent.change(screen.getByTestId('key-dump-sk'), { target: { value: '4F 4E 4D 49 4B 52' } });
    });

    await uploadInto('key-dump-import-input', fileFrom(makeImportBin()));

    // Prompt fired, operator said no → fields are exactly as typed.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('key-dump-label').value).toBe('work in progress');
    expect(screen.getByTestId('key-dump-uid').value.replace(/\s/g, '')).toBe('0077A29B');
    expect(screen.getByTestId('key-dump-sk').value.replace(/\s/g, '')).toBe('4F4E4D494B52');
    // No new record was added.
    expect(screen.queryByTestId('key-dump-tab-1')).toBeNull();
    expect(screen.getByTestId('key-dump-note').textContent || '').toMatch(/cancelled/i);
  });

  it('confirming the overwrite prompt replaces the record in place', async () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);
    confirmSpy.mockReturnValue(true);

    await act(async () => {
      fireEvent.change(screen.getByTestId('key-dump-label'), { target: { value: 'work in progress' } });
      fireEvent.change(screen.getByTestId('key-dump-uid'), { target: { value: '00 77 A2 9B' } });
      fireEvent.change(screen.getByTestId('key-dump-sk'), { target: { value: '4F 4E 4D 49 4B 52' } });
    });

    await uploadInto('key-dump-import-input', fileFrom(makeImportBin()));

    // Prompt fired, operator said yes → record overwritten with the dump.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId('key-dump-uid').value.replace(/\s/g, '')).toBe('DEADBEEF');
    });
    expect(screen.getByTestId('key-dump-sk').value.replace(/\s/g, '')).toBe('102030405060');
    expect(screen.getByTestId('key-dump-flag-locked').checked).toBe(true);
    // The dump carried no label, so the prior label is preserved.
    expect(screen.getByTestId('key-dump-label').value).toBe('work in progress');
    // Replaced in place — no extra record tab.
    expect(screen.queryByTestId('key-dump-tab-1')).toBeNull();
    expect(screen.getByTestId('key-dump-note').textContent || '').toMatch(/Imported/i);
  });
});
