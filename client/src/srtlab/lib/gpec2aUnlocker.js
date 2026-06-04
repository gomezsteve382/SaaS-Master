/* gpec2aUnlocker.js — GPEC2/GPEC2A firmware-file patcher.
 *
 * Algorithm recovered from GPEC_Unlocker.exe (.NET IL disassembly,
 * WinLicense-protected). Source: VILLAIN_GPEC_COMPLETE_EXTRACTION zip,
 * villain_extraction/GPEC_Unlocker_Cracked/GPEC_UNLOCK_ALGORITHM.md
 *
 * The three 4-byte search patterns (FieldRVA entries [04:0005], [04:0006],
 * [04:0007]) live in a WinLicense-protected section of the .NET assembly.
 * They were NOT recoverable from the static binary. Exact missing assets:
 *
 *   LOCKED files available in attached_assets/ (no unlocked counterpart exists):
 *     - FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_CRC_2C3CDXCT1HH652640_1776900514064.bin
 *         384 KB EXT_EEPROM · flag @ 0x2FFFC = 0x3A (LOCKED)
 *     - FCA_CONTINENTAL_GPEC2A_INT_FLASH_JAILBREAK)OG_6.2_1776899205056.bin
 *         4 MB INT_FLASH · flag @ 0x2FFFC = 0x08 (LOCKED)
 *
 *   MISSING — needed to derive the patterns:
 *     The unlocked version of either of the above files (produced by running
 *     GPEC_Unlocker.exe on Windows with the locked file as input).
 *     Once in hand, byte-diff the pair: the single changed byte at offset K
 *     gives UNLOCK_TARGET_PATTERN = locked[K..K+3].
 *     ALREADY_UNLOCKED_PATTERN = unlocked[K+1..K+4] (bytes after the E8 patch).
 *     GEN_DETECT_PATTERN — present only in 2015-2018 firmware; compare a
 *     known-2015 locked file against a known-2018+ locked file.
 *
 * Until the patterns are recovered, PATTERNS_AVAILABLE is false and
 * patchGpec2aFile() returns status 'PATTERN_MISSING' — the patcher core is
 * fully functional and all surrounding UI/test infrastructure is ready to
 * activate the moment the constants are filled in.
 */

/* ── Pattern constants ─────────────────────────────────────────────────────
 * Set PATTERNS_AVAILABLE = true and populate the three arrays once the
 * 4-byte values have been recovered (see header comment above).
 */
export const PATTERNS_AVAILABLE = false;

export const GEN_DETECT_PATTERN       = null; // [04:0005] — 4 bytes, "2015-2018" marker
export const ALREADY_UNLOCKED_PATTERN = null; // [04:0006] — 4 bytes, scanned with look-behind
export const UNLOCK_TARGET_PATTERN    = null; // [04:0007] — 4 bytes, byte[match] → 0xE8

/* Unlock flag offset — this constant is NOT protected and confirmed from IL */
export const UNLOCK_FLAG_OFFSET = 0x2FFFC; // 196604 — only applied when file > this offset
export const UNLOCK_FLAG_BYTE   = 0x96;

/* ── Internal helpers ──────────────────────────────────────────────────────*/

