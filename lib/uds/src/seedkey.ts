/**
 * FCA / Stellantis SecurityAccess (0x27) seed→key algorithms.
 *
 * Pure TypeScript ports of the byte-verified Python implementations in
 * `tools/python-bridge/tools/canflash_seedkey.py`, each reversed from the
 * factory unlock DLL and cross-checked against Unicorn emulation.
 *
 * Every algorithm here is proven byte-identical to the Python source of truth
 * by `src/__tests__/seedkey.test.ts`, which replays the golden vectors in
 * `src/__tests__/unlock_vectors.generated.json` (regenerate with
 * `lib/uds/scripts/gen_unlock_vectors.py`). Anchored DLL self-test vectors
 * (e.g. huntsville_bcm(0x1234)=0x526C) make that transitively DLL-correct.
 *
 * Use this instead of the ad-hoc `algos.js` guesses in the SRT-lab frontend:
 * those (cda6/sxor) do NOT match the factory algorithms and return NRC 0x35.
 *
 *   import { unlockByModule } from '@workspace/uds';
 *   const key = unlockByModule('BCM', seed);            // 16-bit modules
 *   const key = unlockByModule('PCM_GPEC', seedDword);  // 32-bit modules
 *   const key = unlockByModule('RAK', seedLo, seedHi);  // 2-arg modules
 *
 * Keys are returned as unsigned numbers. 16-bit-keyed modules return a value
 * ≤ 0xFFFF; the rest return a 32-bit unsigned value. Callers serialize to the
 * byte width the module expects (usually the seed width).
 */

// ─── width helpers ────────────────────────────────────────────────────
const u16 = (x: number): number => x & 0xffff;
const u32 = (x: number): number => x >>> 0;

const ror16 = (x: number, n: number): number => {
  x &= 0xffff;
  n &= 15;
  return n ? ((x >>> n) | (x << (16 - n))) & 0xffff : x;
};
const rol16 = (x: number, n: number): number => {
  x &= 0xffff;
  n &= 15;
  return n ? ((x << n) | (x >>> (16 - n))) & 0xffff : x;
};

/** 32-bit unsigned multiply (BigInt-backed to avoid float precision loss). */
const mul32 = (a: number, b: number): number =>
  Number((BigInt(a >>> 0) * BigInt(b >>> 0)) & 0xffffffffn) >>> 0;

/** XOR of T[(x>>>shift)&7] over the given shifts (the common 5-tap T8 core). */
const t8 = (T: readonly number[], x: number, ...shifts: number[]): number => {
  let v = 0;
  for (const sh of shifts) v ^= T[(x >>> sh) & 7];
  return v & 0xffff;
};

export type UnlockFn = (seed: number, seedHi?: number) => number;

// ═══════════════════════════════════════════════════════════════════════
// T8-XOR family — 16-bit, 5-tap table XOR ± rotation
// ═══════════════════════════════════════════════════════════════════════

const T_BCM = [0x9c8e, 0x4cc1, 0xd3c2, 0xe7ec, 0x5feb, 0xca78, 0x432e, 0x1ffa];
export const unlock_huntsville_bcm: UnlockFn = (seed) => {
  const s = u16(seed);
  return (t8(T_BCM, s, 10, 7, 4, 13, 0) ^ s ^ 0x64d1) & 0xffff;
};

const T_YAZAKI = [0x4f44, 0xcaac, 0x005a, 0x5a10, 0x92c8, 0x8dff, 0xa1b6, 0x7973];
export const unlock_yazaki_fcm: UnlockFn = (seed) => {
  const s = u16(seed);
  const c = (((s >> 1) & 0x20) | (s & 0x18)) >> 3;
  let v = T_YAZAKI[s & 7] ^ T_YAZAKI[c & 7] ^ T_YAZAKI[(s >> 7) & 7] ^ T_YAZAKI[(s >> 10) & 7] ^ T_YAZAKI[(s >> 13) & 7];
  return (v ^ s ^ 0x632a) & 0xffff;
};

const T_TIPM7 = [0x33e2, 0x6ef0, 0x552d, 0x865a, 0xbbcf, 0xbf62, 0xd4ee, 0x127f];
export const unlock_motorola_tipm7: UnlockFn = (seed) => {
  const orig = u16(seed);
  const s = ror16(orig, 1);
  return (t8(T_TIPM7, s, 12, 9, 6, 3, 0) ^ orig ^ 0x9736) & 0xffff;
};

const T_TRW_ABS = [0xf382, 0xce9d, 0x35af, 0x426c, 0x4863, 0xf941, 0x751d, 0xeadf];
export const unlock_trw_abs: UnlockFn = (seed) => {
  const orig = u16(seed);
  const s = ror16(orig, 3);
  return (t8(T_TRW_ABS, s, 12, 9, 6, 3, 0) ^ orig ^ 0xa59b) & 0xffff;
};

const T_NGC_ENG = [0x8a4f, 0x5245, 0x9308, 0xd997, 0xf4f5, 0xe324, 0xc76f, 0x5535];
export const unlock_ngc_engine: UnlockFn = (seed) => {
  const orig = u16(seed);
  const s = ror16(orig, 1);
  return (t8(T_NGC_ENG, s, 10, 7, 3, 13, 0) ^ orig ^ 0x537e) & 0xffff;
};

const T_NGC_TRANS = [0x9d9f, 0xce48, 0xb0f3, 0xd99b, 0xa720, 0xfdd6, 0x836d, 0x6f8e];
export const unlock_ngc_transmission: UnlockFn = (seed) => {
  const orig = u16(seed);
  const s = ror16(orig, 4);
  return (t8(T_NGC_TRANS, s, 10, 7, 4, 1, 13) ^ orig ^ 0x1ea4) & 0xffff;
};

