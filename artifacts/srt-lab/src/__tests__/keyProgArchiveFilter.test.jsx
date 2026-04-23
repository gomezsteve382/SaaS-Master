// @vitest-environment jsdom
/* Task #395 — the SAVED ARCHIVES card on the Key Prog tab needs filter pills
 * for SEC16 source (split / mirror1 / mirror2 / flat / virgin / unknown) and
 * a free-text VIN-or-filename search box, so a high-volume shop can isolate
 * "only flat fallbacks" or "only this VIN" without scrolling. The visible
 * row count must update to reflect active filters. */
import React from 'react';
import { describe, it, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  KeyProgSavedArchivesCard,
  categorizeArchiveSec16,
} from '../tabs/KeyProgTab.jsx';
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
    source: 'split', offset: 0x81A0, blank: false, bytes: new Uint8Array(16).fill(0xAB),
  })),
};

const flatArchiveA = {
  id: 'kpa_flat_a',
  vin: '2C3CDXCT1HH777777',
  zipName: 'KEYPROG_2C3CDXCT1HH777777.zip',
  savedAt: '2026-04-23T11:00:00.000Z',
  bcmSec16: snap(formatBcmSec16Provenance({
    source: 'flat', offset: 0x40C9, blank: false, bytes: new Uint8Array(16).fill(0x5A),
  })),
};

const flatArchiveB = {
  id: 'kpa_flat_b',
  vin: '2C3CDXCT1HH888888',
  zipName: 'KEYPROG_2C3CDXCT1HH888888.zip',
  savedAt: '2026-04-23T11:30:00.000Z',
  bcmSec16: snap(formatBcmSec16Provenance({
    source: 'flat', offset: 0x40C9, blank: false, bytes: new Uint8Array(16).fill(0x6B),
  })),
};

const virginArchive = {
  id: 'kpa_virgin',
  vin: '2C3CDXCT1HH000000',
  zipName: 'KEYPROG_2C3CDXCT1HH000000.zip',
  savedAt: '2026-04-23T12:00:00.000Z',
  bcmSec16: snap(formatBcmSec16Provenance({
    source: 'split', offset: 0x81A0, blank: true, bytes: new Uint8Array(16).fill(0xFF),
  })),
};

const mirror1Archive = {
  id: 'kpa_mirror1',
  vin: '2C3CDXCT1HH111111',
  zipName: 'KEYPROG_2C3CDXCT1HH111111.zip',
  savedAt: '2026-04-23T13:00:00.000Z',
  bcmSec16: snap(formatBcmSec16Provenance({
    source: 'mirror1', offset: 0x4200, blank: false, bytes: new Uint8Array(16).fill(0xEB),
  })),
};

const unknownArchive = {
  id: 'kpa_unknown',
  vin: '2C3CDXCT1HH222222',
  zipName: 'KEYPROG_2C3CDXCT1HH222222.zip',
  savedAt: '2026-04-23T09:00:00.000Z',
  bcmSec16: null,
};

const allArchives = [splitArchive, flatArchiveA, flatArchiveB, virginArchive, mirror1Archive, unknownArchive];

describe('Task #395 — categorizeArchiveSec16', () => {
  it('classifies blank dumps as virgin regardless of underlying source', () => {
    expect(categorizeArchiveSec16(virginArchive)).toBe('virgin');
  });

  it('uses the resolver source for non-blank dumps', () => {
    expect(categorizeArchiveSec16(splitArchive)).toBe('split');
    expect(categorizeArchiveSec16(flatArchiveA)).toBe('flat');
    expect(categorizeArchiveSec16(mirror1Archive)).toBe('mirror1');
  });

  it('falls back to "unknown" when no SEC16 snapshot was captured', () => {
    expect(categorizeArchiveSec16(unknownArchive)).toBe('unknown');
    expect(categorizeArchiveSec16({ id: 'x' })).toBe('unknown');
    expect(categorizeArchiveSec16(null)).toBe('unknown');
  });
});

