/* Catalog of real-world ECU fixture dumps (mirrors README.md in
 * src/__tests__/fixtures/). Used by the in-tab "Load sample" pickers so
 * users can smoke-test parser/sync/pairing tabs without supplying their
 * own dumps. Keep this in sync with the fixtures README. */

const fixtureUrls = import.meta.glob(
  "../__tests__/fixtures/*.bin",
  { query: "?url", import: "default", eager: true }
);

/* kind values group fixtures by what each tab knows how to parse:
 *   BCM         — BCM DFLASH (8 KB demo or 64 KB full)
 *   95640       — 95640 EXT EEPROM
 *   GPEC_EXT    — GPEC2A external EEPROM
 *   GPEC_INT    — GPEC2A internal program flash
 *   RFH_EEE     — RFHUB external EEPROM (24C32-style)
 *   RFH_PFLASH  — RFHUB program flash
 *   SMARTBOX    — Dodge Journey SmartBox EEPROM
 */
export const SAMPLE_FIXTURES = [
  { file:"SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin", kind:"BCM", size:65536, vin:"2C3CDXL90MH582899", role:"SYNCED",
    pair:"synced-MH582899", notes:"Original synced pair — pairs with matching RFH" },
  { file:"SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin", kind:"RFH_EEE", size:4096, vin:"2C3CDXL90MH582899", role:"SYNCED/VIRGIN",
    pair:"synced-MH582899", notes:"Original synced pair — pairs with matching BCM" },

  { file:"SAMPLE_BCM_DFLASH_18TH_DEMO_OG.bin", kind:"BCM", size:8192, vin:null, role:"DEMO_OG",
    notes:"Truncated 8 KB demo (short-read handling)" },
  { file:"SAMPLE_BCM_DFLASH_18TH_DEMO_PATCHED.bin", kind:"BCM", size:65536, vin:null, role:"DEMO_PATCHED",
    notes:"Patched demo — diff vs DEMO_OG to see deltas" },
  { file:"SAMPLE_BCM_DFLASH_18TH_DEMO_VIN_CRC_1C4RJFDJ7DC513874.bin", kind:"BCM", size:65536, vin:"1C4RJFDJ7DC513874", role:"DEMO_VIN_CRC",
    pair:"trackhawk-1", notes:"Trackhawk #1 set (BCM + 95640 ×2)" },
  { file:"SAMPLE_BCM_DFLASH_18TH_DEMO_VIN_CRC_1C4RJFDJXEC365477.bin", kind:"BCM", size:65536, vin:"1C4RJFDJXEC365477", role:"DEMO_VIN_CRC",
    pair:"trackhawk-2", notes:"Trackhawk #2" },
  { file:"SAMPLE_BCM_DFLASH_18TH_OG.bin", kind:"BCM", size:65536, vin:null, role:"OG",
    notes:"Real Trackhawk BCM original" },
  { file:"SAMPLE_BCM_DFLASH_18TH_OG_VARIANT2.bin", kind:"BCM", size:65536, vin:null, role:"OG",
    notes:"Second Trackhawk BCM (different unit)" },
  { file:"SAMPLE_BCM_DFLASH_18TH_OG_CRC.bin", kind:"BCM", size:65536, vin:null, role:"OG_CRC",
    notes:"Trackhawk BCM OG with CRC slots populated" },

  { file:"SAMPLE_95640_EXT_EEPROM_18TH_BAMA_OG.bin", kind:"95640", size:8192, vin:null, role:"OG",
    notes:"Trackhawk external EEPROM (BAMA tuner unit)" },
  { file:"SAMPLE_95640_EXT_EEPROM_18TH_BAMA_VIN_CRC_1C4RJFDJ7DC513874.bin", kind:"95640", size:8192, vin:"1C4RJFDJ7DC513874", role:"VIN_CRC",
    pair:"trackhawk-1", notes:"Trackhawk #1 set" },
  { file:"SAMPLE_95640_EXT_EEPROM_FCA_DK_OG.bin", kind:"95640", size:65536, vin:null, role:"OG",
    notes:"Generic FCA 95640 OG (64 KB padded capture)" },
  { file:"SAMPLE_95640_EXT_EEPROM_FCA_04120001_OG.bin", kind:"95640", size:8192, vin:null, role:"OG",
    notes:"FCA 95640 part 04120001 OG" },
  { file:"SAMPLE_95640_EXT_EEPROM_FCA_04120001_VIN_CRC_1C4RJFDJ7DC513874.bin", kind:"95640", size:8192, vin:"1C4RJFDJ7DC513874", role:"VIN_CRC",
    pair:"trackhawk-1", notes:"Trackhawk #1 set" },

  { file:"SAMPLE_GPEC2A_EXT_EEPROM_18TH_OG.bin", kind:"GPEC_EXT", size:8192, vin:null, role:"OG",
    notes:"Trackhawk PCM EXT EEPROM (8 KB doubled capture)" },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_JOVENTINO_OG.bin", kind:"GPEC_EXT", size:65536, vin:null, role:"OG",
    pair:"joventino", notes:"Joventino Charger 6.2 PCM EXT (64 KB padded)" },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_VIN_CRC_2C3CDXCT1HH652640.bin", kind:"GPEC_EXT", size:393216, vin:"2C3CDXCT1HH652640", role:"VIN_CRC",
    pair:"mitchell-62", notes:"Mitchell 6.2 RFH↔PCM pair (384 KB padded)" },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_VIRGIN_OG.bin", kind:"GPEC_EXT", size:4096, vin:null, role:"VIRGIN",
    notes:"Virgin (blank) GPEC2A EXT" },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_VIRGIN_SYNCED_62.bin", kind:"GPEC_EXT", size:4096, vin:null, role:"VIRGIN_SYNCED",
    notes:"Virgin GPEC2A 6.2, security-bytes-only (no VIN)" },

  { file:"SAMPLE_GPEC2A_INT_FLASH_OG_62.bin", kind:"GPEC_INT", size:8192, vin:null, role:"OG",
    notes:"GPEC2A 6.2 internal flash partial (8 KB)" },
  { file:"SAMPLE_GPEC2A_INT_FLASH_JAILBREAK_62.bin", kind:"GPEC_INT", size:65536, vin:null, role:"JAILBREAK",
    notes:"GPEC2A 6.2 internal flash JAILBREAK partial (64 KB)" },
  { file:"SAMPLE_GPEC2A_INT_FLASH_JAILBREAK_62_FULL.bin", kind:"GPEC_INT", size:4194304, vin:null, role:"JAILBREAK_FULL",
    notes:"Full 4 MB GPEC2A 6.2 internal flash JAILBREAK" },

  { file:"SAMPLE_RFHUB_EEE_OG_2C3CDXCT1HH652640.bin", kind:"RFH_EEE", size:4096, vin:"2C3CDXCT1HH652640", role:"OG",
    pair:"mitchell-62", notes:"Mitchell 6.2 — pairs with matching PCM EXT EEPROM" },
  { file:"SAMPLE_RFHUB_PFLASH_OG_2C3CDXCT1HH652640.bin", kind:"RFH_PFLASH", size:4096, vin:"2C3CDXCT1HH652640", role:"OG",
    pair:"mitchell-62", notes:"Mitchell 6.2 — RFHUB program flash" },

  { file:"SAMPLE_SMARTBOX_EEE_JOVENTINO_VIN_CRC.bin", kind:"SMARTBOX", size:4096, vin:null, role:"VIN_CRC",
    pair:"joventino", notes:"Joventino set — pairs with JOVENTINO GPEC EXT" },

  // Task #497 — rescued from misnamed `.zip` files in attached_assets/.
  // Two BCM/PCM pairs for the 2020 Charger SXT (VIN 2C3CDXL97LH237142).
  // Both halves of each pair are byte-identical (same sha256 prefix in name);
  // the trailing `_dup_<ts>` keeps the second copy traceable to its original
  // upload timestamp. See RESCUED_DUMPS.md for full provenance.
  { file:"SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2.bin", kind:"BCM", size:65536, vin:"2C3CDXL97LH237142", role:"VIN_CRC",
    pair:"sxt-charger-237142", notes:"Rescued 2020 Charger SXT BCM (FEE1000 header @4, locked, 8 immo recs) — pairs with matching GPEC2A PCM" },
  { file:"SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2_dup_1776900716171.bin", kind:"BCM", size:65536, vin:"2C3CDXL97LH237142", role:"VIN_CRC",
    pair:"sxt-charger-237142", notes:"Rescued duplicate of the SXT Charger BCM (byte-identical, kept for parity with original upload pair)" },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa.bin", kind:"GPEC_EXT", size:8192, vin:"2C3CDXL97LH237142", role:"VIN_CRC",
    pair:"sxt-charger-237142", notes:"Rescued 2020 Charger SXT PCM (Continental GPEC2A 8 KB, VIN @ offset 0) — pairs with matching BCM" },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa_dup_1776900716173.bin", kind:"GPEC_EXT", size:8192, vin:"2C3CDXL97LH237142", role:"VIN_CRC",
    pair:"sxt-charger-237142", notes:"Rescued duplicate of the SXT Charger PCM (byte-identical, kept for parity with original upload pair)" },

  // Task #514 — second-wave rescues from misnamed files in attached_assets/
  // (the new content-sniffing scanner from Task #504 flagged them).
  // - Two byte-identical 64 KB BCM DFLASH dumps for the same SXT Charger
  //   (VIN 2C3CDXL97LH237142) as the Task #497 pair, but a different bench
  //   capture (84-byte delta from the _0d3593f2 BCM); originally uploaded as
  //   `charger_*.png`.
  // - One 4 KB GPEC2A EXT EEPROM PCM dump for a 2018 Jeep Grand Cherokee SRT
  //   (VIN 1C4RJFN9XJC309165, Continental part `A2C7628120000`); originally
  //   uploaded as `fca_module_analyzer_*.jsx`.
  // See RESCUED_DUMPS.md for full provenance.
  { file:"SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1.bin", kind:"BCM", size:65536, vin:"2C3CDXL97LH237142", role:"VIN_CRC",
    pair:"sxt-charger-237142", notes:"Rescued 2020 Charger SXT BCM (different bench capture vs the _0d3593f2 BCM, 84-byte delta; same FEE1000 header @4, same partial-VIN tail NH176487, same security lock 0x5A) — pairs with sxt-charger-237142 set" },
  { file:"SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_ba26d1c1_dup_1776900716172.bin", kind:"BCM", size:65536, vin:"2C3CDXL97LH237142", role:"VIN_CRC",
    pair:"sxt-charger-237142", notes:"Rescued duplicate of the SXT Charger BCM second-bench capture (byte-identical to ba26d1c1, kept for parity with original upload pair)" },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_4KB_RESCUED_VIN_CRC_1C4RJFN9XJC309165_628f7b3c.bin", kind:"GPEC_EXT", size:4096, vin:"1C4RJFN9XJC309165", role:"VIN_CRC",
    pair:"wk2-grand-cherokee-srt-309165", notes:"Rescued 2018 Jeep Grand Cherokee SRT 6.4 PCM (Continental GPEC2A 4 KB EXT EEPROM, part A2C7628120000, VIN @ offset 0)" },

  // FIFTH distinct vehicle — 2022 Charger Redeye 6.2 "797" (VIN 2C3CDXGJXNH176487,
  // RFHUB master secret 581391E0…). PARSE-VERIFIED-ONLY: the RFHUB key table
  // parses clean (4 keys slots 5..8, flag 0x01, mirror-verified, index checksum
  // valid) but the keys are NOT registered in knownWorkingKeys.js — the source
  // bundle's "BCM" file is byte-identical to this RFHUB (a mislabeled duplicate,
  // not a real BCM), and the GPEC2A's PCM SEC6 ≠ reverse(master)[0:6], so the
  // immobilizer secret is attested by a single module. See
  // charRfhubKeyTable.redeye797.test.js for the full determination.
  { file:"SAMPLE_RFHUB_EEE_22REDEYE797_KEYS_2C3CDXGJXNH176487.bin", kind:"RFH_EEE", size:4096, vin:"2C3CDXGJXNH176487", role:"OG",
    pair:"redeye797-176487", notes:"2022 Charger Redeye 6.2 797 RFHUB EEE — 4 paired keys (slots 5..8, flag 0x01, parse-verified-only, NOT registered). VIN echoed reversed in the Gen2 VIN slots." },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_797REDEYE_2C3CDXGJXNH176487.bin", kind:"GPEC_EXT", size:8192, vin:"2C3CDXGJXNH176487", role:"OG",
    pair:"redeye797-176487", notes:"2022 Charger Redeye 6.2 797 PCM (Continental GPEC2A 8 KB EXT EEPROM, VIN @ offset 0) — VIN-attribution provenance for the RFHUB above. PCM SEC6 does NOT match reverse(RFHUB master)[0:6] (only the VIN string is shared)." },

  // Task #1118 — anonymized real ground-truth dumps from the cda6-alphaobd
  // bundle (Task #1111 staged 43 in attached_assets/). Each was VIN-scrubbed
  // with `scripts/anonymize-real-dump.mjs` (donor VIN replaced by a documented
  // anon stand-in, parser CRCs re-stamped, post-scrub leak scan clean) before
  // being copied here. The `vin` field below is the ANON stand-in, not the
  // donor. See fixtures README for the donor→anon mapping.
  //
  // New in-set BCM↔PCM pair "jeepgc-srt-anon-284": both halves share the same
  // anon VIN so the BCM → PCM pairing tab can auto-load them together.
  { file:"SAMPLE_BCM_DFLASH_18TH_SINCERE_VIN_CRC_1C4RJFN95JC100001.bin", kind:"BCM", size:65536, vin:"1C4RJFN95JC100001", role:"VIN_CRC",
    pair:"jeepgc-srt-anon-284", notes:"Anonymized Jeep Grand Cherokee SRT BCM (bundle SINCERE OG, base+8 Redeye layout, SEC16 present) — pairs with the matching GPEC2A PCM" },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_4KB_SINCERE_VIN_CRC_1C4RJFN95JC100001.bin", kind:"GPEC_EXT", size:4096, vin:"1C4RJFN95JC100001", role:"VIN_CRC",
    pair:"jeepgc-srt-anon-284", notes:"Anonymized Jeep Grand Cherokee SRT PCM (Continental GPEC2A 4 KB EXT EEPROM) — pairs with the matching SINCERE BCM" },

  // Standalone anonymized BCM DFLASH samples (parser / VIN-read / sync coverage).
  { file:"SAMPLE_BCM_DFLASH_18TH_DK0G_VIN_CRC_1C4RJFN9XJC100007.bin", kind:"BCM", size:65536, vin:"1C4RJFN9XJC100007", role:"VIN_CRC",
    notes:"Anonymized Jeep Grand Cherokee SRT BCM (bundle DK0G OG)" },
  { file:"SAMPLE_BCM_DFLASH_CHARGER_BLAWSON_VIN_CRC_2C3CDXHG8GH100005.bin", kind:"BCM", size:65536, vin:"2C3CDXHG8GH100005", role:"VIN_CRC",
    notes:"Anonymized Charger BCM (bundle BLAWSON OG)" },
  { file:"SAMPLE_BCM_DFLASH_CHARGER_ALEXTORRES_VIN_CRC_2C3CDXKT3FH100006.bin", kind:"BCM", size:65536, vin:"2C3CDXKT3FH100006", role:"VIN_CRC",
    notes:"Anonymized Charger BCM (bundle ALEXTORRES OG)" },

  // Standalone anonymized Continental GPEC2A PCM EXT EEPROM samples (4 KB).
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_4KB_CONTINENTAL_VIN_CRC_1C4RJFN92JC100002.bin", kind:"GPEC_EXT", size:4096, vin:"1C4RJFN92JC100002", role:"VIN_CRC",
    notes:"Anonymized Jeep Grand Cherokee SRT PCM (Continental GPEC2A 4 KB EXT EEPROM, bundle EEPROM3)" },
  { file:"SAMPLE_GPEC2A_EXT_EEPROM_4KB_CONTINENTAL_VIN_CRC_1C4RJFDJ7DC100003.bin", kind:"GPEC_EXT", size:4096, vin:"1C4RJFDJ7DC100003", role:"VIN_CRC",
    notes:"Anonymized Trackhawk-family PCM (Continental GPEC2A 4 KB EXT EEPROM, bundle EEPROM_513874)" },

  // Standalone anonymized RFHUB Gen2 external EEPROM sample (4 KB).
  { file:"SAMPLE_RFHUB_EEE_BRANDON_VIN_CRC_2B3CJ4DV6AH100004.bin", kind:"RFH_EEE", size:4096, vin:"2B3CJ4DV6AH100004", role:"VIN_CRC",
    notes:"Anonymized RFHUB Gen2 EXT EEPROM (bundle testbrandonrfhub, byte-reversed VIN slots)" },
];

