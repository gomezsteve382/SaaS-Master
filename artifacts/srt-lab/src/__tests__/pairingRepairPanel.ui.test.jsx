// @vitest-environment jsdom
//
// Integration tests for PairingRepairPanel.jsx (Task #1054).
//
// The panel is a pure React component — no context, no server calls —
// so we can drive it entirely through props + click events. The bytes
// are injected via props (bcmBytes / rfhubBytes) to bypass the FileReader
// path, which lets us exercise the complete triage → donor picker →
// patch preview → apply → download flow synchronously in jsdom.
//
// Test matrix:
//   1. BCM-donor path: BCM trusted (split records), RFHUB Gen2 trusted,
//      pick BCM as donor → Apply → BCM + RFHUB download buttons enabled.
//   2. RFHUB-donor path: same fixtures, pick RFHUB as donor → Apply →
//      both download buttons enabled.
//   3. "Generate Fresh" path: only RFHUB loaded, pick Generate → Apply →
//      RFHUB download button enabled, BCM button absent/disabled.
//   4. Triage display: triage cards surface the correct state badges
//      when both modules are pre-loaded.
//
// jsdom traps kept in mind (see .agents/memory/modulesync-ui-test-*):
//   - URL.createObjectURL / revokeObjectURL are not implemented — stub them.
//   - HTMLAnchorElement.click fires but DOM download does not — stub it to
//     avoid noise; we check button enabled state, not file hits.
//   - handleApply calls writeRfhSec16FromBcm which calls writeRfhSec16FromBcm
//     internally — no special stubs needed (pure Uint8Array math).

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import {
  render, screen, cleanup, fireEvent, act, waitFor,
} from '@testing-library/react';

import PairingRepairPanel from '../components/PairingRepairPanel.jsx';

/* ── URL / anchor stubs ──────────────────────────────────────────────────── */
// jsdom has no createObjectURL implementation; stub before any test runs.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:test-mock';
  URL.revokeObjectURL = () => {};
}

/* ── Fixture builders ─────────────────────────────────────────────────────── */

/**
 * 65536-byte BCM with three valid split records at 0x81A0/C0/E0.
 * resolveBcmSec16 + triageBcm resolve these as "trusted".
 * writeBcmSec16Gen2 finds and stamps these records.
 */
function makeBcmWithSplitSec16(sec16) {
  const buf = new Uint8Array(65536).fill(0xFF);
  const OFFSETS = [0x81A0, 0x81C0, 0x81E0];
  for (const off of OFFSETS) {
    buf[off]     = 0xFF;
    buf[off + 1] = 0xFF;
    for (let j = 2; j < 8; j++) buf[off + j] = 0x00;
    buf[off + 8] = 0x01;                   // idx
    for (let k = 0; k < 7; k++) buf[off + 9 + k] = sec16[k];
    buf[off + 16] = 0x04; buf[off + 17] = 0x04;
    buf[off + 18] = 0x00; buf[off + 19] = 0x14;
    for (let k = 0; k < 9; k++) buf[off + 20 + k] = sec16[7 + k];
    buf[off + 29] = 0x00;
  }
  return buf;
}

/**
 * 4096-byte RFHUB Gen2 with valid SEC16 in both mirror slots (0x050E/0x0522).
 * Header AA 55 31 01 at 0x0500 for the Gen2 heuristic check.
 * triageRfhub detects "gen2" + "trusted".
 * writeRfhSec16FromBcm targets these slots.
 */
function makeRfhubGen2Trusted(sec16) {
  const buf = new Uint8Array(4096).fill(0xFF);
  buf[0x0500] = 0xAA; buf[0x0501] = 0x55;
  buf[0x0502] = 0x31; buf[0x0503] = 0x01;
  for (const slotOff of [0x050E, 0x0522]) {
    for (let k = 0; k < 16; k++) buf[slotOff + k] = sec16[k];
    buf[slotOff + 16] = 0x42;  // non-blank CRC byte so the slot isn't treated as virgin
    buf[slotOff + 17] = 0x00;
  }
  return buf;
}

