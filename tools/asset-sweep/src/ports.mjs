/**
 * Hand-ported seed-key algorithms for the asset sweep.
 *
 * Each entry is the source-of-truth JavaScript translation of a Python
 * algorithm discovered in `attached_assets/`. The sweep tool serializes
 * these into `artifacts/srt-lab/src/lib/extendedAlgorithms.generated.js`
 * and verifies every port against its pinned vectors before emitting.
 *
 * Vector source: every `_VECTORS` table in `srtlab_canflash_algos.py`
 * (8 vectors per algorithm, hand-verified byte-identical against Unicorn
 * emulation of the original Chrysler J2534 DLLs). For algorithms whose
 * Python source ships without vectors (`bcm_standard`, `bcm_fca` from
 * `srt_lab.py`), vectors were derived from the closed-form expression in
 * the Python docstring and pinned here so a future drift in either side
 * triggers an immediate test failure.
 *
 * `coverageStatus` per entry — consumed by the normalized findings file.
 * The status set is exactly the three values the unlock-coverage contract
 * specifies:
 *   - "already-implemented" — canonical tag is present in the in-app
 *                             catalogs (algos.js / canflashAlgos.js /
 *                             alfaobdAlgorithms.generated.js), or this
 *                             discovery is a utility helper whose Python
 *                             counterpart already lives in the codebase.
 *   - "partial-match"       — canonical tag is not a direct hit but its
 *                             stem (after stripping common suffixes) does
 *                             match a known tag — flagged for human review.
 *   - "new"                 — neither covered nor a stem-match. Hand-ported
 *                             entries below carry `ported: true` so the
 *                             reviewer can see at a glance which "new"
 *                             findings already have an executable JS port
 *                             in this same sweep output.
 */

// ── Helpers ────────────────────────────────────────────────────────────
//
// All ports use unsigned 32-bit semantics — `>>> 0` after every operation
// that could overflow 32 bits. For multiplications that would exceed 53
// bits (the JS Number precision boundary), we rely on Math.imul which
// performs a 32-bit signed multiply and returns the low 32 bits; combined
// with `>>> 0` this gives the unsigned u32 product matching Python's
// `(a * b) & 0xFFFFFFFF`.

function _u32(n) { return n >>> 0; }

// ── Algorithm bodies ──────────────────────────────────────────────────
//
// These are intentionally written in plain ES2018 so the sweep tool can
// `Function.prototype.toString` them and emit verbatim into the generated
// file (no Babel / minifier in the pipeline). Helpers used inside an
// algorithm body (e.g. `_AISIN_STACK`, `NGC_*_TABLE`) are inlined so each
// `fn.toString()` is self-contained.

function aisin_tcm(seed) {
  seed = seed >>> 0;
  const STACK = [
    0x2345, 0x6789, 0xabc7, 0xcdef, 0x0123, 0x2345, 0x6789, 0xabcd,
    0x2345, 0x6789, 0xabc7, 0xcdef, 0x0123, 0x2345, 0x6789, 0xabcd,
  ];
  const idx = seed & 7;
  let eax = seed;
  const mod_ax = (v) => { eax = ((eax & 0xFFFF0000) | (v & 0xFFFF)) >>> 0; };
  mod_ax((eax & 0xFFFF) - STACK[idx + 0]);
  eax = (eax + 0x7E55) >>> 0;
  mod_ax(((eax & 0xFFFF) * STACK[idx + 1]) & 0xFFFF);
  eax = (~eax) >>> 0;
  mod_ax((eax & 0xFFFF) - STACK[idx + 3]);
  mod_ax((eax & 0xFFFF) + STACK[idx + 2]);
  mod_ax(((eax & 0xFFFF) * STACK[idx + 4]) & 0xFFFF);
  eax = (~eax) >>> 0;
  mod_ax((eax & 0xFFFF) - STACK[idx + 6]);
  mod_ax((eax & 0xFFFF) + STACK[idx + 5]);
  mod_ax(((eax & 0xFFFF) * STACK[idx + 7]) & 0xFFFF);
  eax = (~eax) >>> 0;
  return eax;
}

