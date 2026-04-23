#!/usr/bin/env node
/* Task #420 — generate additional donor-style Gen1 (24C16) RFHUB fixtures.
 *
 * The seed fixtures shipped with task #416
 * (`cherokee_xk_2010_2fobs.bin`, `wk_grand_2008_4fobs.bin`,
 * `lx_charger_2016_1fob.bin`) cover the happy paths: contiguous occupancy
 * (1, 2, or 4 leading slots) and a default SEC16 secret. Real locksmith
 * donors carry far more variation — partially-deprogrammed slot patterns
 * (e.g. slot 2 deleted but slots 0, 1, 3 still flagged AA-50), distinct
 * SEC16 secrets per VIN, distinct per-fob Autel transponder IDs, and
 * scratch noise that varies seed-by-seed.
 *
 * Until physical 24C16 captures land, this script extends the variant
 * matrix the golden test iterates over. The new fixtures are still
 * hand-built to the published layout (so they cannot by themselves
 * detect per-vehicle layout drift — see __golden__/README.md), but
 * they exercise the harness against:
 *   - sparse / non-contiguous AA-50 occupancy
 *   - per-VIN SEC16 secrets (each donor a different 16 B block)
 *   - per-fob Autel ID block uniqueness (no two slots share an ID)
 *   - independent Mulberry32 scratch noise seeds per donor
 *
 * Run: node artifacts/srt-lab/scripts/generate-rfhub-gen1-donor-fixtures.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rfhSec16Cs, crc16 } from '../src/lib/crc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'src', 'lib', '__tests__', '__golden__');

// Same Mulberry32 the seed fixtures use, so scratch regions look like a
// real EEPROM (random-ish, not 0xFF). The seed differs per donor so two
// fixtures cannot accidentally share a noise pattern.
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) & 0xFF;
  };
}

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function fill(buf, off, bytes) {
  for (let i = 0; i < bytes.length; i++) buf[off + i] = bytes[i];
}
function writeBE16(buf, off, val) {
  buf[off] = (val >>> 8) & 0xff;
  buf[off + 1] = val & 0xff;
}

/* Build one Gen1 (2048 B) RFHUB image.
 *
 *   vin            17-char donor VIN (sanitized — FreshAuto-style placeholder)
 *   noiseSeed      Mulberry32 seed for the scratch-region fill
 *   sec16          16 B master transponder secret (mirrored at 0x00AE/0x00C0)
 *   occupancy      [bool, bool, bool, bool] — which AA-50 slots are flagged
 *   fobIds         [Uint8Array(8)|null, ...] — per-slot Autel ID blocks
 */
function buildGen1Donor({ vin, noiseSeed, sec16, occupancy, fobIds }) {
  const sz = 2048;
  const buf = new Uint8Array(sz);
  // Step 1: fill the whole image with deterministic noise. This is what
  // makes the round-trip byte-identity assertion meaningful — a writer
  // that strays into a scratch byte fails immediately.
  const rng = mulberry32(noiseSeed);
  for (let i = 0; i < sz; i++) buf[i] = rng();

  // Step 2: stamp structured regions on top of the noise.
  // SEC16 mirror pair @ 0x00AE / 0x00C0 with the (crc8_65 << 8) | 0x00 CS.
  const cs = rfhSec16Cs(sec16);
  for (const off of [0x00AE, 0x00C0]) {
    fill(buf, off, sec16);
    buf[off + 16] = (cs >>> 8) & 0xFF;
    buf[off + 17] = cs & 0xFF;
  }
  // AA-50 markers @ 0x00D2 stride 2. Empty slots get FF FF (not noise) —
  // a real EEPROM erases marker bytes to FF when a fob is deprogrammed.
  for (let i = 0; i < 4; i++) {
    const off = 0x00D2 + i * 2;
    if (occupancy[i]) { buf[off] = 0xAA; buf[off + 1] = 0x50; }
    else              { buf[off] = 0xFF; buf[off + 1] = 0xFF; }
  }
  // Per-fob Autel ID block @ 0x00DA stride 8. Empty slots get FF×8 — the
  // module zeroes the ID region when a fob is removed, so the noise
  // pattern only persists in truly untouched scratch regions.
  for (let i = 0; i < 4; i++) {
    const off = 0x00DA + i * 8;
    if (fobIds[i]) {
      fill(buf, off, fobIds[i]);
    } else {
      for (let k = 0; k < 8; k++) buf[off + k] = 0xFF;
    }
  }
  // VIN @ 0x92 + CRC16 BE at +0xA3. The 24C16 has no Gen2-style 0xEA5+
  // VIN slot table, so 0x92 is the only VIN copy.
  const vinAscii = asciiBytes(vin);
  fill(buf, 0x92, vinAscii);
  writeBE16(buf, 0x92 + 17, crc16(vinAscii));
  return buf;
}

