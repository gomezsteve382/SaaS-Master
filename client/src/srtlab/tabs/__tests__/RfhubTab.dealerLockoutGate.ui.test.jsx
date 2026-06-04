// @vitest-environment jsdom
//
// Task #636 — Lock in the dealer lockout bypass safety gate.
//
// DealerLockoutBypassCard (RfhubTab.jsx) drives a 5-step alt-level
// security-access routine. Because firing it against the wrong module
// could brick a customer RFHUB, the Run button is gated on:
//   (a) the standard 0x27 0x01 unlock having returned NRC 0x36 or 0x37
//       (recorded into the parent's `lockoutNrc` state), AND
//   (b) the inspector showing an XC2268 internal-flash dump
//       (`moduleHint.type === 'XC2268_RFHUB'`).
// A "Bench override" checkbox is the explicit opt-out. A regression
// that re-enables the button without these signals would be silent at
// runtime — this suite freezes the gating matrix in tests.

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { DealerLockoutBypassCard } from '../RfhubTab.jsx';

function baseProps(overrides = {}) {
  return {
    conn: { id: 'test-conn' },
    addr: { tx: 0x764, rx: 0x76C, name: 'RFHUB' },
    eng: { current: { uds: vi.fn() } },
    addLog: vi.fn(),
    busy: '',
    setBusy: vi.fn(),
    lockoutNrc: null,
    onCleared: vi.fn(),
    moduleHint: null,
    ...overrides,
  };
}

function getRunButton() {
  return screen.getByRole('button', { name: /Run Bypass/i });
}

describe('DealerLockoutBypassCard — safety gate', () => {
  afterEach(() => cleanup());

  it('is disabled when neither lockout NRC nor inspector hint is present', () => {
    render(<DealerLockoutBypassCard {...baseProps()} />);
    expect(getRunButton().disabled).toBe(true);
  });

  it('stays disabled when only a lockout NRC was observed (no inspector hint, no override)', () => {
    render(<DealerLockoutBypassCard {...baseProps({ lockoutNrc: 0x36 })} />);
    expect(getRunButton().disabled).toBe(true);

    cleanup();
    render(<DealerLockoutBypassCard {...baseProps({ lockoutNrc: 0x37 })} />);
    expect(getRunButton().disabled).toBe(true);
  });

  it('stays disabled when only the inspector hint is present (no lockout evidence)', () => {
    render(<DealerLockoutBypassCard {...baseProps({ moduleHint: { type: 'XC2268_RFHUB' } })} />);
    expect(getRunButton().disabled).toBe(true);
  });

  it('enables Run when lockout NRC AND XC2268 inspector hint are both present', () => {
    render(<DealerLockoutBypassCard {...baseProps({
      lockoutNrc: 0x36,
      moduleHint: { type: 'XC2268_RFHUB' },
    })} />);
    expect(getRunButton().disabled).toBe(false);
  });

  it('enables Run when bench override is checked, even without lockout or hint', () => {
    render(<DealerLockoutBypassCard {...baseProps()} />);
    expect(getRunButton().disabled).toBe(true);
    const override = screen.getByLabelText(/Bench override/i);
    fireEvent.click(override);
    expect(getRunButton().disabled).toBe(false);
  });

  it('gates the Run button again after onCleared resets the lockout state (post-clear)', () => {
    const { rerender } = render(<DealerLockoutBypassCard {...baseProps({
      lockoutNrc: 0x36,
      moduleHint: { type: 'XC2268_RFHUB' },
    })} />);
    expect(getRunButton().disabled).toBe(false);

    // Simulate the parent clearing lockoutNrc after a successful bypass
    // (RfhubTab does `onCleared={()=>setLockoutNrc(null)}`).
    rerender(<DealerLockoutBypassCard {...baseProps({
      lockoutNrc: null,
      moduleHint: { type: 'XC2268_RFHUB' },
    })} />);
    expect(getRunButton().disabled).toBe(true);
  });

  it('is disabled when there is no live connection, even with both signals', () => {
    render(<DealerLockoutBypassCard {...baseProps({
      conn: null,
      lockoutNrc: 0x36,
      moduleHint: { type: 'XC2268_RFHUB' },
    })} />);
    expect(getRunButton().disabled).toBe(true);
  });

  it('is disabled while a busy operation is in flight', () => {
    render(<DealerLockoutBypassCard {...baseProps({
      busy: 'Reading VIN…',
      lockoutNrc: 0x36,
      moduleHint: { type: 'XC2268_RFHUB' },
    })} />);
    expect(getRunButton().disabled).toBe(true);
  });
});
