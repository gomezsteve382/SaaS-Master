// @vitest-environment jsdom
/*
 * Key Program navigation integration test.
 *
 * Unlike keyTransferTab.ui.test.jsx (which renders KeyTransferTab in isolation
 * and asserts PRIMARY_NAV contains a 'keyxfer' entry), this test renders the
 * full App → VehicleWorkspace → CommandShell, clicks the `rail-keyxfer` rail
 * button, and asserts the `key-transfer-tab` content actually renders.
 *
 * It guards against navigation drift: if the rail key, the `tab==='keyxfer'`
 * switch, or the KeyTransferTab wiring is renamed/broken, the workspace would
 * silently fall back to the Dumps tab (setTab clamps unknown ids to 'dumps'),
 * and this test would fail instead of shipping a dead button.
 */
import React from 'react';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

import App from '../App.jsx';

describe('Key Program rail navigation (full shell)', () => {
  let originalFetch;
  beforeEach(() => {
    // App fires fire-and-forget fetches on some interactions; stub so jsdom
    // never hits the network or emits unhandled rejections.
    originalFetch = global.fetch;
    global.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
  });

  it('clicking the Key Program rail button renders the key-transfer tab', async () => {
    render(<App />);

    // Landing page → pick a vehicle to enter the per-vehicle workspace.
    await act(async () => { fireEvent.click(screen.getByText('CHARGER')); });

    // The command shell is up; the rail Key Program button is present.
    const railBtn = screen.getByTestId('rail-keyxfer');
    expect(railBtn).toBeTruthy();

    // Default landing tab is Dumps, not the key-transfer tab.
    expect(screen.queryByTestId('key-transfer-tab')).toBeNull();

    // Click the rail button → the key-transfer tab content should render.
    await act(async () => { fireEvent.click(railBtn); });

    expect(screen.getByTestId('key-transfer-tab')).toBeTruthy();
    // And specifically not the Dumps fallback.
    expect(screen.queryByTestId('dumps-corrupt-card')).toBeNull();
  });
});
