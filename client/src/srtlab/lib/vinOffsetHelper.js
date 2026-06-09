/**
 * vinOffsetHelper.js — VIN offset database utilities.
 *
 * Wraps VIN_OFFSET_MODULES from vinOffsetDatabase.generated.js to provide:
 *   1. Multi-supplier BCM detection (Chrysler / Continental / Marelli)
 *   2. Per-module VIN slot lookup (primary + backup offsets)
 *   3. CRC-16-CCITT post-write verifier
 *   4. Backup VIN slot validator (checks 0x200 backup matches primary)
 *
 * All functions are pure — no side effects, no async.
 */

import { VIN_OFFSET_MODULES } from './vinOffsetDatabase.generated.js';

// ─── CRC-16-CCITT (poly 0x1021, init 0xFFFF) ────────────────────────────────
/**
 * Compute CRC-16-CCITT over a byte range.
 * @param {Uint8Array|number[]} buf
 * @param {number} start  inclusive byte index
 * @param {number} end    exclusive byte index
 * @returns {number} 16-bit CRC
 */
export function crc16ccitt(buf, start, end) {
  let crc = 0xFFFF;
  for (let i = start; i < end; i++) {
    crc ^= (buf[i] & 0xFF) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xFFFF;
    }
  }
  return crc;
}

// ─── Supplier detection ──────────────────────────────────────────────────────
/**
 * Map a BCM part number prefix to a supplier key.
 * Returns 'chrysler' | 'continental' | 'marelli' | null
 *
 * Known BCM supplier prefixes (from vinOffsetDatabase + vehicles.js):
 *   68396xxx / 68277xxx / 68525xxx / 68354xxx / 68463xxx / 68309xxx → Chrysler/Mopar
 *   68207xxx / 68208xxx / 68209xxx / 68210xxx                       → Continental
 *   68350xxx / 68351xxx / 68352xxx                                  → Marelli
 */
const SUPPLIER_MAP = [
  { re: /^68(396|277|525|354|463|309|312|313|314|315|316|317|318|319|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|361|362|363|364|365|366|367|368|369|370|371|372|373|374|375|376|377|378|379|380|381|382|383|384|385|386|387|388|389|390|391|392|393|394|395|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|420|421|422|423|424|425|426|427|428|429|430|431|432|433|434|435|436|437|438|439|440|441|442|443|444|445|446|447|448|449|450|451|452|453|454|455|456|457|458|459|460|461|462|464|465|466|467|468|469|470|471|472|473|474|475|476|477|478|479|480|481|482|483|484|485|486|487|488|489|490|491|492|493|494|495|496|497|498|499|500)/, supplier: 'chrysler', name: 'Chrysler/Mopar' },
  { re: /^68(207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255|256|257|258|259|260|261|262|263|264|265|266|267|268|269|270|271|272|273|274|275|276|278|279|280|281|282|283|284|285|286|287|288|289|290|291|292|293|294|295|296|297|298|299|300|301|302|303|304|305|306|307|308)/, supplier: 'continental', name: 'Continental Automotive' },
  { re: /^68(350|351|352|353|355|356|357|358|359|360)/, supplier: 'marelli', name: 'Magneti Marelli' },
];

/**
 * Detect BCM supplier from part number string (e.g. "68396561").
 * @param {string} partNumber
 * @returns {{ supplier: string, name: string, moduleKey: string } | null}
 */
export function detectBcmSupplier(partNumber) {
  if (!partNumber || typeof partNumber !== 'string') return null;
  const pn = partNumber.replace(/\D/g, '');
  for (const entry of SUPPLIER_MAP) {
    if (entry.re.test(pn)) {
      const moduleKey = entry.supplier === 'chrysler'    ? 'BCM_CHRYSLER'
                      : entry.supplier === 'continental' ? 'BCM_CONTINENTAL'
                      : 'BCM_MARELLI';
      return { supplier: entry.supplier, name: entry.name, moduleKey };
    }
  }
  // Default to Chrysler for unrecognized FCA part numbers starting with 68
  if (/^68/.test(pn)) return { supplier: 'chrysler', name: 'Chrysler/Mopar', moduleKey: 'BCM_CHRYSLER' };
  return null;
}

