// @vitest-environment jsdom
/*
 * Full-shell navigation drift guard (job-flow model).
 *
 * Renders the full App -> VehicleWorkspace -> CommandShell and, for every
 * PRIMARY_NAV job door + FOOTER_NAV link, clicks the rail button and asserts
 * the destination renders — never the Dumps fallback.
 *
 * Post job-flow rebuild the rail is the SIX job doors (workspaceJobs.js), each
 * opening its job's `primary` tab. Clicking a door must (a) show that job's
 * mode strip (`mode-strip-<jobId>`) and (b) NOT silently clamp back to the
 * Dumps tab. `setTab()` clamps any unknown id to 'dumps', so a broken rail key
 * or switch arm would land on dumps — which shows `mode-strip-ref` + the dumps
 * fallback — and fail these assertions loudly.
 *
 * A sample of Advanced-drawer destinations is covered the same way (the drawer
 * sections are collapsible, so the test expands the section first).
 */
import React from 'react';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

import App from '../App.jsx';
import { PRIMARY_NAV, FOOTER_NAV } from '../components/CommandShell.jsx';
import { JOB_OF } from '../workspaceJobs.js';

// Each rail door opens a JOB. `job` is the mode-strip id that always renders
// for that door; optional `testid` is a stable root testid on the primary tab.
const PRIMARY_EXPECT = {
  inspector: { job: 'read' },
  secsync:   { job: 'marry', testid: 'marry-sync-tab' },
  keyprog:   { job: 'keys' },
  flasher:   { job: 'flash' },
  obd:       { job: 'live', testid: 'live-obd-tab' },
  dumps:     { job: 'ref', testid: 'dumps-pcm-target-chip-selector' },
};

// FOOTER_NAV links (still reached via rail-footer-<key>).
const FOOTER_EXPECT = {
  workflow: 'workflow-tab',
  canuniverse: 'canuniverse-tab',
};

const DUMPS_FALLBACK_TESTID = 'dumps-pcm-target-chip-selector';

// A representative sample of Advanced-drawer destinations. Both are READ-job
// members, so the drawer's READ section must be expanded before the tab pill
// renders (sections are collapsed by default unless they hold the active tab).
const DRAWER_SAMPLE = [
  { key: 'bcm', section: 'read', testid: 'bcm-tab' },
  { key: 'rfhub', section: 'read', testid: 'rfhub-tab' },
];

function enterWorkspace() {
  render(<App />);
  // Landing page -> pick a vehicle to enter the per-vehicle workspace.
  act(() => { fireEvent.click(screen.getByText('CHARGER')); });
}

describe('Workspace navigation (full shell, job-flow model)', () => {
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

  it('every PRIMARY_NAV door + FOOTER_NAV key has an expectation mapped', () => {
    for (const item of PRIMARY_NAV) {
      expect(
        PRIMARY_EXPECT[item.key],
        `Rail door "${item.key}" has no PRIMARY_EXPECT entry — add one so its door is guarded against dead-navigation drift.`,
      ).toBeTruthy();
      // The door's primary tab must agree with the job model's mode-strip id.
      expect(PRIMARY_EXPECT[item.key].job).toBe(JOB_OF[item.key]);
    }
    for (const item of FOOTER_NAV) {
      expect(FOOTER_EXPECT[item.key], `Footer key "${item.key}" has no FOOTER_EXPECT entry.`).toBeTruthy();
    }
  });

  describe('PRIMARY_NAV job doors render their destination', () => {
    for (const item of PRIMARY_NAV) {
      const { job, testid } = PRIMARY_EXPECT[item.key];
      it(`rail-${item.key} opens the ${job.toUpperCase()} job`, () => {
        enterWorkspace();

        const railBtn = screen.getByTestId(`rail-${item.key}`);
        expect(railBtn).toBeTruthy();
        act(() => { fireEvent.click(railBtn); });

        // The job's mode strip renders — proof we landed in this job, not a
        // clamp to dumps (which would show mode-strip-ref instead).
        expect(screen.getByTestId(`mode-strip-${job}`)).toBeTruthy();
        if (testid) expect(screen.getByTestId(testid)).toBeTruthy();

        // Non-dumps doors must not silently fall back to the Dumps tab.
        if (item.key !== 'dumps') {
          expect(screen.queryByTestId(DUMPS_FALLBACK_TESTID)).toBeNull();
        }
      });
    }
  });

  describe('FOOTER_NAV links render their destination', () => {
    for (const item of FOOTER_NAV) {
      it(`rail-footer-${item.key} renders ${FOOTER_EXPECT[item.key]}`, () => {
        enterWorkspace();

        const footerBtn = screen.getByTestId(`rail-footer-${item.key}`);
        expect(footerBtn).toBeTruthy();
        act(() => { fireEvent.click(footerBtn); });

        expect(screen.getByTestId(FOOTER_EXPECT[item.key])).toBeTruthy();
        expect(screen.queryByTestId(DUMPS_FALLBACK_TESTID)).toBeNull();
      });
    }
  });

  describe('Advanced-drawer destinations render (sample)', () => {
    for (const { key, section, testid } of DRAWER_SAMPLE) {
      it(`drawer-tab-${key} renders ${testid}`, () => {
        enterWorkspace();

        // Open the Advanced / Reference drawer.
        act(() => { fireEvent.click(screen.getByTestId('topbar-advanced-btn')); });
        expect(screen.getByTestId('advanced-drawer')).toBeTruthy();

        // Sections are collapsed by default — expand the one holding this tab.
        act(() => { fireEvent.click(screen.getByTestId(`drawer-section-${section}`)); });

        // Click the drawer entry -> destination content renders, drawer closes.
        act(() => { fireEvent.click(screen.getByTestId(`drawer-tab-${key}`)); });

        expect(screen.getByTestId(testid)).toBeTruthy();
        expect(screen.queryByTestId(DUMPS_FALLBACK_TESTID)).toBeNull();
      });
    }
  });
});
