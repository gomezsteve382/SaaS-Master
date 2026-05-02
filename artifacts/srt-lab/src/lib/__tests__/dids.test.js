import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDidDescription,
  getDidDescriptions,
  loadDidDescriptions,
  getDidDescriptionCount,
  _resetDidDescriptionsForTests,
} from '../dids.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(__dirname, '..', '..', '..', 'public', 'unlock_catalog_extended.json');
const CATALOG_TEXT = readFileSync(CATALOG_PATH, 'utf8');

beforeEach(() => {
  _resetDidDescriptionsForTests();
  // Stub fetch with the on-disk extended catalog so the lookup loads
  // the same data the artifact ships in /public.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => JSON.parse(CATALOG_TEXT),
  });
});

describe('dids dictionary', () => {
  it('falls back to curated CRITICAL_DIDS before load completes', () => {
    expect(getDidDescription(0xF190)).toBe('VIN');
  });

  it('looks up labels from the asset-sweep extended catalog', async () => {
    const count = await loadDidDescriptions();
    expect(count).toBeGreaterThan(100);
    expect(getDidDescription(0x04C8)).toBe('Left/Right Hand Drive');
    expect(getDidDescription('0x04CA')).toBe('Shifter Type');
    expect(getDidDescription('04CC')).toBe('Headrest Present');
  });

  it('exposes every distinct description seen for a DID', async () => {
    await loadDidDescriptions();
    const variants = getDidDescriptions(0x04CC);
    expect(variants).toContain('Headrest Present');
    expect(variants).toContain('PTS Configuration');
    expect(variants).toContain('Rear View Camera');
  });

  it('returns "" for unknown DIDs and reports the loaded size', async () => {
    await loadDidDescriptions();
    expect(getDidDescription(0xDEAD)).toBe('');
    expect(getDidDescriptionCount()).toBe(getDidDescriptionCount());
    expect(getDidDescriptionCount()).toBeGreaterThan(0);
  });

  it('is idempotent across concurrent load calls', async () => {
    const [a, b] = await Promise.all([loadDidDescriptions(), loadDidDescriptions()]);
    expect(a).toBe(b);
  });
});
