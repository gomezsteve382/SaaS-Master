/**
 * key-scanner.ts — Binary Key & Secrets Scanner
 *
 * Scans a binary buffer for embedded cryptographic material:
 *   - PEM blocks (certs, private/public keys)
 *   - SSH keys (RSA, ECDSA, Ed25519)
 *   - JWTs (3-part base64url token)
 *   - API keys (AWS AKIA, GitHub tokens, Stripe, Google)
 *   - High-entropy blobs (7.2 bits/byte threshold, 256-byte sliding window)
 *   - Crypto constants (AES S-Box, SHA-256 IVs, DES S-Box, CRC-32 poly, etc.)
 */

export type KeyFindingGroup =
  | "pem"
  | "ssh"
  | "jwt"
  | "api_key"
  | "high_entropy"
  | "crypto_constant";

export interface KeyFinding {
  id: string; // stable deterministic ID: group-offset-size
  group: KeyFindingGroup;
  label: string; // human-readable type, e.g. "RSA Private Key"
  offset: number; // byte offset in the binary
  size: number; // byte length of the finding
  preview: string; // short printable preview (first 64 chars)
  severity: "high" | "medium" | "low";
}

// ─── Shannon Entropy ─────────────────────────────────────────────────────────
function shannonEntropy(buf: Buffer, start: number, len: number): number {
  const freq = new Array(256).fill(0);
  for (let i = start; i < start + len && i < buf.length; i++) {
    freq[buf[i]]++;
  }
  let entropy = 0;
  for (const f of freq) {
    if (f > 0) {
      const p = f / len;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

// ─── PEM Block Scanner ────────────────────────────────────────────────────────
const PEM_HEADERS: Record<string, string> = {
  "-----BEGIN CERTIFICATE-----": "Certificate",
  "-----BEGIN PRIVATE KEY-----": "Private Key (PKCS#8)",
  "-----BEGIN RSA PRIVATE KEY-----": "RSA Private Key",
  "-----BEGIN EC PRIVATE KEY-----": "EC Private Key",
  "-----BEGIN OPENSSH PRIVATE KEY-----": "OpenSSH Private Key",
  "-----BEGIN PUBLIC KEY-----": "Public Key",
  "-----BEGIN RSA PUBLIC KEY-----": "RSA Public Key",
  "-----BEGIN CERTIFICATE REQUEST-----": "Certificate Request",
  "-----BEGIN X509 CRL-----": "X.509 CRL",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----": "PGP Private Key",
  "-----BEGIN PGP PUBLIC KEY BLOCK-----": "PGP Public Key",
};

function scanPEM(str: string, buf: Buffer): KeyFinding[] {
  const findings: KeyFinding[] = [];
  for (const [header, label] of Object.entries(PEM_HEADERS)) {
    let pos = 0;
    while (true) {
      const idx = str.indexOf(header, pos);
      if (idx === -1) break;
      const endMarker = header.replace("BEGIN", "END");
      const endIdx = str.indexOf(endMarker, idx);
      const size = endIdx === -1 ? Math.min(512, buf.length - idx) : endIdx + endMarker.length - idx;
      const offset = idx;
      findings.push({
        id: `pem-${offset}-${size}`,
        group: "pem",
        label,
        offset,
        size,
        preview: str.slice(idx, idx + 64).replace(/\r?\n/g, " "),
        severity: "high",
      });
      pos = idx + 1;
    }
  }
  return findings;
}

// ─── SSH Key Scanner ──────────────────────────────────────────────────────────
const SSH_PATTERNS = [
  { pattern: "ssh-rsa AAAA", label: "SSH RSA Public Key" },
  { pattern: "ssh-ed25519 AAAA", label: "SSH Ed25519 Public Key" },
  { pattern: "ecdsa-sha2-nistp256 AAAA", label: "SSH ECDSA Public Key" },
  { pattern: "-----BEGIN OPENSSH PRIVATE KEY-----", label: "OpenSSH Private Key" },
];

function scanSSH(str: string): KeyFinding[] {
  const findings: KeyFinding[] = [];
  for (const { pattern, label } of SSH_PATTERNS) {
    let pos = 0;
    while (true) {
      const idx = str.indexOf(pattern, pos);
      if (idx === -1) break;
      // SSH public keys end at whitespace/newline after the key data
      const endIdx = str.indexOf("\n", idx + pattern.length + 100);
      const size = endIdx === -1 ? Math.min(256, str.length - idx) : endIdx - idx;
      findings.push({
        id: `ssh-${idx}-${size}`,
        group: "ssh",
        label,
        offset: idx,
        size,
        preview: str.slice(idx, idx + 64),
        severity: "high",
      });
      pos = idx + 1;
    }
  }
  return findings;
}

// ─── JWT Scanner ──────────────────────────────────────────────────────────────
const JWT_REGEX = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

function scanJWT(str: string): KeyFinding[] {
  const findings: KeyFinding[] = [];
  let match: RegExpExecArray | null;
  while ((match = JWT_REGEX.exec(str)) !== null) {
    const offset = match.index;
    const size = match[0].length;
    findings.push({
      id: `jwt-${offset}-${size}`,
      group: "jwt",
      label: "JSON Web Token (JWT)",
      offset,
      size,
      preview: match[0].slice(0, 64),
      severity: "high",
    });
  }
  // Reset lastIndex after use
  JWT_REGEX.lastIndex = 0;
  return findings;
}

// ─── API Key Scanner ──────────────────────────────────────────────────────────
const API_KEY_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /AKIA[0-9A-Z]{16}/g, label: "AWS Access Key ID" },
  { regex: /ASIA[0-9A-Z]{16}/g, label: "AWS Temporary Access Key" },
  { regex: /ghp_[A-Za-z0-9]{36}/g, label: "GitHub Personal Access Token" },
  { regex: /gho_[A-Za-z0-9]{36}/g, label: "GitHub OAuth Token" },
  { regex: /github_pat_[A-Za-z0-9_]{82}/g, label: "GitHub Fine-Grained PAT" },
  { regex: /sk_live_[A-Za-z0-9]{24,}/g, label: "Stripe Live Secret Key" },
  { regex: /sk_test_[A-Za-z0-9]{24,}/g, label: "Stripe Test Secret Key" },
  { regex: /AIza[0-9A-Za-z_-]{35}/g, label: "Google API Key" },
  { regex: /[0-9a-f]{32}-us[0-9]+/g, label: "Mailchimp API Key" },
  { regex: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, label: "SendGrid API Key" },
];

function scanAPIKeys(str: string): KeyFinding[] {
  const findings: KeyFinding[] = [];
  for (const { regex, label } of API_KEY_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(str)) !== null) {
      const offset = match.index;
      const size = match[0].length;
      findings.push({
        id: `api_key-${offset}-${size}`,
        group: "api_key",
        label,
        offset,
        size,
        preview: match[0].slice(0, 64),
        severity: "high",
      });
    }
    regex.lastIndex = 0;
  }
  return findings;
}

