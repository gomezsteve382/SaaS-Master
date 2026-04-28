// @vitest-environment jsdom
//
// Task #478 — File-size warning surfaces in the OBD flashing wizard.
//
// The PCM file-size mismatch guard added in Task #475 only protected the
// Module Sync workspace. The RFH→PCM Pairing tab is the second entry
// point that loads a PCM .bin and emits a patched image, so it must
// mirror the same protection: byte-size + chip-variant badge on the PCM
// panel, red "Programmer says 'File different size'?" block banner when
// the file is non-canonical, and APPLY / DOWNLOAD disabled until the
// file matches a 95320 (4 KB) or 95640 (8 KB) bench chip.
//
// We exercise the rendered tab with a clean 4 KB PCM (canonical badge,
// no block) and with a 5000-byte PCM (UNKNOWN CHIP badge, red block,
// APPLY disabled) so the wiring can't silently regress in the JSX.
// Task #486 — non-canonical PCM badge wording was unified across the
// Module Sync, RFH↔PCM, and per-vehicle Dumps surfaces; this tab now
// reads the same "{N} B · UNKNOWN CHIP" amber badge the Dumps tab
// already shipped, so a tech doesn't second-guess whether 'OTHER' on
// one tab and 'UNKNOWN CHIP' on another mean different things.

import React from 'react';
import { describe, it, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

import RFHPCMTab from '../tabs/RFHPCMTab.jsx';
import { makeRfhubGen2 } from '../lib/__fixtures__/buildFixtures.js';

afterEach(() => cleanup());

function pcmFile(size, name) {
  /* parsePCMGPEC accepts any byte-length input — it only reads from
   * fixed offsets and decides writability from the size. A zeroed
   * buffer is enough to drive the badge / banner / button-disable
   * code paths, which is what this test pins down. */
  const buf = new Uint8Array(size);
  return new File([buf], name, { type: 'application/octet-stream' });
}

async function pickFile(input, file) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
    await new Promise(r => setTimeout(r, 50));
  });
}

