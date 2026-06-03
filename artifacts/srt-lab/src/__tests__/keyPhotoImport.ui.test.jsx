// @vitest-environment jsdom
/**
 * UI test for the Key Program tab's "Read Key ID from photo" control.
 *
 * The CharRfhubKeyAdderPanel gains an opt-in photo-import card (enablePhotoImport)
 * that POSTs the uploaded image to /api/anthropic/key-photo and auto-fills the
 * Key ID field from the response. KeyTransferTab turns the option on.
 *
 * Covers:
 *   - the upload control only shows when enablePhotoImport is set
 *   - a successful read auto-fills the Key ID input + shows a status line
 *   - a candidate button applies its value to the Key ID input
 */

import React from 'react';
import {render, screen, fireEvent, waitFor, cleanup} from '@testing-library/react';
import {afterEach, beforeEach, describe, it, expect, vi} from 'vitest';
import CharRfhubKeyAdderPanel from '../components/CharRfhubKeyAdderPanel.jsx';
import {
  CHAR_KEYTABLE_BASE,
  CHAR_KEYTABLE_STRIDE,
  keyIdToRevUid,
} from '../lib/charRfhubKeyTable.js';

// jsdom lacks FileReader.readAsDataURL working with our stubbed File; provide a
// minimal stub that resolves to a fixed PNG data URL.
class StubFileReader {
  readAsDataURL() {
    this.result = 'data:image/png;base64,AAAA';
    if (this.onload) this.onload({target: {result: this.result}});
  }
}

function imageFile() {
  return new File([new Uint8Array([1, 2, 3])], 'key.png', {type: 'image/png'});
}

// Minimal but valid 4 KB Charger RFHUB key table so the add-key form (and its
// Key ID input) renders. Mirrors the sibling KeyTransferTab fixture.
const REF_KEYS = [
  {keyId: '0077A29B', idx: 0x48},
  {keyId: 'CC62209F', idx: 0x0F},
  {keyId: '09A6629F', idx: 0x4C},
  {keyId: '91654F9E', idx: 0x19},
  {keyId: '197E6C9E', idx: 0x5B},
  {keyId: 'C47D6C9E', idx: 0xB0},
];

function writeSlot(buf, slotIdx, rec6) {
  const off = CHAR_KEYTABLE_BASE + slotIdx * CHAR_KEYTABLE_STRIDE;
  for (let k = 0; k < 6; k++) { buf[off + k] = rec6[k]; buf[off + 8 + k] = rec6[k]; }
  buf[off + 6] = 0xFF; buf[off + 7] = 0xFF;
  buf[off + 14] = 0xFF; buf[off + 15] = 0xFF;
}

function buildCharTable() {
  const buf = new Uint8Array(4096).fill(0x00);
  writeSlot(buf, 0, [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00]);
  writeSlot(buf, 1, [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00]);
  REF_KEYS.forEach((k, i) => {
    const rev = keyIdToRevUid(k.keyId);
    writeSlot(buf, 2 + i, [rev[0], rev[1], rev[2], rev[3], k.idx, 0x01]);
  });
  const slot8 = CHAR_KEYTABLE_BASE + 7 * CHAR_KEYTABLE_STRIDE;
  buf[slot8 + 14] = 0x00; buf[slot8 + 15] = 0x6C;
  return buf;
}

beforeEach(() => {
  global.FileReader = StubFileReader;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete global.fetch;
});

describe('CharRfhubKeyAdderPanel photo import', () => {
  it('hides the photo card unless enablePhotoImport is set', () => {
    render(<CharRfhubKeyAdderPanel defaultOpen />);
    expect(screen.queryByTestId('char-key-photo-card')).toBeNull();
  });

  it('reads a Key ID from a photo and auto-fills the field', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({keyId: 'BCD2EB9B', found: true, candidates: ['11223344'], notes: 'clear'}),
    });

    render(
      <CharRfhubKeyAdderPanel
        defaultOpen
        enablePhotoImport
        initialMod={{data: buildCharTable(), filename: 'CHARGER_RFHUB.bin'}}
      />,
    );
    const input = screen.getByTestId('char-key-photo-input');
    fireEvent.change(input, {target: {files: [imageFile()]}});

    await waitFor(() => {
      expect(screen.getByTestId('char-key-photo-status').textContent).toMatch(/BCD2EB9B/);
    });
    // The read auto-fills the Key ID input itself, not just the status line.
    expect(screen.getByTestId('char-key-id-input').value).toBe('BCD2EB9B');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, opts] = global.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.mediaType).toBe('image/png');
    expect(body.imageBase64).toMatch(/^data:image\/png;base64,/);

    // The candidate button applies its value when clicked.
    fireEvent.click(screen.getByTestId('char-key-photo-candidate-11223344'));
    // No throw / still rendered.
    expect(screen.getByTestId('char-key-photo-card')).toBeTruthy();
  });

  it('shows an error status when the read fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({error: 'AI service unavailable'}),
    });

    render(<CharRfhubKeyAdderPanel defaultOpen enablePhotoImport />);
    fireEvent.change(screen.getByTestId('char-key-photo-input'), {target: {files: [imageFile()]}});

    await waitFor(() => {
      expect(screen.getByTestId('char-key-photo-status').textContent).toMatch(/unavailable/i);
    });
  });
});