const T_VENOM = [0x7431, 0x1e6d, 0x02ea, 0xf917, 0xac52, 0x377b, 0x21e2, 0xca48];
export const unlock_venom_pcm: UnlockFn = (seed) => {
  const orig = u16(seed);
  const c = ror16(orig, 3);
  return (t8(T_VENOM, c, 11, 6, 2, 0, 9) ^ orig ^ 0xab56) & 0xffff;
};

const T_ITM = [0x4398, 0x7421, 0xc1ab, 0x36dd, 0x508a, 0x9bf6, 0x638e, 0x1409];
export const unlock_may_scofield_itm: UnlockFn = (seed) => {
  const orig = u16(seed);
  const s = ror16(orig, 2);
  return (t8(T_ITM, s, 13, 10, 7, 3, 0) ^ orig ^ 0x2465) & 0xffff;
};

const T_RADIO = [0x715f, 0x36bd, 0x2e05, 0xaa38, 0x8952, 0x1fdc, 0x6255, 0xe379];
export const unlock_huntsville_radio: UnlockFn = (seed) => {
  const s = u16(seed);
  return (t8(T_RADIO, s, 0, 4, 7, 10, 13) ^ s ^ 0xca59) & 0xffff;
};

// CCN family — note these XOR the *full* seed (32-bit) in the verified globals.
const T_HB_CCN = [0xba37, 0x8c2b, 0x6129, 0xef20, 0xa899, 0xf03b, 0x22b0, 0x4fa9];
export const unlock_HB_ccn: UnlockFn = (seed) => {
  const s = u16(seed);
  return u32(t8(T_HB_CCN, s, 13, 10, 7, 4, 0) ^ seed ^ 0x93f5);
};

const T_LX_CCN = [0x2543, 0xecf8, 0x61d9, 0x17ab, 0x3f42, 0xc9e5, 0x7d8a, 0x9643];
export const unlock_LX_ccn: UnlockFn = (seed) => {
  const s = u16(seed);
  return u32(t8(T_LX_CCN, s, 13, 10, 7, 4, 0) ^ s ^ 0x7e5f);
};

const T_NIPPON_CCN = [0x8e07, 0x8c44, 0x4f33, 0x9e95, 0x222c, 0x0d2a, 0x3787, 0x557b];
export const unlock_nippon_ccn: UnlockFn = (seed) => {
  const s = u16(seed);
  return u32(t8(T_NIPPON_CCN, s, 12, 9, 6, 3, 0) ^ seed ^ 0x70e8);
};

const T_NGC4 = [0x8a4f, 0x5245, 0x9308, 0xd997, 0xf4f5, 0xe324, 0xc76f, 0x5535];
export const unlock_ngc4_trans: UnlockFn = (seed) => {
  const s = u16(seed);
  const sr = ror16(s, 1);
  return (t8(T_NGC4, sr, 0, 3, 7, 10, 13) ^ s ^ 0x537e) & 0xffff;
};

const T_OCM = [0x8e1d, 0xeada, 0x184b, 0x4507, 0xb6b4, 0x75df, 0xc3f0, 0xa2c6];
export const unlock_ocm: UnlockFn = (seed) => {
  const s = u16(seed);
  const c = ror16(s, 2);
  return u32(t8(T_OCM, c, 10, 7, 4, 13, 0) ^ seed ^ 0xc657);
};
export const unlock_trw_ocm = unlock_ocm;

const T_TRW_ORC = [0x71e2, 0x1525, 0xe7b4, 0xbaf8, 0x494b, 0x8a20, 0x3c0f, 0x5d39];
export const unlock_trw_orc: UnlockFn = (seed) => {
  const s = u16(seed);
  const c = ror16(s, 2);
  return u32(t8(T_TRW_ORC, c, 10, 7, 4, 13, 0) ^ seed ^ 0xc657);
};

// ASBS / FDCM share a 4-tap T8.
const T_ASBS = [0xb590, 0xf8a2, 0xae93, 0x1821, 0xdd25, 0xc672, 0xf85a, 0x4870];
const asbsFdcm: UnlockFn = (seed) => {
  const s = u16(seed);
  return u32(t8(T_ASBS, s, 13, 10, 4, 0) ^ seed ^ 0xec70);
};
export const unlock_asbs = asbsFdcm;
export const unlock_fdcm = asbsFdcm;

// pdm.dll / ddm.dll (distinct from the Bosch family) — packed first index.
const T_PDM = [0x191c, 0xcd5f, 0xd7fb, 0x91d9, 0x6528, 0x8b3a, 0x63c6, 0x7473];
export const unlock_pdm: UnlockFn = (seed) => {
  const s = u16(seed);
  const sf = u32(seed);
  const iD = ((sf >>> 13) & 6) | ((sf >>> 12) & 1);
  let v = T_PDM[iD];
  v ^= T_PDM[(sf >>> 9) & 7];
  v ^= T_PDM[(sf >>> 6) & 7];
  v ^= T_PDM[(s >> 3) & 7];
  v ^= T_PDM[s & 7];
  return u32(v ^ seed ^ 0xe8c5);
};
export const unlock_ddm = unlock_pdm;

// ═══════════════════════════════════════════════════════════════════════
// T16 GF(2) — bit-indexed table XOR
// ═══════════════════════════════════════════════════════════════════════

const T_BOSCH_ABS = [
  0x9e19, 0x60eb, 0xfd80, 0xdbf2, 0x456b, 0x90d0, 0xeb54, 0xbe6a,
  0x356e, 0x76d5, 0xe11c, 0xadcf, 0x1a72, 0x0afb, 0x91da, 0x4d04,
];
export const unlock_bosch_abs: UnlockFn = (seed) => {
  const s = u16(seed);
  let v = 0;
  for (let bit = 0; bit < 16; bit++) if (s & (1 << bit)) v ^= T_BOSCH_ABS[bit];
  return v & 0xffff;
};

