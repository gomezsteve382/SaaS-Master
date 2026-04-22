import React from "react";

/* ============================================================================
 * plainEnglish.js — translation layer for the wizard + Security Byte tab.
 *
 *   • JARGON       : map of internal terms → { label, tip }
 *   • Tip          : <Tip word="SEC16">SEC16</Tip>  (renders with a hover title)
 *   • translateIssue(raw)             : raw cross-validate string → plain English
 *   • pickRecommendedFix({ ... })     : auto-pick the right sync action
 * ========================================================================== */

export const JARGON = {
  VIN:        { label: 'VIN',                   tip: 'Vehicle Identification Number — the 17-character chassis ID printed on the dashboard.' },
  BCM:        { label: 'BCM',                   tip: 'Body Control Module — runs lights, locks, key-fob pairing and stores the immobilizer token.' },
  RFHUB:      { label: 'Key receiver',          tip: 'RFHUB / FCM — the module that listens for the key fob and holds the master immobilizer secret.' },
  PCM:        { label: 'Engine computer',       tip: 'PCM — engine computer (GPEC2A / GPEC5). Must hold a matching immobilizer token or the engine will not start.' },
  SEC16:      { label: 'Immobilizer token',     tip: 'SEC16 — the 16-byte secret BCM and key receiver share so the engine knows it is the right car.' },
  SEC6:       { label: 'Engine immobilizer key', tip: 'SEC6 — the first 6 bytes of the immobilizer token, copied into the engine computer.' },
  IMMO:       { label: 'Immobilizer',           tip: 'Immobilizer — the anti-theft system that blocks engine start until all modules agree on the secret.' },
  SKIM:       { label: 'Anti-theft enable',     tip: 'SKIM — the byte in the engine computer that turns the immobilizer system on or off.' },
  FOBIK:      { label: 'Key fob',               tip: 'FOBIK — slot for a paired key fob. Each programmed key takes one slot.' },
  CRC8:       { label: 'Checksum',              tip: 'CRC8 — a small integrity check appended to data so corrupt bytes are caught.' },
  CRC16:      { label: 'Checksum',              tip: 'CRC16 — a 16-bit integrity check appended to security data.' },
  GPEC2A:     { label: 'Engine computer',       tip: 'GPEC2A — the Continental engine computer used in SRT/Demon platforms.' },
  '95640':    { label: 'BCM backup chip',       tip: '95640 — the EEPROM chip that mirrors the BCM key data, used as a backup or for off-bench recovery.' },
  'D-FLASH':  { label: 'BCM storage',           tip: 'D-FLASH — the non-volatile area inside the BCM where keys and the immobilizer token live.' },
  VIRGIN:     { label: 'Erased / factory blank', tip: 'Virgin — the security area is wiped to all FF, as if the module just left the factory. Forces a fresh re-pair.' },
  VIRGINIZE:  { label: 'Wipe security data',    tip: 'Virginize — deliberately erase the security area so the modules will negotiate a fresh secret on next power-up.' },
  GEN2:       { label: 'Newer key receiver',    tip: 'Gen2 — the newer RFHUB layout (post-2018). Stores its immobilizer token at different offsets than Gen1.' },
};

const TIP_STYLE = {
  borderBottom: '1px dotted currentColor',
  cursor: 'help',
};

/* Inline tooltip: <Tip word="SEC16">immobilizer token</Tip> */
export function Tip({ word, children }) {
  const j = JARGON[word?.toUpperCase()];
  if (!j) return <span>{children ?? word}</span>;
  return (
    <span title={j.tip} style={TIP_STYLE}>
      {children ?? j.label}
    </span>
  );
}

