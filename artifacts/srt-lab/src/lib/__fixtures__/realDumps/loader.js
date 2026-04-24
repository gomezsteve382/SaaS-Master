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
 * is missing or unreadable. Each pair carries its own effective `rfhSec16`
 * — either the per-pair `rfhSec16Hex` override from the manifest entry or,
 * if absent, the top-level default (`fallbackSec16`). */
function loadPair(entry, fallbackSec16) {
  if (!entry || typeof entry !== 'object') return null;
  const { before, after } = entry;
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  const beforePath = join(HERE, before);
  const afterPath  = join(HERE, after);
  if (!existsSync(beforePath) || !existsSync(afterPath)) return null;
  const perPairSec16 = hexToBytes(entry.rfhSec16Hex);
  const rfhSec16 = (perPairSec16 && perPairSec16.length === 16) ? perPairSec16 : fallbackSec16;
  if (!rfhSec16 || rfhSec16.length !== 16) return null;
  try {
    return {
      before: new Uint8Array(readFileSync(beforePath)),
      after:  new Uint8Array(readFileSync(afterPath)),
      beforePath,
      afterPath,
      rfhSec16,
      source: typeof entry.source === 'string' ? entry.source : undefined,
      // Optional anonymization metadata used by the
      // `realDumps.anonymization.test.js` sanity scan:
      //   anonVin  — the 17-char anonymized VIN that should appear at
      //              every documented VIN slot in this binary.
      //   donorVin — the 17-char original donor VIN that must NOT
      //              appear anywhere in this (or any other) binary.
      // Either may be omitted when not known; the test handles the
      // omission gracefully (still enforces consistency + the
      // global hardcoded forbidden-donor list).
      anonVin:  typeof entry.anonVin  === 'string' && entry.anonVin.length  === 17 ? entry.anonVin  : null,
      donorVin: typeof entry.donorVin === 'string' && entry.donorVin.length === 17 ? entry.donorVin : null,
    };
  } catch {
    return null;
  }
}

/* Public entry point. Returns:
 *   {
 *     rfhSec16: Uint8Array(16),    // top-level default
 *     source: string | undefined,
 *     bcm:   PairEntry | null,
 *     rfhub: PairEntry | null,
 *     pcm:   PairEntry | null,
 *     extraBcms: Array<PairEntry>,
 *     extraPcms: Array<PairEntry>,
 *   }
 *
 * where PairEntry =
 *   { before: Uint8Array,
 *     after:  Uint8Array,
 *     beforePath: string,
 *     afterPath:  string,
 *     rfhSec16: Uint8Array(16),
 *     source: string | undefined,
 *     anonVin:  string|null,   // 17-char anonymized VIN, optional
 *     donorVin: string|null }  // 17-char original donor VIN, optional
 * or null if the manifest itself is missing / malformed / lacks a usable
 * 16-byte top-level RFH SEC16. Per-pair entries may carry their own
 * `rfhSec16Hex` override (e.g. when the rfhub/pcm/extraBcm/extraPcm pair
 * was captured from a different vehicle than the primary BCM pair). */
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
  const extraBcmRaw = Array.isArray(manifest.extraBcms) ? manifest.extraBcms : [];
  const extraBcms = extraBcmRaw.map(e => loadPair(e, rfhSec16)).filter(Boolean);
  const extraPcmRaw = Array.isArray(manifest.extraPcms) ? manifest.extraPcms : [];
  const extraPcms = extraPcmRaw.map(e => loadPair(e, rfhSec16)).filter(Boolean);
  return {
    rfhSec16,
    source: typeof manifest.source === 'string' ? manifest.source : undefined,
    bcm:   loadPair(manifest.bcm,   rfhSec16),
    rfhub: loadPair(manifest.rfhub, rfhSec16),
    pcm:   loadPair(manifest.pcm,   rfhSec16),
    extraBcms,
    extraPcms,
  };
}
