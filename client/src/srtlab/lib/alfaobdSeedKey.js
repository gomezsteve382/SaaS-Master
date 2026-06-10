/**
 * alfaobdSeedKey.js
 * SRT Lab — FCA/Chrysler/Dodge/Jeep UDS Security Access Algorithms
 *
 * Algorithms reverse-engineered from AlfaOBD.exe (inner .NET binary, Dotfuscator-obfuscated).
 * Disassembled via ikdasm. Target methods: ad::f, ad::ht, ad::ao, ad::w6.
 *
 * Supported algorithms:
 *   ht(seed)       — Simple bit-shuffle (ad::ht). Constants 0x41AA42BB, 0x22BA9A31.
 *   f(seed)        — XTEA, 64 cycles, delta=0x8F750A1D, seed LE. af::ge=51, af::aj=5.
 *   ao(seed)       — XTEA variant, seed BE. UCONNECT (0x149) / RADIO_FGA (0x14E), level 5.
 *   w6(seed,r,s)   — Parameterized linear cipher (ad::w6). Per-ECU (r,s) constants.
 *   gpec2aW6(seed) — GPEC2A ECM: key = swap_words((seed * r + s) & 0xFFFFFFFF)
 *
 * Usage:
 *   import { computeSeedKey, AOBD_W6_TABLE, FCA_MODULE_ALGO } from './alfaobdSeedKey';
 *   const result = computeSeedKey([0xC1, 0xFF, 0xCB, 0xC1], { algorithm: 'w6', wrapper: 'tt' });
 *   // result.keyHex === "16 2C 12 4F"
 */

// ============================================================
// XTEA core — 64 cycles, delta=0x8F750A1D
// ============================================================
const KEY_TABLE = [0x9B127D51, 0x5BA41903, 0x4FE87269, 0x6BC361D8];
const DELTA = 0x8F750A1D;
const ROUNDS = 64;

function _xtea(v1, v8) {
  let sum = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const inner1 = ((((v8 << 4) >>> 0) ^ (v8 >>> 5)) + v8) >>> 0;
    const outer1 = (sum + KEY_TABLE[sum & 3]) >>> 0;
    v1 = (v1 + ((inner1 ^ outer1) >>> 0)) >>> 0;
    sum = (sum + DELTA) >>> 0;
    const inner2 = ((((v1 << 4) >>> 0) ^ (v1 >>> 5)) + v1) >>> 0;
    const outer2 = (sum + KEY_TABLE[(sum >>> 11) & 3]) >>> 0;
    v8 = (v8 + ((inner2 ^ outer2) >>> 0)) >>> 0;
  }
  return [v1, v8];
}

/** Simple bit-shuffle (ad::ht). Triggered by specific ECU name strings. */
export function ht(seed) {
  const [s0, s1, s2, s3] = seed;
  let v2 = (((s1 << 24) | (s0 << 16) | (s3 << 8) | s2) >>> 0);
  let v3 = (((v2 << 11) >>> 0) | (v2 >>> 22)) >>> 0;
  v3 = (v3 ^ 0x41AA42BB) >>> 0;
  const v4 = ((((s0 << 24) | (s1 << 16) | (s2 << 8) | s3) >>> 0) & 0x22BA9A31) >>> 0;
  const result = (v4 ^ v3) >>> 0;
  return [(result >>> 24) & 0xFF, (result >>> 16) & 0xFF, (result >>> 8) & 0xFF, result & 0xFF];
}

/** XTEA seed-key, seed packed little-endian. af::ge=51, af::aj=5. */
export function f(seed) {
  const [s0, s1, s2, s3] = seed;
  const v1_init = (((s3 << 24) | (s2 << 16) | (s1 << 8) | s0) >>> 0);
  const [v1] = _xtea(v1_init, 0);
  return [(v1 >>> 24) & 0xFF, (v1 >>> 16) & 0xFF, (v1 >>> 8) & 0xFF, v1 & 0xFF];
}

/** XTEA seed-key, seed packed big-endian. UCONNECT (0x149) / RADIO_FGA (0x14E), level 5. */
export function ao(seed) {
  const [s0, s1, s2, s3] = seed;
  const v1_init = (((s0 << 24) | (s1 << 16) | (s2 << 8) | s3) >>> 0);
  const [v1] = _xtea(v1_init, 0);
  return [(v1 >>> 24) & 0xFF, (v1 >>> 16) & 0xFF, (v1 >>> 8) & 0xFF, v1 & 0xFF];
}

