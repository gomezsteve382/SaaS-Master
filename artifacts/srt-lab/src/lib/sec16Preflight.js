/* ============================================================================
 * sec16Preflight.js — Task #678
 *
 * Pure pre-flight that converts a (classification, crossValidate, modules)
 * triple into a GO/SYNC_REQUIRED/NO_GO/LIVE_ONLY/INSUFFICIENT_DATA verdict
 * plus the ordered list of remediation actions a tech should run before
 * touching Program New Key.
 *
 * Status semantics
 *   GO                  — every required rule reports MATCH; safe to program.
 *   SYNC_REQUIRED       — at least one required rule mismatches AND every
 *                         mismatch has a known sync action listed in
 *                         `actions`. Run the actions then re-evaluate.
 *   NO_GO               — at least one required rule mismatches AND we have
 *                         no sync remedy (e.g. VIN mismatch across modules,
 *                         95640 secret key MISMATCH on a WK2 dump).
 *   LIVE_ONLY           — platform classifier marked the platform live-only
 *                         (XC2268 RFHUB / 2019+ Ram). Offline pre-flight is
 *                         meaningless; run the live SEC16 read.
 *   INSUFFICIENT_DATA   — required modules for the platform are not loaded
 *                         yet. Caller should prompt the operator to load
 *                         the BCM / RFHUB / PCM / 95640 dumps.
 *
 * The mapping from crossValidate output strings → action ids is the most
 * brittle bit. crossValidate.js emits a small fixed vocabulary of message
 * prefixes (each one a single source of truth — see Task #380/#385/#404/
 * #409) so we substring-match those prefixes here. Adding a new rule
 * means BOTH editing the substring table here AND adding the prefix on
 * the producer side; the e2e platform tests in
 * `__tests__/sec16Preflight.platforms.test.js` exercise every entry.
 * ========================================================================== */

import { classifyPlatform } from './sec16Platforms.js';

/* Order matters — first matching prefix wins. */
const RULE_MATCHERS = [
  {
    ruleId: 'rfhub-bcm-sec16',
    severity: 'blocker',
    test: (m) => m.startsWith('RFHUB ↔ BCM vehicle secret: MISMATCH'),
    action: {
      id: 'rfh-bcm-sec16-sync',
      label: 'Apply RFHUB → BCM SEC16 sync (split + mirrors)',
      target: 'BCM',
    },
  },
  {
    ruleId: 'bcm-flat-staleness',
    severity: 'warning',
    test: (m) => m.startsWith('BCM legacy flat 0x40C9 STALE'),
    action: {
      id: 'flat-40c9-repair',
      label: 'Repair flat 0x40C9 from split records',
      target: 'BCM',
    },
  },
  {
    ruleId: 'rfhub-sec16-self',
    severity: 'blocker',
    test: (m) => m.startsWith('RFHUB SEC16: Slot 1/2 MISMATCH'),
    action: null,
  },
  {
    ruleId: 'rfhub-sec16-self',
    severity: 'warning',
    test: (m) => m.startsWith('RFHUB SEC16: BLANK'),
    action: null,
  },
  {
    ruleId: 'bcm-pcm-sec6',
    severity: 'blocker',
    test: (m) => m.startsWith('BCM SEC16 → SEC6 ↔ PCM SEC6:'),
    action: {
      id: 'bcm-pcm-sec6-sync',
      label: 'Apply BCM → PCM SEC6 sync',
      target: 'PCM',
    },
  },
  {
    ruleId: 'rfhub-pcm-sec6',
    severity: 'warning',
    test: (m) => m.startsWith('RFHUB SEC16[0:6] ↔ PCM SEC6: MISMATCH'),
    action: {
      id: 'rfh-pcm-sec6-sync',
      label: 'Apply RFHUB → PCM SEC6 sync',
      target: 'PCM',
    },
  },
  {
    ruleId: 'pcm-sec6-damaged',
    severity: 'blocker',
    test: (m) => m.startsWith('PCM SEC6 @ 0x3C8:') && m.includes('IMMO_DAMAGED'),
    action: {
      id: 'rfh-pcm-sec6-sync',
      label: 'Apply RFHUB → PCM SEC6 sync (or BCM → PCM if no RFHUB loaded)',
      target: 'PCM',
    },
  },
  {
    ruleId: 'rfhub-95640-skey',
    severity: 'blocker',
    test: (m) => m.startsWith('95640 ↔ RFHUB secret key: MISMATCH'),
    action: null,
  },
  {
    ruleId: 'rfhub-95640-bcm-sec16',
    severity: 'warning',
    test: (m) => m.startsWith('RFHUB SEC16 ↔ 95640 BCM-SEC16'),
    action: {
      id: 'rfh-95640-bcm-sec16-sync',
      label: 'Apply RFHUB → 95640 BCM-SEC16 sync (reversed @ 0x838)',
      target: '95640',
    },
  },
  {
    ruleId: 'vin-consistency',
    severity: 'blocker',
    test: (m) => m.startsWith('VIN MISMATCH'),
    action: null,
  },
  {
    ruleId: 'xc2268-live-only',
    severity: 'warning',
    test: (m) => m.startsWith('XC2268 RFHUB'),
    action: null,
  },
];