export const unlock_lrsm: UnlockFn = (seed) => {
  const s = u16(seed);
  let edx = s & 0xffffff7f;
  let eax = (s >> 7) & 1;
  edx ^= 0xf000;
  edx = edx >>> 7;
  let ecx = s ^ 0xf;
  eax = u32(eax + edx);
  ecx = u32(ecx << 9);
  return u32(eax + ecx);
};

const T_CUMMINS = [
  0x1ce32951, 0x8bb28c39, 0x76c6da1a, 0xe0b69a47, 0xf356024c, 0x60af852b,
  0x63a12ac7, 0x53ff8daf, 0xa8f7e36c, 0x63e92252, 0x2cd56fe4, 0x2e3ef306,
  0x5b0a976f, 0xdb6cfa03, 0x19ccb5a4, 0x8113b235,
];
export const unlock_cummins_849: UnlockFn = (seed) => {
  const s = u32(seed);
  const idx = (s >>> 20) & 0xf;
  let v = 0;
  for (const o of [0, 1, 2, 3]) v ^= T_CUMMINS[(idx + o) & 0xf];
  v ^= u32(s + 0x55111511);
  return u32(v);
};

// ═══════════════════════════════════════════════════════════════════════
// LCG-pair family — Park-Miller LCG, ((seed*MUL+ADD) ^ ADD ^ CONST)
// ═══════════════════════════════════════════════════════════════════════

const lcgPair = (seed: number, mul: number, add: number, konst: number): number => {
  const t = (BigInt(seed >>> 0) * BigInt(mul) + BigInt(add)) & 0xffffffffn;
  return Number(t ^ BigInt(add) ^ BigInt(konst >>> 0)) >>> 0;
};
export const unlock_abs: UnlockFn = (seed) => lcgPair(seed, 0x41c64e6d, 0x3039, 0xac15df76);
export const unlock_hella_acc: UnlockFn = (seed) => lcgPair(seed, 0x41c64e6d, 0x3039, 0x80831279);
export const unlock_msmd: UnlockFn = (seed) => lcgPair(seed, 0x41c64e6d, 0x3039, 0x4b);
export const unlock_teves_abs: UnlockFn = (seed) => lcgPair(seed, 0x41c64e6d, 0x3039, 0xff);
export const unlock_valeo_scm: UnlockFn = (seed) => lcgPair(seed, 0x41c64e6d, 0x3039, 0x12345678);
export const unlock_alpine_amp: UnlockFn = (seed) => lcgPair(seed, 0x52d75f5c, 0x412b, 0x6473);

// alpine_rak — 2-arg keyless module.
export const unlock_alpine_rak: UnlockFn = (seedLo, seedHi = 0) => {
  const a = (BigInt(seedLo >>> 0) * 0x41c64e6dn + 0x3039n) & 0xffffffffn;
  const b = (BigInt(seedHi >>> 0) * 0x41c64e6dn + 0x3039n) & 0xffffffffn;
  return Number((a ^ b ^ 0x4e2bn) & 0xffffffffn) >>> 0;
};

// ═══════════════════════════════════════════════════════════════════════
// Bosch door-module family — 4-table XOR + 32-bit ADD K
// ═══════════════════════════════════════════════════════════════════════

const bosch4t = (seed: number, T: readonly number[], K: number): number => {
  const s = u16(seed);
  let eax = u32(seed);
  eax = (eax & 0xffff0000) | (((eax & 0xffff) - T[(s >> 3) & 7]) & 0xffff);
  eax = u32(eax + K);
  let ax = eax & 0xffff;
  ax ^= T[(s >> 12) & 7];
  ax = (ax - T[s & 7]) & 0xffff;
  ax = (ax + T[(s >> 8) & 7]) & 0xffff;
  return u32((eax & 0xffff0000) | ax);
};
const BOSCH_PDM_T = [0xf398, 0x716a, 0x9335, 0xd214, 0x3e9c, 0xa39a, 0x1479, 0x7ee2];
const BOSCH_MDDM_T = [0xa629, 0x21a4, 0x981a, 0xc317, 0xe03a, 0x515a, 0x9417, 0xc6c3];
const BOSCH_MWDDM_T = [0x882a, 0x6b1f, 0xc7e3, 0x4d26, 0x15cc, 0x27e5, 0x4f2a, 0x3de8];
const BOSCH_CDM_T = [0xae4c, 0x5e2b, 0x579d, 0xa4ce, 0x721f, 0x990b, 0x1014, 0x4793];
export const unlock_bosch_pdm: UnlockFn = (seed) => bosch4t(seed, BOSCH_PDM_T, 0x52d3);
export const unlock_bosch_ddm: UnlockFn = (seed) => bosch4t(seed, BOSCH_PDM_T, 0x52d3);
export const unlock_bosch_mddm: UnlockFn = (seed) => bosch4t(seed, BOSCH_MDDM_T, 0x14e7);
export const unlock_bosch_mpdm: UnlockFn = (seed) => bosch4t(seed, BOSCH_MDDM_T, 0x14e7);
export const unlock_bosch_mwddm: UnlockFn = (seed) => bosch4t(seed, BOSCH_MWDDM_T, u32(-0x4dc7));
export const unlock_bosch_mwpdm: UnlockFn = (seed) => bosch4t(seed, BOSCH_MWDDM_T, u32(-0x4dc7));
export const unlock_bosch_cdm_win_ddm: UnlockFn = (seed) => bosch4t(seed, BOSCH_CDM_T, 0x35b3);
export const unlock_bosch_cdm_win_pdm: UnlockFn = (seed) => bosch4t(seed, BOSCH_CDM_T, 0x35b3);

// ═══════════════════════════════════════════════════════════════════════
// Multiply / misc
// ═══════════════════════════════════════════════════════════════════════