export function getFixturesByKind(kind) {
  return SAMPLE_FIXTURES.filter(f => f.kind === kind);
}

/* Bench-set pairs: every `pair` key that has BOTH a full 65 KB BCM and a
 * canonical-size GPEC2A EXT EEPROM (4 KB / 8 KB) entry. These are the pairs
 * the BCM → PCM tab can auto-load in one click (both halves at once).
 * For each pair the first matching BCM + first matching canonical PCM win. */
export function getBenchPairs() {
  const byPair = new Map();
  for (const f of SAMPLE_FIXTURES) {
    if (!f.pair) continue;
    if (!byPair.has(f.pair)) byPair.set(f.pair, { bcm: null, pcm: null });
    const slot = byPair.get(f.pair);
    if (!slot.bcm && f.kind === "BCM" && f.size === 65536) slot.bcm = f;
    if (!slot.pcm && f.kind === "GPEC_EXT" && (f.size === 4096 || f.size === 8192)) slot.pcm = f;
  }
  const out = [];
  for (const [pair, { bcm, pcm }] of byPair) {
    if (bcm && pcm) out.push({ pair, bcm, pcm });
  }
  return out;
}

export function getFixturesByKinds(kinds) {
  const set = new Set(kinds);
  return SAMPLE_FIXTURES.filter(f => set.has(f.kind));
}

export async function loadFixtureBytes(filename) {
  const key = "../__tests__/fixtures/" + filename;
  const url = fixtureUrls[key];
  if (!url) throw new Error("Sample fixture not found: " + filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Fetch failed (" + res.status + ") for " + filename);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export async function loadFixtureAsFile(filename) {
  const bytes = await loadFixtureBytes(filename);
  return new File([bytes], filename, { type: "application/octet-stream" });
}

export function describeFixture(f) {
  const sz = f.size >= 1024 ? (f.size/1024).toFixed(f.size%1024?1:0) + " KB" : f.size + " B";
  const vin = f.vin || "(no VIN)";
  return `${vin} · ${f.role} · ${sz}${f.pair ? " · pair:" + f.pair : ""} — ${f.notes}`;
}
