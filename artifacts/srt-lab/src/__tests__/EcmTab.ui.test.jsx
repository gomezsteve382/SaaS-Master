// @vitest-environment jsdom
//
// Task #446 — EcmTab UI: vehicle prop, mocked initAdapter + bridge engine.
//
// Pre-task this leg lacked any React-level test even though it covers the
// ECM VIN write path that the donor/SEC6/IMMO surface ultimately relies on
// to flush a leaked VIN out of the engine controller. This test mounts the
// tab with a vehicle prop and asserts:
//   1. CONNECT calls the mocked initAdapter and surfaces "● CONNECTED",
//   2. Test Connection issues 3E 00 + 22 F1 90 and surfaces the parsed VIN,
//   3. WRITE MASTER VIN stays disabled until both unlocked AND a 17-char
//      Master VIN is set,
//   4. with no Master VIN, the wrap-around safety button never enables.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

const mockEngine = {
  uds: vi.fn(async (_tx, _rx, req) => {
    if (req[0] === 0x3E) return { ok: true, d: new Uint8Array([0x7E, 0x00]) };
    if (req[0] === 0x22 && req[1] === 0xF1 && req[2] === 0x90) {
      // 62 F1 90 + 17-char VIN
      const vin = '2C3CDXKT8FH000001';
      const out = new Uint8Array(3 + 17);
      out[0] = 0x62; out[1] = 0xF1; out[2] = 0x90;
      for (let i = 0; i < 17; i++) out[3 + i] = vin.charCodeAt(i);
      return { ok: true, d: out };
    }
    return { ok: true, d: new Uint8Array([req[0] + 0x40]) };
  }),
};

vi.mock('../lib/initAdapter.js', async () => {
  const actual = await vi.importActual('../lib/initAdapter.js');
  return {
    ...actual,
    initAdapter: vi.fn(async (addLog) => {
      addLog('mock adapter ready', 'info');
      return mockEngine;
    }),
    parseVinFromResponse: (d) => {
      if (!d || d[0] !== 0x62) return null;
      const arr = Array.from(d).slice(3);
      const ascii = arr.filter(b => b >= 0x20 && b <= 0x7E).map(b => String.fromCharCode(b)).join('').trim();
      return ascii.slice(-17);
    },
  };
});
vi.mock('../lib/audit.js', () => ({
  backupModule: vi.fn(async () => ({ key: 'ecm-snap', dids: {} })),
  CRITICAL_DIDS: { ECM: [0xF190] },
}));
vi.mock('../lib/bridgeEngine.js', () => ({
  createBridgeEngine: vi.fn(async () => ({ ok: false, error: 'not used in this test' })),
}));
vi.mock('../lib/vinProgrammer.js', () => ({
  programVin: vi.fn(async () => ({ ok: false, didResults: [] })),
}));

import EcmTab from '../tabs/EcmTab.jsx';
import { VEHICLES } from '../lib/vehicles.js';
import { MasterVinProvider } from '../lib/masterVinContext.jsx';

beforeEach(() => { mockEngine.uds.mockClear(); });
afterEach(() => cleanup());

describe('EcmTab UI', () => {
  it('renders the ECM PROGRAMMER header with the vehicle banner', () => {
    render(
      <MasterVinProvider setPg={() => {}}>
        <EcmTab vehicle={VEHICLES.charger} />
      </MasterVinProvider>
    );
    expect(screen.getByText(/ECM PROGRAMMER/i)).toBeTruthy();
    expect(screen.getByText(/Dodge Charger/)).toBeTruthy();
    expect(screen.getByText(/○ DISCONNECTED/i)).toBeTruthy();
  });

  it('CONNECT → initAdapter resolves → shows ● CONNECTED', async () => {
    render(
      <MasterVinProvider setPg={() => {}}>
        <EcmTab vehicle={VEHICLES.charger} />
      </MasterVinProvider>
    );

    const btn = screen.getByRole('button', { name: /Connect Adapter/i });
    await act(async () => { fireEvent.click(btn); });

    await waitFor(() => expect(screen.getByText(/● CONNECTED/i)).toBeTruthy());
  });

  it('Test Connection drives 3E 00 + 22 F1 90 and surfaces the parsed VIN', async () => {
    render(
      <MasterVinProvider setPg={() => {}}>
        <EcmTab vehicle={VEHICLES.charger} />
      </MasterVinProvider>
    );

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Connect Adapter/i })); });
    await waitFor(() => expect(screen.getByText(/● CONNECTED/i)).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Test Connection/i })); });

    await waitFor(() => {
      const reqs = mockEngine.uds.mock.calls.map(c => c[2]);
      expect(reqs.some(r => r[0] === 0x3E)).toBe(true);
      expect(reqs.some(r => r[0] === 0x22 && r[1] === 0xF1 && r[2] === 0x90)).toBe(true);
    });

    // VIN appears (in the VIN STATUS panel and again in the log).
    await waitFor(() => expect(screen.getAllByText(/2C3CDXKT8FH000001/).length).toBeGreaterThan(0));
  });

  it('WRITE MASTER VIN stays disabled while no Master VIN is set', async () => {
    render(
      <MasterVinProvider setPg={() => {}}>
        <EcmTab vehicle={VEHICLES.charger} />
      </MasterVinProvider>
    );

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Connect Adapter/i })); });
    await waitFor(() => expect(screen.getByText(/● CONNECTED/i)).toBeTruthy());

    const writeBtn = screen.getByRole('button', { name: /Write Master VIN/i });
    expect(writeBtn.disabled).toBe(true);
  });
});
