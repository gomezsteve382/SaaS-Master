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
  PCM:        { label: 'Engine computer',       tip: 'PCM — engine computer (Continental GPEC2A, 4 KB or 8 KB EEPROM). Must hold a matching immobilizer token or the engine will not start.' },
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

  /* Engine / module families */
  ECM:        { label: 'Engine computer',       tip: 'ECM — Engine Control Module. Same role as PCM on FCA platforms; runs the engine and holds the immobilizer key.' },
  ECU:        { label: 'Module',                tip: 'ECU — Electronic Control Unit. Generic name for any in-vehicle module (BCM, PCM, RFHUB are all ECUs).' },

  /* Memory / storage */
  EEPROM:     { label: 'Memory chip',           tip: 'EEPROM — small electrically-erasable memory chip used inside modules (95640, 24C32, etc.) to store keys and settings.' },
  '95320':    { label: 'GPEC2A storage chip',   tip: '95320 — the SPI EEPROM inside the GPEC2A engine computer that holds its security data.' },
  '24C32':    { label: 'RFHUB storage chip',    tip: '24C32 — the older EEPROM chip used inside Gen1 RFHUBs to hold the immobilizer token.' },

  /* Bus / protocols */
  CAN:        { label: 'Vehicle data bus',      tip: 'CAN — Controller Area Network. The in-vehicle wiring all modules use to talk to each other and to diagnostic tools.' },
  ISO15765:   { label: 'CAN transport',         tip: 'ISO 15765 — the CAN-bus transport that wraps UDS messages so multi-frame requests can be sent over CAN.' },
  UDS:        { label: 'Diagnostic protocol',   tip: 'UDS (ISO 14229) — Unified Diagnostic Services, the request/response protocol used to read, write and unlock modern ECUs.' },
  J2534:      { label: 'PassThru cable API',    tip: 'J2534 — the standard PassThru API used by MaxiFlash, Gould and DrewTech cables to talk to vehicle CAN buses from a PC.' },
  OBD:        { label: 'Diagnostic port',       tip: 'OBD — On-Board Diagnostics. The 16-pin port under the dash where diagnostic cables plug in.' },

  /* Cables / tools */
  MAXIFLASH:  { label: 'Autel J2534 cable',     tip: 'MaxiFlash — Autel\'s J2534 PassThru cable. Used by SRT Lab to talk to the vehicle from Windows.' },
  GOULD:      { label: 'Gould J2534 cable',     tip: 'Gould — a high-end J2534 PassThru cable favoured for stable flashing sessions.' },
  ELM327:     { label: 'Cheap OBD chip',        tip: 'ELM327 — a low-cost OBD2 chip. Not used here because it cannot run UDS or J2534 sessions.' },
  AUTEL:      { label: 'Autel',                 tip: 'Autel — maker of the IM608 key programmer and the MaxiFlash J2534 cable.' },
  IM608:      { label: 'Autel key programmer',  tip: 'IM608 — Autel\'s flagship key programmer / diagnostic tablet, used for FOBIK pairing.' },

  /* Security algorithms */
  XTEA:       { label: 'Seed→key cipher',       tip: 'XTEA — eXtended TEA, the small block cipher used inside several FCA seed-to-key challenges.' },
  CDA6:       { label: 'FCA unlock handshake',  tip: 'CDA6 — Chrysler Diagnostic Algorithm 6, the modern FCA seed/key handshake used to authenticate before writing.' },
  FCA:        { label: 'Fiat Chrysler',         tip: 'FCA — Fiat Chrysler Automobiles. The platform group whose security algorithms the unlock-test runs against.' },
  SEEDKEY:    { label: 'Seed→key handshake',    tip: 'Seed→Key — the challenge/response the ECU uses to verify a tool before allowing security-level writes.' },

  /* BCM internals */
  ZZZZ:       { label: 'Tamper marker',         tip: 'ZZZZ — a marker pattern in the BCM that signals the immobilizer firmware that the security area has been cleared.' },
  AA50:       { label: 'FOBIK slot marker',     tip: 'AA50 — marker bytes inside the BCM that count and bound the FOBIK key slots.' },
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
    return { plain: 'The engine computer\'s immobilizer key is missing or damaged. The engine will not start. Open the Module Sync tab and load your RFHUB dump alongside this PCM — the tool will copy the correct security bytes from the RFHUB into the PCM and download a patched .bin.', term: 'SEC6' };
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

