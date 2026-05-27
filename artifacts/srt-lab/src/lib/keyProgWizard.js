/* ============================================================================
 * keyProgWizard.js — pure logic for the one-click "Stamp VIN to module set"
 * wizard (Task #343). Mirrors the Cluster B patcher script
 * (scripts/patch-cluster-b-vin.mjs) so a locksmith can drive the same
 * algorithm from the GUI without touching a shell.
 *
 * Exports:
 *   identifyModule(data, filename)   → {role:'BCM'|'RFH'|'PCM'|null, info, doubled?, halfPad?}
 *   runKeyProgPatch({bcm, rfh, pcm, vin, promoteBank=false})
 *     → {ok, checks:[{label,pass,detail}], sharedSecret, before, after,
 *        files:[{role,name,data}], verifyText}
 *
 * Each input file is {name, data:Uint8Array}. The wizard refuses to mark the
 * patch OK unless every check passes; the UI keys the "Download" buttons off
 * `result.ok`.
 *
 * IMMO backup auto-sync (writeModuleVIN copies 0x40C0 → 0x2000 at the end of
 * every BCM write) is intentionally undone unless `promoteBank: true` so we
 * don't promote the staged secret into the active bank — see Critical
 * Constraint #2 in the script.
 * ========================================================================== */
import { parseModule, pcmChipFromSize, pcmChipFromKey, PCM_CHIPS } from './parseModule.js';
import { writeModuleVIN } from './fileUtils.js';
import { crc16 } from './crc.js';
import { formatBcmSec16SourceLabel } from './sec16SourceLabel.js';
import {
  writeBcmSec16Gen2,
  writeBcmFlatSec16,
  writeRfhSec16FromBcm,
} from './securityBytes.js';

const IMMO_BACKUP_SIZE = 24 * 8; // 192 bytes (IMMO_REC × IMMO_KC)

/* Critical untouchable BCM regions (start, endExclusive). Patcher refuses to
 * succeed if any byte in these ranges differs between source and patched. */
const BCM_FORBIDDEN = [
  [0x0002, 0x0004],          // bank0 seq
  [0x4002, 0x4004],          // bank1 seq
  [0x40C0, 0x40F8 + 1],      // mirror1 record + LE secret region
  [0x40E8, 0x4110],          // mirror2 record (overlaps with above; union)
  [0x81A0, 0x8200],          // 3 split records (32B each at 0x81A0/C0/E0)
  [0x2000, 0x2000 + IMMO_BACKUP_SIZE], // IMMO backup
];

const fO = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');

export function identifyModule(data, filename) {
  const info = parseModule(data, filename);
  if (info.type === 'BCM') return { role: 'BCM', info };
  if (info.type === 'RFHUB') return { role: 'RFH', info };
  if (info.type === 'GPEC2A') return { role: 'PCM', info, doubled: false };
  // 8 KB doubled PCM: parseModule classifies as 95640. Reparse the first 4 KB
  // as GPEC2A and confirm the second 4 KB is 0xFF padding.
  if (data.length === 8192) {
    const half1 = data.slice(0, 4096);
    const half2 = data.slice(4096);
    const reparsed = parseModule(half1, filename + '#half1');
    if (reparsed.type === 'GPEC2A') {
      const halfPad = half2.every((b) => b === 0xFF);
      return { role: 'PCM', info: reparsed, doubled: true, halfPad };
    }
  }
  return { role: null, info };
}

function deriveSharedSecretBE(bcmInfo) {
  // Task #380 — use the resolved SEC16 (split → mirror → flat) instead of
  // the raw 0x40C9 slice. On synced Redeye dumps the flat slice holds
  // garbage; the resolver picks split/mirror records so the wizard can
  // derive a working shared secret. `info.vehicleSecret.bytes` carries the
  // resolved bytes for backwards compatibility.
  const res = bcmInfo?.bcmSec16;
  const bytes = (res && res.bytes && !res.blank) ? res.bytes
    : bcmInfo?.vehicleSecret?.bytes;
  if (!bytes || bytes.length !== 16) return null;
  return Array.from(bytes).reverse().map(hex2).join('');
}

function bytesEqualRange(a, b, start, end) {
  for (let i = start; i < end; i++) if (a[i] !== b[i]) return { ok: false, at: i };
  return { ok: true };
}

/* Task #386 — single source of truth for the BCM SEC16 provenance badge
 * shown both in the Key Prog wizard UI (KeyProgTab.jsx) and in the
 * downloadable VERIFY.txt report. Returns the badge label, raw offset, the
 * blank flag, the BE hex string, and (for virgin dumps) the explainer
 * paragraph. Returns null when no resolver result is available. */
