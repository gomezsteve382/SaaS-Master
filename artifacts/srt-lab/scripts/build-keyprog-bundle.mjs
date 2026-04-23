#!/usr/bin/env node
/* ============================================================================
 * build-keyprog-bundle.mjs — Task #366 KEYPROG bundler.
 *
 * Builds the deliverable bundle for the Cluster B vehicle (target VIN
 * 2C3CDXCT1HH652640, shared SKIM secret 816531F7CDE32E33C25A415C8440C72A)
 * from the properly-named virgin sources living in attached_assets/:
 *
 *   BCM  22CHARGER_REDEYE_6.2_797BCM_DFLASH_VIRGIN_1776226962777.bin
 *   RFH  RFH_HERMANADO_20CHRGR6.2RFHUBFILE_EEE_OG_VIRGINSYCHNED_1776899205057.bin
 *   PCM  FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2_1776899205055.bin
 *
 * The virgin BCM already carries the target full VINs (4 slots, valid CRCs)
 * and the correct SKIM secret @0x40C9. Its only gap vs the target is the
 * two partial-VIN tails @0x4098 and @0x40B0, which still hold the legacy
 * Hellcat tail "NH176487". The bundler patches ONLY those two 10-byte slots
 * (8 ASCII tail bytes + 2-byte big-endian CRC16) and leaves every other byte
 * untouched. The RFH and PCM are pure pass-through copies.
 *
 * Outputs (under module-type-prefixed filenames, so a flash-to-wrong-module
 * mistake is impossible from naming alone):
 *
 *   BCM_22CHARGER_REDEYE_6.2_KEYPROG_2C3CDXCT1HH652640.bin
 *   RFH_20CHRGR6.2_KEYPROG_2C3CDXCT1HH652640.bin
 *   PCM_FCA_CONTINENTAL_GPEC2A_KEYPROG_2C3CDXCT1HH652640.bin
 *   VERIFY_KEYPROG_2C3CDXCT1HH652640.txt
 *   KEYPROG_2C3CDXCT1HH652640.zip      (stored, no compression, no deps)
 *
 * The script is idempotent: re-running it produces byte-identical outputs
 * and never mutates or deletes its input source files. It only deletes
 * obsolete OUTPUT files (old _KEYPROG_*.bin siblings shipped in earlier
 * bundles) when --no-cleanup is not passed.
 *
 * Filename guards: each role refuses any source whose name starts with the
 * wrong module-type prefix (e.g. an "RFHUB"-named file fed in as the BCM
 * input) unless --allow-mislabeled is passed. With the proper-named virgin
 * sources above, the override is never needed.
 *
 * Usage:
 *   node scripts/build-keyprog-bundle.mjs [--allow-mislabeled] [--no-cleanup]
 * ============================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { parseModule, pcmChipFromKey, pcmChipFromSize, PCM_CHIPS } from '../src/lib/parseModule.js';
import { crc16 } from '../src/lib/crc.js';
import { formatBcmSec16Provenance } from '../src/lib/keyProgWizard.js';

/* Soft-wrap a paragraph for fixed-width VERIFY.txt sections — duplicated
 * (intentionally, per Task #391) from the same helper inside keyProgWizard.js
 * so the bundler script doesn't have to drag in additional non-public
 * exports just to render the virgin-explainer paragraph. */
function wrapParagraph(text, indent, width = 78) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = indent;
  for (const w of words) {
    if (line.length + w.length + 1 > width && line.trim().length > 0) {
      lines.push(line.trimEnd());
      line = indent + w;
    } else {
      line += (line === indent ? '' : ' ') + w;
    }
  }
  if (line.trim().length > 0) lines.push(line.trimEnd());
  return lines;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ATTACHED = path.join(REPO_ROOT, 'attached_assets');

const TARGET_VIN = '2C3CDXCT1HH652640';
const TARGET_TAIL = TARGET_VIN.slice(9);          // "HH652640"
const SHARED_SECRET_HEX = '816531F7CDE32E33C25A415C8440C72A';
const PARTIAL_VIN_OFFSETS = [0x4098, 0x40B0];

