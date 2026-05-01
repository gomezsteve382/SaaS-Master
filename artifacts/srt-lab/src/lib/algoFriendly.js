// Friendly labels + short tooltip descriptions for the algorithm-family tags
// emitted by the unlock catalog generator. Single source of truth so the badge
// in the table cell, the expanded details row, and the test fixtures all
// agree on copy.
//
// Each entry has:
//   label       — the mechanic-readable name shown on the badge
//   description — short tooltip text (one sentence) explaining what the
//                 family does or how it was identified
//   placeholder — true if the underlying tag is a freeform note rather than
//                 a real algorithm family ("unfit", "bitpack", "cummins-style?").
//                 The badge renders these in a muted "uncategorized" pill so
//                 the table reads consistently.
//
// New algorithm tags should be added here as soon as they appear in COVERAGE
// or _EXTRA_ALGORITHMS in tools/python-bridge/tools/srtlab_unlock_catalog_gen.py.
export const ALGO_FRIENDLY = {
  t8_xor: {
    label: "8-bit XOR table",
    description: "Folds the seed through a fixed 8-entry XOR substitution table.",
  },
  "t8_xor (32-bit)": {
    label: "8-bit XOR table (32-bit key)",
    description: "Same 8-entry XOR table, but the result is widened to a 32-bit key.",
  },
  "t8_xor+bitpack": {
    label: "8-bit XOR + bit-pack",
    description: "8-entry XOR table followed by a bit-packing permutation of the result.",
  },
  "t8_xor+rotate": {
    label: "8-bit XOR + rotate",
    description: "8-entry XOR table followed by a fixed bit rotation of the key bytes.",
  },
  "t8_add+bitpack": {
    label: "8-bit ADD + bit-pack",
    description: "8-entry additive table followed by a bit-packing permutation of the result.",
  },
  "t8_add+imul": {
    label: "8-bit ADD + IMUL",
    description: "8-entry additive table followed by a signed integer multiply.",
  },
  t8_chain: {
    label: "8-bit chained table",
    description: "8-entry table where each output byte feeds into the next round.",
  },
  "t8_chain+crc": {
    label: "8-bit chained table + CRC",
    description: "Chained 8-entry table with a CRC pass mixed into the final key.",
  },
  "t8_chain+rot": {
    label: "8-bit chained table + rotate",
    description: "Chained 8-entry table with a fixed rotation applied to the final key.",
  },
  t8_mul_seed: {
    label: "8-bit MUL seed",
    description: "8-entry table whose entries are multiplied against the seed.",
  },
  t8_5tap_chain_xor: {
    label: "8-bit 5-tap chain XOR",
    description: "5-tap chained XOR over an 8-entry table — closer to a small LFSR.",
  },
  t16_mul: {
    label: "16-bit MUL",
    description: "16-entry table feeding a multiplicative key derivation.",
  },
  t16_gf2: {
    label: "16-bit GF(2)",
    description: "16-entry table mixed under GF(2) arithmetic (XOR-only field).",
  },
  t16x32_mixed_mul_xor: {
    label: "16×32 mixed MUL/XOR",
    description: "16-entry table feeding a mixed 32-bit multiply/XOR network.",
  },
  t32_8row_substitution: {
    label: "32-bit 8-row substitution",
    description: "32-bit substitution network over eight parallel rows.",
  },
  lcg_pair: {
    label: "LCG pair (Park–Miller)",
    description: "Two Park–Miller linear-congruential generators combined into a 32-bit key.",
  },
  lcg_halves: {
    label: "LCG halves",
    description: "LCG run independently on the high and low halves of the seed, then merged.",
  },
  rol16_chain_2pass: {
    label: "ROL16 2-pass chain",
    description: "Two passes of 16-bit rotate-left over a chained accumulator.",
  },
  gf2_4x4_substitution: {
    label: "GF(2) 4×4 substitution",
    description: "GF(2) substitution arranged as a 4×4 nibble matrix.",
  },
  hitag2_lfsr48: {
    label: "Hitag2 LFSR-48",
    description: "Classic 48-bit Hitag2 linear-feedback shift register, as used by WCM/SKIM.",
  },
  crc32_feistel_8round: {
    label: "CRC32 Feistel (8 rounds)",
    description: "Eight Feistel rounds with CRC32 as the round function.",
  },
  "tea-feistel": {
    label: "TEA Feistel",
    description: "Feistel network using the Tiny Encryption Algorithm round function.",
  },
  cummins_t16: {
    label: "Cummins 16-bit table",
    description: "Verified Cummins-style 16-entry table, as used on the 6.7L diesel ECMs.",
  },
  bit_driven_accum: {
    label: "Bit-driven accumulator",
    description: "Accumulator updated bit-by-bit over the seed — slow but distinctive.",
  },
  imul_xor: {
    label: "IMUL + XOR",
    description: "Signed integer multiply followed by an XOR mix.",
  },
  "imul+t8": {
    label: "IMUL + 8-bit table",
    description: "Signed integer multiply followed by an 8-entry XOR table.",
  },
  "~s*K": {
    label: "~seed × constant",
    description: "Bitwise-NOT the seed, then multiply by a fixed constant K.",
  },
  inline: {
    label: "Inline expression",
    description: "Short inline arithmetic expression — no table or network involved.",
  },
  simple: {
    label: "Simple XOR",
    description: "Single XOR against a fixed mask — the simplest family.",
  },

  // ── Placeholders ──────────────────────────────────────────────────────────
  // These tags exist in the underlying coverage data but are notes, not real
  // algorithm families. They render in a muted "uncategorized" pill so the
  // table reads consistently.
  unfit: {
    label: "Uncategorized",
    description:
      "Bespoke routine that does not match any reverse-engineered family yet — needs categorisation.",
    placeholder: true,
  },
  bitpack: {
    label: "Uncategorized · bit-pack",
    description:
      "Raw bit-packing observed in the DLL; the surrounding algorithm family has not been identified yet.",
    placeholder: true,
  },
  "cummins-style?": {
    label: "Uncategorized · Cummins-like",
    description:
      "Heuristic match for a Cummins-style table — still pending verification against a real dump.",
    placeholder: true,
  },
};

// Lookup helper. Returns the friendly entry for a tag, or a synthetic entry
// using the raw tag as the label when no mapping exists. Always returns an
// object shaped like { label, description, placeholder } so callers don't
// need to null-check fields.
export function friendlyAlgo(tag) {
  if (!tag) return null;
  const hit = ALGO_FRIENDLY[tag];
  if (hit) return hit;
  return {
    label: tag,
    description: `Raw algorithm tag (no friendly mapping yet): ${tag}`,
    placeholder: false,
  };
}
