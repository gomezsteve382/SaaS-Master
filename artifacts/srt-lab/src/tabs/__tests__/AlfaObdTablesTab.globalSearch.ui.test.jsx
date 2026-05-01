// @vitest-environment jsdom
//
// Task #506 — Global module search across every ECUTYPE family.
//
// Mounts <AlfaObdTablesTab/> with a stubbed fetch that returns a tiny
// manifest plus two ECUTYPE families, then verifies the new global
// search input:
//   1. Filters the sidebar to the families that contain a match and
//      shows a per-family hit count badge.
//   2. Lists the matching modules across every family in a results
//      panel beneath the input.
//   3. Clicking a hit switches the active family and reveals the row
//      in the modules table for that family.

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

import AlfaObdTablesTab from '../AlfaObdTablesTab.jsx';

const MANIFEST = {
  schema_version: '1.0',
  generated_at: '2026-01-01T00:00:00Z',
  alfaobd: { file_version: '2.2.5.6', sha256: 'abc123def456abc123def4567890abcdef1234567890abcdef1234567890abcd' },
  outputs: {
    files: [
      { path: 'ecutypes/ECUTYPE_LX.json' },
      { path: 'ecutypes/ECUTYPE_WL.json' },
    ],
  },
};

const FAMILY_LX = {
  family: 'ECUTYPE_LX',
  modules: [
    { ecu_type_id: '0x100', name: 'BCM_LX', display_name: 'Body Control', protocols: ['UDS'], tx_address: '0x18DA40F1', rx_address: '0x18DAF140', source: 'lx.cs' },
    { ecu_type_id: '0x132', name: 'PCM_LX', display_name: 'Powertrain', protocols: ['UDS'], tx_address: '0x18DA10F1', rx_address: '0x18DAF110', source: 'lx.cs' },
  ],
};

const FAMILY_WL = {
  family: 'ECUTYPE_WL',
  modules: [
    { ecu_type_id: '0x132', name: 'PCM_WL', display_name: 'Powertrain', protocols: ['UDS'], tx_address: '0x18DA11F1', rx_address: '0x18DAF111', source: 'wl.cs' },
    { ecu_type_id: '0x200', name: 'TCM_WL', display_name: 'Trans Control', protocols: ['UDS'], tx_address: '0x18DA18F1', rx_address: '0x18DAF118', source: 'wl.cs' },
  ],
};

function makeFetch() {
  return vi.fn(async (url) => {
    const u = String(url);
    function jsonResp(body) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => body,
      };
    }
    function notFound() {
      return {
        ok: false,
        status: 404,
        headers: { get: () => 'application/json' },
        json: async () => ({}),
      };
    }
    if (u.endsWith('/manifest.json')) return jsonResp(MANIFEST);
    if (u.endsWith('/ecutypes/ECUTYPE_LX.json')) return jsonResp(FAMILY_LX);
    if (u.endsWith('/ecutypes/ECUTYPE_WL.json')) return jsonResp(FAMILY_WL);
    if (u.endsWith('/handlers.json')) return jsonResp({ handlers: [] });
    if (u.endsWith('/transports.json')) return jsonResp({ transports: [] });
    if (u.endsWith('/resources.json')) return jsonResp({ bundles: [], media: [] });
    return notFound();
  });
}