const T_HVAC = [0xfbc3, 0x0bcb, 0xbe79, 0x4f87, 0x69a3, 0x3aa5, 0xff71, 0x03a1];
export const unlock_hvac: UnlockFn = (seed) => (T_HVAC[u16(seed) & 7] * u16(seed)) & 0xffff;
const T_TRW_HVAC = [0xa427, 0x16a9, 0xd55f, 0x4c55, 0xd235, 0xbb1f, 0xa673, 0x3c43];
export const unlock_trw_hvac: UnlockFn = (seed) => (T_TRW_HVAC[u16(seed) & 7] * u16(seed)) & 0xffff;
const T_TRW_HVAC2 = [0xb795, 0xc1c3, 0xc3d3, 0xa457, 0xbcd5, 0xce0b, 0x7883, 0xa987];
export const unlock_trw_hvac_2: UnlockFn = (seed) => {
  const s = u16(seed);
  const masked = (T_TRW_HVAC2[s & 7] * s) & 0x8000ffff;
  return masked & 0x80000000 ? u32(masked | 0xffff0000) : masked;
};

const temic: UnlockFn = (seed) => mul32(u32(~seed), 0x13d);
export const unlock_temic_ddm = temic;
export const unlock_temic_pdm = temic;

export const unlock_egs52: UnlockFn = (seed) => mul32(seed ^ 0x5aa5a5a5, 0x5aa5a5a5);

export const unlock_mitsubishi_rar: UnlockFn = (seed) =>
  u32(((((seed ^ 0x7368) * 0x2) + 0x2a) ^ 0x6974));
export const unlock_mitsubishi_ves: UnlockFn = (seed) => {
  let eax = u32(seed ^ 0x4375);
  eax = u32(eax * 2 + 0x2a);
  return u32(eax ^ 0x6e74);
};

export const unlock_sunr: UnlockFn = (seed) => {
  const s = u16(seed);
  let edx = u32(~s);
  edx ^= 0xcafe;
  edx = u32(edx + s);
  const eax = s ^ 0x9396;
  return u32(eax + edx);
};

export const unlock_awd_pm_mk: UnlockFn = (seed) => {
  const lo = ((seed & 0xffff) * 0x96 + 0x4591) & 0xffff;
  const hi = (((seed >>> 16) & 0xffff) * 0x96 + 0x4591) & 0xffff;
  return u32((hi << 16) | lo);
};

const T_BORG = [0x279d, 0x3bcb, 0x7991, 0xb5c3, 0xc885, 0x6bf9, 0x1f36, 0x58f9];
export const unlock_borg_awd: UnlockFn = (seed) => {
  const s = u16(seed);
  const v = (T_BORG[s & 7] ^ s) & 0xffff;
  const sar = v >>> 4;
  const shl = u32(v << 12);
  return u32(shl | sar);
};

const T_AHBM = [0x44be, 0xadcc, 0xaf69, 0x81e2, 0xa9b2, 0x5342, 0xf5b6, 0x9cfa];
export const unlock_ahbm: UnlockFn = (seed) => {
  let eax = mul32(seed ^ 0x2172, 0x5342);
  const v = T_AHBM[seed & 7];
  eax = u32(eax + u32(~v));
  eax = (eax & 0xffff0000) | (((eax & 0xffff) ^ T_AHBM[seed & 3]) & 0xffff);
  return u32(eax - v);
};

const T_WCM = [
  0x4435, 0x1001, 0x6324, 0x5565, 0x9932, 0x0638, 0x0017, 0x3968,
  0x7656, 0x8239, 0x2743, 0x6897, 0x6460, 0x0054, 0x9078, 0x6546,
];
export const unlock_wcm: UnlockFn = (seed) => {
  const s = u16(seed);
  const ebx = (T_WCM[s & 0xf] & 0xff00) | (s & 0xff);
  let eax = u32(T_WCM[(s >> 8) & 0xf] + s);
  eax = (eax * ebx) & 0xffff;
  return eax;
};

const T_DELPHI_SDAR = [0xf0b5, 0x0da3, 0xb561, 0xac27, 0x34ef, 0x87f0, 0xef0b, 0xf0d5];
export const unlock_delphi_sdar: UnlockFn = (seed) => {
  const s = u16(seed);
  let v = T_DELPHI_SDAR[(s >> 12) & 7];
  v = (v + T_DELPHI_SDAR[(s >> 8) & 7]) & 0xffff;
  v = (v + T_DELPHI_SDAR[(s >> 4) & 7]) & 0xffff;
  v = (v + T_DELPHI_SDAR[s & 7]) & 0xffff;
  return u32(v ^ seed);
};

// cmtc.dll / eom.dll — T8 add-chain.
const T_CMTC = [0x6c47, 0x8686, 0xcb85, 0xd737, 0xa518, 0x1b30, 0x5cb3, 0x1a6a];
export const unlock_cmtc: UnlockFn = (seed) => {
  const s = u32(seed);
  const sLo = s & 0xffff;
  const accum = u32((s * 4) | ((sLo >> 14) & 3));
  let v = T_CMTC[(accum >>> 13) & 7];
  v = (v + T_CMTC[(accum >>> 10) & 7]) & 0xffff;
  v = (v + T_CMTC[(accum >>> 6) & 7]) & 0xffff;
  v = (v + T_CMTC[(accum >>> 3) & 7]) & 0xffff;
  v = (v + T_CMTC[accum & 7]) & 0xffff;
  return u32(v + s - 0x70ca);
};
export const unlock_eom = unlock_cmtc;

// ═══════════════════════════════════════════════════════════════════════
// GPEC — modern Stellantis PCM (Scat Pack / Hellcat / SRT). XTEA-style Feistel.
// ═══════════════════════════════════════════════════════════════════════

const GPEC_KEY = [...'DAIMLERCHRYSLER3'].map((ch) => ch.charCodeAt(0));
const gpecMix4 = (a: number, b: number, c: number, d: number): number =>
  ((((((a << 3) ^ b) << 2) ^ c) << 3) ^ d) >>> 0;
