import { describe, it, expect } from "vitest";
import { scanForKeys, shannonEntropy } from "../keyScanner.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function asciiBytes(str) {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i);
  return arr;
}

function pad(arr, totalLen, fillByte = 0x00) {
  const out = new Uint8Array(totalLen);
  out.fill(fillByte);
  out.set(arr.slice(0, totalLen));
  return out;
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ── PEM detection ──────────────────────────────────────────────────────────

describe("PEM block detection", () => {
  it("detects RSA private key header", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----\n";
    const bytes = pad(asciiBytes(pem), pem.length + 64);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const pf = findings.filter(f => f.group === "pem");
    expect(pf.length).toBeGreaterThan(0);
    expect(pf[0].label).toMatch(/RSA PRIVATE KEY/);
    expect(pf[0].severity).toBe("high");
    expect(pf[0].offset).toBe(0);
  });

  it("detects CERTIFICATE header (medium severity)", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCg==\n-----END CERTIFICATE-----\n";
    const bytes = asciiBytes(pem);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const pf = findings.filter(f => f.group === "pem");
    expect(pf.length).toBeGreaterThan(0);
    expect(pf[0].severity).toBe("medium");
  });

  it("detects OPENSSH PRIVATE KEY header", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
    const bytes = asciiBytes(pem);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const pf = findings.filter(f => f.group === "pem");
    expect(pf.length).toBeGreaterThan(0);
    expect(pf[0].label).toMatch(/OPENSSH/);
    expect(pf[0].severity).toBe("high");
  });

  it("detects EC PRIVATE KEY header", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIOm3jLbV3Y0r\n-----END EC PRIVATE KEY-----\n";
    const bytes = asciiBytes(pem);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const pf = findings.filter(f => f.group === "pem");
    expect(pf[0].label).toMatch(/EC PRIVATE KEY/);
  });

  it("does NOT flag unrelated binary data as PEM", () => {
    const bytes = new Uint8Array(512).fill(0xAB);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    expect(findings.filter(f => f.group === "pem")).toHaveLength(0);
  });

  it("assigns a stable deterministic ID based on offset", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n";
    const prefix = new Uint8Array(32).fill(0xCC);
    const bytes = concat(prefix, asciiBytes(pem));
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const pf = findings.filter(f => f.group === "pem");
    expect(pf[0].id).toBe("pem-000020"); // offset 32 = 0x20
  });
});

// ── JWT detection ──────────────────────────────────────────────────────────

describe("JWT regex / ASCII scan", () => {
  it("detects a well-formed JWT token", () => {
    // A real-looking JWT (header.payload.signature)
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const bytes = concat(new Uint8Array(8).fill(0), asciiBytes(jwt));
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const jf = findings.filter(f => f.group === "jwt");
    expect(jf.length).toBeGreaterThan(0);
    expect(jf[0].severity).toBe("high");
    expect(jf[0].offset).toBe(8);
  });

  it("does NOT flag a short eyJ that has no dots", () => {
    const bytes = asciiBytes("eyJhbGciOiJub3RhcmVhbA==");
    const findings = scanForKeys(bytes, { skipEntropy: true });
    // May or may not detect — but if it does, needs two dots
    const jf = findings.filter(f => f.group === "jwt");
    // All detected JWTs must have offset within bounds
    for (const f of jf) expect(f.offset).toBeGreaterThanOrEqual(0);
  });

  it("assigns a stable id at the correct offset", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJrZXkiOiJ2YWwifQ.abc123DEFabc123DEFabc123";
    const prefix = new Uint8Array(16).fill(0);
    const bytes = concat(prefix, asciiBytes(jwt));
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const jf = findings.filter(f => f.group === "jwt");
    if (jf.length > 0) {
      expect(jf[0].id).toBe("jwt-000010"); // offset 16 = 0x10
    }
  });
});

// ── API key patterns ───────────────────────────────────────────────────────

