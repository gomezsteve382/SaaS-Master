import {crc16, crc8rf, rfhGen2VinCs, rfhGen2DetectMagic} from './crc.js';
import {writePcmSec6} from './securityBytes.js';
import {classifyPcmSec6,PCM_VIN_OFFSETS_GPEC2A} from './parseModule.js';
import {reverse16} from './immoSecret.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

function hexBytes(arr) {
  return Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function readAscii(data, off, len) {
  if (off + len > data.length) return null;
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = data[off + i];
    if (b < 0x20 || b > 0x7E) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

function readVin(data, off) {
  if (off + 17 > data.length) return null;
  const s = readAscii(data, off, 17);
  if (!s) return null;
  const u = s.toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(u) ? u : null;
}

function detectRfhGen(data) {
  const sz = data.length;
  let score1 = 0, score2 = 0;
  if (sz === 2048) score1 += 2;
  if (sz === 4096) score2 += 2;
  if (sz === 8192) score2 += 1;
  if (sz >= 0xD2) {
    const s16a = data.slice(0xAE, 0xBE);
    const s16b = data.slice(0xC0, 0xD0);
    const notBlankA = !s16a.every(b => b === 0xFF || b === 0x00);
    const notBlankB = !s16b.every(b => b === 0xFF || b === 0x00);
    if (notBlankA || notBlankB) score2 += 2;
  }
  if (sz >= 0xA4) {
    const v = readVin(data, 0x92);
    if (v) score2 += 2;
  }
  return score2 >= score1 ? 'gen2' : 'gen1';
}

/**
 * Detect Gen2 hardware-version boundary from the mirrored VINs at 0xEA5/0xEB9/0xECD/0xEE1.
 * Returns { magic, hwVersion, source } where:
 *   magic = 0x87 (Gen2 HW v19+) | 0xDB (Gen2 2020+ Redeye) | null
 *   hwVersion = 'v19plus' | '2020plus' | 'unknown'
 */
function detectGen2HwVersion(data) {
  const sz = data.length;
  for (const o of [0xEA5, 0xEB9, 0xECD, 0xEE1]) {
    if (o + 18 > sz) continue;
    const st = data.slice(o, o + 17);
    if (st.every(b => b === 0xFF || b === 0)) continue;
    const sc = data[o + 17];
    if (sc === 0xFF || sc === 0x00) continue;
    const m = rfhGen2DetectMagic(st, sc);
    if (m === 0x87) return { magic: 0x87, hwVersion: 'v19plus', source: '0x' + o.toString(16) };
    if (m === 0xDB) return { magic: 0xDB, hwVersion: '2020plus', source: '0x' + o.toString(16) };
  }
  return { magic: null, hwVersion: 'unknown', source: null };
}

/**
 * Compute VIN checksum strictly per detected generation/HW-version:
 *   Gen2 v19+      -> rfhGen2VinCs(0x87) (low byte of stored 16-bit CS)
 *   Gen2 2020+     -> rfhGen2VinCs(0xDB) (low byte)
 *   Gen2 unknown   -> try rfhGen2VinCs(0x87) then 0xDB then crc16 (full 16-bit)
 *   Gen1/pre-v19   -> crc8rf (low byte) then crc16 (full 16-bit) fallback
 */
function computeVinCs(vin17, storedCs16, gen, hw) {
  const lo = storedCs16 & 0xFF;
  if (gen === 'gen2') {
    if (hw.magic === 0x87) {
      const c = rfhGen2VinCs(vin17, 0x87);
      return { algo: 'rfhGen2VinCs(0x87) [Gen2 v19+]', ok: c === lo, calc: c };
    }
    if (hw.magic === 0xDB) {
      const c = rfhGen2VinCs(vin17, 0xDB);
      return { algo: 'rfhGen2VinCs(0xDB) [Gen2 2020+]', ok: c === lo, calc: c };
    }
    // Gen2 unknown HW version: try v19+ (rfhGen2VinCs 0x87), then 2020+ (0xDB),
    // then pre-v19 fallback (crc8rf), then full 16-bit CRC16 fallback.
    for (const m of [0x87, 0xDB]) {
      const c = rfhGen2VinCs(vin17, m);
      if (c === lo) return { algo: 'rfhGen2VinCs(0x' + m.toString(16).toUpperCase() + ') [Gen2 detected]', ok: true, calc: c };
    }
    const c8 = crc8rf(vin17);
    if (c8 === lo) return { algo: 'crc8rf [Gen2 pre-v19]', ok: true, calc: c8 };
    const c16 = crc16(vin17);
    return { algo: 'crc16 [Gen2 fallback]', ok: c16 === storedCs16, calc: c16 };
  }
  // Gen1 / pre-v19
  const c8 = crc8rf(vin17);
  if (c8 === lo) return { algo: 'crc8rf [Gen1/pre-v19]', ok: true, calc: c8 };
  const c16 = crc16(vin17);
  return { algo: 'crc16 [Gen1 fallback]', ok: c16 === storedCs16, calc: c16 };
}

function parseSec16(data, off) {
  const sz = data.length;
  if (off + 18 > sz) return { offset: off, present: false };
  const raw = data.slice(off, off + 16);
  const csStored = (data[off + 16] << 8) | data[off + 17];
  const blank = raw.every(b => b === 0xFF || b === 0x00);
  let xr = 0;
  for (let i = 0; i < 16; i++) xr ^= raw[i];
  const csXorByte = xr;
  const csXorWord = (xr << 8) | xr;
  const csOk = !blank && (csStored === csXorWord || csStored === csXorByte || (csStored & 0xFF) === xr);
  const hex = hexBytes(raw);
  const reversed = reverse16(raw);
  const bcmHex = hexBytes(reversed);
  const pinDec = ((raw[14] << 8) | raw[15]).toString().padStart(5, '0');
  return {
    offset: off, present: true, raw: Array.from(raw), reversed: Array.from(reversed),
    hex, bcmHex, csStored, csCalcXor: csXorByte, csCalcWord: csXorWord, csOk, blank, pinDec
  };
}

/**
 * Parse RFH 24C32 (RFHUB) EEPROM dump.
 * Expected size 4096 (Gen2). Warns if 8192 (double-dump) or 2048 (Gen1).
 */
export function parseRFH24C32(buf) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sz = data.length;
  const gen = detectRfhGen(data);
  const sizeWarn = sz === 8192
    ? 'File is 8192 B (double-dump). Expected 4096 B for Gen2 24C32. Using first half offsets only.'
    : (gen === 'gen2' && sz !== 4096 && sz !== 8192) ? 'Unexpected size ' + sz + ' B for Gen2 (expected 4096 B)'
    : (gen === 'gen1' && sz !== 2048) ? 'Unexpected size ' + sz + ' B for Gen1 (expected 2048 B)'
    : null;

  const hw = gen === 'gen2' ? detectGen2HwVersion(data) : { magic: null, hwVersion: 'gen1', source: null };
  const result = { gen, hw, size: sz, sizeWarn, checks: [] };

  // VIN @ 0x92 + CS @ 0xA3 (16-bit, big-endian). Algorithm chosen strictly by detected gen + HW version.
  if (sz >= 0x92 + 19) {
    const raw17 = data.slice(0x92, 0x92 + 17);
    let s = '';
    for (let i = 0; i < 17; i++) s += String.fromCharCode(raw17[i]);
    const csStored = (data[0xA3] << 8) | data[0xA4];
    const isVin = VIN_RE.test(s);
    const csCheck = isVin
      ? computeVinCs(raw17, csStored, gen, hw)
      : { algo: gen === 'gen2' ? 'rfhGen2VinCs' : 'crc8rf', ok: false, calc: 0 };
    result.vin = {
      offset: 0x92, value: isVin ? s : null, raw: Array.from(raw17),
      isValid: isVin, csStored, csCalc: csCheck.calc, csAlgo: csCheck.algo, csOk: csCheck.ok
    };
    result.checks.push({ k: 'VIN ASCII', ok: isVin, msg: isVin ? s : 'Not a valid 17-char VIN' });
    result.checks.push({ k: 'VIN CS (' + csCheck.algo + ')', ok: csCheck.ok, msg: 'stored=0x' + csStored.toString(16).toUpperCase().padStart(4, '0') + ' calc=0x' + csCheck.calc.toString(16).toUpperCase() });
  }

  // PN @ 0x0808 (10B ASCII)
  result.partNumber = readAscii(data, 0x0808, 10);
  // Serial @ 0x0812 (10B ASCII)
  result.serial = readAscii(data, 0x0812, 10);

  // SEC16 slots
  const s1 = parseSec16(data, 0xAE);
  const s2 = parseSec16(data, 0xC0);
  result.sec16Slot1 = s1;
  result.sec16Slot2 = s2;

  const sec16Match = s1.present && s2.present && !s1.blank && !s2.blank
    && s1.raw.every((b, i) => b === s2.raw[i]);
  result.sec16Match = sec16Match;

  // PIN match check
  result.pinMatch = s1.present && s2.present && s1.pinDec === s2.pinDec;

  // CS match check (both slots)
  result.csMatchBoth = s1.present && s2.present && !!s1.csOk && !!s2.csOk;

  // Choose source slot: must be present, non-blank, AND CS-valid.
  // Prefer slot 1 if it satisfies, otherwise fall back to slot 2.
  const slot1Valid = s1.present && !s1.blank && !!s1.csOk;
  const slot2Valid = s2.present && !s2.blank && !!s2.csOk;
  let sourceSlot = null;
  if (slot1Valid) sourceSlot = s1;
  else if (slot2Valid) sourceSlot = s2;
  result.sec16SourceSlot = sourceSlot ? (sourceSlot === s1 ? 1 : 2) : null;

  // SEC6 derived = first 6 bytes of a VALID SEC16 (non-blank AND CS-valid)
  if (sourceSlot) {
    result.sec6 = {
      raw: sourceSlot.raw.slice(0, 6),
      hex: hexBytes(sourceSlot.raw.slice(0, 6)),
      sourceSlot: result.sec16SourceSlot
    };
  } else {
    result.sec6 = null;
    const blankBoth = (s1.present && s1.blank) && (s2.present && s2.blank);
    const noSlots = !s1.present && !s2.present;
    if (noSlots) result.sec6Error = 'RFH file too small — SEC16 slots @0xAE/0xC0 not present';
    else if (blankBoth) result.sec6Error = 'SEC16 is blank (all-FF/00) in both slots — cannot derive SEC6';
    else result.sec6Error = 'SEC16 checksum invalid in both slots — refusing to derive SEC6 from corrupted data';
  }

  result.checks.push({ k: 'SEC16 match', ok: sec16Match, msg: sec16Match ? 'Slot 1 ≡ Slot 2' : 'Slots differ or blank' });
  if (s1.present) result.checks.push({ k: 'SEC16 Slot 1 CS', ok: !!s1.csOk, msg: s1.blank ? 'BLANK' : ('stored=0x' + s1.csStored.toString(16).toUpperCase().padStart(4, '0')) });
  if (s2.present) result.checks.push({ k: 'SEC16 Slot 2 CS', ok: !!s2.csOk, msg: s2.blank ? 'BLANK' : ('stored=0x' + s2.csStored.toString(16).toUpperCase().padStart(4, '0')) });
  result.checks.push({ k: 'PIN match', ok: result.pinMatch, msg: s1.present && s2.present ? ('Slot1=' + s1.pinDec + ' Slot2=' + s2.pinDec) : 'Missing slot' });

  return result;
}

// PCM IMMO state at 0x0011 (the IMMO enable/disable byte). Distinct
// from SEC6 IMMO_DAMAGED status, which is gated on marker @0x3C4 +
// secret bytes @0x3C8. The "(all-FF @ 0x0011)" qualifier disambiguates
// the two: marker-missing PCMs also surface as IMMO_DAMAGED in the
// SEC6 sense, but they are tracked through pcm.sec6 / classifyPcmSec6,
// not this label.
const PCM_IMMO_LABELS = {
  IMMO_DAMAGED: 'IMMO_DAMAGED (all-FF @ 0x0011)',
  ENABLED: 'ENABLED (0x80)',
  DISABLED: 'DISABLED (0x00)',
  UNKNOWN: 'UNKNOWN pattern'
};

/**
 * Parse PCM GPEC2/GPEC2A/GPEC3 dump. Expected canonical size 4096 or 8192 B.
 */
export function parsePCMGPEC(buf) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sz = data.length;
  const result = { size: sz };

  result.sizeWarn = (sz !== 4096 && sz !== 8192)
    ? 'Unexpected size ' + sz + ' B (expected 4096 or 8192 B for canonical Continental GPEC2A PCM dump)'
    : null;

  result.vinCurrent = readVin(data, 0x0000);
  result.vinOriginal = readVin(data, 0x01F0);
  result.partNumber = readAscii(data, 0x0012, 10);
  result.serial = readAscii(data, 0x001C, 14);

  // IMMO: 4-byte pattern at 0x0011
  const immoBytes = sz >= 0x15 ? Array.from(data.slice(0x0011, 0x0015)) : [];
  const allFF = immoBytes.length === 4 && immoBytes.every(b => b === 0xFF);
  const b0 = immoBytes[0];
  let immoState = 'UNKNOWN';
  if (allFF) immoState = 'IMMO_DAMAGED';
  else if (b0 === 0x80) immoState = 'ENABLED';
  else if (b0 === 0x00) immoState = 'DISABLED';
  result.immo = {
    offset: 0x0011, raw: immoBytes, hex: hexBytes(immoBytes),
    state: immoState, label: PCM_IMMO_LABELS[immoState]
  };

  // SEC6 marker (FF FF FF AA at 0x03C4) + raw 6 bytes at 0x03C8 — Task #404.
  // The marker is what tells the PCM bootloader the slot is valid; without
  // it, even a populated 6-byte secret reads as IMMO_DAMAGED in external
  // tools (CGDI / Autel / AlfaOBD / SINCRO / Mitchell 6.x).
  const need = 0x03CE;
  if (sz >= need) {
    const marker = data.slice(0x03C4, 0x03C8);
    const markerOk = marker[0] === 0xFF && marker[1] === 0xFF && marker[2] === 0xFF && marker[3] === 0xAA;
    const s6 = data.slice(0x03C8, 0x03CE);
    // Use the shared classifier so the "populated" / "damaged" /
    // "blank" rules match parseModule.js, fileUtils.js and
    // crossValidate.js exactly. The pre-#404 simple `!allFF && !all00`
    // rule diverged on mostly-FF SEC6 (e.g. FF FF 00 FF FF FF), which
    // could yield a different verdict in the RFH→PCM tab vs the
    // shared cross-module checks for the same dump.
    const cls = classifyPcmSec6(s6);
    const populated = cls.populated && markerOk;
    result.sec6 = {
      offset: 0x03C8, raw: Array.from(s6), hex: hexBytes(s6),
      markerOffset: 0x03C4, markerHex: hexBytes(marker), markerOk,
      blank: cls.blank, populated,
      // damaged = not a valid paired SEC6 from the PCM's POV. That
      // includes "marker missing" (the user-reported regression), not
      // just classifier-damaged secret bytes.
      damaged: !populated,
      classifier: cls,
    };
  } else {
    result.sec6 = null;
  }

  // Task #404 — only canonical GPEC2A sizes (4 KB / 8 KB) are accepted
  // for write. The pre-#404 gate just required `sz >= 0x3CE`, which let
  // arbitrary in-between buffers (e.g. 5000 B) reach the writer; the
  // engine writer would then reject them silently. Hard-block here so
  // the UI surfaces a clear "non-canonical PCM size" error instead.
  const canonical = sz === 4096 || sz === 8192;
  result.writeCheck = {
    need, buf: sz, ok: canonical,
    canonical, expectedSizes: [4096, 8192],
    reason: canonical ? null
          : (sz < need ? 'PCM file too small (need at least 0x03CE bytes, got ' + sz + ')'
                       : 'PCM size ' + sz + ' B is not canonical GPEC2A (expected 4096 or 8192)'),
  };

  return result;
}

