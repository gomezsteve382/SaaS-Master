/* ============================================================================
 * zf8hp.js — ZF 8HP TCU dump handling (GROUNDED on real bench dumps)
 *
 * This module replaces the earlier synthetic "ZF8HP"-ASCII-header contract,
 * which no real dump ever matched. It is built byte-for-byte from the real
 * 8HP TCU reads on the bench:
 *
 *   1. OBDSTAR-tool internal-EEPROM dump  (0x20000 / 128 KB)
 *      - Unused regions are padded with the repeating ASCII filler "OBDSTAR6"
 *        (the OBDSTAR programmer's signature), so these are tool-wrapped reads,
 *        not raw TCU EEPROM images.
 *      - The vehicle-identity block is mirrored ~3x and holds, in order:
 *          [record marker] VIN_A(17 ASCII) VIN_B(17 ASCII) [01 FF FF FF ...]
 *        The two VINs are stored ADJACENT with NO per-VIN checksum between or
 *        after them (confirmed across every bench file).
 *      - Also present as plain ASCII: the ZF unit number (e.g. 1034420271),
 *        the Mopar assembly part number (05035827AC), the ZF calibration /
 *        software id (0260TP1122V02), and a build date ("Oct  1 2019").
 *
 *   2. Infineon TriCore program flash dump (0x200000 / 2 MB, *.HexTemp)
 *      - Begins with the c3 05 c3 05 ... boot pattern; the only reliable plain
 *        ASCII is the software-protection version string, e.g.
 *        "TPROT_TC_G2_V05.01.00" at 0x1F00. No clean VIN, no write path.
 *
 * HONESTY / refuse-on-doubt:
 *   - The immobilizer secret (ISN) and any global EEPROM integrity check are
 *     NOT located/verified in these dumps, so this module never claims to read
 *     or write them. VIN write only patches the ASCII VIN mirrors.
 *   - VIN validation uses the ISO-3779 / NHTSA check digit so calibration
 *     strings that merely look 17-char (e.g. "1034420271011270H") are rejected.
 *   - When a dump carries two distinct VINs the writer refuses to guess and
 *     requires the caller to name the source VIN to replace.
 * ============================================================================ */

export const OBDSTAR_FILLER = 'OBDSTAR6';
export const OBDSTAR_8HP_EEPROM_SIZE = 0x20000;   // 128 KB
export const TRICORE_8HP_FLASH_SIZE = 0x200000;   // 2 MB

/* Grounded identity patterns (all observed as plain ASCII in real dumps).
 * No word boundaries: the ZF unit number and Mopar p/n are stored immediately
 * adjacent to the calibration string, so \b anchors would never match. */
const ZF_UNIT_RE = /103[0-9]{7}/g;                 // ZF Saarbrücken unit no. (1034420271 …)
const MOPAR_PART_RE = /0[0-9]{7}[A-Z]{2}/g;        // Mopar assembly p/n (05035827AC …)
const CAL_RE = /0260[A-Z0-9]{2}[0-9]{4}V[0-9]{2}/g; // ZF calibration / sw id (0260TP1122V02 …)
const DATE_RE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s{1,2}[0-9 ][0-9]\s[0-9]{4}/g;
const SW_VERSION_RE = /[A-Z0-9_]{3,}_V[0-9]{2}\.[0-9]{2}\.[0-9]{2}/g; // TriCore TPROT_TC_G2_V05.01.00

/* Confidently-known ZF unit numbers → marketing variant. Extend only with
 * bench-confirmed mappings; unknown units report the raw number, never a guess. */
const KNOWN_ZF_UNITS = {
  '1034420271': { variant: '8HP95', label: 'ZF 8HP95 (Jeep Grand Cherokee SRT/Trackhawk, Durango)' },
};

