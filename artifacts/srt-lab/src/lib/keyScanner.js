/**
 * keyScanner.js — Pure browser-safe binary scanner for embedded keys,
 * secrets, and cryptographic constants.
 *
 * Ported from the bundled `srt-lab-ultimate` server/key-scanner.ts concept;
 * converted from Node Buffer API to Uint8Array so it runs client-side with
 * no external dependencies.
 *
 * Export: scanForKeys(bytes, options?) → KeyFinding[]
 *
 * Each KeyFinding has:
 *   id        — stable deterministic string (group-hexoffset)
 *   group     — 'pem' | 'ssh' | 'jwt' | 'apikey' | 'entropy' | 'crypto-const'
 *   label     — human-readable name
 *   offset    — byte offset in the binary
 *   size      — byte span of the finding
 *   severity  — 'high' | 'medium' | 'low'
 *   preview   — short hex/ascii string for display (truncated)
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function toAscii(bytes, offset, len) {
  let s = "";
  for (let i = 0; i < len && offset + i < bytes.length; i++) {
    const b = bytes[offset + i];
    s += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : ".";
  }
  return s;
}

function toHex(bytes, offset, len) {
  let s = "";
  for (let i = 0; i < len && offset + i < bytes.length; i++) {
    if (i > 0) s += " ";
    s += bytes[offset + i].toString(16).padStart(2, "0").toUpperCase();
  }
  return s;
}

function makeId(group, offset) {
  return group + "-" + offset.toString(16).padStart(6, "0");
}

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

// Search for a byte sequence (needle) in a Uint8Array (haystack).
// Returns array of all start offsets.
function findAll(haystack, needle) {
  const results = [];
  if (!needle.length || needle.length > haystack.length) return results;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    results.push(i);
  }
  return results;
}

// Scan for ASCII pattern (string) in byte array. Returns array of offsets.
function findAsciiPattern(bytes, pattern) {
  const encoded = [];
  for (let i = 0; i < pattern.length; i++) encoded.push(pattern.charCodeAt(i));
  return findAll(bytes, new Uint8Array(encoded));
}

// Extract a null-terminated or length-bounded ASCII run starting at offset.
// Returns the string and actual length read.
function readAsciiRun(bytes, offset, maxLen) {
  let s = "";
  for (let i = 0; i < maxLen && offset + i < bytes.length; i++) {
    const b = bytes[offset + i];
    if (b === 0) break;
    if (b >= 0x20 && b < 0x7F) s += String.fromCharCode(b);
    else break;
  }
  return s;
}

// Shannon entropy of a byte window (bits per byte, max 8.0).
function shannonEntropy(bytes, offset, windowSize) {
  const end = Math.min(offset + windowSize, bytes.length);
  const actual = end - offset;
  if (actual < 1) return 0;
  const freq = new Uint32Array(256);
  for (let i = offset; i < end; i++) freq[bytes[i]]++;
  let entropy = 0;
  for (let b = 0; b < 256; b++) {
    if (freq[b] === 0) continue;
    const p = freq[b] / actual;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ── Crypto-constant table ──────────────────────────────────────────────────
// Each entry: { label, bytes: Uint8Array, severity, group }

const AES_SBOX_HEAD = new Uint8Array([
  0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5,
  0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
]);

const AES_INV_SBOX_HEAD = new Uint8Array([
  0x52, 0x09, 0x6A, 0xD5, 0x30, 0x36, 0xA5, 0x38,
  0xBF, 0x40, 0xA3, 0x9E, 0x81, 0xF3, 0xD7, 0xFB,
]);

// AES Rcon table (10 round constants used in key expansion)
const AES_RCON = new Uint8Array([
  0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36,
]);

// SHA-256 initial hash values (H0–H7) in big-endian
const SHA256_IV = new Uint8Array([
  0x6A, 0x09, 0xE6, 0x67, 0xBB, 0x67, 0xAE, 0x85,
  0x3C, 0x6E, 0xF3, 0x72, 0xA5, 0x4F, 0xF5, 0x3A,
  0x51, 0x0E, 0x52, 0x7F, 0x9B, 0x05, 0x68, 0x8C,
  0x1F, 0x83, 0xD9, 0xAB, 0x5B, 0xE0, 0xCD, 0x19,
]);

// MD5 initial hash values (A/B/C/D) little-endian (67 45 23 01 / EF CD AB 89 / 98 BA DC FE / 10 32 54 76)
const MD5_IV = new Uint8Array([
  0x67, 0x45, 0x23, 0x01, 0xEF, 0xCD, 0xAB, 0x89,
  0x98, 0xBA, 0xDC, 0xFE, 0x10, 0x32, 0x54, 0x76,
]);

// DES S-box first 8 bytes of S1 (row 0: 14 4 13 1 2 15 11 8...)
// Represented as packed nibbles: 0xE4, 0xD1, 0x2F, 0xB8
// Full first row bytes used in most DES lookup-table implementations:
const DES_SBOX_S1 = new Uint8Array([0x0E, 0x04, 0x0D, 0x01, 0x02, 0x0F, 0x0B, 0x08]);

// CRC-32 IEEE polynomial 0x04C11DB7 (big-endian)
const CRC32_POLY_BE = new Uint8Array([0x04, 0xC1, 0x1D, 0xB7]);
// CRC-32 IEEE polynomial 0xEDB88320 (reflected/little-endian, zlib style)
const CRC32_POLY_LE = new Uint8Array([0x20, 0x83, 0xB8, 0xED]);
// CRC-16/CCITT polynomial 0x1021 (big-endian)
const CRC16_CCITT_POLY = new Uint8Array([0x10, 0x21]);
// CRC-16/CCITT common initial value 0xFFFF in lookup table prefix
const CRC16_CCITT_TABLE_START = new Uint8Array([0x00, 0x00, 0x10, 0x21, 0x20, 0x42, 0x30, 0x63]);

const CRYPTO_CONSTANTS = [
  { label: "AES S-Box (forward, first 16 B)", bytes: AES_SBOX_HEAD, severity: "medium" },
  { label: "AES S-Box (inverse, first 16 B)", bytes: AES_INV_SBOX_HEAD, severity: "medium" },
  { label: "AES Rcon table (10 B)", bytes: AES_RCON, severity: "low" },
  { label: "SHA-256 Initial Hash Values (IVs, 32 B)", bytes: SHA256_IV, severity: "medium" },
  { label: "MD5 Initial Hash Values (IVs, 16 B)", bytes: MD5_IV, severity: "medium" },
  { label: "DES S-Box S1 row-0 (8 B)", bytes: DES_SBOX_S1, severity: "low" },
  { label: "CRC-32 polynomial 0x04C11DB7 (BE)", bytes: CRC32_POLY_BE, severity: "low" },
  { label: "CRC-32 polynomial 0xEDB88320 (reflected)", bytes: CRC32_POLY_LE, severity: "low" },
  { label: "CRC-16/CCITT polynomial 0x1021", bytes: CRC16_CCITT_POLY, severity: "low" },
  { label: "CRC-16/CCITT lookup-table header (8 B)", bytes: CRC16_CCITT_TABLE_START, severity: "low" },
];

// ── PEM block scanner ──────────────────────────────────────────────────────

const PEM_HEADERS = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  "-----BEGIN PUBLIC KEY-----",
  "-----BEGIN RSA PUBLIC KEY-----",
  "-----BEGIN CERTIFICATE-----",
  "-----BEGIN CERTIFICATE REQUEST-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "-----BEGIN PGP PUBLIC KEY BLOCK-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN DSA PRIVATE KEY-----",
];

function scanPem(bytes) {
  const findings = [];
  for (const header of PEM_HEADERS) {
    const offsets = findAsciiPattern(bytes, header);
    for (const offset of offsets) {
      // Find corresponding footer
      const footer = header.replace("BEGIN", "END");
      const footerOffsets = findAsciiPattern(bytes, footer);
      let size = header.length;
      for (const fo of footerOffsets) {
        if (fo > offset) { size = fo + footer.length - offset; break; }
      }
      const isPrivate = header.includes("PRIVATE");
      const label = header.replace("-----BEGIN ", "").replace("-----", "").trim();
      findings.push({
        id: makeId("pem", offset),
        group: "pem",
        label: "PEM: " + label,
        offset,
        size: clamp(size, header.length, 65536),
        severity: isPrivate ? "high" : "medium",
        preview: header.slice(0, 40) + "…",
      });
    }
  }
  return findings;
}

// ── SSH key scanner ────────────────────────────────────────────────────────

// SSH public key wire format starts with a 4-byte big-endian length then
// "ssh-rsa", "ecdsa-sha2-*", "ssh-ed25519" etc. as ASCII.
const SSH_KEY_TYPES = [
  new Uint8Array([0x00, 0x00, 0x00, 0x07, 0x73, 0x73, 0x68, 0x2D, 0x72, 0x73, 0x61]), // ssh-rsa
  new Uint8Array([0x00, 0x00, 0x00, 0x0B, 0x73, 0x73, 0x68, 0x2D, 0x65, 0x64, 0x32, 0x35, 0x35, 0x31, 0x39]), // ssh-ed25519
  new Uint8Array([0x00, 0x00, 0x00, 0x13, 0x65, 0x63, 0x64, 0x73, 0x61, 0x2D, 0x73, 0x68, 0x61, 0x32, 0x2D, 0x6E, 0x69, 0x73, 0x74, 0x70, 0x32, 0x35, 0x36]), // ecdsa-sha2-nistp256
];

function scanSsh(bytes) {
  const findings = [];
  // Also check PEM-style SSH headers (covered by PEM scanner above for
  // OPENSSH PRIVATE KEY, but handle authorized_keys-style "ssh-rsa " prefixes)
  const sshPrefixes = ["ssh-rsa ", "ssh-ed25519 ", "ecdsa-sha2-"];
  for (const prefix of sshPrefixes) {
    const offsets = findAsciiPattern(bytes, prefix);
    for (const offset of offsets) {
      const preview = readAsciiRun(bytes, offset, 64);
      findings.push({
        id: makeId("ssh", offset),
        group: "ssh",
        label: "SSH public key (" + prefix.trim() + ")",
        offset,
        size: Math.min(preview.length + 64, 512),
        severity: "medium",
        preview: preview.slice(0, 60) + (preview.length > 60 ? "…" : ""),
      });
    }
  }
  // Wire-format SSH blobs
  for (const magic of SSH_KEY_TYPES) {
    const offsets = findAll(bytes, magic);
    for (const offset of offsets) {
      const keyType = toAscii(bytes, offset + 4, magic.length - 4);
      findings.push({
        id: makeId("ssh-wire", offset),
        group: "ssh",
        label: "SSH wire-format key blob (" + keyType + ")",
        offset,
        size: 128,
        severity: "medium",
        preview: toHex(bytes, offset, 16),
      });
    }
  }
  return findings;
}

// ── JWT scanner ────────────────────────────────────────────────────────────

// JWT: three base64url segments separated by '.' The first segment decodes
// to {"alg":"...","typ":"JWT"}.
// We look for the ASCII pattern eyJ (base64url for {"a or similar JSON open).
function scanJwt(bytes) {
  const findings = [];
  const prefix = "eyJ"; // base64url for '{"'
  const dotByte = 0x2E; // '.'
  const prefixBytes = new Uint8Array([0x65, 0x79, 0x4A]); // e y J
  const offsets = findAll(bytes, prefixBytes);
  for (const offset of offsets) {
    // Validate: must have two dots within reasonable distance (20..2048 bytes)
    let dot1 = -1, dot2 = -1;
    for (let i = offset + 3; i < Math.min(offset + 2048, bytes.length); i++) {
      if (bytes[i] === dotByte) {
        if (dot1 === -1) { dot1 = i; }
        else { dot2 = i; break; }
      }
      // Only base64url chars: A-Z a-z 0-9 - _ .
      const b = bytes[i];
      const valid =
        (b >= 0x41 && b <= 0x5A) || // A-Z
        (b >= 0x61 && b <= 0x7A) || // a-z
        (b >= 0x30 && b <= 0x39) || // 0-9
        b === 0x2D || b === 0x5F || b === 0x2E; // - _ .
      if (!valid) break;
    }
    if (dot1 === -1 || dot2 === -1) continue;
    // Third segment must also be base64url chars
    let segEnd = dot2 + 1;
    for (let i = dot2 + 1; i < Math.min(dot2 + 512, bytes.length); i++) {
      const b = bytes[i];
      const valid =
        (b >= 0x41 && b <= 0x5A) ||
        (b >= 0x61 && b <= 0x7A) ||
        (b >= 0x30 && b <= 0x39) ||
        b === 0x2D || b === 0x5F;
      if (!valid) { segEnd = i; break; }
    }
    const totalLen = segEnd - offset;
    if (totalLen < 20) continue;
    findings.push({
      id: makeId("jwt", offset),
      group: "jwt",
      label: "JWT token",
      offset,
      size: totalLen,
      severity: "high",
      preview: toAscii(bytes, offset, 60) + (totalLen > 60 ? "…" : ""),
    });
  }
  return findings;
}

// ── API key pattern scanner ────────────────────────────────────────────────

const API_KEY_PATTERNS = [
  {
    name: "AWS Access Key ID",
    prefix: "AKIA",
    totalLen: 20,
    charset: /^[A-Z0-9]{16}$/,
    severity: "high",
  },
  {
    name: "AWS Secret Access Key prefix",
    prefix: "AWS_SECRET_ACCESS_KEY",
    totalLen: 40,
    charset: null,
    severity: "high",
  },
  {
    name: "GitHub Personal Access Token (classic)",
    prefix: "ghp_",
    totalLen: 40,
    charset: /^[A-Za-z0-9]{36}$/,
    severity: "high",
  },
  {
    name: "GitHub OAuth Token",
    prefix: "gho_",
    totalLen: 40,
    charset: /^[A-Za-z0-9]{36}$/,
    severity: "high",
  },
  {
    name: "GitHub Actions Token",
    prefix: "ghs_",
    totalLen: 40,
    charset: /^[A-Za-z0-9]{36}$/,
    severity: "high",
  },
  {
    name: "Stripe Live Secret Key",
    prefix: "sk_live_",
    totalLen: 32,
    charset: null,
    severity: "high",
  },
  {
    name: "Stripe Test Secret Key",
    prefix: "sk_test_",
    totalLen: 32,
    charset: null,
    severity: "medium",
  },
  {
    name: "Google API Key",
    prefix: "AIza",
    totalLen: 39,
    charset: /^[A-Za-z0-9_\-]{35}$/,
    severity: "high",
  },
  {
    name: "Slack Bot Token",
    prefix: "xoxb-",
    totalLen: 56,
    charset: null,
    severity: "high",
  },
  {
    name: "Slack App Token",
    prefix: "xapp-",
    totalLen: 56,
    charset: null,
    severity: "high",
  },
  {
    name: "npm auth token",
    prefix: "npm_",
    totalLen: 40,
    charset: null,
    severity: "medium",
  },
];

function scanApiKeys(bytes) {
  const findings = [];
  for (const pat of API_KEY_PATTERNS) {
    const offsets = findAsciiPattern(bytes, pat.prefix);
    for (const offset of offsets) {
      const maxRead = pat.totalLen + 32;
      const candidate = readAsciiRun(bytes, offset, maxRead);
      const suffix = candidate.slice(pat.prefix.length, pat.prefix.length + (pat.totalLen - pat.prefix.length));
      if (pat.charset && !pat.charset.test(suffix)) continue;
      if (candidate.length < pat.prefix.length + 4) continue;
      findings.push({
        id: makeId("apikey", offset),
        group: "apikey",
        label: pat.name,
        offset,
        size: candidate.length,
        severity: pat.severity,
        preview: candidate.slice(0, 32) + (candidate.length > 32 ? "…" : ""),
      });
    }
  }
  return findings;
}

// ── High-entropy blob scanner ──────────────────────────────────────────────

function scanEntropy(bytes, threshold = 7.2, windowSize = 256, stepSize = 64) {
  const findings = [];
  if (bytes.length < windowSize) return findings;

  let inBlob = false;
  let blobStart = 0;

  for (let i = 0; i <= bytes.length - windowSize; i += stepSize) {
    const entropy = shannonEntropy(bytes, i, windowSize);
    if (entropy >= threshold) {
      if (!inBlob) {
        inBlob = true;
        blobStart = i;
      }
    } else {
      if (inBlob) {
        const blobEnd = i + windowSize;
        const blobLen = clamp(blobEnd - blobStart, windowSize, 65536);
        findings.push({
          id: makeId("entropy", blobStart),
          group: "entropy",
          label: "High-entropy blob (" + entropy.toFixed(2) + " bits/byte)",
          offset: blobStart,
          size: blobLen,
          severity: "medium",
          preview: toHex(bytes, blobStart, 16) + "…",
        });
        inBlob = false;
      }
    }
  }
  // Close open blob at end of scan
  if (inBlob) {
    const blobLen = clamp(bytes.length - blobStart, windowSize, 65536);
    const finalEntropy = shannonEntropy(bytes, blobStart, Math.min(windowSize, bytes.length - blobStart));
    findings.push({
      id: makeId("entropy", blobStart),
      group: "entropy",
      label: "High-entropy blob (" + finalEntropy.toFixed(2) + " bits/byte)",
      offset: blobStart,
      size: blobLen,
      severity: "medium",
      preview: toHex(bytes, blobStart, 16) + "…",
    });
  }
  return findings;
}

// ── Crypto-constant scanner ────────────────────────────────────────────────

function scanCryptoConstants(bytes) {
  const findings = [];
  for (const entry of CRYPTO_CONSTANTS) {
    const offsets = findAll(bytes, entry.bytes);
    for (const offset of offsets) {
      findings.push({
        id: makeId("crypto-const", offset),
        group: "crypto-const",
        label: entry.label,
        offset,
        size: entry.bytes.length,
        severity: entry.severity,
        preview: toHex(bytes, offset, Math.min(entry.bytes.length, 16)),
      });
    }
  }
  return findings;
}

// ── Deduplication ──────────────────────────────────────────────────────────

// Remove findings that overlap with a higher-priority finding at the same
// or nearby offset. Priority order: pem > ssh > jwt > apikey > entropy > crypto-const
const GROUP_PRIORITY = { pem: 0, ssh: 1, jwt: 2, apikey: 3, entropy: 4, "crypto-const": 5 };

function dedup(findings) {
  // Stable sort by offset, then by group priority
  const sorted = findings.slice().sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    return (GROUP_PRIORITY[a.group] ?? 99) - (GROUP_PRIORITY[b.group] ?? 99);
  });
  const kept = [];
  for (const f of sorted) {
    // Check if this finding is entirely contained within an already-kept higher-priority one
    const dominated = kept.some(k => {
      const kPri = GROUP_PRIORITY[k.group] ?? 99;
      const fPri = GROUP_PRIORITY[f.group] ?? 99;
      if (kPri >= fPri) return false; // k is lower or equal priority — cannot dominate f
      // k has higher priority; does its span overlap f's start significantly?
      return k.offset <= f.offset && k.offset + k.size >= f.offset + Math.min(f.size, 4);
    });
    if (!dominated) kept.push(f);
  }
  return kept;
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Scan a binary buffer for embedded keys, secrets, and crypto constants.
 *
 * @param {Uint8Array} bytes — the binary to scan
 * @param {object}    [options]
 * @param {number}    [options.entropyThreshold=7.2] — min Shannon entropy (bits/byte) to flag
 * @param {number}    [options.entropyWindow=256]    — sliding window size in bytes
 * @param {number}    [options.entropyStep=64]       — stride between windows
 * @param {boolean}   [options.skipEntropy=false]    — disable entropy scanner (faster, no false positives)
 * @returns {KeyFinding[]} stable-sorted findings (offset ASC, group priority ASC)
 */
export function scanForKeys(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("scanForKeys: bytes must be a Uint8Array");
  }

  const {
    entropyThreshold = 7.2,
    entropyWindow = 256,
    entropyStep = 64,
    skipEntropy = false,
  } = options;

  const raw = [
    ...scanPem(bytes),
    ...scanSsh(bytes),
    ...scanJwt(bytes),
    ...scanApiKeys(bytes),
    ...(skipEntropy ? [] : scanEntropy(bytes, entropyThreshold, entropyWindow, entropyStep)),
    ...scanCryptoConstants(bytes),
  ];

  const deduped = dedup(raw);

  // Final stable sort: offset ASC, then group priority ASC, then id ASC
  deduped.sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    const pa = GROUP_PRIORITY[a.group] ?? 99;
    const pb = GROUP_PRIORITY[b.group] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return deduped;
}

export { shannonEntropy, findAll, toHex, toAscii };
