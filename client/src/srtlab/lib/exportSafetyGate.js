/* ============================================================================
 * exportSafetyGate.js — shared pre-download safety gate (Task #1023)
 *
 * Root problem this guards against: a "Sync all" run silently exported an RFH
 * whose SEC16 did not match the BCM, labeled both files _SYNCED and reported
 * success. Flashing that pair bricks the immobilizer. Every security-byte /
 * VIN export path must run the outgoing bytes back through the SAME parser the
 * rest of the app trusts (parseModule) and the SAME cross-module rule engine
 * (crossValidate), and refuse the download on any blocking inconsistency.
 *
 * The gate is deliberately UI-free and synchronous so it can be unit-tested
 * against real bench dumps and reused from any tab's download handler.
 *
 * API
 * ---
 *   checkExportSafety({ outgoing, context }) -> Verdict
 *
 *   outgoing : Array<{ role, bytes, name? }>  files about to be written to disk
 *   context  : Array<{ role, bytes, name? }>  sibling files present in the
 *                                             session that the outgoing set
 *                                             must stay consistent with but
 *                                             that are NOT themselves exported
 *
 *   role     : 'BCM' | 'RFH' | 'PCM' | 'GPEC2A' | '95640' | ... (free-form tag
 *              used only for human-readable messages; the actual module type is
 *              re-derived by parseModule, never trusted from the caller)
 *
 *   Verdict  : {
 *     ok        : boolean,          // false => DO NOT DOWNLOAD
 *     blocking  : string[],         // brick-risk reasons (refuse)
 *     warnings  : string[],         // surfaced but non-blocking
 *     passed    : string[],         // checks that confirmed safe
 *     parsed    : Array<{ role, type, info }>,  // re-parsed outgoing modules
 *   }
 *
 * Design notes
 * ------------
 * - Per-file checksum self-checks run on the OUTGOING bytes only (you cannot
 *   refuse a download because a sibling you are not writing has a bad CRC).
 * - Cross-module checks run crossValidate over outgoing + context together so
 *   a single-file export (e.g. only BCM_SEC16_SYNCED) is still checked against
 *   the RFH it is supposed to match.
 * - crossValidate.issues are treated as blocking (they are the inter-module
 *   contradictions: VIN mismatch, SEC16 mismatch, PCM never paired, secret-key
 *   mismatch). crossValidate.warnings stay non-blocking.
 * ============================================================================ */
import { parseModule } from './parseModule.js';
import { crossValidate } from './crossValidate.js';
import { crc16 } from './crc.js';

const fOff = (n) => (n == null ? '0x????' : '0x' + n.toString(16).toUpperCase().padStart(4, '0'));

/* Per-file self-consistency: every VIN slot CRC must verify and every
 * populated SEC16 record CS must verify. These are the checksums that a flash
 * tool re-derives on write — if they are wrong the module rejects the file (or
 * worse, accepts a corrupt secret). Returns {blocking[], passed[]}. */
function checkFileChecksums(role, info, bytes, selfChecks) {
  const blocking = [];
  const passed = [];
  const tag = role || info.type || 'MODULE';
  const wantVin = selfChecks.includes('vin');
  const wantSec16 = selfChecks.includes('sec16');

  // Full VIN slots
  if (wantVin) {
    const fullVins = info.vins || [];
    let fullBad = 0;
    for (const v of fullVins) {
      if (v.crcOk === false) {
        fullBad++;
        blocking.push(`${tag} VIN slot @${fOff(v.offset)} (${v.vin}) checksum INVALID — flash tool will reject or mispair`);
      }
    }
    if (fullVins.length > 0 && fullBad === 0) {
      passed.push(`${tag}: ${fullVins.length} VIN slot checksum(s) valid`);
    }

    // Partial / tail VIN slots (BCM)
    const partials = info.partialVins || [];
    let partBad = 0;
    for (const p of partials) {
      if (p.crcOk === false) {
        partBad++;
        blocking.push(`${tag} partial VIN tail @${fOff(p.offset)} (${p.tail}) checksum INVALID`);
      }
    }
    if (partials.length > 0 && partBad === 0) {
      passed.push(`${tag}: ${partials.length} partial VIN checksum(s) valid`);
    }
  }

  // RFH SEC16 record checksums
  if (wantSec16) {
    const sec16s = info.sec16s || [];
    let secBad = 0;
    let secPopulated = 0;
    for (let i = 0; i < sec16s.length; i++) {
      const s = sec16s[i];
      if (!s || s.blank) continue;
      secPopulated++;
      if (s.csOk === false) {
        secBad++;
        blocking.push(`${tag} SEC16 slot ${i + 1} @${fOff(s.offset)} checksum INVALID (stored vs calc mismatch)`);
      }
    }
    if (secPopulated > 0 && secBad === 0) {
      passed.push(`${tag}: ${secPopulated} SEC16 record checksum(s) valid`);
    }

    // RFH dual-slot SEC16 agreement: a populated slot 1 and slot 2 must match,
    // otherwise the module's two security banks disagree.
    if (sec16s.length >= 2 && !sec16s[0]?.blank && !sec16s[1]?.blank) {
      if (info.sec16match === false) {
        blocking.push(`${tag} SEC16 slot 1 / slot 2 DISAGREE — the two security banks hold different secrets`);
      } else if (info.sec16match === true) {
        passed.push(`${tag}: SEC16 slot 1 = slot 2`);
      }
    }
  }

  return { blocking, passed };
}

