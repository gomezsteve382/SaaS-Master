import React from 'react';

/* ============================================================================
 * ProgrammerSizeHelp — single source of truth for the
 * "Programmer says 'File different size'?" help blurb.
 *
 * The same message used to be hand-copied into three workspaces where a
 * tech can hit the wrong-size flasher error:
 *   - tabs/ModuleSync.jsx        (testid="modsync-programmer-size-help")
 *   - tabs/RFHPCMTab.jsx         (testid="obdwiz-programmer-size-help")
 *   - App.jsx DumpsTabV2         (testid="dumps-programmer-size-help")
 *
 * Each call site now imports this component so the canonical wording
 * (header + 4KB / 8KB chip rule + "re-read EXT EEPROM, not INT FLASH")
 * cannot drift between workspaces. The site-specific tail (which
 * button/badge to look at in *this* tab) is passed in via the `tail`
 * prop, and each site keeps its own `testId` so existing UI tests
 * still resolve.
 *
 * `variant` controls the box chrome only:
 *   'accent' — solid 1px blue accent strip (Module Sync, OBD wizard)
 *   'teal'   — dashed teal strip used by the dumps workspace
 * ========================================================================== */

const VARIANTS = {
  accent: {
    background: '#2979FF0E',
    border: '1px solid #2979FF40',
    headerColor: '#2979FF',
    bodyColor: '#1A1A1A',
    errorColor: '#FF1744',
  },
  teal: {
    background: 'rgba(0,131,143,0.08)',
    border: '1px dashed rgba(0,131,143,0.45)',
    headerColor: '#00565E',
    bodyColor: '#1A1A1A',
    errorColor: '#FF1744',
  },
};

export default function ProgrammerSizeHelp({
  testId,
  variant = 'accent',
  tail = null,
  style = null,
}) {
  const v = VARIANTS[variant] || VARIANTS.accent;
  return (
    <div data-testid={testId} style={{
      marginTop: 12, padding: '10px 14px', borderRadius: 10,
      background: v.background, border: v.border,
      color: v.bodyColor, fontSize: 11, fontWeight: 600, lineHeight: 1.5,
      ...(style || {}),
    }}>
      <div style={{
        fontWeight: 800, fontSize: 11, color: v.headerColor,
        letterSpacing: 0.5, marginBottom: 4,
      }}>
        ❓ Programmer says &quot;File different size&quot;?
      </div>
      The CGDI / Xprog / Orange5 / Multi-PROG / Xhorse flasher refuses
      any image whose byte count doesn&apos;t match the chip on the bench.
      The PCM EXT EEPROM must be exactly <strong>4 KB (95320)</strong> or{' '}
      <strong>8 KB (95640)</strong>. The size badge on each loaded PCM
      shows the live byte count and chip class — re-read the EXT EEPROM
      (not INT FLASH) if it shows{' '}
      <span style={{ color: v.errorColor, fontWeight: 800 }}>OTHER</span>.
      {tail ? <> {tail}</> : null}
    </div>
  );
}