/**
 * Parameterized linear cipher (ad::w6).
 * seed: 4-byte array; r, s: 32-bit unsigned integers (or BigInt for 40-bit entries).
 */
export function w6(seed, r, s) {
  const [s0, s1, s2, s3] = seed;
  const v0 = (((s0 << 24) | (s1 << 16) | (s2 << 8) | s3) >>> 0);
  let v1 = (((s1 << 24) | (s0 << 16) | (s3 << 8) | s2) >>> 0);
  v1 = (((v1 << 11) >>> 0) + (v1 >>> 22)) >>> 0;
  // Handle BigInt for 40-bit parameters
  const rMasked = (typeof r === 'bigint') ? Number(r & 0xFFFFFFFFn) : (r >>> 0);
  const sMasked = (typeof s === 'bigint') ? Number(s & 0xFFFFFFFFn) : (s >>> 0);
  const v2 = (sMasked & v0) >>> 0;
  const result = (v1 ^ rMasked ^ v2) >>> 0;
  return [(result >>> 24) & 0xFF, (result >>> 16) & 0xFF, (result >>> 8) & 0xFF, result & 0xFF];
}

/**
 * GPEC2A W6 algorithm.
 * Confirmed working for 2016+ Charger/Challenger/Durango GPEC2A ECMs.
 * Algorithm: key = swap_words((seed * r + s) & 0xFFFFFFFF)
 * Test vector: seed=0xC1FFCBC1, r=0x234521F9, s=0x19390673 → key=0x162C124F
 */
