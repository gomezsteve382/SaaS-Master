// AlfaOBD Dotfuscator string decryption.
//
// Ported from `/tmp/aobd/deliverables/alfaobd_decrypt.py` (Python, verified
// against AlfaOBD_PC v2.5.7.0). Algorithm reverse-engineered from
// AlfaOBD.exe's Method[26] `h(string, int)` at RVA 0x5A324.
//
// Algorithm (verbatim from the original IL):
//   key = 0x6DDC67B5 + salt
//   for each 16-bit char in encrypted UTF-16-LE string:
//     dec_lo = enc_lo XOR (key & 0xFF); key++
//     dec_hi = enc_hi XOR (key & 0xFF); key++
//   Output bytes are SWAPPED: [dec_hi, dec_lo] for each char.
//
// Verified by decrypting UserString @0x7E65 -> "+" (matches live IL output).
// Successfully decrypts 2078 of 2079 strings in the v2.5.7.0 #US heap.

const DOTFUSCATOR_BASE_KEY = 0x6ddc67b5;

/**
 * Decrypt a single AlfaOBD Dotfuscator-encrypted string.
 *
 * @param {Uint8Array} encryptedBytes - UTF-16-LE encoded encrypted string bytes.
 * @param {number} salt - The per-string salt (constant in the `h(string, int)` call).
 * @returns {string} The decrypted plaintext.
 */
export function decryptAlfaobdString(encryptedBytes, salt) {
  let key = (DOTFUSCATOR_BASE_KEY + salt) >>> 0;
  const decoded = new Uint8Array(encryptedBytes.length);
  for (let i = 0; i < encryptedBytes.length - 1; i += 2) {
    const lo = encryptedBytes[i];
    const hi = encryptedBytes[i + 1];
    const decLo = (lo ^ (key & 0xff)) & 0xff;
    key = (key + 1) >>> 0;
    const decHi = (hi ^ (key & 0xff)) & 0xff;
    key = (key + 1) >>> 0;
    // Output is byte-swapped from input
    decoded[i] = decHi;
    decoded[i + 1] = decLo;
  }
  // Decode as UTF-16-LE
  const view = new Uint16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength >> 1);
  return String.fromCharCode(...view);
}

/**
 * Brute-force the salt that produces the most printable-ASCII output.
 * Used when call-site salts haven't been extracted from IL.
 *
 * @param {Uint8Array} encryptedBytes
 * @returns {{salt: number, score: number, text: string}}
 */
export function bestSaltDecryption(encryptedBytes) {
  let best = { salt: 0, score: 0, text: "" };
  for (let salt = 0; salt < 256; salt++) {
    const text = decryptAlfaobdString(encryptedBytes, salt);
    let printable = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) {
        printable++;
      }
    }
    const score = text.length > 0 ? printable / text.length : 0;
    if (score > best.score) {
      best = { salt, score, text };
      if (score === 1) break;
    }
  }
  return best;
}

export const ALFAOBD_STRING_DECRYPT_META = {
  decryptStubLocation: "AlfaOBD_PC.exe Method[26] 'h(string, int)' at RVA 0x5A324",
  baseKey: "0x6DDC67B5",
  algorithm: "per-char XOR with (baseKey+salt)&0xFF, key++ per byte, then byte-swap",
  verifiedAgainst: "AlfaOBD_PC v2.5.7.0 (build date 2025-08-24)",
  decryptionRate: "2078 of 2079 strings (99.95%)",
  sourcePort: "/tmp/aobd/deliverables/alfaobd_decrypt.py",
};