/* ─── Issue → plain-English string + key term to highlight ─── */
export function translateIssue(raw) {
  const u = (raw || '').toUpperCase();
  if (u.includes('VIN MISMATCH'))
    return { plain: 'The BCM and key receiver were taken from different cars — their VINs do not match.', term: 'VIN' };
  if (u.includes('SEC16') && (u.includes('MISMATCH') || u.includes('INVALID')))
    return { plain: 'The immobilizer token in the BCM does not match the one in the key receiver. The engine will refuse to start until they match.', term: 'SEC16' };
  if (u.includes('PCM SEC6') || u.includes('IMMO_DAMAGED'))
    return { plain: 'The engine computer\'s immobilizer key is missing or damaged. The engine will not start.', term: 'SEC6' };
  if (u.includes('VEHICLE SECRET'))
    return { plain: 'The shared vehicle secret stored in the BCM and key receiver disagree. The immobilizer handshake will fail.', term: 'IMMO' };
  if (u.includes('BCM PN MISMATCH'))
    return { plain: 'The BCM part number is unusual for this vehicle family. Key fob pairing may not behave normally.', term: 'BCM' };
  if (u.includes('BCM SEC16') && u.includes('RFHUB'))
    return { plain: 'The BCM has a good immobilizer token but the key receiver does not. The receiver needs the BCM\'s token written into it.', term: 'SEC16' };
  if (u.includes('GPEC2A') && u.includes('KEY'))
    return { plain: 'The engine computer\'s internal secret keys disagree with each other. The dump may be corrupt or incomplete.', term: 'PCM' };
  if (u.includes('95640') && u.includes('MISMATCH'))
    return { plain: 'The BCM backup chip has a different secret than the key receiver. Key re-pairing may fail in some scenarios.', term: '95640' };
  if (u.includes('SKIM'))
    return { plain: 'The engine computer\'s anti-theft system is in an unexpected state.', term: 'SKIM' };
  if (u.includes('SLOT 1/2 MISMATCH'))
    return { plain: 'The two copies of the immobilizer token inside the key receiver disagree. One slot may have been written by a different tool.', term: 'SEC16' };
  if (u.includes('BLANK'))
    return { plain: 'A security area is erased (factory blank). The modules will negotiate a fresh secret on next power-up.', term: 'VIRGIN' };
  return { plain: raw, term: null };
}

/* ─── Extract VINs from hexSnippets like "BCM VIN @0xXXXX: VIN" ─── */
export function extractVins(hexSnippets = []) {
  const result = {};
  for (const s of hexSnippets) {
    const m = s.match(/^(BCM|RFHUB|PCM)\s+VIN[^:]*:\s*([A-HJ-NPR-Z0-9]{17})/i);
    if (m) result[m[1].toUpperCase()] = m[2].toUpperCase();
  }
  return result;
}

/* ─── Auto-pick the correct sync action ─────────────────────────────────────
 * Given the issues + warnings + which sync actions are enabled, return one
 * "Recommended fix" object describing what the wizard should do.
 *
 *   actionId      : id to pass to onAction()
 *   title         : one-line headline ("I can fix this in 1 click")
 *   summary       : 1-2 sentence plain-English summary
 *   plan          : array of plain-English bullets describing what will change
 *   targetVin     : VIN that will be stamped (best guess: RFHUB > BCM)
 *   modulesAffected : ['BCM', 'RFHUB', 'PCM'] etc.
 *   why           : one sentence on why this matters
 * Returns null if no fix is needed or no action is available.
 * ─────────────────────────────────────────────────────────────────────────── */
