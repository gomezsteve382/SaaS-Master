// @vitest-environment jsdom
/* ============================================================================
 * KeyWriterTab.knownKeys.ui.test.jsx — Task #1096 click-through for the
 * known-good working-key registry surface on the Key Dump card.
 *
 * Covers:
 *  - the known-good picker is rendered with the seeded 2019 Charger key,
 *  - Prefill loads the Key Dump card (chip/UID/SK) from the registry entry,
 *  - the status badge flips to "known-good" once prefilled,
 *  - editing the SK to a wrong value flips the badge to "mismatch",
 *  - a fresh/blank record reads as "unknown" (not in the registry).
 * ========================================================================== */

import React from 'react';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

import KeyWriterTab from '../KeyWriterTab.jsx';

const SEED_ID = 'charger62-2019-0077A29B';

describe('KeyWriterTab known-good registry surface (Task #1096)', () => {
  beforeEach(() => {
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch { /* ignore */ }
  });
  afterEach(() => {
    cleanup();
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch { /* ignore */ }
  });

  it('renders the known-good picker with the seeded Charger key', () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);
    expect(screen.getByTestId('known-key-list')).toBeTruthy();
    expect(screen.getByTestId(`known-key-row-${SEED_ID}`)).toBeTruthy();
    expect(screen.getByTestId('known-key-list').textContent).toContain('0077A29B');
  });

  it('a fresh blank record reads as "unknown"', () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);
    expect(screen.getByTestId('known-key-status').getAttribute('data-status')).toBe('unknown');
  });

  it('Prefill loads the card and flips the badge to known-good', async () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`known-key-prefill-${SEED_ID}`));
    });

    await waitFor(() => {
      expect(screen.getByTestId('key-dump-uid').value.replace(/\s/g, '')).toBe('0077A29B');
    });
    expect(screen.getByTestId('key-dump-sk').value.replace(/\s/g, '')).toBe('4F4E4D494B52');
    expect(screen.getByTestId('key-dump-chip').value).toBe('id46');
    expect(screen.getByTestId('known-key-status').getAttribute('data-status')).toBe('known-good');
  });

  it('editing the SK to a wrong value flips the badge to mismatch', async () => {
    render(<KeyWriterTab onOpenTab={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`known-key-prefill-${SEED_ID}`));
    });
    await waitFor(() => {
      expect(screen.getByTestId('known-key-status').getAttribute('data-status')).toBe('known-good');
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId('key-dump-sk'), { target: { value: 'DE AD BE EF CA FE' } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('known-key-status').getAttribute('data-status')).toBe('mismatch');
    });
    expect(screen.getByTestId('known-key-status').textContent).toMatch(/sk/i);
  });
});