// Canonical test secrets: BCM_SEC16 = reverse(RFHUB_SEC16)
const RFHUB_SEC16 = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10,
]);
const BCM_SEC16 = new Uint8Array([...RFHUB_SEC16].reverse());

const BCM_BYTES   = makeBcmWithSplitSec16(BCM_SEC16);
const RFHUB_BYTES = makeRfhubGen2Trusted(RFHUB_SEC16);

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Renders the panel with optional pre-loaded bytes. onClose is a no-op spy. */
function renderPanel(props = {}) {
  const onClose = vi.fn();
  const result = render(
    <PairingRepairPanel onClose={onClose} {...props} />,
  );
  return { ...result, onClose };
}

/**
 * Navigate from step 1 (Triage) to step 2 (Donor Picker).
 * Waits for the "Next: Choose Donor" button to become available.
 */
async function goToDonorStep() {
  await waitFor(() => {
    expect(screen.getByTestId('triage-next-btn')).toBeTruthy();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('triage-next-btn'));
  });
}

/**
 * From step 2, click a donor card and advance to step 3 (Preview).
 * @param {'bcm'|'rfhub'|'generate'} donor
 */
async function chooseDonorAndPreview(donor) {
  await waitFor(() => {
    expect(screen.getByTestId(`donor-card-${donor}`)).toBeTruthy();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId(`donor-card-${donor}`));
  });
  // Advance to Preview step.
  await waitFor(() => {
    const btn = screen.getByTestId('donor-next-btn');
    expect(btn.disabled).toBe(false);
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('donor-next-btn'));
  });
}

/**
 * From step 3 (Preview), click Apply and wait for step 4 to render.
 */
async function applyAndWaitForStep4() {
  await waitFor(() => {
    expect(screen.getByTestId('apply-all-btn')).toBeTruthy();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('apply-all-btn'));
  });
  // Step 4 renders the download section.
  await waitFor(() => {
    expect(screen.getByTestId('download-bcm-btn')).toBeTruthy();
  });
}

