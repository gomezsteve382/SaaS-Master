// @vitest-environment jsdom
/* ============================================================================
 * KeyWriterHistory.ui.test.jsx — Task #986
 *
 * Verifies the per-vehicle "Keys on file" history on the Key Writer tab:
 *   1. Without a Master VIN, the history card prompts for one and Save refuses.
 *   2. With a valid VIN, a captured key Saves, appears in the list (chip family,
 *      UID, slot, capture time), and the saved count increments.
 *   3. Load re-populates the Key Dump card; Remove drops the row.
 * ========================================================================== */

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within, waitFor } from '@testing-library/react';

import KeyWriterTab from '../KeyWriterTab.jsx';
import { MasterVinContext } from '../../lib/masterVinContext.jsx';
import { KEY_HISTORY_KEY, buildKeyHistoryExport } from '../../lib/keyWriter/keyHistory.js';

const VIN = '2C3CDXL95KH123456';

function renderWithVin(vin) {
  const value = {
    vin: vin || '',
    setVin: () => {},
    vinValid: !!vin,
    moduleStatus: { BCM: 'pending', RFHUB: 'pending', ECM: 'pending', ADCM: 'pending' },
    setModuleStatus: () => {}, updateStatus: () => {}, resetStatus: () => {},
    setPg: () => {}, loadedDumps: [], addDump: () => null, replaceDump: () => null,
    removeDump: () => {}, clearDumps: () => {}, getDumpsByType: () => [],
    jobId: null, setJobId: () => {}, hydrateFromJob: () => {},
  };
  return render(
    <MasterVinContext.Provider value={value}>
      <KeyWriterTab />
    </MasterVinContext.Provider>,
  );
}

/* Fill the inline Key Dump card with a valid id46 read (default chip family). */
async function captureValidKey(label = 'spare fob #2') {
  await act(async () => {
    fireEvent.change(screen.getByTestId('key-dump-label'), { target: { value: label } });
    fireEvent.change(screen.getByTestId('key-dump-uid'), { target: { value: '00 77 A2 9B' } });
    fireEvent.change(screen.getByTestId('key-dump-sk'), { target: { value: '4F 4E 4D 49 4B 52' } });
  });
}

describe('KeyWriter per-vehicle key history (Task #986)', () => {
  beforeEach(() => {
    globalThis.localStorage?.removeItem(KEY_HISTORY_KEY);
    if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:stub';
    if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
  });
  afterEach(() => cleanup());

  it('prompts for a VIN and refuses save when none is set', async () => {
    renderWithVin('');
    expect(screen.getByTestId('key-history-novin')).toBeTruthy();
    await captureValidKey();
    await act(async () => {
      fireEvent.click(screen.getByTestId('key-dump-save-history'));
    });
    expect(screen.getByTestId('key-dump-note').textContent).toMatch(/Master VIN/i);
    expect(screen.queryByTestId('key-history-list')).toBeNull();
  });

  it('saves a captured key and lists chip family + UID for the VIN', async () => {
    renderWithVin(VIN);
    expect(screen.getByTestId('key-history-empty')).toBeTruthy();

    await captureValidKey();
    await act(async () => {
      fireEvent.click(screen.getByTestId('key-dump-save-history'));
    });

    const list = screen.getByTestId('key-history-list');
    const rows = within(list).getAllByTestId('key-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toMatch(/spare fob #2/);
    expect(rows[0].textContent).toMatch(/ID46/i);
    expect(rows[0].textContent).toMatch(/00 77 A2 9B/);
    expect(screen.getByTestId('key-history-count').textContent).toMatch(/1 saved/);
  });

  it('persists across remount (localStorage), then Remove drops the row', async () => {
    renderWithVin(VIN);
    await captureValidKey();
    await act(async () => {
      fireEvent.click(screen.getByTestId('key-dump-save-history'));
    });
    cleanup();

    // Remount — the row hydrates from localStorage.
    renderWithVin(VIN);
    expect(within(screen.getByTestId('key-history-list')).getAllByTestId('key-history-row')).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId('key-history-remove'));
    });
    expect(screen.queryByTestId('key-history-list')).toBeNull();
    expect(screen.getByTestId('key-history-empty')).toBeTruthy();
  });

  it('Load re-populates the Key Dump card from a saved row', async () => {
    renderWithVin(VIN);
    await captureValidKey('charger key #1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('key-dump-save-history'));
    });

    // Start a fresh blank key so the fields are empty before reload.
    await act(async () => {
      fireEvent.click(screen.getByTestId('key-dump-add'));
    });
    expect(screen.getByTestId('key-dump-uid').value).toBe('');

    await act(async () => {
      fireEvent.click(screen.getByTestId('key-history-load'));
    });
    expect(screen.getByTestId('key-dump-uid').value).toBe('00 77 A2 9B');
    expect(screen.getByTestId('key-dump-sk').value).toBe('4F 4E 4D 49 4B 52');
    expect(screen.getByTestId('key-dump-label').value).toBe('charger key #1');
  });
});

