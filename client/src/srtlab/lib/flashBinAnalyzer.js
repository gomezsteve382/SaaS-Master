/**
 * flashBinAnalyzer.js
 * Full structural analysis of raw flash BIN dumps from Mopar/FCA ECUs.
 *
 * Supports: GPEC2A (MPC5674F), GPEC3 (SPC5777), BCM (MPC5606B),
 *           TCM (MPC5607B), RFHUB (24C32 / XC2268), BCM EEPROM,
 *           and unknown/unrecognized files.
 *
 * Returns a rich analysis object — no side effects.
 */

// ─── ECU PROFILES ────────────────────────────────────────────────────────────
// Each profile defines: sizes (bytes), magic byte patterns, region map,
// known VIN offsets, SEC byte offsets, and PN scan hints.

const ECU_PROFILES = [
  {
    id: 'GPEC2A_LB18',
    label: 'GPEC2A / GPEC2B — INT FLASH (LB18)',
    chip: 'MPC5674F',
    sizes: [3407872],
    // First 4 bytes: PowerPC bl instruction 0x48xxxxxx
    magic: { offset: 0, mask: 0xFF000000, value: 0x48000000 },
    regions: [
      { name: 'Code/Cal Header',  start: 0x000000, end: 0x00FFFF, notes: 'Boot vector + interrupt table' },
      { name: 'Calibration Data', start: 0x260000, end: 0x2AFFFF, notes: 'FCA calibration tables (low entropy)' },
      { name: 'Config / Cal Tail',start: 0x330000, end: 0x33FFFF, notes: 'Config block + part number area' },
      { name: 'Code (main)',      start: 0x010000, end: 0x25FFFF, notes: 'Compiled PowerPC code' },
      { name: 'Erased (FF)',      start: 0x2B0000, end: 0x32FFFF, notes: 'Unprogrammed flash (0xFF fill)' },
    ],
    vinOffsets: [],  // VIN lives in EEPROM (GPEC2A 4/8 KB), not in LB18
    secOffsets: [],  // SEC6 lives in EEPROM, not in LB18
    pnHints: [
      { offset: 0x335013, len: 12, label: 'Calibration PN' },
    ],
    copyright: { search: true, label: 'FCA Copyright' },
    architecture: 'PowerPC e200z7 (MPC5674F)',
    programmer: 'Multi-PROG · DB44 · DC_PWR 12V/0.5A',
    notes: 'Primary calibration region for GPEC2A/GPEC2B ECMs (Charger/Challenger/300 6.4L, 5.7L, 6.2L)',
  },
  {
    id: 'GPEC2A_LB19',
    label: 'GPEC2A / GPEC2B — Secondary P-Flash (LB19)',
    chip: 'MPC5674F',
    sizes: [524288],
    magic: { offset: 0, mask: 0xFF000000, value: 0x48000000 },
    regions: [
      { name: 'Secondary Code',   start: 0x000000, end: 0x07FFFF, notes: 'Secondary code block' },
    ],
    vinOffsets: [], secOffsets: [], pnHints: [],
    copyright: { search: true, label: 'FCA Copyright' },
    architecture: 'PowerPC e200z7 (MPC5674F)',
    programmer: 'Multi-PROG · DB44 · DC_PWR 12V/0.5A',
    notes: 'Secondary P-Flash block (LB19) — less commonly written',
  },
  {
    id: 'GPEC2A_FULL_PFLASH',
    label: 'GPEC2A / GPEC2B — Full P-Flash',
    chip: 'MPC5674F',
    sizes: [4194304],
    magic: null,
    regions: [
      { name: 'LB18 INT FLASH',   start: 0x040000, end: 0x37FFFF, notes: 'Primary calibration (3.25 MB)' },
      { name: 'LB19 Secondary',   start: 0x380000, end: 0x3FFFFF, notes: 'Secondary code (512 KB)' },
      { name: 'LB20 Data Block',  start: 0x00E000, end: 0x00F5FF, notes: 'Data/config (5.5 KB)' },
    ],
    vinOffsets: [], secOffsets: [], pnHints: [],
    copyright: { search: true, label: 'FCA Copyright' },
    architecture: 'PowerPC e200z7 (MPC5674F)',
    programmer: 'Multi-PROG · DB44 · DC_PWR 12V/0.5A',
    notes: 'Complete P-Flash image (all logical blocks)',
  },
  {
    id: 'GPEC3',
    label: 'GPEC3 — INT FLASH',
    chip: 'SPC5777',
    sizes: [2097152, 4194304],
    magic: null,
    regions: [
      { name: 'INT FLASH', start: 0x000000, end: 0x1FFFFF, notes: 'SPC5777 internal flash' },
    ],
    vinOffsets: [], secOffsets: [], pnHints: [],
    copyright: { search: true, label: 'FCA Copyright' },
    architecture: 'PowerPC e200z7 (SPC5777)',
    programmer: 'Multi-PROG · GPEC3 adapter · DC_PWR 12V/0.5A',
    notes: 'Hellcat / Demon / Redeye ECM (6.2L SC)',
  },
  {
    id: 'BCM_FLASH',
    label: 'BCM — INT FLASH',
    chip: 'MPC5606B',
    sizes: [1048576, 524288],
    magic: null,
    regions: [
      { name: 'INT FLASH', start: 0x000000, end: 0x0FFFFF, notes: 'BCM internal flash' },
    ],
    vinOffsets: [], secOffsets: [],
    pnHints: [],
    copyright: { search: true, label: 'FCA Copyright' },
    architecture: 'PowerPC e200z0 (MPC5606B)',
    programmer: 'Multi-PROG · MPC5606B BCM adapter',
    notes: 'Body Control Module flash image',
  },
  {
    id: 'TCM_FLASH',
    label: 'TCM — INT FLASH (ZF 8HP)',
    chip: 'MPC5607B',
    sizes: [2097152],
    magic: null,
    regions: [
      { name: 'INT FLASH', start: 0x000000, end: 0x1FFFFF, notes: 'TCM internal flash' },
    ],
    vinOffsets: [], secOffsets: [], pnHints: [],
    copyright: { search: true, label: 'FCA Copyright' },
    architecture: 'PowerPC e200z0 (MPC5607B)',
    programmer: 'Multi-PROG · MPC5607B TCM adapter',
    notes: 'ZF 8HP transmission control module',
  },
  {
    id: 'BCM_DFLASH',
    label: 'BCM — D-FLASH (EEPROM)',
    chip: 'MPC5606B',
    sizes: [65536, 131072],
    magic: null,
    regions: [
      { name: 'D-FLASH', start: 0x000000, end: 0x00FFFF, notes: 'BCM data flash (EEPROM emulation)' },
    ],
    // BCM D-Flash has VIN at known offsets (partial VIN, 8 chars)
    vinOffsets: [0x0040, 0x0080, 0x00C0, 0x0100],
    secOffsets: [{ offset: 0x0226, len: 16, label: 'SEC16' }],
    pnHints: [],
    copyright: { search: false },
    architecture: 'MPC5606B D-Flash',
    programmer: 'Multi-PROG · MPC5606B BCM adapter',
    notes: 'BCM data flash — contains VIN, SEC16, and EEPROM data',
  },
  {
    id: 'RFHUB_GEN2_4KB',
    label: 'RFHUB — Gen2 EEPROM (4 KB)',
    chip: '24C32',
    sizes: [4096],
    magic: null,
    regions: [
      { name: 'Auth Sector',   start: 0x0100, end: 0x027F, notes: 'Key auth data (0x180 bytes)' },
      { name: 'Master Xpndr',  start: 0x0226, end: 0x0233, notes: 'Master transponder (14 bytes)' },
      { name: 'VIN Slots',     start: 0x0EA5, end: 0x0EF4, notes: '4× reversed VIN slots' },
      { name: 'SEC16 Slots',   start: 0x050E, end: 0x051D, notes: 'Gen2 SEC16 (2 slots × 8 bytes)' },
      { name: 'Key Ring',      start: 0x0C5E, end: 0x0CDD, notes: 'Key ring buffer (128 bytes)' },
    ],
    vinOffsets: [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1],
    secOffsets: [{ offset: 0x050E, len: 8, label: 'SEC16 slot 1' }, { offset: 0x0516, len: 8, label: 'SEC16 slot 2' }],
    pnHints: [],
    copyright: { search: false },
    architecture: '24C32 I²C EEPROM',
    programmer: 'Multi-PROG / SOIC8 clip',
    notes: 'Standard RFHUB — Charger/Challenger/300/Durango',
  },
  {
    id: 'RFHUB_GEN2_8KB',
    label: 'RFHUB — Gen2 EEPROM (8 KB, Trackhawk)',
    chip: '24C32 doubled',
    sizes: [8192],
    magic: null,
    regions: [
      { name: 'Copy 1 (0x0000)', start: 0x0000, end: 0x0FFF, notes: 'First 4 KB copy' },
      { name: 'Copy 2 (0x1000)', start: 0x1000, end: 0x1FFF, notes: 'Second 4 KB copy (mirrored)' },
    ],
    vinOffsets: [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1, 0x1EA5, 0x1EB9, 0x1ECD, 0x1EE1],
    secOffsets: [{ offset: 0x050E, len: 8, label: 'SEC16 slot 1' }, { offset: 0x1516, len: 8, label: 'SEC16 slot 1 (copy 2)' }],
    pnHints: [],
    copyright: { search: false },
    architecture: '24C32 I²C EEPROM (doubled)',
    programmer: 'Multi-PROG / SOIC8 clip',
    notes: 'WK2 Trackhawk RFHUB — doubled 24C32 dump',
  },
  {
    id: 'XC2268_RFHUB',
    label: 'XC2268 RFHUB — EEPROM (16 KB)',
    chip: 'XC2268',
    sizes: [16384],
    magic: null,
    regions: [
      { name: 'XC2268 EEPROM', start: 0x0000, end: 0x3FFF, notes: 'XC2268 full EEPROM' },
    ],
    vinOffsets: [],
    secOffsets: [{ offset: 0x0010, len: 8, label: 'SEC16 (XC2268)' }],
    pnHints: [],
    copyright: { search: false },
    architecture: 'XC2268 SPI EEPROM',
    programmer: 'SOIC8 adapter',
    notes: 'XC2268 RFHUB variant — not Gen2 compatible',
  },
  {
    id: 'GPEC2A_EEPROM_4KB',
    label: 'GPEC2A PCM — EXT EEPROM (4 KB, 95320)',
    chip: '95320',
    sizes: [4096],
    magic: null,
    regions: [
      { name: 'VIN Area',    start: 0x0000, end: 0x00FF, notes: 'VIN slots at 0x0000, 0x01F0, 0x0224, 0x0CE0' },
      { name: 'SEC6 Area',   start: 0x03C0, end: 0x03CF, notes: 'PCM SEC6 at 0x03C8 (6 bytes)' },
      { name: 'Config Data', start: 0x0100, end: 0x0FFF, notes: 'PCM configuration data' },
    ],
    vinOffsets: [0x0000, 0x01F0, 0x0224, 0x0CE0],
    secOffsets: [{ offset: 0x03C8, len: 6, label: 'SEC6' }],
    pnHints: [],
    copyright: { search: false },
    architecture: '95320 SPI EEPROM',
    programmer: 'Multi-PROG / SOIC8',
    notes: 'Continental GPEC2A PCM external EEPROM (4 KB variant)',
  },
  {
    id: 'GPEC2A_EEPROM_8KB',
    label: 'GPEC2A PCM — EXT EEPROM (8 KB, 95640)',
    chip: '95640',
    sizes: [8192],
    magic: null,
    regions: [
      { name: 'VIN Area',    start: 0x0000, end: 0x00FF, notes: 'VIN slots at 0x0000, 0x01F0, 0x0224, 0x0CE0' },
      { name: 'SEC6 Area',   start: 0x03C0, end: 0x03CF, notes: 'PCM SEC6 at 0x03C8 (6 bytes)' },
      { name: 'Config Data', start: 0x0100, end: 0x1FFF, notes: 'PCM configuration data' },
    ],
    vinOffsets: [0x0000, 0x01F0, 0x0224, 0x0CE0],
    secOffsets: [{ offset: 0x03C8, len: 6, label: 'SEC6' }],
    pnHints: [],
    copyright: { search: false },
    architecture: '95640 SPI EEPROM',
    programmer: 'Multi-PROG / SOIC8',
    notes: 'Continental GPEC2A PCM external EEPROM (8 KB variant)',
  },
  {
    id: 'BCM_EEPROM_2KB',
    label: 'BCM EEPROM (2 KB, 24C16)',
    chip: '24C16',
    sizes: [2048],
    magic: null,
    regions: [{ name: 'BCM EEPROM', start: 0x0000, end: 0x07FF, notes: 'BCM EEPROM data' }],
    vinOffsets: [], secOffsets: [],
    pnHints: [], copyright: { search: false },
    architecture: '24C16 I²C EEPROM',
    programmer: 'Multi-PROG / SOIC8',
    notes: 'BCM EEPROM — 2 KB variant',
  },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function entropy(bytes) {
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  let ent = 0;
  const total = bytes.length;
  for (let i = 0; i < 256; i++) {
    if (counts[i] === 0) continue;
    const p = counts[i] / total;
    ent -= p * Math.log2(p);
  }
  return ent;
}

function ffPercent(bytes) {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0xFF) n++;
  return (n / bytes.length) * 100;
}