export const unlock_gpec: UnlockFn = (seedDword) => {
  const s = u32(seedDword);
  let eax = (((s >>> 16) & 0xff) << 8) | ((s >>> 24) & 0xff);
  let edx = (((s >>> 0) & 0xff) << 8) | ((s >>> 8) & 0xff);
  eax &= 0xffff;
  edx &= 0xffff;
  const K = GPEC_KEY;
  const ebp = gpecMix4(K[0x3], K[0x2], K[0x1], K[0x0]);
  const edi = gpecMix4(K[0x7], K[0x6], K[0x5], K[0x4]);
  const esi = gpecMix4(K[0xb], K[0xa], K[0x9], K[0x8]);
  const ecx = gpecMix4(K[0xf], K[0xe], K[0xd], K[0xc]);
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    sum = (sum + 0xffff9e37) & 0xffff;
    let t = u32((edx << 4) + ebp);
    let u = u32((edx >>> 5) + edi);
    const m1 = u32(t ^ u ^ u32(sum + edx));
    eax = (eax + m1) & 0xffff;
    t = u32((eax << 4) + esi);
    u = u32((eax >>> 5) + ecx);
    const m2 = u32(t ^ u ^ u32(sum + eax));
    edx = (edx + m2) & 0xffff;
  }
  const alLo = eax & 0xff;
  const alHi = (eax >>> 8) & 0xff;
  const dlLo = edx & 0xff;
  const dlHi = (edx >>> 8) & 0xff;
  return u32((alLo << 24) | (alHi << 16) | (dlLo << 8) | dlHi);
};

// ═══════════════════════════════════════════════════════════════════════
// Final-10 hardest DLLs (Task #539)
// ═══════════════════════════════════════════════════════════════════════

const SAS_T = [0x80, 0xcc, 0x7c, 0x7a];
const SAS_M = [
  [7, 5, 3, 2],
  [0x13, 0x11, 0xd, 0xb],
  [0xb, 0xd, 0x11, 0x13],
  [2, 3, 5, 7],
];
export const unlock_sas: UnlockFn = (seed) => {
  const b3 = (seed >>> 24) & 0xff;
  const b2 = (seed >>> 16) & 0xff;
  const b1 = (seed >>> 8) & 0xff;
  const b0 = seed & 0xff;
  let out = 0;
  const shifts = [0, 2, 4, 6];
  for (let grp = 0; grp < 4; grp++) {
    const shift = shifts[grp];
    const a = SAS_T[(b0 >> shift) & 3];
    const b = SAS_T[(b1 >> shift) & 3];
    const c = SAS_T[(b2 >> shift) & 3];
    const d = SAS_T[(b3 >> shift) & 3];
    const m = SAS_M[grp];
    const byte = (a * m[0]) ^ (b * m[1]) ^ (c * m[2]) ^ (d * m[3]);
    out |= (byte & 0xff) << ((3 - grp) * 8);
  }
  return u32(out);
};

const HIDT_T = [
  0x2be9, 0x8519, 0x23ec, 0x9ba7, 0x73b9, 0x001e, 0x93cd, 0x5e7a,
  0x971a, 0x9476, 0x1b63, 0x73f3, 0x7f3b, 0x816a, 0xc983, 0x3800,
  0x3726, 0x0ae1, 0x38be, 0x9356, 0x1b43, 0xbe74, 0xedae, 0x3273,
  0x6538, 0x8461, 0xbebc, 0x0101, 0x1827, 0x9378, 0x192a, 0xcbe2,
];
export const unlock_hidt: UnlockFn = (seed) => {
  const s = u32(seed);
  const b0 = s & 0xff;
  const b1 = (s >>> 8) & 0xff;
  const idxA = (b1 >> 4) & 0x1f;
  const idxB = b1 & 0x1f;
  const idxC = (b0 >> 4) & 0x1f;
  const idxD = b0 & 0x1f;
  let eax = (HIDT_T[idxA] + b0) & 0xffff;
  eax = u32(eax | s);
  eax = u32(eax - ((HIDT_T[idxB] ^ b1) & 0xffff));
  eax = (eax & 0xffff0000) | ((eax + HIDT_T[idxD]) & 0xffff);
  eax = u32(eax + b1);
  eax = u32(eax ^ ((HIDT_T[idxC] * b0) & 0xffff));
  return eax;
};

export const unlock_cvt: UnlockFn = (seed) => {
  const s = u32(seed);
  const lo = s & 0xffff;
  const hi = (s >>> 16) & 0xffff;
  const n0 = s & 0xf;
  const n1 = (s >>> 4) & 0xf;
  const n2 = (s >>> 8) & 0xf;
  const v1 = (lo - 0x3e8d) & 0xffff;
  const s1 = (((v1 + rol16(v1, n0) - 1) & 0xffff) ^ hi) & 0xffff;
  const v2 = (s1 + 0x4da1) & 0xffff;
  const s2 = (v2 + rol16(v2, n1) - 1) & 0xffff;
  const outHi = (rol16(s2, n2) ^ lo ^ s2) & 0xffff;
  return u32((outHi << 16) | s1);
};

const PEIKER_T = [0xa62e, 0x579a, 0xce23, 0x6ba5, 0xd173, 0x5d13, 0x1347, 0xb8f1];
export const unlock_peiker_hfm: UnlockFn = (seed) => {
  const s = u32(seed);
  const b0 = s & 0xff;
  const b1 = (s >>> 8) & 0xff;
  const idxA = ((b0 >> 3) & 1) | ((b0 >> 1) & 2) | ((b0 << 1) & 4);
  const idxB = ((b1 >> 3) & 1) | ((b0 >> 6) & 2) | ((b0 >> 4) & 4);
  const idxD = ((b1 >> 1) & 1) | ((b1 >> 1) & 2) | ((b1 >> 2) & 4);
  const idxE = (b0 >> 3) & 7;
  const idxC = (b1 >> 5) & 7;
  return u32(s ^ 0xc521 ^ PEIKER_T[idxA] ^ PEIKER_T[idxB] ^ PEIKER_T[idxD] ^ PEIKER_T[idxE] ^ PEIKER_T[idxC]);
};