function alpine_radio(seed) {
  // LCG pair with constants distinct from alpine_rak / dcx_ptcm; the
  // second LCG always feeds in `arg2 = 0` because the Python signature
  // defaults `arg2=0` and no Chrysler dispatcher wires a non-zero value.
  const a = (Math.imul(seed >>> 0, 0x32A95B7F | 0) + 0x52D8) >>> 0;
  const b = (Math.imul(0, 0x32A95B7F | 0) + 0x52D8) >>> 0;
  return (a ^ b ^ 0x58C2) >>> 0;
}

function bcm_standard(seed) {
  // BCM Standard — closed form `seed * 0x9D + 0x1234`. 0x9D fits a
  // 32-bit multiply without Math.imul, but we use it anyway for
  // consistency with the higher-multiplier algorithms below.
  return (Math.imul(seed >>> 0, 0x9D) + 0x1234) >>> 0;
}

function bcm_fca(seed) {
  // BCM FCA — `((seed ^ 0xABCDEF12) * 0x4D + 0x5678)`.
  return (Math.imul((seed ^ 0xABCDEF12) >>> 0, 0x4D) + 0x5678) >>> 0;
}

function cummins_849(seed) {
  seed = seed >>> 0;
  const T = [
    0x1ce32951, 0x8bb28c39, 0x76c6da1a, 0xe0b69a47,
    0xf356024c, 0x60af852b, 0x63a12ac7, 0x53ff8daf,
    0xa8f7e36c, 0x63e92252, 0x2cd56fe4, 0x2e3ef306,
    0x5b0a976f, 0xdb6cfa03, 0x19ccb5a4, 0x8113b235,
  ];
  const idx = (seed >>> 20) & 0xF;
  let k = T[(idx + 2) & 0xF];
  k = (k ^ T[(idx + 3) & 0xF]) >>> 0;
  k = (k ^ T[(idx + 1) & 0xF]) >>> 0;
  k = (k ^ T[(idx + 0) & 0xF]) >>> 0;
  const edx = (seed + 0x55111511) >>> 0;
  return (k ^ edx) >>> 0;
}

function dcx_ptcm(seed) {
  // LCG pair XOR — same Park-Miller multiplier as alpine_rak but a
  // different mixing constant. arg2 always 0 (no Chrysler dispatcher
  // path supplies a non-zero second word).
  const a = (Math.imul(seed >>> 0, 0x41C64E6D | 0) + 0x3039) >>> 0;
  const b = (Math.imul(0, 0x41C64E6D | 0) + 0x3039) >>> 0;
  return (a ^ b ^ 0xF3DD1133) >>> 0;
}

function egs52(seed) {
  // Mercedes EGS52 — `(seed ^ 0x5AA5A5A5) * 0x5AA5A5A5`. The product
  // exceeds 2^53 so Math.imul is mandatory.
  return Math.imul((seed ^ 0x5AA5A5A5) >>> 0, 0x5AA5A5A5 | 0) >>> 0;
}

function mitsubishi_rar(seed) {
  // Mitsubishi RAR — `((seed ^ 0x7368) * 2 + 0x2A) ^ 0x6974`.
  const eax = (seed ^ 0x7368) >>> 0;
  const ecx = ((eax << 1) + 0x2A) >>> 0;
  return (ecx ^ 0x6974) >>> 0;
}