describe('Task #478 — RFH→PCM (OBD wizard) file-size guard', () => {
  it('always renders the "Programmer says File different size?" help blurb', () => {
    render(<RFHPCMTab />);
    const help = screen.getByTestId('obdwiz-programmer-size-help');
    expect(help.textContent).toMatch(/File different size/i);
    /* The blurb must point the tech at the EXT EEPROM as the fix —
     * that's the diagnosis that turns "wrong file size" into a
     * resolvable problem on the bench. */
    expect(help.textContent).toMatch(/EXT EEPROM/i);
  });

  it('shows the canonical 95320 chip badge for a 4 KB PCM and does not render the red block banner', async () => {
    const { container } = render(<RFHPCMTab />);
    const inputs = container.querySelectorAll('input[type="file"]');
    /* Two FileDropZone inputs are rendered: [0] = RFH, [1] = PCM.
     * SamplePicker may add more, but the first two are the .bin
     * dropzones and that ordering is asserted here so the test fails
     * fast if a future refactor changes the layout. */
    expect(inputs.length).toBeGreaterThanOrEqual(2);

    await pickFile(inputs[1], pcmFile(4096, 'PCM_4KB.bin'));

    await waitFor(() => {
      const badge = screen.getByTestId('obdwiz-pcm-size-badge');
      expect(badge.getAttribute('data-size-key')).toBe('4kb');
      expect(badge.getAttribute('data-size-canonical')).toBe('1');
      expect(badge.textContent).toMatch(/95320/);
      expect(badge.textContent).toMatch(/4,?096 B/);
    });

    expect(screen.queryByTestId('obdwiz-programmer-size-block')).toBeNull();
  });

  it('shows the canonical 95640 chip badge for an 8 KB PCM and does not render the red block banner', async () => {
    const { container } = render(<RFHPCMTab />);
    const inputs = container.querySelectorAll('input[type="file"]');

    await pickFile(inputs[1], pcmFile(8192, 'PCM_8KB.bin'));

    await waitFor(() => {
      const badge = screen.getByTestId('obdwiz-pcm-size-badge');
      expect(badge.getAttribute('data-size-key')).toBe('8kb');
      expect(badge.getAttribute('data-size-canonical')).toBe('1');
      expect(badge.textContent).toMatch(/95640/);
    });

    expect(screen.queryByTestId('obdwiz-programmer-size-block')).toBeNull();
  });

  it('shows the UNKNOWN CHIP badge AND the red block banner for a non-canonical PCM size, and disables APPLY + DOWNLOAD', async () => {
    const { container } = render(<RFHPCMTab />);
    const inputs = container.querySelectorAll('input[type="file"]');

    await pickFile(inputs[1], pcmFile(5000, 'PCM_NONCANONICAL.bin'));

    await waitFor(() => {
      const badge = screen.getByTestId('obdwiz-pcm-size-badge');
      /* Task #486 — wording unified with the Dumps + Module Sync tabs:
       * dataKey is now 'unknown' (not 'other') and the label reads
       * "{N} B · UNKNOWN CHIP" instead of "{kb} KB · OTHER". */
      expect(badge.getAttribute('data-size-key')).toBe('unknown');
      expect(badge.getAttribute('data-size-canonical')).toBe('0');
      expect(badge.textContent).toMatch(/UNKNOWN CHIP/);
      expect(badge.textContent).toMatch(/5,?000 B/);
    });

    const block = screen.getByTestId('obdwiz-programmer-size-block');
    expect(block.textContent).toMatch(/File different size/i);
    expect(block.textContent).toMatch(/95320/);
    expect(block.textContent).toMatch(/95640/);
    /* The banner must call out that APPLY + DOWNLOAD are blocked so a
     * tech doesn't hunt for a greyed-out button without an explanation. */
    expect(block.textContent).toMatch(/APPLY/);
    expect(block.textContent).toMatch(/DOWNLOAD/);

    /* APPLY + DOWNLOAD are inside the COMPATIBILITY card which renders
     * only when both RFH and PCM are loaded. With only PCM loaded they
     * aren't in the DOM yet — but the doApply / doDownload guards in
     * the component already short-circuit on pcmSizeNonCanonical, so
     * even if the buttons were visible they would refuse to fire. The
     * banner is the user-visible block and is asserted above. */
  });

  it('with both RFH and a non-canonical PCM loaded, the COMPATIBILITY card renders APPLY/DOWNLOAD as disabled', async () => {
    const { container } = render(<RFHPCMTab />);
    const inputs = container.querySelectorAll('input[type="file"]');

    /* makeRfhubGen2 builds a structurally valid 4 KB Gen2 RFHUB image
     * (VIN @ 0x92 + valid CRC, SEC16 slots, FOB markers, etc.) so the
     * COMPATIBILITY card actually mounts. The PCM is intentionally
     * 5000 bytes — non-canonical — to exercise the new size guard. */
    const rfh = makeRfhubGen2();
    const rfhFile = new File([rfh], 'RFH_GEN2.bin', { type: 'application/octet-stream' });
    await pickFile(inputs[0], rfhFile);
    await pickFile(inputs[1], pcmFile(5000, 'PCM_NONCANONICAL.bin'));

    /* COMPATIBILITY card title is the trigger we use to confirm the
     * card is actually in the DOM before we go looking for buttons. */
    await waitFor(() => {
      expect(screen.getByText(/COMPATIBILITY/i)).toBeTruthy();
    });

    /* APPLY button label: "⚡ APPLY — Patch PCM in memory".
     * DOWNLOAD button label: "💾 DOWNLOAD patched PCM".
     * Both must be present and disabled. */
    const applyBtn = screen.getByRole('button', { name: /APPLY.*Patch PCM/i });
    const downloadBtn = screen.getByRole('button', { name: /DOWNLOAD patched PCM/i });
    expect(applyBtn.disabled).toBe(true);
    expect(downloadBtn.disabled).toBe(true);

    /* Banner remains visible so the disabled state has an
     * explanation the tech can act on. */
    expect(screen.getByTestId('obdwiz-programmer-size-block')).toBeTruthy();
  });
});
