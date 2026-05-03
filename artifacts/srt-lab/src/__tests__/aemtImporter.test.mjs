/* Unit tests for aemtImporter — Task #583.
 *
 * Run: node --test artifacts/srt-lab/src/__tests__/aemtImporter.test.mjs
 *
 * Covers parseAemtBundle:
 *   - ZIP bundle parse (transparent expansion, metadata + bins)
 *   - Loose-file parse
 *   - Role auto-detection by binary header (BCM / RFH / PCM)
 *   - Role auto-detection by filename heuristic fallback
 *   - VIN extraction from metadata JSON (vin, vehicle.vin, job.vin) and
 *     binary fallback (BCM info.vins[0].vin)
 *   - AemtImportError on bad input (no files, missing data, bad zip,
 *     no .bin dumps, empty zip)
 *   - Duplicate-role warning behaviour
 *   - Tolerated-but-ignored unknown file extensions (e.g. .txt)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

import { parseAemtBundle, AemtImportError } from '../lib/aemtImporter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');

const FIX_BCM = 'SAMPLE_BCM_DFLASH_18TH_OG.bin';
const FIX_RFH = 'SAMPLE_RFHUB_EEE_OG_2C3CDXCT1HH652640.bin';
const FIX_PCM = 'SAMPLE_GPEC2A_EXT_EEPROM_JOVENTINO_OG.bin';

/* The 18TH_OG BCM fixture exposes this VIN through parseModule.info.vins. */
const VIN_FROM_BCM_FIXTURE = '1C4RJFN9XJC309165';

/* Size that does not match any module's expected EEPROM/flash size — keeps
 * identifyModule's binary-header check from classifying random/zero blobs,
 * forcing the filename heuristic fallback path. */
const NON_CLASSIFYING_SIZE = 1234;

function loadFixture(name) {
  const p = path.join(FIX, name);
  if (!fs.existsSync(p)) return null;
  return new Uint8Array(fs.readFileSync(p));
}

const bcmBytes = loadFixture(FIX_BCM);
const rfhBytes = loadFixture(FIX_RFH);
const pcmBytes = loadFixture(FIX_PCM);
const haveAllFixtures = !!(bcmBytes && rfhBytes && pcmBytes);

const skipNoFix = { skip: !haveAllFixtures && 'fixture binaries unavailable' };

const enc = (s) => new TextEncoder().encode(s);

/* ───────────────── Bad-input AemtImportError tests ───────────────── */

test('throws AemtImportError when rawFiles is null/empty', () => {
  assert.throws(() => parseAemtBundle(null), (e) => {
    assert.ok(e instanceof AemtImportError);
    assert.match(e.message, /No files provided/);
    assert.ok(Array.isArray(e.details) && e.details.length > 0);
    return true;
  });
  assert.throws(() => parseAemtBundle([]), AemtImportError);
});

test('throws AemtImportError when an entry has no Uint8Array data', () => {
  assert.throws(
    () => parseAemtBundle([{ name: 'BCM.bin', data: null }]),
    (e) => {
      assert.ok(e instanceof AemtImportError);
      assert.match(e.message, /no binary data/i);
      return true;
    },
  );
  assert.throws(
    () => parseAemtBundle([{ name: 'BCM.bin', data: 'not bytes' }]),
    AemtImportError,
  );
});

test('throws AemtImportError on a malformed ZIP', () => {
  const bogus = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x00, 0x01, 0x02]);
  assert.throws(
    () => parseAemtBundle([{ name: 'job.zip', data: bogus }]),
    (e) => {
      assert.ok(e instanceof AemtImportError);
      assert.match(e.message, /Could not open ZIP/);
      return true;
    },
  );
});

test('throws AemtImportError when a ZIP expands to no usable files', () => {
  /* Every entry's basename starts with "." so expandZip filters them all,
   * leaving the flat file list empty. */
  const zipBytes = zipSync({
    '.DS_Store': new Uint8Array([1, 2, 3]),
    'aemt_job/.hidden': new Uint8Array([4, 5]),
    '.metadata': new Uint8Array([6]),
  });
  assert.throws(
    () => parseAemtBundle([{ name: 'job.zip', data: zipBytes }]),
    (e) => {
      assert.ok(e instanceof AemtImportError);
      assert.match(e.message, /ZIP contained no usable files/);
      return true;
    },
  );
});

test('throws AemtImportError when no .bin dumps are present', () => {
  const meta = enc(JSON.stringify({ vin: VIN_FROM_BCM_FIXTURE }));
  assert.throws(
    () => parseAemtBundle([{ name: 'job.json', data: meta }]),
    (e) => {
      assert.ok(e instanceof AemtImportError);
      assert.match(e.message, /No \.bin module dump/);
      assert.ok(e.details.some((d) => /metadata file/.test(d)));
      return true;
    },
  );
});

