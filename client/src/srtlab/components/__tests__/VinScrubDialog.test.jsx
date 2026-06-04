// @vitest-environment jsdom
//
// Task #755 — shared VIN-scrub gate used by every trace-text export path
// (share link, file download, recorder handoffs). Verifies:
//   1. No VINs in text → onProceed runs immediately with original text,
//      no dialog mounted.
//   2. VINs present → dialog mounts; cancel leaves onProceed un-called.
//   3. Proceed-with-real → onProceed gets the original text verbatim.
//   4. Scrub first → onProceed gets text with VINs replaced by the
//      shared placeholder (so every export path uses the same scrub).
//   5. actionLabel customises the proceed-real button label so each
//      export surface (Share / Download / Send to Analyzer) confirms
//      the actual action.

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useVinScrubGate } from '../VinScrubDialog.jsx';
import { VIN_PLACEHOLDER } from '../../lib/udsSessionAnalyzer/shareLink.js';

const VIN = '2C3CDXL9XKH123456'; // check-digit-valid

function Harness({ text, onProceed, actionLabel }) {
  const gate = useVinScrubGate();
  return (
    <div>
      <button
        data-testid="trigger"
        onClick={() => gate.run(text, onProceed, actionLabel ? { actionLabel } : undefined)}
      >
        go
      </button>
      {gate.dialog}
    </div>
  );
}

describe('useVinScrubGate', () => {
  afterEach(() => cleanup());

  it('runs onProceed immediately when no VIN is present', () => {
    const onProceed = vi.fn();
    render(<Harness text="no vin here at all" onProceed={onProceed} />);
    act(() => { fireEvent.click(screen.getByTestId('trigger')); });
    expect(onProceed).toHaveBeenCalledWith('no vin here at all');
    expect(screen.queryByTestId('vin-scrub-dialog')).toBeNull();
  });

  it('opens the dialog when a VIN is detected and cancel suppresses onProceed', () => {
    const onProceed = vi.fn();
    render(<Harness text={`prefix ${VIN} suffix`} onProceed={onProceed} />);
    act(() => { fireEvent.click(screen.getByTestId('trigger')); });
    expect(screen.getByTestId('vin-scrub-dialog')).toBeTruthy();
    act(() => { fireEvent.click(screen.getByTestId('vin-scrub-cancel')); });
    expect(onProceed).not.toHaveBeenCalled();
    expect(screen.queryByTestId('vin-scrub-dialog')).toBeNull();
  });

  it('proceed-real forwards the original text verbatim', () => {
    const onProceed = vi.fn();
    const src = `pre ${VIN} post`;
    render(<Harness text={src} onProceed={onProceed} />);
    act(() => { fireEvent.click(screen.getByTestId('trigger')); });
    act(() => { fireEvent.click(screen.getByTestId('vin-scrub-proceed-real')); });
    expect(onProceed).toHaveBeenCalledWith(src);
    expect(screen.queryByTestId('vin-scrub-dialog')).toBeNull();
  });

  it('scrub-first forwards text with VINs replaced by the shared placeholder', () => {
    const onProceed = vi.fn();
    render(<Harness text={`pre ${VIN} post`} onProceed={onProceed} />);
    act(() => { fireEvent.click(screen.getByTestId('trigger')); });
    act(() => { fireEvent.click(screen.getByTestId('vin-scrub-proceed-scrubbed')); });
    expect(onProceed).toHaveBeenCalledTimes(1);
    const arg = onProceed.mock.calls[0][0];
    expect(arg).toContain(VIN_PLACEHOLDER);
    expect(arg).not.toContain(VIN);
  });

  it('honors actionLabel on the proceed-real button', () => {
    const onProceed = vi.fn();
    render(<Harness text={`pre ${VIN} post`} onProceed={onProceed} actionLabel="Download" />);
    act(() => { fireEvent.click(screen.getByTestId('trigger')); });
    const btn = screen.getByTestId('vin-scrub-proceed-real');
    expect(btn.textContent).toContain('Download with real VIN');
  });
});