/* ─── Detect a "common scenario" for true 1-click pairing ───────────────────
 * Recognizes the handful of bench setups people actually run on a daily basis
 * and labels them in plain English. When a scenario matches, the wizard skips
 * the multi-section "what you have / what's wrong / what I'll do / FIX IT"
 * breakdown and shows a single "Confirm & Download" button instead.
 *
 * Returns null when the loaded modules / issues don't match a recognized
 * shape — callers should fall back to pickRecommendedFix() for those.
 *
 *   key            : machine id, e.g. 'pair-rfhub-to-bcm'
 *   name           : plain-English scenario name shown in the UI
 *   actionId       : id to pass to onAction()
 *   summary        : 1-line description of what will happen
 *   modulesAffected: which modules will get patched .bin files
 *   targetVin      : best-guess master VIN
 * ─────────────────────────────────────────────────────────────────────────── */
export function detectCommonScenario({ issues = [], warnings = [], stepActions = [], modules = [], hexSnippets = [] } = {}) {
  /* Need an enabled action to be a true 1-click. */
  const enabled = new Set(stepActions.filter(a => a.enabled).map(a => a.id));
  if (enabled.size === 0) return null;

  /* Need *something* worth fixing — otherwise SimpleFlow's empty/ok state
   * already takes over. */
  if (issues.length === 0 && warnings.length === 0) return null;

  const mods = new Set((modules || []).map(m => String(m).toUpperCase()));
  const issueText = issues.join(' | ').toUpperCase();
  const vinMismatch    = issueText.includes('VIN MISMATCH');
  const sec16Mismatch  = issueText.includes('SEC16') && (issueText.includes('MISMATCH') || issueText.includes('INVALID'));
  const sec6Damaged    = issueText.includes('PCM SEC6') || issueText.includes('IMMO_DAMAGED');
  const secretMismatch = issueText.includes('VEHICLE SECRET');
  const bcmToRfhSec16  = issueText.includes('BCM SEC16') && issueText.includes('RFHUB');

  const vins = extractVins(hexSnippets);
  const targetVin = vins.RFHUB || vins.BCM || vins.PCM || null;

  /* ── Scenario A: BCM + RFHUB pair (no PCM) ───────────────────────────────
   * Most common bench setup: someone has a donor RFHUB and the car's BCM,
   * or vice versa, and just wants the two to agree. */
  if (mods.has('BCM') && mods.has('RFHUB') && !mods.has('PCM')) {
    /* BCM has a good token, RFHUB doesn't → use BCM as master */
    if (bcmToRfhSec16 && !vinMismatch && enabled.has('bcm-sec16-to-rfh')) {
      return {
        key: 'bcm-sec16-to-rfhub',
        name: 'Copy BCM token into the key receiver',
        actionId: 'bcm-sec16-to-rfh',
        summary: 'BCM is the master. Its immobilizer token will be written into the key receiver so they share the same secret.',
        modulesAffected: ['RFHUB'],
        targetVin,
      };
    }
    /* SEC16-only mismatch (no VIN issue) → narrower 1-click. Checked
     * before the broader full-pair branch so we don't over-write VINs
     * when only the immobilizer token needs syncing. */
    if (sec16Mismatch && !vinMismatch && !secretMismatch && enabled.has('sec16-only')) {
      return {
        key: 'sec16-only-pair',
        name: 'Sync immobilizer token (RFHUB → BCM)',
        actionId: 'sec16-only',
        summary: 'Copy the immobilizer token from the key receiver into the BCM. VINs are left unchanged.',
        modulesAffected: ['BCM'],
        targetVin,
      };
    }
    /* VIN / SEC16+VIN / vehicle-secret mismatch → full pair using RFHUB as master */
    if ((vinMismatch || sec16Mismatch || secretMismatch) && enabled.has('full-sync')) {
      return {
        key: 'pair-rfhub-to-bcm',
        name: 'Pair RFHUB to BCM',
        actionId: 'full-sync',
        summary: targetVin
          ? `Stamp VIN ${targetVin} into both modules and copy the immobilizer token from the key receiver into the BCM.`
          : 'Stamp the same VIN into both modules and copy the immobilizer token from the key receiver into the BCM.',
        modulesAffected: ['BCM', 'RFHUB'],
        targetVin,
      };
    }
  }

  /* ── Scenario B: BCM + RFHUB + PCM (full 3-module pair) ──────────────────
   * The "everything on the bench" case. Treat as a true 1-click when there
   * is any IMMO-class problem and full-sync is available. */
  if (mods.has('BCM') && mods.has('RFHUB') && mods.has('PCM') &&
      (vinMismatch || sec16Mismatch || sec6Damaged || secretMismatch) &&
      enabled.has('full-sync')) {
    return {
      key: 'pair-all-three',
      name: 'Pair BCM + RFHUB + Engine computer',
      actionId: 'full-sync',
      summary: targetVin
        ? `Stamp VIN ${targetVin} into all three modules and rebuild the immobilizer token + engine immobilizer key from the key receiver.`
        : 'Stamp the same VIN into all three modules and rebuild the immobilizer token + engine immobilizer key from the key receiver.',
      modulesAffected: ['BCM', 'RFHUB', 'PCM'],
      targetVin,
    };
  }

  /* ── Scenario C: GPEC2A engine computer + 95640 BCM backup chip ─────────
   * The 95640 EEPROM mirrors the BCM key data and is paired with the GPEC2A
   * engine computer for off-bench recovery. When both are loaded and an
   * IMMO-class problem is reported, this is a true 1-click re-key from the
   * 95640 / RFHUB master into the engine computer. The consumer wires this
   * up by enabling a `gpec2a-95640-pair` action; if that's not available we
   * fall back to whatever PCM-write action the consumer does expose
   * (full-sync, sec16-only). */
  const hasPcm    = mods.has('GPEC2A') || mods.has('PCM');
  const hasEeprom = mods.has('95640');
  const eepromMismatch = issueText.includes('95640') && (issueText.includes('MISMATCH') || issueText.includes('BLANK'));
  const immoIssue = vinMismatch || sec16Mismatch || sec6Damaged || secretMismatch || eepromMismatch;

  /* ── Scenario E: RFHUB + 95640 BCM backup chip (no PCM) ────────────────
   * The 95640 EEPROM mirrors the BCM key data. When the user has only the
   * RFHUB (master) + the 95640 backup chip on the bench — typically after
   * replacing the chip — the 1-click flow is to copy the RFHUB token
   * (byte-reversed) into the 95640 so it mirrors the rest of the vehicle.
   * The consumer wires this up by enabling a `rekey-95640-from-rfh` action;
   * if that's not available we fall back to whatever sec16 action exists. */
  if (mods.has('RFHUB') && hasEeprom && !hasPcm && !mods.has('BCM') && immoIssue) {
    let actionId = null;
    if (enabled.has('rekey-95640-from-rfh')) actionId = 'rekey-95640-from-rfh';
    else if (enabled.has('sec16-only'))      actionId = 'sec16-only';
    if (actionId) {
      return {
        key: 'rekey-95640-from-rfhub',
        name: 'Re-key 95640 from RFHUB',
        actionId,
        summary: 'Use the RFHUB as master and copy its immobilizer token (byte-reversed) into the 95640 BCM backup chip so the chip mirrors the rest of the vehicle.',
        modulesAffected: ['95640'],
        targetVin,
      };
    }
  }

  if (hasPcm && hasEeprom && immoIssue) {
    let actionId = null;
    if (enabled.has('gpec2a-95640-pair'))      actionId = 'gpec2a-95640-pair';
    else if (enabled.has('full-sync'))         actionId = 'full-sync';
    else if (enabled.has('sec16-only'))        actionId = 'sec16-only';
    if (actionId) {
      return {
        key: 'pair-gpec2a-95640',
        name: 'Pair GPEC2A engine computer to 95640 backup chip',
        actionId,
        summary: 'Re-key the engine computer from the 95640 backup chip so the SEC6 immobilizer key + VIN match the rest of the vehicle.',
        modulesAffected: ['PCM', '95640'],
        targetVin,
      };
    }
  }

  /* ── Scenario D: Single-module VIN re-flash ──────────────────────────────
   * Only one module loaded. If a VIN re-stamp action is enabled and the
   * issue is VIN-shaped, this is a true 1-click. */
  if (mods.size === 1) {
    const onlyMod = [...mods][0];
    if (vinMismatch || issueText.includes('VIN')) {
      if (onlyMod === 'BCM' && enabled.has('rfh-to-bcm')) {
        return {
          key: 'restamp-bcm-vin',
          name: 'Re-stamp VIN into the BCM',
          actionId: 'rfh-to-bcm',
          summary: targetVin
            ? `Write VIN ${targetVin} into the BCM and refresh its checksum.`
            : 'Write the master VIN into the BCM and refresh its checksum.',
          modulesAffected: ['BCM'],
          targetVin,
        };
      }
      if (onlyMod === 'RFHUB' && enabled.has('bcm-to-rfh')) {
        return {
          key: 'restamp-rfhub-vin',
          name: 'Re-stamp VIN into the key receiver',
          actionId: 'bcm-to-rfh',
          summary: targetVin
            ? `Write VIN ${targetVin} into the key receiver and refresh its checksum.`
            : 'Write the master VIN into the key receiver and refresh its checksum.',
          modulesAffected: ['RFHUB'],
          targetVin,
        };
      }
    }
  }

  return null;
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