const VIN_CHARSET_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const VIN_TRANS = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
for (let i = 0; i <= 9; i++) VIN_TRANS[String(i)] = i;
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** ISO-3779 / NHTSA VIN check-digit validation (position 9). */
export function vinCheckDigitOk(vin) {
  if (!VIN_CHARSET_RE.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += VIN_TRANS[vin[i]] * VIN_WEIGHTS[i];
  const r = sum % 11;
  const expect = r === 10 ? 'X' : String(r);
  return vin[8] === expect;
}

function asUint8(buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

function latin1(data, start = 0, end = data.length) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(data[i]);
  return s;
}

function uniqueByValue(arr) {
  return Array.from(new Set(arr));
}

/** True iff the buffer contains the repeating OBDSTAR programmer filler. */
export function containsObdstarFiller(data) {
  const needle = OBDSTAR_FILLER;
  const text = latin1(data, 0, Math.min(data.length, 0x20000));
  return text.includes(needle);
}

/** Every check-digit-valid VIN occurrence in the buffer: [{ vin, offset }]. */
export function extractObdstar8hpVins(data) {
  const text = latin1(data);
  const re = /[A-HJ-NPR-Z0-9]{17}/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    // Check digit + an alphabetic WMI char in position 2. Every FCA/Stellantis
    // VIN (1C4…, 2C3…, ZAR…) has a letter there; the numeric-prefix calibration
    // strings (1034420271…, 1039S…) that happen to pass the check digit do not.
    if (vinCheckDigitOk(m[0]) && /[A-HJ-NPR-Z]/.test(m[0][1])) {
      out.push({ vin: m[0], offset: m.index });
    }
  }
  return out;
}

/** True iff `data` is an OBDSTAR-wrapped 8HP internal-EEPROM dump. */
export function isObdstar8hpEeprom(data) {
  if (!data || data.length !== OBDSTAR_8HP_EEPROM_SIZE) return false;
  if (!containsObdstarFiller(data)) return false;
  // 8HP fingerprint so other 128 KB OBDSTAR dumps aren't misread as a TCU.
  const text = latin1(data);
  ZF_UNIT_RE.lastIndex = 0;
  CAL_RE.lastIndex = 0;
  return ZF_UNIT_RE.test(text) || CAL_RE.test(text) || extractObdstar8hpVins(data).length > 0;
}

/** True iff `data` is an Infineon TriCore 8HP program-flash dump. */
export function isTricore8hpFlash(data) {
  if (!data || data.length !== TRICORE_8HP_FLASH_SIZE) return false;
  return latin1(data, 0, data.length).includes('TPROT_');
}

/** True iff `data` is any recognised ZF-8HP TCU dump (EEPROM or flash). */
export function isZf8hpImage(data) {
  return isObdstar8hpEeprom(data) || isTricore8hpFlash(data);
}

function grabAll(text, re) {
  re.lastIndex = 0;
  return uniqueByValue(text.match(re) || []);
}

/** Parse an OBDSTAR-wrapped 8HP internal-EEPROM dump. */
export function parseObdstar8hpEeprom(buf) {
  const data = asUint8(buf);
  const text = latin1(data);

  const vinHits = extractObdstar8hpVins(data);
  const distinctVins = uniqueByValue(vinHits.map((v) => v.vin));
  const primaryVin = vinHits.length ? vinHits[0].vin : null;

  const zfUnit = grabAll(text, ZF_UNIT_RE).find((u) => /^103/.test(u)) || grabAll(text, ZF_UNIT_RE)[0] || null;
  const moparPart = grabAll(text, MOPAR_PART_RE).find((p) => /^050/.test(p)) || null;
  const calibrationIds = grabAll(text, CAL_RE);
  const buildDate = grabAll(text, DATE_RE)[0] || null;

  const known = zfUnit ? KNOWN_ZF_UNITS[zfUnit] : null;
  const variant = known ? known.variant : null;
  const variantLabel = known ? known.label : (zfUnit ? `ZF 8HP TCU (ZF unit ${zfUnit})` : 'ZF 8HP TCU');

  const banners = [{
    level: 'info',
    message: 'OBDSTAR-tool internal-EEPROM dump. VIN / ZF unit / Mopar p/n / calibration / build-date are read from plain-ASCII ground truth. The immobilizer secret (ISN) and any global EEPROM checksum are not located in this block — neither is read or written.',
  }];
  if (distinctVins.length > 1) {
    banners.push({
      level: 'warn',
      message: `This dump carries ${distinctVins.length} distinct VINs (${distinctVins.join(', ')}). A VIN write must name which one to replace.`,
    });
  } else if (distinctVins.length === 0) {
    banners.push({ level: 'warn', message: 'No check-digit-valid VIN found — virgin or non-standard dump.' });
  }

  return {
    ok: true,
    type: 'ZF_8HP_TCU',
    format: 'OBDSTAR_EEPROM',
    size: data.length,
    vins: vinHits,
    vinSlots: vinHits.map((v) => ({ offset: v.offset, vin: v.vin, present: true })),
    distinctVins,
    vin: distinctVins.length === 1 ? distinctVins[0] : primaryVin,
    primaryVin,
    zfUnit,
    variant,
    variantLabel,
    moparPart,
    calibrationIds,
    buildDate,
    softwareVersion: null,
    writeSafe: distinctVins.length >= 1,
    banners,
  };
}