// ─── VIN slot lookup ─────────────────────────────────────────────────────────
/**
 * Get all VIN slot definitions for a module key.
 * @param {string} moduleKey  e.g. 'BCM_CHRYSLER', 'ECM_GPEC2A', 'RFHUB'
 * @returns {Array<{ offset: number, length: number, type: string, format: string }>}
 */
export function getVinSlots(moduleKey) {
  const entry = VIN_OFFSET_MODULES[moduleKey];
  if (!entry || !entry.vin_locations) return [];
  return entry.vin_locations.map(loc => ({
    offset: typeof loc.offset === 'string' ? parseInt(loc.offset, 16) : loc.offset,
    length: loc.length || 17,
    type: loc.type || 'primary',
    format: loc.format || 'ASCII',
  }));
}

/**
 * Get the primary VIN slot for a module key.
 * @param {string} moduleKey
 * @returns {{ offset: number, length: number, type: string, format: string } | null}
 */
export function getPrimaryVinSlot(moduleKey) {
  const slots = getVinSlots(moduleKey);
  return slots.find(s => s.type === 'primary') || slots[0] || null;
}

/**
 * Get the backup VIN slot for a module key (if any).
 * @param {string} moduleKey
 * @returns {{ offset: number, length: number, type: string, format: string } | null}
 */
export function getBackupVinSlot(moduleKey) {
  const slots = getVinSlots(moduleKey);
  return slots.find(s => s.type === 'backup') || null;
}

// ─── VIN read from buffer ────────────────────────────────────────────────────
/**
 * Read a VIN from a binary buffer at a given offset.
 * @param {Uint8Array|number[]} buf
 * @param {number} offset
 * @param {number} [length=17]
 * @returns {string|null}  17-char VIN or null if invalid
 */
export function readVinAt(buf, offset, length = 17) {
  if (!buf || offset + length > buf.length) return null;
  let vin = '';
  for (let i = 0; i < length; i++) {
    const b = buf[offset + i];
    if (b === 0x00 || b === 0xFF) return null; // blank/erased
    vin += String.fromCharCode(b);
  }
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return null;
  return vin;
}

// ─── Backup VIN slot validator ───────────────────────────────────────────────
/**
 * Validate that the backup VIN slot matches the primary VIN slot.
 * @param {Uint8Array|number[]} buf  Full module dump
 * @param {string} moduleKey
 * @returns {{
 *   primaryVin: string|null,
 *   backupVin: string|null,
 *   match: boolean,
 *   hasBackupSlot: boolean,
 *   primaryOffset: number|null,
 *   backupOffset: number|null,
 * }}
 */
export function validateBackupVinSlot(buf, moduleKey) {
  const primary = getPrimaryVinSlot(moduleKey);
  const backup  = getBackupVinSlot(moduleKey);

  const primaryVin = primary ? readVinAt(buf, primary.offset) : null;
  const backupVin  = backup  ? readVinAt(buf, backup.offset)  : null;

  return {
    primaryVin,
    backupVin,
    match: !backup ? true : primaryVin === backupVin,
    hasBackupSlot: !!backup,
    primaryOffset: primary?.offset ?? null,
    backupOffset:  backup?.offset  ?? null,
  };
}

// ─── CRC verifier ────────────────────────────────────────────────────────────
/**
 * Get checksum definition for a module key.
 * @param {string} moduleKey
 * @returns {{ algorithm: string, polynomial: string, init: string, locations: Array } | null}
 */
export function getChecksumDef(moduleKey) {
  const entry = VIN_OFFSET_MODULES[moduleKey];
  return entry?.checksum || null;
}

/**
 * Verify all CRC checksum locations in a buffer for a given module.
 * @param {Uint8Array|number[]} buf
 * @param {string} moduleKey
 * @returns {Array<{
 *   offset: number,
 *   stored: number,
 *   computed: number,
 *   ok: boolean,
 *   covers: string,
 * }>}
 */