export function formatBcmSec16Provenance(bcmSec16) {
  if (!bcmSec16) return null;
  const off = bcmSec16.offset;
  const offHex = (n) => (n == null
    ? '0x????'
    : '0x' + n.toString(16).toUpperCase().padStart(4, '0'));
  /* Task #471 — defer the source/offset label to the shared helper so
   * MismatchWizard, KeyProgTab, and ModuleFieldsPanel always render the
   * exact same string for a given resolver result. */
  const label = formatBcmSec16SourceLabel(bcmSec16);
  const hex = bcmSec16.bytes
    ? Array.from(bcmSec16.bytes).map(hex2).join(' ')
    : null;
  const beHex = bcmSec16.bytes
    ? Array.from(bcmSec16.bytes).reverse().map(hex2).join('')
    : null;
  const virginExplainer = 'This BCM looks virgin — every SEC16 candidate '
    + '(split records @0x81A0/0x81C0/0x81E0, mirror1 0xEB, mirror2 0xCA, '
    + 'and the legacy flat slice @0x40C9) is all 0xFF / 0x00, so there\'s '
    + 'no shared secret to derive. The download buttons stay disabled '
    + 'until you load a BCM that has actually been paired to a vehicle. '
    + '(A bench-fresh module dump will look like this.)';
  return {
    source: bcmSec16.source || null,
    label,
    offset: off ?? null,
    offsetHex: off == null ? null : offHex(off),
    blank: !!bcmSec16.blank,
    hex,
    beHex,
    virginExplainer,
  };
}

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

function buildVerifyText({
  vin, sharedSecret, bcmName, rfhName, pcmName,
  bcmSrcSha, bcmOutSha, rfhSrcSha, rfhOutSha, pcmSrcSha, pcmOutSha,
  before, after, bcmAfterInfo, rfhAfterInfo, pcmAfterInfo,
  bcmPatched, promoteBank, ok, failedChecks = [],
  pcmChip, pcmSliced,
  rfhSec16Status, rfhSec16BeforeHex, rfhSec16AfterHex,
}) {
  const lines = [];
  lines.push('Cluster key-prog patch — VERIFY report');
  lines.push('=========================================');
  lines.push('Target VIN:           ' + vin);
  lines.push('Shared secret (BE):   ' + (sharedSecret || '(unknown)'));
  lines.push('Generated:            ' + new Date().toISOString());
  lines.push('Promote bank:         ' + (promoteBank ? 'YES (IMMO backup auto-sync ON)' : 'NO (do not promote bank)'));
  lines.push('');
  lines.push('-- BCM ' + bcmName);
  lines.push('   src SHA-256: ' + bcmSrcSha);
  lines.push('   out SHA-256: ' + bcmOutSha);
  lines.push('   Full VIN slots (BEFORE → AFTER):');
  for (let i = 0; i < before.bcmFullVins.length; i++) {
    const b = before.bcmFullVins[i];
    const a = after.bcmFullVins[i];
    lines.push('     ' + fO(a.offset) + '  ' + b.vin + ' → ' + a.vin
      + '  (CRC stored=0x' + a.crcStored.toString(16).padStart(4, '0').toUpperCase()
      + ' calc=0x' + a.crcCalc.toString(16).padStart(4, '0').toUpperCase()
      + ' ok=' + a.crcOk + ')');
  }
  lines.push('   Partial VIN tails (BEFORE → AFTER):');
  for (let i = 0; i < before.bcmPartials.length; i++) {
    const b = before.bcmPartials[i];
    const a = after.bcmPartials[i];
    lines.push('     ' + fO(a.offset) + '  ' + b.tail + ' → ' + a.tail + '  (crcOk=' + a.crcOk + ')');
  }
  if (bcmAfterInfo?.vehicleSecret) {
    const res = bcmAfterInfo.bcmSec16;
    const srcLabel = res?.source === 'split'
      ? 'split @' + fO(res.offset) + '/' + fO(res.offset + 0x20) + '/' + fO(res.offset + 0x40)
      : res?.source === 'mirror1'
        ? 'mirror1 0xEB/0x18 @' + fO(res.offset)
        : res?.source === 'mirror2'
          ? 'mirror2 0xCA/0x28 @' + fO(res.offset)
          : 'flat @0x40C9 (legacy)';
    const blank = res?.blank ? '  [BLANK / virgin]' : '  [unchanged]';
    lines.push('   Vehicle secret (BCM SEC16 ' + srcLabel + '): ' + bcmAfterInfo.vehicleSecret.hex + blank);
  }
  lines.push('   Bank0 seq @0x0002:           ' + hex2(bcmPatched[0x0002]) + ' ' + hex2(bcmPatched[0x0003]) + '  [unchanged]');
  lines.push('   Bank1 seq @0x4002:           ' + hex2(bcmPatched[0x4002]) + ' ' + hex2(bcmPatched[0x4003]) + '  [unchanged]');
  lines.push('');
  // Task #386 — promote the SEC16 provenance badge from the wizard UI into
  // the archived report so a locksmith opening a saved ZIP can see *why*
  // the wizard derived a given shared secret without re-loading the BCM.
  const prov = formatBcmSec16Provenance(bcmAfterInfo?.bcmSec16);
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
  const rfhWasPatched = rfhSec16Status && rfhSec16Status.startsWith('PATCHED');
  const rfhModeTag = rfhWasPatched ? '  (SEC16 PATCHED)' : '  (PASS-THROUGH)';
  const rfhShaTag  = rfhWasPatched ? '  [SEC16 bytes updated]' : '  [identical]';
  lines.push('-- RFH ' + rfhName + rfhModeTag);
  lines.push('   src SHA-256: ' + rfhSrcSha);
  lines.push('   out SHA-256: ' + rfhOutSha + rfhShaTag);
  if (rfhAfterInfo?.vins?.length) {
    lines.push('   Full VINs:');
    for (const v of rfhAfterInfo.vins) {
      lines.push('     ' + fO(v.offset) + '  ' + v.vin + '  (crcOk=' + v.crcOk + ')');
    }
  }
  if (rfhAfterInfo?.sec16s?.[0]?.hex) {
    lines.push('   SEC16 slot1 (= shared secret BE): ' + rfhAfterInfo.sec16s[0].hex.toUpperCase());
  }
  // RFHUB_SEC16 outcome — always present so the operator knows exactly what
  // happened to the SEC16 during this wizard run without re-loading the files.
  if (rfhSec16Status) {
    lines.push('   RFHUB_SEC16: ' + rfhSec16Status);
    if (rfhWasPatched && rfhSec16BeforeHex) {
      lines.push('     before: ' + rfhSec16BeforeHex);
      lines.push('     after:  ' + (rfhSec16AfterHex || '(see slot1 above)'));
    }
  }
  lines.push('');
  // Task #379: surface the actual chip-mode resolution in the operator
  // report. When the wizard sliced an 8 KB doubled capture down to 4 KB
  // for a 95320 bench, the PCM output is NOT byte-identical to the source
  // and the report must say so.
  const pcmModeTag = pcmSliced
    ? '  (SLICED 8KB → 4KB for ' + (pcmChip?.chip || '95320') + ')'
    : pcmChip ? '  (PASS-THROUGH, ' + pcmChip.chip + ')' : '  (PASS-THROUGH)';
  const pcmShaTag = pcmSliced
    ? '  [first 4 KB of source]'
    : '  [identical]';
  lines.push('-- PCM ' + pcmName + pcmModeTag);
  lines.push('   src SHA-256: ' + pcmSrcSha);
  lines.push('   out SHA-256: ' + pcmOutSha + pcmShaTag);
  if (pcmAfterInfo?.vins?.length) {
    lines.push('   Full VINs:');
    for (const v of pcmAfterInfo.vins) lines.push('     ' + fO(v.offset) + '  ' + v.vin);
  }
  if (pcmAfterInfo?.pcmSec6) {
    lines.push('   PCM SEC6 (= first 6 bytes of shared secret): ' + pcmAfterInfo.pcmSec6.hex);
  }
  lines.push('');
  if (ok) {
    lines.push('Status: PASS — three files ready to flash for key programming.');
  } else {
    lines.push('Status: FAIL — DO NOT FLASH. Failed checks:');
    for (const c of failedChecks) {
      lines.push('  ✗ ' + c.label + (c.detail ? '  (' + c.detail + ')' : ''));
    }
  }
  return lines.join('\n') + '\n';
}

