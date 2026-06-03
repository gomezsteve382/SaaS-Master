// @vitest-environment jsdom
/*
 * Full-shell navigation drift guard.
 *
 * Companion to keyTransferNav.ui.test.jsx (which guards the single Key Program
 * rail button). This test renders the full App -> VehicleWorkspace ->
 * CommandShell and, for every PRIMARY_NAV + FOOTER_NAV destination, clicks the
 * rail button and asserts the destination's own content renders — never the
 * Dumps fallback.
 *
 * Why this matters: `setTab()` in VehicleWorkspace clamps any unknown tab id
 * to 'dumps'. So if a rail key, the `tab === '<id>'` switch arm, or a tab
 * component's wiring is renamed/broken, the workspace would silently fall back
 * to the Dumps tab and ship a dead button with no failure. This test turns that
 * silent drift into a hard failure.
 *
 * A small sample of Advanced-drawer destinations is covered the same way.
 *
 * Each destination has an EXPECTED_CONTENT_TESTID entry pointing at a stable
 * root testid on the rendered tab. The `PRIMARY_NAV/FOOTER_NAV are all mapped`
 * test asserts the map stays complete, so adding a new rail/footer entry
 * without a content assertion fails loudly here.
 */
import React from 'react';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

import App from '../App.jsx';
import { PRIMARY_NAV, FOOTER_NAV } from '../components/CommandShell.jsx';

// Stable root testid rendered by each destination tab's content. The negative
// assertion checks the Dumps fallback (`dumps-pcm-target-chip-selector`) is
// absent for every non-dumps destination.
const EXPECTED_CONTENT_TESTID = {
  dumps: 'dumps-pcm-target-chip-selector',
  vinsync: 'vinsync-slots',
  secsync: 'security-sync-tab',
  keyxfer: 'key-transfer-tab',
  'uds-console': 'uds-console-tab',
  vinprog: 'vinprog-subtab-bar',
  obd: 'live-obd-tab',
  investigation: 'investigation-tab',
  // FOOTER_NAV
  workflow: 'workflow-tab',
  canuniverse: 'canuniverse-tab',
};

const DUMPS_FALLBACK_TESTID = 'dumps-pcm-target-chip-selector';

// A representative sample of Advanced-drawer destinations (reached via the
// topbar "Advanced / Reference" button -> drawer-tab-<id>).
const DRAWER_SAMPLE = [
  { key: 'bcm', testid: 'bcm-tab' },
  { key: 'rfhub', testid: 'rfhub-tab' },
];

function enterWorkspace() {
  render(<App />);
  // Landing page -> pick a vehicle to enter the per-vehicle workspace.
  act(() => { fireEvent.click(screen.getByText('CHARGER')); });
}

describe('Workspace navigation (full shell)', () => {
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

  it('every PRIMARY_NAV and FOOTER_NAV key has a content assertion mapped', () => {
    for (const item of [...PRIMARY_NAV, ...FOOTER_NAV]) {
      expect(
        EXPECTED_CONTENT_TESTID[item.key],
        `Nav key "${item.key}" has no EXPECTED_CONTENT_TESTID entry — add one so its rail button is guarded against dead-navigation drift.`,
      ).toBeTruthy();
    }
  });

  describe('PRIMARY_NAV rail buttons render their destination', () => {
    for (const item of PRIMARY_NAV) {
      it(`rail-${item.key} renders ${EXPECTED_CONTENT_TESTID[item.key]}`, () => {
        enterWorkspace();

        const railBtn = screen.getByTestId(`rail-${item.key}`);
        expect(railBtn).toBeTruthy();

        act(() => { fireEvent.click(railBtn); });

        const contentTestId = EXPECTED_CONTENT_TESTID[item.key];
        expect(screen.getByTestId(contentTestId)).toBeTruthy();

        // Non-dumps destinations must not silently fall back to the Dumps tab.
        if (item.key !== 'dumps') {
          expect(screen.queryByTestId(DUMPS_FALLBACK_TESTID)).toBeNull();
        }
      });
    }
  });

  describe('FOOTER_NAV rail buttons render their destination', () => {
    for (const item of FOOTER_NAV) {
      it(`rail-footer-${item.key} renders ${EXPECTED_CONTENT_TESTID[item.key]}`, () => {
        enterWorkspace();

        const footerBtn = screen.getByTestId(`rail-footer-${item.key}`);
        expect(footerBtn).toBeTruthy();

        act(() => { fireEvent.click(footerBtn); });

        expect(screen.getByTestId(EXPECTED_CONTENT_TESTID[item.key])).toBeTruthy();
        expect(screen.queryByTestId(DUMPS_FALLBACK_TESTID)).toBeNull();
      });
    }
  });

  describe('Advanced-drawer destinations render (sample)', () => {
    for (const { key, testid } of DRAWER_SAMPLE) {
      it(`drawer-tab-${key} renders ${testid}`, () => {
        enterWorkspace();

        // Open the Advanced / Reference drawer.
        act(() => { fireEvent.click(screen.getByTestId('topbar-advanced-btn')); });
        expect(screen.getByTestId('advanced-drawer')).toBeTruthy();

        // Click the drawer entry -> destination content renders, drawer closes.
        act(() => { fireEvent.click(screen.getByTestId(`drawer-tab-${key}`)); });

        expect(screen.getByTestId(testid)).toBeTruthy();
        expect(screen.queryByTestId(DUMPS_FALLBACK_TESTID)).toBeNull();
      });
    }
  });
});