// ─── High-Entropy Blob Scanner ────────────────────────────────────────────────
const ENTROPY_THRESHOLD = 7.2;
const WINDOW_SIZE = 256;
const STRIDE = 64; // step between windows

function scanHighEntropy(buf: Buffer): KeyFinding[] {
  const findings: KeyFinding[] = [];
  let inBlob = false;
  let blobStart = 0;

  for (let i = 0; i + WINDOW_SIZE <= buf.length; i += STRIDE) {
    const entropy = shannonEntropy(buf, i, WINDOW_SIZE);
    if (entropy >= ENTROPY_THRESHOLD) {
      if (!inBlob) {
        inBlob = true;
        blobStart = i;
      }
    } else {
      if (inBlob) {
        const size = i - blobStart + WINDOW_SIZE;
        findings.push({
          id: `high_entropy-${blobStart}-${size}`,
          group: "high_entropy",
          label: `High-Entropy Blob (${entropy.toFixed(2)} bits/byte)`,
          offset: blobStart,
          size,
          preview: buf.slice(blobStart, blobStart + 32).toString("hex").slice(0, 64),
          severity: "medium",
        });
        inBlob = false;
      }
    }
  }
  // Close any open blob at end of buffer
  if (inBlob) {
    const size = buf.length - blobStart;
    const entropy = shannonEntropy(buf, blobStart, Math.min(WINDOW_SIZE, size));
    findings.push({
      id: `high_entropy-${blobStart}-${size}`,
      group: "high_entropy",
      label: `High-Entropy Blob (${entropy.toFixed(2)} bits/byte)`,
      offset: blobStart,
      size,
      preview: buf.slice(blobStart, blobStart + 32).toString("hex").slice(0, 64),
      severity: "medium",
    });
  }
  return findings;
}

