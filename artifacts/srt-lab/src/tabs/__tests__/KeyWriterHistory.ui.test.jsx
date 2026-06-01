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
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';

import KeyWriterTab from '../KeyWriterTab.jsx';
import { MasterVinContext } from '../../lib/masterVinContext.jsx';
import { KEY_HISTORY_KEY } from '../../lib/keyWriter/keyHistory.js';

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