export function verifyChecksums(buf, moduleKey) {
  const cs = getChecksumDef(moduleKey);
  if (!cs || !cs.locations) return [];

  const results = [];
  for (const loc of cs.locations) {
    const csOffset = typeof loc.offset === 'string' ? parseInt(loc.offset, 16) : loc.offset;
    const csLen    = loc.length || 2;

    // Parse covers range e.g. "0x100-0x110"
    let coverStart = 0, coverEnd = 0;
    if (loc.covers) {
      const parts = loc.covers.split('-');
      coverStart = parseInt(parts[0], 16);
      coverEnd   = parseInt(parts[1], 16);
    }

    // Read stored CRC (little-endian 2 bytes)
    let stored = 0;
    if (csOffset + csLen <= buf.length) {
      stored = (buf[csOffset] & 0xFF) | ((buf[csOffset + 1] & 0xFF) << 8);
    }

    // Compute expected CRC
    const computed = crc16ccitt(buf, coverStart, coverEnd);

    results.push({
      offset: csOffset,
      stored,
      computed,
      ok: stored === computed,
      covers: loc.covers || `0x${coverStart.toString(16)}-0x${coverEnd.toString(16)}`,
    });
  }
  return results;
}

/**
 * Full post-write validation: read back VIN from primary + backup slots,
 * verify all CRC checksums. Returns a structured report.
 *
 * @param {Uint8Array|number[]} buf  The patched module dump
 * @param {string} moduleKey
 * @param {string} expectedVin  The VIN that was written
 * @returns {{
 *   moduleKey: string,
 *   supplier: string|null,
 *   primaryVin: string|null,
 *   backupVin: string|null,
 *   vinMatch: boolean,
 *   backupMatch: boolean,
 *   checksums: Array,
 *   allOk: boolean,
 *   issues: string[],
 * }}
 */
export function postWriteValidation(buf, moduleKey, expectedVin) {
  const entry = VIN_OFFSET_MODULES[moduleKey];
  const supplier = entry?.supplier || null;

  const vinResult = validateBackupVinSlot(buf, moduleKey);
  const checksums = verifyChecksums(buf, moduleKey);

  const issues = [];
  if (vinResult.primaryVin !== expectedVin) {
    issues.push(`Primary VIN mismatch: expected ${expectedVin}, found ${vinResult.primaryVin || 'BLANK'}`);
  }
  if (vinResult.hasBackupSlot && !vinResult.match) {
    issues.push(`Backup VIN slot (0x${vinResult.backupOffset?.toString(16)}) mismatch: ${vinResult.backupVin || 'BLANK'} ≠ ${vinResult.primaryVin}`);
  }
  for (const cs of checksums) {
    if (!cs.ok) {
      issues.push(`CRC mismatch at 0x${cs.offset.toString(16)}: stored 0x${cs.stored.toString(16).padStart(4,'0')} ≠ computed 0x${cs.computed.toString(16).padStart(4,'0')} (covers ${cs.covers})`);
    }
  }

  return {
    moduleKey,
    supplier,
    primaryVin: vinResult.primaryVin,
    backupVin: vinResult.backupVin,
    vinMatch: vinResult.primaryVin === expectedVin,
    backupMatch: !vinResult.hasBackupSlot || vinResult.match,
    checksums,
    allOk: issues.length === 0,
    issues,
  };
}

/**
 * Convenience: given a BCM part number, detect supplier and return the
 * correct moduleKey to use for vinOffsetDatabase lookups.
 * Falls back to 'BCM_CHRYSLER' if unknown.
 *
 * @param {string} partNumber
 * @returns {string} moduleKey
 */
export function bcmModuleKeyForPartNumber(partNumber) {
  const s = detectBcmSupplier(partNumber);
  return s?.moduleKey || 'BCM_CHRYSLER';
}

/**
 * Get a human-readable summary of a module's VIN storage layout.
 * Useful for tooltips and diagnostic panels.
 *
 * @param {string} moduleKey
 * @returns {string}
 */
export function getVinLayoutSummary(moduleKey) {
  const entry = VIN_OFFSET_MODULES[moduleKey];
  if (!entry) return `No offset data for ${moduleKey}`;

  const slots = getVinSlots(moduleKey);
  const cs = getChecksumDef(moduleKey);

  const slotDesc = slots.map(s =>
    `${s.type} @ 0x${s.offset.toString(16).toUpperCase()} (${s.format})`
  ).join(', ');

  const csDesc = cs
    ? `CRC-${cs.algorithm || '16-CCITT'} poly=${cs.polynomial} init=${cs.init}`
    : 'No checksum';

  return `${entry.name || moduleKey}: ${slotDesc} | ${csDesc}`;
}
