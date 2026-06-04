// @vitest-environment jsdom
//
// Smoke + wiring coverage for the dedicated SECURITY SYNC tab.
//
// SecuritySyncTab is a lean, security-only workbench: load BCM + RFHUB + PCM,
// see the SEC16/SEC6 byte-by-byte comparison, and run the GPEC2A immo fix. The
// byte-relationship math (reverse(BCM) → RFH, reverse(BCM)[0:6] → SEC6) is
// already golden-tested in lib; this suite just freezes that the tab mounts,
// renders its empty state, and exposes the comparison + verdict surfaces so a
// future refactor that drops a section is caught.

import React from 'react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

import SecuritySyncTab from '../SecuritySyncTab.jsx';

const FIX = resolve(__dirname, '..', '..', '__tests__', 'fixtures');
const BCM_FILE = 'SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin';
const bcmBytes = () => new Uint8Array(readFileSync(join(FIX, BCM_FILE)));

async function loadInto(role, bytes, name) {
  const input = screen.getByTestId('secsync-input-' + role);
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([bytes], name, { type: 'application/octet-stream' })] } });
  });
}

afterEach(cleanup);

describe('SecuritySyncTab', () => {
  it('mounts and renders the security-only workbench shell', () => {
    render(<SecuritySyncTab />);
    expect(screen.getByTestId('security-sync-tab')).toBeTruthy();
    // three load slots
    expect(screen.getByTestId('secsync-load-bcm')).toBeTruthy();
    expect(screen.getByTestId('secsync-load-rfh')).toBeTruthy();
    expect(screen.getByTestId('secsync-load-pcm')).toBeTruthy();
    // the side-by-side comparison surface + both verdict badges
    expect(screen.getByTestId('secsync-comparison')).toBeTruthy();
    expect(screen.getByTestId('secsync-verdict-rfh')).toBeTruthy();
    expect(screen.getByTestId('secsync-verdict-sec6')).toBeTruthy();
  });

  it('shows the empty-state hint before any dump is loaded', () => {
    render(<SecuritySyncTab />);
    expect(screen.getByText(/Load at least a BCM/i)).toBeTruthy();
    // immo fix is disabled until a PCM is present
    expect(screen.getByText(/Load a PCM .* to enable the immo analyzer/i)).toBeTruthy();
  });
});

describe('SecuritySyncTab — refuse-on-doubt type gating', () => {
  it('accepts a real BCM dump in the BCM slot', async () => {
    render(<SecuritySyncTab />);
    await loadInto('bcm', bcmBytes(), BCM_FILE);
    // No refusal surfaced for the correct slot type.
    expect(screen.queryByTestId('secsync-error')).toBeNull();
  });

  it('refuses a BCM dump dropped into the PCM (GPEC2A) slot', async () => {
    render(<SecuritySyncTab />);
    await loadInto('pcm', bcmBytes(), BCM_FILE);
    await waitFor(() => {
      const e = screen.getByTestId('secsync-error');
      expect(e.textContent).toMatch(/load a PCM \(GPEC2A\) dump/i);
    });
  });

  it('refuses a BCM dump dropped into the RFHUB slot', async () => {
    render(<SecuritySyncTab />);
    await loadInto('rfh', bcmBytes(), BCM_FILE);
    await waitFor(() => {
      const e = screen.getByTestId('secsync-error');
      expect(e.textContent).toMatch(/load an RFHUB dump/i);
    });
  });
});