// ─── Crypto Constants Scanner ─────────────────────────────────────────────────
// Known byte sequences for common crypto primitives
const CRYPTO_CONSTANTS: Array<{ bytes: Buffer; label: string }> = [
  // AES S-Box (first 16 bytes)
  {
    bytes: Buffer.from([0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76]),
    label: "AES S-Box",
  },
  // AES Inverse S-Box (first 16 bytes)
  {
    bytes: Buffer.from([0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb]),
    label: "AES Inverse S-Box",
  },
  // SHA-256 initial hash values (H0-H7, first 8 bytes)
  {
    bytes: Buffer.from([0x6a, 0x09, 0xe6, 0x67, 0xbb, 0x67, 0xae, 0x85]),
    label: "SHA-256 Initial Hash Values",
  },
  // SHA-512 initial hash values (first 8 bytes)
  {
    bytes: Buffer.from([0x6a, 0x09, 0xe6, 0x67, 0xf3, 0xbc, 0xc9, 0x08]),
    label: "SHA-512 Initial Hash Values",
  },
  // MD5 initial state
  {
    bytes: Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]),
    label: "MD5 Initial State",
  },
  // DES S-Box 1 (first 8 bytes)
  {
    bytes: Buffer.from([0x0e, 0x04, 0x0d, 0x01, 0x02, 0x0f, 0x0b, 0x08]),
    label: "DES S-Box",
  },
  // CRC-32 polynomial
  {
    bytes: Buffer.from([0x04, 0xc1, 0x1d, 0xb7]),
    label: "CRC-32 Polynomial",
  },
  // CRC-32C (Castagnoli) polynomial
  {
    bytes: Buffer.from([0x1e, 0xdc, 0x6f, 0x41]),
    label: "CRC-32C Polynomial",
  },
  // Blowfish P-array start
  {
    bytes: Buffer.from([0x24, 0x3f, 0x6a, 0x88, 0x85, 0xa3, 0x08, 0xd3]),
    label: "Blowfish P-Array",
  },
  // RC4 key schedule marker (not a constant but common init pattern)
  // Whirlpool hash initial value
  {
    bytes: Buffer.from([0x19, 0x08, 0x11, 0x09, 0x19, 0x08, 0x11, 0x09]),
    label: "Whirlpool Hash Constant",
  },
];

function scanCryptoConstants(buf: Buffer): KeyFinding[] {
  const findings: KeyFinding[] = [];
  const seen = new Set<string>(); // dedup by label+offset stride

  for (const { bytes, label } of CRYPTO_CONSTANTS) {
    const needle = bytes;
    let pos = 0;
    while (pos < buf.length - needle.length) {
      // Manual search for the byte sequence
      let found = -1;
      for (let i = pos; i <= buf.length - needle.length; i++) {
        let match = true;
        for (let j = 0; j < needle.length; j++) {
          if (buf[i + j] !== needle[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          found = i;
          break;
        }
      }
      if (found === -1) break;

      // Stride-based dedup: skip if we already reported this label within 64 bytes
      const strideKey = `${label}-${Math.floor(found / 64)}`;
      if (!seen.has(strideKey)) {
        seen.add(strideKey);
        findings.push({
          id: `crypto_constant-${found}-${needle.length}`,
          group: "crypto_constant",
          label,
          offset: found,
          size: needle.length,
          preview: buf.slice(found, found + needle.length).toString("hex"),
          severity: "low",
        });
      }
      pos = found + 1;
    }
  }
  return findings;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────
export function scanKeyMaterial(buf: Buffer): KeyFinding[] {
  // Convert buffer to latin-1 string for text-based pattern matching
  const str = buf.toString("latin1");

  const findings: KeyFinding[] = [
    ...scanPEM(str, buf),
    ...scanSSH(str),
    ...scanJWT(str),
    ...scanAPIKeys(str),
    ...scanHighEntropy(buf),
    ...scanCryptoConstants(buf),
  ];

  // Sort by offset ascending
  findings.sort((a, b) => a.offset - b.offset);

  // Deduplicate by id
  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}
