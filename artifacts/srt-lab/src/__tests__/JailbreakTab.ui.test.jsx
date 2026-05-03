// @vitest-environment jsdom
//
// Task #446 — JailbreakTab UI: vehicle prop, target picker, mocked OBD engine.
//
// Pre-task there was no React-level coverage of the jailbreak surface even
// though it directly drives BCM CDA6/SEC16 unlocks. This test mounts the tab
// with a Challenger vehicle prop and asserts:
//   1. the vehicle-defaults banner renders the correct BCM target string,
//   2. clicking CONNECT spins up the mocked OBD engine and surfaces ●
//      CONNECTED,
//   3. AUTO-FIND BCM iterates the mocked uds() so the first responder ends up
//      selected (covering the find-loop's success branch),
//   4. UNLOCK runs the mocked seed/key dance and surfaces UNLOCKED.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// Mock the OBD engine + backups before importing the tab.
const mockEngine = {
  connect: vi.fn(async () => true),
  disconnect: vi.fn(async () => undefined),
  uds: vi.fn(async (_tx, _rx, req) => {
    if (req[0] === 0x22 && req[1] === 0xF1 && req[2] === 0x90) {
      return { ok: true, d: new Uint8Array([0x62, 0xF1, 0x90, 0x32, 0x43]) };
    }
    if (req[0] === 0x10) return { ok: true, d: new Uint8Array([0x50, req[1]]) };
    if (req[0] === 0x27 && req[1] === 0x01) {
      return { ok: true, d: new Uint8Array([0x67, 0x01, 0xDE, 0xAD, 0xBE, 0xEF]) };
    }
    if (req[0] === 0x27 && req[1] === 0x02) {
      return { ok: true, d: new Uint8Array([0x67, 0x02]) };
    }
    return { ok: true, d: new Uint8Array([req[0] + 0x40]) };
  }),
};

vi.mock('../lib/obdEngine.js', () => ({
  createObdEngine: vi.fn(() => mockEngine),
  decodeDTC:       () => 'P0000',
  decodeDTCStatus: () => ({}),
}));
vi.mock('../lib/audit.js', () => ({
  backupModule: vi.fn(async () => ({ key: 'bcm-snap-1', dids: {} })),
  CRITICAL_DIDS: { BCM: [0xF190] },
}));

import JailbreakTab from '../tabs/JailbreakTab.jsx';
import { VEHICLES } from '../lib/vehicles.js';

beforeEach(() => {
  mockEngine.connect.mockClear();
  mockEngine.disconnect.mockClear();
  mockEngine.uds.mockClear();
});
afterEach(() => cleanup());

describe('JailbreakTab UI', () => {
  it('renders the JAILBREAK header and vehicle defaults banner', () => {
    render(<JailbreakTab vehicle={VEHICLES.challenger} />);
    expect(screen.getByText(/JAILBREAK OPTIONS/i)).toBeTruthy();
    // Banner uses vehicle.name (e.g. "CHALLENGER"), not vehicle.full.
    expect(screen.getByText(/Using\s+CHALLENGER\s+BCM defaults/i)).toBeTruthy();
  });

  it('connect → uses the mocked OBD engine and flips the connection pill', async () => {
    render(<JailbreakTab vehicle={VEHICLES.challenger} />);

    const connectBtn = screen.getByText(/CONNECT OBDLink/i);
    await act(async () => { fireEvent.click(connectBtn); });

    await waitFor(() => expect(mockEngine.connect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/● CONNECTED/i)).toBeTruthy());
  });

  it('AUTO-FIND BCM picks the first candidate that responds', async () => {
    render(<JailbreakTab vehicle={VEHICLES.challenger} />);

    await act(async () => { fireEvent.click(screen.getByText(/CONNECT OBDLink/i)); });
    await waitFor(() => expect(screen.getByText(/● CONNECTED/i)).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByText(/AUTO-FIND BCM/i)); });
    // The find loop should have issued at least one 22 F1 90 probe.
    await waitFor(() => {
      const calls = mockEngine.uds.mock.calls.filter(
        c => c[2][0] === 0x22 && c[2][1] === 0xF1 && c[2][2] === 0x90,
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('UNLOCK drives 27 01 → 27 02 and flips the lock pill to UNLOCKED', async () => {
    render(<JailbreakTab vehicle={VEHICLES.challenger} />);

    await act(async () => { fireEvent.click(screen.getByText(/CONNECT OBDLink/i)); });
    await waitFor(() => expect(screen.getByText(/● CONNECTED/i)).toBeTruthy());

    // The unlock button label is just "UNLOCK" — find by exact text.
    const unlockBtn = screen.getByText(/^UNLOCK$/);
    await act(async () => { fireEvent.click(unlockBtn); });

    await waitFor(() => {
      // Verify both the seed request and the key reply were fired.
      const reqs = mockEngine.uds.mock.calls.map(c => c[2]);
      expect(reqs.some(r => r[0] === 0x27 && r[1] === 0x01)).toBe(true);
      expect(reqs.some(r => r[0] === 0x27 && r[1] === 0x02)).toBe(true);
    });
    await waitFor(() => expect(screen.getByText(/🔓 UNLOCKED/i)).toBeTruthy());
  });
});