function matchRule(message) {
  for (const r of RULE_MATCHERS) {
    if (r.test(message)) return r;
  }
  return null;
}

function moduleTypePresent(modules, t) {
  return (modules || []).some((m) => m && m.type === t);
}

function moduleSetForPlatform(platform, modules) {
  const need = { BCM: false, RFHUB: false, GPEC2A: false, '95640': false };
  switch (platform) {
    case 'wk2-jeep':
    case 'wd-durango':
      need.BCM = need.RFHUB = need.GPEC2A = need['95640'] = true;
      break;
    case 'lx-ld':
    case 'unknown':
      need.BCM = need.RFHUB = need.GPEC2A = true;
      break;
    case 'dt-ram-2019plus':
      /* live-only — nothing required offline */
      break;
    default:
      break;
  }
  const missing = [];
  for (const t of Object.keys(need)) {
    if (need[t] && !moduleTypePresent(modules, t)) missing.push(t);
  }
  return { need, missing };
}

/**
 * Evaluate a SEC16 pre-flight verdict.
 *
 * @param {object} args
 * @param {string|null} args.vin            17-char master VIN
 * @param {Array}        args.modules        parseModule() results
 * @param {object}       args.crossValidate  { issues, warnings, passed }
 * @returns {{
 *   status: 'GO'|'SYNC_REQUIRED'|'NO_GO'|'LIVE_ONLY'|'INSUFFICIENT_DATA',
 *   classification: object,
 *   summary: string,
 *   blockers: Array<{ruleId, severity, message, action: object|null}>,
 *   warnings: Array<{ruleId, severity, message, action: object|null}>,
 *   passed: string[],
 *   actions: Array<{id, label, target}>,
 *   missingModules: string[],
 *   canProgramKey: boolean,
 * }}
 */