function ptim_lx(seed) {
  seed = seed >>> 0;
  const T = [0xd785, 0xd95b, 0x68e7, 0x8a4f, 0x7f8b, 0x8ae8, 0x6f21, 0x9a69];
  const i0 = (seed >>> 13) & 7;
  const i1 = (seed >>> 10) & 7;
  // Note the intentionally unusual i2 packing — bit 7 is dropped, then
  // bit 6 of seed is OR'd back in. Matches the Python source byte-for-byte.
  const i2 = ((seed >>> 7) & 6) | ((seed >>> 6) & 1);
  const i3 = (seed >>> 3) & 7;
  const i4 = seed & 7;
  let k = T[i0];
  k = (k ^ T[i1]) >>> 0;
  k = (k ^ T[i2]) >>> 0;
  k = (k ^ T[i3]) >>> 0;
  k = (k ^ T[i4]) >>> 0;
  k = (k ^ (seed & 0xFFFF)) >>> 0;
  return ((seed & 0xFFFF0000) | (k & 0xFFFF)) >>> 0;
}

// ── Registry ──────────────────────────────────────────────────────────
//
// Each PORT entry carries the metadata the sweep needs to render a row
// in the generated catalog plus a `vectors` list to verify the
// implementation. `coverageStatus` annotations mirror the values
// produced in `findings.generated.json` so downstream tools can join
// the two artifacts on `tag`.