/* Public entry point.
 *
 * crossModule (default true): when false, skip the crossValidate inter-module
 * pass and only run per-file checksum self-checks. Use this for deliberate
 * virginize / wipe exports where the outgoing RFH SEC16 is intentionally blank
 * and would otherwise read as a false "secret mismatch" against a paired BCM.
 *
 * selfChecks (default ['vin','partials','sec16']): which per-file checksum
 * families to verify on the OUTGOING bytes. A VIN-only export (e.g. target-both)
 * never touches SEC16, so it should pass ['vin'] to avoid refusing on a
 * pre-existing SEC16 condition the export did not create (e.g. a virgin RFH that
 * still carries stale, invalid SEC16 records). Secret-writing paths leave it
 * default so every checksum the export produced is re-verified. */
export function checkExportSafety({ outgoing = [], context = [], crossModule = true, selfChecks = ['vin', 'partials', 'sec16'] } = {}) {
  const verdict = { ok: true, blocking: [], warnings: [], passed: [], parsed: [] };

  const reparse = (f, exported) => {
    if (!f || !f.bytes || !(f.bytes instanceof Uint8Array) || f.bytes.length === 0) {
      if (exported) {
        verdict.blocking.push(`${f?.role || 'OUTGOING'} file is empty or not a byte buffer — refusing to write`);
      }
      return null;
    }
    let info;
    try {
      info = parseModule(f.bytes, f.name || f.role || 'module.bin');
    } catch (e) {
      if (exported) {
        verdict.blocking.push(`${f.role || 'OUTGOING'} could not be re-parsed after patching (${String(e?.message || e)}) — refusing to write`);
      }
      return null;
    }
    return { role: f.role || info.type || 'MODULE', name: f.name, bytes: f.bytes, info };
  };

  const out = outgoing.map((f) => reparse(f, true)).filter(Boolean);
  const ctx = context.map((f) => reparse(f, false)).filter(Boolean);

  for (const f of out) {
    verdict.parsed.push({ role: f.role, type: f.info.type, info: f.info });
    const r = checkFileChecksums(f.role, f.info, f.bytes, selfChecks);
    verdict.blocking.push(...r.blocking);
    verdict.passed.push(...r.passed);
  }

  // Cross-module rule engine over the whole consistent set.
  const allInfos = [...out, ...ctx].map((f) => f.info);
  if (crossModule && allInfos.length > 0) {
    const cv = crossValidate(allInfos);
    verdict.blocking.push(...cv.issues);
    verdict.warnings.push(...cv.warnings);
    verdict.passed.push(...cv.passed);
  }

  verdict.ok = verdict.blocking.length === 0;
  return verdict;
}

/* Convenience: format a verdict into a single multi-line blocking message for
 * a log panel / toast. Returns '' when ok. */
export function formatBlockingMessage(verdict) {
  if (!verdict || verdict.ok) return '';
  const lines = ['⛔ Export refused — outgoing file failed the pre-download safety gate:'];
  for (const b of verdict.blocking) lines.push('   • ' + b);
  lines.push('No file was written. Resolve the inconsistency (re-sync the modules so their');
  lines.push('VINs and SEC16/SEC6 secrets agree) before exporting, or you risk bricking the ECU.');
  return lines.join('\n');
}
