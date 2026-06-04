/* ============================================================================
 * eepromLayoutScan.js — unified EEPROM layout scan with region map
 *
 * Single entry point: `scanEepromLayout(bytes)` dispatches on the existing
 * `parseModule` detector and translates known offsets into a unified region
 * list. The AI assistant and the Mismatch Wizard can call this without
 * knowing which per-family parser to pick.
 *
 * Return shape:
 *   {
 *     moduleType: string,            // e.g. 'BCM', 'GPEC2A', 'UNKNOWN'
 *     confidence: 'high'|'medium'|'low',
 *     regions: Array<{
 *       offset: number,
 *       length: number,
 *       label: string,               // human-readable
 *       role: RoleString,            // see ROLES below
 *       preview: string,             // short hex / ASCII preview
 *     }>
 *   }
 *
 * Roles (exhaustive):
 *   vin | seed_key | skim_pair | pin | calibration_id | dtc | immo |
 *   boot | flash_flag | unknown
 *
 * Families handled (reuses existing parsers — no parallel detection logic):
 *   BCM, RFHUB (Gen1 + Gen2), GPEC2A, 95640, XC2268_RFHUB, ZF_8HP_TCU
 *
 * For UNKNOWN type: entropy bands, long 0xFF/0x00 runs, and ASCII clusters
 * are flagged with role:'unknown' so the caller still gets a useful map.
 * ============================================================================ */

import {
  parseModule,
  PCM_VIN_OFFSETS_GPEC2A,
  RFH_GEN2_VIN_OFFSETS,
  RFH_GEN1_VIN_OFFSET,
  BCM_FULL_VIN_BASES_PARSED,
  BCM_PARTIAL_VIN_OFFSETS,
  EEP95640_VIN_OFFSETS,
} from './parseModule.js';
import { XC2268_VIN_SLOTS, XC2268_VIN_LEN, XC2268_VARIANT_OFFSET } from './xc2268Rfhub.js';
import { BCM_PARTIAL_VIN_LEN } from './donorLeakScan.js';

export const ROLES = Object.freeze([
  'vin', 'seed_key', 'skim_pair', 'pin', 'calibration_id',
  'dtc', 'immo', 'boot', 'flash_flag', 'unknown',
]);

const ROLE_COLORS = {
  vin:            '#FF9800',
  seed_key:       '#AB47BC',
  skim_pair:      '#EF5350',
  pin:            '#EC407A',
  calibration_id: '#26A69A',
  dtc:            '#78909C',
  immo:           '#42A5F5',
  boot:           '#8D6E63',
  flash_flag:     '#FFCA28',
  unknown:        '#9E9E9E',
};
export { ROLE_COLORS };