export function evaluateSec16Preflight({ vin = null, modules = [], crossValidate = {} } = {}) {
  const classification = classifyPlatform({ vin, modules });
  const issues = Array.isArray(crossValidate.issues) ? crossValidate.issues : [];
  const warnings = Array.isArray(crossValidate.warnings) ? crossValidate.warnings : [];
  const passed = Array.isArray(crossValidate.passed) ? crossValidate.passed : [];

  if (classification.liveOnly) {
    return {
      status: 'LIVE_ONLY',
      classification,
      summary: `${classification.label}: offline SEC16 not stored in flash. Read live over OBD.`,
      blockers: [],
      warnings: [],
      passed: [],
      actions: [],
      missingModules: [],
      canProgramKey: false,
    };
  }

  const { missing } = moduleSetForPlatform(classification.platform, modules);
  if (missing.length > 0) {
    return {
      status: 'INSUFFICIENT_DATA',
      classification,
      summary: `Load ${missing.join(' + ')} dump${missing.length === 1 ? '' : 's'} for ${classification.label} before pre-flight.`,
      blockers: [],
      warnings: [],
      passed: [],
      actions: [],
      missingModules: missing,
      canProgramKey: false,
    };
  }

  const annotatedBlockers = [];
  const annotatedWarnings = [];
  const actionsById = new Map();

  const consider = (message, defaultSeverity) => {
    const rule = matchRule(message);
    if (!rule) {
      if (defaultSeverity === 'blocker') {
        annotatedBlockers.push({ ruleId: 'unknown', severity: 'blocker', message, action: null });
      }
      return;
    }
    const entry = { ruleId: rule.ruleId, severity: rule.severity, message, action: rule.action || null };
    if (rule.severity === 'blocker') annotatedBlockers.push(entry);
    else annotatedWarnings.push(entry);
    if (rule.action && !actionsById.has(rule.action.id)) {
      actionsById.set(rule.action.id, rule.action);
    }
  };

  issues.forEach((m) => consider(m, 'blocker'));
  warnings.forEach((m) => consider(m, 'warning'));

  /* Task #678 (post-review) — promote any matched WARNING entry whose
   * ruleId appears in the platform's requiredRules list to a BLOCKER.
   * Without this, a wk2/wd dump can show GO even though
   * `rfhub-95640-bcm-sec16` (matched as severity:'warning' in the
   * matcher table) is mis-aligned — which is exactly the failure mode
   * a tech is asking pre-flight to catch. The matcher severities stay
   * as the conservative default; classification.requiredRules is the
   * authoritative gate per platform. */
  const requiredIds = new Set(classification.requiredRules || []);
  for (let i = annotatedWarnings.length - 1; i >= 0; i--) {
    const w = annotatedWarnings[i];
    if (requiredIds.has(w.ruleId)) {
      const promoted = { ...w, severity: 'blocker' };
      annotatedBlockers.push(promoted);
      annotatedWarnings.splice(i, 1);
      if (promoted.action && !actionsById.has(promoted.action.id)) {
        actionsById.set(promoted.action.id, promoted.action);
      }
    }
  }

  let status;
  if (annotatedBlockers.length === 0 && annotatedWarnings.length === 0) {
    status = 'GO';
  } else {
    const allBlockersFixable = annotatedBlockers.every((b) => !!b.action);
    if (annotatedBlockers.length === 0) status = 'GO'; /* warnings only — soft GO */
    else status = allBlockersFixable ? 'SYNC_REQUIRED' : 'NO_GO';
  }

  /* If warnings-only with no blockers, still allow programming but flag the
   * actions so the operator can apply the optional sync first. */
  const canProgramKey = status === 'GO';

  let summary;
  if (status === 'GO') {
    summary = `${classification.label}: SEC16 chain verified across ${Object.keys(moduleSetForPlatform(classification.platform, modules).need).filter((t) => moduleTypePresent(modules, t)).join(' + ')} — safe to program.`;
  } else if (status === 'SYNC_REQUIRED') {
    summary = `${classification.label}: ${annotatedBlockers.length} sync action${annotatedBlockers.length === 1 ? '' : 's'} required before key programming.`;
  } else {
    summary = `${classification.label}: ${annotatedBlockers.length} unresolved issue${annotatedBlockers.length === 1 ? '' : 's'} — no automatic remedy. Review dumps before any write.`;
  }

  return {
    status,
    classification,
    summary,
    blockers: annotatedBlockers,
    warnings: annotatedWarnings,
    passed: [...passed],
    actions: Array.from(actionsById.values()),
    missingModules: [],
    canProgramKey,
  };
}