function zeroPercent(bytes) {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x00) n++;
  return (n / bytes.length) * 100;
}

function isAllFF(bytes, start, len) {
  for (let i = start; i < start + len && i < bytes.length; i++) {
    if (bytes[i] !== 0xFF) return false;
  }
  return true;
}

function isAllZero(bytes, start, len) {
  for (let i = start; i < start + len && i < bytes.length; i++) {
    if (bytes[i] !== 0x00) return false;
  }
  return true;
}

function hexBytes(bytes, start, len) {
  const out = [];
  for (let i = start; i < start + len && i < bytes.length; i++) {
    out.push(bytes[i].toString(16).toUpperCase().padStart(2, '0'));
  }
  return out.join(' ');
}

function isVinChar(c) {
  // VIN chars: A-H, J-N, P-Z (no I, O, Q), 0-9
  return (c >= 0x30 && c <= 0x39) ||
         (c >= 0x41 && c <= 0x48) ||
         (c >= 0x4A && c <= 0x4E) ||
         (c >= 0x50 && c <= 0x5A && c !== 0x51); // no Q
}

const KNOWN_WMIS = new Set([
  '1C3','1C6','2C3','2C6','3C3','3C6',  // Chrysler/Dodge US/Canada/Mexico
  '1B3','2B3','1D3','2D3',              // Dodge variants
  '1J4','1J8',                          // Jeep
  '4S3','5S3',                          // Subaru (for cross-ref)
  '1FA','2FA','3FA',                    // Ford (for cross-ref)
]);