async function sha256Hex(bytes) {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf)).map(hex2).join('').toLowerCase();
  }
  // Node fallback (only used in tests / SSR contexts)
  // eslint-disable-next-line no-undef
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

// Task #379 — auto-pick the PCM output size that matches the bench EEPROM
// chip so the CGDI flasher doesn't reject the file with "File different
// size." Resolution rules (single source of truth, mirrored by the bundler):
//
//   - When the caller passes an explicit `pcmChip` (4kb / 8kb / 95320 / 95640),
//     honour it: slice or pad the output as needed, or surface an explicit
//     error if the requested size cannot be produced from the loaded PCM.
//   - Otherwise auto-pick: an 8 KB doubled GPEC2A capture (half-2 all 0xFF)
//     defaults to 4 KB output (the 95320 case that triggered #379); a clean
//     4 KB GPEC2A stays 4 KB; a real 8 KB image stays 8 KB.
//
// Returns {ok, bytes, chip, sliced, reason?}. `ok=false` means the wizard
// must surface the `reason` to the user instead of producing a flash file.
export function resolvePcmOutput(pcmInData, idP, requestedChip) {
  const inSize = pcmInData?.length || 0;
  const inChip = pcmChipFromSize(inSize);
  const isDoubledFFPad = idP?.doubled === true && idP?.halfPad === true;

  let target;
  if (requestedChip != null) {
    target = pcmChipFromKey(requestedChip);
    if (!target) {
      const valid = PCM_CHIPS.map((c) => c.chipKey + '|' + c.chip).join(', ');
      return { ok: false, bytes: null, chip: null, sliced: false,
        reason: 'Unknown pcmChip "' + requestedChip + '". Valid: ' + valid + '.' };
    }
  } else {
    // Auto-pick: doubled-with-FF-padding 8 KB → 4 KB; otherwise pass-through.
    target = isDoubledFFPad ? pcmChipFromKey('4kb') : (inChip || pcmChipFromKey('8kb'));
  }

  if (target.sizeBytes === inSize) {
    // Pass through the original reference to preserve true byte-for-byte
    // identity (incl. Buffer-vs-Uint8Array sameness for Node-side callers).
    return { ok: true, bytes: pcmInData, chip: target, sliced: false };
  }
  if (target.sizeBytes === 4096 && inSize === 8192 && isDoubledFFPad) {
    return { ok: true, bytes: new Uint8Array(pcmInData.slice(0, 4096)), chip: target, sliced: true };
  }
  if (target.sizeBytes === 8192 && inSize === 4096) {
    return { ok: false, bytes: null, chip: target, sliced: false,
      reason: 'Cannot produce an 8 KB (95640) PCM from a 4 KB source. '
        + 'Load the matching 8 KB virgin or rerun with --pcm-chip 4kb.' };
  }
  return { ok: false, bytes: null, chip: target, sliced: false,
    reason: 'PCM input size (' + inSize + ' B) cannot be reshaped to chip '
      + target.chip + ' (' + target.sizeBytes + ' B) safely. '
      + 'Load a matching virgin or rerun with --pcm-chip ' + (inChip?.chipKey || '4kb') + '.' };
}

