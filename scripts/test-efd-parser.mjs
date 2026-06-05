/**
 * test-efd-parser.mjs
 *
 * Synthetic EFD fixture test — builds a minimal but structurally correct
 * Mopar PowerCal EBML container in memory and runs every extraction path
 * in efdParser.js through it.
 *
 * Key insight: the EBML magic (0x1A45DFA3) is the EBML HEADER element ID.
 * It must be followed by a VINT size field. In real EFD files the header
 * has a small body; we use size=0 (VINT byte 0x80) so the walker advances
 * past it immediately and then finds the DS/FS/CO/UP sections as siblings.
 */

import { createHash } from 'crypto';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

function writeVintId(id) {
  const bytes = [];
  const len = id <= 0xFF ? 1 : id <= 0xFFFF ? 2 : id <= 0xFFFFFF ? 3 : 4;
  for (let i = len - 1; i >= 0; i--) bytes.push((id >> (i * 8)) & 0xFF);
  return new Uint8Array(bytes);
}

function writeVintSize(size) {
  if (size < 0x7F) return new Uint8Array([0x80 | size]);
  if (size < 0x3FFF) return new Uint8Array([0x40 | (size >> 8), size & 0xFF]);
  return new Uint8Array([0x20 | (size >> 16), (size >> 8) & 0xFF, size & 0xFF]);
}

function makeSection(idHex, payload) {
  const id = parseInt(idHex, 16);
  return concat(writeVintId(id), writeVintSize(payload.length), payload);
}

// ─── Build the fixture ────────────────────────────────────────────────────────

// EBML header element: ID=0x1A45DFA3, size=0 (empty body)
const ebmlHeader = concat(
  new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]),
  new Uint8Array([0x80]) // VINT size = 0
);

// DS section — plaintext Key=Value metadata
const dsText = [
  'Engine = 6.2L SUPERCHARGED HEMI SRT',
  'Program = SRT_HELLCAT_2018',
  'Version = 1.04.0002',
  'Part Number = 68XXXXXX-AB',
  'ModelYear = 2018',
  'Body = LD_CHARGER',
  '',
].join('\r\n');
const dsSection = makeSection('204453', new TextEncoder().encode(dsText));

// FS section — fake encrypted blob (16 bytes)
const fsSection = makeSection('204653', new Uint8Array(16).fill(0xAA));

// CO section — checksum (4 bytes)
const coSection = makeSection('20434F', new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));

// UP section — 512 bytes of pseudo-random payload
const upPayload = new Uint8Array(512);
for (let i = 0; i < 512; i++) upPayload[i] = (i * 37 + 13) & 0xFF;
const upSection = makeSection('205550', upPayload);

// Full fixture
const efdBuffer = concat(ebmlHeader, dsSection, fsSection, coSection, upSection);

