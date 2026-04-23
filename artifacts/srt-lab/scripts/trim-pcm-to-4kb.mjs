#!/usr/bin/env node
/* ============================================================================
 * trim-pcm-to-4kb.mjs — Task #378 one-shot rescue.
 *
 * Some PCM_SYNCED outputs were emitted at 8,192 bytes when the bench EXT
 * EEPROM chip is actually a 95320 (4,096 bytes). For the affected files the
 * lower 4 KB carries the real VIN-patched payload and the upper 4 KB is
 * entirely 0xFF padding, so trimming to the first half is lossless and
 * produces a file the CGDI flasher will accept.
 *
 * For each candidate input under attached_assets/:
 *   1. Verify file size == 8192 and upper 4 KB is all-0xFF.
 *   2. Verify all four PCM VIN slots (0x0000, 0x01F0, 0x0224, 0x0CE0) read
 *      the VIN embedded in the source filename.
 *   3. Write attached_assets/PCM_SYNCED_<vin>_4KB_<ts>.bin (4096 bytes).
 *   4. Re-verify VIN slots on the trimmed output.
 *
 * Emits attached_assets/VERIFY_PCM_SYNCED_4KB_RESCUE.txt with size/SHA/VIN
 * audit for every file processed.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ATTACHED = path.join(REPO_ROOT, 'attached_assets');

const PCM_VIN_OFFSETS = [0x0000, 0x01F0, 0x0224, 0x0CE0];
const VIN_LEN = 17;
const TARGET_HALF = 4096;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fO = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

function fail(msg) {
  console.error('\n[ABORT] ' + msg);
  process.exit(1);
}

function vinFromFilename(name) {
  const m = name.match(/PCM_SYNCED_([0-9A-HJ-NPR-Z]{17})_/);
  return m ? m[1] : null;
}

function readVinAt(buf, off) {
  if (off + VIN_LEN > buf.length) return null;
  return Buffer.from(buf.slice(off, off + VIN_LEN)).toString('latin1');
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_'
    + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

const candidates = fs.readdirSync(ATTACHED)
  .filter((n) => /^PCM_SYNCED_.*\.bin$/.test(n) && !/_4KB_/.test(n))
  .sort();

if (candidates.length === 0) fail('No PCM_SYNCED_*.bin candidates in attached_assets/');

console.log('=== Task #378 PCM 4 KB rescue ===');
console.log('Found ' + candidates.length + ' candidate(s):');
for (const c of candidates) console.log('  ' + c);
console.log('');

const ts = timestamp();
const report = [];
report.push('PCM_SYNCED 4 KB rescue — VERIFY report (Task #378)');
report.push('==================================================');
report.push('Generated:   ' + new Date().toISOString());
report.push('Tool:        artifacts/srt-lab/scripts/trim-pcm-to-4kb.mjs');
report.push('Trim policy: keep first 4096 bytes; require upper 4 KB to be all 0xFF');
report.push('VIN slots verified at: ' + PCM_VIN_OFFSETS.map(fO).join(', '));
report.push('');

const outputs = [];
for (const name of candidates) {
  const inPath = path.join(ATTACHED, name);
  const inBuf = new Uint8Array(fs.readFileSync(inPath));
  const inSha = sha256(inBuf);

  report.push('-- INPUT  ' + name);
  report.push('   size:        ' + inBuf.length + ' bytes');
  report.push('   sha256:      ' + inSha);

  if (inBuf.length !== 8192) {
    report.push('   SKIP: size != 8192 (rescue applies only to 8 KB files)');
    report.push('');
    console.log('  [SKIP] ' + name + ' — size ' + inBuf.length + ' != 8192');
    continue;
  }

  // Upper-half-must-be-FF invariant.
  const upper = inBuf.slice(TARGET_HALF);
  let nonFf = 0;
  const nonFfSamples = [];
  for (let i = 0; i < upper.length; i++) {
    if (upper[i] !== 0xFF) {
      nonFf++;
      if (nonFfSamples.length < 8) nonFfSamples.push(fO(TARGET_HALF + i));
    }
  }
  if (nonFf > 0) {
    fail('Upper 4 KB of ' + name + ' contains ' + nonFf + ' non-0xFF byte(s) (sample offsets: '
      + nonFfSamples.join(', ') + '). Refusing to trim — would lose data.');
  }
  report.push('   upper 4 KB:  all 0xFF (verified ' + upper.length + ' bytes)');

  const expectedVin = vinFromFilename(name);
  if (!expectedVin) fail('Could not parse VIN from filename: ' + name);

  // Verify input VIN slots.
  const inSlots = PCM_VIN_OFFSETS.map((off) => ({ off, vin: readVinAt(inBuf, off) }));
  for (const s of inSlots) {
    if (s.vin !== expectedVin) {
      fail('Input ' + name + ' VIN slot ' + fO(s.off) + ' = "' + s.vin
        + '", expected "' + expectedVin + '". Refusing to trim a corrupt source.');
    }
  }
  report.push('   VIN slots:   all 4 slots = ' + expectedVin + ' [OK]');

  // Trim.
  const out = inBuf.slice(0, TARGET_HALF);
  const outName = 'PCM_SYNCED_' + expectedVin + '_4KB_' + ts + '.bin';
  const outPath = path.join(ATTACHED, outName);
  fs.writeFileSync(outPath, Buffer.from(out));

  // Re-verify on-disk.
  const written = new Uint8Array(fs.readFileSync(outPath));
  const outSha = sha256(written);
  if (outSha !== sha256(out)) fail('On-disk SHA mismatch for ' + outName);
  if (written.length !== TARGET_HALF) fail('Trimmed output size != 4096 for ' + outName);

  // Re-verify VIN slots on output.
  const outSlots = PCM_VIN_OFFSETS.map((off) => ({ off, vin: readVinAt(written, off) }));
  for (const s of outSlots) {
    if (s.vin !== expectedVin) {
      fail('Output ' + outName + ' VIN slot ' + fO(s.off) + ' = "' + s.vin
        + '", expected "' + expectedVin + '" after trim.');
    }
  }

  // Confirm the trimmed bytes are byte-identical to the input's first half.
  const inHalf = inBuf.slice(0, TARGET_HALF);
  if (sha256(inHalf) !== outSha) fail('Trim is not byte-identical to input first half for ' + outName);

  report.push('-- OUTPUT ' + outName);
  report.push('   size:        ' + written.length + ' bytes');
  report.push('   sha256:      ' + outSha);
  report.push('   VIN slots:   all 4 slots = ' + expectedVin + ' [OK]');
  report.push('   parity:      byte-identical to input bytes 0x0000..0x0FFF [OK]');
  report.push('');

  console.log('  [OK]  ' + name);
  console.log('         → ' + outName);
  console.log('         sha256 = ' + outSha);

  outputs.push({ name: outName, sha: outSha, vin: expectedVin });
}

if (outputs.length === 0) fail('No files were trimmed — nothing to ship.');

report.push('Status: PASS — ' + outputs.length + ' file(s) trimmed and verified.');
report.push('');
report.push('Next step: load each *_4KB_*.bin into the CGDI as the EXT EEPROM');
report.push('write target. The programmer will accept a 4 KB file because it');
report.push('matches the 95320 chip on the bench.');

const reportPath = path.join(ATTACHED, 'VERIFY_PCM_SYNCED_4KB_RESCUE.txt');
fs.writeFileSync(reportPath, report.join('\n') + '\n');

console.log('\nWrote VERIFY_PCM_SYNCED_4KB_RESCUE.txt');
console.log('PASS — ' + outputs.length + ' file(s) ready.');
