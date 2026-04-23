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
  if (!bcmInfo?.vehicleSecret?.bytes) return null;
  const reversed = Array.from(bcmInfo.vehicleSecret.bytes).reverse();
  return reversed.map(hex2).join('');
}

function bytesEqualRange(a, b, start, end) {
  for (let i = start; i < end; i++) if (a[i] !== b[i]) return { ok: false, at: i };
  return { ok: true };
}

function buildVerifyText({
  vin, sharedSecret, bcmName, rfhName, pcmName,
  bcmSrcSha, bcmOutSha, rfhSrcSha, rfhOutSha, pcmSrcSha, pcmOutSha,
  before, after, bcmAfterInfo, rfhAfterInfo, pcmAfterInfo,
  bcmPatched, promoteBank, ok, failedChecks = [],
  pcmChip, pcmSliced,
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
    lines.push('   Vehicle secret (LE @0x40C9): ' + bcmAfterInfo.vehicleSecret.hex + '  [unchanged]');
  }
  lines.push('   Bank0 seq @0x0002:           ' + hex2(bcmPatched[0x0002]) + ' ' + hex2(bcmPatched[0x0003]) + '  [unchanged]');
  lines.push('   Bank1 seq @0x4002:           ' + hex2(bcmPatched[0x4002]) + ' ' + hex2(bcmPatched[0x4003]) + '  [unchanged]');
  lines.push('');
  lines.push('-- RFH ' + rfhName + '  (PASS-THROUGH)');
  lines.push('   src SHA-256: ' + rfhSrcSha);
  lines.push('   out SHA-256: ' + rfhOutSha + '  [identical]');
  if (rfhAfterInfo?.vins?.length) {
    lines.push('   Full VINs:');
    for (const v of rfhAfterInfo.vins) {
      lines.push('     ' + fO(v.offset) + '  ' + v.vin + '  (crcOk=' + v.crcOk + ')');
    }
  }
  if (rfhAfterInfo?.sec16s?.[0]?.hex) {
    lines.push('   SEC16 slot1 (= shared secret BE): ' + rfhAfterInfo.sec16s[0].hex.toUpperCase());
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
  ok('RFH file identified as RFHUB', idR.role === 'RFH', 'detected ' + (idR.info.type || 'UNKNOWN'));
  ok('PCM file identified as GPEC2A', idP.role === 'PCM', 'detected ' + (idP.info.type || 'UNKNOWN'));
  if (idP.role === 'PCM' && idP.doubled) {
    ok('PCM half-2 is 0xFF padding', idP.halfPad === true);
  }

  const sharedSecret = idB.role === 'BCM' ? deriveSharedSecretBE(idB.info) : null;
  if (sharedSecret && idR.info?.sec16s?.[0]?.hex) {
    const rfhSec = String(idR.info.sec16s[0].hex).toUpperCase();
    ok('RFH SEC16 slot1 matches BCM secret (BE)', rfhSec === sharedSecret, 'RFH=' + rfhSec);
  } else if (idR.role === 'RFH') {
    ok('RFH SEC16 slot1 matches BCM secret (BE)', false, 'RFH SEC16 not parsed');
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

  // ── RFH pass-through; PCM size resolution per --pcm-chip / auto-pick (#379) ──
  const rfhOut = new Uint8Array(rfh.data);
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

export { sha256Hex, BCM_FORBIDDEN, IMMO_BACKUP_SIZE };
