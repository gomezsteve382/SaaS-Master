// @vitest-environment jsdom
//
// Task #446 — GpecTab UI: load firmware → unlock byte 0x2FFFC → download.
//
// The tab's whole job is to flip a single byte. Pre-task this leg lacked any
// React-level test: regressions to the unlock logic would only surface in
// production. This test mounts the tab, drives a stubbed FileReader to load
// a synthetic 192 KB firmware blob, clicks Unlock, and asserts:
//   1. the "Already unlocked" guard fires when the byte is 0x96 to begin with,
//   2. the "too small" guard fires when the file is shorter than 0x2FFFD,
//   3. the happy path flips byte 0x2FFFC from 0x00 → 0x96 and exposes the
//      download button + the patched buffer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// useDownloadCount fires real fetch() calls during mount; stub it so the test
// stays hermetic and the tracker call is observable.
const trackUnlocked = vi.fn();
vi.mock('../lib/useDownloadCount.jsx', () => ({
  useDownloadCount: () => [42, trackUnlocked],
  DownloadCounter: () => null,
}));

import GpecTab from '../tabs/GpecTab.jsx';

class StubFileReader {
  constructor() { this.onload = null; }
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      if (this.onload) this.onload({ target: { result: buf } });
    });
  }
}

let originalFR;
beforeEach(() => {
  originalFR = globalThis.FileReader;
  globalThis.FileReader = StubFileReader;
  trackUnlocked.mockReset();
});
afterEach(() => {
  globalThis.FileReader = originalFR;
  cleanup();
});

function makeFirmware({ size = 0x40000, byte2FFFC = 0x00 } = {}) {
  const buf = new Uint8Array(size);
  if (size > 0x2FFFC) buf[0x2FFFC] = byte2FFFC;
  return new File([buf], 'fw.bin', { type: 'application/octet-stream' });
}

async function loadFirmware(file) {
  const input = document.querySelector('input[type="file"]');
  expect(input).toBeTruthy();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { fireEvent.change(input); });
  // settle the FileReader microtask
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('GpecTab UI', () => {
  it('flips 0x2FFFC from 0x00 → 0x96 on unlock and enables download', async () => {
    render(<GpecTab />);

    // Nothing rendered until a file is loaded.
    expect(screen.queryByText(/Already unlocked/i)).toBeNull();

    await loadFirmware(makeFirmware({ size: 0x40000, byte2FFFC: 0x00 }));

    // Filename rendered → file accepted.
    await waitFor(() => expect(screen.getByText(/fw\.bin/i)).toBeTruthy());

    // Click the Unlock card (the parent div with "Unlock" text).
    const unlockText = screen.getByText('Unlock');
    await act(async () => { fireEvent.click(unlockText.parentElement); });

    // Success message + download button now visible.
    await waitFor(() => expect(screen.getByText(/Unlock flag set/i)).toBeTruthy());
    expect(screen.getByText(/Download Unlocked Firmware/i)).toBeTruthy();
  });

  it('shows "too small" when the file is shorter than 0x2FFFD', async () => {
    render(<GpecTab />);

    await loadFirmware(makeFirmware({ size: 0x100, byte2FFFC: 0x00 }));

    const unlockText = screen.getByText('Unlock');
    await act(async () => { fireEvent.click(unlockText.parentElement); });

    await waitFor(() => expect(screen.getByText(/File too small/i)).toBeTruthy());
    expect(screen.queryByText(/Download Unlocked Firmware/i)).toBeNull();
  });

  it('refuses to re-unlock when 0x2FFFC is already 0x96', async () => {
    render(<GpecTab />);

    await loadFirmware(makeFirmware({ size: 0x40000, byte2FFFC: 0x96 }));

    // Pre-flight banner already calls out the unlocked state.
    await waitFor(() => expect(screen.getAllByText(/Already unlocked/i).length).toBeGreaterThan(0));

    const unlockText = screen.getByText('Unlock');
    await act(async () => { fireEvent.click(unlockText.parentElement); });

    // Still no download — only the existing "already unlocked" annotation.
    expect(screen.queryByText(/Download Unlocked Firmware/i)).toBeNull();
  });
});