export const PORTS = [
  {
    tag: "aisin_tcm",
    label: "Aisin AS68/69 TCM",
    pythonName: "aisin_tcm_unlock",
    params: "seed",
    doc: "Aisin AS68RC/AS69RC TCM — 3-stage sub/add/imul/not chain, indexed by seed & 7.",
    signatures: ["CANFLASH_TABLE_LOOKUP"],
    coverageStatus: "new",
    fn: aisin_tcm,
    vectors: [
      {seed: 0x00000000, key: 0xFFFE2831},
      {seed: 0x12345678, key: 0xEDCB14A9},
      {seed: 0xA1B2C3D4, key: 0x5E4CCCEF},
      {seed: 0xDEADBEEF, key: 0x2152D3BC},
      {seed: 0xFFFFFFFF, key: 0x00008C8C},
      {seed: 0x00000001, key: 0xFFFE9C88},
      {seed: 0xCAFEBABE, key: 0x35016F93},
      {seed: 0x55555555, key: 0xAAAAD2B8},
    ],
  },
  {
    tag: "alpine_radio",
    label: "Alpine RA3/RA4 radio (mid-spec UConnect 4)",
    pythonName: "alpine_radio_unlock",
    params: "seed, arg2=0",
    doc: "Alpine RA3/RA4 radio — different LCG constants, XOR 0x58C2.",
    signatures: ["LCG_PAIR"],
    coverageStatus: "new",
    fn: alpine_radio,
    vectors: [
      {seed: 0x00000000, key: 0x000058C2},
      {seed: 0x12345678, key: 0x27EBEA7A},
      {seed: 0xA1B2C3D4, key: 0x723FDF1E},
      {seed: 0xDEADBEEF, key: 0xF4D80A73},
      {seed: 0xFFFFFFFF, key: 0xCD56FD43},
      {seed: 0x00000001, key: 0x32A9A44D},
      {seed: 0xCAFEBABE, key: 0xA42E8B00},
      {seed: 0x55555555, key: 0x99C7D519},
    ],
  },
  {
    tag: "bcm_fca",
    label: "BCM FCA (BCM 2016+, srt_lab.py)",
    pythonName: "algo_bcm_fca",
    params: "seed",
    doc: "BCM FCA — `((seed ^ 0xABCDEF12) * 0x4D + 0x5678)`. Exclusive to srt_lab.py.",
    signatures: ["LINEAR_MUL_XOR"],
    coverageStatus: "new",
    fn: bcm_fca,
    vectors: [
      {seed: 0x00000000, key: 0xACF13EE2},
      {seed: 0x12345678, key: 0xF01D1B5A},
      {seed: 0xA1B2C3D4, key: 0x2840CE06},
      {seed: 0xDEADBEEF, key: 0x4DF8FF91},
      {seed: 0xFFFFFFFF, key: 0x530F6DC1},
      {seed: 0x00000001, key: 0xACF13F2F},
      {seed: 0xCAFEBABE, key: 0x3C711B34},
      {seed: 0x55555555, key: 0x93F05DD3},
    ],
  },
  {
    tag: "bcm_standard",
    label: "BCM Standard (BCM 2007-2015, srt_lab.py)",
    pythonName: "algo_bcm_standard",
    params: "seed",
    doc: "BCM Standard — `seed * 0x9D + 0x1234`. Exclusive to srt_lab.py.",
    signatures: ["LINEAR_MUL"],
    coverageStatus: "new",
    fn: bcm_standard,
    vectors: [
      {seed: 0x00000000, key: 0x00001234},
      {seed: 0x12345678, key: 0x2A1919CC},
      {seed: 0xA1B2C3D4, key: 0x2AA22B38},
      {seed: 0xDEADBEEF, key: 0x908E2AC7},
      {seed: 0xFFFFFFFF, key: 0x00001197},
      {seed: 0x00000001, key: 0x000012D1},
      {seed: 0xCAFEBABE, key: 0x7E3898BA},
      {seed: 0x55555555, key: 0x55556755},
    ],
  },
  {
    tag: "cummins_849",
    label: "Cummins ISB 6.7L (CM2100/CM2200)",
    pythonName: "cummins_849_unlock",
    params: "seed",
    doc: "Cummins ISB 6.7L — 16-entry 32-bit table, 4 rotating XORs + seed + 0x55111511.",
    signatures: ["CANFLASH_TABLE_LOOKUP"],
    coverageStatus: "new",
    fn: cummins_849,
    vectors: [
      {seed: 0x00000000, key: 0x5430F024},
      {seed: 0x12345678, key: 0x77AB5C6E},
      {seed: 0xA1B2C3D4, key: 0x4157F32B},
      {seed: 0xDEADBEEF, key: 0xB133258E},
      {seed: 0xFFFFFFFF, key: 0x3595D857},
      {seed: 0x00000001, key: 0x5430F027},
      {seed: 0xCAFEBABE, key: 0x408B0288},
      {seed: 0x55555555, key: 0x5260AB49},
    ],
  },
  {
    tag: "dcx_ptcm",
    label: "DCX PowerTrain Control Module",
    pythonName: "dcx_ptcm_unlock",
    params: "seed, arg2=0",
    doc: "DCX PTCM — LCG(0x41C64E6D, 0x3039) pair ^ 0xF3DD1133.",
    signatures: ["LCG_PAIR"],
    coverageStatus: "new",
    fn: dcx_ptcm,
    vectors: [
      {seed: 0x00000000, key: 0xF3DD1133},
      {seed: 0x12345678, key: 0xF8ACB05B},
      {seed: 0xA1B2C3D4, key: 0x691D0877},
      {seed: 0xDEADBEEF, key: 0xEFDC6CF6},
      {seed: 0xFFFFFFFF, key: 0x4DE4C0C6},
      {seed: 0x00000001, key: 0xB21B5FAC},
      {seed: 0xCAFEBABE, key: 0x4B92B615},
      {seed: 0x55555555, key: 0x19CE4A60},
    ],
  },
  {
    tag: "egs52",
    label: "Mercedes EGS52 (7G-Tronic)",
    pythonName: "egs52_unlock",
    params: "seed",
    doc: "Mercedes EGS52 — (seed ^ 0x5AA5A5A5) * 0x5AA5A5A5.",
    signatures: ["LINEAR_MUL_XOR"],
    coverageStatus: "new",
    fn: egs52,
    vectors: [
      {seed: 0x00000000, key: 0xF5E01C59},
      {seed: 0x12345678, key: 0xB7B09E71},
      {seed: 0xA1B2C3D4, key: 0xABF0DBD5},
      {seed: 0xDEADBEEF, key: 0xED8248B2},
      {seed: 0xFFFFFFFF, key: 0xAF7A3E02},
      {seed: 0x00000001, key: 0x9B3A76B4},
      {seed: 0xCAFEBABE, key: 0x502E7367},
      {seed: 0x55555555, key: 0x3C45FAB0},
    ],
  },
  {
    tag: "mitsubishi_rar",
    label: "Mitsubishi RAR (5\" UConnect 3)",
    pythonName: "mitsubishi_rar_unlock",
    params: "seed",
    doc: "Mitsubishi RAR — ((seed ^ 0x7368) * 2 + 0x2A) ^ 0x6974.",
    signatures: ["LINEAR_MUL_XOR"],
    coverageStatus: "new",
    fn: mitsubishi_rar,
    vectors: [
      {seed: 0x00000000, key: 0x00008F8E},
      {seed: 0x12345678, key: 0x2468233E},
      {seed: 0xA1B2C3D4, key: 0x436508D6},
      {seed: 0xDEADBEEF, key: 0xBD5BF24C},
      {seed: 0xFFFFFFFF, key: 0xFFFF702C},
      {seed: 0x00000001, key: 0x00008F88},
      {seed: 0xCAFEBABE, key: 0x95FDFAA2},
      {seed: 0x55555555, key: 0xAAAA25D0},
    ],
  },
  {
    tag: "ptim_lx",
    label: "PowerTrain Integrated Module (LX)",
    pythonName: "ptim_lx_unlock",
    params: "seed",
    doc: "PowerTrain Integrated Module (LX) — 5 table XORs with unusual i2 packing.",
    signatures: ["CANFLASH_TABLE_LOOKUP"],
    coverageStatus: "new",
    fn: ptim_lx,
    vectors: [
      {seed: 0x00000000, key: 0x0000D785},
      {seed: 0x12345678, key: 0x12347373},
      {seed: 0xA1B2C3D4, key: 0xA1B2F675},
      {seed: 0xDEADBEEF, key: 0xDEAD3407},
      {seed: 0xFFFFFFFF, key: 0xFFFF6596},
      {seed: 0x00000001, key: 0x0000D95A},
      {seed: 0xCAFEBABE, key: 0xCAFED5B4},
      {seed: 0x55555555, key: 0x5555DF1A},
    ],
  },
];

