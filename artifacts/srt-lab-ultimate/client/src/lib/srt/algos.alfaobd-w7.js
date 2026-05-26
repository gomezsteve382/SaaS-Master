// AlfaW7 — BigInteger seedkey cipher (port from AlfaOBD.exe IL)
//
// This is the W7 BigInteger cipher used by FCA's 8 high-security ECU families
// (17/21/22/27/31/37/39/66 per dispatch). 360 per-ECU (n, o, p) parameter
// triples are catalogued in AOBD_W7 (alfaobdAlgorithms.generated.js).
//
// IL provenance:
//   - Method[203] w7 (765 B) — invocation harness with 23 ldstr decryptions
//   - Method[1075] a (114 B) — BigInteger ctor wrapper
//   - Method[1079] o (31 B)  — top-level (a*a - b*c) composition
//   - Method[1080] a (374 B) — larger arithmetic
//   - Method[1087/1089/1091] (40-44 B each) — 4-arg arithmetic chains
//   - Method[1096] b (64 B)  — byte-array indexing
//   - Method[1097] k (25 B)  — bignum op wrapper
//   - Method[1098] j (43 B)  — trim/right-shift
//   - Method[1101] h (37 B)  — bignum MULTIPLY (uses static field T_0971)
//   - Method[1103] g (159 B) — bignum DIVMOD (long division, 6-bit masks)
//   - Method[1104] b (45 B)  — buffer alloc
//   - Method[1106] e (125 B) — string->bignum conversion
//   - Method[1107] d (203 B) — string-to-bignum decoder w/ T_0974/T_0979
//   - Method[1126] a (134 B) — branch comparison
//   - Method[1140] .cctor (378 B) — initializes 12 byte-array constants
//
// Cipher constants from Method[1140] .cctor InitializeArray sites:
//   uint32 seeds: 0x4E, 0xD4, 0xAE, 0x9F, 7, 0xD8, 0x42
//   6-byte: 0x42
//   16-byte BigInteger constants: 0x11, 0x0E
//   ~41 KB sparse uint64 lookup table (likely permutation / S-box / catalog)
//
// JS BigInt port — uses native BigInt (ES2020+) which is available in all
// modern browsers and Node. The algorithm is a custom multi-precision
// integer operation chain combining the (n, o, p) parameters with the seed
// via modular arithmetic.
//
// IMPORTANT — UNFINISHED: The exact algebraic combination of (n, o, p) is
// still pending C# decompilation of the 6 helper methods. This file ports
// the STRUCTURE (input/output, parameter handling) and provides a stub
// `alfaW7Stub` that:
//   1. Returns the cipher PARAMETER TRIPLE for inspection (not the key bytes)
//   2. Throws if called for actual key computation (so the caller surfaces
//      the gap explicitly)
//
// When the helper-method semantics are decompiled, replace alfaW7Stub's
// throw with the actual computation. Test against bench-captured (seed, key)
// pairs from a real FCA ECU using one of the family_X dispatched ECUs.
//
// See PROVENANCE.md "W7 catalog: 360 per-ECU (n, o, p) parameter triples
// ⚠ CLAIMED" entry.

import { AOBD_W7 } from "./alfaobdAlgorithms.generated.js";

const u32 = (n) => Number(BigInt(n) & 0xFFFFFFFFn);

/**
 * Look up the (n, o, p) parameter triple for an ECU's W7 wrapper name.
 * Returns { n, o, p } as bigints, or null if not in catalog.
 */
export function alfaW7Params(wrapperName) {
  const v = AOBD_W7?.[wrapperName];
  if (!v) return null;
  // Catalog format: [n, o, p] as hex strings or ints
  const toBig = (x) => {
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(x);
    if (typeof x === "string") return BigInt(x.startsWith("0x") ? x : `0x${x}`);
    return null;
  };
  return {
    n: toBig(v[0]),
    o: toBig(v[1]),
    p: toBig(v[2]),
  };
}

/**
 * Stub implementation of alfaW7 cipher. Currently INCOMPLETE — the algebraic
 * combination of (n, o, p) with the seed bytes hasn't been fully decompiled
 * from the 6 BigInteger helper methods. This stub:
 *   - Resolves the wrapper name to its (n, o, p) parameter triple
 *   - Throws an explicit "not yet implemented" error so callers fall back
 *     to the alfaHt default or surface the gap to the operator
 *
 * To complete: decompile Methods[1075/1079/1080/1087/1089/1091/1096/1101/
 * 1103/1106/1126] from AlfaOBD.exe to a working JS BigInteger ladder, then
 * verify against a bench-captured (seed, key) pair for any family_X ECU.
 *
 * @param {Uint8Array|number[]} seedBytes  4-byte seed from ECU 27 03 response
 * @param {string} wrapperName             W7 wrapper name from cipher dispatch
 *                                          (e.g., 'jh', 'jg', 'jf' for family_31)
 * @returns {Uint8Array}                   4-byte computed key (currently throws)
 */