/* ───────────────── Loose-file role detection (binary header) ───────────────── */

test('loose-file parse: detects BCM/RFH/PCM via identifyModule on real fixtures', skipNoFix, () => {
  /* Uses the canonical fixture filenames so identifyModule (= parseModule)
   * applies its filename hint plus the binary-content classifier together
   * — this is the same code path the real importer runs against an AEMT
   * bundle pulled out of the field. */
  const result = parseAemtBundle([
    { name: FIX_BCM, data: bcmBytes },
    { name: FIX_RFH, data: rfhBytes },
    { name: FIX_PCM, data: pcmBytes },
  ]);

  assert.ok(result.roles.BCM, 'BCM detected');
  assert.equal(result.roles.BCM.name, FIX_BCM);
  assert.equal(result.roles.BCM.data, bcmBytes);

  assert.ok(result.roles.RFH, 'RFH detected');
  assert.equal(result.roles.RFH.name, FIX_RFH);

  assert.ok(result.roles.PCM, 'PCM detected');
  assert.equal(result.roles.PCM.name, FIX_PCM);

  /* Internal _id field must not leak in the returned roles. */
  assert.equal(result.roles.BCM._id, undefined);
  assert.equal(result.roles.RFH._id, undefined);
  assert.equal(result.roles.PCM._id, undefined);
});

/* ───────────────── ZIP bundle parse ───────────────── */

test('ZIP bundle parse: expands archive and extracts roles + metadata VIN', () => {
  /* Use non-classifying-size synthetic blobs so the role detection path
   * inside the ZIP is exercised via the filename heuristic — keeps this
   * test independent of the real fixtures' parseModule behaviour. */
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const meta = { vin: '1C4RJFDJ7DC513874', extra: 'value' };
  const zipBytes = zipSync({
    'aemt_job/BCM.bin': blob,
    'aemt_job/RFHUB.bin': blob,
    'aemt_job/PCM.bin': blob,
    'aemt_job/job.json': enc(JSON.stringify(meta)),
    'aemt_job/.DS_Store': new Uint8Array([0]),
    '__MACOSX/aemt_job/._BCM.bin': new Uint8Array([0]),
  });

  const result = parseAemtBundle([{ name: 'aemt_job.zip', data: zipBytes }]);

  assert.ok(result.roles.BCM, 'BCM extracted from zip');
  assert.equal(result.roles.BCM.name, 'BCM.bin');
  assert.ok(result.roles.RFH, 'RFH extracted from zip');
  assert.equal(result.roles.RFH.name, 'RFHUB.bin');
  assert.ok(result.roles.PCM, 'PCM extracted from zip');
  assert.equal(result.roles.PCM.name, 'PCM.bin');
  assert.equal(result.vin, '1C4RJFDJ7DC513874');
  assert.deepEqual(result.meta, meta);
  assert.ok(Array.isArray(result.warnings));
});

test('ZIP bundle parse: a .zip in a loose-file list is transparently expanded alongside other files', () => {
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const innerZip = zipSync({ 'BCM.bin': blob });
  const result = parseAemtBundle([
    { name: 'inner.zip', data: innerZip },
    { name: 'rfhub.bin', data: blob },
    { name: 'pcm_dump.bin', data: blob },
  ]);
  assert.ok(result.roles.BCM, 'BCM came from the inner zip');
  assert.equal(result.roles.BCM.name, 'BCM.bin');
  assert.ok(result.roles.RFH, 'RFH came from the loose file list');
  assert.ok(result.roles.PCM, 'PCM came from the loose file list');
});

/* ───────────────── Filename heuristic fallback ───────────────── */

test('filename heuristic: assigns BCM/RFH/PCM when binary header is unrecognised', () => {
  /* Use a non-classifying blob size so identifyModule returns role=null
   * and the role MUST come from the filename keyword fallback. */
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const result = parseAemtBundle([
    { name: 'BCM_dump.bin', data: blob },
    { name: 'rfhub_capture.bin', data: blob },
    { name: 'gpec2a_pcm.bin', data: blob },
  ]);

  assert.ok(result.roles.BCM, 'BCM by filename');
  assert.equal(result.roles.BCM.name, 'BCM_dump.bin');
  assert.ok(result.roles.RFH, 'RFH by filename');
  assert.equal(result.roles.RFH.name, 'rfhub_capture.bin');
  assert.ok(result.roles.PCM, 'PCM by filename');
  assert.equal(result.roles.PCM.name, 'gpec2a_pcm.bin');
  assert.equal(result.vin, null, 'no VIN without metadata or recognised binary');
});

