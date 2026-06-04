// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/inline-cipher-wrappers-constants.json
//
// Inline cipher wrappers extracted from AlfaOBD.exe's abf() dispatcher.
// These are cipher methods named like 'f2', 'jn', 'il' etc. that are CALLED
// by abf for specific ECU codes but are NOT in the W6/W7 catalog. Each is
// a small (66-600 byte) inline cipher with its own constants.
//
// For each, this file records:
//   - The method index + RVA in AlfaOBD.exe for further decompilation
//   - The arithmetic operations observed in IL (add/mul/xor/and/or/shl/shr)
//   - The non-trivial numeric constants used (filtered: excluded 0, 1, 8,
//     16, 24, 32, 255, 0xFFFF, 0xFFFFFFFF which are common bit masks)
//
// NOTABLE FINDINGS:
//   - 'jn' uses 0x41C64E6D (glibc rand() multiplier) - it's an LCG cipher
//   - 'j3', 'j4', 'j6', 'j7' all share constants 0x25010000 and 0x537E -
//     same cipher family with different level routing
//   - 'jp' uses 64-bit constant 0x1102041108000001 - bitfield permutation
//   - 'il', 'im', 'in', 'w2' use 16-bit XOR masks (0xCA59, 0x781C, 0x7000,
//     0xA59B respectively)
//
// To implement each in JS: decompile the IL at the recorded RVA to
// pseudo-C# via dnSpy/ILSpy, then transcribe the algorithm. The constants
// here serve as a quick check that the decompilation matches reality.

export const INLINE_CIPHER_WRAPPERS_META = {
  totalAnalyzed: 39,
  trulyInlineCiphers: 15,
  note: "Each entry has the method_idx + RVA where the cipher IL lives, plus the constants and arithmetic ops observed. Use as a starting point for full decompilation.",
};

