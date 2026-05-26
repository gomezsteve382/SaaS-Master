/**
 * AlfaOBD Seed-Key Algorithms (ES module)
 *
 * Reverse-engineered from AlfaOBD.exe inner .NET binary (Dotfuscator-obfuscated).
 * Methods: ad::ht, ad::f, ad::ao — all byte[4] -> byte[4].
 *
 * See alfaobd_seedkey.py for full notes / caveats.
 */

// All math done with >>> 0 to keep values unsigned 32-bit after shifts.
// No 64-bit math needed; XTEA fits in 32-bit when masked after each op.

const KEY = [0x9B127D51, 0x5BA41903, 0x4FE87269, 0x6BC361D8];
const DELTA = 0x8F750A1D;
const ROUNDS = 64;

/** Simple bit-shuffle seed-key. Triggered by specific ECU name strings. */
export function ht(seed) {
  if (seed.length !== 4) throw new Error('seed must be 4 bytes');
  const [s0, s1, s2, s3] = seed;

  const v2 = (((s1 << 24) | (s0 << 16) | (s3 << 8) | s2) >>> 0);
  let v3 = ((v2 << 11) >>> 0) | (v2 >>> 22);
  v3 = (v3 ^ 0x41AA42BB) >>> 0;

  let v4 = (((s0 << 24) | (s1 << 16) | (s2 << 8) | s3) >>> 0) & 0x22BA9A31;
  v4 = (v4 ^ v3) >>> 0;

  return new Uint8Array([(v4 >>> 24) & 0xFF, (v4 >>> 16) & 0xFF, (v4 >>> 8) & 0xFF, v4 & 0xFF]);
}

function xtea64(v1, v8) {
  let sum = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const inner1 = ((((v8 << 4) >>> 0) ^ (v8 >>> 5)) + v8) >>> 0;
    v1 = (v1 + (inner1 ^ ((sum + KEY[sum & 3]) >>> 0))) >>> 0;
    sum = (sum + DELTA) >>> 0;
    const inner2 = ((((v1 << 4) >>> 0) ^ (v1 >>> 5)) + v1) >>> 0;
    v8 = (v8 + (inner2 ^ ((sum + KEY[(sum >>> 11) & 3]) >>> 0))) >>> 0;
  }
  return [v1, v8];
}

/** XTEA variant. Triggered when af::ix=true, af::ge=51, af::aj=5. */
export function f(seed) {
  if (seed.length !== 4) throw new Error('seed must be 4 bytes');
  const v1_init = (((seed[3] << 24) | (seed[2] << 16) | (seed[1] << 8) | seed[0]) >>> 0); // LE
  const [v1] = xtea64(v1_init, 0);
  return new Uint8Array([(v1 >>> 24) & 0xFF, (v1 >>> 16) & 0xFF, (v1 >>> 8) & 0xFF, v1 & 0xFF]);
}

/** XTEA variant for UCONNECT (eEcutype 0x149) and RADIO_FGA (0x14E) at access level 5. */
export function ao(seed) {
  if (seed.length !== 4) throw new Error('seed must be 4 bytes');
  const v1_init = (((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0); // BE
  const [v1] = xtea64(v1_init, 0);
  return new Uint8Array([(v1 >>> 24) & 0xFF, (v1 >>> 16) & 0xFF, (v1 >>> 8) & 0xFF, v1 & 0xFF]);
}

// Helper: hex string <-> Uint8Array(4)
export const hexToSeed = (h) => {
  const s = h.replace(/[^0-9a-fA-F]/g, '').padStart(8, '0').slice(-8);
  return new Uint8Array([parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16),
                         parseInt(s.slice(4,6),16), parseInt(s.slice(6,8),16)]);
};
export const keyToHex = (k) => Array.from(k).map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
