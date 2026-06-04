/* ============================================================================
 * sec16SourceLabel.js — single source of truth for the BCM SEC16 provenance
 * label rendered next to BCM SEC16 hex throughout the app.
 *
 * Formats:
 *   { source: 'split',   offset: 0x81A0 } → 'split @0x81A0'
 *   { source: 'mirror1', offset: 0x40C0 } → 'mirror1 0xEB @0x40C0'
 *   { source: 'mirror2', offset: 0x40E8 } → 'mirror2 0xCA @0x40E8'
 *   { source: 'flat',    offset: 0x40C9 } → 'flat @0x40C9 (legacy)'
 *   { source: anything else }              → '(no SEC16 source)'
 *   null / undefined                       → null  (caller decides whether
 *                                                   to render anything)
 *
 * Task #471 — promoted from three near-identical copies that lived in
 * components/MismatchWizard.jsx, lib/keyProgWizard.js, and
 * components/ModuleFieldsPanel.jsx. Several UI tests pin the exact strings
 * (wizardSec16Badge.ui.test.jsx, keyProgArchiveHistory.test.jsx,
 * keyProgZipSummaryProvenance.test.jsx, keyProgTab.ui.test.jsx) so any
 * future tweak should happen here and then be re-asserted across all four
 * suites at once.
 * ========================================================================== */

function formatOffsetHex(n) {
  if (n == null) return '0x????';
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
}

export function formatBcmSec16SourceLabel(status) {
  if (status == null) return null;
  const off = formatOffsetHex(status.offset);
  switch (status.source) {
    case 'split':   return 'split @' + off;
    case 'mirror1': return 'mirror1 0xEB @' + off;
    case 'mirror2': return 'mirror2 0xCA @' + off;
    case 'flat':    return 'flat @0x40C9 (legacy)';
    default:        return '(no SEC16 source)';
  }
}