/** Parse an Infineon TriCore 8HP program-flash dump (version string only). */
export function parseTricore8hpFlash(buf) {
  const data = asUint8(buf);
  const text = latin1(data, 0, Math.min(data.length, 0x40000));
  SW_VERSION_RE.lastIndex = 0;
  let softwareVersion = null;
  let versionOffset = null;
  const m = SW_VERSION_RE.exec(text);
  if (m) {
    softwareVersion = m[0];
    versionOffset = m.index;
  }
  return {
    ok: true,
    type: 'ZF_8HP_TCU',
    format: 'TRICORE_FLASH',
    size: data.length,
    vins: [],
    vinSlots: [],
    distinctVins: [],
    vin: null,
    primaryVin: null,
    zfUnit: null,
    variant: null,
    variantLabel: 'ZF 8HP TCU — Infineon TriCore program flash',
    moparPart: null,
    calibrationIds: [],
    buildDate: null,
    softwareVersion,
    versionOffset,
    writeSafe: false,
    banners: [{
      level: 'info',
      message: softwareVersion
        ? `TriCore program flash. Software version "${softwareVersion}" surfaced; this image holds no plain-ASCII VIN and has no write path here.`
        : 'TriCore program flash. No software-version string located; no VIN and no write path here.',
    }],
  };
}

/** Parse any recognised ZF-8HP dump; `ok:false` if it is neither format. */
export function parseZf8hpImage(buf) {
  const data = asUint8(buf);
  if (isObdstar8hpEeprom(data)) return parseObdstar8hpEeprom(data);
  if (isTricore8hpFlash(data)) return parseTricore8hpFlash(data);
  return { ok: false, reason: 'Not a recognised ZF-8HP TCU dump (no OBDSTAR EEPROM filler or TriCore flash signature).' };
}

/**
 * Patch a target VIN into every mirror of a source VIN inside an OBDSTAR 8HP
 * EEPROM dump. `arg` may be a target-VIN string (only valid for single-VIN
 * dumps) or `{ targetVin, sourceVin }`. There is no per-VIN checksum in this
 * block, so only the ASCII VIN bytes are rewritten. Returns `{ ok, bytes, log }`.
 */