const VISTEON_T = [0x374f, 0xd329, 0xb213, 0x7fea, 0x1152, 0x6c63, 0x2545, 0x583d];
const VISTEON_POS = [9, 6, 0xe, 8, 0xf, 0xc, 1, 0xb, 0, 2, 5, 3, 0xa, 4, 0xd, 7];
export const unlock_visteon_amp: UnlockFn = (seed) => {
  const s = u32(seed);
  let ax = VISTEON_T[s & 7];
  for (let i = 0; i < 16; i++) {
    const bit = (s >>> i) & 1;
    if ((i % 2 === 0 && bit === 0) || (i % 2 === 1 && bit === 1)) {
      ax = (ax + (1 << VISTEON_POS[i])) & 0xffff;
    }
  }
  return ax;
};

const KICKER_TAB1 = [0x2, 0x4, 0x3, 0x9, 0x1, 0xb, 0xa, 0xd, 0x5, 0x7, 0xe, 0xc, 0x0, 0x8, 0x6, 0xf];
const KICKER_TAB2 = [0x3, 0x5, 0xb, 0xa, 0xf, 0xd, 0x9, 0xc, 0x6, 0x1, 0x8, 0x0, 0x4, 0xe, 0x7, 0x2];
const kickerCrc = (edx: number, n: number): number => {
  for (let i = 0; i < n; i++) {
    edx = edx & 0x80000000 ? u32((edx << 1) ^ 0x4c11db7) : u32(edx << 1);
  }
  return edx;
};
export const unlock_kicker_amp: UnlockFn = (seed) => {
  const s = u32(seed);
  let al = s & 0xff;
  const bl0 = (s >>> 8) & 0xff;
  let bl = bl0;
  let edx = kickerCrc(0xfe0714b6, 37);
  let clPrev = bl;
  let clLast = bl;
  for (let i = 0; i < 8; i++) {
    edx = kickerCrc(edx, 8);
    const sIn = (al ^ (edx & 0xff)) & 0xff;
    const sbox = ((KICKER_TAB1[(sIn >> 4) & 0xf] << 4) | KICKER_TAB2[sIn & 0xf]) & 0xff;
    const rotated = ((sbox >> 1) | ((sbox & 1) << 7)) & 0xff;
    clPrev = clLast;
    clLast = rotated;
    al = (rotated ^ bl) & 0xff;
    bl = rotated;
  }
  return ((clLast << 8) | (clLast ^ clPrev)) & 0xffff;
};

const edc16 = (seed: number, T: readonly number[]): number => {
  const s = u32(seed);
  const b0 = s & 0xff;
  const b1 = (s >>> 8) & 0xff;
  const b2 = (s >>> 16) & 0xff;
  const b3 = (s >>> 24) & 0xff;
  const x23 = b2 ^ b3;
  const idx0 = ((b1 >> 6) & 1) | (((x23 >> 2) & 1) << 1) | (((x23 >> 5) & 1) << 2);
  const dlInter = (T[4 * idx0 + 2] ^ b1) & 0xff;
  const idx1 = ((b1 >> 1) & 1) | (((dlInter >> 5) & 1) << 1) | (((x23 >> 7) & 1) << 2);
  const byte3 = (T[4 * idx0] ^ b3 ^ T[4 * idx1 + 3]) & 0xff;
  const byte2 = (T[4 * idx0 + 1] ^ b2 ^ T[4 * idx1]) & 0xff;
  const byte1 = (T[4 * idx0 + 2] ^ b1 ^ T[4 * idx1 + 1]) & 0xff;
  const byte0 = (T[4 * idx0 + 3] ^ b0 ^ T[4 * idx1 + 2]) & 0xff;
  return u32((byte3 << 24) | (byte2 << 16) | (byte1 << 8) | byte0);
};
const T_EDC16C2 = [
  0x9b, 0x38, 0x11, 0x76, 0x77, 0xe4, 0x4d, 0x02, 0x13, 0x50, 0x49, 0x4e, 0x6f, 0x7c, 0x05, 0x5a,
  0x8b, 0x68, 0x81, 0x26, 0x67, 0x14, 0xbd, 0xb2, 0x03, 0x80, 0xb9, 0xfe, 0x5f, 0xac, 0x75, 0x0a,
];
const T_EDC16CP31 = [
  0x05, 0x09, 0x07, 0xd3, 0xa3, 0x4a, 0xd1, 0x21, 0x01, 0x07, 0x07, 0xba, 0x3b, 0xca, 0xe0, 0x72,
  0x3e, 0x10, 0xaa, 0x89, 0xd8, 0x2f, 0x9a, 0x62, 0x54, 0x9e, 0xa2, 0xda, 0x6b, 0xc4, 0x90, 0x52,
];
const T_EDC16U31 = [
  0xcc, 0x15, 0x2a, 0x1b, 0xb8, 0x91, 0xf6, 0xf7, 0x64, 0xcd, 0x82, 0x93, 0xd0, 0xc9, 0xce, 0xef,
  0xfc, 0x85, 0xda, 0x0b, 0xe8, 0x01, 0xa6, 0xe7, 0x94, 0x3d, 0x32, 0x83, 0x00, 0x39, 0x7e, 0xdf,
];
export const unlock_edc16c2: UnlockFn = (seed) => edc16(seed, T_EDC16C2);
export const unlock_edc16cp31: UnlockFn = (seed) => edc16(seed, T_EDC16CP31);
export const unlock_edc16u31: UnlockFn = (seed) => edc16(seed, T_EDC16U31);