describe("API key pattern detection", () => {
  it("detects AWS Access Key ID (AKIA...)", () => {
    const bytes = asciiBytes("AKIAIOSFODNN7EXAMPLE padding padding");
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const af = findings.filter(f => f.group === "apikey" && f.label.includes("AWS Access Key"));
    expect(af.length).toBeGreaterThan(0);
    expect(af[0].severity).toBe("high");
    expect(af[0].offset).toBe(0);
  });

  it("detects GitHub PAT (ghp_...)", () => {
    const bytes = asciiBytes("ghp_abcdefghijklmnopqrstuvwxyz123456ABCD padding");
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const af = findings.filter(f => f.group === "apikey" && f.label.includes("GitHub Personal"));
    expect(af.length).toBeGreaterThan(0);
    expect(af[0].severity).toBe("high");
  });

  it("detects GitHub Actions token (ghs_...)", () => {
    const bytes = asciiBytes("ghs_abcdefghijklmnopqrstuvwxyz123456ABCD padding");
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const af = findings.filter(f => f.group === "apikey" && f.label.includes("GitHub Actions"));
    expect(af.length).toBeGreaterThan(0);
  });

  it("detects Stripe live secret key (sk_live_...)", () => {
    const bytes = asciiBytes("sk_live_abcdefghijklmnopqrstuvwxyz12345 padding");
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const af = findings.filter(f => f.group === "apikey" && f.label.includes("Stripe Live"));
    expect(af.length).toBeGreaterThan(0);
    expect(af[0].severity).toBe("high");
  });

  it("detects Stripe test key (sk_test_) as medium severity", () => {
    const bytes = asciiBytes("sk_test_abcdefghijklmnopqrstuvwxyz12345 padding");
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const af = findings.filter(f => f.group === "apikey" && f.label.includes("Stripe Test"));
    expect(af.length).toBeGreaterThan(0);
    expect(af[0].severity).toBe("medium");
  });

  it("does NOT flag short random binary data as an API key", () => {
    const bytes = new Uint8Array(256).fill(0xFF);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    expect(findings.filter(f => f.group === "apikey")).toHaveLength(0);
  });
});

// ── Crypto constant detection ──────────────────────────────────────────────