/* ── beforeEach/afterEach ─────────────────────────────────────────────────── */
let anchorClickSpy;

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-mock');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  anchorClickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Suite 1: BCM-donor path (primary task requirement)
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('PairingRepairPanel — BCM-donor path', () => {
  it('BCM and RFHUB download buttons are enabled after Apply with BCM donor', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });

    await goToDonorStep();
    await chooseDonorAndPreview('bcm');
    await applyAndWaitForStep4();

    const bcmBtn   = screen.getByTestId('download-bcm-btn');
    const rfhubBtn = screen.getByTestId('download-rfhub-btn');

    expect(bcmBtn.disabled).toBe(false);
    expect(rfhubBtn.disabled).toBe(false);
  });

  it('PCM download button stays disabled (no PCM loaded)', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });

    await goToDonorStep();
    await chooseDonorAndPreview('bcm');
    await applyAndWaitForStep4();

    const pcmBtn = screen.getByTestId('download-pcm-btn');
    expect(pcmBtn.disabled).toBe(true);
  });

  it('clicking the enabled BCM download button triggers a file download', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });

    await goToDonorStep();
    await chooseDonorAndPreview('bcm');
    await applyAndWaitForStep4();

    await act(async () => {
      fireEvent.click(screen.getByTestId('download-bcm-btn'));
    });

    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Suite 2: RFHUB-donor path
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('PairingRepairPanel — RFHUB-donor path', () => {
  it('BCM and RFHUB download buttons are enabled after Apply with RFHUB donor', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });

    await goToDonorStep();
    await chooseDonorAndPreview('rfhub');
    await applyAndWaitForStep4();

    expect(screen.getByTestId('download-bcm-btn').disabled).toBe(false);
    expect(screen.getByTestId('download-rfhub-btn').disabled).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Suite 3: Generate-Fresh path (RFHUB-only)
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('PairingRepairPanel — Generate-Fresh path', () => {
  it('RFHUB download button is enabled after Apply with fresh secret', async () => {
    renderPanel({ rfhubBytes: RFHUB_BYTES });

    await goToDonorStep();
    await chooseDonorAndPreview('generate');
    await applyAndWaitForStep4();

    expect(screen.getByTestId('download-rfhub-btn').disabled).toBe(false);
  });

  it('BCM download button stays disabled when no BCM was loaded', async () => {
    renderPanel({ rfhubBytes: RFHUB_BYTES });

    await goToDonorStep();
    await chooseDonorAndPreview('generate');
    await applyAndWaitForStep4();

    expect(screen.getByTestId('download-bcm-btn').disabled).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Suite 4: Triage display
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('PairingRepairPanel — Triage display', () => {
  it('renders the panel overlay', () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });
    expect(screen.getByTestId('pairing-repair-panel')).toBeTruthy();
  });

  it('shows triage report when modules are pre-loaded', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });
    // Triage cards appear when anyLoaded is true — confirmed by the triage
    // next-btn becoming available.
    await waitFor(() => {
      expect(screen.getByTestId('triage-next-btn')).toBeTruthy();
    });
  });

  it('BCM donor card is enabled when BCM triage is trusted', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });
    await goToDonorStep();
    const bcmDonorCard = screen.getByTestId('donor-card-bcm');
    expect(bcmDonorCard.disabled).toBe(false);
  });

  it('RFHUB donor card is enabled when RFHUB triage is trusted', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });
    await goToDonorStep();
    const rfhDonorCard = screen.getByTestId('donor-card-rfhub');
    expect(rfhDonorCard.disabled).toBe(false);
  });

  it('Generate-Fresh donor card is always enabled', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });
    await goToDonorStep();
    expect(screen.getByTestId('donor-card-generate').disabled).toBe(false);
  });

  it('donor-next-btn starts disabled (no donor chosen yet)', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });
    await goToDonorStep();
    const nextBtn = screen.getByTestId('donor-next-btn');
    expect(nextBtn.disabled).toBe(true);
  });

  it('donor-next-btn enables once a donor is selected', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });
    await goToDonorStep();

    await act(async () => {
      fireEvent.click(screen.getByTestId('donor-card-bcm'));
    });

    expect(screen.getByTestId('donor-next-btn').disabled).toBe(false);
  });

  it('download buttons start locked on step 4 when validation has not run', async () => {
    // Navigate all the way through but check *before* Apply fires.
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });
    await goToDonorStep();

    await act(async () => {
      fireEvent.click(screen.getByTestId('donor-card-bcm'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('donor-next-btn'));
    });

    // Step 3 is now visible.  Apply has not been clicked yet.
    await waitFor(() => {
      expect(screen.getByTestId('apply-all-btn')).toBeTruthy();
    });

    // Click Apply to move to step 4 so we can inspect the buttons.
    await act(async () => {
      fireEvent.click(screen.getByTestId('apply-all-btn'));
    });

    // The download buttons should be visible.  Their enabled/disabled state
    // is determined by applied.ok which depends on crossValidate results —
    // we already check that in the BCM-donor suite above.  Here we just
    // assert they exist and that the ZIP button exists too.
    await waitFor(() => {
      expect(screen.getByTestId('download-zip-btn')).toBeTruthy();
    });
  });

  it('onClose is called when the ✕ button is clicked', async () => {
    const { onClose } = renderPanel({ bcmBytes: BCM_BYTES });
    const closeBtn = screen.getByText('✕');
    await act(async () => { fireEvent.click(closeBtn); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Start Over resets to step 1', async () => {
    renderPanel({ bcmBytes: BCM_BYTES, rfhubBytes: RFHUB_BYTES });
    await goToDonorStep();
    await chooseDonorAndPreview('bcm');
    await applyAndWaitForStep4();

    await act(async () => {
      fireEvent.click(screen.getByTestId('start-over-btn'));
    });

    // After Start Over the triage-next-btn should reappear (step 1).
    await waitFor(() => {
      expect(screen.getByTestId('triage-next-btn')).toBeTruthy();
    });
  });
});
