/* ============================================================================
 * autelExport.js — Assemble and download key data extracted from an RFHUB
 * dump in a format suitable for manual entry into an Autel IM608 / IM508
 * transponder programmer (or any tool that accepts raw chip data).
 *
 * The Autel IM608 does not expose a documented binary import format for
 * PCF7953/HITAG-Pro chips, so we produce two artefacts:
 *
 *   1. A human-readable JSON manifest with every field labelled.
 *      Copy-paste any value straight into the Autel's hex keyboard.
 *
 *   2. A compact raw .bin:
 *        offset  0  : magic  41 55 54 4C  ("AUTL")
 *        offset  4  : version 01
 *        offset  5  : chip ordinal (01=PCF7953, 02=PCF7945, FF=unknown)
 *        offset  6  : UID length in bytes
 *        offset  7  : payload length in bytes
 *        offset  8  : UID bytes  (4 B for PCF7953/7945)
 *        offset 12  : payload bytes (4 B for PCF7953/7945)
 *        offset 16  : SEC16 master secret (16 B)
 *        total  32 B
 *      The Autel will not directly import this — it is a portable
 *      intermediate you can convert with any hex editor or script.
 *
 * ============================================================================ */

const CHIP_ORDINALS = {
  pcf7953: 0x01,
  pcf7945: 0x02,
};

function toHexStr(u8) {
  return [...u8].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function toHexStrCompact(u8) {
  return [...u8].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

/**
 * Extract and validate the key data we are about to export.
 *
 * @param {object}     slot       – slot object from parseKeySlots()
 * @param {Uint8Array} secret16   – 16-byte SEC16 master secret
 * @param {string}     chipId     – chip family id (e.g. 'pcf7953')
 * @param {import('../keyWriter/chipFamilies.js').ChipFamily|null} chipDef
 * @param {string}     gen        – 'gen1' | 'gen2'
 * @returns {{ ok: boolean, error?: string, uid: Uint8Array, payload: Uint8Array, sec16: Uint8Array }}
 */
export function buildAutelExportData({ slot, secret16, chipId, chipDef, gen }) {
  if (!slot || !slot.occupied || !slot.idMapped || !slot.idBytes) {
    return { ok: false, error: 'No occupied/mapped slot selected' };
  }
  if (!secret16 || secret16.length !== 16) {
    return { ok: false, error: 'SEC16 missing or wrong length' };
  }
  const allFF = [...secret16].every((b) => b === 0xFF);
  const all00 = [...secret16].every((b) => b === 0x00);
  if (allFF || all00) {
    return { ok: false, error: 'SEC16 is blank (all 0xFF / 0x00) — refusing export' };
  }
  if (!chipDef) {
    return { ok: false, error: `Unknown chip family: ${chipId}` };
  }
  const expectedLen = chipDef.uidBytes + chipDef.payloadBytes;
  if (slot.idBytes.length !== expectedLen) {
    return {
      ok: false,
      error: `ID block length ${slot.idBytes.length} B does not match chip layout (expected ${expectedLen} B for ${chipId})`,
    };
  }

  const uid     = slot.idBytes.slice(0, chipDef.uidBytes);
  const payload = slot.idBytes.slice(chipDef.uidBytes);

  return { ok: true, uid, payload, sec16: secret16 };
}

/**
 * Build the JSON manifest string.
 */
export function buildJsonManifest({ uid, payload, sec16, chipId, chipDef, gen, slotIdx, fileName }) {
  const manifest = {
    _note: 'Extracted from RFHUB dump by SRT Lab. Use these values in your Autel IM608 transponder programmer.',
    source_file: fileName || 'unknown',
    rfhub_gen: gen,
    slot_index: slotIdx + 1,
    chip_family: chipId,
    chip_label: chipDef?.label || chipId,
    transponder_uid_hex: toHexStr(uid),
    transponder_uid_hex_compact: toHexStrCompact(uid),
    payload_hex: toHexStr(payload),
    payload_hex_compact: toHexStrCompact(payload),
    id_block_hex: toHexStr(new Uint8Array([...uid, ...payload])),
    sec16_master_secret_hex: toHexStr(sec16),
    sec16_master_secret_hex_compact: toHexStrCompact(sec16),
    autel_workflow: [
      'In Autel IM608 MaxiIM: IMMO → FCA/Chrysler → [your model year] → Program Key → Expert Mode',
      'When prompted for the transponder UID, enter: ' + toHexStrCompact(uid),
      'When prompted for the crypto payload / data pages, enter: ' + toHexStrCompact(payload),
      'When prompted for the master secret / encryption key, enter: ' + toHexStrCompact(sec16),
      'After chip programming, pair the new key via OBD using the existing RFHUB RoutineControl 0x0401 flow.',
    ],
  };
  return JSON.stringify(manifest, null, 2);
}

/**
 * Build the compact 32-byte raw binary.
 */
export function buildRawBin({ uid, payload, sec16, chipId }) {
  const magic    = [0x41, 0x55, 0x54, 0x4C]; // "AUTL"
  const version  = [0x01];
  const ordinal  = [CHIP_ORDINALS[chipId] ?? 0xFF];
  const uidLen   = [uid.length];
  const payLen   = [payload.length];

  const total = magic.length + version.length + ordinal.length +
    uidLen.length + payLen.length + uid.length + payload.length + sec16.length;
  const out = new Uint8Array(total);
  let i = 0;
  for (const b of [...magic, ...version, ...ordinal, ...uidLen, ...payLen]) out[i++] = b;
  for (const b of uid)     out[i++] = b;
  for (const b of payload) out[i++] = b;
  for (const b of sec16)   out[i++] = b;
  return out;
}

/**
 * Trigger a browser download of a Blob.
 */
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

/**
 * Build a safe base filename from RFHUB file name + slot index.
 */
export function exportBaseName(rfhFileName, slotIdx) {
  const stem = (rfhFileName || 'rfhub')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${stem}_slot${slotIdx + 1}_autel`;
}