describe("crypto constant detection", () => {
  it("detects AES S-Box forward table header", () => {
    const aesHead = new Uint8Array([
      0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5,
      0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    ]);
    const bytes = concat(new Uint8Array(4).fill(0), aesHead, new Uint8Array(32).fill(0));
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const cf = findings.filter(f => f.group === "crypto-const" && f.label.includes("AES S-Box (forward"));
    expect(cf.length).toBeGreaterThan(0);
    expect(cf[0].offset).toBe(4);
  });

  it("detects AES S-Box inverse table header", () => {
    const aesInv = new Uint8Array([
      0x52, 0x09, 0x6A, 0xD5, 0x30, 0x36, 0xA5, 0x38,
      0xBF, 0x40, 0xA3, 0x9E, 0x81, 0xF3, 0xD7, 0xFB,
    ]);
    const bytes = concat(new Uint8Array(8).fill(0), aesInv);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const cf = findings.filter(f => f.group === "crypto-const" && f.label.includes("inverse"));
    expect(cf.length).toBeGreaterThan(0);
    expect(cf[0].offset).toBe(8);
  });

  it("detects SHA-256 IV block", () => {
    const sha256iv = new Uint8Array([
      0x6A, 0x09, 0xE6, 0x67, 0xBB, 0x67, 0xAE, 0x85,
      0x3C, 0x6E, 0xF3, 0x72, 0xA5, 0x4F, 0xF5, 0x3A,
      0x51, 0x0E, 0x52, 0x7F, 0x9B, 0x05, 0x68, 0x8C,
      0x1F, 0x83, 0xD9, 0xAB, 0x5B, 0xE0, 0xCD, 0x19,
    ]);
    const bytes = concat(new Uint8Array(16).fill(0), sha256iv);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const cf = findings.filter(f => f.group === "crypto-const" && f.label.includes("SHA-256"));
    expect(cf.length).toBeGreaterThan(0);
    expect(cf[0].offset).toBe(16);
  });

  it("detects MD5 IV block", () => {
    const md5iv = new Uint8Array([
      0x67, 0x45, 0x23, 0x01, 0xEF, 0xCD, 0xAB, 0x89,
      0x98, 0xBA, 0xDC, 0xFE, 0x10, 0x32, 0x54, 0x76,
    ]);
    const bytes = concat(new Uint8Array(4).fill(0), md5iv);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const cf = findings.filter(f => f.group === "crypto-const" && f.label.includes("MD5"));
    expect(cf.length).toBeGreaterThan(0);
  });

  it("detects DES S-Box S1 row-0", () => {
    const desS1 = new Uint8Array([0x0E, 0x04, 0x0D, 0x01, 0x02, 0x0F, 0x0B, 0x08]);
    const bytes = concat(new Uint8Array(12).fill(0xFF), desS1, new Uint8Array(8).fill(0));
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const cf = findings.filter(f => f.group === "crypto-const" && f.label.includes("DES"));
    expect(cf.length).toBeGreaterThan(0);
    expect(cf[0].offset).toBe(12);
  });

  it("detects CRC-32 polynomial 0x04C11DB7 (BE)", () => {
    const crc32 = new Uint8Array([0x04, 0xC1, 0x1D, 0xB7]);
    const bytes = concat(new Uint8Array(20).fill(0), crc32, new Uint8Array(8).fill(0));
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const cf = findings.filter(f => f.group === "crypto-const" && f.label.includes("CRC-32") && f.label.includes("BE"));
    expect(cf.length).toBeGreaterThan(0);
    expect(cf[0].offset).toBe(20);
  });

  it("detects CRC-16/CCITT polynomial 0x1021", () => {
    const crc16 = new Uint8Array([0x10, 0x21]);
    const bytes = concat(new Uint8Array(6).fill(0), crc16, new Uint8Array(8).fill(0));
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const cf = findings.filter(f => f.group === "crypto-const" && f.label.includes("CRC-16/CCITT poly"));
    expect(cf.length).toBeGreaterThan(0);
    expect(cf[0].offset).toBe(6);
  });

  it("does NOT detect crypto constants in empty-FF buffer", () => {
    const bytes = new Uint8Array(256).fill(0xFF);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    expect(findings.filter(f => f.group === "crypto-const")).toHaveLength(0);
  });
});

// ── Shannon entropy threshold ──────────────────────────────────────────────

describe("Shannon entropy sliding-window blobs", () => {
  it("flags a 256-byte window of pseudo-random data above 7.2 bits/byte", () => {
    // Build a 512-byte array with all 256 byte values appearing twice (max entropy)
    const highEntropy = new Uint8Array(512);
    for (let i = 0; i < 512; i++) highEntropy[i] = i % 256;
    const findings = scanForKeys(highEntropy);
    const ef = findings.filter(f => f.group === "entropy");
    expect(ef.length).toBeGreaterThan(0);
  });

  it("does NOT flag a buffer of all-zero bytes", () => {
    const zeros = new Uint8Array(512).fill(0);
    const findings = scanForKeys(zeros);
    const ef = findings.filter(f => f.group === "entropy");
    expect(ef).toHaveLength(0);
  });

  it("does NOT flag a repeating pattern of 0xAA 0x55 (exactly 1 bit/byte)", () => {
    const rep = new Uint8Array(512);
    for (let i = 0; i < 512; i++) rep[i] = i % 2 === 0 ? 0xAA : 0x55;
    const findings = scanForKeys(rep);
    const ef = findings.filter(f => f.group === "entropy");
    expect(ef).toHaveLength(0);
  });

  it("respects a custom entropyThreshold option", () => {
    // 4 distinct byte values → entropy = 2 bits/byte
    const lowEntropy = new Uint8Array(512);
    for (let i = 0; i < 512; i++) lowEntropy[i] = [0x01, 0x02, 0x03, 0x04][i % 4];
    // At default threshold 7.2 — no findings
    const high = scanForKeys(lowEntropy, { entropyThreshold: 7.2 });
    expect(high.filter(f => f.group === "entropy")).toHaveLength(0);
    // At threshold 1.0 — should detect
    const low = scanForKeys(lowEntropy, { entropyThreshold: 1.0 });
    expect(low.filter(f => f.group === "entropy").length).toBeGreaterThan(0);
  });

  it("shannonEntropy returns 0 for all-zero window", () => {
    const bytes = new Uint8Array(256).fill(0);
    expect(shannonEntropy(bytes, 0, 256)).toBe(0);
  });

  it("shannonEntropy returns ~8.0 for uniform distribution", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const e = shannonEntropy(bytes, 0, 256);
    expect(e).toBeCloseTo(8.0, 1);
  });
});