// Per-donor inputs. VINs are FreshAuto-style placeholders (no real
// customer data); they pass the standard 17-char VIN regex
// /^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/ used elsewhere in the codebase.
const DONORS = [
  {
    file: 'cherokee_xk_2009_partial.bin',
    vin: '1J8HG58N79C500001',
    noiseSeed: 0x10001001,
    // Distinct SEC16 secret (donor #1)
    sec16: Uint8Array.from([
      0x4A, 0x21, 0x9F, 0x06, 0xB3, 0x55, 0x12, 0xC8,
      0xD0, 0x7E, 0x3F, 0x88, 0x14, 0xAB, 0x90, 0x6E,
    ]),
    // Sparse occupancy: slot 2 was deleted by a previous locksmith,
    // slots 0/1/3 still flagged. This pattern only happens on a real
    // partially-deprogrammed donor — the seed fixtures don't cover it.
    occupancy: [true, true, false, true],
    fobIds: [
      Uint8Array.from([0x57, 0xC2, 0x91, 0x4E, 0x18, 0xA0, 0x6B, 0xFD]),
      Uint8Array.from([0x12, 0x84, 0xDB, 0x37, 0x9A, 0x46, 0x2C, 0xE9]),
      null,
      Uint8Array.from([0xB3, 0x6F, 0x05, 0xC1, 0x88, 0x29, 0x74, 0xAE]),
    ],
  },
  {
    file: 'wk_grand_2011_3fobs.bin',
    vin: '1J4RR4GG3BC500002',
    noiseSeed: 0x20002002,
    sec16: Uint8Array.from([
      0xE7, 0x14, 0x66, 0xBD, 0x02, 0x99, 0xCC, 0x40,
      0x71, 0x8A, 0x55, 0x1D, 0xF3, 0x6E, 0x29, 0xB7,
    ]),
    // Three contiguous fobs paired, slot 3 still empty from the factory.
    occupancy: [true, true, true, false],
    fobIds: [
      Uint8Array.from([0xA1, 0x5C, 0x33, 0x7E, 0xBB, 0x08, 0xD4, 0x91]),
      Uint8Array.from([0x4F, 0xE2, 0x18, 0x67, 0xC0, 0x3B, 0x95, 0x22]),
      Uint8Array.from([0xD8, 0x76, 0x2A, 0x40, 0x09, 0xEE, 0x53, 0xBA]),
      null,
    ],
  },
  {
    file: 'lx_charger_2014_fullhouse.bin',
    vin: '2C3CDXCT5EH500003',
    noiseSeed: 0x30003003,
    sec16: Uint8Array.from([
      0x1B, 0xCF, 0x82, 0x47, 0x33, 0xA5, 0x70, 0x09,
      0x6E, 0xD1, 0x44, 0xFB, 0x27, 0x99, 0x5A, 0x8C,
    ]),
    // All four slots paired — common on a high-mileage daily-driver donor
    // where every fob the dealer ever issued is still flagged.
    occupancy: [true, true, true, true],
    fobIds: [
      Uint8Array.from([0x66, 0x11, 0xA8, 0x3C, 0xD7, 0x42, 0x9F, 0x05]),
      Uint8Array.from([0xCB, 0x37, 0x60, 0xE4, 0x19, 0x82, 0x55, 0xAE]),
      Uint8Array.from([0x08, 0x9D, 0x2F, 0x71, 0xB6, 0x4A, 0xE3, 0x50]),
      Uint8Array.from([0xF2, 0x48, 0x91, 0x05, 0x6C, 0xDA, 0x37, 0x84]),
    ],
  },
];

for (const d of DONORS) {
  const buf = buildGen1Donor(d);
  const path = join(OUT_DIR, d.file);
  writeFileSync(path, Buffer.from(buf));
  console.log(`wrote ${path} (${buf.length} B, occupancy=${JSON.stringify(d.occupancy)})`);
}
