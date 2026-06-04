/**
 * checksumScanner.js — pure-JS mirror of tools/re-bridge/autokit_checksum.py
 *
 * Implements the same scanning, repair, and EEPROM-map logic so the feature
 * can be unit-tested without a Python process.  The API routes call the Python
 * version; this module is the testable JS equivalent.
 *
 * Algorithms supported (matching autokit_checksum.py's ALGOS table):
 *   crc32  · crc16 (CRC-16/CCITT-FALSE) · sum16 · sum32 · sum8 · xor32
 */

// ---------------------------------------------------------------------------
// CRC-32 (ISO 3309 / zlib, poly 0xEDB88320, init 0xFFFFFFFF, reflect)
// Matches Python's binascii.crc32
// ---------------------------------------------------------------------------
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(data, start = 0, end = data.length) {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no-reflect, no-XorOut)
// Matches crc16ccitt in crc.js and Python's _crc16_ccitt
// ---------------------------------------------------------------------------
function crc16ccitt(data, start = 0, end = data.length) {
  let crc = 0xFFFF;
  for (let i = start; i < end; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

// ---------------------------------------------------------------------------
// Algorithm table  {name → {width, compute(data,start,end) → Uint8Array}}
// Each compute() covers the half-open window [start, end). Passing start=0
// yields a whole-file prefix checksum; passing a block start yields a
// partial-range / per-block checksum (e.g. ZF-8HP TCU per-block CRC32).
// Mirrors autokit_checksum.py's ALGOS table.
// ---------------------------------------------------------------------------
const ALGOS = {
  crc32: {
    width: 4,
    compute(data, start, end) {
      const v = crc32(data, start, end);
      return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
    },
  },
  // crc32be: same CRC, stored big-endian — the byte order used by ZF-8HP
  // per-block CRC32 and many other FCA module images.
  crc32be: {
    width: 4,
    compute(data, start, end) {
      const v = crc32(data, start, end);
      return new Uint8Array([(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]);
    },
  },
  crc16: {
    width: 2,
    compute(data, start, end) {
      const v = crc16ccitt(data, start, end);
      return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
    },
  },
  sum16: {
    width: 2,
    compute(data, start, end) {
      let s = 0;
      for (let i = start; i + 1 < end; i += 2) s = (s + ((data[i + 1] << 8) | data[i])) & 0xFFFF;
      return new Uint8Array([s & 0xFF, (s >>> 8) & 0xFF]);
    },
  },
  sum32: {
    width: 4,
    compute(data, start, end) {
      let lo = 0, hi = 0;
      for (let i = start; i + 3 < end; i += 4) {
        lo = (lo + data[i] + (data[i + 1] << 8)) & 0xFFFF;
        hi = (hi + data[i + 2] + (data[i + 3] << 8)) & 0xFFFF;
      }
      return new Uint8Array([lo & 0xFF, (lo >>> 8) & 0xFF, hi & 0xFF, (hi >>> 8) & 0xFF]);
    },
  },
  sum8: {
    width: 1,
    compute(data, start, end) {
      let s = 0;
      for (let i = start; i < end; i++) s = (s + data[i]) & 0xFF;
      return new Uint8Array([s]);
    },
  },
  xor32: {
    width: 4,
    compute(data, start, end) {
      let a = 0, b = 0, c = 0, d = 0;
      for (let i = start; i + 3 < end; i += 4) {
        a ^= data[i]; b ^= data[i + 1]; c ^= data[i + 2]; d ^= data[i + 3];
      }
      return new Uint8Array([a, b, c, d]);
    },
  },
};

// Algorithms used by the prefix / structural (end-of-file) scan. crc32be is
// intentionally excluded here: big-endian CRCs are detected by the per-block
// pass (blockScan), which is far less prone to noisy false positives than
// surfacing every structural mismatch for an extra algorithm.
// Mirrors PREFIX_ALGOS in autokit_checksum.py.
const PREFIX_ALGOS = ["crc32", "crc16", "sum16", "sum32", "sum8", "xor32"];

// Common ECU block sizes probed by the partial-range / per-block scan.
// 0x10000 (64 KB) is included so ZF-8HP TCU per-block CRC32 schemes are caught.
// Mirrors BLOCK_SIZES in autokit_checksum.py.
const BLOCK_SIZES = [0x100, 0x1000, 0x4000, 0x10000];

// Only CRC algorithms are probed per-block. Real per-block ECU integrity
// schemes use CRCs; the sum/xor algorithms trivially "validate" over uniform
// padding regions (e.g. an all-0xFF block makes xor32 == 0xFFFFFFFF == stored),
// which would flood the results with false positives. CRCs do not match a
// uniform region's stored bytes, so they stay robust. Mirrors Python BLOCK_ALGOS.
const BLOCK_ALGOS = ["crc32", "crc32be", "crc16"];

// Human-readable inclusive coverage range string. Mirrors Python _covers().
function covers(start, pos) {
  return `0x${start.toString(16)} .. 0x${(pos - 1).toString(16)}`;
}

// ---------------------------------------------------------------------------
// hexStr helpers
// ---------------------------------------------------------------------------
function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// structuralProbes(n) → Set<number>
//
// Returns the last 16 byte-positions of the file's containing power-of-2
// block (smallest power-of-2 ≥ n).  ECU checksums land overwhelmingly at
// the very end of the flash/EEPROM region, so we concentrate there rather
// than every sub-block boundary.  Broken checksums at these positions are
// surfaced even when stored ≠ computed so that users who edited a dump can
// find and repair the invalidated field.
// Mirrors Python _structural_probes().
// ---------------------------------------------------------------------------
function structuralProbes(n) {
  // Smallest power-of-2 ≥ n
  let block = 256;
  while (block < n) block *= 2;

  const probes = new Set();
  for (let off = 1; off <= 16; off++) {
    const p = block - off;
    if (p >= 4 && p < n) probes.add(p);
  }
  return probes;
}

// ---------------------------------------------------------------------------
// prefixStates(data, positions) → Map<pos, {algo → Uint8Array}>
//
// Computes every prefix-checksum value at each probe position in ONE forward
// pass. Recomputing each algorithm from offset 0 at every probe is
// O(probes × size) and becomes pathological on large images (a 512 KB ZF-8HP
// dump took ~5 s). Because the probe positions are walked in ascending order,
// the accumulators only ever extend forward, making the scan O(size). The
// per-algorithm results are byte-for-byte identical to ALGOS[algo].compute(
// data, 0, pos). Mirrors Python _prefix_states().
// ---------------------------------------------------------------------------
function prefixStates(data, positions) {
  const n = data.length;
  const sorted = [...new Set(positions)].filter(p => p > 0 && p <= n).sort((a, b) => a - b);
  const states = new Map();

  let crc32run = 0xFFFFFFFF;
  let crc16 = 0xFFFF;
  let s8 = 0;
  let even = 0, odd = 0;          // sum16 byte lanes (even/odd index)
  let l0 = 0, l1 = 0, l2 = 0, l3 = 0; // sum32 byte lanes (index % 4)
  let x0 = 0, x1 = 0, x2 = 0, x3 = 0; // xor32 byte lanes (index % 4)
  let prev = 0;

  for (const cur of sorted) {
    for (let j = prev; j < cur; j++) {
      const b = data[j];
      s8 = (s8 + b) & 0xFF;
      crc32run = (crc32run >>> 8) ^ CRC32_TABLE[(crc32run ^ b) & 0xFF];
      crc16 ^= b << 8;
      for (let k = 0; k < 8; k++) crc16 = crc16 & 0x8000 ? ((crc16 << 1) ^ 0x1021) & 0xFFFF : (crc16 << 1) & 0xFFFF;
      if (j & 1) odd += b; else even += b;
      const m = j & 3;
      if (m === 0) { l0 += b; x0 ^= b; }
      else if (m === 1) { l1 += b; x1 ^= b; }
      else if (m === 2) { l2 += b; x2 ^= b; }
      else { l3 += b; x3 ^= b; }
    }
    prev = cur;

    const v = (crc32run ^ 0xFFFFFFFF) >>> 0;
    // sum16 over complete 2-byte words only.
    const lo16 = (even - (cur & 1 ? data[cur - 1] : 0));
    const s16 = (lo16 + 256 * odd) & 0xFFFF;
    // sum32 / xor32 over complete 4-byte words only — drop the trailing
    // incomplete word's bytes from each lane.
    const rem4 = cur & 3;
    const base = cur - rem4;
    let a0 = l0, a1 = l1, a2 = l2, a3 = l3;
    let b0 = x0, b1 = x1, b2 = x2, b3 = x3;
    if (rem4 > 0) { a0 -= data[base]; b0 ^= data[base]; }
    if (rem4 > 1) { a1 -= data[base + 1]; b1 ^= data[base + 1]; }
    if (rem4 > 2) { a2 -= data[base + 2]; b2 ^= data[base + 2]; }
    // sum32 mirrors the JS ALGOS.sum32 split-halfword form (lo/hi each mod 0x10000).
    const sLo = (a0 + 256 * a1) & 0xFFFF;
    const sHi = (a2 + 256 * a3) & 0xFFFF;

    states.set(cur, {
      crc32:   new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]),
      crc32be: new Uint8Array([(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]),
      crc16:   new Uint8Array([crc16 & 0xFF, (crc16 >>> 8) & 0xFF]),
      sum16:   new Uint8Array([s16 & 0xFF, (s16 >>> 8) & 0xFF]),
      sum32:   new Uint8Array([sLo & 0xFF, (sLo >>> 8) & 0xFF, sHi & 0xFF, (sHi >>> 8) & 0xFF]),
      sum8:    new Uint8Array([s8]),
      xor32:   new Uint8Array([b0 & 0xFF, b1 & 0xFF, b2 & 0xFF, b3 & 0xFF]),
    });
  }
  return states;
}

// ---------------------------------------------------------------------------
// blockScan(data, fileHasContent, seen)
//
// Detects partial-range / per-block checksums (the prefix scan only catches
// checksums covering bytes 0..offset-1). Many ECU images store a checksum at
// the END of each fixed-size block, covering only that block's bytes. The
// canonical case is the ZF-8HP TCU, which stores a big-endian CRC32 in the
// trailing 4 bytes of every 64 KB block over the preceding (BLOCK_SIZE-4)
// bytes. A scheme is reported only when ≥2 blocks AND at least half of the
// file's blocks validate, distinguishing a real per-block scheme from chance
// single-block matches of weak algorithms (e.g. sum8). Confirmed schemes also
// surface non-matching blocks as "broken" for repair. Mirrors Python _block_scan().
// ---------------------------------------------------------------------------
function blockScan(data, fileHasContent, seen) {
  const n = data.length;
  for (const blockSize of BLOCK_SIZES) {
    if (blockSize > n) continue;
    const totalBlocks = Math.floor(n / blockSize);
    if (totalBlocks < 2) continue;
    for (const name of BLOCK_ALGOS) {
      const { width, compute } = ALGOS[name];
      if (width >= blockSize) continue;
      const results = [];
      for (let k = 1; k <= totalBlocks; k++) {
        const blockEnd = k * blockSize;
        const start = blockEnd - blockSize;
        const csPos = blockEnd - width;
        if (csPos <= start) continue;
        let computed;
        try { computed = compute(data, start, csPos); } catch { continue; }
        const stored = data.slice(csPos, csPos + width);
        const match = computed.every((b, i) => b === stored[i]) && Array.from(stored).some(b => b !== 0);
        results.push({ csPos, start, stored, computed, match });
      }

      const validCount = results.filter(r => r.match).length;
      // Require a real scheme: ≥2 blocks AND at least half of them validate.
      if (validCount < 2 || validCount * 2 < results.length) continue;

      for (const { csPos, start, stored, computed, match } of results) {
        const key = `${start}:${csPos}:${name}`;
        const computedNonTrivial = Array.from(computed).some(b => b !== 0);
        if (match) {
          seen.set(key, {
            offset:      "0x" + csPos.toString(16),
            algorithm:   name,
            width,
            stored:      toHex(stored),
            computed:    toHex(computed),
            status:      "valid",
            covers:      covers(start, csPos),
            coversStart: "0x" + start.toString(16),
          });
        } else if (fileHasContent && computedNonTrivial && !seen.has(key)) {
          seen.set(key, {
            offset:      "0x" + csPos.toString(16),
            algorithm:   name,
            width,
            stored:      toHex(stored),
            computed:    toHex(computed),
            status:      "broken",
            covers:      covers(start, csPos),
            coversStart: "0x" + start.toString(16),
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// scanChecksums(data: Uint8Array) → [{offset, algorithm, width, stored, computed, status, covers, coversStart}]
//
// Mirrors Python cmd_checksum (with structural-probe + per-block extension):
//   • Prefix scan — any position: if stored === computed && non-trivial → "valid"
//   • Structural positions only (end-of-file zone), when file has content:
//     if stored ≠ computed && computed non-trivial → "broken"
//   • Per-block scan (blockScan) — partial-range checksums at block boundaries.
// Every entry carries coversStart (the coverage window start; "0x0" for a
// prefix checksum) so a repair can target the exact window.
// Results: valid entries sorted ASC by offset; then broken entries sorted DESC
// by offset (highest = end-of-file first). Total capped at 30.
// ---------------------------------------------------------------------------
export function scanChecksums(data) {
  const n = data.length;
  const step = Math.max(2, Math.floor(n / 400));
  const regularProbes = new Set();
  for (let p = 4; p < n - 4; p += step) regularProbes.add(p);
  for (const pct of [0.25, 0.5, 0.75, 1.0]) regularProbes.add(Math.max(4, Math.floor(n * pct)) & ~1);

  const structural = structuralProbes(n);
  const allProbes = new Set([...regularProbes, ...structural]);

  // Only surface broken candidates if the file actually has content.
  // All-zero / all-FF files produce trivially non-trivial CRC values at
  // every structural position, which would generate misleading noise.
  const fileHasContent = Array.from(data).some(b => b !== 0);

  // seen: key → entry  (prefer "valid" over "broken"). Prefix keys are
  // `0:${pos}:${name}` so a prefix and a same-offset block checksum never clash.
  const seen = new Map();

  // Single-pass precompute of all prefix-checksum values at every probe.
  const states = prefixStates(data, allProbes);

  for (const pos of [...allProbes].sort((a, b) => a - b)) {
    const isStructural = structural.has(pos);
    const state = states.get(pos) || {};
    for (const name of PREFIX_ALGOS) {
      const { width } = ALGOS[name];
      if (pos + width > n) continue;
      const computed = state[name];
      if (!computed) continue;
      const stored = data.slice(pos, pos + width);
      const key = `0:${pos}:${name}`;
      const computedNonTrivial = Array.from(computed).some(b => b !== 0);
      const storedMatchesComputed = computed.every((b, i) => b === stored[i]);
      const storedNonTrivial = Array.from(stored).some(b => b !== 0);
      // Blank EEPROM locations store all-FF (erased state) or all-00 (zero-filled).
      // These are NOT broken checksums — they are unwritten slots.  Surfacing them
      // as BROKEN floods the table with noise (e.g. 20+ entries on a GPEC2A whose
      // end region is all-FF).  Filter them from the broken candidate path; the
      // valid path still fires whenever computed === stored (e.g. sum8 = 0xFF).
      const storedIsAllFF = Array.from(stored).every(b => b === 0xFF);

      if (storedMatchesComputed && storedNonTrivial) {
        // Valid: stored checksum matches computed prefix — overwrite any prior broken entry
        seen.set(key, {
          offset:      "0x" + pos.toString(16),
          algorithm:   name,
          width,
          stored:      toHex(stored),
          computed:    toHex(computed),
          status:      "valid",
          covers:      covers(0, pos),
          coversStart: "0x0",
        });
      } else if (isStructural && fileHasContent && computedNonTrivial && !storedIsAllFF && !seen.has(key)) {
        // Broken candidate: structural position, file has data, stored slot looks
        // intentionally written (not blank EEPROM), computed is meaningful.
        seen.set(key, {
          offset:      "0x" + pos.toString(16),
          algorithm:   name,
          width,
          stored:      toHex(stored),
          computed:    toHex(computed),
          status:      "broken",
          covers:      covers(0, pos),
          coversStart: "0x0",
        });
      }
    }
  }

  // Partial-range / per-block checksums (e.g. ZF-8HP TCU per-block CRC32).
  blockScan(data, fileHasContent, seen);

  const validEntries  = [...seen.values()].filter(e => e.status === "valid")
    .sort((a, b) => parseInt(a.offset, 16) - parseInt(b.offset, 16));
  // Broken: sort DESC by offset so end-of-file (most likely ECU checksum) appears first
  const brokenEntries = [...seen.values()].filter(e => e.status === "broken")
    .sort((a, b) => parseInt(b.offset, 16) - parseInt(a.offset, 16));

  // Valid entries first (up to 20), then broken (highest offset first).
  // Combined cap of 30 so that with 0 valid entries the broken pool gets 30 slots.
  return [...validEntries, ...brokenEntries].slice(0, 30);
}

// ---------------------------------------------------------------------------
// fixChecksum(data, offsetHex, algorithm, startHex = 0) → Uint8Array (patched copy)
//
// Recomputes the checksum over its coverage window [start, pos) and writes it
// back at pos. `start` defaults to 0 (a whole-file prefix checksum); pass a
// scan entry's coversStart to repair a partial/per-block checksum (e.g. a
// ZF-8HP TCU per-block CRC32). Mirrors Python cmd_fixck's --start option.
// ---------------------------------------------------------------------------
export function fixChecksum(data, offsetHex, algorithm, startHex = 0) {
  const pos = typeof offsetHex === "number" ? offsetHex : parseInt(offsetHex, 16);
  const start = typeof startHex === "number" ? startHex : parseInt(startHex, 16);
  const algo = ALGOS[algorithm];
  if (!algo) throw new Error(`unknown algorithm: ${algorithm}`);
  if (start < 0 || start >= pos) throw new Error(`coverage start 0x${start.toString(16)} must be >= 0 and < offset 0x${pos.toString(16)}`);
  const patched = new Uint8Array(data);
  const computed = algo.compute(patched, start, pos);
  patched.set(computed, pos);
  return patched;
}

// ---------------------------------------------------------------------------
// eepmapAnalyze(data: Uint8Array) → {vinCandidates, strings, mirroredBlocks}
//
// Mirrors Python cmd_eepmap.
// ---------------------------------------------------------------------------
const VIN_RE = /[A-HJ-NPR-Z0-9]{17}/g;

export function eepmapAnalyze(data) {
  // Convert to latin1 string for regex scanning
  const text = Array.from(data).map(b => String.fromCharCode(b)).join("");

  // VIN candidates
  const vinCandidates = [];
  let m;
  VIN_RE.lastIndex = 0;
  while ((m = VIN_RE.exec(text)) !== null) {
    vinCandidates.push({ offset: "0x" + m.index.toString(16), vin: m[0] });
    if (vinCandidates.length >= 20) break;
  }

  // ASCII strings (length >= 6)
  const strings = [];
  let runStart = null;
  let runBuf = [];
  for (let i = 0; i <= data.length; i++) {
    const b = data[i];
    if (b !== undefined && b >= 0x20 && b < 0x7F) {
      if (runStart === null) runStart = i;
      runBuf.push(String.fromCharCode(b));
    } else {
      if (runStart !== null && runBuf.length >= 6) {
        strings.push({ offset: "0x" + runStart.toString(16), length: runBuf.length, text: runBuf.slice(0, 80).join("") });
      }
      runStart = null;
      runBuf = [];
    }
  }
  strings.sort((a, b) => b.length - a.length);

  // Mirrored 16-byte blocks
  const mirroredBlocks = [];
  const blockMap = new Map();
  for (let i = 0; i < data.length - 16; i += 4) {
    const blk = data.slice(i, i + 16);
    if (blk.every(b => b === 0xFF) || blk.every(b => b === 0)) continue;
    const key = toHex(blk);
    if (blockMap.has(key)) {
      mirroredBlocks.push({
        first_offset: "0x" + blockMap.get(key).toString(16),
        mirror_offset: "0x" + i.toString(16),
        gap: "0x" + (i - blockMap.get(key)).toString(16),
        hex: key,
      });
      if (mirroredBlocks.length >= 30) break;
    } else {
      blockMap.set(key, i);
    }
  }

  return {
    vinCandidates: vinCandidates.slice(0, 20),
    strings: strings.slice(0, 40),
    mirroredBlocks,
  };
}

export { ALGOS, PREFIX_ALGOS, BLOCK_SIZES, crc32, crc16ccitt };
