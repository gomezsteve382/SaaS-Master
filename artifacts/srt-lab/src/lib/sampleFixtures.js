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
];

export function getFixturesByKind(kind) {
  return SAMPLE_FIXTURES.filter(f => f.kind === kind);
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
