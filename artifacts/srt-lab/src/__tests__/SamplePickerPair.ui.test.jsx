// @vitest-environment jsdom
//
// Task #348 — Auto-suggest matching pair when one sample dump is loaded.
//
// SamplePicker now accepts:
//   - onLoaded(fixture)   — fired with fixture metadata after a successful load
//   - suggestedPair       — pair-key from a sibling picker; if any fixture in
//                           this picker shares it, render a one-click
//                           "Load matching pair" button.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React, { useState, useCallback } from 'react';
import SamplePicker from '../lib/SamplePicker.jsx';
import { SAMPLE_FIXTURES } from '../lib/sampleFixtures.js';

// Stub out the network fetch performed by loadFixture* — we only care about
// the metadata wiring, not the actual bytes.
vi.mock('../lib/sampleFixtures.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadFixtureAsFile: vi.fn(async (name) => new File([new Uint8Array([0])], name)),
    loadFixtureBytes:  vi.fn(async () => new Uint8Array([0])),
  };
});

afterEach(() => cleanup());

function Harness({ kindsA, kindsB, sizesA, sizesB }) {
  const [pair, setPair] = useState(null);
  const onLoaded = useCallback(f => setPair(f?.pair || null), []);
  return (
    <div>
      <SamplePicker kinds={kindsA} acceptSizes={sizesA} onFile={() => {}}
        onLoaded={onLoaded} suggestedPair={pair} label="A" />
      <SamplePicker kinds={kindsB} acceptSizes={sizesB} onFile={() => {}}
        onLoaded={onLoaded} suggestedPair={pair} label="B" />
    </div>
  );
}

describe('SamplePicker — pair auto-suggest', () => {
  it('shows a "Load matching pair" hint on sibling picker after a paired fixture loads', async () => {
    // trackhawk-1 spans BCM and 95640 fixtures.
    render(<Harness kindsA={['BCM']} sizesA={[65536]} kindsB={['95640']} sizesB={[8192]} />);

    // No suggestion before anything is selected.
    expect(screen.queryByRole('button', { name: /Load matching pair/i })).toBeNull();

    // Find the BCM trackhawk-1 fixture and pick it on picker A.
    const bcmFix = SAMPLE_FIXTURES.find(f => f.pair === 'trackhawk-1' && f.kind === 'BCM');
    expect(bcmFix).toBeTruthy();

    const selects = document.querySelectorAll('select[data-sample-picker="1"]');
    expect(selects.length).toBe(2);
    fireEvent.change(selects[0], { target: { value: bcmFix.file } });

    // After load, picker B should show the matching-pair button referencing
    // the partner 95640 fixture.
    await waitFor(() => {
      const btn = document.querySelector('button[data-sample-pair-suggest="1"][data-pair-key="trackhawk-1"]');
      expect(btn).toBeTruthy();
      expect(btn.textContent).toMatch(/Load matching pair/);
      expect(btn.textContent).toMatch(/95640/);
    });
  });

  it('does not show a hint when the loaded fixture has no pair key', async () => {
    render(<Harness kindsA={['BCM']} sizesA={[65536]} kindsB={['95640']} sizesB={[8192]} />);

    const orphan = SAMPLE_FIXTURES.find(f => f.kind === 'BCM' && !f.pair && f.size === 65536);
    expect(orphan).toBeTruthy();

    const selects = document.querySelectorAll('select[data-sample-picker="1"]');
    fireEvent.change(selects[0], { target: { value: orphan.file } });

    // Give effects a tick.
    await new Promise(r => setTimeout(r, 30));
    expect(document.querySelector('button[data-sample-pair-suggest="1"]')).toBeNull();
  });

  it('clicking the hint loads the partner fixture via the picker', async () => {
    const { loadFixtureAsFile } = await import('../lib/sampleFixtures.js');
    render(<Harness kindsA={['BCM']} sizesA={[65536]} kindsB={['95640']} sizesB={[8192]} />);

    const bcmFix = SAMPLE_FIXTURES.find(f => f.pair === 'trackhawk-1' && f.kind === 'BCM');
    const partnerFix = SAMPLE_FIXTURES.find(f => f.pair === 'trackhawk-1' && f.kind === '95640');

    const selects = document.querySelectorAll('select[data-sample-picker="1"]');
    fireEvent.change(selects[0], { target: { value: bcmFix.file } });

    let btn;
    await waitFor(() => {
      btn = document.querySelector('button[data-sample-pair-suggest="1"]');
      expect(btn).toBeTruthy();
    });

    loadFixtureAsFile.mockClear();
    fireEvent.click(btn);

    await waitFor(() => {
      expect(loadFixtureAsFile).toHaveBeenCalledWith(partnerFix.file);
    });
  });
});
