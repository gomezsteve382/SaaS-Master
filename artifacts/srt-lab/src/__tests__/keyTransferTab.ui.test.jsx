// @vitest-environment jsdom
/*
 * KeyTransferTab UI test — pins the promotion of the offline Charger RFHUB
 * key-transfer flow to a primary-nav destination, plus the read-only hex viewer:
 *   1. PRIMARY_NAV exposes a 'keyxfer' entry (and its keys are deduplicated, so
 *      the Advanced drawer — which filters out PRIMARY_NAV keys — never shows a
 *      duplicate).
 *   2. The tab lands directly on the empty hex viewer before any file is loaded.
 *   3. After loading a real Charger key table and adding a key, the change
 *      summary renders and the written bytes are highlighted in the hex view.
 */
import React from 'react';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

import KeyTransferTab from '../tabs/KeyTransferTab.jsx';
import { PRIMARY_NAV } from '../components/CommandShell.jsx';
import {
  CHAR_KEYTABLE_BASE,
  CHAR_KEYTABLE_STRIDE,
  keyIdToRevUid,
} from '../lib/charRfhubKeyTable.js';

// Faithful 4 KB Charger RFHUB key table (mirrors the lib golden fixture):
// 8 slots @0xC5E stride 16, slots 1-2 empty, slots 3-8 real keys, and the
// real slot-8 trailing boundary (00 6C, not FF FF).
const REF_KEYS = [
  { keyId: '0077A29B', idx: 0x48 },
  { keyId: 'CC62209F', idx: 0x0F },
  { keyId: '09A6629F', idx: 0x4C },
  { keyId: '91654F9E', idx: 0x19 },
  { keyId: '197E6C9E', idx: 0x5B },
  { keyId: 'C47D6C9E', idx: 0xB0 },
];

function writeSlot(buf, slotIdx, rec6) {
  const off = CHAR_KEYTABLE_BASE + slotIdx * CHAR_KEYTABLE_STRIDE;
  for (let k = 0; k < 6; k++) { buf[off + k] = rec6[k]; buf[off + 8 + k] = rec6[k]; }
  buf[off + 6] = 0xFF; buf[off + 7] = 0xFF;
  buf[off + 14] = 0xFF; buf[off + 15] = 0xFF;
}

function buildRef() {
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

// jsdom's FileReader.readAsArrayBuffer doesn't read Buffer-backed File blobs
// reliably; resolve via the File's own .arrayBuffer() instead.
class StubFileReader {
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

describe('KeyTransferTab — primary nav + hex viewer', () => {
  let originalFR;
  let originalCreateURL;
  let originalRevokeURL;
  beforeEach(() => {
    originalFR = global.FileReader;
    global.FileReader = StubFileReader;
    // CharRfhubKeyAdderPanel triggers a download on add; stub the URL helpers.
    originalCreateURL = URL.createObjectURL;
    originalRevokeURL = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:stub';
    URL.revokeObjectURL = () => {};
  });
  afterEach(() => {
    global.FileReader = originalFR;
    URL.createObjectURL = originalCreateURL;
    URL.revokeObjectURL = originalRevokeURL;
    cleanup();
  });

  it('registers a deduplicated keyxfer entry in the primary nav', () => {
    const keys = PRIMARY_NAV.map(n => n.key);
    expect(keys).toContain('keyxfer');
    // Deduplicated keys => the Advanced drawer (which excludes PRIMARY_NAV keys)
    // can never render a duplicate of this destination.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lands on the empty hex viewer before a file is loaded', () => {
    render(<KeyTransferTab />);
    expect(screen.getByTestId('key-transfer-tab')).toBeTruthy();
    expect(screen.getByTestId('key-table-hex-view')).toBeTruthy();
    expect(screen.getByTestId('key-table-hex-empty')).toBeTruthy();
  });

  it('populates the hex view and highlights bytes written by an add', async () => {
    render(<KeyTransferTab />);
    const file = new File([buildRef()], 'CHARGER_RFHUB.bin', { type: 'application/octet-stream' });
    await uploadInto('char-rfhub-key-adder-file-input', file);

    // Hex view now shows the table region (empty placeholder gone).
    expect(screen.queryByTestId('key-table-hex-empty')).toBeNull();
    expect(screen.getByTestId('hexrow-0x0C50')).toBeTruthy();

    // Add a fresh key with an explicit non-colliding index.
    fireEvent.change(screen.getByTestId('char-key-id-input'), { target: { value: 'BCD2EB9B' } });
    fireEvent.change(screen.getByTestId('char-key-index-input'), { target: { value: '22' } });
    fireEvent.click(screen.getByTestId('char-key-ack'));
    await act(async () => { fireEvent.click(screen.getByTestId('char-key-add-btn')); });
    await act(async () => { await Promise.resolve(); });

    // Change summary + at least one highlighted (changed) byte.
    expect(screen.getByTestId('key-transfer-change-summary')).toBeTruthy();
    const changed = document.querySelectorAll('[data-testid^="hexbyte-changed-0x"]');
    expect(changed.length).toBeGreaterThan(0);
  });
});