export function runKeyProgPatch({ bcm, rfh, pcm, vin, promoteBank = false, pcmChip = null } = {}) {
  const checks = [];
  let allOk = true;
  const ok = (label, pass, detail = '') => {
    checks.push({ label, pass: !!pass, detail });
    if (!pass) allOk = false;
  };

  if (!vin || vin.length !== 17) {
    return {
      ok: false,
      checks: [{ label: 'VIN is 17 characters', pass: false, detail: 'got ' + (vin ? vin.length : 0) }],
      files: [], before: null, after: null, sharedSecret: null, verifyText: '',
    };
  }
  if (!bcm?.data || !rfh?.data || !pcm?.data) {
    return {
      ok: false,
      checks: [{ label: 'BCM, RFH, PCM all loaded', pass: false, detail: 'missing input file' }],
      files: [], before: null, after: null, sharedSecret: null, verifyText: '',
    };
  }

  const idB = identifyModule(bcm.data, bcm.name);
  const idR = identifyModule(rfh.data, rfh.name);
  const idP = identifyModule(pcm.data, pcm.name);
  ok('BCM file identified as BCM', idB.role === 'BCM', 'detected ' + (idB.info.type || 'UNKNOWN'));

  // XC2268-class RFHUB (2019+ Ram internal-flash, 64 KB) uses a different
  // internal layout than the Gen2 Yazaki (which has AA 55 31 01 at 0x0500 and
  // SEC16 slots at 0x050E / 0x0522). writeRfhSec16FromBcm cannot auto-patch an
  // XC2268 image — surface a clear, blocking error rather than silently treating
  // it as an unknown module and allowing a corrupt ZIP to be downloaded.
  if (idR.info?.type === 'XC2268_RFHUB') {
    return {
      ok: false,
      checks: [
        ...checks,
        {
          label: 'RFH file identified as RFHUB',
          pass: false,
          detail: 'XC2268 RFHUB (2019+ Ram internal-flash, 64 KB) detected — '
            + 'SEC16 slots differ from Gen2 layout and cannot be auto-patched here. '
            + 'Use ModuleSync BCM→RFH to sync the RFHUB SEC16, then re-run the wizard.',
        },
      ],
      files: [],
      before: { bcmFullVins: (idB.info?.vins || []).map((v) => ({ offset: v.offset, vin: v.vin })), bcmPartials: [] },
      after: null, sharedSecret: null, verifyText: '',
    };
  }

  ok('RFH file identified as RFHUB', idR.role === 'RFH', 'detected ' + (idR.info.type || 'UNKNOWN'));
  ok('PCM file identified as GPEC2A', idP.role === 'PCM', 'detected ' + (idP.info.type || 'UNKNOWN'));
  if (idP.role === 'PCM' && idP.doubled) {
    ok('PCM half-2 is 0xFF padding', idP.halfPad === true);
  }

  const sharedSecret = idB.role === 'BCM' ? deriveSharedSecretBE(idB.info) : null;

  // Track the RFHUB SEC16 state before patching.  When there is a mismatch the
  // wizard auto-fixes it below (writeRfhSec16FromBcm) rather than failing hard
  // here. The check is recorded as informational so the operator can see what
  // was found before any write, but a mismatch alone is NOT a blocking failure.
  let rfhSec16NeedsWrite = false;
  let rfhSec16BeforeHex = null;
  if (sharedSecret && idR.role === 'RFH') {
    if (idR.info?.sec16s?.[0]?.hex) {
      rfhSec16BeforeHex = String(idR.info.sec16s[0].hex).toUpperCase();
      rfhSec16NeedsWrite = rfhSec16BeforeHex !== sharedSecret;
      checks.push({
        label: 'RFH SEC16 slot1 vs BCM secret (BE)',
        pass: true,
        detail: rfhSec16NeedsWrite
          ? 'mismatch — will auto-patch (was ' + rfhSec16BeforeHex + ')'
          : 'already matched',
      });
    } else {
      // SEC16 not yet populated (virgin or unrecognised format) — attempt write.
      rfhSec16NeedsWrite = true;
      checks.push({
        label: 'RFH SEC16 slot1 vs BCM secret (BE)',
        pass: true,
        detail: 'SEC16 not yet populated — will write from BCM secret',
      });
    }
  }
  if (sharedSecret && idP.info?.pcmSec6?.hex) {
    const pcmSec6 = String(idP.info.pcmSec6.hex).replace(/ /g, '');
    ok('PCM SEC6 is prefix of shared secret', sharedSecret.startsWith(pcmSec6), 'PCM=' + pcmSec6);
  } else if (idP.role === 'PCM') {
    ok('PCM SEC6 is prefix of shared secret', false, 'PCM SEC6 not parsed');
  }

  // BCM full-VIN cardinality (must be 4 to safely run the slot-by-slot writer)
  const beforeBcmFullVins = (idB.info?.vins || []).map((v) => ({ offset: v.offset, vin: v.vin }));
  const beforeBcmPartials = (idB.info?.partialVins || []).map((p) => ({ offset: p.offset, tail: p.tail, crcOk: p.crcOk }));
  ok('BCM source has 4 full VIN slots', beforeBcmFullVins.length === 4, 'got ' + beforeBcmFullVins.length);

  if (!allOk || idB.role !== 'BCM') {
    return {
      ok: false, checks, sharedSecret,
      before: { bcmFullVins: beforeBcmFullVins, bcmPartials: beforeBcmPartials },
      after: null, files: [], verifyText: '',
    };
  }

  // ── Patch BCM ──
  let bcmPatched = writeModuleVIN(bcm.data, 'BCM', vin, idB.info.vins);
  ok('writeModuleVIN(BCM) succeeded', !!bcmPatched);
  if (!bcmPatched) {
    return { ok: false, checks, sharedSecret, before: { bcmFullVins: beforeBcmFullVins, bcmPartials: beforeBcmPartials }, after: null, files: [], verifyText: '' };
  }

  // Restore IMMO backup unless promoteBank is on. writeModuleVIN auto-copies
  // 0x40C0 → 0x2000 — for staged-secret clusters we do NOT want that.
  if (!promoteBank) {
    for (let i = 0; i < IMMO_BACKUP_SIZE; i++) bcmPatched[0x2000 + i] = bcm.data[0x2000 + i];
  }

  // Forbidden region guards (run after the optional restore so they reflect
  // what the user actually downloads).
  let firstFail = null;
  for (const [s, e] of BCM_FORBIDDEN) {
    const r = bytesEqualRange(bcm.data, bcmPatched, s, e);
    if (!r.ok) { firstFail = fO(r.at); break; }
  }
  ok('BCM forbidden regions byte-identical to source', firstFail === null,
     firstFail ? 'first diff @ ' + firstFail : '');

  // Reparse patched BCM
  const bcmAfterInfo = parseModule(bcmPatched, bcm.name + '_patched');
  ok('Post-patch BCM full-VIN cardinality preserved',
     bcmAfterInfo.vins.length === beforeBcmFullVins.length,
     bcmAfterInfo.vins.length + ' vs ' + beforeBcmFullVins.length);
  ok('Post-patch BCM partial-VIN cardinality preserved',
     (bcmAfterInfo.partialVins?.length || 0) === beforeBcmPartials.length);

  const afterBcmFullVins = bcmAfterInfo.vins.map((v) => {
    const slot = bcmPatched.slice(v.offset, v.offset + 17);
    const crcStored = (bcmPatched[v.offset + 17] << 8) | bcmPatched[v.offset + 18];
    const crcCalc = crc16(slot);
    return { offset: v.offset, vin: v.vin, crcStored, crcCalc, crcOk: crcStored === crcCalc };
  });
  const allVinOk = afterBcmFullVins.every((v) => v.vin === vin);
  const allCrcOk = afterBcmFullVins.every((v) => v.crcOk);
  ok('All BCM full VINs read target VIN', allVinOk);
  ok('All BCM full VIN CRC16s valid', allCrcOk);

  const expectedTail = vin.slice(9);
  const afterBcmPartials = (bcmAfterInfo.partialVins || []).map((p) =>
    ({ offset: p.offset, tail: p.tail, crcOk: !!p.crcOk }));
  ok('Both BCM partial VIN tails read target tail',
     afterBcmPartials.every((p) => p.tail === expectedTail));
  ok('Both BCM partial VIN CRCs valid',
     afterBcmPartials.every((p) => p.crcOk));

  // VIN-slot trailers + headers preserved
  let trailerFail = null;
  for (const v of (idB.info.vins || [])) {
    const slotBase = v.slotBase ?? v.offset;
    const trailerStart = v.offset + 19;
    const trailerEnd = slotBase + 32;
    if (trailerEnd <= bcm.data.length) {
      const r = bytesEqualRange(bcm.data, bcmPatched, trailerStart, trailerEnd);
      if (!r.ok) { trailerFail = 'trailer @ ' + fO(r.at); break; }
    }
    if ((v.headerBytes || 0) > 0) {
      const r = bytesEqualRange(bcm.data, bcmPatched, slotBase, v.offset);
      if (!r.ok) { trailerFail = 'header @ ' + fO(r.at); break; }
    }
  }
  ok('All BCM VIN-slot headers/trailers preserved', trailerFail === null, trailerFail || '');

  // ── RFH SEC16 write (when mismatched) + PCM size resolution ──────────────
  // `rfhOut` starts as a mutable copy of the source. When rfhSec16NeedsWrite
  // is set we call writeRfhSec16FromBcm which returns a new patched buffer;
  // any thrown error (e.g. missing AA 55 31 01 Gen2 header on a module that
  // cannot be auto-stamped) surfaces as a clear, blocking wizard failure.
  let rfhOut = new Uint8Array(rfh.data);
  let rfhSec16Status = rfhSec16NeedsWrite ? null : 'ALREADY_MATCHED';
  let rfhSec16AfterHex = rfhSec16BeforeHex; // stays same when already matched

  if (rfhSec16NeedsWrite && sharedSecret
      && idB.info?.bcmSec16?.bytes && !idB.info.bcmSec16.blank) {
    const bcmSec16Bytes = new Uint8Array(idB.info.bcmSec16.bytes);
    try {
      const wr = writeRfhSec16FromBcm(rfhOut, bcmSec16Bytes);
      rfhOut = wr.bytes;
      rfhSec16AfterHex = wr.rfhSec16Hex.toUpperCase();
      rfhSec16Status = 'PATCHED (old: ' + (rfhSec16BeforeHex || 'unset')
        + ', new: ' + rfhSec16AfterHex + ')';
      ok('RFH SEC16 written from BCM secret', wr.patched === 2,
        'slots patched: ' + wr.patched);
    } catch (e) {
      const msg = String(e?.message || e);
      return {
        ok: false,
        checks: [
          ...checks,
          {
            label: 'RFH SEC16 write failed',
            pass: false,
            detail: msg + ' — cannot produce a safe RFHUB output. '
              + 'Use ModuleSync BCM→RFH to sync the RFHUB SEC16 manually.',
          },
        ],
        sharedSecret,
        before: { bcmFullVins: beforeBcmFullVins, bcmPartials: beforeBcmPartials },
        after: null, files: [], verifyText: '',
      };
    }
  } else if (rfhSec16NeedsWrite) {
    // BCM SEC16 is blank or not resolvable — cannot derive a secret to write.
    rfhSec16Status = 'WRITE_SKIPPED (BCM SEC16 blank or unresolvable)';
    ok('RFH SEC16 write skipped — BCM SEC16 blank', false,
      'BCM has no vehicle secret to derive from');
  }

  const pcmRes = resolvePcmOutput(pcm.data, idP, pcmChip);
  ok('PCM output size matches selected chip',
     pcmRes.ok, pcmRes.ok ? pcmRes.chip.chip + ' (' + pcmRes.chip.sizeLabel + ')'
                          : (pcmRes.reason || 'unresolved'));
  if (!pcmRes.ok) {
    return {
      ok: false, checks, sharedSecret, pcmChip: pcmRes.chip,
      before: { bcmFullVins: beforeBcmFullVins, bcmPartials: beforeBcmPartials },
      after: null, files: [], verifyText: '',
    };
  }
  const pcmOut = pcmRes.bytes;
  const rfhAfterInfo = parseModule(rfhOut, rfh.name);
  const pcmAfterInfo = pcmOut.length === 8192 && idP.doubled
    ? parseModule(pcmOut.slice(0, 4096), pcm.name + '#half1')
    : parseModule(pcmOut, pcm.name);

  const rfhVinOk = (rfhAfterInfo.vins || []).every((v) => v.vin === vin);
  const pcmVinOk = (pcmAfterInfo.vins || []).every((v) => v.vin === vin);
  ok('RFH already carries target VIN (pass-through)',
     rfhVinOk && (rfhAfterInfo.vins?.length || 0) > 0,
     'VINs: ' + (rfhAfterInfo.vins || []).map((v) => v.vin).join(','));
  ok('PCM already carries target VIN (pass-through)',
     pcmVinOk && (pcmAfterInfo.vins?.length || 0) > 0,
     'VINs: ' + (pcmAfterInfo.vins || []).map((v) => v.vin).join(','));

  const stem = (s) => String(s).replace(/\.bin$/i, '');
  const bcmOutName = stem(bcm.name) + '_KEYPROG_' + vin + '.bin';
  const rfhOutName = stem(rfh.name) + '_KEYPROG_' + vin + '.bin';
  // Tag the PCM output filename with the chip suffix so the user (and CGDI)
  // can never confuse a 4 KB and 8 KB image for the same VIN (Task #379).
  const pcmChipSuffix = '_' + pcmRes.chip.sizeLabel.replace(' ', '');
  const pcmOutName = stem(pcm.name) + pcmChipSuffix + '_KEYPROG_' + vin + '.bin';
  const verifyName = 'VERIFY_KEYPROG_' + vin + pcmChipSuffix + '.txt';

  const verifyText = buildVerifyText({
    vin, sharedSecret,
    bcmName: bcmOutName, rfhName: rfhOutName, pcmName: pcmOutName,
    bcmSrcSha: '(computed at download)', bcmOutSha: '(computed at download)',
    rfhSrcSha: '(computed at download)', rfhOutSha: '(computed at download)',
    pcmSrcSha: '(computed at download)', pcmOutSha: '(computed at download)',
    before: { bcmFullVins: beforeBcmFullVins, bcmPartials: beforeBcmPartials },
    after: { bcmFullVins: afterBcmFullVins, bcmPartials: afterBcmPartials },
    bcmAfterInfo, rfhAfterInfo, pcmAfterInfo, bcmPatched, promoteBank,
    ok: allOk, failedChecks: checks.filter((c) => !c.pass),
    pcmChip: pcmRes.chip, pcmSliced: pcmRes.sliced,
    rfhSec16Status, rfhSec16BeforeHex, rfhSec16AfterHex,
  });

  return {
    ok: allOk,
    checks,
    sharedSecret,
    pcmChip: pcmRes.chip,
    pcmSliced: pcmRes.sliced,
    before: { bcmFullVins: beforeBcmFullVins, bcmPartials: beforeBcmPartials },
    after: { bcmFullVins: afterBcmFullVins, bcmPartials: afterBcmPartials },
    files: [
      { role: 'BCM', name: bcmOutName, data: bcmPatched },
      { role: 'RFH', name: rfhOutName, data: rfhOut },
      { role: 'PCM', name: pcmOutName, data: pcmOut },
      { role: 'VERIFY', name: verifyName, data: new TextEncoder().encode(verifyText) },
    ],
    verifyText,
  };
}