function hexPreview(data, offset, len, maxBytes = 8) {
  const end = Math.min(offset + len, data.length);
  const count = Math.min(end - offset, maxBytes);
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push(data[offset + i].toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(' ') + (len > maxBytes ? ' …' : '');
}

function asciiPreview(data, offset, len) {
  const end = Math.min(offset + len, data.length);
  let s = '';
  for (let i = offset; i < end; i++) {
    const b = data[i];
    s += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
  }
  return s;
}

function region(offset, length, label, role, data) {
  return {
    offset,
    length,
    label,
    role,
    preview: hexPreview(data, offset, length),
  };
}

function vinRegion(offset, label, data) {
  return {
    offset,
    length: 17,
    label,
    role: 'vin',
    preview: asciiPreview(data, offset, 17),
  };
}

/* ── per-family region builders ─────────────────────────────────────────── */

function regionsGpec2a(info, data) {
  const out = [];
  for (let i = 0; i < PCM_VIN_OFFSETS_GPEC2A.length; i++) {
    const off = PCM_VIN_OFFSETS_GPEC2A[i];
    if (off + 17 > data.length) continue;
    out.push(vinRegion(off, `VIN slot ${i + 1} (GPEC2A @ 0x${off.toString(16).toUpperCase()})`, data));
  }
  if (data.length > 0x0012) {
    out.push(region(0x0011, 1, 'SKIM immobilizer byte', 'skim_pair', data));
  }
  if (data.length >= 0x020B) {
    out.push(region(0x0203, 8, 'Secret key (primary)', 'seed_key', data));
  }
  if (data.length >= 0x0369) {
    out.push(region(0x0361, 8, 'Secret key (mirror)', 'seed_key', data));
  }
  if (data.length >= 0x0898) {
    out.push(region(0x0888, 16, 'Transponder keys (4 × 4 B)', 'immo', data));
  }
  if (data.length >= 0x0C94) {
    out.push(region(0x0C8C, 8, 'ZZZZ tamper marker', 'flash_flag', data));
  }
  if (data.length >= 0x3CE) {
    out.push(region(0x3C4, 4, 'PCM SEC6 marker (FF FF FF AA)', 'immo', data));
    out.push(region(0x3C8, 6, 'PCM SEC6 (BCM pairing secret)', 'seed_key', data));
  }
  if (data.length >= 0x0FAF) {
    out.push(region(0x0FA1, 13, 'Software release / part number', 'calibration_id', data));
  }
  return out;
}

function regionsRfhubGen2(info, data) {
  const out = [];
  for (let i = 0; i < RFH_GEN2_VIN_OFFSETS.length; i++) {
    const off = RFH_GEN2_VIN_OFFSETS[i];
    if (off + 18 > data.length) continue;
    out.push({
      offset: off,
      length: 18,
      label: `VIN slot ${i + 1} reversed + CS (Gen2 RFHUB @ 0x${off.toString(16).toUpperCase()})`,
      role: 'vin',
      preview: hexPreview(data, off, 18),
    });
  }
  if (data.length >= 0x051E) {
    out.push(region(0x050E, 16, 'Vehicle secret / SEC16 slot 1', 'seed_key', data));
  }
  if (data.length >= 0x0532) {
    out.push(region(0x0522, 16, 'SEC16 slot 2 (mirror)', 'seed_key', data));
  }
  if (data.length >= 0x0808 + 10) {
    out.push(region(0x0808, 10, 'HW part number', 'calibration_id', data));
  }
  if (data.length >= 0x0812 + 10) {
    out.push(region(0x0812, 10, 'SW part number', 'calibration_id', data));
  }
  if (data.length >= 0x082C + 14) {
    out.push(region(0x082C, 14, 'Calibration ID', 'calibration_id', data));
  }
  if (data.length >= 0x0880 + 20) {
    out.push(region(0x0880, 20, 'FOBIK AA-50 occupancy markers (10 slots)', 'immo', data));
  }
  if (data.length >= 0x40 + 16) {
    out.push(region(0x40, 16, 'Secret key (skey)', 'seed_key', data));
  }
  if (data.length >= RFH_GEN1_VIN_OFFSET + 19) {
    out.push({
      offset: RFH_GEN1_VIN_OFFSET,
      length: 19,
      label: 'VIN @ 0x92 + CRC16',
      role: 'vin',
      preview: asciiPreview(data, RFH_GEN1_VIN_OFFSET, 17),
    });
  }
  return out;
}

function regionsRfhubGen1(info, data) {
  const out = [];
  if (data.length >= RFH_GEN1_VIN_OFFSET + 19) {
    out.push({
      offset: RFH_GEN1_VIN_OFFSET,
      length: 19,
      label: 'VIN @ 0x92 + CRC16 (Gen1 RFHUB only)',
      role: 'vin',
      preview: asciiPreview(data, RFH_GEN1_VIN_OFFSET, 17),
    });
  }
  for (const [slot, off] of [[1, 0x00AE], [2, 0x00C0]]) {
    if (off + 18 > data.length) continue;
    out.push(region(off, 18, `SEC16 slot ${slot} + CS (Gen1)`, 'seed_key', data));
  }
  if (data.length >= 0x00D2 + 8) {
    out.push(region(0x00D2, 8, 'FOBIK AA-50 markers (4 slots)', 'immo', data));
  }
  return out;
}

function regionsBcm(info, data) {
  const out = [];
  for (let i = 0; i < BCM_FULL_VIN_BASES_PARSED.length; i++) {
    const base = BCM_FULL_VIN_BASES_PARSED[i];
    if (base + 25 > data.length) continue;
    out.push({
      offset: base,
      length: 25,
      label: `VIN slot ${i + 1} (BCM @ 0x${base.toString(16).toUpperCase()}) + CRC16`,
      role: 'vin',
      preview: asciiPreview(data, base, 17),
    });
  }
  for (let i = 0; i < BCM_PARTIAL_VIN_OFFSETS.length; i++) {
    const off = BCM_PARTIAL_VIN_OFFSETS[i];
    if (off + BCM_PARTIAL_VIN_LEN + 2 > data.length) continue;
    out.push({
      offset: off,
      length: BCM_PARTIAL_VIN_LEN + 2,
      label: `Partial VIN tail (8 chars) + CRC16 @ 0x${off.toString(16).toUpperCase()}`,
      role: 'vin',
      preview: asciiPreview(data, off, BCM_PARTIAL_VIN_LEN),
    });
  }
  if (data.length >= 0x40D9) {
    out.push(region(0x40C9, 16, 'SEC16 legacy flat slice (0x40C9, LE)', 'seed_key', data));
  }
  if (data.length >= 0x40C0 + 24) {
    out.push(region(0x40C0, 24, 'IMMO primary record block header', 'immo', data));
  }
  if (data.length >= 0x2000 + 24) {
    out.push(region(0x2000, 24, 'IMMO backup block header', 'immo', data));
  }
  for (const off of [0x81A4, 0x81C4, 0x81E4]) {
    if (off + 16 > data.length) continue;
    out.push(region(off, 16, `IMMO key record @ 0x${off.toString(16).toUpperCase()}`, 'immo', data));
  }
  for (const [off, label] of [
    [0x81A0, 'Split SEC16 record 1 header'],
    [0x81C0, 'Split SEC16 record 2 header'],
    [0x81E0, 'Split SEC16 record 3 header'],
  ]) {
    if (off + 32 > data.length) continue;
    out.push(region(off, 32, label, 'seed_key', data));
  }
  if (data.length > 0x8028) {
    out.push(region(0x8028, 1, 'Security lock byte (0x5A = LOCKED)', 'flash_flag', data));
  }
  if (data.length > 0x5862) {
    out.push(region(0x5862, 1, 'FOBIK key count', 'immo', data));
  }
  if (data.length >= 0x5818 + 10) {
    out.push(region(0x5818, 10, 'FOBIK part number', 'calibration_id', data));
  }
  return out;
}

function regions95640(info, data) {
  const out = [];
  for (let i = 0; i < EEP95640_VIN_OFFSETS.length; i++) {
    const off = EEP95640_VIN_OFFSETS[i];
    if (off + 17 > data.length) continue;
    out.push(vinRegion(off, `VIN slot ${i + 1} (95640 @ 0x${off.toString(16).toUpperCase()})`, data));
  }
  if (data.length >= 0x50) {
    out.push(region(0x40, 16, 'Secret key (skey @ 0x40)', 'seed_key', data));
  }
  if (data.length >= 0x84A) {
    out.push(region(0x838, 16, 'BCM SEC16 (raw, 16 B)', 'seed_key', data));
    out.push(region(0x848, 2, 'BCM SEC16 CRC16', 'seed_key', data));
  }
  if (data.length >= 0x240) {
    out.push(region(0x200, 64, 'FOBIK key data block', 'immo', data));
  }
  return out;
}

function regionsXc2268(info, data) {
  const out = [];
  out.push(region(0x0000, 4, 'XC2268 header signature "XC22"', 'boot', data));
  out.push(region(0x0010, 5, 'XC2268 tag "RFHUB"', 'boot', data));
  out.push(region(XC2268_VARIANT_OFFSET, 1, 'Variant tag (0x01/02/03 = Ram 19/20/HD)', 'flash_flag', data));
  for (let i = 0; i < XC2268_VIN_SLOTS.length; i++) {
    const off = XC2268_VIN_SLOTS[i];
    if (off + XC2268_VIN_LEN + 2 > data.length) continue;
    out.push({
      offset: off,
      length: XC2268_VIN_LEN + 2,
      label: `VIN slot ${i + 1} + CRC16 (XC2268 @ 0x${off.toString(16).toUpperCase()})`,
      role: 'vin',
      preview: asciiPreview(data, off, XC2268_VIN_LEN),
    });
  }
  if (data.length >= 4) {
    out.push(region(data.length - 4, 4, 'Image-wide checksum (BE32 CRC16 fold)', 'flash_flag', data));
  }
  return out;
}

function regionsZf8hp(info, data) {
  // Grounded ZF-8HP layout. OBDSTAR EEPROM dumps mirror an identity block
  // holding the VIN(s) (no per-VIN CRC); TriCore flash carries only a
  // software-version string. Annotate the real, observed offsets only.
  const out = [];
  const z = info.zf8hp;
  if (z && z.ok && Array.isArray(z.vinSlots)) {
    for (let i = 0; i < z.vinSlots.length; i++) {
      const s = z.vinSlots[i];
      if (!s || s.offset === undefined) continue;
      out.push({
        offset: s.offset,
        length: 17,
        label: `VIN mirror ${i + 1} (ZF-8HP @ 0x${s.offset.toString(16).toUpperCase()})`,
        role: 'vin',
        preview: asciiPreview(data, s.offset, 17),
      });
    }
  }
  if (z && z.ok && z.softwareVersion && z.versionOffset !== undefined && z.versionOffset !== null) {
    out.push(region(z.versionOffset, z.softwareVersion.length,
      `TriCore software version "${z.softwareVersion}"`, 'flash_flag', data));
  }
  return out;
}

/* ── fallback pass: entropy / plateau / ASCII for UNKNOWN buffers ─────────── */

function regionsUnknown(data) {
  const out = [];
  const sz = data.length;
  if (sz === 0) return out;

  const WIN = 64;
  const STEP = 32;

  const entropy = (slice) => {
    const freq = new Array(256).fill(0);
    for (let i = 0; i < slice.length; i++) freq[slice[i]]++;
    let h = 0;
    for (let i = 0; i < 256; i++) {
      if (freq[i] === 0) continue;
      const p = freq[i] / slice.length;
      h -= p * Math.log2(p);
    }
    return h;
  };

  let i = 0;
  while (i + WIN <= sz) {
    const slice = data.subarray(i, i + WIN);
    const e = entropy(slice);

    if (e > 6.5) {
      let end = i + WIN;
      while (end + WIN <= sz && entropy(data.subarray(end, end + WIN)) > 6.5) end += WIN;
      out.push({
        offset: i,
        length: end - i,
        label: `High-entropy region (possible encrypted/compressed data, entropy ≈ ${e.toFixed(1)})`,
        role: 'unknown',
        preview: hexPreview(data, i, end - i),
      });
      i = end;
      continue;
    }

    const allFF = slice.every(b => b === 0xFF);
    const all00 = slice.every(b => b === 0x00);
    if (allFF || all00) {
      const fill = allFF ? 0xFF : 0x00;
      let end = i + WIN;
      while (end + WIN <= sz && data.subarray(end, end + WIN).every(b => b === fill)) end += WIN;
      out.push({
        offset: i,
        length: end - i,
        label: `Erased region (${allFF ? '0xFF' : '0x00'} fill, ${(end - i).toLocaleString()} bytes)`,
        role: 'unknown',
        preview: allFF ? 'FF FF FF FF FF FF FF FF' : '00 00 00 00 00 00 00 00',
      });
      i = end;
      continue;
    }

    let asciiCount = 0;
    for (let j = 0; j < slice.length; j++) {
      const b = slice[j];
      if ((b >= 0x20 && b < 0x7F) || b === 0x0A || b === 0x0D) asciiCount++;
    }
    if (asciiCount / slice.length > 0.85) {
      let end = i + WIN;
      while (end + WIN <= sz) {
        const s2 = data.subarray(end, end + WIN);
        let ac2 = 0;
        for (let k = 0; k < s2.length; k++) {
          const b = s2[k];
          if ((b >= 0x20 && b < 0x7F) || b === 0x0A || b === 0x0D) ac2++;
        }
        if (ac2 / WIN > 0.85) end += WIN;
        else break;
      }
      out.push({
        offset: i,
        length: end - i,
        label: `ASCII cluster (possible calibration data / strings, ${(end - i)} bytes)`,
        role: 'unknown',
        preview: asciiPreview(data, i, Math.min(end - i, 16)),
      });
      i = end;
      continue;
    }

    i += STEP;
  }

  return out;
}

/* ── confidence scoring ──────────────────────────────────────────────────── */

function confidenceFor(type, info) {
  if (type === 'UNKNOWN') return 'low';
  if (['BCM', 'GPEC2A', 'RFHUB', '95640', 'XC2268_RFHUB', 'ZF_8HP_TCU'].includes(type)) {
    if (info.vins && info.vins.length > 0) return 'high';
    return 'medium';
  }
  return 'low';
}

/* ── public entry point ──────────────────────────────────────────────────── */

/**
 * Scan `bytes` and return a unified region map.
 *
 * @param {Uint8Array|ArrayBuffer} bytes - Raw module binary.
 * @param {string} [filename] - Optional filename hint passed to parseModule.
 * @returns {{ moduleType: string, confidence: string, regions: Array }}
 */
export function scanEepromLayout(bytes, filename) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const info = parseModule(data, filename || '');
  const type = info.type || 'UNKNOWN';
  let regions = [];

  if (type === 'GPEC2A') {
    regions = regionsGpec2a(info, data);
  } else if (type === 'RFHUB') {
    const isGen1 = data.length === 2048;
    regions = isGen1 ? regionsRfhubGen1(info, data) : regionsRfhubGen2(info, data);
  } else if (type === 'BCM') {
    regions = regionsBcm(info, data);
  } else if (type === '95640') {
    regions = regions95640(info, data);
  } else if (type === 'XC2268_RFHUB') {
    regions = regionsXc2268(info, data);
  } else if (type === 'ZF_8HP_TCU') {
    regions = regionsZf8hp(info, data);
  } else {
    regions = regionsUnknown(data);
  }

  regions.sort((a, b) => a.offset - b.offset);

  return {
    moduleType: type,
    confidence: confidenceFor(type, info),
    regions,
  };
}
