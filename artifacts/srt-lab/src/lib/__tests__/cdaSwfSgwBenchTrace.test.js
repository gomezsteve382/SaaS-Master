import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { SGW_VIN_OFFSETS as SGW_VIN_OFFSETS_PARSE } from '../parseModule.js';
import { SGW_VIN_OFFSETS as SGW_VIN_OFFSETS_LEAK } from '../donorLeakScan.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #457 — automated bench trace on the cracked OEM Chrysler diagnostic
// SWF (`attached_assets/CDA_1776448059516.swf`). This is the same SWF that
// produced the SGW XTEA key, delta, and round count documented in
// `docs/SGW_XTEA_ALGORITHM.md` (AS3 constant pool offset 0x24664A) — i.e.
// the canonical reference for what the OEM tool is allowed to do with a
// factory-stock SGW on the bus.
//
// Pinned invariants (full prose lives in docs/SGW_VIN_STORAGE.md §0):
//
//   1. The SWF decompresses to the canonical inflated body length recorded
//      in the XTEA doc (8,716,982 bytes). Catches any swap/corruption of
//      the SWF before the rest of the trace runs.
//   2. The SGW authentication / status / timeout API surface IS present in
//      the inflated body (proves we're inspecting the SGW-aware OEM tool,
//      not some unrelated SWF that happened to land in attached_assets/).
//   3. The SGW VIN read/write API surface is ABSENT — across seventeen
//      naming-convention variants. The OEM tool exposes no API to write a
//      VIN to the SGW or read a VIN from it.
//   4. The standard VIN UDS DID identifier "F190" appears nowhere as an
//      ASCII string in the inflated body. (The raw F1 90 byte pair occurs
//      ~37 times scattered across 8.7 MB of AS3 — that's noise, not signal,
//      so this assertion pins the ASCII form, not the byte form.)
//   5. The runtime SGW_VIN_OFFSETS arrays in parseModule.js and
//      donorLeakScan.js are both empty — the design decision the bench
//      trace supports.
//
// Together (2)+(3)+(4) constitute the bench trace cited in the
// "no VIN slot — confirmed by bench trace on dump X" comments in
// parseModule.js, donorLeakScan.js, and scripts/anonymize-real-dump.mjs.
//
// SCOPE NOTE. This bench trace is the **supporting evidence control**
// for the SGW "no VIN slot" design decision — it is NOT a substitute
// for a real SGW EEPROM `before.bin` / `after.bin` fixture in the
// realDumps/ directory. Under the design decision (see
// docs/SGW_VIN_STORAGE.md and the SGW bullet in
// __fixtures__/realDumps/README.md) the real-fixture acceptance bullet
// from Task #457 is explicitly waived because no sanctioned OEM
// tooling reads the SGW EEPROM in the first place — and it's exactly
// THIS bench trace that proves that. If a genuine SGW dump ever
// becomes available, the maintainer's job is to add a real fixture
// pair, populate SGW_VIN_OFFSETS, graduate SGW into the per-fixture
// loop, and let this bench-trace test demote itself to a corroborating
// sanity check.
//
// If the SWF is missing from attached_assets/ (e.g. fresh checkout that
// doesn't carry it), the test SKIPS rather than fails — the bench trace is
// optional infrastructure, not a hard build dependency. The synthetic SGW
// invariants in anonymizeRealDump.test.js still pin the runtime contract
// even when this test skips.
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SWF_PATH = path.join(REPO_ROOT, 'attached_assets', 'CDA_1776448059516.swf');

const CANONICAL_INFLATED_LENGTH = 8716982; // per docs/SGW_XTEA_ALGORITHM.md

const swfExists = fs.existsSync(SWF_PATH);
const describeIfSwf = swfExists ? describe : describe.skip;

function countSubstring(haystack, needle, { caseInsensitive = false } = {}) {
  let h = haystack;
  let n = needle;
  if (caseInsensitive) {
    h = h.toLowerCase();
    n = n.toLowerCase();
  }
  let count = 0;
  let from = 0;
  while (true) {
    const idx = h.indexOf(n, from);
    if (idx < 0) break;
    count += 1;
    from = idx + 1;
  }
  return count;
}