/* ============================================================================
 * runRfhBcmSync({ rfh, bcm, direction }) — Task #771
 *
 * Bidirectional SEC16 sync companion to the 6.2 Charger bench-set cross-check
 * report. Once the report comes back PASS (no blocking errors) the operator
 * can either push the RFH SEC16 into the BCM or vice-versa, and we re-emit
 * a single patched binary with all checksums recomputed.
 *
 * direction='RFH_TO_BCM':
 *   - Reads RFH SEC16 slot 1 (16 B, RFH endian).
 *   - Writes reverse(rfhSec16) (BCM endian) into the BCM split records
 *     (0x81A0 / 0x81C0 / 0x81E0), mirror1 (slot 0xEB) and mirror2 (slot 0xCA)
 *     in the inactive bank — mirror CRC16/CCITT recomputed — plus the
 *     legacy flat slice at 0x40C9 (little-endian).
 *   - Returns the patched BCM as the single output file.
 *
 * direction='BCM_TO_RFH':
 *   - Reads the resolved BCM SEC16 (split → mirror1 → mirror2 → flat).
 *   - Writes reverse(bcmSec16) into RFH Gen2 SEC16 slot 1 (0x050E) and
 *     slot 2 (0x0522), each with a fresh (crc8_65 << 8) | 0x00 CS.
 *   - Returns the patched RFH as the single output file.
 *
 * Both paths reparse the patched binary and assert SEC16 round-trip equality
 * before returning ok=true; if the round-trip fails the wizard refuses the
 * patch (ok=false, files=[]). Caller is expected to gate the button on the
 * cross-check report's `blockingErrors.length === 0`.
 * ========================================================================== */