function scanVins(bytes) {
  const results = [];
  for (let i = 0; i <= bytes.length - 17; i++) {
    let valid = true;
    for (let j = 0; j < 17; j++) {
      if (!isVinChar(bytes[i + j])) { valid = false; break; }
    }
    if (!valid) continue;
    const vin = String.fromCharCode(...bytes.slice(i, i + 17));
    const wmi = vin.slice(0, 3);
    const isKnownWmi = KNOWN_WMIS.has(wmi);
    // Also accept if it looks like a real VIN (check digit at pos 8 is digit or X)
    const checkDigit = vin[8];
    const hasValidCheck = (checkDigit >= '0' && checkDigit <= '9') || checkDigit === 'X';
    if (isKnownWmi || hasValidCheck) {
      results.push({ offset: i, vin, knownWmi: isKnownWmi });
    }
    i += 16; // skip ahead — VINs don't overlap
  }
  return results;
}

function scanReversedVins(bytes) {
  // For RFHUB Gen2 — VINs stored reversed
  const results = [];
  for (let i = 0; i <= bytes.length - 17; i++) {
    let valid = true;
    for (let j = 0; j < 17; j++) {
      if (!isVinChar(bytes[i + j])) { valid = false; break; }
    }
    if (!valid) continue;
    const reversed = String.fromCharCode(...bytes.slice(i, i + 17));
    const vin = reversed.split('').reverse().join('');
    const wmi = vin.slice(0, 3);
    if (KNOWN_WMIS.has(wmi)) {
      results.push({ offset: i, vin, reversed: true, knownWmi: true });
    }
    i += 16;
  }
  return results;
}