/**
 * Compute pairing compatibility between an RFH parse and a PCM parse.
 */
export function computeCompatibility(rfh, pcm) {
  const issues = [];
  const info = [];

  if (!rfh) issues.push('RFH file not loaded');
  if (!pcm) issues.push('PCM file not loaded');
  if (!rfh || !pcm) {
    return { verdict: 'LOCKED', reason: 'Load both RFH and PCM files', issues, info,
      vinEqualBefore: false, sec6EqualBefore: false, sec6FromRfh: null, sec6PcmCurrent: null, canApply: false };
  }

  const rfhVin = rfh.vin?.value || null;
  const pcmVinCur = pcm.vinCurrent || null;
  const vinEqualBefore = !!rfhVin && !!pcmVinCur && rfhVin === pcmVinCur;

  const sec6FromRfh = rfh.sec6 ? rfh.sec6.hex : null;
  const sec6PcmCurrent = pcm.sec6 ? pcm.sec6.hex : null;
  const sec6EqualBefore = !!sec6FromRfh && !!sec6PcmCurrent && sec6FromRfh === sec6PcmCurrent;

  if (rfh.sizeWarn) info.push('RFH: ' + rfh.sizeWarn);
  if (pcm.sizeWarn) info.push('PCM: ' + pcm.sizeWarn);
  if (!pcm.writeCheck.ok) issues.push(pcm.writeCheck.reason || 'PCM not writable');

  if (!rfh.sec6) issues.push('RFH SEC16 is blank/invalid in both slots — cannot derive SEC6');
  if (!rfh.sec16Match) info.push('RFH SEC16 slots differ — using Slot ' + (rfh.sec16SourceSlot || '?'));
  if (rfh.sec6 && rfh.sec16SourceSlot && rfh.sec16SourceSlot !== 1) info.push('RFH SEC6 derived from Slot 2 (Slot 1 blank/invalid)');

  if (!rfhVin) issues.push('RFH VIN at 0x92 is missing or invalid ASCII');
  else if (rfh.vin && !rfh.vin.csOk) info.push('RFH VIN CS check failed (' + rfh.vin.csAlgo + ') — VIN bytes still usable');

  if (pcm.immo.state === 'IMMO_DAMAGED') info.push('PCM IMMO byte pattern is IMMO_DAMAGED (all-FF). Enable the "Repair PCM IMMO byte" toggle to also rewrite 0x0011 → ENABLED (80 00 00 00) on Apply.');

  if (vinEqualBefore) info.push('VIN already matches between RFH and PCM');
  if (sec6EqualBefore) info.push('SEC6 already matches — no change needed');

  let verdict = 'LOCKED';
  let reason = '';
  let canApply = false;
  if (rfh.sec6 && rfhVin && pcm.writeCheck.ok) {
    if (sec6EqualBefore && vinEqualBefore) {
      verdict = 'COMPATIBLE';
      reason = 'Already paired — no write necessary, but Apply will rewrite to confirm';
      canApply = true;
    } else if (vinEqualBefore || !pcmVinCur) {
      verdict = 'COMPATIBLE';
      reason = 'RFH SEC16 valid, VIN matches/blank — safe to apply';
      canApply = true;
    } else {
      verdict = 'WARNING';
      reason = 'RFH and PCM VINs differ — applying will overwrite PCM VIN slots with RFH VIN';
      canApply = true;
    }
  } else {
    verdict = 'LOCKED';
    reason = issues[0] || 'Cannot derive a valid SEC6 + VIN to apply';
    canApply = false;
  }

  return { verdict, reason, issues, info, vinEqualBefore, sec6EqualBefore, sec6FromRfh, sec6PcmCurrent, canApply };
}

