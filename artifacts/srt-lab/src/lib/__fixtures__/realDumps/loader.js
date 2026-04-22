/* ============================================================================
 * loader.js — real-dump fixture loader for the security-byte writer tests.
 *
 * Reads ./manifest.json and returns a structured fixture object, or null if
 * the manifest is missing / malformed / references files that are not on
 * disk. Returning null (rather than throwing) lets the test file describe.skip
 * the corresponding suite so the build does not break before dumps are
 * committed.
 *
 * This module deliberately uses Node's fs synchronously — it only runs in
 * the vitest test process, never in the browser bundle.
 * ============================================================================ */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'manifest.json');

/* Parse a hex string like "0123abcd" into a Uint8Array. Returns null on any
 * malformed input so the caller can skip rather than throw. */
function hexToBytes(hex) {
  if (typeof hex !== 'string') return null;
  const clean = hex.replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/* Resolve and read a single before/after pair. Returns null if either file
 * is missing or unreadable. */
function loadPair(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const { before, after } = entry;
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  const beforePath = join(HERE, before);
  const afterPath  = join(HERE, after);
  if (!existsSync(beforePath) || !existsSync(afterPath)) return null;
  try {
    return {
      before: new Uint8Array(readFileSync(beforePath)),
      after:  new Uint8Array(readFileSync(afterPath)),
      beforePath,
      afterPath,
    };
  } catch {
    return null;
  }
}

/* Public entry point. Returns:
 *   {
 *     rfhSec16: Uint8Array(16),
 *     source: string | undefined,
 *     bcm:   { before, after, beforePath, afterPath } | null,
 *     rfhub: { before, after, beforePath, afterPath } | null,
 *     pcm:   { before, after, beforePath, afterPath } | null,
 *   }
 * or null if the manifest itself is missing / malformed / lacks a usable
 * 16-byte RFH SEC16. */
export function loadRealDumpFixtures() {
  if (!existsSync(MANIFEST_PATH)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object') return null;
  const rfhSec16 = hexToBytes(manifest.rfhSec16Hex);
  if (!rfhSec16 || rfhSec16.length !== 16) return null;
  return {
    rfhSec16,
    source: typeof manifest.source === 'string' ? manifest.source : undefined,
    bcm:   loadPair(manifest.bcm),
    rfhub: loadPair(manifest.rfhub),
    pcm:   loadPair(manifest.pcm),
  };
}