export function pickRecommendedFix({ issues = [], warnings = [], stepActions = [], modules = [], hexSnippets = [] } = {}) {
  const enabled = new Set(stepActions.filter(a => a.enabled).map(a => a.id));
  const has = (id) => enabled.has(id);

  const issueText = issues.join(' | ').toUpperCase();
  const vinMismatch    = issueText.includes('VIN MISMATCH');
  const sec16Mismatch  = issueText.includes('SEC16') && (issueText.includes('MISMATCH') || issueText.includes('INVALID'));
  const sec6Damaged    = issueText.includes('PCM SEC6') || issueText.includes('IMMO_DAMAGED');
  const secretMismatch = issueText.includes('VEHICLE SECRET');

  /* No real problems — nothing to recommend */
  if (issues.length === 0 && warnings.length === 0) return null;

  /* Pick the action that fixes the most pressing problem */
  let actionId = null;
  let title = '';
  let why = '';
  const plan = [];
  const modulesAffected = new Set();

  const vins = extractVins(hexSnippets);
  /* Prefer the RFHUB VIN as the master (it's the immobilizer master in most flows) */
  const targetVin = vins.RFHUB || vins.BCM || vins.PCM || null;

  if (vinMismatch || (sec16Mismatch && sec6Damaged) || secretMismatch) {
    /* Heaviest fix wins — full sync handles VIN + token + engine key in one pass */
    if (has('full-sync')) actionId = 'full-sync';
    else if (has('sec16-only')) actionId = 'sec16-only';
    else if (has('rfh-to-bcm')) actionId = 'rfh-to-bcm';
    title = 'I can re-pair these modules in 1 click.';
    why = 'Without this, the engine will refuse to start because the modules disagree on which car they belong to.';
    if (vinMismatch) plan.push(`Stamp the same VIN (${targetVin || 'master VIN'}) into the BCM, key receiver, and engine computer.`);
    if (sec16Mismatch || secretMismatch) plan.push('Copy the immobilizer token from the key receiver into the BCM (and the first 6 bytes into the engine computer).');
    if (sec6Damaged) plan.push('Repair the engine computer\'s immobilizer key from the key receiver.');
    plan.push('Save patched .bin files for each module so you can flash them.');
    if (has('full-sync')) ['BCM', 'RFHUB', 'PCM'].forEach(m => modulesAffected.add(m));
    else ['BCM', 'RFHUB'].forEach(m => modulesAffected.add(m));
  } else if (sec16Mismatch || sec6Damaged) {
    if (has('sec16-only')) actionId = 'sec16-only';
    else if (has('full-sync')) actionId = 'full-sync';
    else if (has('bcm-sec16-to-rfh')) actionId = 'bcm-sec16-to-rfh';
    title = 'I can match the immobilizer token in 1 click.';
    why = 'Without a matching token, the engine refuses to start even if the keys are programmed.';
    plan.push('Copy the immobilizer token from the key receiver into the BCM.');
    if (sec6Damaged) plan.push('Refresh the engine computer\'s immobilizer key (first 6 bytes of the token).');
    plan.push('Save patched .bin files for each module so you can flash them.');
    ['BCM', 'PCM'].forEach(m => modulesAffected.add(m));
  } else if (issueText.includes('BCM SEC16') && issueText.includes('RFHUB')) {
    if (has('bcm-sec16-to-rfh')) actionId = 'bcm-sec16-to-rfh';
    else if (has('sec16-only')) actionId = 'sec16-only';
    title = 'I can sync these modules in 1 click.';
    why = 'The BCM\'s token will be written into the key receiver so they share the same secret.';
    plan.push('Use the BCM as master and write its immobilizer token into the key receiver.');
    plan.push('Save a patched .bin file for the key receiver so you can flash it.');
    modulesAffected.add('RFHUB');
  }

  if (!actionId) {
    /* Fallback — pick the first enabled action so the user always has a primary button */
    const fallback = stepActions.find(a => a.enabled);
    if (!fallback) return null;
    actionId = fallback.id;
    title = 'I can apply the recommended fix in 1 click.';
    why = 'Resolves the issues detected in your dumps.';
    plan.push(fallback.description || fallback.label);
  }

  return {
    actionId, title, summary: title, plan, targetVin, why,
    modulesAffected: Array.from(modulesAffected).filter(m => modules.includes(m)),
  };
}

/* ─── Plain-English status banner string from cross-validate output ─── */
export function statusBanner({ issues = [], warnings = [], modules = [] } = {}) {
  if (modules.length === 0)
    return { tone: 'neutral', headline: 'Drop module dumps to begin', detail: 'Drag BCM, key receiver (RFHUB), or engine computer (PCM) bins to compare and pair.' };

  const u = issues.join(' | ').toUpperCase();
  if (u.includes('VIN MISMATCH'))
    return { tone: 'error', headline: 'Won\'t start — modules from different cars', detail: 'Your BCM and key receiver report different VINs. Run the guided fix to stamp them with one shared VIN.' };
  if ((u.includes('SEC16') && u.includes('MISMATCH')) || u.includes('PCM SEC6') || u.includes('IMMO_DAMAGED'))
    return { tone: 'error', headline: 'Won\'t start — immobilizer mismatch', detail: 'The immobilizer token doesn\'t match across modules. Run the guided fix to copy the master token everywhere.' };
  if (issues.length > 0)
    return { tone: 'error', headline: `${issues.length} security issue${issues.length === 1 ? '' : 's'} need your attention`, detail: 'Open the guided fix for a plain-English explanation and a 1-click repair.' };
  if (warnings.length > 0)
    return { tone: 'warning', headline: 'Modules paired — minor warnings', detail: 'Things should work, but a few items are worth a look. Open the guided view for details.' };
  return { tone: 'ok', headline: 'Paired — modules ready to flash', detail: 'All security checks passed. You can flash the dumps as-is and power-cycle for 30 seconds.' };
}

/* ─── Session-only Advanced toggle persistence ─── */
const ADV_KEY = (scope) => `srt-advanced:${scope || 'default'}`;

export function loadAdvanced(scope) {
  try { return sessionStorage.getItem(ADV_KEY(scope)) === '1'; }
  catch { return false; }
}

export function saveAdvanced(scope, value) {
  try { sessionStorage.setItem(ADV_KEY(scope), value ? '1' : '0'); }
  catch {}
}