// PCM_VIN_OFFSETS is re-exported from PCM_VIN_OFFSETS_GPEC2A in
// parseModule.js (single source of truth — Task #443).
const PCM_VIN_OFFSETS = PCM_VIN_OFFSETS_GPEC2A;
const PCM_SEC6_OFFSET = 0x03C8;
const PCM_IMMO_OFFSET = 0x0011;
const PCM_IMMO_ENABLED_PATTERN = [0x80, 0x00, 0x00, 0x00];

/**
 * Apply RFH-derived SEC6 (and RFH VIN if valid) into a copy of the PCM buffer.
 * If opts.repairImmo is true and the PCM IMMO byte at 0x0011 is reported as
 * IMMO_DAMAGED (all-FF), also rewrite the 4-byte IMMO pattern to ENABLED (0x80 00 00 00).
 * Returns { data, log } or null if not applicable.
 */
export function applyRfhToPcm(rfh, pcm, pcmBuf, opts) {
  if (!rfh || !pcm || !rfh.sec6 || !pcm.writeCheck.ok) return null;
  // Task #404 — delegate the SEC6 + marker write to the engine writer
  // so the canonical FF FF FF AA marker at 0x3C4 gets stamped alongside
  // the 6 secret bytes at 0x3C8. Pre-#404 only the 6 bytes were written
  // and external tools still flagged the resulting PCM as IMMO_DAMAGED.
  const sec6Bytes = new Uint8Array(rfh.sec6.raw);
  const writeRes = writePcmSec6(pcmBuf, sec6Bytes);
  // Hard-fail if the engine writer refused (non-canonical PCM size).
  // Returning a structured error lets the UI disable the download and
  // show a real banner instead of silently writing VINs into a buffer
  // whose SEC6 slot was never stamped.
  if (!writeRes.ok) {
    return {
      data: null, log: [], error: true,
      errorMessage: 'PCM SEC6 write refused — non-canonical PCM size ' + pcmBuf.length
                  + ' B (expected 4096 or 8192). No bytes were written.',
    };
  }
  const out = writeRes.bytes;
  const log = [];
  log.push('PCM SEC6 @ 0x03C8 ← ' + rfh.sec6.hex + ' (RFH SEC16 Slot ' + rfh.sec6.sourceSlot + '[0:6])');
  log.push('PCM SEC6 marker @ 0x03C4 ← FF FF FF AA (canonical Continental tag)');
  const vin = rfh.vin?.value;
  if (vin && VIN_RE.test(vin)) {
    const enc = new TextEncoder().encode(vin);
    for (const off of PCM_VIN_OFFSETS) {
      // Task #446 — surface silent slot drops (pre-#446 a too-small PCM
      // buffer would skip a canonical VIN slot without telling the UI;
      // the donor VIN at that slot then survived the patch silently).
      if (off + 17 > out.length) {
        log.push('PCM VIN @ 0x' + off.toString(16).toUpperCase().padStart(4, '0')
               + ' SKIPPED — slot needs 17 B, buffer is only ' + out.length + ' B');
        continue;
      }
      for (let i = 0; i < 17; i++) out[off + i] = enc[i];
      log.push('PCM VIN @ 0x' + off.toString(16).toUpperCase().padStart(4, '0') + ' ← ' + vin);
    }
  } else {
    log.push('RFH VIN missing/invalid — VIN slots NOT written');
  }
  const repairImmo = !!(opts && opts.repairImmo);
  if (repairImmo) {
    if (out.length < PCM_IMMO_OFFSET + 4) {
      log.push('IMMO repair SKIPPED — PCM buffer too small for 0x0011..0x0014');
    } else if (pcm.immo?.state === 'IMMO_DAMAGED') {
      for (let i = 0; i < 4; i++) out[PCM_IMMO_OFFSET + i] = PCM_IMMO_ENABLED_PATTERN[i];
      log.push('PCM IMMO @ 0x0011 ← 80 00 00 00 (ENABLED) [was IMMO_DAMAGED all-FF]');
    } else {
      log.push('IMMO repair SKIPPED — PCM IMMO state is ' + (pcm.immo?.label || 'UNKNOWN') + ' (only repairs IMMO_DAMAGED)');
    }
  }
  return { data: out, log };
}

