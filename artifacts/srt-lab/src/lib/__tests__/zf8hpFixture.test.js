/* Task #634 — committed ZF-8HP 845RE fixture round-trip.
 * Locks the fixture bytes against the production parser so changes to
 * zf8hp.js layout / CRC logic that would invalidate real bench dumps
 * fail loudly here. Regenerate with src/lib/__fixtures__/buildZf8hpFixture.mjs.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseZf8hpImage, patchZf8hpVin } from '../zf8hp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', '__fixtures__', 'zf8hp_845re.bin');

describe('ZF-8HP 845RE fixture (Task #634)', () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));

  it('is the canonical 845RE size', () => {
    expect(bytes.length).toBe(0x80000);
  });

  it('parses as 845RE with writeSafe:true and a clean VIN', () => {
    const r = parseZf8hpImage(bytes);
    expect(r.ok).toBe(true);
    expect(r.variant).toBe('845RE');
    expect(r.vin).toBe('2C3CDXL90MH582899');
    expect(r.vinAllSlotsMatch).toBe(true);
    expect(r.blocksOk).toBe(true);
    expect(r.writeSafe).toBe(true);
  });

  it('every per-block CRC32 verifies', () => {
    const r = parseZf8hpImage(bytes);
    expect(r.blocks.length).toBe(8);
    for (const b of r.blocks) expect(b.ok).toBe(true);
  });

  it('round-trips a new VIN through patchZf8hpVin', () => {
    const NEW = '2C3CDXL90MH000001';
    const r = patchZf8hpVin(bytes, NEW);
    expect(r.ok).toBe(true);
    const re = parseZf8hpImage(r.bytes);
    expect(re.vin).toBe(NEW);
    expect(re.blocksOk).toBe(true);
    expect(re.writeSafe).toBe(true);
  });
});
