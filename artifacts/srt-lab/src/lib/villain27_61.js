// ============================================================================
// FCA UDS 0x27 0x61 — CalculateSecurityKey_0x61
//
// Promoted from src/lib/_unverified/villain27_61.candidate.js per the Phase 3
// promotion steps in docs/villain-unpack-workflow.md §3.3. Source intel:
// docs/villain-binary-intel.md §7.
//
// IMPORTANT — S-BOX STATUS
//   The 256-byte FCA_SBox embedded below is still the identity-permutation
//   placeholder. Steps 1–4 of the algorithm are implemented as described in
//   §7.2. Step 5 (S-box substitution) will not produce valid ECU keys until
//   the real S-box is extracted from the unpacked binary and replaces
//   FCA_SBOX_PLACEHOLDER. Because of this, the corresponding ALGOS entry in
//   algos.js is gated behind ENABLE_VILLAIN_0x61 (default false). Do not
//   flip the flag true until the real S-box is in place AND the bench-pair
//   harness in src/lib/_unverified/__tests__/villain27_61.candidate.test.js
//   passes against ≥ 3 real captures.
// ============================================================================

// ─── S-box (256-byte permutation) ─────────────────────────────────────────
//
// TODO: replace this identity placeholder with the real 256-byte FCA_SBox
// extracted from VILLAIN_unpacked.exe. Extraction procedure: see
// docs/villain-unpack-workflow.md §Phase 1 + §Phase 2.
const FCA_SBOX_PLACEHOLDER = new Uint8Array([
  0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0x0C,0x0D,0x0E,0x0F,
  0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19,0x1A,0x1B,0x1C,0x1D,0x1E,0x1F,
  0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x29,0x2A,0x2B,0x2C,0x2D,0x2E,0x2F,
  0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x3A,0x3B,0x3C,0x3D,0x3E,0x3F,
  0x40,0x41,0x42,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4A,0x4B,0x4C,0x4D,0x4E,0x4F,
  0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5A,0x5B,0x5C,0x5D,0x5E,0x5F,
  0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6A,0x6B,0x6C,0x6D,0x6E,0x6F,
  0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7A,0x7B,0x7C,0x7D,0x7E,0x7F,
  0x80,0x81,0x82,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8A,0x8B,0x8C,0x8D,0x8E,0x8F,
  0x90,0x91,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9A,0x9B,0x9C,0x9D,0x9E,0x9F,
  0xA0,0xA1,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,0xA8,0xA9,0xAA,0xAB,0xAC,0xAD,0xAE,0xAF,
  0xB0,0xB1,0xB2,0xB3,0xB4,0xB5,0xB6,0xB7,0xB8,0xB9,0xBA,0xBB,0xBC,0xBD,0xBE,0xBF,
  0xC0,0xC1,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,0xC8,0xC9,0xCA,0xCB,0xCC,0xCD,0xCE,0xCF,
  0xD0,0xD1,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,0xD8,0xD9,0xDA,0xDB,0xDC,0xDD,0xDE,0xDF,
  0xE0,0xE1,0xE2,0xE3,0xE4,0xE5,0xE6,0xE7,0xE8,0xE9,0xEA,0xEB,0xEC,0xED,0xEE,0xEF,
  0xF0,0xF1,0xF2,0xF3,0xF4,0xF5,0xF6,0xF7,0xF8,0xF9,0xFA,0xFB,0xFC,0xFD,0xFE,0xFF,
]);

