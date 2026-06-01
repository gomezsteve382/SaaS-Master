// @vitest-environment jsdom
/* ============================================================================
 * KeyWriterTab.keydump.ui.test.jsx — Task #987 click-through for the
 * standalone Key Dump capture card (the `key-dump-*` surface added in
 * Task #985), mirroring the burn-pipeline coverage in
 * KeyWriterTab.ui.test.jsx.
 *
 * The library helpers (validateKeyRecord / cloneKeyRecord / writeKeyRecordToSlot)
 * already have unit coverage in src/lib/__tests__/keyDump.test.js — this test
 * walks the actual React card to catch wiring regressions between the inputs,
 * the refuse-on-doubt gates, and the clone / export / write buttons.
 *
 * parseKeySlots is mocked so we don't need a real RFHUB binary fixture for the
 * slot/SEC16 shape the card reads. writeKeyRecordToSlot + firstFreeSlot are
 * kept REAL (via importActual) so the "Write UID into RFHUB" path exercises the
 * genuine refuse-on-doubt buffer writer — which is why the loaded dump below is
 * a real 4 KB Gen2 image carrying the AA 55 31 01 header @ 0x0500.
 * ========================================================================== */

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

vi.mock('../../lib/rfhubKeySlots.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    // Override only the parser so the card sees a healthy Gen2 RFHUB with one
    // occupied/mapped slot and a non-blank (0xAA*16) SEC16 master — every other
    // export (writeKeyRecordToSlot, firstFreeSlot, KEY_ID_BLOCK_LEN) stays real.
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
          idOffset: 0x888,
          idBytes: new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]),
        },
        {
          idx: 1,
          occupied: false,
          idMapped: false,
          idOffset: 0x890,
          idBytes: null,
        },
      ],
    }),
  };
});

import KeyWriterTab from '../KeyWriterTab.jsx';

// jsdom's FileReader doesn't reliably read Buffer-backed File blobs; mirror the
// shim used by the sibling burn-pipeline test.
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

// Real 4 KB Gen2 RFHUB image: just the AA 55 31 01 header @ 0x0500 that the
// genuine writeKeyRecordToSlot/checkRfhub refuse-on-doubt gate requires. The
// AA-50 marker table @ 0x0880 is left zeroed so every slot reads as free.
function makeGen2RfhBuffer() {
  const b = new Uint8Array(4096);
  b[0x0500] = 0xAA; b[0x0501] = 0x55; b[0x0502] = 0x31; b[0x0503] = 0x01;
  return b;
}

// Real Gen2 ID-block layout (rfhubKeySlots.js): AA-50 marker @ 0x0880 stride 2,
// per-slot 8-byte ID block @ 0x0888 stride 8. Slot 0 → marker 0x0880, id 0x0888.
const SLOT0_MARKER_OFF = 0x0880;
const SLOT0_ID_OFF = 0x0888;

