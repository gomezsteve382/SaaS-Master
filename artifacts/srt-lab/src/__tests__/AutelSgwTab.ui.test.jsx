// @vitest-environment jsdom
//
// Task #446 — AutelSgwTab UI: bridge probe + SGW seed/key smoke.
//
// The Autel SGW tab gates every BCM/RFHUB/ECM/ADCM write that downstream
// donor-VIN/SEC6/IMMO operations depend on. Pre-task there was no
// React-level coverage; regressions to the SGW gate's UI surface (auth
// pill state, bridge log, run-test flow) would only show up when a tech
// hit them on the bench. This test mounts the tab with mocked
// bridgeClient + useBridgeStatus + sgw auth and asserts:
//   1. headers + bridge URL input render with sensible defaults,
//   2. RUN TEST drives bridgeClient.status / .open and writes to the log,
//   3. AUTHENTICATE SGW respects the "no VIN" guard (button disabled).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

const bridgeStatusObj = {
  ok: true, vendor: 'Autel', platform: 'linux', dllPath: '/tmp/x.so',
  bridgeVersion: '1.0', deviceOpen: false, deviceId: null,
  channelConnected: false, channelId: null,
  pythonVersion: '3.11', versions: { firmware: 'fw1', dll: 'd1', api: '04.04' },
};

vi.mock('../lib/bridgeClient.js', () => ({
  DEFAULT_BRIDGE_URL: 'http://127.0.0.1:8765',
  bridgeClient: {
    status: vi.fn(async () => bridgeStatusObj),
    open:   vi.fn(async () => ({ ok: true, deviceId: 7, versions: bridgeStatusObj.versions, deviceSerial: 'SN1' })),
    close:  vi.fn(async () => ({ ok: true })),
  },
  // The hook signature the tab consumes.
  useBridgeStatus: vi.fn(() => ({
    connected: true, status: bridgeStatusObj, error: null,
    refresh: vi.fn(),
  })),
  getAutelState: vi.fn(() => ({ url: 'http://127.0.0.1:8765' })),
  setAutelState: vi.fn(),
}));
vi.mock('../lib/sgwAuth.js', async () => {
  const actual = await vi.importActual('../lib/sgwAuth.js');
  return {
    ...actual,
    useSgwAuth: () => ({
      authenticated: false, bypassed: false,
      vin: null, expiresAt: null, remainingMs: 0,
    }),
    setSgwAuthenticated: vi.fn(),
    clearSgwAuth: vi.fn(),
    setSgwBypass: vi.fn(),
  };
});
vi.mock('../lib/bridgeEngine.js', () => ({
  createBridgeEngine: vi.fn(async () => ({ ok: false, error: 'no bridge in this test' })),
}));

import AutelSgwTab from '../tabs/AutelSgwTab.jsx';
import { MasterVinProvider } from '../lib/masterVinContext.jsx';
import { bridgeClient } from '../lib/bridgeClient.js';

beforeEach(() => {
  bridgeClient.status.mockClear();
  bridgeClient.open.mockClear();
  bridgeClient.close.mockClear();
});
afterEach(() => cleanup());

describe('AutelSgwTab UI', () => {
  it('renders the AUTEL SGW header with the default bridge URL', () => {
    render(
      <MasterVinProvider setPg={() => {}}>
        <AutelSgwTab />
      </MasterVinProvider>
    );
    expect(screen.getByText(/AUTEL SGW/i)).toBeTruthy();
    expect(screen.getByText(/✓ BRIDGE CONNECTED/i)).toBeTruthy();
    const urlInput = screen.getByPlaceholderText(/127\.0\.0\.1:8765/);
    expect(urlInput.value).toBe('http://127.0.0.1:8765');
  });

  it('AUTHENTICATE SGW is disabled while no Master VIN is set', () => {
    render(
      <MasterVinProvider setPg={() => {}}>
        <AutelSgwTab />
      </MasterVinProvider>
    );
    expect(screen.getByText(/NO VIN LOADED/i)).toBeTruthy();
    const authBtn = screen.getByRole('button', { name: /AUTHENTICATE SGW/i });
    expect(authBtn.disabled).toBe(true);
  });

  it('RUN TEST calls bridgeClient.status and bridgeClient.open and writes to the log', async () => {
    render(
      <MasterVinProvider setPg={() => {}}>
        <AutelSgwTab />
      </MasterVinProvider>
    );

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^RUN TEST$/i })); });

    await waitFor(() => expect(bridgeClient.status).toHaveBeenCalled());
    await waitFor(() => expect(bridgeClient.open).toHaveBeenCalled());
    // Log should now show the OK lines.
    await waitFor(() => expect(screen.getByText(/\[OK\] \/status/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/PassThruOpen/)).toBeTruthy());
  });
});
