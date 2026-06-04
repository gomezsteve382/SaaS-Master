/**
 * UDS DID catalog — ISO 14229 standard 0xF1xx identification block plus
 * common OBD-II PIDs and the FCA / Stellantis scoped DID space mined from
 * the srt-lab VILLAIN extraction (24-bit 0x6Exxxxx range, 32-bit SCI-B
 * flags, module-specific BCM/RFHUB/ECM families).
 *
 * Each entry carries:
 *
 *   did      — DID number. Standard UDS DIDs are 16-bit; FCA scoped reads
 *              use 24-bit (0x6E2025, 0x6E9EB0, …) and SCI-B addressed
 *              flags use 32-bit (0xF79EB045). Wide DIDs cannot be issued
 *              via a standard 0x22 two-byte read frame — the catalog
 *              indexes them for label/decoding purposes only.
 *   name     — human-readable name (ISO 14229 / SAE J1979 naming where
 *              applicable; FCA names from VILLAIN otherwise)
 *   length   — byte length hint (null = variable)
 *   encoding — how to decode the raw bytes ('ascii', 'bcd', 'hex', 'uint')
 *   decode   — decode function: (bytes) => human-readable string
 */

export type DidEncoding = 'ascii' | 'bcd' | 'hex' | 'uint' | 'raw';