function scanForPattern(data, pattern, startIndex = 0) {
  if (!pattern || pattern.length !== 4) return -1;
  const limit = data.length - pattern.length;
  for (let i = startIndex; i <= limit; i++) {
    if (data[i] === pattern[0] &&
        data[i + 1] === pattern[1] &&
        data[i + 2] === pattern[2] &&
        data[i + 3] === pattern[3]) {
      return i;
    }
  }
  return -1;
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * detectGeneration(fileData, opts?)
 * Returns "2015-2018 FILE FLASH" | "NEW 2018+ FILE FLASH" | "PATTERN_MISSING"
 *
 * Mirrors DetectFileFlashGeneration() from the cracked IL.
 *
 * @param {Uint8Array} fileData
 * @param {{ genDetectPattern?: number[]|null }} [opts]
 */
export function detectGeneration(fileData, opts = {}) {
  const pattern = 'genDetectPattern' in opts
    ? opts.genDetectPattern
    : (PATTERNS_AVAILABLE ? GEN_DETECT_PATTERN : null);

  if (!pattern) return 'PATTERN_MISSING';
  const idx = scanForPattern(fileData, pattern, 0);
  return idx >= 0 ? '2015-2018 FILE FLASH' : 'NEW 2018+ FILE FLASH';
}

/**
 * isAlreadyUnlocked(fileData, opts?)
 * Returns true if the file appears to have already been through the unlocker.
 *
 * Mirrors IsFileAlreadyUnlocked() from the cracked IL:
 *   - If file.length > 0x2FFFC and fileData[0x2FFFC] === 0x96 → unlocked.
 *   - Scan for ALREADY_UNLOCKED_PATTERN starting at index 1 (not 0).
 *     If found at position i and fileData[i-1] === 0xE8 → unlocked.
 *
 * @param {Uint8Array} fileData
 * @param {{ alreadyUnlockedPattern?: number[]|null }} [opts]
 */
export function isAlreadyUnlocked(fileData, opts = {}) {
  if (fileData.length > UNLOCK_FLAG_OFFSET &&
      fileData[UNLOCK_FLAG_OFFSET] === UNLOCK_FLAG_BYTE) {
    return true;
  }
  const pattern = 'alreadyUnlockedPattern' in opts
    ? opts.alreadyUnlockedPattern
    : (PATTERNS_AVAILABLE ? ALREADY_UNLOCKED_PATTERN : null);

  if (!pattern) return false;
  const idx = scanForPattern(fileData, pattern, 1);
  if (idx >= 1 && fileData[idx - 1] === 0xE8) return true;
  return false;
}

/**
 * patchGpec2aFile(fileData, opts?)
 *
 * @param {Uint8Array} fileData — firmware binary to patch (read-only; a copy is returned)
 * @param {{
 *   genDetectPattern?: number[]|null,
 *   alreadyUnlockedPattern?: number[]|null,
 *   unlockTargetPattern?: number[]|null,
 * }} [opts] — inject patterns for testing; falls back to module constants when omitted
 * @returns {{
 *   generation: string,
 *   status: 'already_unlocked'|'unlocked'|'offset_only'|'pattern_not_found'|'PATTERN_MISSING',
 *   matchOffset: number|null,
 *   patched: Uint8Array,
 *   flagSet: boolean,
 * }}
 *
 * Mirrors BtnUnlock_Click() from the cracked IL (async MoveNext).
 *
 * 1. Scan for UNLOCK_TARGET_PATTERN.
 * 2. If found at position i: fileData[i] = 0xE8, patternFound = true.
 * 3. If fileData.length > 0x2FFFC: fileData[0x2FFFC] = 0x96.
 * 4. Return result with generation, status, matchOffset, patched bytes.
 */
export function patchGpec2aFile(fileData, opts = {}) {
  if (!(fileData instanceof Uint8Array)) {
    fileData = new Uint8Array(fileData);
  }

  const hasOpts = Object.keys(opts).length > 0;
  const patternsReady = hasOpts || PATTERNS_AVAILABLE;

  const unlockTarget = 'unlockTargetPattern' in opts
    ? opts.unlockTargetPattern
    : (PATTERNS_AVAILABLE ? UNLOCK_TARGET_PATTERN : null);

  const generation = detectGeneration(fileData, opts);

  if (!patternsReady || !unlockTarget) {
    return {
      generation,
      status: 'PATTERN_MISSING',
      matchOffset: null,
      patched: new Uint8Array(fileData),
      flagSet: false,
    };
  }

  if (isAlreadyUnlocked(fileData, opts)) {
    return {
      generation,
      status: 'already_unlocked',
      matchOffset: null,
      patched: new Uint8Array(fileData),
      flagSet: fileData.length > UNLOCK_FLAG_OFFSET && fileData[UNLOCK_FLAG_OFFSET] === UNLOCK_FLAG_BYTE,
    };
  }

  const out = new Uint8Array(fileData);
  let matchOffset = null;
  let patternFound = false;

  const idx = scanForPattern(out, unlockTarget, 0);
  if (idx >= 0) {
    out[idx] = 0xE8;
    matchOffset = idx;
    patternFound = true;
  }

  let flagSet = false;
  if (out.length > UNLOCK_FLAG_OFFSET) {
    out[UNLOCK_FLAG_OFFSET] = UNLOCK_FLAG_BYTE;
    flagSet = true;
  }

  const status = patternFound
    ? 'unlocked'
    : flagSet
      ? 'offset_only'
      : 'pattern_not_found';

  return { generation, status, matchOffset, patched: out, flagSet };
}