describe('Task #395 — SAVED ARCHIVES filter & search', () => {
  afterEach(cleanup);

  it('shows the controls row and total count when archives are present', () => {
    render(<KeyProgSavedArchivesCard archives={allArchives} />);
    const controls = screen.getByTestId('keyprog-archive-history-controls');
    expect(controls).toBeTruthy();
    for (const key of ['split', 'mirror1', 'mirror2', 'flat', 'virgin', 'unknown']) {
      expect(screen.getByTestId('keyprog-archive-filter-' + key)).toBeTruthy();
    }
    const count = screen.getByTestId('keyprog-archive-history-count');
    expect(count.getAttribute('data-visible')).toBe('6');
    expect(count.getAttribute('data-total')).toBe('6');
    expect(count.textContent).toMatch(/6 archives/);
    // No reset button until a filter is active.
    expect(screen.queryByTestId('keyprog-archive-filter-reset')).toBeNull();
  });

  it('does not show controls when the archive list is empty', () => {
    render(<KeyProgSavedArchivesCard archives={[]} />);
    expect(screen.queryByTestId('keyprog-archive-history-controls')).toBeNull();
    expect(screen.getByTestId('keyprog-archive-history-empty')).toBeTruthy();
  });

  it('filters to a single SEC16 source when one pill is active', () => {
    render(<KeyProgSavedArchivesCard archives={allArchives} />);
    fireEvent.click(screen.getByTestId('keyprog-archive-filter-flat'));
    expect(screen.getByTestId('keyprog-archive-filter-flat').getAttribute('data-active')).toBe('1');
    expect(screen.getByTestId('keyprog-archive-row-' + flatArchiveA.id)).toBeTruthy();
    expect(screen.getByTestId('keyprog-archive-row-' + flatArchiveB.id)).toBeTruthy();
    expect(screen.queryByTestId('keyprog-archive-row-' + splitArchive.id)).toBeNull();
    expect(screen.queryByTestId('keyprog-archive-row-' + virginArchive.id)).toBeNull();
    expect(screen.queryByTestId('keyprog-archive-row-' + mirror1Archive.id)).toBeNull();
    expect(screen.queryByTestId('keyprog-archive-row-' + unknownArchive.id)).toBeNull();
    const count = screen.getByTestId('keyprog-archive-history-count');
    expect(count.getAttribute('data-visible')).toBe('2');
    expect(count.getAttribute('data-total')).toBe('6');
    expect(count.textContent).toMatch(/Showing 2 of 6/);
  });

  it('treats blank dumps as virgin even when their source label is split', () => {
    render(<KeyProgSavedArchivesCard archives={allArchives} />);
    fireEvent.click(screen.getByTestId('keyprog-archive-filter-virgin'));
    expect(screen.getByTestId('keyprog-archive-row-' + virginArchive.id)).toBeTruthy();
    expect(screen.queryByTestId('keyprog-archive-row-' + splitArchive.id)).toBeNull();
    expect(screen.getByTestId('keyprog-archive-history-count').getAttribute('data-visible')).toBe('1');
  });

  it('toggles pills off and combines pills with OR semantics', () => {
    render(<KeyProgSavedArchivesCard archives={allArchives} />);
    fireEvent.click(screen.getByTestId('keyprog-archive-filter-flat'));
    fireEvent.click(screen.getByTestId('keyprog-archive-filter-mirror1'));
    expect(screen.getByTestId('keyprog-archive-history-count').getAttribute('data-visible')).toBe('3');
    expect(screen.getByTestId('keyprog-archive-row-' + flatArchiveA.id)).toBeTruthy();
    expect(screen.getByTestId('keyprog-archive-row-' + flatArchiveB.id)).toBeTruthy();
    expect(screen.getByTestId('keyprog-archive-row-' + mirror1Archive.id)).toBeTruthy();

    // Toggle flat back off — only mirror1 should remain.
    fireEvent.click(screen.getByTestId('keyprog-archive-filter-flat'));
    expect(screen.getByTestId('keyprog-archive-history-count').getAttribute('data-visible')).toBe('1');
    expect(screen.queryByTestId('keyprog-archive-row-' + flatArchiveA.id)).toBeNull();
    expect(screen.getByTestId('keyprog-archive-row-' + mirror1Archive.id)).toBeTruthy();
  });

  it('matches a VIN substring via the search box', () => {
    render(<KeyProgSavedArchivesCard archives={allArchives} />);
    const search = screen.getByTestId('keyprog-archive-search');
    fireEvent.change(search, { target: { value: '777777' } });
    expect(screen.getByTestId('keyprog-archive-row-' + flatArchiveA.id)).toBeTruthy();
    expect(screen.queryByTestId('keyprog-archive-row-' + flatArchiveB.id)).toBeNull();
    expect(screen.queryByTestId('keyprog-archive-row-' + splitArchive.id)).toBeNull();
    expect(screen.getByTestId('keyprog-archive-history-count').getAttribute('data-visible')).toBe('1');
  });

  it('matches the zip filename and is case-insensitive', () => {
    render(<KeyProgSavedArchivesCard archives={allArchives} />);
    const search = screen.getByTestId('keyprog-archive-search');
    fireEvent.change(search, { target: { value: 'keyprog_2c3cdxct1hh652640' } });
    expect(screen.getByTestId('keyprog-archive-row-' + splitArchive.id)).toBeTruthy();
    expect(screen.getByTestId('keyprog-archive-history-count').getAttribute('data-visible')).toBe('1');
  });

  it('combines source pills and search with AND semantics', () => {
    render(<KeyProgSavedArchivesCard archives={allArchives} />);
    fireEvent.click(screen.getByTestId('keyprog-archive-filter-flat'));
    fireEvent.change(screen.getByTestId('keyprog-archive-search'), { target: { value: '888888' } });
    expect(screen.getByTestId('keyprog-archive-row-' + flatArchiveB.id)).toBeTruthy();
    expect(screen.queryByTestId('keyprog-archive-row-' + flatArchiveA.id)).toBeNull();
    expect(screen.getByTestId('keyprog-archive-history-count').getAttribute('data-visible')).toBe('1');
  });

  it('renders an empty-match notice when filters exclude every row', () => {
    render(<KeyProgSavedArchivesCard archives={allArchives} />);
    fireEvent.change(screen.getByTestId('keyprog-archive-search'), { target: { value: 'NOTAVIN' } });
    expect(screen.getByTestId('keyprog-archive-history-no-matches')).toBeTruthy();
    expect(screen.queryByTestId('keyprog-archive-history-list')).toBeNull();
    expect(screen.getByTestId('keyprog-archive-history-count').getAttribute('data-visible')).toBe('0');
  });

  it('reset button clears every active filter and the search box', () => {
    render(<KeyProgSavedArchivesCard archives={allArchives} />);
    fireEvent.click(screen.getByTestId('keyprog-archive-filter-flat'));
    fireEvent.change(screen.getByTestId('keyprog-archive-search'), { target: { value: '888888' } });
    fireEvent.click(screen.getByTestId('keyprog-archive-filter-reset'));
    expect(screen.getByTestId('keyprog-archive-filter-flat').getAttribute('data-active')).toBe('0');
    expect(screen.getByTestId('keyprog-archive-search').value).toBe('');
    expect(screen.getByTestId('keyprog-archive-history-count').getAttribute('data-visible')).toBe('6');
    expect(screen.queryByTestId('keyprog-archive-filter-reset')).toBeNull();
  });
});