// lear_wcm — Hitag2-style 48-bit LFSR, 2-arg.
const LEAR_SBOX_A = [1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0];
const LEAR_SBOX_B = [1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0];
const LEAR_SBOX_F = [
  1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0,
  1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0,
];
const LEAR_FB_T = [0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0];
const LEAR_KEY = [0x42, 0xf7, 0x8e, 0x11];
const learFilter = (s: number[]): number => {
  const idx1 = ((s[1] >> 7) & 1) | (((s[1] >> 3) & 1) << 1) | (((s[1] >> 1) & 1) << 2) | (((s[1] >> 0) & 1) << 3);
  const idx2 = ((s[2] >> 6) & 1) | (((s[2] >> 2) & 1) << 1) | (((s[2] >> 0) & 1) << 2) | (((s[3] >> 5) & 1) << 3);
  const idx3 = ((s[4] >> 5) & 1) | (((s[5] >> 4) & 1) << 1) | (((s[5] >> 3) & 1) << 2) | (((s[5] >> 1) & 1) << 3);
  const idx4 = ((s[0] >> 5) & 1) | (((s[0] >> 4) & 1) << 1) | (((s[0] >> 2) & 1) << 2) | (((s[0] >> 1) & 1) << 3);
  const idx5 = ((s[3] >> 3) & 1) | (((s[3] >> 2) & 1) << 1) | (((s[3] >> 0) & 1) << 2) | (((s[4] >> 6) & 1) << 3);
  const o1 = LEAR_SBOX_A[idx1];
  const o2 = LEAR_SBOX_A[idx2];
  const o3 = LEAR_SBOX_B[idx3];
  const o4 = LEAR_SBOX_B[idx4];
  const o5 = LEAR_SBOX_A[idx5];
  return LEAR_SBOX_F[o4 | (o1 << 1) | (o2 << 2) | (o5 << 3) | (o3 << 4)];
};
const learShift = (state: number[], newBit: number): void => {
  for (let i = 0; i < 5; i++) state[i] = ((state[i] << 1) & 0xff) | (state[i + 1] >> 7);
  state[5] = ((state[5] << 1) & 0xff) | (newBit & 1);
};
export const unlock_lear_wcm: UnlockFn = (seed1, seed2 = 0) => {
  const bytesIn = [
    (seed1 >>> 24) & 0xff, (seed1 >>> 16) & 0xff, (seed1 >>> 8) & 0xff, seed1 & 0xff,
    (seed2 >>> 24) & 0xff, (seed2 >>> 16) & 0xff, (seed2 >>> 8) & 0xff, seed2 & 0xff,
  ];
  const state = [0x42, 0xf7, 0x8e, 0x11, 0x6a, 0x05];
  for (let outer = 0; outer < 4; outer++) {
    let bm = 0x80;
    while (bm) {
      let al = learFilter(state);
      al ^= LEAR_KEY[outer] & bm ? 1 : 0;
      al ^= bytesIn[outer] & bm ? 1 : 0;
      learShift(state, al);
      bm >>= 1;
    }
  }
  const buf = bytesIn.slice(4, 8);
  let byteIdx = 0;
  let bitMask = 0x80;
  for (let it = 0; it < 0x20; it++) {
    if (byteIdx >= 4) break;
    const b = buf[byteIdx];
    const ks = learFilter(state);
    const inputBit = b & bitMask ? 1 : 0;
    if ((ks ^ inputBit) === 1) buf[byteIdx] = b | bitMask;
    else buf[byteIdx] = b & (~bitMask & 0xff);
    let al = (state[1] & 0xfc) ^ state[2];
    al = (al & 0xcf) ^ (state[3] & 0x22);
    al ^= state[0];
    al = (al & 0xb3) ^ (state[5] & 0x73);
    const fb = LEAR_FB_T[(al >> 4) & 0xf] ^ LEAR_FB_T[al & 0xf];
    learShift(state, fb);
    bitMask >>= 1;
    if (bitMask === 0) {
      byteIdx += 1;
      bitMask = 0x80;
    }
  }
  return u32((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]);
};

// ═══════════════════════════════════════════════════════════════════════
// Dispatcher
// ═══════════════════════════════════════════════════════════════════════

/** DLL-basename → verified unlock fn (1:1 with the Python `_DLL_ALIASES`). */
export const UNLOCKS: Record<string, UnlockFn> = {
  huntsville_bcm: unlock_huntsville_bcm,
  yazaki_fcm: unlock_yazaki_fcm,
  motorola_tipm7: unlock_motorola_tipm7,
  trw_abs: unlock_trw_abs,
  bosch_abs: unlock_bosch_abs,
  ngc_engine: unlock_ngc_engine,
  ngc_transmission: unlock_ngc_transmission,
  venom_pcm: unlock_venom_pcm,
  gpec: unlock_gpec,
  may_scofield_itm: unlock_may_scofield_itm,
  huntsville_radio: unlock_huntsville_radio,
  alpine_rak: unlock_alpine_rak,
  wcm: unlock_wcm,
  HB_ccn: unlock_HB_ccn,
  LX_ccn: unlock_LX_ccn,
  nippon_ccn: unlock_nippon_ccn,
  ngc4_trans: unlock_ngc4_trans,
  ocm: unlock_ocm,
  trw_ocm: unlock_trw_ocm,
  trw_orc: unlock_trw_orc,
  asbs: unlock_asbs,
  lrsm: unlock_lrsm,
  abs: unlock_abs,
  alpine_amp: unlock_alpine_amp,
  hella_acc: unlock_hella_acc,
  msmd: unlock_msmd,
  teves_abs: unlock_teves_abs,
  valeo_scm: unlock_valeo_scm,
  cummins_849: unlock_cummins_849,
  egs52: unlock_egs52,
  mitsubishi_rar: unlock_mitsubishi_rar,
  mitsubishi_ves: unlock_mitsubishi_ves,
  eom: unlock_eom,
  cmtc: unlock_cmtc,
  pdm: unlock_pdm,
  ddm: unlock_ddm,
  fdcm: unlock_fdcm,
  bosch_ddm: unlock_bosch_ddm,
  bosch_pdm: unlock_bosch_pdm,
  bosch_mddm: unlock_bosch_mddm,
  bosch_mpdm: unlock_bosch_mpdm,
  bosch_mwddm: unlock_bosch_mwddm,
  bosch_mwpdm: unlock_bosch_mwpdm,
  bosch_cdm_win_ddm: unlock_bosch_cdm_win_ddm,
  bosch_cdm_win_pdm: unlock_bosch_cdm_win_pdm,
  hvac: unlock_hvac,
  trw_hvac: unlock_trw_hvac,
  trw_hvac_2: unlock_trw_hvac_2,
  temic_ddm: unlock_temic_ddm,
  temic_pdm: unlock_temic_pdm,
  sunr: unlock_sunr,
  awd_pm_mk: unlock_awd_pm_mk,
  borg_awd: unlock_borg_awd,
  ahbm: unlock_ahbm,
  delphi_sdar: unlock_delphi_sdar,
  sas: unlock_sas,
  hidt: unlock_hidt,
  cvt: unlock_cvt,
  peiker_hfm: unlock_peiker_hfm,
  visteon_amp: unlock_visteon_amp,
  kicker_amp: unlock_kicker_amp,
  edc16c2: unlock_edc16c2,
  edc16cp31: unlock_edc16cp31,
  edc16u31: unlock_edc16u31,
  lear_wcm: unlock_lear_wcm,
};

