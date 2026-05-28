// @vitest-environment jsdom
//
// Task #905 — RFHUB SEC16 banner render paths in the Key Prog UI.
//
// PayloadResultCard (exported from Charger62BenchPanel) renders:
//   • an amber "RFHUB SEC16 auto-corrected" banner when rfhSec16Status starts
//     with 'PATCHED', showing the old→new hex values.
//   • a red "RFHUB SEC16 write not completed" banner when rfhSec16Status starts
//     with 'WRITE_SKIPPED' (or 'WRITE_FAILED'), with a ModuleSync reference.
//   • no banner at all when rfhSec16Status is 'ALREADY_MATCHED'.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { PayloadResultCard } from '../components/Charger62BenchPanel.jsx';
import { KeyProgSec16Banners } from '../tabs/KeyProgTab.jsx';

afterEach(cleanup);

// Minimal payResult shape that satisfies PayloadResultCard without triggering
// the checks-list render path.
const baseResult = { ok: true, checks: [] };

describe('PayloadResultCard — RFHUB SEC16 banners', () => {

  // ── PATCHED banner ────────────────────────────────────────────────────────
  it('shows the amber patched-banner and old→new hex when status is PATCHED', () => {
    const OLD_HEX = 'AABBCCDDEEFF00112233445566778899';
    const NEW_HEX = 'DDEEFF0011223344556677889900AABB';

    render(
      <PayloadResultCard
        payResult={{
          ...baseResult,
          rfhSec16Status: `PATCHED (old: ${OLD_HEX}, new: ${NEW_HEX})`,
          rfhSec16BeforeHex: OLD_HEX,
          rfhSec16AfterHex: NEW_HEX,
        }}
      />,
    );

    const banner = screen.getByTestId('rfh-sec16-patched-banner');
    expect(banner).toBeTruthy();

    // Old hex value must be visible inside the banner.
    expect(banner.textContent).toContain(OLD_HEX);
    // New hex value must also be visible.
    expect(banner.textContent).toContain(NEW_HEX);

    // The failed banner must NOT be present for a PATCHED status.
    expect(screen.queryByTestId('rfh-sec16-failed-banner')).toBeNull();
  });

  // ── WRITE_SKIPPED banner ──────────────────────────────────────────────────
  it('shows the red failed-banner and mentions ModuleSync when status is WRITE_SKIPPED', () => {
    const STATUS = 'WRITE_SKIPPED (BCM SEC16 blank or unresolvable)';

    render(
      <PayloadResultCard
        payResult={{
          ...baseResult,
          rfhSec16Status: STATUS,
        }}
      />,
    );

    const banner = screen.getByTestId('rfh-sec16-failed-banner');
    expect(banner).toBeTruthy();

    // The raw status string must appear in the banner.
    expect(banner.textContent).toContain(STATUS);
    // Must direct the user to ModuleSync for the manual sync path.
    expect(banner.textContent).toMatch(/ModuleSync/i);

    // The patched banner must NOT appear.
    expect(screen.queryByTestId('rfh-sec16-patched-banner')).toBeNull();
  });

  // ── ALREADY_MATCHED — no banners ──────────────────────────────────────────
  it('shows neither banner when status is ALREADY_MATCHED', () => {
    render(
      <PayloadResultCard
        payResult={{
          ...baseResult,
          rfhSec16Status: 'ALREADY_MATCHED',
        }}
      />,
    );

    expect(screen.queryByTestId('rfh-sec16-patched-banner')).toBeNull();
    expect(screen.queryByTestId('rfh-sec16-failed-banner')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KeyProgSec16Banners — same three render paths via the extracted component
// that KeyProgTab.jsx uses in its result section (lines 1233–1234).
// ─────────────────────────────────────────────────────────────────────────────
describe('KeyProgSec16Banners — RFHUB SEC16 banners', () => {

  // ── PATCHED banner ────────────────────────────────────────────────────────
  it('shows the amber patched-banner and old→new hex when status is PATCHED', () => {
    const OLD_HEX = 'AABBCCDDEEFF00112233445566778899';
    const NEW_HEX = 'DDEEFF0011223344556677889900AABB';

    render(
      <KeyProgSec16Banners
        result={{
          rfhSec16Status: `PATCHED (old: ${OLD_HEX}, new: ${NEW_HEX})`,
          rfhSec16BeforeHex: OLD_HEX,
          rfhSec16AfterHex: NEW_HEX,
        }}
      />,
    );

    const banner = screen.getByTestId('rfh-sec16-patched-banner');
    expect(banner).toBeTruthy();

    // Old hex value must be visible inside the banner.
    expect(banner.textContent).toContain(OLD_HEX);
    // New hex value must also be visible.
    expect(banner.textContent).toContain(NEW_HEX);

    // The failed banner must NOT be present for a PATCHED status.
    expect(screen.queryByTestId('rfh-sec16-failed-banner')).toBeNull();
  });

  // ── WRITE_SKIPPED banner ──────────────────────────────────────────────────
  it('shows the red failed-banner and mentions ModuleSync when status is WRITE_SKIPPED', () => {
    const STATUS = 'WRITE_SKIPPED (BCM SEC16 blank or unresolvable)';

    render(
      <KeyProgSec16Banners
        result={{
          rfhSec16Status: STATUS,
        }}
      />,
    );

    const banner = screen.getByTestId('rfh-sec16-failed-banner');
    expect(banner).toBeTruthy();

    // The raw status string must appear in the banner.
    expect(banner.textContent).toContain(STATUS);
    // Must direct the user to ModuleSync for the manual sync path.
    expect(banner.textContent).toMatch(/ModuleSync/i);

    // The patched banner must NOT appear.
    expect(screen.queryByTestId('rfh-sec16-patched-banner')).toBeNull();
  });

  // ── ALREADY_MATCHED — no banners ──────────────────────────────────────────
  it('shows neither banner when status is ALREADY_MATCHED', () => {
    render(
      <KeyProgSec16Banners
        result={{
          rfhSec16Status: 'ALREADY_MATCHED',
        }}
      />,
    );

    expect(screen.queryByTestId('rfh-sec16-patched-banner')).toBeNull();
    expect(screen.queryByTestId('rfh-sec16-failed-banner')).toBeNull();
  });

  // ── null result — no banners, no crash ────────────────────────────────────
  it('renders nothing and does not throw when result is null', () => {
    render(<KeyProgSec16Banners result={null} />);

    expect(screen.queryByTestId('rfh-sec16-patched-banner')).toBeNull();
    expect(screen.queryByTestId('rfh-sec16-failed-banner')).toBeNull();
  });
});
