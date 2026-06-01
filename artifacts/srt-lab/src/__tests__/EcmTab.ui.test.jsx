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
    // SecurityAccess: 27 01 → seed (≥4 bytes), 27 02 → key accepted (0x67).
    if (req[0] === 0x27 && req[1] === 0x01) return { ok: true, d: new Uint8Array([0x67, 0x01, 0x12, 0x34, 0x56, 0x78]) };
    if (req[0] === 0x27 && req[1] === 0x02) return { ok: true, d: new Uint8Array([0x67, 0x02]) };
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
vi.mock('../lib/sgwAuth.js', () => ({ isSgwAuthenticated: () => true }));
vi.mock('../lib/vin.js', async () => {
  const actual = await vi.importActual('../lib/vin.js');
  return { ...actual, vinHasSGW: () => false };
});

import EcmTab from '../tabs/EcmTab.jsx';
import { VEHICLES } from '../lib/vehicles.js';
import { MasterVinProvider, MasterVinContext } from '../lib/masterVinContext.jsx';

// Seeds the Master VIN through context (the provider has no initialVin prop)
// so the ECM write button can enable in tests.
function SeedVin({ vin, children }) {
  const { setVin } = React.useContext(MasterVinContext);
  React.useEffect(() => { setVin(vin); }, [vin, setVin]);
  return children;
}

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

  it('VIN write routes programVin to the manually-overridden address, not the 0x7E0 default', async () => {
    const { programVin } = await import('../lib/vinProgrammer.js');
    programVin.mockClear();
    render(
      <MasterVinProvider setPg={() => {}}>
        <SeedVin vin="2C3CDXKT8FH000001">
          <EcmTab vehicle={VEHICLES.charger} />
        </SeedVin>
      </MasterVinProvider>
    );

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Connect Adapter/i })); });
    await waitFor(() => expect(screen.getByText(/● CONNECTED/i)).toBeTruthy());

    // Apply a non-standard manual override (TX 0x6F0 / RX 0x6F8).
    const addrInput = screen.getByPlaceholderText(/7E0/i);
    await act(async () => { fireEvent.change(addrInput, { target: { value: '6F0' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Set Address/i })); });

    // Unlock so the write button enables (mock engine returns 0x67 for 27 02).
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Unlock \(Auto-Try/i })); });
    await waitFor(() => expect(screen.getByText(/● UNLOCKED/i)).toBeTruthy());

    const writeBtn = screen.getByRole('button', { name: /Write Master VIN/i });
    await waitFor(() => expect(writeBtn.disabled).toBe(false));
    await act(async () => { fireEvent.click(writeBtn); });

    // Read-First modal: tick the "I have reviewed…" checkbox to enable confirm.
    const modal = await screen.findByTestId('read-first-modal');
    const reviewCb = modal.querySelector('input[type="checkbox"]');
    await act(async () => { fireEvent.click(reviewCb); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /CONFIRM & PROCEED/i })); });

    await waitFor(() => expect(programVin).toHaveBeenCalled());
    const { row } = programVin.mock.calls[0][0];
    expect(row.tx).toBe(0x6F0);
    expect(row.rx).toBe(0x6F8);
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