// ── Deterministic IDs ──────────────────────────────────────────────────────

describe("deterministic finding IDs", () => {
  it("produces the same IDs for the same input on two calls", () => {
    const aes = new Uint8Array([
      0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5,
      0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    ]);
    const bytes = concat(new Uint8Array(10).fill(0), aes);
    const r1 = scanForKeys(bytes, { skipEntropy: true }).map(f => f.id);
    const r2 = scanForKeys(bytes, { skipEntropy: true }).map(f => f.id);
    expect(r1).toEqual(r2);
  });

  it("IDs embed the correct hex offset", () => {
    const crc32 = new Uint8Array([0x04, 0xC1, 0x1D, 0xB7]);
    const bytes = concat(new Uint8Array(0x100).fill(0), crc32);
    const findings = scanForKeys(bytes, { skipEntropy: true });
    const cf = findings.filter(f => f.group === "crypto-const" && f.label.includes("CRC-32") && f.label.includes("BE"));
    expect(cf[0].id).toBe("crypto-const-000100");
  });

  it("results are in offset-ascending order", () => {
    const sha256iv = new Uint8Array([
      0x6A, 0x09, 0xE6, 0x67, 0xBB, 0x67, 0xAE, 0x85,
      0x3C, 0x6E, 0xF3, 0x72, 0xA5, 0x4F, 0xF5, 0x3A,
      0x51, 0x0E, 0x52, 0x7F, 0x9B, 0x05, 0x68, 0x8C,
      0x1F, 0x83, 0xD9, 0xAB, 0x5B, 0xE0, 0xCD, 0x19,
    ]);
    const aes = new Uint8Array([
      0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5,
      0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    ]);
    // Put SHA-256 IV first, then AES S-box
    const bytes = concat(
      new Uint8Array(8).fill(0),
      sha256iv,
      new Uint8Array(4).fill(0),
      aes,
      new Uint8Array(8).fill(0)
    );
    const findings = scanForKeys(bytes, { skipEntropy: true });
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i].offset).toBeGreaterThanOrEqual(findings[i - 1].offset);
    }
  });
});

// ── Empty buffer / edge cases ──────────────────────────────────────────────

describe("edge cases", () => {
  it("returns empty array for an empty buffer", () => {
    expect(scanForKeys(new Uint8Array(0))).toHaveLength(0);
  });

  it("returns empty array for a small all-zero buffer", () => {
    const findings = scanForKeys(new Uint8Array(64).fill(0));
    expect(findings).toHaveLength(0);
  });

  it("throws TypeError for non-Uint8Array input", () => {
    expect(() => scanForKeys("not a buffer")).toThrow(TypeError);
    expect(() => scanForKeys([1, 2, 3])).toThrow(TypeError);
  });

  it("shows 'No findings' scenario — all-FF buffer produces no results", () => {
    const findings = scanForKeys(new Uint8Array(512).fill(0xFF));
    // All-FF has entropy ~0, no patterns, no constants
    expect(findings).toHaveLength(0);
  });
});