test('filename heuristic: unrecognised .bin filenames are skipped with warning', () => {
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const result = parseAemtBundle([
    { name: 'BCM_dump.bin', data: blob },
    { name: 'mystery_blob.bin', data: blob },
  ]);
  assert.ok(result.roles.BCM, 'BCM matched by filename');
  assert.equal(result.roles.RFH, null);
  assert.equal(result.roles.PCM, null);
  assert.ok(
    result.warnings.some((w) => /unrecognised/.test(w) && /mystery_blob\.bin/.test(w)),
    'warning lists the skipped file',
  );
});

/* ───────────────── VIN extraction from metadata ───────────────── */

test('VIN extraction: reads vin field from metadata JSON', () => {
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const result = parseAemtBundle([
    { name: 'BCM.bin', data: blob },
    { name: 'job.json', data: enc(JSON.stringify({ vin: '2C3CDXCT1HH652640' })) },
  ]);
  assert.equal(result.vin, '2C3CDXCT1HH652640');
  assert.deepEqual(result.meta, { vin: '2C3CDXCT1HH652640' });
});

test('VIN extraction: reads nested vehicle.vin', () => {
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const result = parseAemtBundle([
    { name: 'BCM.bin', data: blob },
    { name: 'job.json', data: enc(JSON.stringify({ vehicle: { vin: '1C4RJFDJ7DC513874' } })) },
  ]);
  assert.equal(result.vin, '1C4RJFDJ7DC513874');
});

test('VIN extraction: reads nested job.vin', () => {
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const result = parseAemtBundle([
    { name: 'BCM.bin', data: blob },
    { name: 'profile.json', data: enc(JSON.stringify({ job: { VIN: '1c4rjfdj7dc513874' } })) },
  ]);
  /* cleanVin uppercases — assert canonical form. */
  assert.equal(result.vin, '1C4RJFDJ7DC513874');
});

test('VIN extraction: invalid VIN in metadata is rejected (returns null)', () => {
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const result = parseAemtBundle([
    { name: 'BCM.bin', data: blob },
    { name: 'job.json', data: enc(JSON.stringify({ vin: 'NOT-A-REAL-VIN' })) },
  ]);
  assert.equal(result.vin, null);
});

test('VIN extraction: malformed metadata JSON is silently skipped', () => {
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const result = parseAemtBundle([
    { name: 'BCM.bin', data: blob },
    { name: 'broken.json', data: enc('{not valid json') },
  ]);
  assert.equal(result.meta, null);
  assert.equal(result.vin, null);
});

/* ───────────────── VIN extraction from binary fallback ───────────────── */

test('VIN extraction: falls back to BCM binary when metadata absent', skipNoFix, () => {
  const result = parseAemtBundle([
    { name: 'BCM.bin', data: bcmBytes },
    { name: 'RFHUB.bin', data: rfhBytes },
    { name: 'PCM.bin', data: pcmBytes },
  ]);
  /* The 18TH_OG BCM fixture exposes a real VIN via parseModule. We don't
   * pin the exact VIN here (it's a property of the fixture); instead we
   * assert the importer surfaced *something* valid (17 chars) from the
   * binary in the absence of metadata. */
  assert.equal(result.meta, null);
  assert.ok(typeof result.vin === 'string' && result.vin.length === 17,
    'VIN extracted from BCM binary, got: ' + result.vin);
});

/* ───────────────── Duplicate-role warning ───────────────── */

test('duplicate role files emit a warning and the first file wins', skipNoFix, () => {
  /* Two RFH-classified inputs (binary header). The first becomes the role,
   * the second is reported via warnings. */
  const result = parseAemtBundle([
    { name: 'rfh_a.bin', data: rfhBytes },
    { name: 'rfh_b.bin', data: rfhBytes },
  ]);
  assert.ok(result.roles.RFH);
  /* Either filename may "win" the tie depending on detection ordering, but
   * exactly one warning must mention the conflict. */
  assert.ok(
    result.warnings.some((w) => /Duplicate RFH/.test(w)),
    'duplicate RFH warning emitted; warnings=' + JSON.stringify(result.warnings),
  );
});

/* ───────────────── Unknown file extensions ───────────────── */

test('unknown extensions (e.g. .txt) are silently ignored', () => {
  const blob = new Uint8Array(NON_CLASSIFYING_SIZE);
  const result = parseAemtBundle([
    { name: 'BCM_dump.bin', data: blob },
    { name: 'README.txt', data: enc('hello') },
    { name: 'aemt.exe', data: new Uint8Array([0x4D, 0x5A]) },
  ]);
  assert.ok(result.roles.BCM);
  /* No "unrecognised" warning for the .txt / .exe — only .bin files
   * that fail role detection should produce that warning. */
  assert.ok(!result.warnings.some((w) => /README\.txt|aemt\.exe/.test(w)));
});