describe('KeyWriterTab Key Dump card UI (Task #987)', () => {
  let originalFR;
  let originalCreate;
  let originalRevoke;
  let createSpy;
  let revokeSpy;
  beforeEach(() => {
    originalFR = globalThis.FileReader;
    globalThis.FileReader = StubFileReader;
    // jsdom lacks URL.createObjectURL — triggerDownload needs it.
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    createSpy = vi.fn(() => 'blob:stub');
    revokeSpy = vi.fn();
    URL.createObjectURL = createSpy;
    URL.revokeObjectURL = revokeSpy;
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch { /* ignore */ }
  });
  afterEach(() => {
    cleanup();
    globalThis.FileReader = originalFR;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch { /* ignore */ }
  });

  it('gates export/write on validity, then writes a patched RFHUB buffer', async () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);

    // The standalone Key Dump card is present.
    expect(screen.getByTestId('key-dump-card')).toBeTruthy();

    // Refuse-on-doubt: an empty record (no UID/SK) leaves every output disabled.
    expect(screen.getByTestId('key-dump-export-json').disabled).toBe(true);
    expect(screen.getByTestId('key-dump-export-bin').disabled).toBe(true);
    expect(screen.getByTestId('key-dump-write-rfhub').disabled).toBe(true);
    expect(screen.getByTestId('key-dump-validation').textContent || '').toMatch(/✗/);

    // Fill the fields: chip family, UID (4 B), SK (6 B), label + a flag.
    await act(async () => {
      fireEvent.change(screen.getByTestId('key-dump-chip'), { target: { value: 'pcf7953' } });
      fireEvent.change(screen.getByTestId('key-dump-label'), { target: { value: 'spare fob' } });
      fireEvent.change(screen.getByTestId('key-dump-uid'), { target: { value: '00 77 A2 9B' } });
      fireEvent.change(screen.getByTestId('key-dump-sk'), { target: { value: '4F 4E 4D 49 4B 52' } });
      fireEvent.click(screen.getByTestId('key-dump-flag-locked'));
    });

    // Now the record validates → JSON/bin export enable.
    await waitFor(() => {
      expect(screen.getByTestId('key-dump-validation').textContent || '').toMatch(/Valid/);
      expect(screen.getByTestId('key-dump-export-json').disabled).toBe(false);
      expect(screen.getByTestId('key-dump-export-bin').disabled).toBe(false);
    });

    // ...but Write-to-RFHUB is still gated: no dump is loaded yet.
    expect(screen.getByTestId('key-dump-write-rfhub').disabled).toBe(true);

    // A bad UID re-trips the refuse-on-doubt gate (odd nibble count).
    await act(async () => {
      fireEvent.change(screen.getByTestId('key-dump-uid'), { target: { value: 'XYZ' } });
    });
    await waitFor(() => {
      expect(screen.getByTestId('key-dump-export-json').disabled).toBe(true);
      expect(screen.getByTestId('key-dump-validation').textContent || '').toMatch(/✗/);
    });
    // Restore a valid UID.
    await act(async () => {
      fireEvent.change(screen.getByTestId('key-dump-uid'), { target: { value: '00 77 A2 9B' } });
    });
    await waitFor(() => expect(screen.getByTestId('key-dump-export-json').disabled).toBe(false));

    // Load a real Gen2 RFHUB image (header @ 0x0500); slot 0 auto-selects and
    // SEC16 is non-blank, so the clone-on-bench writer unlocks.
    await uploadInto('kwriter-load-rfh', new File([makeGen2RfhBuffer()], 'rfh.bin', { type: 'application/octet-stream' }));
    await waitFor(() => expect(screen.queryByTestId('kwriter-slot-0')).not.toBeNull());

    const writeBtn = screen.getByTestId('key-dump-write-rfhub');
    await waitFor(() => expect(writeBtn.disabled).toBe(false));

    await act(async () => { fireEvent.click(writeBtn); });

    // Success row names the patched slot (1-based) ...
    await waitFor(() => {
      const res = screen.getByTestId('key-dump-clone-result');
      expect(res.textContent || '').toMatch(/UID written into slot 1/);
    });

    // ...and a patched 4 KB buffer was handed to the download helper, with the
    // captured UID actually stamped into slot 0's ID block and the AA-50
    // occupancy marker flipped on.
    expect(createSpy).toHaveBeenCalled();
    const blobArg = createSpy.mock.calls.at(-1)[0];
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.size).toBe(4096);
    const patched = new Uint8Array(await blobArg.arrayBuffer());
    // UID 00 77 A2 9B written at the Gen2 slot-0 ID block.
    expect([...patched.slice(SLOT0_ID_OFF, SLOT0_ID_OFF + 4)]).toEqual([0x00, 0x77, 0xA2, 0x9B]);
    // Occupancy marker set to AA 50.
    expect([...patched.slice(SLOT0_MARKER_OFF, SLOT0_MARKER_OFF + 2)]).toEqual([0xAA, 0x50]);
  });

  it('"Copy to new key" mints a fresh record with a "(copy)" label', async () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);

    // Only one record tab to start.
    expect(screen.getByTestId('key-dump-tab-0')).toBeTruthy();
    expect(screen.queryByTestId('key-dump-tab-1')).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByTestId('key-dump-label'), { target: { value: 'spare fob' } });
      fireEvent.change(screen.getByTestId('key-dump-uid'), { target: { value: '00 77 A2 9B' } });
      fireEvent.change(screen.getByTestId('key-dump-sk'), { target: { value: '4F 4E 4D 49 4B 52' } });
    });

    await act(async () => { fireEvent.click(screen.getByTestId('key-dump-copy')); });

    // A second record now exists and is active, labelled with the "(copy)" hint.
    await waitFor(() => expect(screen.queryByTestId('key-dump-tab-1')).not.toBeNull());
    expect(screen.getByTestId('key-dump-tab-1').textContent || '').toMatch(/spare fob \(copy\)/);
    // The copy carried over UID/SK (and stays valid) and the label field shows
    // the cloned, editable name.
    expect(screen.getByTestId('key-dump-label').value).toBe('spare fob (copy)');
    expect(screen.getByTestId('key-dump-uid').value.replace(/\s/g, '')).toBe('0077A29B');
    expect(screen.getByTestId('key-dump-validation').textContent || '').toMatch(/Valid/);
  });
});