// ─── Load the real parser ─────────────────────────────────────────────────────
const parserPath = new URL('../client/src/srtlab/lib/efdParser.js', import.meta.url);
const { parseEFD, extractEfdPayload, shannonEntropy, isEbmlBuffer } = await import(parserPath);

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail !== undefined ? ' — ' + String(detail) : ''}`);
    failed++;
  }
}

console.log('\n══════════════════════════════════════════════════════');
console.log('  EFD Parser — Synthetic Fixture Test');
console.log('══════════════════════════════════════════════════════\n');

// ── 1. EBML magic detection ───────────────────────────────────────────────────
console.log('1. EBML magic detection');
const parsed = parseEFD(efdBuffer, 'test.efd');
assert('valid=true for correct magic', parsed.valid === true);
assert('error=null for correct magic', parsed.error === null);

const badBuf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
const badParsed = parseEFD(badBuf, 'bad.efd');
assert('valid=false for wrong magic', badParsed.valid === false);
assert('error message set for wrong magic',
  typeof badParsed.error === 'string' && badParsed.error.includes('EBML'));

// ── 2. Section map completeness ───────────────────────────────────────────────
console.log('\n2. Section map completeness');
const sectionIds = parsed.sections.map(s => s.id);
console.log('   Found section IDs:', sectionIds);
// EBML header element (1A45DFA3) + DS + FS + CO + UP = 5 sections
assert('EBML header section found (1A45DFA3)',
  sectionIds.includes('1A45DFA3'), JSON.stringify(sectionIds));
assert('DS section found (204453)',
  sectionIds.includes('204453'), JSON.stringify(sectionIds));
assert('FS section found (204653)',
  sectionIds.includes('204653'), JSON.stringify(sectionIds));
assert('CO section found (20434F)',
  sectionIds.includes('20434F'), JSON.stringify(sectionIds));
assert('UP section found (205550)',
  sectionIds.includes('205550'), JSON.stringify(sectionIds));
assert('Total 5 sections', parsed.sections.length === 5, String(parsed.sections.length));

// ── 3. Section labels and kinds ───────────────────────────────────────────────
console.log('\n3. Section labels and kinds');
const dsEl  = parsed.sections.find(s => s.id === '204453');
const upEl  = parsed.sections.find(s => s.id === '205550');
const fsEl  = parsed.sections.find(s => s.id === '204653');
const coEl  = parsed.sections.find(s => s.id === '20434F');

assert('DS label = "DS"',   dsEl?.label === 'DS',   dsEl?.label);
assert('DS kind = "plaintext-metadata"', dsEl?.kind === 'plaintext-metadata', dsEl?.kind);
assert('UP label = "UP"',   upEl?.label === 'UP',   upEl?.label);
assert('UP kind = "payload"', upEl?.kind === 'payload', upEl?.kind);
assert('FS label = "FS"',   fsEl?.label === 'FS',   fsEl?.label);
assert('FS kind = "encrypted"', fsEl?.kind === 'encrypted', fsEl?.kind);
assert('CO label = "CO"',   coEl?.label === 'CO',   coEl?.label);
assert('CO kind = "checksum"', coEl?.kind === 'checksum', coEl?.kind);

// ── 4. Metadata extraction ────────────────────────────────────────────────────
console.log('\n4. DS metadata extraction (Key = Value parsing)');
const meta = parsed.metadata;
assert('Engine extracted',      meta.Engine === '6.2L SUPERCHARGED HEMI SRT', meta.Engine);
assert('Program extracted',     meta.Program === 'SRT_HELLCAT_2018', meta.Program);
assert('Version extracted',     meta.Version === '1.04.0002', meta.Version);
assert('Part Number extracted', meta['Part Number'] === '68XXXXXX-AB', meta['Part Number']);
assert('ModelYear extracted',   meta.ModelYear === '2018', meta.ModelYear);
assert('Body extracted',        meta.Body === 'LD_CHARGER', meta.Body);
assert('efdType = mopar_powercal', parsed.efdType === 'mopar_powercal', parsed.efdType);
assert('No extra junk keys', Object.keys(meta).length === 6, String(Object.keys(meta)));

// ── 5. Payload object ─────────────────────────────────────────────────────────
console.log('\n5. Payload (UP section) object');
assert('payload object present',       parsed.payload !== null);
assert('payload.size = 512',           parsed.payload?.size === 512, String(parsed.payload?.size));
assert('payload.declaredSize = 512',   parsed.payload?.declaredSize === 512, String(parsed.payload?.declaredSize));
assert('payload.offset > 0',           (parsed.payload?.offset ?? 0) > 0, String(parsed.payload?.offset));
assert('payload.entropy is a number',  typeof parsed.payload?.entropy === 'number');
assert('payload.entropy > 0',          (parsed.payload?.entropy ?? 0) > 0, String(parsed.payload?.entropy));

// ── 6. extractEfdPayload ──────────────────────────────────────────────────────
console.log('\n6. extractEfdPayload()');
const extracted = extractEfdPayload(efdBuffer, 'test.efd');
assert('ok=true',                extracted.ok === true, extracted.error);
assert('bytes.length = 512',     extracted.bytes?.length === 512, String(extracted.bytes?.length));
assert('declaredSize = 512',     extracted.declaredSize === 512, String(extracted.declaredSize));
assert('size = 512',             extracted.size === 512, String(extracted.size));
assert('declaredSize === size (no truncation)', extracted.declaredSize === extracted.size);

// Byte-level correctness
let byteMatch = true;
if (extracted.bytes) {
  for (let i = 0; i < 512; i++) {
    if (extracted.bytes[i] !== upPayload[i]) { byteMatch = false; break; }
  }
}
assert('extracted bytes match original upPayload byte-for-byte', byteMatch);

// SHA-256 cross-check
const sha = createHash('sha256').update(extracted.bytes).digest('hex');
const expectedSha = createHash('sha256').update(upPayload).digest('hex');
assert('SHA-256 of extracted bytes matches upPayload',
  sha === expectedSha, `got ${sha.slice(0,16)}… expected ${expectedSha.slice(0,16)}…`);

// ── 7. Truncation detection ───────────────────────────────────────────────────
console.log('\n7. Truncation detection');
const truncated = efdBuffer.subarray(0, efdBuffer.length - 100);
const truncResult = extractEfdPayload(truncated, 'truncated.efd');
assert('ok=true even when truncated (extracts what exists)', truncResult.ok === true);
assert('size < declaredSize when truncated',
  (truncResult.size ?? 0) < (truncResult.declaredSize ?? 0),
  `size=${truncResult.size} declaredSize=${truncResult.declaredSize}`);
assert('truncated size = 412 (512 - 100)', truncResult.size === 412, String(truncResult.size));
assert('declaredSize still = 512', truncResult.declaredSize === 512, String(truncResult.declaredSize));

// ── 8. Shannon entropy ────────────────────────────────────────────────────────
console.log('\n8. shannonEntropy()');
assert('entropy of all-zeros = 0',
  shannonEntropy(new Uint8Array(1024).fill(0)) === 0);

const uniform = new Uint8Array(1024);
for (let i = 0; i < 1024; i++) uniform[i] = i & 0xFF;
const he = shannonEntropy(uniform);
assert('entropy of uniform 0-255 pattern > 7.9', he > 7.9, `got ${he.toFixed(3)}`);

assert('single-byte buffer entropy = 0',
  shannonEntropy(new Uint8Array([0xAB])) === 0);

// ── 9. isEbmlBuffer helper ────────────────────────────────────────────────────
console.log('\n9. isEbmlBuffer()');
assert('isEbmlBuffer(efdBuffer) = true',  isEbmlBuffer(efdBuffer) === true);
assert('isEbmlBuffer(badBuf) = false',    isEbmlBuffer(badBuf) === false);
assert('isEbmlBuffer(null) = false',      isEbmlBuffer(null) === false);
assert('isEbmlBuffer(short) = false',
  isEbmlBuffer(new Uint8Array([0x1A, 0x45])) === false);
assert('isEbmlBuffer(ArrayBuffer) = true',
  isEbmlBuffer(efdBuffer.buffer) === true);

// ── 10. Non-EFD rejection ─────────────────────────────────────────────────────
console.log('\n10. Non-EFD file rejection');
const notEfd = extractEfdPayload(new Uint8Array([0xFF, 0xFE, 0x00, 0x01, 0x02]), 'random.bin');
assert('ok=false for non-EFD',          notEfd.ok === false);
assert('error string present',
  typeof notEfd.error === 'string' && notEfd.error.length > 0, notEfd.error);

// ── 11. Edge cases ────────────────────────────────────────────────────────────
console.log('\n11. Edge cases');
assert('ok=false for empty buffer',
  extractEfdPayload(new Uint8Array(0), 'empty.efd').ok === false);

// Magic-only (no size byte) — parser sees valid magic but can't find UP
const magicOnly = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]);
const magicOnlyResult = extractEfdPayload(magicOnly, 'magic-only.efd');
assert('parsed.valid=true for magic-only', magicOnlyResult.parsed?.valid === true);
assert('ok=false for magic-only (no UP section)', magicOnlyResult.ok === false);

// Magic + empty header but no UP section
const noUp = concat(ebmlHeader, dsSection);
const noUpResult = extractEfdPayload(noUp, 'no-up.efd');
assert('ok=false when no UP section', noUpResult.ok === false);
assert('parsed.valid=true even without UP', noUpResult.parsed?.valid === true);
assert('metadata still extracted without UP', noUpResult.parsed?.metadata?.Engine === '6.2L SUPERCHARGED HEMI SRT');

// ── 12. Section offset ordering ───────────────────────────────────────────────
console.log('\n12. Section offset ordering');
const offsets = parsed.sections.map(s => s.offset);
const isMonotonic = offsets.every((o, i) => i === 0 || o > offsets[i - 1]);
assert('section offsets are strictly increasing', isMonotonic, JSON.stringify(offsets));

// Each section's dataStart is within the buffer
const allInBounds = parsed.sections.every(s => s.dataStart <= efdBuffer.length);
assert('all section dataStart values are within buffer', allInBounds);

// ── 13. dataStart field ───────────────────────────────────────────────────────
console.log('\n13. dataStart field');
assert('upEl.dataStart is defined', typeof upEl?.dataStart === 'number');
assert('upEl.dataStart = payload.offset',
  upEl?.dataStart === parsed.payload?.offset,
  `dataStart=${upEl?.dataStart} offset=${parsed.payload?.offset}`);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