/** Per-wrapper cipher metadata: method index, RVA, IL size, constants, ops. */
export const INLINE_CIPHER_WRAPPERS = {"as":{"method_idx":1020,"rva":"0x75670","il_size":99,"constants_hex":["0x4"],"arith_ops_used":[],"is_inline_cipher":false},"at":{"method_idx":1019,"rva":"0x75600","il_size":99,"constants_hex":["0x4"],"arith_ops_used":[],"is_inline_cipher":false},"di":{"method_idx":921,"rva":"0x73478","il_size":99,"constants_hex":["0x2"],"arith_ops_used":["shl"],"is_inline_cipher":false},"f0":{"method_idx":824,"rva":"0x70814","il_size":339,"constants_hex":["0xFE7000D5"],"arith_ops_used":["shr.un"],"is_inline_cipher":false},"f2":{"method_idx":822,"rva":"0x704B8","il_size":156,"constants_hex":["0x25010000","0x8000","0x9736","0x1C0","0xE00","0x7000"],"arith_ops_used":["add","and","or","shl","shr","xor"],"is_inline_cipher":true},"f3":{"method_idx":821,"rva":"0x70328","il_size":386,"constants_hex":["0x12"],"arith_ops_used":[],"is_inline_cipher":false},"fa":{"method_idx":857,"rva":"0x720B8","il_size":321,"constants_hex":["0x7"],"arith_ops_used":[],"is_inline_cipher":false},"fe":{"method_idx":853,"rva":"0x71CD8","il_size":148,"constants_hex":["0xA"],"arith_ops_used":["shr.un"],"is_inline_cipher":false},"fg":{"method_idx":851,"rva":"0x71A38","il_size":321,"constants_hex":["0xC"],"arith_ops_used":[],"is_inline_cipher":false},"fy":{"method_idx":826,"rva":"0x70BB0","il_size":171,"constants_hex":["0x25010000","0xC010000","0xA721"],"arith_ops_used":["add","and","or","shl","shr","xor"],"is_inline_cipher":true},"ii":{"method_idx":732,"rva":"0x6E00C","il_size":148,"constants_hex":["0x9"],"arith_ops_used":[],"is_inline_cipher":false},"ij":{"method_idx":731,"rva":"0x6DF58","il_size":165,"constants_hex":["0x9"],"arith_ops_used":[],"is_inline_cipher":false},"ik":{"method_idx":730,"rva":"0x6DD68","il_size":482,"constants_hex":["0x12"],"arith_ops_used":["add","shr.un","xor"],"is_inline_cipher":true},"il":{"method_idx":729,"rva":"0x6DC90","il_size":203,"constants_hex":["0xCA59"],"arith_ops_used":["add","and","shl","shr","sub","xor"],"is_inline_cipher":true},"im":{"method_idx":728,"rva":"0x6DBB8","il_size":202,"constants_hex":["0x781C"],"arith_ops_used":["add","and","shl","shr","xor"],"is_inline_cipher":true},"in":{"method_idx":727,"rva":"0x6DB34","il_size":117,"constants_hex":["0x7000"],"arith_ops_used":["add","and","shl","shr","xor"],"is_inline_cipher":true},"io":{"method_idx":726,"rva":"0x6DA7C","il_size":171,"constants_hex":["0xA"],"arith_ops_used":[],"is_inline_cipher":false},"ip":{"method_idx":725,"rva":"0x6D998","il_size":215,"constants_hex":["0xD"],"arith_ops_used":[],"is_inline_cipher":false},"iq":{"method_idx":724,"rva":"0x6D7A8","il_size":482,"constants_hex":["0x12"],"arith_ops_used":["or","xor"],"is_inline_cipher":true},"j3":{"method_idx":675,"rva":"0x6A564","il_size":203,"constants_hex":["0x25010000","0x537E"],"arith_ops_used":["add","and","shl","shr","xor"],"is_inline_cipher":true},"j4":{"method_idx":674,"rva":"0x6A48C","il_size":203,"constants_hex":["0x25010000","0x537E"],"arith_ops_used":["add","and","shl","shr","xor"],"is_inline_cipher":true},"j5":{"method_idx":673,"rva":"0x6A270","il_size":528,"constants_hex":["0x11"],"arith_ops_used":["add","or","xor"],"is_inline_cipher":true},"j6":{"method_idx":672,"rva":"0x6A198","il_size":203,"constants_hex":["0x25010000","0x537E"],"arith_ops_used":["add","and","shl","shr","xor"],"is_inline_cipher":true},"j7":{"method_idx":671,"rva":"0x6A0C0","il_size":203,"constants_hex":["0x25010000","0x537E"],"arith_ops_used":["add","and","shl","shr","xor"],"is_inline_cipher":true},"jb":{"method_idx":703,"rva":"0x6CD88","il_size":99,"constants_hex":[],"arith_ops_used":[],"is_inline_cipher":false},"jc":{"method_idx":702,"rva":"0x6CD18","il_size":99,"constants_hex":["0xE"],"arith_ops_used":[],"is_inline_cipher":false},"ji":{"method_idx":696,"rva":"0x6C5E8","il_size":99,"constants_hex":["0x5"],"arith_ops_used":[],"is_inline_cipher":false},"jk":{"method_idx":694,"rva":"0x6C4D0","il_size":154,"constants_hex":["0xF"],"arith_ops_used":[],"is_inline_cipher":false},"jl":{"method_idx":693,"rva":"0x6C460","il_size":99,"constants_hex":["0xB"],"arith_ops_used":["shr.un"],"is_inline_cipher":false},"jn":{"method_idx":691,"rva":"0x6C1B4","il_size":66,"constants_hex":["0x33F6D311","0x41C64E6D","0x3039"],"arith_ops_used":["add","mul","xor"],"is_inline_cipher":true},"jp":{"method_idx":689,"rva":"0x6BEE8","il_size":591,"constants_hex":["0xC010000","0xD010000","0x1102041108000001"],"arith_ops_used":["add","and","or","xor"],"is_inline_cipher":true},"jq":{"method_idx":688,"rva":"0x6BE78","il_size":99,"constants_hex":["0x11"],"arith_ops_used":[],"is_inline_cipher":false},"k9":{"method_idx":633,"rva":"0x690C0","il_size":99,"constants_hex":["0x5"],"arith_ops_used":["shr.un"],"is_inline_cipher":false},"lf":{"method_idx":627,"rva":"0x6861C","il_size":390,"constants_hex":["0x2"],"arith_ops_used":[],"is_inline_cipher":false},"w0":{"method_idx":210,"rva":"0x6061C","il_size":99,"constants_hex":["0x12"],"arith_ops_used":[],"is_inline_cipher":false},"w1":{"method_idx":209,"rva":"0x605AC","il_size":99,"constants_hex":["0x9"],"arith_ops_used":[],"is_inline_cipher":false},"w2":{"method_idx":208,"rva":"0x60528","il_size":118,"constants_hex":["0xA59B"],"arith_ops_used":["add","and","shl","shr","xor"],"is_inline_cipher":true},"w5":{"method_idx":205,"rva":"0x600E8","il_size":99,"constants_hex":["0x5"],"arith_ops_used":[],"is_inline_cipher":false},"w6":{"method_idx":204,"rva":"0x60050","il_size":138,"constants_hex":[],"arith_ops_used":["add","and","mul","shl","shr","sub","xor"],"is_inline_cipher":false}};

/** Notable findings — wrappers with identifiable cipher structures. */
export const NOTABLE_INLINE_CIPHERS = {
  jn_LCG: {
    method_idx: 691,
    rva: "0x6C1B4",
    cipher_type: "Linear Congruential Generator (LCG)",
    multiplier: "0x41C64E6D (glibc rand() multiplier)",
    increment: "0x3039 (12345 = glibc rand() increment)",
    state_bias: "0x33F6D311",
    js_template: "key = (((seed * 0x41C64E6D) + 0x3039) ^ 0x33F6D311) & 0xFFFFFFFF",
  },
  j3_family: {
    members: ["j3", "j4", "j6", "j7"],
    shared_constants: ["0x25010000", "0x537E"],
    cipher_type: "Bit-shuffle with XOR mask",
  },
  il_xor16: { constant: "0xCA59", method_idx: 729 },
  im_xor16: { constant: "0x781C", method_idx: 728 },
  in_xor16: { constant: "0x7000", method_idx: 727 },
  w2_xor16: { constant: "0xA59B", method_idx: 208 },
};