export function patchZf8hpVin(buf, arg) {
  const data = asUint8(buf);
  const opts = typeof arg === 'string' ? { targetVin: arg } : (arg || {});
  const targetVin = (opts.targetVin || '').toUpperCase();
  let sourceVin = opts.sourceVin ? opts.sourceVin.toUpperCase() : null;

  if (!isObdstar8hpEeprom(data)) {
    return { ok: false, reason: 'VIN write supported only on OBDSTAR 8HP internal-EEPROM dumps.', log: [] };
  }
  if (!vinCheckDigitOk(targetVin)) {
    return { ok: false, reason: 'Target VIN missing or fails the VIN check digit.', log: [] };
  }

  const parsed = parseObdstar8hpEeprom(data);

  // allVins mode: rewrite EVERY VIN occurrence (every mirror of every distinct
  // VIN) to the target. This matches the codebase-wide BCM/RFHUB convention —
  // the generic patchFile pipeline "writes the new VIN at every detected slot"
  // so a module adapted into a target vehicle reports that VIN everywhere. The
  // surgical { sourceVin } path below is for preserving a second distinct VIN.
  if (opts.allVins) {
    const targets = parsed.vins.filter((v) => v.vin && v.vin !== targetVin);
    if (targets.length === 0) {
      return { ok: false, reason: 'No replaceable VIN slot found (dump already carries only the target VIN, or none).', log: [] };
    }
    const outAll = new Uint8Array(data);
    const logAll = [];
    for (const slot of targets) {
      for (let i = 0; i < 17; i++) outAll[slot.offset + i] = targetVin.charCodeAt(i) & 0xff;
      logAll.push(`ZF-8HP VIN @ 0x${slot.offset.toString(16).toUpperCase().padStart(6, '0')} ${slot.vin} → ${targetVin}`);
    }
    const priorVins = uniqueByValue(targets.map((v) => v.vin));
    if (priorVins.length > 1) {
      logAll.push(`Note: dump carried ${priorVins.length} distinct VINs (${priorVins.join(', ')}); all overwritten with ${targetVin}.`);
    }
    logAll.push(`Patched ${targets.length} VIN slot${targets.length === 1 ? '' : 's'}. No per-VIN checksum in this block — none recomputed.`);
    return { ok: true, bytes: outAll, log: logAll, vin: targetVin, mirrorsPatched: targets.length };
  }

  if (!sourceVin) {
    if (parsed.distinctVins.length === 1) {
      sourceVin = parsed.distinctVins[0];
    } else if (parsed.distinctVins.length === 0) {
      return { ok: false, reason: 'No existing VIN to replace in this dump.', log: [] };
    } else {
      return {
        ok: false,
        reason: `Dump holds ${parsed.distinctVins.length} VINs (${parsed.distinctVins.join(', ')}). Specify which to replace via { sourceVin }, or { allVins: true } to overwrite every slot.`,
        log: [],
      };
    }
  }
  if (!parsed.distinctVins.includes(sourceVin)) {
    return { ok: false, reason: `Source VIN ${sourceVin} not present in this dump.`, log: [] };
  }
  if (sourceVin === targetVin) {
    return { ok: false, reason: 'Target VIN equals source VIN — nothing to write.', log: [] };
  }

  const out = new Uint8Array(data);
  const offsets = parsed.vins.filter((v) => v.vin === sourceVin).map((v) => v.offset);
  const log = [];
  for (const off of offsets) {
    for (let i = 0; i < 17; i++) out[off + i] = targetVin.charCodeAt(i) & 0xff;
    log.push(`ZF-8HP VIN @ 0x${off.toString(16).toUpperCase().padStart(6, '0')} ${sourceVin} → ${targetVin}`);
  }
  log.push(`Patched ${offsets.length} mirror${offsets.length === 1 ? '' : 's'}. No per-VIN checksum in this block — none recomputed.`);
  return { ok: true, bytes: out, log, vin: targetVin, sourceVin, mirrorsPatched: offsets.length };
}

/**
 * Build a deterministic OBDSTAR-style 8HP EEPROM fixture for tests/docs:
 * a 128 KB buffer of OBDSTAR6 filler with the identity block (two VINs +
 * ZF unit + Mopar p/n + calibration + date) written into 3 mirrors.
 */
export function makeZf8hpFixture({
  vinA = '1C4RJFN98MC842152',
  vinB = '1C4RJFDJ4EC359481',
  zfUnit = '1034420271',
  moparPart = '05035827AC',
  calibration = '0260TP1122V02',
  date = 'Oct  1 2019',
} = {}) {
  const buf = new Uint8Array(OBDSTAR_8HP_EEPROM_SIZE);
  const filler = Array.from(OBDSTAR_FILLER).map((c) => c.charCodeAt(0));
  for (let i = 0; i < buf.length; i++) buf[i] = filler[i % filler.length];
  const writeAscii = (off, str) => { for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i) & 0xff; };
  const mirrors = [0x0ae6f, 0x12e6f, 0x1ae6f];
  for (const base of mirrors) {
    buf[base - 1] = 0x01; // record marker (matches observed layout)
    writeAscii(base, vinA);
    writeAscii(base + 17, vinB);
    buf[base + 34] = 0x01;
    buf[base + 35] = 0xff; buf[base + 36] = 0xff; buf[base + 37] = 0xff;
  }
  // Identity strings near the end (matches the observed ~0x1A000+ region).
  writeAscii(0x1acdd, 'A' + moparPart);
  writeAscii(0x1ae53, date);
  writeAscii(0x1ba33, moparPart);
  writeAscii(0x1bc9f, zfUnit + calibration);
  return buf;
}
