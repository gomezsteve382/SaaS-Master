#!/usr/bin/env node
/* Demo: load 6.2 Charger bench-set (BCM + RFHUB + PCM/ECM), report the
 * security-byte state across the three modules, then run the bidirectional
 * sync (RFH→BCM and BCM→RFH) and surface the byte-level deltas.
 *
 * This is the same code path the Module Sync tab runs in the browser —
 * just driven from Node so we can see it end-to-end without a bench. */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModule } from '../src/lib/parseModule.js';
import { crossValidate } from '../src/lib/crossValidate.js';
import { runRfhBcmSync } from '../src/lib/keyProgWizard.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const FIXTURES = {
  bcm: 'public/bench-sets/bcm_6.2charger.bin',
  rfh: 'public/bench-sets/rfhubeee_6.2charger.bin',
  pcm: 'public/bench-sets/pcm_6.2charger.bin',
};

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const toHex = (a) => Array.from(a).map(hex).join(' ');

function load(rel) {
  const data = new Uint8Array(readFileSync(resolve(root, rel)));
  return { name: rel.split('/').pop(), data };
}

function bytesAt(buf, off, len) {
  return Array.from(buf.slice(off, off + len));
}

function diffRanges(a, b) {
  const diffs = [];
  let run = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (!run) run = { start: i, oldB: [], newB: [] };
      run.oldB.push(a[i]); run.newB.push(b[i]);
    } else if (run) {
      diffs.push({ ...run, end: i - 1 });
      run = null;
    }
  }
  if (run) diffs.push({ ...run, end: a.length - 1 });
  return diffs;
}

function fmtOff(o) { return '0x' + o.toString(16).toUpperCase().padStart(4, '0'); }

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  6.2 Charger bench-set — Module Sync demo');
console.log('══════════════════════════════════════════════════════════════════════\n');

const bcm = load(FIXTURES.bcm);
const rfh = load(FIXTURES.rfh);
const pcm = load(FIXTURES.pcm);

console.log('Loaded:');
console.log('  BCM   ' + bcm.data.length.toString().padStart(6) + ' B   ' + FIXTURES.bcm);
console.log('  RFHUB ' + rfh.data.length.toString().padStart(6) + ' B   ' + FIXTURES.rfh);
console.log('  PCM   ' + pcm.data.length.toString().padStart(6) + ' B   ' + FIXTURES.pcm);

const bcmInfo = parseModule(bcm.data, bcm.name);
const rfhInfo = parseModule(rfh.data, rfh.name);
const pcmInfo = parseModule(pcm.data, pcm.name);

console.log('\nParsed types:');
console.log('  BCM   → ' + bcmInfo.type);
console.log('  RFHUB → ' + rfhInfo.type);
console.log('  PCM   → ' + pcmInfo.type);

// ── Current security bytes ──
console.log('\n──────────────────────────────────────────────────────────────────────');
console.log(' Step 1 — Current security-byte state across the three modules');
console.log('──────────────────────────────────────────────────────────────────────');

const bcmSec = bcmInfo.bcmSec16;
const rfhSec0 = rfhInfo.sec16s?.[0];
const rfhSec1 = rfhInfo.sec16s?.[1];
const pcmSec6 = pcmInfo.pcmSec6;

console.log('\n BCM SEC16 (resolved):');
if (bcmSec?.bytes) {
  console.log('   source = ' + bcmSec.source);
  console.log('   bytes  = ' + toHex(bcmSec.bytes));
  console.log('   blank  = ' + !!bcmSec.blank);
} else {
  console.log('   (absent — ALERT_NO_SECURITY, VIN-only edition)');
}

console.log('\n RFHUB SEC16:');
if (rfhSec0?.raw) {
  console.log('   slot 1 = ' + toHex(rfhSec0.raw) + (rfhSec0.blank ? '  (BLANK)' : ''));
}
if (rfhSec1?.raw) {
  console.log('   slot 2 = ' + toHex(rfhSec1.raw) + (rfhSec1.blank ? '  (BLANK)' : ''));
}
console.log('   slots match? ' + !!rfhInfo.sec16valid);

console.log('\n PCM SEC6 (Continental GPEC2A):');
if (pcmSec6?.raw) {
  console.log('   bytes = ' + toHex(pcmSec6.raw));
} else {
  console.log('   (not parsed — likely IMMO-disabled variant or marker missing)');
}