describeIfSwf('CDA SWF — SGW VIN-storage bench trace (Task #457)', () => {
  // Decompress once and reuse across the it() blocks. Vitest evaluates the
  // describe body up front so this runs at file load.
  const raw = fs.readFileSync(SWF_PATH);
  const sig = raw.slice(0, 3).toString('ascii');
  const ver = raw[3];
  let body;
  if (sig === 'CWS') {
    body = zlib.inflateSync(raw.slice(8));
  } else if (sig === 'FWS') {
    body = raw.slice(8);
  } else {
    body = null; // will fail invariant 1
  }
  // latin1 preserves every byte 1:1 so substring counts on the binary are safe.
  const ascii = body ? body.toString('latin1') : '';

  it('1. inflates cleanly to the canonical 8,716,982-byte AS3 body', () => {
    expect(sig, 'expected CWS-compressed SWF v11').toBe('CWS');
    expect(ver, 'expected SWF version 11').toBe(11);
    expect(body, 'expected inflate to succeed').not.toBeNull();
    expect(body.length).toBe(CANONICAL_INFLATED_LENGTH);
  });

  it('2. carries the SGW authentication / status / timeout API surface', () => {
    // Floor counts come from a one-time enumeration; assertions use >= so
    // future minor SWF revisions (additional callers) don't false-positive.
    const presentApis = [
      ['unlockSecurityGateway', 1],
      ['dongleUnlockSecurityGateway', 3],
      ['flashUnlockSecurityGateway', 1],
      ['SecurityGatewayCommand', 6],
      ['SecurityGatewayMessage', 1],
      ['DongleSecurityGatewayMessage', 1],
      ['FlashSecurityGatewayMessage', 1],
      ['SGWStatusIndicator', 48],
      ['SGWStatusModel', 4],
      ['isSGWReady', 2],
      ['hasSgw', 2],
      ['sgwUnlockedBy', 2],
      ['SecurityGatewayFault', 1],
      ['SecurityGatewayFeedbackMessage', 1],
      ['sgwTimeoutHTTPActionContext', 1],
      ['SGWJsonHTTPAction', 1],
    ];
    for (const [needle, floor] of presentApis) {
      const count = countSubstring(ascii, needle);
      expect(count, `expected SGW auth/status API "${needle}" to appear ≥ ${floor} times`).toBeGreaterThanOrEqual(floor);
    }
  });

  it('3. has ZERO SGW VIN read/write API symbols across every naming variant', () => {
    // The full needle list. If a future SGW revision starts persisting VINs
    // and OEM tooling exposes a read/write API for it, AT LEAST ONE of
    // these would land in the SWF — at which point this test fails loudly,
    // the maintainer reclassifies SGW from "design decision" to
    // "documented slot table", populates SGW_VIN_OFFSETS with the real
    // offsets, and updates docs/SGW_VIN_STORAGE.md accordingly.
    const absentApis = [
      'WriteVinToSGW',
      'WriteSGWVin',
      'SGWWriteVin',
      'ReadVinFromSGW',
      'ReadSGWVin',
      'SGWReadVin',
      'SGWVinSlot',
      'SGWVinOffset',
      'SGWVinDID',
      'SGWVinHandler',
      'SGWVinCommand',
      'SGWVinMessage',
      'SGWVinService',
      'VinSGW',
      'SgwVin',
    ];
    for (const needle of absentApis) {
      const count = countSubstring(ascii, needle);
      expect(count, `unexpected SGW VIN API "${needle}" found in CDA SWF — reclassify SGW per docs/SGW_VIN_STORAGE.md`).toBe(0);
    }
    // Case-insensitive belt-and-braces for the two compound forms — catches
    // any oddly-cased variant like `vinSGW` / `sgwvin`.
    expect(countSubstring(ascii, 'vinsgw', { caseInsensitive: true })).toBe(0);
    expect(countSubstring(ascii, 'sgwvin', { caseInsensitive: true })).toBe(0);
  });

  it('4. has ZERO ASCII references to the VIN UDS DID identifier "F190"', () => {
    // F190 is the standard UDS DataIdentifier for the VIN. If the OEM tool
    // ever needed to address a VIN via DID-based UDS on any ECU it would
    // carry this string somewhere. It's absent — VIN handling is wired
    // through the BCM/PCM/RFHUB native UDS endpoints in this SWF, not
    // through generic F190-keyed UDS, and certainly not through the SGW.
    expect(countSubstring(ascii, 'F190')).toBe(0);
    expect(countSubstring(ascii, 'f190')).toBe(0);
  });

  it('5. runtime SGW_VIN_OFFSETS in parseModule + donorLeakScan agree with the bench trace', () => {
    // The whole point of pinning the bench trace is to make the empty
    // runtime arrays defensible. If a future commit populates either
    // array WITHOUT first updating docs/SGW_VIN_STORAGE.md to reflect a
    // newly discovered slot, this assertion is the canary.
    expect(SGW_VIN_OFFSETS_PARSE).toEqual([]);
    expect(SGW_VIN_OFFSETS_LEAK).toEqual([]);
  });
});

describe.skipIf(swfExists)('CDA SWF — SGW VIN-storage bench trace (Task #457)', () => {
  it.skip('skipped: attached_assets/CDA_1776448059516.swf not present', () => {});
});