// Tags discovered in attached_assets/ that are NOT seed→key cipher
// implementations and therefore intentionally not ported. They appear
// in the normalized findings file with their `coverageStatus` so the
// reviewer can see why they were skipped.
export const NON_CIPHER_FINDINGS = [
  {
    tag: "check_trivial_transforms",
    pythonName: "check_trivial_transforms",
    params: "seed, key",
    coverageStatus: "already-implemented",
    rationale:
      "Diagnostic helper — checks if a captured (seed, key) pair matches a"
      + " trivial transform (identity, byte-reverse, NOT, ROL/ROR…). Not a"
      + " unlock cipher; lives in srtlab_seedkey_capture.py for offline"
      + " forensics. The corresponding helper already lives in the in-repo"
      + " python toolchain — no JS port needed.",
  },
  {
    tag: "w6_by_name",
    pythonName: "w6_by_name",
    params: "seed, name",
    coverageStatus: "already-implemented",
    rationale:
      "Dispatcher wrapper — looks up (r, s) from AOBD_W6_TABLE and forwards"
      + " to `w6(seed, r, s)`. The cipher itself (`w6`) is already in"
      + " algos.js as `alfaW6` / `alfaW6By`, surfaced in SeedTab via the"
      + " AlfaOBD lookup row and `alfa_w6_*` ALGOS entries.",
  },
];

/**
 * Run every port through its pinned vectors. Returns a verification
 * report `{tag, total, failed: [{seed, expected, got}]}` per algorithm.
 * The sweep tool refuses to emit if any vector fails.
 */
export function verifyAllPorts() {
  const report = [];
  for (const p of PORTS) {
    const failed = [];
    for (const v of p.vectors) {
      const got = p.fn(v.seed) >>> 0;
      if (got !== (v.key >>> 0)) {
        failed.push({seed: v.seed, expected: v.key, got});
      }
    }
    report.push({tag: p.tag, total: p.vectors.length, failed});
  }
  return report;
}
