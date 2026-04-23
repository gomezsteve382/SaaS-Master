// @vitest-environment jsdom
/* Task #392 — the SAVED ARCHIVES card on the Key Prog tab must render the
 * BCM SEC16 source line for every saved archive (split / mirror1 / mirror2
 * / flat / virgin), so a locksmith scanning past sessions can see how the
 * shared secret was derived without re-opening each ZIP.
 *
 * This covers the three resolver outcomes called out in the task:
 *   - split  (live SEC16 read from 0x81A0/0x81C0/0x81E0)
 *   - flat   (legacy 0x40C9 fallback)
 *   - virgin (every candidate is 0xFF — BLANK badge appears)
 */
import React from 'react';
import { describe, it, afterEach, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { KeyProgSavedArchivesCard } from '../tabs/KeyProgTab.jsx';
import { formatBcmSec16Provenance } from '../lib/keyProgWizard.js';

function snap(prov) {
  if (!prov) return null;
  return {
    source: prov.source ?? null,
    label: prov.label,
    blank: !!prov.blank,
    offsetHex: prov.offsetHex ?? null,
    beHex: prov.beHex ?? null,
  };
}

const splitArchive = {
  id: 'kpa_split',
  vin: '2C3CDXCT1HH652640',
  zipName: 'KEYPROG_2C3CDXCT1HH652640.zip',
  savedAt: '2026-04-23T10:00:00.000Z',
  bcmSec16: snap(formatBcmSec16Provenance({
    source: 'split',
    offset: 0x81A0,
    blank: false,
    bytes: new Uint8Array(16).fill(0xAB),
  })),
};

const flatArchive = {
  id: 'kpa_flat',
  vin: '2C3CDXCT1HH777777',
  zipName: 'KEYPROG_2C3CDXCT1HH777777.zip',
  savedAt: '2026-04-23T11:00:00.000Z',
  bcmSec16: snap(formatBcmSec16Provenance({
    source: 'flat',
    offset: 0x40C9,
    blank: false,
    bytes: new Uint8Array(16).fill(0x5A),
  })),
};

const virginArchive = {
  id: 'kpa_virgin',
  vin: '2C3CDXCT1HH000000',
  zipName: 'KEYPROG_2C3CDXCT1HH000000.zip',
  savedAt: '2026-04-23T12:00:00.000Z',
  bcmSec16: snap(formatBcmSec16Provenance({
    source: 'split',
    offset: 0x81A0,
    blank: true,
    bytes: new Uint8Array(16).fill(0xFF),
  })),
};

describe('Task #392 — Saved Archives history shows BCM SEC16 source per row', () => {
  afterEach(cleanup);

  it('renders the empty state when no archives are saved', () => {
    render(<KeyProgSavedArchivesCard archives={[]} />);
    expect(screen.getByTestId('keyprog-archive-history-empty')).toBeTruthy();
  });

  it('renders filename, VIN, timestamp, and SEC16 source for split / flat / virgin rows', () => {
    render(
      <KeyProgSavedArchivesCard
        archives={[splitArchive, flatArchive, virginArchive]}
        onDelete={() => {}}
        onClear={() => {}}
      />,
    );

    // Split — live source line
    const splitRow = screen.getByTestId('keyprog-archive-row-' + splitArchive.id);
    expect(splitRow.getAttribute('data-sec16-source')).toBe('split');
    expect(splitRow.getAttribute('data-sec16-blank')).toBe('0');
    expect(screen.getByTestId('keyprog-archive-row-name-' + splitArchive.id).textContent)
      .toBe(splitArchive.zipName);
    expect(screen.getByTestId('keyprog-archive-row-vin-' + splitArchive.id).textContent)
      .toBe(splitArchive.vin);
    const splitTime = screen.getByTestId('keyprog-archive-row-time-' + splitArchive.id);
    expect(splitTime.textContent.length).toBeGreaterThan(0);
    const splitSec16 = screen.getByTestId('keyprog-archive-row-sec16-' + splitArchive.id);
    expect(splitSec16.textContent).toMatch(/BCM SEC16 source: split @0x81A0/);
    expect(splitSec16.textContent).not.toMatch(/BLANK \/ virgin/);

    // Flat — legacy fallback
    const flatRow = screen.getByTestId('keyprog-archive-row-' + flatArchive.id);
    expect(flatRow.getAttribute('data-sec16-source')).toBe('flat');
    expect(flatRow.getAttribute('data-sec16-blank')).toBe('0');
    const flatSec16 = screen.getByTestId('keyprog-archive-row-sec16-' + flatArchive.id);
    expect(flatSec16.textContent).toMatch(/BCM SEC16 source: flat @0x40C9 \(legacy\)/);

    // Virgin — BLANK / virgin badge present in line
    const virginRow = screen.getByTestId('keyprog-archive-row-' + virginArchive.id);
    expect(virginRow.getAttribute('data-sec16-blank')).toBe('1');
    const virginSec16 = screen.getByTestId('keyprog-archive-row-sec16-' + virginArchive.id);
    expect(virginSec16.textContent).toMatch(/BCM SEC16 source: split @0x81A0/);
    expect(virginSec16.textContent).toMatch(/BLANK \/ virgin/);
  });

  it('falls back to "(no SEC16 source)" when the archive predates the SEC16 capture', () => {
    const legacyArchive = {
      id: 'kpa_legacy',
      vin: '2C3CDXCT1HH111111',
      zipName: 'KEYPROG_2C3CDXCT1HH111111.zip',
      savedAt: '2026-04-23T09:00:00.000Z',
      bcmSec16: null,
    };
    render(<KeyProgSavedArchivesCard archives={[legacyArchive]} />);
    const row = screen.getByTestId('keyprog-archive-row-' + legacyArchive.id);
    expect(row.getAttribute('data-sec16-source')).toBe('none');
    const sec16 = screen.getByTestId('keyprog-archive-row-sec16-' + legacyArchive.id);
    expect(sec16.textContent).toMatch(/BCM SEC16 source: \(no SEC16 source\)/);
  });
});
