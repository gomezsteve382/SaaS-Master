#!/usr/bin/env node
/**
 * buildZf8hpFixture.mjs (Task #634)
 *
 * Generates a deterministic synthetic ZF-8HP 845RE (512 KB) fixture image:
 *   - "ZF8HP" header @ 0x0000, variant tag 0x45 @ 0x0008
 *   - VIN 2C3CDXL90MH582899 written at both 845RE VIN slots
 *   - Per-block CRC32 (zlib) stamped at the trailing 4 B of every 64 KB block
 *
 * Re-run if zf8hp.js layout constants change, then commit the regenerated
 * bin. Output: src/lib/__fixtures__/zf8hp_845re.bin
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ZF8HP_SIG_HEAD, ZF8HP_SIG_OFFSET, ZF8HP_VARIANT_OFFSET,
  patchZf8hpVin, parseZf8hpImage,
} from '../zf8hp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIZE = 0x80000; // 512 KB — 845RE canonical
const VIN  = '2C3CDXL90MH582899';

const buf = new Uint8Array(SIZE);
for (let i = 0; i < ZF8HP_SIG_HEAD.length; i++) buf[ZF8HP_SIG_OFFSET + i] = ZF8HP_SIG_HEAD[i];
buf[ZF8HP_VARIANT_OFFSET] = 0x45;

// Stamp every VIN slot + per-block CRC via the production patcher so the
// fixture round-trips through parseZf8hpImage with `writeSafe:true`.
const r = patchZf8hpVin(buf, VIN);
if (!r.ok) { console.error('patchZf8hpVin failed:', r.reason); process.exit(1); }

const parsed = parseZf8hpImage(r.bytes);
if (!parsed.ok || !parsed.writeSafe) {
  console.error('Round-trip failed:', parsed);
  process.exit(1);
}

const out = resolve(__dirname, 'zf8hp_845re.bin');
writeFileSync(out, Buffer.from(r.bytes));
console.log(`wrote ${out} (${r.bytes.length} B, VIN ${parsed.vin}, blocks ${parsed.blocks.length})`);