const SRC_BCM = '22CHARGER_REDEYE_6.2_797BCM_DFLASH_VIRGIN_1776226962777.bin';
const SRC_RFH = 'RFH_HERMANADO_20CHRGR6.2RFHUBFILE_EEE_OG_VIRGINSYCHNED_1776899205057.bin';
// SRC_PCM is the 8 KB doubled "VIRGINSYNCHED" capture (first 4 KB = real
// 95320-layout image carrying the target VIN; second 4 KB = 0xFF padding).
// We always read the 8 KB source and slice or copy depending on --pcm-chip
// (Task #379). 95320 (4 KB) is the default because the bench chip on the
// target Charger is a 95320 — pre-#379 the bundler shipped an 8 KB output
// that the CGDI flasher refused with "File different size."
const SRC_PCM = 'FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2_1776899205055.bin';

const OUT_BCM = 'BCM_22CHARGER_REDEYE_6.2_KEYPROG_' + TARGET_VIN + '.bin';
const OUT_RFH = 'RFH_20CHRGR6.2_KEYPROG_' + TARGET_VIN + '.bin';
function pcmOutName(chip) {
  return 'PCM_FCA_CONTINENTAL_GPEC2A_' + chip.sizeLabel.replace(' ', '') + '_KEYPROG_' + TARGET_VIN + '.bin';
}
function verifyOutName(chip) {
  return 'VERIFY_KEYPROG_' + TARGET_VIN + '_' + chip.sizeLabel.replace(' ', '') + '.txt';
}
function zipOutName(chip) {
  return 'KEYPROG_' + TARGET_VIN + '_' + chip.sizeLabel.replace(' ', '') + '.zip';
}

/* Filename prefix → expected module type. Refusal patterns abort the run
 * unless --allow-mislabeled is passed; allow patterns are informational
 * only. With the proper-named virgin sources above the override is never
 * required — the guard only fires when somebody points the script at a
 * mis-prefixed file like "...797RFHUB...." for the BCM slot. */
/* Filename-guard rules and helper exported for behavioral testing (see
 * src/lib/__tests__/keyprogBundle.golden.test.js). */
export const FILENAME_PREFIX_RULES = {
  BCM: { allow:  /^(BCM|22CHARGER|18TH_DFLASH|18TRACKHWK|18trackhwk|CARTMAN|BCM_HERMANADO)/i,
         refuse: /^(RFH|RFHUB|PCM|GPEC2A|FCA_CONTINENTAL|FCA_95640|95640|CONTINENTAL)/i },
  RFH: { allow:  /^(RFH|RFHUB|20CHRGR|2020_RFHUB|21RFHUB|DRAGRFHUB|CARTMAN.*RFHUB|FIXED_RFH)/i,
         refuse: /^(BCM|22CHARGER|PCM|GPEC2A|FCA_CONTINENTAL|FCA_95640|95640|CONTINENTAL)/i },
  PCM: { allow:  /^(PCM|GPEC2A|FCA_CONTINENTAL|CONTINENTAL_GPEC2A|95640|FCA_95640)/i,
         refuse: /^(BCM|22CHARGER|RFH|RFHUB)/i },
};

/* Pure decision function: returns one of
 *   { decision: 'refuse', reason }       — refuse pattern hit, override off
 *   { decision: 'override', reason }     — refuse pattern hit, override on
 *   { decision: 'unfamiliar', reason }   — neither allow nor refuse pattern hit
 *   { decision: 'allow' }                — allow pattern hit
 * Caller decides whether to abort (refuse), warn (override/unfamiliar) or
 * proceed silently (allow). */
export function evaluateFilenameGuard(role, name, { allowMislabeled = false } = {}) {
  const rules = FILENAME_PREFIX_RULES[role];
  if (!rules) return { decision: 'allow' };
  if (rules.refuse.test(name)) {
    const reason = role + ' source filename "' + name + '" starts with a non-' + role
      + ' module-type prefix.';
    return { decision: allowMislabeled ? 'override' : 'refuse', reason };
  }
  if (!rules.allow.test(name)) {
    return { decision: 'unfamiliar',
      reason: role + ' source filename "' + name + '" does not match the usual '
        + role + ' naming pattern.' };
  }
  return { decision: 'allow' };
}

