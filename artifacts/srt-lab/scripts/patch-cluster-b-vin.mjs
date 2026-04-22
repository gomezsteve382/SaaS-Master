#!/usr/bin/env node
/* ============================================================================
 * patch-cluster-b-vin.mjs — Task #342 one-shot patcher.
 *
 * Stamps VIN 2C3CDXCT1HH652640 into the Cluster B trio (BCM + RFH + PCM,
 * shared secret 816531F7CDE32E33C25A415C8440C72A) so the user can program
 * a key against the target vehicle. RFH and PCM already carry the correct
 * VIN; only the BCM needs patching. Pass-through files are written
 * verbatim; SHA-256 of those outputs must match the originals exactly.
 *
 * Refuses to write if any post-patch sanity check fails:
 *   - BCM critical regions (LE secret, mirror records, split records, both
 *     bank seq numbers, IMMO backup region) byte-identical to source.
 *   - All 4 BCM full VINs and both partial-VIN tails read the target VIN
 *     with valid CRC.
 *   - RFH and PCM SHA-256 match originals exactly.
 *
 * Outputs:
 *   attached_assets/<srcname>_KEYPROG_2C3CDXCT1HH652640.bin   (×3)
 *   attached_assets/VERIFY_KEYPROG_2C3CDXCT1HH652640.txt
 * ============================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseModule } from '../src/lib/parseModule.js';
import { writeModuleVIN } from '../src/lib/fileUtils.js';
import { crc16 } from '../src/lib/crc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ATTACHED = path.join(REPO_ROOT, 'attached_assets');

const TARGET_VIN = '2C3CDXCT1HH652640';
const SHARED_SECRET_HEX = '816531F7CDE32E33C25A415C8440C72A';

const SRC_BCM = '22CHARGER_REDEYE_6.2_797RFHUB_EEE_OGFILE_VIRGIN_1776900226655.bin';
const SRC_RFH = 'RFH_HERMANADO_20CHRGR6.2RFHUBFILE_EEE_OG_VIRGINSYCHNED_1776899205057.bin';
const SRC_PCM = 'FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2_1776899205055.bin';

/* Critical untouchable BCM regions (start, endExclusive). Patcher aborts if
 * any byte in these ranges differs between source and patched BCM. */
