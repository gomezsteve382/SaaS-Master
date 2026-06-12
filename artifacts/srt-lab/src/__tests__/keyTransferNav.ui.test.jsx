// @vitest-environment jsdom
/*
 * Key Program navigation integration test.
 *
 * Unlike keyTransferTab.ui.test.jsx (which renders KeyTransferTab in isolation
 * and asserts PRIMARY_NAV contains a 'keyxfer' entry), this test renders the
 * full App → VehicleWorkspace → CommandShell, opens the KEYS job door
 * (`rail-keyprog`), clicks the `mode-keyxfer` mode pill, and asserts the
 * `key-transfer-tab` content actually renders.
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

    // Post job-flow rebuild: the rail exposes the KEYS job door (primary
    // `keyprog`), not a standalone keyxfer button.
    const keysDoor = screen.getByTestId('rail-keyprog');
    expect(keysDoor).toBeTruthy();

    // Default landing tab is Dumps, not the key-transfer tab.
    expect(screen.queryByTestId('key-transfer-tab')).toBeNull();

    // Open the KEYS door → its mode strip exposes a keyxfer mode pill.
    await act(async () => { fireEvent.click(keysDoor); });
    const modePill = screen.getByTestId('mode-keyxfer');
    expect(modePill).toBeTruthy();

    // Click the keyxfer mode → the key-transfer tab content renders.
    await act(async () => { fireEvent.click(modePill); });

    expect(screen.getByTestId('key-transfer-tab')).toBeTruthy();
    // And specifically not the Dumps fallback.
    expect(screen.queryByTestId('dumps-corrupt-card')).toBeNull();
  });
});