beforeEach(() => {
  globalThis.fetch = makeFetch();
  // jsdom doesn't implement scrollIntoView; the click handler invokes it.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AlfaObdTablesTab — global search across families', () => {
  it('shows the new global search input and the per-family search input once data is loaded', async () => {
    render(<AlfaObdTablesTab />);
    await waitFor(() => {
      expect(screen.getByTestId('alfaobd-tables-ready')).toBeTruthy();
    });
    expect(screen.getByTestId('alfaobd-global-search')).toBeTruthy();
    expect(screen.getByTestId('alfaobd-module-search')).toBeTruthy();
  });

  it('filters the sidebar to families with matches, shows a hit-count badge per family, and lists every match across families', async () => {
    render(<AlfaObdTablesTab />);
    await waitFor(() => screen.getByTestId('alfaobd-tables-ready'));

    // Both families visible before the global search runs.
    expect(screen.getByTestId('alfaobd-family-ECUTYPE_LX')).toBeTruthy();
    expect(screen.getByTestId('alfaobd-family-ECUTYPE_WL')).toBeTruthy();

    const globalInput = screen.getByTestId('alfaobd-global-search');
    await act(async () => {
      fireEvent.change(globalInput, { target: { value: '0x132' } });
    });

    // Both families have a 0x132 module — both stay visible with badges.
    const lxHits = await screen.findByTestId('alfaobd-family-hits-ECUTYPE_LX');
    const wlHits = await screen.findByTestId('alfaobd-family-hits-ECUTYPE_WL');
    expect(lxHits.textContent).toMatch(/1\s*hit/);
    expect(wlHits.textContent).toMatch(/1\s*hit/);

    // The global results panel lists hits from BOTH families.
    expect(screen.getByTestId('alfaobd-global-hit-ECUTYPE_LX-0x132')).toBeTruthy();
    expect(screen.getByTestId('alfaobd-global-hit-ECUTYPE_WL-0x132')).toBeTruthy();
  });

  it('hides families that have no matches when the global search is active', async () => {
    render(<AlfaObdTablesTab />);
    await waitFor(() => screen.getByTestId('alfaobd-tables-ready'));

    const globalInput = screen.getByTestId('alfaobd-global-search');
    await act(async () => {
      fireEvent.change(globalInput, { target: { value: 'TCM' } }); // only in WL
    });

    expect(screen.queryByTestId('alfaobd-family-ECUTYPE_LX')).toBeNull();
    expect(screen.getByTestId('alfaobd-family-ECUTYPE_WL')).toBeTruthy();
    expect(screen.getByTestId('alfaobd-global-hit-ECUTYPE_WL-0x200')).toBeTruthy();
  });

  it('clicking a global hit jumps to that family and renders the matching row in the modules table', async () => {
    render(<AlfaObdTablesTab />);
    await waitFor(() => screen.getByTestId('alfaobd-tables-ready'));

    // Active family starts as LX (alphabetical first).
    expect(screen.getByTestId('alfaobd-modules-ECUTYPE_LX')).toBeTruthy();

    const globalInput = screen.getByTestId('alfaobd-global-search');
    await act(async () => {
      fireEvent.change(globalInput, { target: { value: 'TCM' } });
    });

    const hit = await screen.findByTestId('alfaobd-global-hit-ECUTYPE_WL-0x200');
    await act(async () => {
      fireEvent.click(hit);
    });

    // The active family switched to WL and the matching row is in the DOM.
    await waitFor(() => {
      expect(screen.getByTestId('alfaobd-modules-ECUTYPE_WL')).toBeTruthy();
    });
    expect(screen.getByTestId('alfaobd-module-row-ECUTYPE_WL-0x200')).toBeTruthy();
  });

  it('clicking a global hit clears any pre-existing per-family search so the row is guaranteed to be visible', async () => {
    render(<AlfaObdTablesTab />);
    await waitFor(() => screen.getByTestId('alfaobd-tables-ready'));

    // Stash a per-family search that would normally hide the BCM_LX row.
    const perFamily = screen.getByTestId('alfaobd-module-search');
    await act(async () => {
      fireEvent.change(perFamily, { target: { value: 'PCM' } });
    });
    expect(screen.queryByTestId('alfaobd-module-row-ECUTYPE_LX-0x100')).toBeNull();

    // Now use the global search for a BCM hit and click it.
    const globalInput = screen.getByTestId('alfaobd-global-search');
    await act(async () => {
      fireEvent.change(globalInput, { target: { value: 'BCM' } });
    });
    const hit = await screen.findByTestId('alfaobd-global-hit-ECUTYPE_LX-0x100');
    await act(async () => {
      fireEvent.click(hit);
    });

    // The per-family search was cleared and the row is now in the DOM.
    expect(screen.getByTestId('alfaobd-module-search').value).toBe('');
    await waitFor(() => {
      expect(screen.getByTestId('alfaobd-module-row-ECUTYPE_LX-0x100')).toBeTruthy();
    });
  });

  it('shows a "no matches" message when the global query has zero hits across all families', async () => {
    render(<AlfaObdTablesTab />);
    await waitFor(() => screen.getByTestId('alfaobd-tables-ready'));

    const globalInput = screen.getByTestId('alfaobd-global-search');
    await act(async () => {
      fireEvent.change(globalInput, { target: { value: 'definitely-not-a-real-id' } });
    });

    const panel = await screen.findByTestId('alfaobd-global-results');
    expect(panel.textContent.toLowerCase()).toContain('no matches');
    expect(screen.queryByTestId('alfaobd-family-ECUTYPE_LX')).toBeNull();
    expect(screen.queryByTestId('alfaobd-family-ECUTYPE_WL')).toBeNull();
  });
});