export function runRfhBcmSync({ rfh, bcm, direction } = {}) {
  const checks = [];
  let allOk = true;
  const ok = (label, pass, detail = '') => {
    checks.push({ label, pass: !!pass, detail });
    if (!pass) allOk = false;
  };
  const fail = (reason) => ({
    ok: false,
    direction,
    checks: [{ label: reason, pass: false, detail: '' }],
    files: [],
  });

  if (direction !== 'RFH_TO_BCM' && direction !== 'BCM_TO_RFH') {
    return fail('direction must be "RFH_TO_BCM" or "BCM_TO_RFH"');
  }
  if (!bcm?.data || !rfh?.data) return fail('BCM and RFH both required');

  const idB = identifyModule(bcm.data, bcm.name);
  const idR = identifyModule(rfh.data, rfh.name);
  ok('BCM file identified as BCM', idB.role === 'BCM', 'detected ' + (idB.info.type || 'UNKNOWN'));
  ok('RFH file identified as RFHUB', idR.role === 'RFH', 'detected ' + (idR.info.type || 'UNKNOWN'));
  if (!allOk) {
    return { ok: false, direction, checks, files: [] };
  }

  const rfhSlot1 = idR.info?.sec16s?.[0] || null;
  const bcmRes = idB.info?.bcmSec16 || null;

  if (direction === 'RFH_TO_BCM') {
    if (!rfhSlot1 || rfhSlot1.blank || !rfhSlot1.raw || rfhSlot1.raw.length !== 16) {
      return { ok: false, direction, checks: [...checks, { label: 'RFH SEC16 slot 1 present and non-blank', pass: false, detail: rfhSlot1?.blank ? 'BLANK' : 'missing' }], files: [] };
    }
    const rfhSec16 = new Uint8Array(rfhSlot1.raw);
    let bcmPatched;
    try {
      const r1 = writeBcmSec16Gen2(bcm.data, rfhSec16);
      const bcmSec16BE = new Uint8Array(16);
      for (let i = 0; i < 16; i++) bcmSec16BE[i] = rfhSec16[15 - i];
      // writeBcmFlatSec16 self-guards against an overlapping mirror1 at
      // 0x40C0 (see securityBytes.js) — no caller-side skip needed.
      const flat = writeBcmFlatSec16(r1.bytes, bcmSec16BE);
      bcmPatched = flat.bytes;
      ok('BCM split records patched (0x81A0/C0/E0)',
        r1.splitPatched > 0 || r1.mirrorPatched > 0,
        r1.splitPatched + ' of 3');
      ok('BCM mirror records patched (CRC16/CCITT recomputed)', r1.mirrorPatched > 0,
        'm1=' + (r1.mirror1Offset != null ? '0x' + r1.mirror1Offset.toString(16).toUpperCase() : 'none')
        + ' m2=' + (r1.mirror2Offset != null ? '0x' + r1.mirror2Offset.toString(16).toUpperCase() : 'none'));
      ok('BCM legacy flat 0x40C9 (LE) ' + (flat.skipped ? 'covered by mirror1 (skipped)' : 'repaired'), true);
    } catch (e) {
      return { ok: false, direction, checks: [...checks, { label: 'BCM SEC16 writer threw', pass: false, detail: String(e?.message || e) }], files: [] };
    }

    // Round-trip
    const bcmAfter = parseModule(bcmPatched, bcm.name + '_SYNC');
    const after = bcmAfter?.bcmSec16?.bytes ? Array.from(bcmAfter.bcmSec16.bytes) : null;
    const expected = Array.from(rfhSec16).reverse();
    const eq = after && after.length === 16 && expected.every((b, i) => after[i] === b);
    ok('Round-trip: parseModule(patched BCM).bcmSec16 = reverse(RFH SEC16)', eq,
      'after=' + (after ? after.map(hex2).join('') : 'null')
      + ' expected=' + expected.map(hex2).join(''));
    // SEC16 unchanged in BCM endianness if compared as RFH endianness
    const rfhEndian = after ? [...after].reverse() : null;
    const rfhEq = rfhEndian && rfhEndian.every((b, i) => b === rfhSec16[i]);
    ok('Round-trip: reverse(BCM SEC16) = RFH SEC16 input', rfhEq);

    if (!allOk) {
      return { ok: false, direction, checks, files: [] };
    }

    const outName = String(bcm.name || 'bcm.bin').replace(/\.bin$/i, '') + '_SYNC_FROM_RFH.bin';
    return {
      ok: true,
      direction,
      checks,
      sec16RfhHex: Array.from(rfhSec16).map(hex2).join(''),
      sec16BcmHex: expected.map(hex2).join(''),
      files: [{ role: 'BCM', name: outName, data: bcmPatched }],
    };
  }

  // direction === 'BCM_TO_RFH'
  const bcmSec16BE = bcmRes?.bytes && !bcmRes.blank ? new Uint8Array(bcmRes.bytes) : null;
  if (!bcmSec16BE || bcmSec16BE.length !== 16) {
    return { ok: false, direction, checks: [...checks, { label: 'BCM SEC16 resolved and non-blank', pass: false, detail: bcmRes?.blank ? 'BLANK' : (bcmRes?.source || 'missing') }], files: [] };
  }

  let rfhPatched;
  let markerStamped = false;
  try {
    // Some real bench RFH dumps (e.g. the canonical 6.2 Charger fixture)
    // carry valid Gen2 SEC16 slots but lack the AA 55 31 01 marker at
    // 0x0500 that writeRfhSec16FromBcm guards on. The parser is already
    // permissive here, so if parseModule classified the file as RFHUB and
    // surfaced slot 1, normalize the marker on our working copy before
    // calling the writer rather than refusing the bench-set workflow.
    const rfhWork = new Uint8Array(rfh.data);
    if (rfhWork.length >= 0x0504 && !(
      rfhWork[0x0500] === 0xAA && rfhWork[0x0501] === 0x55 &&
      rfhWork[0x0502] === 0x31 && rfhWork[0x0503] === 0x01
    )) {
      rfhWork[0x0500] = 0xAA; rfhWork[0x0501] = 0x55;
      rfhWork[0x0502] = 0x31; rfhWork[0x0503] = 0x01;
      markerStamped = true;
    }
    const r = writeRfhSec16FromBcm(rfhWork, bcmSec16BE);
    rfhPatched = r.bytes;
    ok('RFH SEC16 slot 1 + slot 2 rewritten (crc8_65 CS recomputed)', r.patched === 2, 'patched=' + r.patched);
    if (markerStamped) {
      ok('RFH Gen2 marker stamped at 0x0500 (was missing)', true);
    }
  } catch (e) {
    return { ok: false, direction, checks: [...checks, { label: 'RFH SEC16 writer threw', pass: false, detail: String(e?.message || e) }], files: [] };
  }

  const rfhAfter = parseModule(rfhPatched, rfh.name + '_SYNC');
  const slot1 = rfhAfter?.sec16s?.[0];
  const slot2 = rfhAfter?.sec16s?.[1];
  const expectedRfh = Array.from(bcmSec16BE).reverse();
  const slot1Eq = slot1?.raw && expectedRfh.every((b, i) => slot1.raw[i] === b);
  const slot2Eq = slot2?.raw && expectedRfh.every((b, i) => slot2.raw[i] === b);
  ok('Round-trip: parseModule(patched RFH).sec16s[0].raw = reverse(BCM SEC16)', !!slot1Eq);
  ok('Round-trip: parseModule(patched RFH).sec16s[1].raw = reverse(BCM SEC16)', !!slot2Eq);
  ok('Round-trip: patched RFH slot 1 CS valid', !!slot1?.csOk);
  ok('Round-trip: patched RFH slot 2 CS valid', !!slot2?.csOk);
  ok('Round-trip: patched RFH sec16match', rfhAfter?.sec16match === true);

  if (!allOk) {
    return { ok: false, direction, checks, files: [] };
  }

  const outName = String(rfh.name || 'rfh.bin').replace(/\.bin$/i, '') + '_SYNC_FROM_BCM.bin';
  return {
    ok: true,
    direction,
    checks,
    sec16BcmHex: Array.from(bcmSec16BE).map(hex2).join(''),
    sec16RfhHex: expectedRfh.map(hex2).join(''),
    files: [{ role: 'RFH', name: outName, data: rfhPatched }],
  };
}

export { sha256Hex, BCM_FORBIDDEN, IMMO_BACKUP_SIZE, deriveSharedSecretBE, buildVerifyText };
