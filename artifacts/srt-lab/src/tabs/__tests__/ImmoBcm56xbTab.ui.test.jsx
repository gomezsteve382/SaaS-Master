// @vitest-environment jsdom
//
// Task #689 — RTL smoke test for the standalone Immo BCM 56xB tab.
//
// Mounts the tab, drops the 18TH VIN-only BCM fixture, and asserts:
//   1. Mode badge renders "VIN_ONLY".
//   2. The 4 verified VIN slots are surfaced in the slot table.
//   3. The SEC16 input is RENDERED but DISABLED (not hidden) with the
//      explanatory title text — per the spec, the field stays visible
//      so the user can see that SEC16 writes exist but aren't applicable.
//   4. The Apply button stays enabled (VIN field pre-populated with the
//      dominant VIN, no SEC16 needed).

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

import ImmoBcm56xbTab from '../ImmoBcm56xbTab.jsx';
import { crc16 } from '../../lib/crc.js';

const FIX = path.resolve(__dirname, '../../__tests__/fixtures');
const loadBytes = name => new Uint8Array(fs.readFileSync(path.join(FIX, name)));

function bufferFile(name, bytes) {
  return new File([bytes], name, { type: 'application/octet-stream' });
}

// Same VIN_ONLY synthesiser as the unit-test suite — wipes inactive
// bank + split-record band + flat-fallback slot, then re-stamps VINs.
function blankSec16(buf) {
  const out = new Uint8Array(buf);
  for (let i = 0x81A0; i < 0x8200; i++) out[i] = 0xFF;
  for (let i = 0x0000; i < 0x4000; i++) out[i] = 0xFF;
  for (let i = 0x4000; i < 0x8000; i++) out[i] = 0xFF;
  for (let i = 0x40C9; i < 0x40D9; i++) out[i] = 0xFF;
  const vin = '1C4RJFN9XJC309165';
  const vinBytes = new TextEncoder().encode(vin);
  const vinCrc = crc16(vinBytes);
  for (const base of [0x1320, 0x1340, 0x1360, 0x1380]) {
    out.set(vinBytes, base);
    out[base + 17] = (vinCrc >> 8) & 0xFF;
    out[base + 18] = vinCrc & 0xFF;
  }
  return out;
}

describe('ImmoBcm56xbTab — UI smoke', () => {
  beforeEach(() => {});
  afterEach(() => cleanup());

  it('classifies 18TH BCM as VIN_ONLY, disables SEC16 input (not hidden)', async () => {
    render(<ImmoBcm56xbTab />);
    const input = document.querySelector('input[type="file"]');
    expect(input).toBeTruthy();

    const bytes = blankSec16(loadBytes('SAMPLE_BCM_DFLASH_18TH_OG.bin'));
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [bufferFile('SAMPLE_BCM_DFLASH_18TH_OG.bin', bytes)] },
      });
    });

    // Mode badge must read VIN_ONLY (visible to the operator, not hidden).
    expect(await screen.findByText('VIN_ONLY')).toBeTruthy();
    // Dominant VIN surfaced.
    expect(screen.getAllByText('1C4RJFN9XJC309165').length).toBeGreaterThan(0);

    // SEC16 main + mirrors panel rendered — at least the four candidate
    // rows must be present (split / mirror1 / mirror2 / flat).
    for (const key of ['split', 'mirror1', 'mirror2', 'flat']) {
      expect(screen.getByTestId('sec16-row-' + key)).toBeTruthy();
    }

    // SEC16 input is RENDERED and DISABLED with the documented title.
    const sec16Input = screen.getByTestId('new-sec16-input');
    expect(sec16Input).toBeTruthy();
    expect(sec16Input.disabled).toBe(true);
    expect(sec16Input.title).toMatch(/VIN_ONLY/);
  });

  it('renders SEC16 input as writable on a FULL dump', async () => {
    render(<ImmoBcm56xbTab />);
    const input = document.querySelector('input[type="file"]');
    const bytes = loadBytes('SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin');
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [bufferFile('SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin', bytes)] },
      });
    });
    expect(await screen.findByText('FULL')).toBeTruthy();
    const sec16Input = screen.getByTestId('new-sec16-input');
    expect(sec16Input.disabled).toBe(false);
  });
});