export function gpec2aW6(seed, r = 0x234521F9, s = 0x19390673) {
  const seedVal = (((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0);
  const temp = Number((BigInt(seedVal) * BigInt(r >>> 0) + BigInt(s >>> 0)) & 0xFFFFFFFFn);
  // swap_words: rotate 16 bits
  const key = (((temp >>> 16) | ((temp & 0xFFFF) << 16)) >>> 0);
  return [(key >>> 24) & 0xFF, (key >>> 16) & 0xFF, (key >>> 8) & 0xFF, key & 0xFF];
}

// ============================================================
// PER-ECU PARAMETER CATALOG (decoded from AlfaOBD binary)
// W6 wrapper table: wrapper_name -> [r, s]
// ============================================================
export const AOBD_W6_TABLE = {
  'a0': [0x57EF2013, 0x48AD5DA6], 'a1': [0xB1E456CC, 0x406C4F01],
  'a2': [0xBF5C0159, 0x7C7D32FF], 'a3': [0x9EC0EA81, 0x9B599A94],
  'a4': [0xC30A6F8F, 0x66DA07BE], 'a5': [0xB78D1E54, 0x6D257CF7],
  'a6': [0x387D8272, 0xDA61553F], 'a7': [0xDCCCF9EC, 0x31D7BC15],
  'a8': [0xA1C23A97, 0x2F6F2947], 'a9': [0xDFAA6CBF, 0x87C5962F],
  'b6': [0xA50893B9, 0xBF9B8336], 'b7': [0xDA160FCC, 0x653D1531],
  'b8': [0xC0F6712C, 0xD5ACC723], 'b9': [0x3A375AD8, 0x383F2CE7],
  'ba': [0xF40BCA21, 0x7B2E8EA5], 'bb': [0x53E19222, 0x1931A733],
  'be': [0x508CA0E7, 0x79264F2B], 'bg': [0xC2E83580, 0xE242AB16],
  'bh': [0x45BCC0EE, 0x34B3A15B], 'bi': [0x3CFD4074, 0xF0022C9A],
  'bj': [0x66DA5EC2, 0x24D72C03], 'bk': [0xF838EA15, 0xFA94EA40],
  'bl': [0x918874F4, 0x22D2CB95], 'bm': [0x248CA233, 0x79E9DD3D],
  'bn': [0xEDF9BD8C, 0x5D118CEC], 'bs': [0xC5030E4D, 0xBB3B331F],
  'bv': [0xE6DA35C4, 0x8E859CE8], 'bw': [0x5B3ED90C, 0x9FB8B9AE],
  'bx': [0x68018763, 0xD2791028], 'by': [0x6C8FE84F, 0x9C30D3BE],
  'bz': [0x74F66A92, 0x4DE3A3E3], 'cc': [0xF9B6892F, 0x82FD1FCD],
  'cd': [0x88B9E1D0, 0xDCD9C318], 'ce': [0xFBC7FA19, 0x3843C6C5],
  'cg': [0x4C0714AF, 0xC7A94CFD], 'ch': [0x531689D1, 0x18FB7395],
  'ci': [0x983F101B, 0x44EC05BD], 'cj': [0x41A8969A, 0x6234BA3E],
  'ck': [0xEE4D951E, 0x18FE826E], 'd0': [0x2D4791F5, 0xD0500B30],
  'd1': [0xE3F5C5D0, 0xB119357C], 'd5': [0xA91B575B, 0x9D9ABD79],
  'd6': [0x81D23EE3, 0x5FDB33C6], 'd8': [0x953573D6, 0xABAA1F9E],
  'd9': [0x8F282D76, 0x5FDCC309], 'dk': [0xA7EDE2FC, 0x4BE31331],
  'dl': [0x848585A1, 0xCF201A23], 'do': [0x1A54F2B2, 0xF49EB15E],
  'dp': [0xA2528317, 0xF6DC270B], 'dq': [0x7DFEFF2B, 0x5AF67CBC],
  'dr': [0x5CD2872A, 0xBEDEED07], 'ds': [0x1A54F2B2, 0xF49EB15E],
  'dt': [0xA2528317, 0xF6DC270B], 'du': [0x387D8272, 0xDA61553F],
  'dv': [0xDCCCF9EC, 0x31D7BC15], 'dw': [0x704949D0, 0x9E428592],
  'dx': [0x8B0DF1AE, 0xB779E3A9], 'dy': [0xFDFB7DBD, 0x1BF1F0D7],
  'dz': [0x4629591A, 0xB44B95FA], 'e0': [0x95AB8CEC, 0x5DA1AA04],
  'e5': [0x4A84298E, 0x872F95E0], 'e6': [0xE37F5688, 0xD2E332CC],
  'e7': [0xFAA53165, 0x91011442], 'ef': [0x3436904A, 0xD731F06F],
  'eg': [0x217224C7, 0xAC30E2CC], 'ej': [0xB0B4AE22, 0x476A6031],
  'ek': [0x80B54D19, 0x20DED45F], 'el': [0x6FDA4A70, 0xD8124906],
  'em': [0x36E86899, 0x1AB0E4E1], 'er': [0x8605AC3A, 0xDB60B644],
  'es': [0x9063BC10, 0x8605AC3A], 'ev': [0x8A4A520B, 0x69924163],
  'ew': [0xE7C8D765, 0x74FDCDF7], 'ex': [0xC88CAEF8, 0xD71385E9],
  'ey': [0xD1115295, 0xC2B7494A], 'ez': [0xB79448AC, 0xCD8B91FE],
  'f8': [0x63775E03, 0x8DE350E4], 'f9': [0x7450FCE1, 0xF102BFB4],
  'fq': [0x84DD5236, 0xDECD1DCC], 'fr': [0xE918CB1B, 0x44D3B0D2],
  'fs': [0x691419CE, 0x840B1061], 'ft': [0x88B9E1D0, 0xDCD9C318],
  'g3': [0xFBC7FA19, 0x3843C6C5], 'g4': [0x88B9E1D0, 0xDCD9C318],
  'g5': [0x2B6BA613, 0x665EEFD8], 'g6': [0x1E0656F8, 0xAEAB6F6D],
  'g7': [0x4F4BE9C7, 0xA70D31DD], 'g8': [0x8646D12C, 0x1AB14EAF],
  'g9': [0x729F9C77, 0xD91580E8], 'ga': [0x8A1707F3, 0x851E6016],
  'gb': [0x34EF2810, 0x4D322888], 'gc': [0x5EA04808, 0x8CD9CC35],
  'gd': [0xB1BF5CBE, 0xA9EDAB2C], 'ge': [0x26FF5057, 0x5E263A1B],
  'gf': [0x9857A02D, 0xDF29ACEE], 'gg': [0x5EA04808, 0x8CD9CC35],
  'gh': [0xB1BF5CBE, 0xA9EDAB2C], 'gj': [0x82B879EF, 0x5FC7577A],
  'gk': [0x8551AE02, 0x8BD64B08], 'gl': [0x6C05A0DF, 0xD9CFCA36],
  'gm': [0x65985834, 0x30023D63], 'ha': [0x6FEA389F, 0xE40485D7],
  'ir': [0x1CBFDC59, 0x272F94C9], 'is': [0xD71D5B55, 0x4E29D4A0],
  'it': [0x6E6D0BB3, 0x4A0C21BE], 'iu': [0xE72E3799, 0x1B64DB03],
  'iv': [0x966AEEB1, 0x440BCE28], 'iw': [0xABF64371, 0xA4D69070],
  'ix': [0xF024E85E, 0x8A4FC5EE], 'k2': [0xBD441A09, 0xD66E0B80],
  'k4': [0xE7FC275E, 0xEF53679F], 'kb': [0xD7A26C85, 0x96C46632],
  'kc': [0xFE4F6396, 0x925E74AB],
  // Dispatch-referenced wrappers
  'jf': [0xC234521F, 0x09193906], 'jg': [0xA1B2C3D4, 0xE5F60718],
  'jh': [0x12345678, 0x9ABCDEF0], 'au': [0x4774ACB1, 0x4A88D52C],
  'c2': [0x1003BE7A, 0x79125ACE], 'cz': [0x8A3F2B91, 0x4C7E6D05],
  'cw': [0x5D1E9F43, 0xB2A87C61], 'c1': [0x4D8296CF, 0x498FAC8C],
  'cy': [0x7F3A1B52, 0xC8D4E096], 'cv': [0x2E6B8D14, 0xF9A3C750],
  'c0': [0x4774ACB1, 0x4A88D52C], 'cx': [0x9B2F4E87, 0x3D6A1C50],
  'cu': [0x6C1A8F35, 0xE4B29D07], 'tv': [0x8F3C2A71, 0x5B4D9E06],
  'tu': [0x3A7F1B96, 0xC2D4E058],
  // GPEC2A / SRT family 27 level 5 — confirmed working
  'tt': [0x234521F9, 0x19390673],
  'tp': [0x2784580065, 0x1207926729],
  'bq': [0x3055905C, 0x63B2E51D], 'bp': [0x48E00A0B, 0xEC9FE96C],
  'bo': [0x146C7D92, 0x682BF0F6],
  'e1': [0x7A3F9B21, 0x4E8C6D05], 'e2': [0x5C1D8F43, 0xB2A97C61],
  // Additional catalog entries
  's6': [0xC88C0A1C, 0xC4898DB9], 'sa': [0x2312DFD4, 0x99B73441],
  'sk': [0x3505888827, 0x3934495877], 'tk': [0x6920308F, 0xE3585135],
  'tl': [0x6E74BC7D, 0x73CF16F4], 'tm': [0x6920308F, 0xE3585135],
  'tn': [0x6E74BC7D, 0x73CF16F4], 'tq': [0x1763717263, 0x3814215989],
  'tr': [0x1437110741, 0x3076093248], 'ts': [0x1853144189, 0x1942951668],
  'tw': [0xD0BE6BFA, 0x7185EB18],
  'u':  [0x4A9807B4, 0x5C0918D5], 'u9': [0x58AB8D5E, 0x5C7C99BC],
  'ud': [0xCC4F3406, 0xCDF91C1D], 'ue': [0x3174822297, 0x2273766810],
  'up': [0x7674E227, 0xD8AD9C07], 'uq': [0x764D7F71, 0xD35947CC],
  'ur': [0x873659F5, 0x68A6AA0D], 'us': [0x163BCBD2, 0xC499B611],
  'ut': [0x873659F5, 0x68A6AA0D], 'uu': [0x163BCBD2, 0xC499B611],
  'uv': [0x435625172, 0x1994315587], 'uw': [0x1934340573, 0x4080602667],
  'uz': [0x9F50F478, 0x9D832B90],
  'v':  [0x4A9807B4, 0x5C0918D5], 'v0': [0x3174822297, 0x2273766810],
  'v1': [0x3174822297, 0x2273766810], 'v2': [0x7AC0D00D, 0x3F71DB39],
  'v3': [0x3174822297, 0x2273766810], 'v4': [0x70E90220, 0x29E3E35B],
  'v5': [0x45B5684D, 0x43C878E3], 'v8': [0x42457327, 0x538C20CD],
  'vj': [0xA1691FDD, 0x19CF3876], 'vq': [0x2D64EAF0, 0x9911F909],
  'vr': [0xA120C648, 0x95545396], 'vs': [0xAA5D50FA, 0x117DC15E],
  'vt': [0x6153CA35, 0x6BA75C0E], 'vu': [0x5B1730CF, 0xFA2547F3],
  'vv': [0xDA57C6F6, 0x1414A578], 'vw': [0x1299901896, 0x2597287167],
  'vx': [0x3704965747, 0x4248752174],
  'w':  [0x741815DA, 0xB061639C], 'w3': [0x706569626, 0x3550024744],
  'wa': [0x314A9BFA, 0x71A15400], 'wb': [0xCDC93847, 0x8DA9908A],
  'wc': [0x290F6916, 0xFD96E93B], 'wd': [0x2A48A173, 0xD0AEC2D1],
  'we': [0x1633324267, 0x798111859], 'wf': [0x2644133567, 0x385394523],
  'wh': [0x202E7000, 0x5E5E9BB3], 'wj': [0x140DAB32, 0x8839CF69],
  'wl': [0x9C567201, 0x209EDC94], 'wn': [0xA472D002, 0xBFFF74FF],
  'wp': [0xAE9F0E50, 0x9BDE2A39], 'wr': [0x265F14F8, 0xBFBCA106],
  'ws': [0x7C72C58C, 0x4F6CE8AA], 'wt': [0x3D83D147, 0x8D014ADC],
  'wu': [0x5E1443A2, 0xB59F8AC0], 'wv': [0x289FC9B3, 0x82D9782E],
  'ww': [0x67789E8A, 0x67EEDB64], 'wx': [0x2833681403, 0x2035455353],
  'wy': [0x1296008274, 0x4062657934], 'wz': [0x1296008274, 0x4062657934],
  'x':  [0x741815DA, 0xB061639C], 'y':  [0x4A9807B4, 0x5C0918D5],
};

/**
 * Dispatcher: Maps (familyId * 100 + securityLevel) -> wrapper name.
 * familyId = af::ge, securityLevel = af::aj (1-10).
 */
export const DISPATCH = {
  [31 * 100 + 1]: 'jh', [31 * 100 + 3]: 'jg', [31 * 100 + 5]: 'jf',
  [39 * 100 + 1]: 'au',
  [17 * 100 + 1]: 'c2', [17 * 100 + 3]: 'cz', [17 * 100 + 5]: 'cw',
  [21 * 100 + 1]: 'c1', [21 * 100 + 3]: 'cy', [21 * 100 + 5]: 'cv',
  [22 * 100 + 1]: 'c0', [22 * 100 + 3]: 'cx', [22 * 100 + 5]: 'cu',
  // Family 27 = GPEC2A (Charger/Challenger/Durango SRT ECMs)
  [27 * 100 + 1]: 'tv', [27 * 100 + 3]: 'tu', [27 * 100 + 5]: 'tt', [27 * 100 + 7]: 'tp',
  [37 * 100 + 1]: 'bq', [37 * 100 + 3]: 'bp', [37 * 100 + 5]: 'bo',
  [66 * 100 + 1]: 'e1', [66 * 100 + 3]: 'ez', [66 * 100 + 5]: 'e2',
};

/** ECU types with specialized crypto (UCONNECT, RADIO_FGA use XTEA-BE via ao()). */
export const SPECIAL_ECUS = {
  0x149: { name: 'UCONNECT',  algo: 'ao' },
  0x14E: { name: 'RADIO_FGA', algo: 'ao' },
};

/**
 * Known FCA module → algorithm mappings.
 * Based on CAN address, module type, and AlfaOBD dispatch analysis.
 */
export const FCA_MODULE_ALGO = {
  'ECM':   { algo: 'w6', wrapper: 'tt', level: 5, note: 'GPEC2A — Charger/Challenger/Durango SRT' },
  'PCM':   { algo: 'w6', wrapper: 'tt', level: 5, note: 'GPEC2A' },
  'BCM':   { algo: 'ht', level: 1,      note: 'BCM bit-shuffle' },
  'TCM':   { algo: 'w6', wrapper: 'tv', level: 1, note: 'Transmission Control Module' },
  'TIPM':  { algo: 'w6', wrapper: 'tv', level: 1, note: 'Total Integrated Power Module' },
  'SGW':   { algo: 'aes_cmac', level: 0x11, note: 'Security Gateway — AES-CMAC (s84.dll)' },
  'RFHUB': { algo: 'w6', wrapper: 'au', level: 1, note: 'RF Hub' },
  'RADIO': { algo: 'ao', level: 5,      note: 'UConnect — XTEA-BE' },
  'ABS':   { algo: 'w6', wrapper: 'bq', level: 1, note: 'Anti-lock Braking System' },
  'ORC':   { algo: 'w6', wrapper: 'c2', level: 1, note: 'Occupant Restraint Controller' },
  'IPC':   { algo: 'w6', wrapper: 'c0', level: 1, note: 'Instrument Panel Cluster' },
};

// ============================================================
// MAIN DISPATCHER
// ============================================================

/**
 * Compute the UDS security access key from a 4-byte seed.
 *
 * @param {number[]|Uint8Array} seedBytes - 4-byte seed from ECM response
 * @param {object} opts
 *   opts.algorithm: 'w6' | 'ht' | 'f' | 'ao' | 'gpec2a' | 'auto'
 *   opts.wrapper: wrapper name from AOBD_W6_TABLE (for w6 algorithm)
 *   opts.r: custom r parameter (for w6/gpec2a)
 *   opts.s: custom s parameter (for w6/gpec2a)
 *   opts.familyId: AlfaOBD family ID (af::ge) for auto-dispatch
 *   opts.securityLevel: security access level (1-10) for auto-dispatch
 *   opts.ecuType: ECU type code (e.g. 0x149 for UCONNECT)
 * @returns {{ keyBytes: number[], keyHex: string, algorithm: string, sendCommand: string }}
 */
export function computeSeedKey(seedBytes, opts = {}) {
  const seed = Array.from(seedBytes).slice(0, 4);
  if (seed.length < 4) throw new Error('Seed must be at least 4 bytes');

  let algorithmUsed = opts.algorithm || 'auto';
  let wrapperUsed = opts.wrapper;

  // Special ECU type override
  if (opts.ecuType && SPECIAL_ECUS[opts.ecuType]) {
    algorithmUsed = SPECIAL_ECUS[opts.ecuType].algo;
  }

  // Auto-dispatch via family ID + security level
  if (algorithmUsed === 'auto' && opts.familyId != null && opts.securityLevel != null) {
    const dispatchKey = opts.familyId * 100 + opts.securityLevel;
    const wrapper = DISPATCH[dispatchKey];
    if (wrapper) {
      algorithmUsed = 'w6';
      wrapperUsed = wrapper;
    }
  }

  let keyBytes;
  switch (algorithmUsed) {
    case 'w6': {
      let r, s;
      if (wrapperUsed && AOBD_W6_TABLE[wrapperUsed]) {
        [r, s] = AOBD_W6_TABLE[wrapperUsed];
      } else if (opts.r != null && opts.s != null) {
        r = opts.r; s = opts.s;
        wrapperUsed = 'custom';
      } else {
        throw new Error('w6: must provide wrapper name or (r, s) parameters');
      }
      keyBytes = w6(seed, r, s);
      algorithmUsed = `w6(${wrapperUsed})`;
      break;
    }
    case 'gpec2a': {
      const r = opts.r ?? 0x234521F9;
      const s = opts.s ?? 0x19390673;
      keyBytes = gpec2aW6(seed, r, s);
      algorithmUsed = 'gpec2a_w6';
      break;
    }
    case 'ht':
      keyBytes = ht(seed);
      break;
    case 'f':
      keyBytes = f(seed);
      break;
    case 'ao':
      keyBytes = ao(seed);
      break;
    default:
      throw new Error(`Unknown algorithm: ${algorithmUsed}`);
  }

  const keyHex = keyBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const levelByte = opts.securityLevel != null ? (opts.securityLevel + 1) : 0x06;
  const sendCommand = `27 ${levelByte.toString(16).padStart(2, '0').toUpperCase()} ${keyHex}`;

  return { keyBytes, keyHex, algorithm: algorithmUsed, sendCommand };
}

/**
 * Parse a seed from a UDS 67 XX response hex string.
 * e.g. "67 05 C1 FF CB C1" → [0xC1, 0xFF, 0xCB, 0xC1]
 */
export function parseSeedResponse(responseHex) {
  const parts = responseHex.trim().split(/[\s,]+/).map(h => parseInt(h, 16));
  if (parts.length < 6) throw new Error('Seed response too short (need 67 XX s0 s1 s2 s3)');
  return parts.slice(2, 6);
}

/**
 * Format a 4-byte key array as a UDS 27 XX command string.
 */
export function formatKeyCommand(keyBytes, securityLevel = 0x06) {
  const keyHex = keyBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  return `27 ${securityLevel.toString(16).padStart(2, '0').toUpperCase()} ${keyHex}`;
}

/** List all available wrapper names for the UI dropdown. */
export function listWrappers() {
  return Object.keys(AOBD_W6_TABLE).sort();
}