function scanAsciiStrings(bytes, minLen = 8) {
  const results = [];
  let i = 0;
  while (i < bytes.length) {
    let j = i;
    while (j < bytes.length && bytes[j] >= 0x20 && bytes[j] <= 0x7E) j++;
    if (j - i >= minLen) {
      results.push({ offset: i, text: String.fromCharCode(...bytes.slice(i, j)) });
    }
    i = j + 1;
  }
  return results;
}

// Part number / calibration ID patterns
const PN_PATTERNS = [
  /\*[A-Z][0-9]{7,}/,              // *C4436011 style
  /[0-9]{8,}/,                      // 8+ digit PN
  /[A-Z]{2,}[0-9]{4,}/,            // AB1234 style
  /[A-Z0-9]{3,}[-_][A-Z0-9]{2,}[-_][A-Z0-9]{2,}/, // AA-BB-CC style
  /[0-9]{4}[._][0-9]{2}[._][0-9]{2}/, // date-like
  /(?:SW|HW|CAL|PN|P\/N)[:\s]*[A-Z0-9]{6,}/i, // labeled PN
];

function extractPartNumbers(strings) {
  const results = [];
  const seen = new Set();
  for (const { offset, text } of strings) {
    for (const pat of PN_PATTERNS) {
      const m = text.match(pat);
      if (m && !seen.has(m[0]) && m[0].length >= 6) {
        seen.add(m[0]);
        results.push({ offset, value: m[0], context: text.slice(0, 80) });
      }
    }
  }
  return results;
}

