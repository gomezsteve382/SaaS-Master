/* customerReport — redaction + plain-English layer for the customer-facing
   report/certificate. The tech reports (reportData.js -> buildAnalysisPDF.js)
   print secrets verbatim — secret keys, vehicle secret, FOBIK/IMMO transponder
   hex — and dump the full audit log. A customer copy must NEVER contain any of
   that.

   SECRET LEAK IS THE WHOLE POINT, so redaction is ALLOWLIST-based, not denylist:
   a field is dropped unless its category is explicitly customer-safe AND its
   value contains no 16+ hex-char run. A future secret field with a new category
   label is therefore dropped by default, not leaked. A regression test asserts no
   16-hex run survives in the customer output. */

export const CUSTOMER_SAFE_CATEGORIES = new Set([
  'VIN', 'VIN 1', 'VIN 2', 'ORIGINAL VIN',
  'FOBIK SLOTS', 'FOBIK KEYS', 'KEY COUNT',
  'SW RELEASE', 'PART NUMBER', 'MODEL YEAR', 'ODOMETER',
  'LOCK', 'TAMPER',
]);

const HEX16 = /[0-9A-Fa-f]{16}/;

function valueHasHexRun(v) {
  if (v == null) return false;
  return HEX16.test(String(v).replace(/[^0-9A-Fa-f]/g, ''));
}

/* Is a single reportData field safe to show a customer? Allowlist + hex scrub. */
export function isCustomerSafeField(f) {
  if (!f || !f.category) return false;
  if (f.secret === true) return false;                         // explicit secret flag, if present
  const cat = String(f.category).toUpperCase();
  const allowed =
    CUSTOMER_SAFE_CATEGORIES.has(cat) ||
    /^VIN(\s|$)/.test(cat) ||
    /^PART/.test(cat) ||
    /^SW /.test(cat);
  if (!allowed) return false;
  if (valueHasHexRun(f.value) || valueHasHexRun(f.detail)) return false;  // never emit a hex secret
  return true;
}

/* Strip a module report down to customer-safe fields. */
export function redactModuleReport(reportData) {
  if (!reportData) return reportData;
  return {
    ...reportData,
    fields: (reportData.fields || []).filter(isCustomerSafeField),
    hasSecrets: false,
    customer: true,
  };
}

const STEP_PLAIN = {
  vinWrite: 'Programmed the vehicle VIN',
  sec16Patch: 'Synchronized module security data',
  pairing: 'Paired the replacement module',
  verify: 'Verified the repair on the vehicle',
  manual: 'Completed a manual service step',
};

/* Plain-English description of a fix-plan step (no internal jargon, no secrets). */
export function plainEnglishStep(step) {
  if (!step) return null;
  return STEP_PLAIN[step.action] || (step.label ? String(step.label) : 'Service step');
}

/* Customer-safe job report: drop the audit log entirely, map completed steps to
   plain-English work-performed, keep vehicle + sign-off, scrub any stray fields. */
export function redactJobReport(reportData, { keyCount = null, keyIds = [] } = {}) {
  if (!reportData) return reportData;
  const steps = reportData.steps || [];
  const plainEnglishWork = steps
    .filter(s => s.status === 'ok' || s.status === 'done' || s.status === 'pass')
    .map(plainEnglishStep)
    .filter(Boolean);
  const out = {
    kind: 'customer',
    filename: reportData.filename,
    title: reportData.title,
    vin: reportData.vin,
    status: reportData.status,
    signOff: reportData.signOff,
    plainEnglishWork,
    keySummary: { count: keyCount, ids: Array.isArray(keyIds) ? keyIds.filter(id => !valueHasHexRun(id)) : [] },
    customer: true,
    // NOTE: events/censusRows/blockers/fields deliberately OMITTED — they can
    // carry secrets (audit payloads, secret-key hex). Never spread reportData here.
  };
  return out;
}