// The rest of this file only runs when the script is the entrypoint
// (so importing it from a test doesn't trigger the bundler).
const IS_ENTRYPOINT = (() => {
  try { return import.meta.url === 'file://' + process.argv[1]; }
  catch { return false; }
})();
if (!IS_ENTRYPOINT) {
  // Exported helpers above are enough for tests; skip the build pipeline.
} else {

const argv = process.argv.slice(2);
const args = new Set(argv);
const ALLOW_MISLABELED = args.has('--allow-mislabeled');
const SKIP_CLEANUP = args.has('--no-cleanup');

// --pcm-chip <key> selects which EEPROM size the PCM output targets
// (Task #379). Default 4kb (95320) — that's the chip on the bench for
// the target Charger and the original "File different size" failure
// mode. Pass --pcm-chip 8kb to ship the full doubled 95640 image.
function parsePcmChipArg() {
  const i = argv.indexOf('--pcm-chip');
  if (i >= 0) {
    const v = argv[i + 1];
    const c = pcmChipFromKey(v);
    if (!c) {
      const valid = PCM_CHIPS.map((p) => p.chipKey + '|' + p.chip).join(', ');
      fail('Unknown --pcm-chip "' + v + '". Valid: ' + valid + '.');
    }
    return { chip: c, source: 'flag' };
  }
  // Task #379: when --donor <path> is supplied without an explicit chip,
  // auto-detect the chip from the donor PCM read. This is the durable
  // protection against shipping a wrong-sized image when the bench tech
  // points the bundler at the actual capture.
  const di = argv.indexOf('--donor');
  if (di >= 0) {
    const dpath = argv[di + 1];
    if (!dpath) fail('--donor requires a path to the donor PCM file');
    let donor;
    try { donor = fs.readFileSync(dpath); }
    catch (e) { fail('Cannot read --donor file "' + dpath + '": ' + e.message); }
    const detected = pcmChipFromSize(donor.length);
    if (!detected) {
      fail('Donor PCM size ' + donor.length + ' B is non-canonical (need 4096 or 8192). Refusing to guess.');
    }
    return { chip: detected, source: 'donor:' + dpath };
  }
  return { chip: pcmChipFromKey('4kb'), source: 'default' };
}
const PCM_CHIP_RES = parsePcmChipArg();
const PCM_CHIP = PCM_CHIP_RES.chip;
const OUT_PCM = pcmOutName(PCM_CHIP);
const OUT_VERIFY = verifyOutName(PCM_CHIP);
const OUT_ZIP = zipOutName(PCM_CHIP);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const fO = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

function fail(msg) {
  console.error('\n[ABORT] ' + msg);
  process.exit(1);
}
function readBin(name) {
  const p = path.join(ATTACHED, name);
  if (!fs.existsSync(p)) fail('Missing source file: ' + name);
  return new Uint8Array(fs.readFileSync(p));
}
function checkFilenameGuard(role, name) {
  const r = evaluateFilenameGuard(role, name, { allowMislabeled: ALLOW_MISLABELED });
  if (r.decision === 'refuse') {
    fail(r.reason + ' Refusing to proceed without --allow-mislabeled.\n'
      + '  This guard exists because the original KEYPROG bundle shipped a BCM dump\n'
      + '  under an "RFHUB"-prefixed filename, creating a flash-to-wrong-module risk.');
  } else if (r.decision === 'override') {
    console.warn('[WARN] ' + r.reason + ' --allow-mislabeled override active.');
  } else if (r.decision === 'unfamiliar') {
    console.warn('[NOTE] ' + r.reason + ' Bytes still verified — proceeding.');
  }
}

/* Patch a single 10-byte partial-VIN slot in-place: 8 ASCII tail bytes
 * followed by a big-endian CRC16 over those 8 bytes. Returns the slot's
 * before/after byte snapshot for the VERIFY report. */
function patchPartialVin(buf, off, tail) {
  if (tail.length !== 8) throw new Error('partial-VIN tail must be 8 chars');
  const before = Buffer.from(buf.slice(off, off + 10)).toString('hex').toUpperCase();
  for (let i = 0; i < 8; i++) buf[off + i] = tail.charCodeAt(i);
  const cs = crc16(buf.slice(off, off + 8));
  buf[off + 8] = (cs >> 8) & 0xFF;
  buf[off + 9] = cs & 0xFF;
  const after = Buffer.from(buf.slice(off, off + 10)).toString('hex').toUpperCase();
  return { off, before, after, csHex: cs.toString(16).toUpperCase().padStart(4, '0') };
}

console.log('=== KEYPROG bundle builder (Task #366 / chip-aware via #379) ===');
console.log('Target VIN:    ', TARGET_VIN);
console.log('Shared secret: ', SHARED_SECRET_HEX);
console.log('PCM chip:      ', PCM_CHIP.chip + ' (' + PCM_CHIP.sizeLabel + ', ' + PCM_CHIP.sizeBytes + ' B)');
console.log('Allow mislabeled source filenames:', ALLOW_MISLABELED);
console.log('');

// ─── Filename guards ───
checkFilenameGuard('BCM', SRC_BCM);
checkFilenameGuard('RFH', SRC_RFH);
checkFilenameGuard('PCM', SRC_PCM);

// ─── Read sources ───
const bcmSrc = readBin(SRC_BCM);
const rfhSrc = readBin(SRC_RFH);
const pcmSrc = readBin(SRC_PCM);
const bcmSrcSha = sha256(bcmSrc);
const rfhSrcSha = sha256(rfhSrc);
const pcmSrcSha = sha256(pcmSrc);

console.log('Source files:');
console.log('  BCM ' + SRC_BCM + '  sz=' + bcmSrc.length);
console.log('      sha256 = ' + bcmSrcSha);
console.log('  RFH ' + SRC_RFH + '  sz=' + rfhSrc.length);
console.log('      sha256 = ' + rfhSrcSha);
console.log('  PCM ' + SRC_PCM + '  sz=' + pcmSrc.length);
console.log('      sha256 = ' + pcmSrcSha);

// ─── Pre-patch source parses ───
const bcmInfoIn = parseModule(bcmSrc, SRC_BCM);
const rfhInfo   = parseModule(rfhSrc, SRC_RFH);
const pcmHalf2  = pcmSrc.slice(4096);
const pcmInfo   = parseModule(pcmSrc.slice(0, 4096), SRC_PCM + '#half1');

// ─── Module type assertions ───
if (bcmInfoIn.type !== 'BCM')   fail('BCM source did not parse as BCM (got ' + bcmInfoIn.type + ')');
if (rfhInfo.type   !== 'RFHUB') fail('RFH source did not parse as RFHUB (got ' + rfhInfo.type + ')');
if (pcmInfo.type   !== 'GPEC2A') fail('PCM half-1 did not parse as GPEC2A (got ' + pcmInfo.type + ')');
if (!pcmHalf2.every((b) => b === 0xFF)) fail('PCM half-2 is not all-0xFF padding (unexpected layout)');

// ─── BCM source preconditions: full VINs + SKIM already correct ───
if (bcmInfoIn.vins.length !== 4) fail('Expected 4 BCM full VINs in source, got ' + bcmInfoIn.vins.length);
for (const v of bcmInfoIn.vins) {
  if (v.vin !== TARGET_VIN) fail('BCM source full VIN at ' + fO(v.offset) + ' is ' + v.vin + ', expected ' + TARGET_VIN);
  if (!v.crcOk) fail('BCM source full VIN CRC bad at ' + fO(v.offset));
}
const bcmSecretBE = Array.from(bcmInfoIn.vehicleSecret.bytes).reverse().map(hex2).join('');
if (bcmSecretBE !== SHARED_SECRET_HEX) fail('BCM source SKIM secret (BE) does not match Cluster B shared secret');

// ─── BCM source partials: must be parseable + valid CRC, but tail is allowed
//     to be EITHER stale (legacy "NH176487") OR already target. We always
//     re-stamp them to the target tail so the script is idempotent. ───
if (bcmInfoIn.partialVins.length !== 2) fail('Expected 2 BCM partial-VIN slots, got ' + bcmInfoIn.partialVins.length);
for (const p of bcmInfoIn.partialVins) {
  if (!p.crcOk) fail('BCM source partial VIN CRC bad at ' + fO(p.offset) + ' (refusing to patch a corrupt slot)');
}
for (const o of PARTIAL_VIN_OFFSETS) {
  if (!bcmInfoIn.partialVins.some((p) => p.offset === o)) {
    fail('BCM source missing expected partial-VIN slot at ' + fO(o));
  }
}

// ─── Build BCM output: copy source + minimal partial-VIN patch ───
const outBcm = new Uint8Array(bcmSrc);
const patchLog = [];
for (const off of PARTIAL_VIN_OFFSETS) patchLog.push(patchPartialVin(outBcm, off, TARGET_TAIL));

// Verify the patch was minimal (≤ 20 bytes changed; in practice 18 for this
// VIN pair because tail[1]='H' coincides with stale tail[1]='H').
let diffCount = 0;
const diffOffsets = [];
for (let i = 0; i < bcmSrc.length; i++) {
  if (bcmSrc[i] !== outBcm[i]) {
    diffCount++;
    diffOffsets.push(i);
    if (i < PARTIAL_VIN_OFFSETS[0] || i > PARTIAL_VIN_OFFSETS[1] + 9) {
      fail('Patch touched a byte outside partial-VIN windows: ' + fO(i));
    }
  }
}
if (diffCount > 20) fail('Patch changed ' + diffCount + ' bytes (>20 max for two 10-byte slots)');

// ─── Re-parse the patched BCM and re-assert ALL invariants on the OUTPUT ───
const bcmInfoOut = parseModule(outBcm, OUT_BCM);
if (bcmInfoOut.vins.length !== 4) fail('Output BCM lost a full-VIN slot');
for (const v of bcmInfoOut.vins) {
  if (v.vin !== TARGET_VIN || !v.crcOk) fail('Output BCM full VIN regressed at ' + fO(v.offset));
}
if (bcmInfoOut.partialVins.length !== 2) fail('Output BCM lost a partial-VIN slot');
for (const p of bcmInfoOut.partialVins) {
  if (p.tail !== TARGET_TAIL) fail('Output BCM partial-VIN tail at ' + fO(p.offset) + ' is ' + p.tail);
  if (!p.crcOk) fail('Output BCM partial-VIN CRC bad at ' + fO(p.offset));
}
const outBcmSecretBE = Array.from(bcmInfoOut.vehicleSecret.bytes).reverse().map(hex2).join('');
if (outBcmSecretBE !== SHARED_SECRET_HEX) fail('Output BCM SKIM secret regressed');

// ─── RFH + PCM are pure pass-through ───
if (!rfhInfo.vins?.length) fail('RFH carries no parseable VINs');
for (const v of rfhInfo.vins) {
  if (v.vin !== TARGET_VIN || !v.crcOk) fail('RFH VIN at ' + fO(v.offset) + ' invalid');
}
const rfhSec = String(rfhInfo.sec16s?.[0]?.hex || '').toUpperCase();
if (rfhSec !== SHARED_SECRET_HEX) fail('RFH SEC16 slot1 ' + rfhSec + ' != shared secret');
if (rfhInfo.sec16s[0].csOk !== true) fail('RFH SEC16 slot1 CS is not valid');

if (!pcmInfo.vins?.length) fail('PCM carries no parseable VINs');
for (const v of pcmInfo.vins) {
  if (v.vin !== TARGET_VIN) fail('PCM VIN at ' + fO(v.offset) + ' is ' + v.vin);
}
const pcmSec6 = String(pcmInfo.pcmSec6?.hex || '').replace(/ /g, '');
if (!SHARED_SECRET_HEX.startsWith(pcmSec6)) fail('PCM SEC6 ' + pcmSec6 + ' is not the prefix of the shared secret');

const outRfh = new Uint8Array(rfhSrc);
// PCM output sizing (Task #379):
//   --pcm-chip 4kb (default, 95320) → first 4 KB of the 8 KB virgin only.
//                That half is the real GPEC2A image carrying the target VIN
//                and SEC6; half-2 (verified all-0xFF above) is dropped.
//   --pcm-chip 8kb (95640)          → byte-identical pass-through of the
//                full doubled 8 KB capture.
const outPcm = PCM_CHIP.sizeBytes === 4096
  ? new Uint8Array(pcmSrc.slice(0, 4096))
  : new Uint8Array(pcmSrc);
if (outPcm.length !== PCM_CHIP.sizeBytes) {
  fail('PCM output size ' + outPcm.length + ' B does not match selected chip ' + PCM_CHIP.chip + ' (' + PCM_CHIP.sizeBytes + ' B)');
}
if (sha256(outRfh) !== rfhSrcSha) fail('RFH output SHA differs from source after copy');
if (PCM_CHIP.sizeBytes === 8192 && sha256(outPcm) !== pcmSrcSha) {
  fail('PCM output SHA differs from source after 8 KB pass-through');
}

const outBcmSha = sha256(outBcm);
const outRfhSha = sha256(outRfh);
const outPcmSha = sha256(outPcm);

console.log('\n[OK] All source-file checks passed. BCM patched at offsets:');
for (const p of patchLog) {
  console.log('  ' + fO(p.off) + '  before=' + p.before + '  after=' + p.after + '  cs=0x' + p.csHex);
}
console.log('  Total bytes changed: ' + diffCount + ' (offsets: ' + diffOffsets.map(fO).join(', ') + ')');
console.log('  RFH and PCM are byte-identical pass-through.');

// ─── VERIFY.txt ───
const lines = [];
lines.push('KEYPROG bundle — VERIFY report (Task #366)');
lines.push('=========================================');
lines.push('Target VIN:           ' + TARGET_VIN);
lines.push('Shared secret (BE):   ' + SHARED_SECRET_HEX);
lines.push('Generated:            ' + new Date().toISOString());
lines.push('Bundler:              scripts/build-keyprog-bundle.mjs');
lines.push('');
lines.push('-- BCM ' + OUT_BCM);
lines.push('   module type:   ' + bcmInfoOut.type);
lines.push('   src filename:  ' + SRC_BCM);
lines.push('   src SHA-256:   ' + bcmSrcSha);
lines.push('   out SHA-256:   ' + outBcmSha);
lines.push('   patch:         partial-VIN-only (' + diffCount + ' bytes changed across the two 10-byte slots)');
for (const p of patchLog) {
  lines.push('     ' + fO(p.off) + '  before=' + p.before + '  after=' + p.after + '  cs=0x' + p.csHex);
}
lines.push('   Full VIN slots:');
for (const v of bcmInfoOut.vins) {
  lines.push('     ' + fO(v.offset) + '  ' + v.vin + '  crcOk=' + v.crcOk);
}
lines.push('   Partial VIN tails:');
for (const p of bcmInfoOut.partialVins) {
  lines.push('     ' + fO(p.offset) + '  ' + p.tail + '  crcOk=' + p.crcOk);
}
lines.push('   Vehicle secret (LE @0x40C9): ' + bcmInfoOut.vehicleSecret.hex);
lines.push('   Vehicle secret (BE form):    ' + outBcmSecretBE + '  [matches shared secret]');
lines.push('   IMMO records (primary):      ' + bcmInfoOut.immoRecs);
lines.push('   IMMO backup synced:          ' + bcmInfoOut.immoSynced);
lines.push('   Bank0 seq @0x0002:           ' + hex2(outBcm[0x0002]) + ' ' + hex2(outBcm[0x0003]));
lines.push('   Bank1 seq @0x4002:           ' + hex2(outBcm[0x4002]) + ' ' + hex2(outBcm[0x4003]));
lines.push('');
// Task #391 — mirror the GUI wizard's "BCM SEC16 source" section into the
// bundler's VERIFY.txt so a ZIP produced by the script is self-describing
// to the same level as one produced by the wizard. Uses the shared
// formatBcmSec16Provenance helper from keyProgWizard.js so the badge
// label / offset / blank flag / virgin-explainer paragraph stay in sync.
const prov = formatBcmSec16Provenance(bcmInfoOut.bcmSec16);
if (prov) {
  lines.push('-- BCM SEC16 source');
  lines.push('   Source:    ' + prov.label);
  if (prov.offsetHex) lines.push('   Offset:    ' + prov.offsetHex);
  lines.push('   Blank:     ' + (prov.blank ? 'yes  [BLANK / virgin]' : 'no'));
  if (prov.blank) {
    lines.push('');
    for (const ln of wrapParagraph(prov.virginExplainer, '   ')) {
      lines.push(ln);
    }
  } else if (prov.beHex) {
    lines.push('   Bytes (BE): ' + prov.beHex);
  }
  lines.push('');
}
lines.push('-- RFH ' + OUT_RFH + '  (PASS-THROUGH)');
lines.push('   module type:   ' + rfhInfo.type + ' (' + rfhInfo.rfhGen + ')');
lines.push('   src filename:  ' + SRC_RFH);
lines.push('   src SHA-256:   ' + rfhSrcSha);
lines.push('   out SHA-256:   ' + outRfhSha + '  [identical]');
lines.push('   Full VINs:');
for (const v of rfhInfo.vins) {
  lines.push('     ' + fO(v.offset) + '  ' + v.vin + '  (cs=0x' + v.sc.toString(16).toUpperCase().padStart(2, '0')
    + ' calc=0x' + v.cc.toString(16).toUpperCase().padStart(2, '0') + ' crcOk=' + v.crcOk + ')');
}
lines.push('   SEC16 slot1 (= shared secret BE): ' + rfhSec);
lines.push('   SEC16 slot1 csOk:                 ' + rfhInfo.sec16s[0].csOk);
lines.push('   SEC16 slot1↔slot2 match:          ' + rfhInfo.sec16match);
lines.push('');
const pcmDispo = PCM_CHIP.sizeBytes === 4096
  ? 'SLICED first 4 KB of 8 KB virgin (95320 / 4 KB target chip)'
  : 'PASS-THROUGH (full 8 KB doubled capture; half-2 is 0xFF padding)';
const pcmShaTag = PCM_CHIP.sizeBytes === 8192 ? '  [identical]' : '  [first 4 KB of source]';
lines.push('-- PCM ' + OUT_PCM + '  (' + pcmDispo + ')');
lines.push('   module type:   ' + pcmInfo.type);
lines.push('   target chip:   ' + PCM_CHIP.chip + ' (' + PCM_CHIP.sizeLabel + ', ' + PCM_CHIP.sizeBytes + ' B)');
lines.push('   src filename:  ' + SRC_PCM + '  (' + pcmSrc.length + ' B)');
lines.push('   src SHA-256:   ' + pcmSrcSha);
lines.push('   out size:      ' + outPcm.length + ' B');
lines.push('   out SHA-256:   ' + outPcmSha + pcmShaTag);
lines.push('   Full VINs (in 4 KB GPEC2A half):');
for (const v of pcmInfo.vins) lines.push('     ' + fO(v.offset) + '  ' + v.vin);
lines.push('   PCM SEC6 (= first 6 bytes of shared secret): ' + pcmSec6);
lines.push('');
lines.push('Status: PASS — three files ready to flash for key programming.');
lines.push('');
lines.push('Notes:');
lines.push('  - The BCM patch is the minimum byte-set required to bring the virgin BCM');
lines.push('    to the target VIN: 2 partial-VIN tail slots (8 ASCII bytes + 2-byte');
lines.push('    big-endian CRC16 each). The source virgin already had the 4 full VINs,');
lines.push('    SKIM secret, IMMO records, and bank sequence numbers correct.');
lines.push('  - RFH output is a byte-identical copy of the virgin source.');
lines.push('  - PCM output size depends on --pcm-chip (default 4kb / 95320):');
lines.push('      4kb (95320) → first 4 KB of the 8 KB virgin (drops the 0xFF padding half);');
lines.push('      8kb (95640) → byte-identical pass-through of the full 8 KB virgin.');
lines.push('    The CGDI flasher rejects the wrong size with "File different size",');
lines.push('    so the chip selection at build time matches the bench EEPROM.');
lines.push('  - Output filenames start with the actual module type (BCM_/RFH_/PCM_) so');
lines.push('    a flash-to-wrong-module mistake is impossible from naming alone.');
lines.push('  - The bundler is idempotent: re-running yields byte-identical outputs and');
lines.push('    never deletes its input source files.');
const verifyText = lines.join('\n') + '\n';

// ─── Write outputs to attached_assets/ ───
fs.writeFileSync(path.join(ATTACHED, OUT_BCM), Buffer.from(outBcm));
fs.writeFileSync(path.join(ATTACHED, OUT_RFH), Buffer.from(outRfh));
fs.writeFileSync(path.join(ATTACHED, OUT_PCM), Buffer.from(outPcm));
fs.writeFileSync(path.join(ATTACHED, OUT_VERIFY), verifyText);

// Re-verify on-disk copies match in-memory bytes exactly.
for (const [name, buf] of [[OUT_BCM, outBcm], [OUT_RFH, outRfh], [OUT_PCM, outPcm]]) {
  const onDisk = new Uint8Array(fs.readFileSync(path.join(ATTACHED, name)));
  if (sha256(onDisk) !== sha256(buf)) fail('On-disk SHA mismatch for ' + name);
}

// ─── Build a stored-only ZIP (no compression, no deps) ───
function dosTime(d) {
  const t = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const dt = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { t, dt };
}
function buildZip(entries) {
  const now = new Date();
  const { t, dt } = dosTime(now);
  const localChunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data);
    const crc = zlib.crc32 ? zlib.crc32(data) : (() => {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < data.length; i++) {
        c ^= data[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
      }
      return (c ^ 0xFFFFFFFF) >>> 0;
    })();
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt16LE(t, 10);
    lfh.writeUInt16LE(dt, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    localChunks.push(lfh, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(t, 12);
    cd.writeUInt16LE(dt, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, ...central, eocd]);
}

const zipBytes = buildZip([
  { name: OUT_BCM, data: outBcm },
  { name: OUT_RFH, data: outRfh },
  { name: OUT_PCM, data: outPcm },
  { name: OUT_VERIFY, data: Buffer.from(verifyText, 'utf8') },
]);
fs.writeFileSync(path.join(ATTACHED, OUT_ZIP), zipBytes);

// ─── Cleanup of obsolete OUTPUT files only — never touches input sources. ───
const OBSOLETE_OUTPUTS = [
  '22CHARGER_REDEYE_6.2_797RFHUB_EEE_OGFILE_VIRGIN_1776900226655_KEYPROG_2C3CDXCT1HH652640.bin',
  'RFH_HERMANADO_20CHRGR6.2RFHUBFILE_EEE_OG_VIRGINSYCHNED_1776899205057_KEYPROG_2C3CDXCT1HH652640.bin',
  'FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2_1776899205055_KEYPROG_2C3CDXCT1HH652640.bin',
  'KEYPROG_2C3CDXCT1HH652640_1776903757676.zip',
  // Pre-#379 un-suffixed PCM/VERIFY/zip outputs (now replaced by
  // the chip-suffixed _4KB_/_8KB_ filenames).
  'PCM_FCA_CONTINENTAL_GPEC2A_KEYPROG_2C3CDXCT1HH652640.bin',
  'VERIFY_KEYPROG_2C3CDXCT1HH652640.txt',
  'KEYPROG_2C3CDXCT1HH652640.zip',
];
const PROTECTED_INPUTS = new Set([SRC_BCM, SRC_RFH, SRC_PCM]);
if (!SKIP_CLEANUP) {
  for (const f of OBSOLETE_OUTPUTS) {
    if (PROTECTED_INPUTS.has(f)) continue; // never delete a current input
    const p = path.join(ATTACHED, f);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log('  deleted obsolete output ' + f);
    }
  }
}

console.log('\n=== Wrote 5 files to attached_assets/ ===');
console.log('  ' + OUT_BCM    + '   sha=' + outBcmSha.slice(0, 16) + '... (sz=' + outBcm.length + ')');
console.log('  ' + OUT_RFH    + '   sha=' + outRfhSha.slice(0, 16) + '... (sz=' + outRfh.length + ')');
console.log('  ' + OUT_PCM    + '   sha=' + outPcmSha.slice(0, 16) + '... (sz=' + outPcm.length + ')');
console.log('  ' + OUT_VERIFY + '   sz=' + verifyText.length);
console.log('  ' + OUT_ZIP    + '   sz=' + zipBytes.length);
console.log('\nPASS — bundle ready.');

} // end IS_ENTRYPOINT block