function extractCopyright(strings) {
  for (const { offset, text } of strings) {
    if (/copyright/i.test(text) && text.length > 20) {
      return { offset, text: text.slice(0, 200) };
    }
  }
  return null;
}

function detectEcu(bytes) {
  const size = bytes.length;
  const candidates = [];

  for (const profile of ECU_PROFILES) {
    if (!profile.sizes.includes(size)) continue;

    let score = 50; // base score for size match
    let magicOk = false;

    // Magic byte check
    if (profile.magic) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const word = view.getUint32(profile.magic.offset, false); // big-endian
      if ((word & profile.magic.mask) === profile.magic.value) {
        score += 30;
        magicOk = true;
      }
    } else {
      magicOk = true; // no magic required
    }

    // Entropy check — code regions should have entropy 6-8
    const blockEnt = entropy(bytes.slice(0, Math.min(65536, size)));
    if (blockEnt > 5.5 && blockEnt < 8.1) score += 10;

    // FF% check — erased flash is 100% FF
    const ffPct = ffPercent(bytes);
    if (ffPct < 50) score += 10; // has real data

    candidates.push({ profile, score, magicOk });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

// ─── ENTROPY MAP ─────────────────────────────────────────────────────────────

function buildEntropyMap(bytes, blockSize = 65536) {
  const blocks = [];
  for (let i = 0; i < bytes.length; i += blockSize) {
    const block = bytes.slice(i, i + blockSize);
    const ent = entropy(block);
    const ffPct = ffPercent(block);
    const zeroPct = zeroPercent(block);
    let label = 'code';
    if (ffPct > 90) label = 'erased';
    else if (ffPct > 50) label = 'sparse';
    else if (ent < 3) label = 'low-entropy';
    else if (ent < 5.5) label = 'data/cal';
    else if (ent > 7.5) label = 'compressed/packed';
    else label = 'code';
    blocks.push({
      index: i / blockSize,
      start: i,
      end: i + block.length - 1,
      size: block.length,
      entropy: ent,
      ffPercent: ffPct,
      zeroPercent: zeroPct,
      label,
    });
  }
  return blocks;
}

// ─── SEC BYTE SCAN ───────────────────────────────────────────────────────────

function scanSecBytes(bytes, profile) {
  const results = [];
  for (const secDef of profile.secOffsets) {
    const { offset, len, label } = secDef;
    if (offset + len > bytes.length) continue;
    const raw = bytes.slice(offset, offset + len);
    const hex = hexBytes(bytes, offset, len);
    const virgin = isAllFF(bytes, offset, len) || isAllZero(bytes, offset, len);
    results.push({ offset, len, label, hex, virgin });
  }
  return results;
}

// ─── MAIN ANALYSIS ───────────────────────────────────────────────────────────

/**
 * Analyze a raw flash BIN dump.
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {object} analysis result
 */
export function analyzeFlashBin(bytes, filename = '') {
  const size = bytes.length;
  const detection = detectEcu(bytes);
  const profile = detection ? detection.profile : null;

  // Entropy map (64 KB blocks, or 4 KB blocks for small files)
  const blockSize = size <= 65536 ? 4096 : 65536;
  const entropyMap = buildEntropyMap(bytes, blockSize);

  // ASCII strings
  const strings = scanAsciiStrings(bytes, 8);

  // VINs
  let vins = [];
  if (profile && (profile.id === 'RFHUB_GEN2_4KB' || profile.id === 'RFHUB_GEN2_8KB')) {
    vins = scanReversedVins(bytes);
  } else {
    vins = scanVins(bytes);
  }

  // Part numbers
  const partNumbers = extractPartNumbers(strings);

  // Copyright
  const copyright = profile && profile.copyright && profile.copyright.search
    ? extractCopyright(strings)
    : null;

  // SEC bytes
  const secBytes = profile ? scanSecBytes(bytes, profile) : [];

  // Interesting strings (filter to useful ones)
  const interestingStrings = strings.filter(s => {
    const t = s.text;
    if (t.length > 200) return false;
    if (/copyright/i.test(t)) return true;
    if (/fca|chrysler|dodge|mopar|continental/i.test(t)) return true;
    if (/gpec|p14u|scat|hellcat|demon|redeye|hemi/i.test(t)) return true;
    if (/\*[A-Z][0-9]{6,}/.test(t)) return true;
    if (/[0-9]{8,}/.test(t) && t.length < 40) return true;
    return false;
  }).slice(0, 30);

  // Overall stats
  const overallEntropy = entropy(bytes);
  const overallFfPct = ffPercent(bytes);
  const overallZeroPct = zeroPercent(bytes);

  // Determine if file is encrypted (entropy > 7.9 means likely encrypted/compressed)
  const likelyEncrypted = overallEntropy > 7.9;

  return {
    // Identity
    filename,
    size,
    sizeHex: '0x' + size.toString(16).toUpperCase(),
    sizeLabel: size >= 1048576
      ? `${(size / 1048576).toFixed(2)} MB`
      : size >= 1024
        ? `${(size / 1024).toFixed(1)} KB`
        : `${size} bytes`,

    // ECU detection
    detected: detection ? {
      id: profile.id,
      label: profile.label,
      chip: profile.chip,
      architecture: profile.architecture,
      programmer: profile.programmer,
      notes: profile.notes,
      score: detection.score,
      magicOk: detection.magicOk,
    } : null,

    // Regions
    regions: profile ? profile.regions : [],

    // Entropy
    overallEntropy,
    overallFfPct,
    overallZeroPct,
    likelyEncrypted,
    entropyMap,

    // Content
    vins,
    secBytes,
    partNumbers,
    copyright,
    interestingStrings,
    totalStrings: strings.length,
  };
}

/**
 * Format an analysis result as a plain-text report.
 * @param {object} analysis
 * @returns {string}
 */
export function formatAnalysisReport(analysis) {
  const lines = [];
  const hr = '─'.repeat(72);

  lines.push('SRT LAB — FLASH BIN ANALYSIS REPORT');
  lines.push(hr);
  lines.push(`File:     ${analysis.filename}`);
  lines.push(`Size:     ${analysis.sizeLabel}  (${analysis.size.toLocaleString()} bytes, ${analysis.sizeHex})`);
  lines.push(`Entropy:  ${analysis.overallEntropy.toFixed(2)} bits/byte  |  FF: ${analysis.overallFfPct.toFixed(1)}%  |  00: ${analysis.overallZeroPct.toFixed(1)}%`);
  if (analysis.likelyEncrypted) {
    lines.push('⚠  Entropy > 7.9 — file may be encrypted or compressed (not a raw flash dump)');
  }
  lines.push('');

  if (analysis.detected) {
    const d = analysis.detected;
    lines.push('ECU DETECTION');
    lines.push(hr);
    lines.push(`Type:         ${d.label}`);
    lines.push(`Chip:         ${d.chip}  (${d.architecture})`);
    lines.push(`Programmer:   ${d.programmer}`);
    lines.push(`Notes:        ${d.notes}`);
    lines.push('');
  } else {
    lines.push('ECU DETECTION: No match found for this file size');
    lines.push('');
  }

  if (analysis.regions.length > 0) {
    lines.push('FLASH REGION MAP');
    lines.push(hr);
    for (const r of analysis.regions) {
      const size = r.end - r.start + 1;
      const sizeStr = size >= 1048576 ? `${(size/1048576).toFixed(2)} MB` : `${(size/1024).toFixed(0)} KB`;
      lines.push(`  0x${r.start.toString(16).toUpperCase().padStart(6,'0')} – 0x${r.end.toString(16).toUpperCase().padStart(6,'0')}  [${sizeStr.padStart(8)}]  ${r.name}  —  ${r.notes}`);
    }
    lines.push('');
  }

  if (analysis.vins.length > 0) {
    lines.push('VIN SCAN');
    lines.push(hr);
    for (const v of analysis.vins) {
      lines.push(`  0x${v.offset.toString(16).toUpperCase().padStart(6,'0')}: ${v.vin}${v.reversed ? '  (stored reversed)' : ''}${v.knownWmi ? '  ✓ known WMI' : ''}`);
    }
    lines.push('');
  }

  if (analysis.secBytes.length > 0) {
    lines.push('SECURITY BYTES');
    lines.push(hr);
    for (const s of analysis.secBytes) {
      lines.push(`  0x${s.offset.toString(16).toUpperCase().padStart(6,'0')}: [${s.label}]  ${s.hex}${s.virgin ? '  (VIRGIN)' : ''}`);
    }
    lines.push('');
  }

  if (analysis.partNumbers.length > 0) {
    lines.push('PART NUMBERS / CALIBRATION IDs');
    lines.push(hr);
    for (const p of analysis.partNumbers) {
      lines.push(`  0x${p.offset.toString(16).toUpperCase().padStart(6,'0')}: ${p.value}  —  ${p.context.slice(0, 60)}`);
    }
    lines.push('');
  }

  if (analysis.copyright) {
    lines.push('COPYRIGHT / WATERMARK');
    lines.push(hr);
    lines.push(`  0x${analysis.copyright.offset.toString(16).toUpperCase().padStart(6,'0')}: ${analysis.copyright.text}`);
    lines.push('');
  }

  if (analysis.interestingStrings.length > 0) {
    lines.push('NOTABLE STRINGS');
    lines.push(hr);
    for (const s of analysis.interestingStrings) {
      if (s.text === analysis.copyright?.text) continue;
      lines.push(`  0x${s.offset.toString(16).toUpperCase().padStart(6,'0')}: ${s.text.slice(0, 100)}`);
    }
    lines.push('');
  }

  lines.push('ENTROPY MAP (per block)');
  lines.push(hr);
  for (const b of analysis.entropyMap) {
    const bar = '█'.repeat(Math.round(b.entropy)) + '░'.repeat(Math.max(0, 8 - Math.round(b.entropy)));
    lines.push(`  [${String(b.index).padStart(2)}] 0x${b.start.toString(16).toUpperCase().padStart(6,'0')}-0x${b.end.toString(16).toUpperCase().padStart(6,'0')}  ${bar}  ent=${b.entropy.toFixed(2)}  FF=${b.ffPercent.toFixed(0)}%  ${b.label}`);
  }
  lines.push('');
  lines.push(`Generated by SRT Lab · ${new Date().toISOString()}`);

  return lines.join('\n');
}
