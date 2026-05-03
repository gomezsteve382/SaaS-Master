/**
 * Standard UDS DID catalog — 0xF1xx identification block plus common
 * manufacturer-agnostic DIDs. Each entry carries:
 *
 *   did     — 16-bit identifier number
 *   name    — human-readable name (ISO 14229 or SAE J1979 naming)
 *   length  — byte length hint (null = variable)
 *   encoding — how to decode the raw bytes ('ascii', 'bcd', 'hex', 'uint')
 *   decode  — decode function: (bytes) => human-readable string
 */

export type DidEncoding = 'ascii' | 'bcd' | 'hex' | 'uint' | 'raw';

export interface DidEntry {
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

function makeAscii(did: number, name: string, length: number | null): DidEntry {
  return { did, name, length, encoding: 'ascii', decode: decodeAscii };
}
function makeHex(did: number, name: string, length: number | null): DidEntry {
  return { did, name, length, encoding: 'hex', decode: decodeHex };
}
function makeUint(did: number, name: string, length: number | null): DidEntry {
  return { did, name, length, encoding: 'uint', decode: decodeUint };
}
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

  // ── System supplier block ─────────────────────────────────────────────
  makeAscii(0xF1E0, 'System Supplier Identifier',                  null),
  makeAscii(0xF1E1, 'System Supplier Specific Identifier 1',       null),
  makeAscii(0xF1E2, 'System Supplier Specific Identifier 2',       null),

  // ── Common diagnostic DIDs ────────────────────────────────────────────
  makeHex  (0x0100, 'OBD Supported PIDs 0x01–0x20',                4),
  makeHex  (0x0120, 'OBD Supported PIDs 0x21–0x40',                4),
  makeUint (0x012F, 'Fuel Tank Level Input (%)',                    1),
  makeHex  (0x0142, 'Control Module Voltage (raw)',                 2),
  makeHex  (0x0146, 'Ambient Air Temperature',                      2),
  makeUint (0x014D, 'Time Since DTC Cleared',                       4),
  makeHex  (0xF400, 'Fault Memory Status',                         null),
  makeHex  (0xFD01, 'Control Status Data',                         null),
  makeHex  (0xFD31, 'Pending Fault Memory',                        null),
  makeHex  (0xFDFD, 'Fast Vehicle Info',                           null),
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