/** Logical module name (UI-facing) → DLL-basename key in {@link UNLOCKS}. */
export const LOGICAL_TO_DLL: Record<string, string> = {
  BCM: 'huntsville_bcm',
  BCM_LX: 'yazaki_fcm',
  FCM: 'huntsville_bcm',
  TIPM_7: 'motorola_tipm7',
  ABS_TRW: 'trw_abs',
  ABS_BOSCH: 'bosch_abs',
  ITM: 'may_scofield_itm',
  PCM_NGC: 'ngc_engine',
  PCM_GPEC: 'gpec',
  PCM_VENOM: 'venom_pcm',
  TCM: 'ngc_transmission',
  RADIO: 'huntsville_radio',
  RAK: 'alpine_rak',
  WCM: 'wcm',
  WCM_LEAR: 'lear_wcm',
  CCN_HB: 'HB_ccn',
  CCN_LX: 'LX_ccn',
  CCN_NIPPON: 'nippon_ccn',
  TRANS_NGC4: 'ngc4_trans',
  OCM: 'ocm',
  OCM_TRW: 'trw_ocm',
  ORC_TRW: 'trw_orc',
  ASBS: 'asbs',
  LRSM: 'lrsm',
  ABS: 'abs',
  AMP_ALPINE: 'alpine_amp',
  ACC_HELLA: 'hella_acc',
  MSMD: 'msmd',
  ABS_TEVES: 'teves_abs',
  SCM_VALEO: 'valeo_scm',
  CUMMINS_849: 'cummins_849',
  EGS52: 'egs52',
  RAR_MITSUBISHI: 'mitsubishi_rar',
  VES_MITSUBISHI: 'mitsubishi_ves',
  EOM: 'eom',
  CMTC: 'cmtc',
  PDM: 'pdm',
  DDM: 'ddm',
  FDCM: 'fdcm',
  DDM_BOSCH: 'bosch_ddm',
  PDM_BOSCH: 'bosch_pdm',
  MDDM_BOSCH: 'bosch_mddm',
  MPDM_BOSCH: 'bosch_mpdm',
  MWDDM_BOSCH: 'bosch_mwddm',
  MWPDM_BOSCH: 'bosch_mwpdm',
  CDM_WIN_DDM: 'bosch_cdm_win_ddm',
  CDM_WIN_PDM: 'bosch_cdm_win_pdm',
  HVAC: 'hvac',
  HVAC_TRW: 'trw_hvac',
  HVAC_TRW_2: 'trw_hvac_2',
  DDM_TEMIC: 'temic_ddm',
  PDM_TEMIC: 'temic_pdm',
  SUNR: 'sunr',
  AWD_PM_MK: 'awd_pm_mk',
  AWD_BORG: 'borg_awd',
  AHBM: 'ahbm',
  SDAR_DELPHI: 'delphi_sdar',
  SAS: 'sas',
  HIDT: 'hidt',
  CVT: 'cvt',
  HFM_PEIKER: 'peiker_hfm',
  AMP_VISTEON: 'visteon_amp',
  AMP_KICKER: 'kicker_amp',
  EDC16C2: 'edc16c2',
  EDC16CP31: 'edc16cp31',
  EDC16U31: 'edc16u31',
};

/** Module names whose algorithm consumes two 32-bit seed args. */
export const TWO_ARG_MODULES = new Set(['alpine_rak', 'lear_wcm', 'RAK', 'WCM_LEAR']);

/**
 * Compute the SecurityAccess key for a module.
 *
 * `name` accepts either a logical module name ('BCM', 'PCM_GPEC', 'RAK') or a
 * raw DLL basename ('huntsville_bcm', 'gpec'). Returns the key as an unsigned
 * number, or `null` if the module has no verified algorithm (caller should
 * fall back, e.g. to the python-bridge Unicorn path).
 *
 * For two-arg modules (RAK, WCM_LEAR) pass `seedHi` as well.
 */
export function unlockByModule(name: string, seed: number, seedHi = 0): number | null {
  const key = LOGICAL_TO_DLL[name] ?? name;
  const fn = UNLOCKS[key];
  if (!fn) return null;
  return fn(seed, seedHi) >>> 0;
}

/** True when the named module's algorithm requires a second 32-bit seed arg. */
export function isTwoArgModule(name: string): boolean {
  return TWO_ARG_MODULES.has(name) || TWO_ARG_MODULES.has(LOGICAL_TO_DLL[name] ?? '');
}