export interface DidEntry {
  /**
   * DID number. 16-bit for standard UDS DIDs; up to 32-bit for FCA scoped
   * reads (0x6Exxxxx) and SCI-B flag DIDs (0xF79EB045).
   */
  readonly did: number;
  readonly name: string;
  /** Expected byte length, or null when variable. */
  readonly length: number | null;
  readonly encoding: DidEncoding;
  /** Decode raw bytes to a human-readable string. */
  decode(data: Uint8Array | number[]): string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function asBytes(d: Uint8Array | number[]): Uint8Array {
  return d instanceof Uint8Array ? d : new Uint8Array(d);
}

function decodeAscii(d: Uint8Array | number[]): string {
  return Array.from(asBytes(d))
    .filter(b => b >= 0x20 && b <= 0x7E)
    .map(b => String.fromCharCode(b))
    .join('');
}

function decodeHex(d: Uint8Array | number[]): string {
  return Array.from(asBytes(d))
    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

function decodeBcd(d: Uint8Array | number[]): string {
  return Array.from(asBytes(d))
    .map(b => `${(b >> 4) & 0xF}${b & 0xF}`)
    .join('');
}

function decodeUint(d: Uint8Array | number[]): string {
  const bytes = asBytes(d);
  let v = 0;
  for (const b of bytes) v = (v * 256 + b) >>> 0;
  return String(v);
}

/**
 * SKIM/IMMO state byte: 0x80 → Enabled, 0x00 → Disabled, anything else
 * falls back to hex so callers see the unexpected value verbatim.
 */
function decodeSkimState(d: Uint8Array | number[]): string {
  const bytes = asBytes(d);
  if (bytes.length === 0) return '(no data)';
  const b = bytes[0];
  if (b === 0x80) return 'Enabled (0x80)';
  if (b === 0x00) return 'Disabled (0x00)';
  return decodeHex(bytes);
}

/**
 * Single-byte enable/disable flag: 0x01 → Enabled, 0x00 → Disabled.
 * Used by RFHUB 0xAB01 Remote Start. Falls back to hex on unknown values.
 */
function decodeEnableDisable(d: Uint8Array | number[]): string {
  const bytes = asBytes(d);
  if (bytes.length === 0) return '(no data)';
  const b = bytes[0];
  if (b === 0x01) return 'Enabled (0x01)';
  if (b === 0x00) return 'Disabled (0x00)';
  return decodeHex(bytes);
}

/**
 * SKIM key-learning status byte. The VILLAIN report enumerates 4 states;
 * unknown values fall through to hex.
 */
function decodeKeyLearningStatus(d: Uint8Array | number[]): string {
  const bytes = asBytes(d);
  if (bytes.length === 0) return '(no data)';
  const b = bytes[0];
  switch (b) {
    case 0x00: return 'Idle (0x00)';
    case 0x01: return 'Learning In Progress (0x01)';
    case 0x02: return 'Learning Complete (0x02)';
    case 0xFF: return 'Learning Failed (0xFF)';
    default:   return decodeHex(bytes);
  }
}

function makeAscii(did: number, name: string, length: number | null): DidEntry {
  return { did, name, length, encoding: 'ascii', decode: decodeAscii };
}
function makeHex(did: number, name: string, length: number | null): DidEntry {
  return { did, name, length, encoding: 'hex', decode: decodeHex };
}
function makeUint(did: number, name: string, length: number | null): DidEntry {
  return { did, name, length, encoding: 'uint', decode: decodeUint };
}
// `makeBcd` retained for future BCD-encoded DIDs (e.g. programming dates).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function makeBcd(did: number, name: string, length: number | null): DidEntry {
  return { did, name, length, encoding: 'bcd', decode: decodeBcd };
}

// ── Standard Identification Block (0xF180–0xF1FF) ────────────────────

export const DID_CATALOG: readonly DidEntry[] = [
  // ── Boot software ────────────────────────────────────────────────────
  makeAscii(0xF180, 'Boot Software Block Version Number',          null),
  makeAscii(0xF181, 'Application Software Block Version Number',   null),
  makeAscii(0xF182, 'Application Data Block Version Number',       null),
  makeAscii(0xF183, 'Boot Software ID',                            null),
  makeAscii(0xF184, 'Application Software ID',                     null),
  makeAscii(0xF185, 'Application Data ID',                         null),
  makeAscii(0xF186, 'Active Diagnostic Session',                   1),
  makeHex  (0xF187, 'Vehicle Manufacturer Spare Part Number',       null),
  makeAscii(0xF188, 'Vehicle Manufacturer ECU SW Version Number',  null),
  makeAscii(0xF189, 'Vehicle Manufacturer ECU HW Version Number',  null),
  makeHex  (0xF18C, 'ECU Serial Number',                            null),

  // ── VIN and identification ────────────────────────────────────────────
  makeAscii(0xF190, 'VIN (Vehicle Identification Number)',         17),
  makeHex  (0xF191, 'Vehicle Manufacturer ECU Hardware Number',    null),
  makeAscii(0xF192, 'System Supplier ECU Hardware Number',         null),
  makeAscii(0xF193, 'System Supplier ECU Hardware Version Number', null),
  makeAscii(0xF194, 'System Supplier ECU SW Number',               null),
  makeAscii(0xF195, 'System Supplier ECU SW Version Number',       null),
  makeAscii(0xF196, 'Exhaust Regulation or Type Approval Number',  null),
  makeAscii(0xF197, 'System Name or Engine Type',                  null),
  makeAscii(0xF198, 'Repair Shop Code or Tester Serial Number',   null),
  makeHex  (0xF199, 'Programming Date (YYYYMMDD)',                  4),
  makeHex  (0xF19A, 'ECU Installation Date',                       4),
  makeAscii(0xF19B, 'ODX File',                                    null),
  makeAscii(0xF19C, 'Entity (FCA: module description string)',     null),
  makeAscii(0xF19D, 'ODX Description',                             null),
  makeHex  (0xF19E, 'Entity ID (FCA scoped)',                      null),

  // ── Calibration ───────────────────────────────────────────────────────
  {
    did: 0xF19F,
    name: 'Number of Valid Calibration Files',
    length: 1,
    encoding: 'uint',
    decode: decodeUint,
  },
  makeAscii(0xF1A0, 'Calibration ID',                              16),
  makeHex  (0xF1A1, 'Calibration Verification Results',           null),
  makeAscii(0xF1A2, 'ECU Calibration Date',                       null),
  makeAscii(0xF1A3, 'Vehicle Manufacturer Spare Part Number Alt',  null),
  makeAscii(0xF1A4, 'Vehicle Manufacturer Application SW Fingerprint', null),
  makeAscii(0xF1A5, 'ECU SW Fingerprint',                         null),
  makeHex  (0xF1A6, 'Active Security Level',                       1),
  makeAscii(0xF1A7, 'Network Configuration Data For Communication', null),
  makeHex  (0xF1A8, 'Vehicle Manufacturer Data Container',         null),
  makeHex  (0xF1A9, 'Country Code',                                1),
  makeAscii(0xF1AA, 'Vehicle Manufacturer Coding Data Container', null),

  // ── FCA / Stellantis specific (commonly used) ─────────────────────────
  makeHex  (0xF1B0, 'FCA Part Number',                             null),
  makeAscii(0xF1B3, 'FCA Flash Part Number',                       null),
  makeHex  (0xF1B6, 'FCA Calibration Version',                     null),
  makeHex  (0xF1BA, 'FCA Supplier Code',                           4),
  makeHex  (0xF1BD, 'FCA ECU Type Code',                           null),
  makeHex  (0xF1C0, 'FCA Assembly Part Number',                    null),
  makeUint (0xF1C1, 'Engine Hours',                                null),

  // ── ECM/PCM odometer/runtime ─────────────────────────────────────────
  makeUint (0xF40D, 'Odometer (raw)',                              null),

  // ── BCM / Key fob / SKIM module data ─────────────────────────────────
  makeHex  (0xF1D0, 'Key Fob Data',                                null),
  makeHex  (0xF1D1, 'SKIM Data',                                   null),

  // ── System supplier block (RFHUB tire sensors, secret keys) ──────────
  makeAscii(0xF1E0, 'System Supplier Identifier (RFHUB: Tire Sensors)', null),
  makeHex  (0xF1E1, 'System Supplier Specific Identifier 1 (RFHUB: Secret Key)', null),
  makeAscii(0xF1E2, 'System Supplier Specific Identifier 2',       null),

  // ── Common diagnostic DIDs ────────────────────────────────────────────
  makeHex  (0x0100, 'OBD Supported PIDs 0x01–0x20',                4),
  makeHex  (0x0120, 'OBD Supported PIDs 0x21–0x40',                4),
  makeUint (0x012F, 'Fuel Tank Level Input (%)',                    1),
  makeHex  (0x0142, 'Control Module Voltage (raw)',                 2),
  makeHex  (0x0146, 'Ambient Air Temperature',                      2),
  makeUint (0x014D, 'Time Since DTC Cleared',                       4),

  // ── ECM 0xFDxx family (control / fault status) ───────────────────────
  makeHex  (0xFD01, 'Control Status Data',                         null),
  makeHex  (0xFD31, 'Pending Fault Memory',                        null),
  makeHex  (0xFDFD, 'Fast Vehicle Info',                           null),
  makeHex  (0xF400, 'Fault Memory Status',                         null),

  // ── BCM configuration block 0xDE00–0xDE0C ────────────────────────────
  // FCA BCM exposes a contiguous configuration window via the 0xDExx
  // 16-bit range; values are vendor-encoded byte arrays. ADCM reuses
  // 0xDE10 (Vehicle Config) and 0xDE11 (Variant Code) — kept here so
  // the catalog covers the full module-specific family.
  makeHex  (0xDE00, 'BCM Configuration Block 00',                  null),
  // 0xDE01–0xDE03 carry SKIM-specific semantics in the VILLAIN report
  // (Immobilizer Status / Key Count / Key Learning Status) while still
  // sitting inside the BCM 0xDExx configuration window. Labels prefix
  // with "BCM Configuration Block" so the family invariant tests keep
  // passing.
  {
    did: 0xDE01,
    name: 'BCM Configuration Block 01 (SKIM Immobilizer Status)',
    length: 1,
    encoding: 'hex',
    decode: decodeSkimState,
  },
  {
    did: 0xDE02,
    name: 'BCM Configuration Block 02 (SKIM Key Count)',
    length: 1,
    encoding: 'uint',
    decode: decodeUint,
  },
  {
    did: 0xDE03,
    name: 'BCM Configuration Block 03 (SKIM Key Learning Status)',
    length: 1,
    encoding: 'hex',
    decode: decodeKeyLearningStatus,
  },
  makeHex  (0xDE04, 'BCM Configuration Block 04',                  null),
  makeHex  (0xDE05, 'BCM Configuration Block 05',                  null),
  makeHex  (0xDE06, 'BCM Configuration Block 06',                  null),
  makeHex  (0xDE07, 'BCM Configuration Block 07',                  null),
  makeHex  (0xDE08, 'BCM Configuration Block 08',                  null),
  makeHex  (0xDE09, 'BCM Configuration Block 09',                  null),
  makeHex  (0xDE0A, 'BCM Configuration Block 0A',                  null),
  makeHex  (0xDE0B, 'BCM Configuration Block 0B',                  null),
  makeHex  (0xDE0C, 'BCM Configuration Block 0C',                  null),
  makeHex  (0xDE10, 'Vehicle Config',                              null),
  makeHex  (0xDE11, 'Variant Code',                                null),

  // ── RFHUB proprietary 0xABxx (VILLAIN report) ────────────────────────
  {
    did: 0xAB01,
    name: 'Remote Start Enable/Disable (RFHUB)',
    length: 1,
    encoding: 'hex',
    decode: decodeEnableDisable,
  },
  makeHex  (0xAB02, 'Key Fob Configuration Data (RFHUB)',          null),

  // ── PCM proprietary 0xCDxx (VILLAIN report) ──────────────────────────
  makeHex  (0xCD01, 'Injector Flow Rates (PCM)',                   null),
  makeHex  (0xCD02, 'Transmission Adaptives (PCM)',                null),

  // ── VILLAIN VIN block (16-bit Chrysler ECU CAN 11-bit) ───────────────
  makeAscii(0x7B88, 'Original VIN',                                17),
  makeAscii(0x7B90, 'Current VIN',                                 17),

  // ── FCA scoped 24-bit DIDs (0x6Exxxxx) ───────────────────────────────
  // These cannot be issued via a standard 0x22 hi/lo read; they are
  // wired up by VILLAIN-style multi-byte addressing. Catalog them so
  // every consumer (UdsTab, BackupsTab) sees the correct label.
  makeAscii(0x6E2025, 'Bus-Transmitted VIN',                       17),
  makeAscii(0x6E2027, 'WCM Configured VIN',                        17),
  {
    did: 0x6E9EB0,
    name: 'SKIM State',
    length: 1,
    encoding: 'hex',
    decode: decodeSkimState,
  },
  makeAscii(0x6EF190, 'EPS VIN',                                   17),

  // ── 32-bit SCI-B addressed flag ──────────────────────────────────────
  {
    did: 0xF79EB045,
    name: 'SKIM State Flag (SCI-B)',
    length: 1,
    encoding: 'hex',
    decode: decodeSkimState,
  },
];

/** Look up a DID entry by number. Returns undefined if not in the catalog. */
export function didEntry(did: number): DidEntry | undefined {
  return DID_CATALOG.find(e => e.did === did);
}

/**
 * Decode raw bytes for a known DID. Falls back to hex when the DID is
 * not in the catalog or when the data is empty.
 */
export function decodeDid(did: number, data: Uint8Array | number[]): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.length) return '(no data)';
  const entry = didEntry(did);
  if (!entry) return decodeHex(bytes);
  return entry.decode(bytes);
}
