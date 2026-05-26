// @vitest-environment jsdom
/* ============================================================================
 * KeyWriterTab.ui.test.jsx — Task #862 smoke test.
 *
 * Drives the whole tab through the React DOM:
 *   1. Mount with a stub onOpenTab so the handoff button is observable.
 *   2. Mock parseKeySlots so we don't need a real RFHUB binary fixture
 *      (parser coverage lives elsewhere — this test is about the UI
 *      gating + transport wiring).
 *   3. Pick a slot, leave Simulator + happy profile selected, click Burn.
 *   4. Assert KEYMOD WRITTEN log line + green CTA.
 *   5. Click "Open RFHUB tab" — assert onOpenTab('rfhub') fired and the
 *      sessionStorage handoff record was written with the slot we picked.
 * ========================================================================== */

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

vi.mock('../../lib/rfhubKeySlots.js', () => ({
  KEY_ID_BLOCK_LEN: 8,
  parseKeySlots: () => ({
    ok: true,
    gen: 2,
    sec16: {
      match: true,
      slots: [
        { raw: new Uint8Array(16).fill(0xAA) },
        { raw: new Uint8Array(16).fill(0xAA) },
      ],
    },
    slots: [
      {
        idx: 0,
        occupied: true,
        idMapped: true,
        idOffset: 0x100,
        idBytes: new Uint8Array([0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88]),
      },
      {
        idx: 1,
        occupied: false,
        idMapped: false,
        idOffset: 0x120,
        idBytes: null,
      },
    ],
  }),
}));

import KeyWriterTab from '../KeyWriterTab.jsx';

// jsdom's FileReader doesn't reliably read Buffer-backed File blobs; mirror the
// shim used by KeyProgTab's UI test.
class StubFileReader {
  constructor() { this.onload = null; }
  readAsArrayBuffer(file) {
    file.arrayBuffer().then((buf) => {
      this.result = buf;
      if (this.onload) this.onload({ target: { result: buf } });
    });
  }
}

async function uploadInto(testId, file) {
  const input = screen.getByTestId(testId);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { fireEvent.change(input); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('KeyWriterTab UI (Task #862)', () => {
  let originalFR;
  beforeEach(() => {
    originalFR = globalThis.FileReader;
    globalThis.FileReader = StubFileReader;
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    globalThis.FileReader = originalFR;
    sessionStorage.clear();
  });

  it('walks load -> pick slot -> burn -> handoff CTA -> sessionStorage record', async () => {
    const onOpenTab = vi.fn();
    render(<KeyWriterTab onOpenTab={onOpenTab} />);

    // Burn is disabled before any dump is loaded.
    expect(screen.getByTestId('kwriter-burn').disabled).toBe(true);

    // Load a stub RFHUB dump (bytes don't matter — parseKeySlots is mocked).
    const file = new File([new Uint8Array(4096)], 'rfh.bin', { type: 'application/octet-stream' });
    await uploadInto('kwriter-load-rfh', file);

    // Slot 0 is auto-selected because it's the first occupied slot.
    await waitFor(() => expect(screen.queryByTestId('kwriter-slot-0')).not.toBeNull());

    // Default Simulator + happy profile, default chip pcf7953 (8 B), writer vvdi-mini.
    // Burn should now be enabled.
    const burnBtn = screen.getByTestId('kwriter-burn');
    await waitFor(() => expect(burnBtn.disabled).toBe(false));

    await act(async () => { fireEvent.click(burnBtn); });

    // Burn pipeline + simulator latency settle.
    await waitFor(() => {
      const log = screen.getByTestId('kwriter-log').textContent || '';
      expect(log).toMatch(/KEYMOD WRITTEN/);
    }, { timeout: 4000 });

    // Handoff CTA appears.
    const cta = await screen.findByTestId('kwriter-open-rfhub');
    await act(async () => { fireEvent.click(cta); });
    expect(onOpenTab).toHaveBeenCalledWith('rfhub');

    // sessionStorage record carries the slot the operator burned.
    const raw = sessionStorage.getItem('srtlab:keywriter:handoff');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.slotIdx).toBe(0);
    expect(parsed.chipId).toBe('pcf7953');
    expect(parsed.writerId).toBe('vvdi-mini');
  });
});