export const RFH_PCM_CONST = { PCM_VIN_OFFSETS, PCM_SEC6_OFFSET, PCM_IMMO_OFFSET, PCM_IMMO_ENABLED_PATTERN };

/* ----------------------------------------------------------------------------
 * planPcmRepair({ pcmBytes, targetVin, secret6 })  — Task #574
 *
 * Pure planner for a "Repair PCM" download. Given a known-good target
 * VIN (from BCM, which has been confirmed to match the RFHUB) and the
 * 6-byte pairing secret (first 6 bytes of the trusted RFHUB SEC16),
 * produces a patched copy of the PCM buffer with ONLY the offsets that
 * were genuinely off rewritten:
 *   - VIN slots @ PCM_VIN_OFFSETS_GPEC2A (only slots that differ)
 *   - SEC6 marker FF FF FF AA @ 0x03C4 (only when missing/wrong)
 *   - SEC6 secret bytes @ 0x03C8 (only when they differ from secret6)
 *   - IMMO byte @ 0x0011 → 0x80 (whenever the byte is NOT already
 *     0x80/ENABLED — covers both the all-FF IMMO_DAMAGED state and the
 *     0x00/DISABLED state, per task spec "IMMO byte not enabled")
 *
 * Refuses (returns ok:false with a plain-English reason) when:
 *   - PCM size is not 4096 or 8192
 *   - target VIN is missing/invalid
 *   - secret6 length != 6 or is blank (all-FF or all-00)
 *
 * Returns { ok, patchedBytes, edits, reason }.
 * Each edit: { offset, length, before, after, label } with hex strings.
 * The patched buffer is byte-identical to the input at every offset
 * NOT listed in edits.
 * ---------------------------------------------------------------------------- */
