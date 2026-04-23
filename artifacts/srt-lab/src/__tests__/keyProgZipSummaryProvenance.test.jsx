// @vitest-environment jsdom
/* Task #390 — the post-download "ZIP DOWNLOADED" summary card must echo the
 * same BCM SEC16 source line that the wizard badge above the dropzone and
 * the archived VERIFY.txt both show, so a locksmith comparing two saved
 * ZIPs side by side can spot a split-vs-flat-vs-virgin mismatch without
 * opening VERIFY.txt.
 *
 * Covers the three resolver outcomes:
 *   - split  (live SEC16 read from 0x81A0/0x81C0/0x81E0)
 *   - flat   (legacy 0x40C9 fallback)
 *   - virgin (every candidate is 0xFF — explainer flag rendered)
 */
import React from 'react';
import { describe, it, afterEach, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { KeyProgZipSummaryCard } from '../tabs/KeyProgTab.jsx';
import { formatBcmSec16Provenance } from '../lib/keyProgWizard.js';

function makeSummary(bcmSec16) {
  return {
    zipName: 'KEYPROG_2C3CDXCT1HH652640.zip',
    zipSize: 12345,
    entries: [
      { role: 'BCM', name: 'BCM_patched.bin', size: 65536, sha256: 'aa'.repeat(32) },
      { role: 'RFH', name: 'RFH_patched.bin', size: 4096, sha256: 'bb'.repeat(32) },
      { role: 'PCM', name: 'PCM_patched.bin', size: 4096, sha256: 'cc'.repeat(32) },
      { role: 'VERIFY', name: 'VERIFY.txt', size: 1024, sha256: 'dd'.repeat(32) },
    ],
    bcmSec16,
    at: '2026-04-23T00:00:00.000Z',
  };
}

describe('Task #390 — KeyProg ZIP summary echoes BCM SEC16 provenance', () => {
  afterEach(cleanup);

  it('renders the split @offset label for a synced (split-source) BCM', () => {
    const prov = formatBcmSec16Provenance({
      source: 'split',
      offset: 0x81A0,
      blank: false,
      bytes: new Uint8Array(16).fill(0xAB),
    });
    render(<KeyProgZipSummaryCard zipSummary={makeSummary(prov)} onDismiss={() => {}} />);
    const line = screen.getByTestId('keyprog-zip-summary-bcm-sec16');
    expect(line.getAttribute('data-sec16-source')).toBe('split');
    expect(line.getAttribute('data-sec16-blank')).toBe('0');
    expect(line.textContent).toMatch(/BCM SEC16 source: split @0x81A0/);
    expect(line.textContent).not.toMatch(/BLANK \/ virgin/);
  });

  it('renders the legacy flat @0x40C9 label for a flat-fallback BCM', () => {
    const prov = formatBcmSec16Provenance({
      source: 'flat',
      offset: 0x40C9,
      blank: false,
      bytes: new Uint8Array(16).fill(0x5A),
    });
    render(<KeyProgZipSummaryCard zipSummary={makeSummary(prov)} onDismiss={() => {}} />);
    const line = screen.getByTestId('keyprog-zip-summary-bcm-sec16');
    expect(line.getAttribute('data-sec16-source')).toBe('flat');
    expect(line.getAttribute('data-sec16-blank')).toBe('0');
    expect(line.textContent).toMatch(/BCM SEC16 source: flat @0x40C9 \(legacy\)/);
  });

  it('flags BLANK / virgin BCM dumps with the inline marker', () => {
    const prov = formatBcmSec16Provenance({
      source: 'flat',
      offset: 0x40C9,
      blank: true,
      bytes: new Uint8Array(16).fill(0xFF),
    });
    render(<KeyProgZipSummaryCard zipSummary={makeSummary(prov)} onDismiss={() => {}} />);
    const line = screen.getByTestId('keyprog-zip-summary-bcm-sec16');
    expect(line.getAttribute('data-sec16-blank')).toBe('1');
    expect(line.textContent).toMatch(/BCM SEC16 source: flat @0x40C9 \(legacy\)/);
    expect(line.textContent).toMatch(/\[BLANK \/ virgin\]/);
  });

  it('only attaches the SEC16 line to the BCM row, not RFH/PCM/VERIFY', () => {
    const prov = formatBcmSec16Provenance({
      source: 'split', offset: 0x81A0, blank: false, bytes: new Uint8Array(16),
    });
    render(<KeyProgZipSummaryCard zipSummary={makeSummary(prov)} onDismiss={() => {}} />);
    // Exactly one provenance line in the entire panel.
    const all = screen.getAllByTestId('keyprog-zip-summary-bcm-sec16');
    expect(all.length).toBe(1);
    // …and it lives inside the BCM row (row index 0 in our fixture).
    const bcmRow = screen.getByTestId('keyprog-zip-summary-row-0');
    expect(bcmRow.contains(all[0])).toBe(true);
  });

  it('omits the SEC16 line entirely when no provenance was captured', () => {
    render(<KeyProgZipSummaryCard zipSummary={makeSummary(null)} onDismiss={() => {}} />);
    expect(screen.queryByTestId('keyprog-zip-summary-bcm-sec16')).toBeNull();
  });
});
