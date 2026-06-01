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

function crc32(data, end = data.length) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < end; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no-reflect, no-XorOut)
// Matches crc16ccitt in crc.js and Python's _crc16_ccitt
// ---------------------------------------------------------------------------
function crc16ccitt(data, end = data.length) {
  let crc = 0xFFFF;
  for (let i = 0; i < end; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

// ---------------------------------------------------------------------------
// Algorithm table  {name → {width, compute(data,n) → Uint8Array}}
// ---------------------------------------------------------------------------
const ALGOS = {
  crc32: {
    width: 4,
    compute(data, n) {
      const v = crc32(data, n);
      return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
    },
  },
  crc16: {
    width: 2,
    compute(data, n) {
      const v = crc16ccitt(data, n);
      return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
    },
  },
  sum16: {
    width: 2,
    compute(data, n) {
      let s = 0;
      for (let i = 0; i + 1 < n; i += 2) s = (s + ((data[i + 1] << 8) | data[i])) & 0xFFFF;
      return new Uint8Array([s & 0xFF, (s >>> 8) & 0xFF]);
    },
  },
  sum32: {
    width: 4,
    compute(data, n) {
      let lo = 0, hi = 0;
      for (let i = 0; i + 3 < n; i += 4) {
        lo = (lo + data[i] + (data[i + 1] << 8)) & 0xFFFF;
        hi = (hi + data[i + 2] + (data[i + 3] << 8)) & 0xFFFF;
      }
      return new Uint8Array([lo & 0xFF, (lo >>> 8) & 0xFF, hi & 0xFF, (hi >>> 8) & 0xFF]);
    },
  },
  sum8: {
    width: 1,
    compute(data, n) {
      let s = 0;
      for (let i = 0; i < n; i++) s = (s + data[i]) & 0xFF;
      return new Uint8Array([s]);
    },
  },
  xor32: {
    width: 4,
    compute(data, n) {
      let a = 0, b = 0, c = 0, d = 0;
      for (let i = 0; i + 3 < n; i += 4) {
        a ^= data[i]; b ^= data[i + 1]; c ^= data[i + 2]; d ^= data[i + 3];
      }
      return new Uint8Array([a, b, c, d]);
    },
  },
};

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
// scanChecksums(data: Uint8Array) → [{offset, algorithm, width, stored, computed, status, covers}]
//
// Mirrors Python cmd_checksum (with structural-probe extension):
//   • Any position: if stored === computed && non-trivial → "valid"
//   • Structural positions only (end-of-file zone), when file has content:
//     if stored ≠ computed && computed non-trivial → "broken"
//     These are candidate checksum fields invalidated by a user edit.
// Results: valid entries sorted ASC by offset (up to 20); then broken
// entries sorted DESC by offset (highest = end-of-file first, up to 10).
// Total capped at 30.
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

  // seen: `${pos}:${name}` → entry  (prefer "valid" over "broken")
  const seen = new Map();

  for (const pos of [...allProbes].sort((a, b) => a - b)) {
    const isStructural = structural.has(pos);
    for (const [name, { width, compute }] of Object.entries(ALGOS)) {
      if (pos + width > n) continue;
      let computed;
      try { computed = compute(data, pos); } catch { continue; }
      const stored = data.slice(pos, pos + width);
      const key = `${pos}:${name}`;
      const computedNonTrivial = Array.from(computed).some(b => b !== 0);
      const storedMatchesComputed = computed.every((b, i) => b === stored[i]);
      const storedNonTrivial = Array.from(stored).some(b => b !== 0);

      if (storedMatchesComputed && storedNonTrivial) {
        // Valid: stored checksum matches computed prefix — overwrite any prior broken entry
        seen.set(key, {
          offset:    "0x" + pos.toString(16),
          algorithm: name,
          width,
          stored:    toHex(stored),
          computed:  toHex(computed),
          status:    "valid",
          covers:    `0x0 .. 0x${(pos - 1).toString(16)}`,
        });
      } else if (isStructural && fileHasContent && computedNonTrivial && !seen.has(key)) {
        // Broken candidate: structural position, file has data, computed is meaningful.
        // Surface so users can see and repair the invalidated field.
        seen.set(key, {
          offset:    "0x" + pos.toString(16),
          algorithm: name,
          width,
          stored:    toHex(stored),
          computed:  toHex(computed),
          status:    "broken",
          covers:    `0x0 .. 0x${(pos - 1).toString(16)}`,
        });
      }
    }
  }

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
// fixChecksum(data, offsetHex, algorithm) → Uint8Array (patched copy)
// ---------------------------------------------------------------------------
export function fixChecksum(data, offsetHex, algorithm) {
  const pos = typeof offsetHex === "number" ? offsetHex : parseInt(offsetHex, 16);
  const algo = ALGOS[algorithm];
  if (!algo) throw new Error(`unknown algorithm: ${algorithm}`);
  const patched = new Uint8Array(data);
  const computed = algo.compute(patched, pos);
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

export { ALGOS, crc32, crc16ccitt };