// ─── CRC-16/CCITT-FALSE helper ────────────────────────────────────────────
// Poly 0x1021, init 0xFFFF, no final XOR. Matches crc16ccitt() in crc.js.
// Inlined so this module is self-contained (mirrors candidate file).
function _crc16ccitt(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      else crc = (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

// ─── CalculateSecurityKey_0x61 ────────────────────────────────────────────
//
// FCA UDS Security Access 0x27 0x61 key derivation. See
// docs/villain-binary-intel.md §7.2 for the full step-by-step description.
//
// Input:  seed  — Uint8Array or number[] of exactly 8 bytes
//                 (from the ECU's 67 61 response, bytes [2..9])
//         sbox  — optional 256-byte Uint8Array; defaults to FCA_SBOX_PLACEHOLDER
// Output: Uint8Array of 8 bytes (the key to send in 27 62)
//
// Throws: TypeError  if seed is not 8 bytes
//                    if sbox is not 256 bytes
export function calculateSecurityKey_0x61(seed, sbox) {
  const s = seed instanceof Uint8Array ? seed : new Uint8Array(seed);
  if (s.length !== 8) {
    throw new TypeError(
      'calculateSecurityKey_0x61: seed must be exactly 8 bytes, got ' + s.length
    );
  }

  const box = sbox instanceof Uint8Array ? sbox : FCA_SBOX_PLACEHOLDER;
  if (box.length !== 256) {
    throw new TypeError('calculateSecurityKey_0x61: sbox must be 256 bytes');
  }

  // Step 1 — Initialize key buffer
  const Key = new Uint8Array(8);
  Key[0] = 0x5A;
  Key[1] = 0xA5;

  // Step 2 — TempSeed permutation (byte reorder + XOR)
  const TempSeed = new Uint8Array(8);
  TempSeed[0] = (s[2] ^ s[5]) & 0xFF;
  TempSeed[1] = (s[0] ^ s[7]) & 0xFF;
  TempSeed[2] = (s[4] ^ s[1]) & 0xFF;
  TempSeed[3] = (s[6] ^ s[3]) & 0xFF;
  TempSeed[4] = (s[1] ^ s[6]) & 0xFF;
  TempSeed[5] = (s[3] ^ s[0]) & 0xFF;
  TempSeed[6] = (s[5] ^ s[2]) & 0xFF;
  TempSeed[7] = (s[7] ^ s[4]) & 0xFF;

  // Step 3 — 4-round mixer
  for (let i = 0; i < 4; i++) {
    Key[2] = (Key[2] + TempSeed[i * 2])     & 0xFF;
    Key[3] = (Key[3] ^ TempSeed[i * 2 + 1]) & 0xFF;
    Key[4] = (Key[4] + Key[2])              & 0xFF;
    Key[5] = (Key[5] ^ Key[3])              & 0xFF;
    Key[6] = (Key[6] + (Key[4] >> 4))       & 0xFF;
    Key[7] = (Key[7] ^ (Key[5] << 4))       & 0xFF;
    Key[0] = (Key[0] + Key[6])              & 0xFF;
    Key[1] = (Key[1] ^ Key[7])              & 0xFF;
  }

  // Step 4 — CRC-16/CCITT over Seed[0..3], XOR into Key[0..1]
  const crc = _crc16ccitt(s.slice(0, 4));
  Key[0] = (Key[0] ^ (crc & 0xFF))        & 0xFF;
  Key[1] = (Key[1] ^ ((crc >> 8) & 0xFF)) & 0xFF;

  // Step 5 — S-box substitution
  for (let j = 0; j < 8; j++) {
    Key[j] = box[Key[j]];
  }

  return Key;
}

// ─── Hex helpers ──────────────────────────────────────────────────────────

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new TypeError('hexToBytes: odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── S-box validation helpers ─────────────────────────────────────────────

export function isBijectiveSbox(sbox) {
  if (!sbox || sbox.length !== 256) return false;
  const seen = new Uint8Array(256);
  for (const b of sbox) {
    if (seen[b]) return false;
    seen[b] = 1;
  }
  return true;
}

export function isSboxPlaceholder(sbox) {
  if (!sbox || sbox.length !== 256) return true;
  for (let i = 0; i < 256; i++) {
    if (sbox[i] !== i) return false;
  }
  return true;
}

export { FCA_SBOX_PLACEHOLDER };