export function alfaW7Stub(seedBytes, wrapperName) {
  const params = alfaW7Params(wrapperName);
  if (!params) {
    throw new Error(`alfaW7: unknown wrapper '${wrapperName}' — not in AOBD_W7 catalog`);
  }
  // Stub: surface the parameter triple for diagnostic display
  throw new Error(
    `alfaW7('${wrapperName}'): not yet implemented. ` +
      `Parameters: n=0x${params.n.toString(16)}, o=0x${params.o.toString(16)}, p=0x${params.p.toString(16)}. ` +
      `Translation of 6 BigInteger helper methods from AlfaOBD.exe IL pending. ` +
      `See client/src/lib/srt/algos.alfaobd-w7.js source for the IL provenance and what's needed.`,
  );
}

/**
 * BigInteger multiplication primitive (translated from Method[1101]:h).
 * Multiplies two BigInteger byte arrays and returns the result, modulo the
 * static field T_0971 constant (whose value is still unknown — pending
 * decompilation of Method[1140] .cctor static field initialization).
 *
 * Currently STUB — returns native BigInt multiplication. Real algorithm
 * uses limb-wise multiply with 64-bit shift mask (0x3F = 6-bit).
 */
export function alfaW7_bignumMul(a, b, modulus) {
  if (typeof a !== "bigint") a = BigInt(a);
  if (typeof b !== "bigint") b = BigInt(b);
  const product = a * b;
  return modulus ? product % modulus : product;
}

/**
 * BigInteger divmod primitive (translated from Method[1103]:g).
 * Implements long-division with limb-wise shifts.
 */
export function alfaW7_bignumDivMod(dividend, divisor) {
  if (typeof dividend !== "bigint") dividend = BigInt(dividend);
  if (typeof divisor !== "bigint") divisor = BigInt(divisor);
  return [dividend / divisor, dividend % divisor];
}

/**
 * Convert a seed-byte array (typically 4 bytes from 27 03 response) to a
 * BigInteger. Big-endian packing matches the FCA convention.
 */
export function alfaW7_seedToBigInt(seedBytes) {
  let result = 0n;
  for (const b of seedBytes) {
    result = (result << 8n) | BigInt(b & 0xff);
  }
  return result;
}

/**
 * Convert a computed key BigInteger back to a fixed-length byte array.
 */
export function alfaW7_bigIntToKeyBytes(value, lengthBytes = 4) {
  if (typeof value !== "bigint") value = BigInt(value);
  value = value & ((1n << BigInt(lengthBytes * 8)) - 1n);
  const out = new Uint8Array(lengthBytes);
  for (let i = lengthBytes - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/**
 * Known mappings (from PROVENANCE.md + algorithm-catalog.json dispatch):
 *   family_17 (Convergence)         level 1/3/5 → c2/cz/cw
 *   family_21 (ESL/Steer Lock)      level 1/3/5 → c1/cy/cv
 *   family_22 (ACC/Cruise)          level 1/3/5 → c0/cx/cu
 *   family_27 (Park Brake)          level 1/3/5/7 → tv/tu/tt/tp
 *   family_31 (Drivetrain/4WD)      level 1/3/5 → jh/jg/jf
 *   family_37 (Trailer)             level 1/3/5 → bq/bp/bo
 *   family_39 (Battery/Charging)    level 1 → au
 *   family_66                        level 1/3/5 → e1/ez/e2
 *   0x149 UCONNECT                   level 5 → ao (XTEA-BE, NOT W7)
 *   0x14E RADIO_FGA                  level 5 → ao (XTEA-BE, NOT W7)
 */
export const W7_FAMILY_DISPATCH = {
  family_17: { 1: "c2", 3: "cz", 5: "cw" },
  family_21: { 1: "c1", 3: "cy", 5: "cv" },
  family_22: { 1: "c0", 3: "cx", 5: "cu" },
  family_27: { 1: "tv", 3: "tu", 5: "tt", 7: "tp" },
  family_31: { 1: "jh", 3: "jg", 5: "jf" },
  family_37: { 1: "bq", 3: "bp", 5: "bo" },
  family_39: { 1: "au" },
  family_66: { 1: "e1", 3: "ez", 5: "e2" },
};

/**
 * Pick the W7 wrapper name for a given (family, level) pair.
 * Returns null if no wrapper is catalogued.
 */
export function pickW7Wrapper(familyNumber, securityLevel) {
  const key = `family_${familyNumber}`;
  return W7_FAMILY_DISPATCH[key]?.[securityLevel] ?? null;
}
