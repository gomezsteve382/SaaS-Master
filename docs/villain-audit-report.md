# VILLAIN Audit Report — Task #578

**Source:** `VILLAIN_GPEC_COMPLETE_EXTRACTION.zip` → `villain_extraction/VILLAIN_COMPLETE_EXTRACTION.md`  
**Date:** 2026-05-03

## Comparison: VILLAIN vs `algos.js`

| Algorithm | VILLAIN Constant | algos.js Status |
|---|---|---|
| GPEC1 | 670269 | ✅ MATCH |
| GPEC2 q1 | 0xE72E3799 | ✅ MATCH |
| GPEC2 q2 | 0x1B64DB03 | ✅ ADDED (new) |
| GPEC2 Flash q1 | 0x966AEEB1 | ✅ MATCH |
| GPEC2 Flash q2 | 0x440BCE28 | ✅ ADDED (new) |
| GPEC2 EPROM q1 | 0x3F711F5A | ✅ MATCH |
| GPEC2 EPROM q2 | 0xC3573AE9 | ✅ ADDED (new) |
| GPEC2 EPROM q3 | 0x725EF016 | ✅ ADDED (new) |
| GPEC2 EPROM q4 | 0x58329671 | ✅ ADDED (new) |
| GPEC3 EPROM q1 | 0x129D657F | ✅ MATCH |
| GPEC3 EPROM q2 | 0xD0726B89 | ✅ ADDED (new) |
| GPEC2 2015 EPROM q1 | 0x47EC21F8 | ✅ MATCH |
| GPEC2 2015 EPROM q2 | 0xCFB81A2E | ✅ ADDED (new) |
| GPEC2A EPROM q1 | 0xCE853A6F | ✅ MATCH |
| GPEC2A EPROM q2 | 0x3BA8FDC7 | ✅ ADDED (new) |
| NGC NT ("DAIMLERCHRYSLER1" 16B) | confirmed | ✅ MATCH |
| NGC NS (shift_format 8 entries) | 0x9D9F…0x6F8E | ✅ MATCH |
| NGC 14×32-bit pre-computation table | 0x2796144E…0x19111199 | ✅ ADDED (NGC_PRE) |
| TIPM TM bitmask | 0xBAEE,0xE000,0x1C00,0x0380,0x0070,0x0007 | ✅ MATCH |
| TIPM t8001 (SA 0x80) | 0x727B…0xE47E | ✅ MATCH (TT.a) |
| TIPM t3605 (SA 0x36/0x05) | 0x7A44…0x4EDC | ✅ MATCH (TT.b) |
| TIPM t8101 (SA 0x81) | 0x22B5…0x36D6 | ✅ MATCH (TT.c) |
| TIPM t3c (SA 0x3C) | 0x632A…0x00DD | ✅ MATCH (TT.d) |
| TIPM t3608 (SA 0x08) | 0x9110…0x16CC | ✅ ADDED (TT.e) |
| TIPM tc605 (SA 0xC6/0x05) | 0x53CE…0x81A4 | ✅ ADDED (TT.f) |
| JTEC fixed key | "0000" | ✅ MATCH |
| EPS session/DID | 0x67 / 0x6706 | ✅ MATCH (documented in SA_DISPATCH) |
| SA dispatch: 0x42/0x44/0x36 → GPEC2 | confirmed | ✅ WIRED (SA_DISPATCH + pickChainForSA) |
| SA dispatch: 0x08/0x88 → NGC | confirmed | ✅ WIRED |
| SA dispatch: 0x80/0x01/0x81 → NGC level-5 | confirmed | ✅ WIRED |
| SA dispatch: 0x34 → JTEC | confirmed | ✅ WIRED |
| SA dispatch: 0x60 → EPS (cda6) | confirmed | ✅ WIRED |
| SA dispatch: 0x0C → Cummins | confirmed | ✅ WIRED |

## Mismatches Found

None. All constants already in `algos.js` matched VILLAIN exactly.

## Additions Made

1. **8 secondary sxor constants** (`gpec2_q2`, `gpec2f_q2`, `gpec2e_q2/q3/q4`, `gpec3_q2`, `gpec2a_q2`, `gpec15_q2`) — new ALGOS entries with VILLAIN-confirmed values
2. **2 TIPM tables** (`t3608` / TT.e, `tc605` / TT.f) — new ALGOS entries + TIPM_SA_DISPATCH routing
3. **NGC_PRE** (14×32-bit) — exported constant for NGC trans_unlock_level5 variant
4. **SA_DISPATCH** — frozen map of 13 SA levels → algo ids
5. **pickChainForSA(saLevel)** — builds unlock chain with VILLAIN SA routing as preferred first
6. **TIPM_SA_DISPATCH** — routes TIPM SA levels to correct table key
7. **tipmByLevel(seed, saLevel)** — convenience wrapper for SA-aware TIPM routing
8. **tryUnlock saLevel param** — optional 8th arg lets callers pass a known SA level to use pickChainForSA instead of pickUnlockChain

## Pinned Fixture Vectors (seed = 0x12345678)

| id | key |
|---|---|
| gpec1 | 0x469ebb7a |
| gpec2 | 0x6ff897ab |
| gpec2_q2 | 0x70437906 |
| gpec2f | 0xfc35fcd3 |
| gpec2f_q2 | 0xce9d5350 |
| gpec2e | 0x3868f1b4 |
| gpec2e_q2 | 0x0373803b |
| gpec2e_q3 | 0xa2372f2c |
| gpec2e_q4 | 0xf6efe3e2 |
| gpec3 | 0x63b005fe |
| gpec3_q2 | 0x361c739b |
| gpec2a | 0x150581b1 |
| gpec2a_q2 | 0x31db348e |
| gpec15 | 0xc9528cf0 |
| gpec15_q2 | 0x1642e172 |
| ngc(0x12345678) | 0x123186 |
| ngc(0xDEADBEEF) | 0x3cec4c |
| t3608 / tipm(0x1234, 'e') | 0xcae8 |
| tc605 / tipm(0x1234, 'f') | 0x9cf2 |