/* ============================================================================
 * Task #1000 — Export all keys / Import key set buttons.
 *
 * keyHistory.test.js already unit-tests the wrapper build/parse/import logic.
 * These tests lock in the *wiring* of the two new Key Writer buttons:
 *   - "Export all keys" triggers a download once a populated history exists.
 *   - The hidden file input folds an imported wrapper into the list + note.
 *   - "Import key set" is disabled without a valid Master VIN.
 * ========================================================================== */
describe('KeyWriter Export/Import key set buttons (Task #1000)', () => {
  beforeEach(() => {
    globalThis.localStorage?.removeItem(KEY_HISTORY_KEY);
    if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:stub';
    if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('Export all keys triggers a download for a populated history', async () => {
    renderWithVin(VIN);

    // Populate the history with one saved key so the export button renders.
    await captureValidKey('export me');
    await act(async () => {
      fireEvent.click(screen.getByTestId('key-dump-save-history'));
    });

    // Spy on the download primitives so we can assert one fired.
    const createUrl = vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:keyset');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const exportBtn = screen.getByTestId('key-history-export-all');
    await act(async () => {
      fireEvent.click(exportBtn);
    });

    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('key-dump-note').textContent).toMatch(/Exported all 1 key/i);
  });

  it('importing a wrapper file via the hidden input grows the list and shows a note', async () => {
    renderWithVin(VIN);
    expect(screen.getByTestId('key-history-empty')).toBeTruthy();

    // Build a valid wrapper the lib would accept, carrying two distinct keys.
    const wrapper = buildKeyHistoryExport(VIN, [
      { chipId: 'id46', uidHex: '11 22 33 44', skHex: '01 02 03 04 05 06', label: 'imported A' },
      { chipId: 'id46', uidHex: 'AA BB CC DD', skHex: '0A 0B 0C 0D 0E 0F', label: 'imported B' },
    ]);
    const file = new File([JSON.stringify(wrapper)], 'keyset.json', { type: 'application/json' });

    const input = screen.getByTestId('key-history-import-input');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    // onImportKeysFile awaits file.text(); wait for the list to materialize.
    await waitFor(() => {
      expect(screen.getByTestId('key-history-list')).toBeTruthy();
    });
    const rows = within(screen.getByTestId('key-history-list')).getAllByTestId('key-history-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('key-history-count').textContent).toMatch(/2 saved/);
    expect(screen.getByTestId('key-dump-note').textContent).toMatch(/Imported 2 keys/i);
  });

  it('Import key set is disabled without a valid Master VIN', () => {
    renderWithVin('');
    expect(screen.getByTestId('key-history-import').disabled).toBe(true);
  });
});

describe('KeyWriter cross-VIN import warning (Task #999)', () => {
  const OTHER_VIN = '2C3CDXL95KH654321';

  /* A one-key wrapper exported from OTHER_VIN, ready to import onto VIN. */
  function otherVinWrapperFile() {
    const wrapper = {
      type: 'srtlab.keywriter.keyhistory',
      version: 1,
      exportedAt: Date.now(),
      vin: OTHER_VIN,
      keys: [{
        chipId: 'id46', uidHex: '11 22 33 44', skHex: '4F 4E 4D 49 4B 52',
        flags: { locked: false, coding: 'manchester', encryption: true, cloneable: true },
        label: 'foreign fob', slotIdx: 0,
      }],
    };
    const file = new File([JSON.stringify(wrapper)], 'keys.json', { type: 'application/json' });
    file.text = async () => JSON.stringify(wrapper);
    return file;
  }

  beforeEach(() => {
    globalThis.localStorage?.removeItem(KEY_HISTORY_KEY);
    if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:stub';
    if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
  });
  afterEach(() => {
    cleanup();
    delete globalThis.window.confirm;
  });

  it('cancelling the warning aborts with no change to history', async () => {
    globalThis.window.confirm = () => false;
    renderWithVin(VIN);
    expect(screen.getByTestId('key-history-empty')).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByTestId('key-history-import-input'), {
        target: { files: [otherVinWrapperFile()] },
      });
    });

    expect(screen.queryByTestId('key-history-list')).toBeNull();
    expect(screen.getByTestId('key-history-empty')).toBeTruthy();
    expect(screen.getByTestId('key-dump-note').textContent).toMatch(/cancelled/i);
  });

  it('confirming the warning folds the foreign key set in', async () => {
    globalThis.window.confirm = () => true;
    renderWithVin(VIN);

    await act(async () => {
      fireEvent.change(screen.getByTestId('key-history-import-input'), {
        target: { files: [otherVinWrapperFile()] },
      });
    });

    const rows = within(screen.getByTestId('key-history-list')).getAllByTestId('key-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toMatch(/foreign fob/);
    expect(screen.getByTestId('key-dump-note').textContent).toMatch(/Imported 1 key/i);
  });
});
