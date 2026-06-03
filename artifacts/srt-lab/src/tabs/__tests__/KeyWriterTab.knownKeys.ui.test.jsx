// @vitest-environment jsdom
/* ============================================================================
 * KeyWriterTab.knownKeys.ui.test.jsx — Task #1096 click-through for the
 * known-good working-key registry surface on the Key Dump card.
 *
 * Covers:
 *  - the known-good picker is rendered with the seeded 2019 Charger key,
 *  - Prefill loads the Key Dump card (chip/UID/SK) from the registry entry,
 *  - the status badge flips to "known-good" once prefilled,
 *  - editing the SK to a wrong value flips the badge to "mismatch",
 *  - a fresh/blank record reads as "unknown" (not in the registry).
 * ========================================================================== */

import React from 'react';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

import KeyWriterTab from '../KeyWriterTab.jsx';
import { MasterVinContext } from '../../lib/masterVinContext.jsx';

const SEED_ID = 'charger62-2019-0077A29B';

/* Render the tab inside a MasterVinContext fixed to `vin` so the VIN-scoped
 * known-good keys (SCAT / CARTMAN) surface. */
function renderWithVin(vin) {
  const value = {
    vin: vin || '',
    setVin: () => {},
    vinValid: !!vin && vin.length === 17,
    moduleStatus: { BCM: 'pending', RFHUB: 'pending', ECM: 'pending', ADCM: 'pending' },
    setModuleStatus: () => {},
    updateStatus: () => {},
    resetStatus: () => {},
    setPg: () => {},
    loadedDumps: [],
    addDump: () => null,
    replaceDump: () => null,
    removeDump: () => {},
    clearDumps: () => {},
    getDumpsByType: () => [],
    jobId: null,
    setJobId: () => {},
    hydrateFromJob: () => {},
  };
  return render(
    <MasterVinContext.Provider value={value}>
      <KeyWriterTab onOpenTab={() => {}} />
    </MasterVinContext.Provider>,
  );
}

describe('KeyWriterTab known-good registry surface (Task #1096)', () => {
  beforeEach(() => {
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch { /* ignore */ }
  });
  afterEach(() => {
    cleanup();
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch { /* ignore */ }
  });

  it('renders the known-good picker with the seeded Charger key', () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);
    expect(screen.getByTestId('known-key-list')).toBeTruthy();
    expect(screen.getByTestId(`known-key-row-${SEED_ID}`)).toBeTruthy();
    expect(screen.getByTestId('known-key-list').textContent).toContain('0077A29B');
  });

  it('a fresh blank record reads as "unknown"', () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);
    expect(screen.getByTestId('known-key-status').getAttribute('data-status')).toBe('unknown');
  });

  it('Prefill loads the card and flips the badge to known-good', async () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`known-key-prefill-${SEED_ID}`));
    });

    await waitFor(() => {
      expect(screen.getByTestId('key-dump-uid').value.replace(/\s/g, '')).toBe('0077A29B');
    });
    expect(screen.getByTestId('key-dump-sk').value.replace(/\s/g, '')).toBe('4F4E4D494B52');
    expect(screen.getByTestId('key-dump-chip').value).toBe('id46');
    expect(screen.getByTestId('known-key-status').getAttribute('data-status')).toBe('known-good');
  });

  it('editing the SK to a wrong value flips the badge to mismatch', async () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`known-key-prefill-${SEED_ID}`));
    });
    await waitFor(() => {
      expect(screen.getByTestId('known-key-status').getAttribute('data-status')).toBe('known-good');
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId('key-dump-sk'), { target: { value: 'DE AD BE EF CA FE' } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('known-key-status').getAttribute('data-status')).toBe('mismatch');
    });
    expect(screen.getByTestId('known-key-status').textContent).toMatch(/sk/i);
  });
});

describe('KeyWriterTab known-good keys grouped by vehicle + VIN (Task #1104)', () => {
  const SCAT_VIN = '2C3CDXHG5EH219538';
  const SCAT_KEY_ID = 'scat-2C3CDXHG5EH219538-54D44964';
  const CARTMAN_VIN = '2C3CDZL95NH179529';
  const CARTMAN_KEY_ID = 'cartman-2C3CDZL95NH179529-2FA7D964';

  afterEach(() => { cleanup(); });

  it('labels the global seed group with "Any vehicle" when no VIN is loaded', () => {
    renderWithVin('');
    const label = screen.getByTestId('known-key-group-label-global');
    expect(label.textContent).toMatch(/any vehicle/i);
    // the seed key still renders inside its group
    expect(screen.getByTestId(`known-key-row-${SEED_ID}`)).toBeTruthy();
  });

  it('renders a VIN-scoped vehicle label for the SCAT keys', () => {
    renderWithVin(SCAT_VIN);
    const group = screen.getByTestId(`known-key-group-${SCAT_VIN}`);
    expect(group.getAttribute('data-vin')).toBe(SCAT_VIN);
    const label = screen.getByTestId(`known-key-group-label-${SCAT_VIN}`);
    expect(label.textContent).toMatch(/Charger SCAT/i);
    expect(label.textContent).toContain(SCAT_VIN);
    // a SCAT key row lives under that group
    expect(screen.getByTestId(`known-key-row-${SCAT_KEY_ID}`)).toBeTruthy();
    // the global seed group is still present alongside the VIN-scoped one
    expect(screen.getByTestId('known-key-group-label-global')).toBeTruthy();
  });

  it('renders a VIN-scoped vehicle label for the CARTMAN keys', () => {
    renderWithVin(CARTMAN_VIN);
    const label = screen.getByTestId(`known-key-group-label-${CARTMAN_VIN}`);
    expect(label.textContent).toMatch(/CARTMAN/i);
    expect(label.textContent).toContain(CARTMAN_VIN);
    expect(screen.getByTestId(`known-key-row-${CARTMAN_KEY_ID}`)).toBeTruthy();
  });
});