const BCM_FORBIDDEN = [
  [0x0002, 0x0004], // bank0 seq
  [0x4002, 0x4004], // bank1 seq
  [0x40C0, 0x40F8 + 1], // mirror1 record (slot 0xEB) + LE secret region
  [0x40E8, 0x4110],     // mirror2 record (slot 0xCA) — overlaps slightly with above; ranges union
  [0x81A0, 0x8200],     // 3 split records (0x81A0/C0/E0 each 32 bytes)
  [0x2000, 0x2000 + 192], // IMMO backup (8 records × 24 bytes)
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const fO = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

function readBin(name) {
  return new Uint8Array(fs.readFileSync(path.join(ATTACHED, name)));
}

function bytesEqual(a, b, start, end) {
  for (let i = start; i < end; i++) if (a[i] !== b[i]) return { ok: false, at: i, src: a[i], dst: b[i] };
  return { ok: true };
}

function fail(msg) {
  console.error('\n[ABORT] ' + msg);
  process.exit(1);
}

console.log('=== Cluster B VIN patcher ===');
console.log('Target VIN:', TARGET_VIN);

// ─── Read sources ───
const bcmSrc = readBin(SRC_BCM);
const rfhSrc = readBin(SRC_RFH);
const pcmSrc = readBin(SRC_PCM);

const bcmSrcSha = sha256(bcmSrc);
const rfhSrcSha = sha256(rfhSrc);
const pcmSrcSha = sha256(pcmSrc);

console.log('\nSource SHA-256:');
console.log('  BCM  ' + bcmSrcSha + '  (' + bcmSrc.length + ' B)');
console.log('  RFH  ' + rfhSrcSha + '  (' + rfhSrc.length + ' B)');
console.log('  PCM  ' + pcmSrcSha + '  (' + pcmSrc.length + ' B)');

// ─── Parse all three to baseline ───
const bcmInfoBefore = parseModule(bcmSrc, SRC_BCM);
const rfhInfoBefore = parseModule(rfhSrc, SRC_RFH);
// PCM is a doubled 8 KB dump (two copies of 4 KB; half-2 is 0xFF padding).
// The size-based detector classifies 8192-byte files as 95640, so for
// inspection we parse the first 4 KB as a GPEC2A. The output file remains
// the full 8 KB pass-through.
const pcmHalf1 = pcmSrc.slice(0, 4096);
const pcmInfoBefore = parseModule(pcmHalf1, SRC_PCM + '#half1');

if (bcmInfoBefore.type !== 'BCM') fail('BCM source did not parse as BCM (type=' + bcmInfoBefore.type + ')');
if (rfhInfoBefore.type !== 'RFHUB') fail('RFH source did not parse as RFHUB (type=' + rfhInfoBefore.type + ')');
if (pcmInfoBefore.type !== 'GPEC2A') fail('PCM half-1 did not parse as GPEC2A (type=' + pcmInfoBefore.type + ')');
// Confirm half-2 is the expected 0xFF padding so we don't ship a corrupted file.
const half2 = pcmSrc.slice(4096);
if (!half2.every((b) => b === 0xFF)) fail('PCM half-2 is not all-0xFF padding (unexpected layout)');

console.log('\nBCM source full VINs:');
for (const v of bcmInfoBefore.vins) console.log('  ' + fO(v.offset) + ' (slotBase=' + fO(v.slotBase) + ' hdr=' + v.headerBytes + ')  ' + v.vin);
console.log('BCM source partial VINs:');
for (const p of bcmInfoBefore.partialVins) console.log('  ' + fO(p.offset) + '  ' + p.tail + ' crcOk=' + p.crcOk);

if (bcmInfoBefore.vins.length !== 4) fail('Expected 4 BCM full VINs, got ' + bcmInfoBefore.vins.length);

// Verify shared secret matches expected so we know we're patching the right cluster.
const bcmSecretHex = bcmInfoBefore.vehicleSecret.hex.replace(/ /g, '');
// BCM stores LE; reverse to get the canonical "shared secret" form.
const bcmSecretBytes = Array.from(bcmInfoBefore.vehicleSecret.bytes).reverse();
const bcmSecretBE = bcmSecretBytes.map(hex).join('');
console.log('\nBCM secret (LE @0x40C9): ' + bcmSecretHex);
console.log('BCM secret (BE form):    ' + bcmSecretBE);
if (bcmSecretBE !== SHARED_SECRET_HEX) fail('BCM secret does not match expected Cluster B shared secret');

const rfhSec16Hex = rfhInfoBefore.sec16s[0].hex.toUpperCase();
console.log('RFH SEC16 slot1:         ' + rfhSec16Hex);
if (rfhSec16Hex !== SHARED_SECRET_HEX) fail('RFH SEC16 does not match expected Cluster B shared secret');

const pcmSec6Hex = pcmInfoBefore.pcmSec6.hex.replace(/ /g, '');
console.log('PCM SEC6:                ' + pcmSec6Hex);
if (!SHARED_SECRET_HEX.startsWith(pcmSec6Hex)) fail('PCM SEC6 is not the prefix of the shared secret');

// ─── Patch BCM ───
// writeModuleVIN auto-syncs the IMMO backup region (0x2000←0x40C0) at the
// end of every BCM write. On this dump bank0 (containing 0x2000) is the
// ACTIVE bank and bank1 (containing 0x40C0) holds the new staged secret, so
// that auto-sync would prematurely promote the staged secret into the
// active bank — exactly what Critical Constraint #2 forbids ("Don't
// promote the bank"). We let the writer run, then restore the original
// 0x2000..0x2000+IMMO_BLOCK bytes byte-for-byte from the source so the
// next ECU boot still sees the unchanged active bank.
const bcmPatched = writeModuleVIN(bcmSrc, 'BCM', TARGET_VIN, bcmInfoBefore.vins);
if (!bcmPatched) fail('writeModuleVIN returned null');

const IMMO_BACKUP_SIZE = 24 * 8; // IMMO_REC × IMMO_KC = 192 bytes
for (let i = 0; i < IMMO_BACKUP_SIZE; i++) {
  bcmPatched[0x2000 + i] = bcmSrc[0x2000 + i];
}

// ─── Verify forbidden regions unchanged ───
for (const [s, e] of BCM_FORBIDDEN) {
  const r = bytesEqual(bcmSrc, bcmPatched, s, e);
  if (!r.ok) fail('Forbidden region changed at ' + fO(r.at) + ' (src=' + hex(r.src) + ' dst=' + hex(r.dst) + ')');
}
console.log('\n[OK] All forbidden BCM regions byte-identical to source.');

// ─── Reparse patched BCM ───
const bcmInfoAfter = parseModule(bcmPatched, SRC_BCM + '_patched');
// Cardinality guard: if reparse drops slots, the per-slot loop below would
// silently skip them — abort instead.
if (bcmInfoAfter.vins.length !== bcmInfoBefore.vins.length) {
  fail('Post-patch full-VIN count ' + bcmInfoAfter.vins.length + ' != source ' + bcmInfoBefore.vins.length);
}
if (bcmInfoAfter.partialVins.length !== bcmInfoBefore.partialVins.length) {
  fail('Post-patch partial-VIN count ' + bcmInfoAfter.partialVins.length + ' != source ' + bcmInfoBefore.partialVins.length);
}
console.log('\nBCM patched full VINs:');
for (const v of bcmInfoAfter.vins) {
  const slot = bcmPatched.slice(v.offset, v.offset + 17);
  const crcStored = (bcmPatched[v.offset + 17] << 8) | bcmPatched[v.offset + 18];
  const crcCalc = crc16(slot);
  const crcOk = crcStored === crcCalc;
  console.log('  ' + fO(v.offset) + '  ' + v.vin + '  CRC=' + fO(crcStored) + ' calc=' + fO(crcCalc) + ' ' + (crcOk ? 'OK' : 'BAD'));
  if (v.vin !== TARGET_VIN) fail('Full VIN at ' + fO(v.offset) + ' is ' + v.vin + ', expected ' + TARGET_VIN);
  if (!crcOk) fail('Full VIN CRC mismatch at ' + fO(v.offset));
}
console.log('BCM patched partial VINs:');
const expectedTail = TARGET_VIN.slice(9);
for (const p of bcmInfoAfter.partialVins) {
  console.log('  ' + fO(p.offset) + '  ' + p.tail + '  crcOk=' + p.crcOk);
  if (p.tail !== expectedTail) fail('Partial VIN tail at ' + fO(p.offset) + ' is ' + p.tail + ', expected ' + expectedTail);
  if (!p.crcOk) fail('Partial VIN CRC mismatch at ' + fO(p.offset));
}

// ─── Verify slot trailers (5 bytes after CRC) preserved ───
for (const v of bcmInfoBefore.vins) {
  const trailerStart = v.offset + 19;
  const trailerEnd = v.slotBase + 32; // each slot region is 32 bytes
  if (trailerEnd > bcmSrc.length) continue;
  const r = bytesEqual(bcmSrc, bcmPatched, trailerStart, trailerEnd);
  if (!r.ok) fail('VIN-slot trailer at ' + fO(r.at) + ' changed (src=' + hex(r.src) + ' dst=' + hex(r.dst) + ')');
  // Header bytes (before VIN) too
  if (v.headerBytes > 0) {
    const r2 = bytesEqual(bcmSrc, bcmPatched, v.slotBase, v.offset);
    if (!r2.ok) fail('VIN-slot header at ' + fO(r2.at) + ' changed (src=' + hex(r2.src) + ' dst=' + hex(r2.dst) + ')');
  }
}
console.log('[OK] All BCM VIN-slot headers and trailers preserved.');

// ─── Pass-through verification for RFH and PCM ───
// We don't run them through the writer at all — copy verbatim and confirm
// they already carry the target VIN.
const rfhOut = new Uint8Array(rfhSrc);
const pcmOut = new Uint8Array(pcmSrc);
const rfhOutSha = sha256(rfhOut);
const pcmOutSha = sha256(pcmOut);
if (rfhOutSha !== rfhSrcSha) fail('RFH pass-through SHA mismatch');
if (pcmOutSha !== pcmSrcSha) fail('PCM pass-through SHA mismatch');

const rfhInfoAfter = parseModule(rfhOut, SRC_RFH);
const pcmInfoAfter = parseModule(pcmOut.slice(0, 4096), SRC_PCM + '#half1');
for (const v of rfhInfoAfter.vins) {
  if (v.vin !== TARGET_VIN) fail('RFH VIN at ' + fO(v.offset) + ' is ' + v.vin + ' (expected ' + TARGET_VIN + ')');
}
for (const v of pcmInfoAfter.vins) {
  if (v.vin !== TARGET_VIN) fail('PCM VIN at ' + fO(v.offset) + ' is ' + v.vin + ' (expected ' + TARGET_VIN + ')');
}
console.log('[OK] RFH and PCM pass-through verified (SHA unchanged, VINs already ' + TARGET_VIN + ').');

// ─── Write outputs ───
const stem = (s) => s.replace(/\.bin$/i, '');
const outBcm = stem(SRC_BCM) + '_KEYPROG_' + TARGET_VIN + '.bin';
const outRfh = stem(SRC_RFH) + '_KEYPROG_' + TARGET_VIN + '.bin';
const outPcm = stem(SRC_PCM) + '_KEYPROG_' + TARGET_VIN + '.bin';
fs.writeFileSync(path.join(ATTACHED, outBcm), Buffer.from(bcmPatched));
fs.writeFileSync(path.join(ATTACHED, outRfh), Buffer.from(rfhOut));
fs.writeFileSync(path.join(ATTACHED, outPcm), Buffer.from(pcmOut));

const bcmOutSha = sha256(bcmPatched);

// ─── VERIFY.txt ───
const lines = [];
lines.push('Cluster B key-prog patch — VERIFY report');
lines.push('=========================================');
lines.push('Target VIN:           ' + TARGET_VIN);
lines.push('Shared secret (BE):   ' + SHARED_SECRET_HEX);
lines.push('Generated:            ' + new Date().toISOString());
lines.push('');
lines.push('-- BCM ' + outBcm);
lines.push('   src SHA-256: ' + bcmSrcSha);
lines.push('   out SHA-256: ' + bcmOutSha);
lines.push('   Full VIN slots (BEFORE → AFTER):');
for (let i = 0; i < bcmInfoBefore.vins.length; i++) {
  const b = bcmInfoBefore.vins[i], a = bcmInfoAfter.vins[i];
  lines.push('     ' + fO(a.offset) + '  ' + b.vin + ' → ' + a.vin);
}
lines.push('   Partial VIN tails (BEFORE → AFTER):');
for (let i = 0; i < bcmInfoBefore.partialVins.length; i++) {
  const b = bcmInfoBefore.partialVins[i], a = bcmInfoAfter.partialVins[i];
  lines.push('     ' + fO(a.offset) + '  ' + b.tail + ' → ' + a.tail + '  (crcOk=' + a.crcOk + ')');
}
lines.push('   Vehicle secret (LE @0x40C9): ' + bcmInfoAfter.vehicleSecret.hex + '  [unchanged]');
lines.push('   IMMO records (primary):      ' + bcmInfoAfter.immoRecs);
lines.push('   IMMO backup synced:          ' + bcmInfoAfter.immoSynced);
lines.push('   Bank0 seq @0x0002:           ' + hex(bcmPatched[0x0002]) + ' ' + hex(bcmPatched[0x0003]) + '  [unchanged]');
lines.push('   Bank1 seq @0x4002:           ' + hex(bcmPatched[0x4002]) + ' ' + hex(bcmPatched[0x4003]) + '  [unchanged]');
lines.push('');
lines.push('-- RFH ' + outRfh + '  (PASS-THROUGH)');
lines.push('   src SHA-256: ' + rfhSrcSha);
lines.push('   out SHA-256: ' + rfhOutSha + '  [identical]');
lines.push('   Full VINs:');
for (const v of rfhInfoAfter.vins) lines.push('     ' + fO(v.offset) + '  ' + v.vin + '  (cs=' + hex(v.sc) + ' calc=' + hex(v.cc) + ' ok=' + v.crcOk + ')');
lines.push('   SEC16 slot1 (= shared secret BE): ' + rfhInfoAfter.sec16s[0].hex.toUpperCase());
lines.push('   SEC16 csOk:                       ' + rfhInfoAfter.sec16s[0].csOk);
lines.push('');
lines.push('-- PCM ' + outPcm + '  (PASS-THROUGH)');
lines.push('   src SHA-256: ' + pcmSrcSha);
lines.push('   out SHA-256: ' + pcmOutSha + '  [identical]');
lines.push('   Full VINs:');
for (const v of pcmInfoAfter.vins) lines.push('     ' + fO(v.offset) + '  ' + v.vin);
lines.push('   PCM SEC6 (= first 6 bytes of shared secret): ' + pcmInfoAfter.pcmSec6.hex);
lines.push('');
lines.push('Status: PASS — three files ready to flash for key programming.');

const verifyName = 'VERIFY_KEYPROG_' + TARGET_VIN + '.txt';
fs.writeFileSync(path.join(ATTACHED, verifyName), lines.join('\n') + '\n');

console.log('\n=== Wrote 4 files to attached_assets/ ===');
console.log('  ' + outBcm);
console.log('  ' + outRfh);
console.log('  ' + outPcm);
console.log('  ' + verifyName);
console.log('\nPASS — ready to flash.');