export function planPcmRepair({ pcmBytes, targetVin, secret6 }) {
  const SEC6_MARKER_OFFSET = 0x03C4;
  const SEC6_OFFSET = 0x03C8;
  const IMMO_OFFSET = 0x0011;
  const SEC6_MARKER = [0xFF, 0xFF, 0xFF, 0xAA];

  if (!pcmBytes || (!(pcmBytes instanceof Uint8Array) && !Array.isArray(pcmBytes))) {
    return { ok: false, reason: 'PCM bytes missing or not a byte array.' };
  }
  const sz = pcmBytes.length;
  if (sz !== 4096 && sz !== 8192) {
    return { ok: false, reason: 'PCM size ' + sz + ' B is not canonical GPEC2A. Repair only supports 4096 B (95320) or 8192 B (95640) dumps.' };
  }
  if (!targetVin || !VIN_RE.test(targetVin)) {
    return { ok: false, reason: 'Target VIN missing or not a valid 17-character VIN.' };
  }
  const sec = secret6 instanceof Uint8Array ? secret6 : Uint8Array.from(secret6 || []);
  if (sec.length !== 6) {
    return { ok: false, reason: 'Pairing secret must be 6 bytes (got ' + sec.length + ').' };
  }
  const allFF = sec.every(b => b === 0xFF);
  const all00 = sec.every(b => b === 0x00);
  if (allFF || all00) {
    return { ok: false, reason: 'Pairing secret is blank (' + (allFF ? 'all 0xFF' : 'all 0x00') + ') — refusing to write a virgin SEC6 into the PCM.' };
  }

  const patched = new Uint8Array(pcmBytes);
  const edits = [];
  const fmtOff = (o) => '0x' + o.toString(16).toUpperCase().padStart(4, '0');

  const enc = new TextEncoder().encode(targetVin);
  for (const off of PCM_VIN_OFFSETS_GPEC2A) {
    if (off + 17 > patched.length) continue;
    const beforeArr = patched.slice(off, off + 17);
    let differs = false;
    for (let i = 0; i < 17; i++) if (beforeArr[i] !== enc[i]) { differs = true; break; }
    if (!differs) continue;
    let beforeAscii = '';
    for (let i = 0; i < 17; i++) {
      const b = beforeArr[i];
      beforeAscii += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.';
    }
    for (let i = 0; i < 17; i++) patched[off + i] = enc[i];
    edits.push({
      offset: off, length: 17,
      before: hexBytes(beforeArr),
      after: hexBytes(enc),
      beforeAscii, afterAscii: targetVin,
      label: 'VIN slot @' + fmtOff(off),
    });
  }

  const beforeMarker = patched.slice(SEC6_MARKER_OFFSET, SEC6_MARKER_OFFSET + 4);
  const markerOk = beforeMarker[0] === 0xFF && beforeMarker[1] === 0xFF && beforeMarker[2] === 0xFF && beforeMarker[3] === 0xAA;
  if (!markerOk) {
    const beforeHex = hexBytes(beforeMarker);
    for (let i = 0; i < 4; i++) patched[SEC6_MARKER_OFFSET + i] = SEC6_MARKER[i];
    edits.push({
      offset: SEC6_MARKER_OFFSET, length: 4,
      before: beforeHex,
      after: 'FF FF FF AA',
      label: 'SEC6 marker @' + fmtOff(SEC6_MARKER_OFFSET) + ' (canonical FF FF FF AA tag)',
    });
  }

  const beforeSec6 = patched.slice(SEC6_OFFSET, SEC6_OFFSET + 6);
  let sec6Differs = false;
  for (let i = 0; i < 6; i++) if (beforeSec6[i] !== sec[i]) { sec6Differs = true; break; }
  if (sec6Differs) {
    edits.push({
      offset: SEC6_OFFSET, length: 6,
      before: hexBytes(beforeSec6),
      after: hexBytes(sec),
      label: 'SEC6 secret @' + fmtOff(SEC6_OFFSET) + ' (first 6 B of trusted RFHUB SEC16)',
    });
    for (let i = 0; i < 6; i++) patched[SEC6_OFFSET + i] = sec[i];
  }

  /* IMMO repair: rewrite to ENABLED (0x80 00 00 00) whenever the
   * current 4-byte IMMO pattern at 0x0011 is not already exactly that.
   * Per task #574 spec, "IMMO byte not enabled" is a repairable
   * condition, which covers both IMMO_DAMAGED (all-FF) and DISABLED
   * (0x00 00 00 00) states. */
  const immoBefore = patched.slice(IMMO_OFFSET, IMMO_OFFSET + 4);
  const immoAlreadyEnabled =
    immoBefore[0] === PCM_IMMO_ENABLED_PATTERN[0] &&
    immoBefore[1] === PCM_IMMO_ENABLED_PATTERN[1] &&
    immoBefore[2] === PCM_IMMO_ENABLED_PATTERN[2] &&
    immoBefore[3] === PCM_IMMO_ENABLED_PATTERN[3];
  if (!immoAlreadyEnabled) {
    const wasAllFF = immoBefore.every(b => b === 0xFF);
    const wasAll00 = immoBefore.every(b => b === 0x00);
    const stateLabel = wasAllFF ? 'IMMO_DAMAGED all-FF'
                     : wasAll00 ? 'DISABLED 00 00 00 00'
                     : 'NOT_ENABLED ' + hexBytes(immoBefore);
    const beforeHex = hexBytes(immoBefore);
    for (let i = 0; i < 4; i++) patched[IMMO_OFFSET + i] = PCM_IMMO_ENABLED_PATTERN[i];
    edits.push({
      offset: IMMO_OFFSET, length: 4,
      before: beforeHex,
      after: hexBytes(PCM_IMMO_ENABLED_PATTERN),
      label: 'IMMO byte @' + fmtOff(IMMO_OFFSET) + ' (was ' + stateLabel + ' → ENABLED 0x80)',
    });
  }

  return { ok: true, patchedBytes: patched, edits };
}