// ── Cross-validate ──
console.log('\n──────────────────────────────────────────────────────────────────────');
console.log(' Step 2 — crossValidate verdicts');
console.log('──────────────────────────────────────────────────────────────────────');
const xv = crossValidate([bcmInfo, rfhInfo, pcmInfo]);
console.log('\n PASSED (' + xv.passed.length + '):');
xv.passed.forEach((s) => console.log('   ✓ ' + s));
if (xv.warnings.length) {
  console.log('\n WARNINGS (' + xv.warnings.length + '):');
  xv.warnings.forEach((s) => console.log('   ⚠ ' + s));
}
if (xv.errors?.length) {
  console.log('\n ERRORS (' + xv.errors.length + '):');
  xv.errors.forEach((s) => console.log('   ✗ ' + s));
}

// ── Run sync RFH → BCM ──
console.log('\n──────────────────────────────────────────────────────────────────────');
console.log(' Step 3 — runRfhBcmSync({ direction: "RFH_TO_BCM" })');
console.log('──────────────────────────────────────────────────────────────────────');
console.log(' Reads RFH SEC16 slot 1, reverses endian, writes to:');
console.log('   • BCM split records @ 0x81A0 / 0x81C0 / 0x81E0');
console.log('   • Mirror1 (slot 0xEB) + Mirror2 (slot 0xCA) in inactive bank');
console.log('   • Legacy flat slice @ 0x40C9 (LE)');
console.log(' Re-parses, asserts SEC16 round-trip equality.\n');

const r1 = runRfhBcmSync({ rfh, bcm, direction: 'RFH_TO_BCM' });
console.log(' Result: ok=' + r1.ok + (r1.reason ? ' reason="' + r1.reason + '"' : ''));
if (r1.files?.length) {
  for (const f of r1.files) {
    const d = diffRanges(bcm.data, f.data);
    console.log('\n Output file: ' + f.name + '  (' + f.data.length + ' B)');
    console.log(' Diff ranges (' + d.length + ' contiguous regions):');
    for (const x of d.slice(0, 12)) {
      console.log('   ' + fmtOff(x.start) + '..' + fmtOff(x.end) +
        '  (' + (x.end - x.start + 1) + ' B)' +
        '\n     - old: ' + toHex(x.oldB) +
        '\n     + new: ' + toHex(x.newB));
    }
    if (d.length > 12) console.log('   … (' + (d.length - 12) + ' more)');
  }
}

// ── Run sync BCM → RFH ──
console.log('\n──────────────────────────────────────────────────────────────────────');
console.log(' Step 4 — runRfhBcmSync({ direction: "BCM_TO_RFH" })');
console.log('──────────────────────────────────────────────────────────────────────');
console.log(' Reads resolved BCM SEC16 (split → mirror1 → mirror2 → flat),');
console.log(' reverses endian, writes to RFH Gen2 SEC16:');
console.log('   • Slot 1 @ 0x050E   (16 B + crc8_65 + 0x00)');
console.log('   • Slot 2 @ 0x0522   (16 B + crc8_65 + 0x00)');
console.log(' Re-parses, asserts SEC16 round-trip equality.\n');

const r2 = runRfhBcmSync({ rfh, bcm, direction: 'BCM_TO_RFH' });
console.log(' Result: ok=' + r2.ok + (r2.reason ? ' reason="' + r2.reason + '"' : ''));
if (r2.files?.length) {
  for (const f of r2.files) {
    const d = diffRanges(rfh.data, f.data);
    console.log('\n Output file: ' + f.name + '  (' + f.data.length + ' B)');
    console.log(' Diff ranges (' + d.length + ' contiguous regions):');
    for (const x of d.slice(0, 12)) {
      console.log('   ' + fmtOff(x.start) + '..' + fmtOff(x.end) +
        '  (' + (x.end - x.start + 1) + ' B)' +
        '\n     - old: ' + toHex(x.oldB) +
        '\n     + new: ' + toHex(x.newB));
    }
    if (d.length > 12) console.log('   … (' + (d.length - 12) + ' more)');
  }
}

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log(' Done.');
console.log('══════════════════════════════════════════════════════════════════════\n');
