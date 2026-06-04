/**
 * ISO 14229-1 Negative Response Code (NRC) table.
 *
 * Covers every code defined in the standard from 0x10 through 0x93,
 * including all ISO-SAE reserved and extended-data-link-security reserved
 * ranges that occupy the code space but are not named services.
 *
 * isPending — true when the NRC signals a temporary condition: the
 * caller should retry the same request after a short delay (the spec
 * recommends honoring the P2-star/P2C extension timing when 0x78 is
 * received, and backing off ~100 ms for 0x21/0x37).
 */

export interface NRCEntry {
  readonly code: number;
  readonly shortName: string;
  readonly description: string;
  /** true = temporary/pending — retry is appropriate; false = hard error */
  readonly isPending: boolean;
}

export const NRC_TABLE: readonly NRCEntry[] = [
  // ── 0x10–0x14: Named service-level errors ───────────────────────────
  { code: 0x10, shortName: 'GR',     description: 'General reject — the ECU cannot process this request',                                              isPending: false },
  { code: 0x11, shortName: 'SNS',    description: 'Service not supported in the current session',                                                       isPending: false },
  { code: 0x12, shortName: 'SFNS',   description: 'Sub-function not supported',                                                                         isPending: false },
  { code: 0x13, shortName: 'IMLOIF', description: 'Incorrect message length or invalid format',                                                         isPending: false },
  { code: 0x14, shortName: 'RTL',    description: 'Response too long — ECU cannot fit response in available buffer',                                    isPending: false },

  // ── 0x15–0x20: ISOSAEReserved ────────────────────────────────────────
  { code: 0x15, shortName: 'ISOSAERESERVED15', description: 'ISO-SAE reserved (0x15)',                                                                  isPending: false },
  { code: 0x16, shortName: 'ISOSAERESERVED16', description: 'ISO-SAE reserved (0x16)',                                                                  isPending: false },
  { code: 0x17, shortName: 'ISOSAERESERVED17', description: 'ISO-SAE reserved (0x17)',                                                                  isPending: false },
  { code: 0x18, shortName: 'ISOSAERESERVED18', description: 'ISO-SAE reserved (0x18)',                                                                  isPending: false },
  { code: 0x19, shortName: 'ISOSAERESERVED19', description: 'ISO-SAE reserved (0x19)',                                                                  isPending: false },
  { code: 0x1A, shortName: 'ISOSAERESERVED1A', description: 'ISO-SAE reserved (0x1A)',                                                                  isPending: false },
  { code: 0x1B, shortName: 'ISOSAERESERVED1B', description: 'ISO-SAE reserved (0x1B)',                                                                  isPending: false },
  { code: 0x1C, shortName: 'ISOSAERESERVED1C', description: 'ISO-SAE reserved (0x1C)',                                                                  isPending: false },
  { code: 0x1D, shortName: 'ISOSAERESERVED1D', description: 'ISO-SAE reserved (0x1D)',                                                                  isPending: false },
  { code: 0x1E, shortName: 'ISOSAERESERVED1E', description: 'ISO-SAE reserved (0x1E)',                                                                  isPending: false },
  { code: 0x1F, shortName: 'ISOSAERESERVED1F', description: 'ISO-SAE reserved (0x1F)',                                                                  isPending: false },
  { code: 0x20, shortName: 'ISOSAERESERVED20', description: 'ISO-SAE reserved (0x20)',                                                                  isPending: false },

  // ── 0x21–0x22: Named ─────────────────────────────────────────────────
  { code: 0x21, shortName: 'BRR',    description: 'Busy repeat request — ECU is temporarily busy, retry shortly',                                       isPending: true  },
  { code: 0x22, shortName: 'CNC',    description: 'Conditions not correct — preconditions (session, lock state, etc.) not met',                         isPending: false },

  // ── 0x23: ISOSAEReserved ─────────────────────────────────────────────
  { code: 0x23, shortName: 'ISOSAERESERVED23', description: 'ISO-SAE reserved (0x23)',                                                                  isPending: false },

  // ── 0x24–0x26: Named ─────────────────────────────────────────────────
  { code: 0x24, shortName: 'RSE',    description: 'Request sequence error — service called out of order',                                               isPending: false },
  { code: 0x25, shortName: 'NRFSC',  description: 'No response from sub-net component',                                                                 isPending: false },
  { code: 0x26, shortName: 'FPEORA', description: 'Failure prevents execution of requested action',                                                     isPending: false },

  // ── 0x27–0x30: ISOSAEReserved ────────────────────────────────────────
  { code: 0x27, shortName: 'ISOSAERESERVED27', description: 'ISO-SAE reserved (0x27)',                                                                  isPending: false },
  { code: 0x28, shortName: 'ISOSAERESERVED28', description: 'ISO-SAE reserved (0x28)',                                                                  isPending: false },
  { code: 0x29, shortName: 'ISOSAERESERVED29', description: 'ISO-SAE reserved (0x29)',                                                                  isPending: false },
  { code: 0x2A, shortName: 'ISOSAERESERVED2A', description: 'ISO-SAE reserved (0x2A)',                                                                  isPending: false },
  { code: 0x2B, shortName: 'ISOSAERESERVED2B', description: 'ISO-SAE reserved (0x2B)',                                                                  isPending: false },
  { code: 0x2C, shortName: 'ISOSAERESERVED2C', description: 'ISO-SAE reserved (0x2C)',                                                                  isPending: false },
  { code: 0x2D, shortName: 'ISOSAERESERVED2D', description: 'ISO-SAE reserved (0x2D)',                                                                  isPending: false },
  { code: 0x2E, shortName: 'ISOSAERESERVED2E', description: 'ISO-SAE reserved (0x2E)',                                                                  isPending: false },
  { code: 0x2F, shortName: 'ISOSAERESERVED2F', description: 'ISO-SAE reserved (0x2F)',                                                                  isPending: false },
  { code: 0x30, shortName: 'ISOSAERESERVED30', description: 'ISO-SAE reserved (0x30)',                                                                  isPending: false },

  // ── 0x31: Named ──────────────────────────────────────────────────────
  { code: 0x31, shortName: 'ROOR',   description: 'Request out of range — DID or parameter value not supported',                                        isPending: false },

  // ── 0x32: ISOSAEReserved ─────────────────────────────────────────────
  { code: 0x32, shortName: 'ISOSAERESERVED32', description: 'ISO-SAE reserved (0x32)',                                                                  isPending: false },

  // ── 0x33–0x37: Named ─────────────────────────────────────────────────
  { code: 0x33, shortName: 'SAD',    description: 'Security access denied — security level not unlocked',                                               isPending: false },
  { code: 0x34, shortName: 'AR',     description: 'Authentication required (UDS 0x29) — module requires certificate-based auth',                       isPending: false },
  { code: 0x35, shortName: 'IK',     description: 'Invalid key — seed/key challenge failed',                                                            isPending: false },
  { code: 0x36, shortName: 'ENOA',   description: 'Exceeded number of attempts — security lockout active',                                              isPending: false },
  { code: 0x37, shortName: 'RTDNE',  description: 'Required time delay not expired — must wait before retry',                                           isPending: true  },

  // ── 0x38–0x4F: ReservedByExtendedDataLinkSecurityDocument ────────────
  { code: 0x38, shortName: 'RBEDNE38', description: 'Reserved by extended data link security document (0x38)',                                          isPending: false },
  { code: 0x39, shortName: 'RBEDNE39', description: 'Reserved by extended data link security document (0x39)',                                          isPending: false },
  { code: 0x3A, shortName: 'RBEDNE3A', description: 'Reserved by extended data link security document (0x3A)',                                          isPending: false },
  { code: 0x3B, shortName: 'RBEDNE3B', description: 'Reserved by extended data link security document (0x3B)',                                          isPending: false },
  { code: 0x3C, shortName: 'RBEDNE3C', description: 'Reserved by extended data link security document (0x3C)',                                          isPending: false },
  { code: 0x3D, shortName: 'RBEDNE3D', description: 'Reserved by extended data link security document (0x3D)',                                          isPending: false },
  { code: 0x3E, shortName: 'RBEDNE3E', description: 'Reserved by extended data link security document (0x3E)',                                          isPending: false },
  { code: 0x3F, shortName: 'RBEDNE3F', description: 'Reserved by extended data link security document (0x3F)',                                          isPending: false },
  { code: 0x40, shortName: 'RBEDNE40', description: 'Reserved by extended data link security document (0x40)',                                          isPending: false },
  { code: 0x41, shortName: 'RBEDNE41', description: 'Reserved by extended data link security document (0x41)',                                          isPending: false },
  { code: 0x42, shortName: 'RBEDNE42', description: 'Reserved by extended data link security document (0x42)',                                          isPending: false },
  { code: 0x43, shortName: 'RBEDNE43', description: 'Reserved by extended data link security document (0x43)',                                          isPending: false },
  { code: 0x44, shortName: 'RBEDNE44', description: 'Reserved by extended data link security document (0x44)',                                          isPending: false },
  { code: 0x45, shortName: 'RBEDNE45', description: 'Reserved by extended data link security document (0x45)',                                          isPending: false },
  { code: 0x46, shortName: 'RBEDNE46', description: 'Reserved by extended data link security document (0x46)',                                          isPending: false },
  { code: 0x47, shortName: 'RBEDNE47', description: 'Reserved by extended data link security document (0x47)',                                          isPending: false },
  { code: 0x48, shortName: 'RBEDNE48', description: 'Reserved by extended data link security document (0x48)',                                          isPending: false },
  { code: 0x49, shortName: 'RBEDNE49', description: 'Reserved by extended data link security document (0x49)',                                          isPending: false },
  { code: 0x4A, shortName: 'RBEDNE4A', description: 'Reserved by extended data link security document (0x4A)',                                          isPending: false },
  { code: 0x4B, shortName: 'RBEDNE4B', description: 'Reserved by extended data link security document (0x4B)',                                          isPending: false },
  { code: 0x4C, shortName: 'RBEDNE4C', description: 'Reserved by extended data link security document (0x4C)',                                          isPending: false },
  { code: 0x4D, shortName: 'RBEDNE4D', description: 'Reserved by extended data link security document (0x4D)',                                          isPending: false },
  { code: 0x4E, shortName: 'RBEDNE4E', description: 'Reserved by extended data link security document (0x4E)',                                          isPending: false },
  { code: 0x4F, shortName: 'RBEDNE4F', description: 'Reserved by extended data link security document (0x4F)',                                          isPending: false },

  // ── 0x50–0x6F: ISOSAEReserved ────────────────────────────────────────
  { code: 0x50, shortName: 'ISOSAERESERVED50', description: 'ISO-SAE reserved (0x50)',                                                                  isPending: false },
  { code: 0x51, shortName: 'ISOSAERESERVED51', description: 'ISO-SAE reserved (0x51)',                                                                  isPending: false },
  { code: 0x52, shortName: 'ISOSAERESERVED52', description: 'ISO-SAE reserved (0x52)',                                                                  isPending: false },
  { code: 0x53, shortName: 'ISOSAERESERVED53', description: 'ISO-SAE reserved (0x53)',                                                                  isPending: false },
  { code: 0x54, shortName: 'ISOSAERESERVED54', description: 'ISO-SAE reserved (0x54)',                                                                  isPending: false },
  { code: 0x55, shortName: 'ISOSAERESERVED55', description: 'ISO-SAE reserved (0x55)',                                                                  isPending: false },
  { code: 0x56, shortName: 'ISOSAERESERVED56', description: 'ISO-SAE reserved (0x56)',                                                                  isPending: false },
  { code: 0x57, shortName: 'ISOSAERESERVED57', description: 'ISO-SAE reserved (0x57)',                                                                  isPending: false },
  { code: 0x58, shortName: 'ISOSAERESERVED58', description: 'ISO-SAE reserved (0x58)',                                                                  isPending: false },
  { code: 0x59, shortName: 'ISOSAERESERVED59', description: 'ISO-SAE reserved (0x59)',                                                                  isPending: false },
  { code: 0x5A, shortName: 'ISOSAERESERVED5A', description: 'ISO-SAE reserved (0x5A)',                                                                  isPending: false },
  { code: 0x5B, shortName: 'ISOSAERESERVED5B', description: 'ISO-SAE reserved (0x5B)',                                                                  isPending: false },
  { code: 0x5C, shortName: 'ISOSAERESERVED5C', description: 'ISO-SAE reserved (0x5C)',                                                                  isPending: false },
  { code: 0x5D, shortName: 'ISOSAERESERVED5D', description: 'ISO-SAE reserved (0x5D)',                                                                  isPending: false },
  { code: 0x5E, shortName: 'ISOSAERESERVED5E', description: 'ISO-SAE reserved (0x5E)',                                                                  isPending: false },
  { code: 0x5F, shortName: 'ISOSAERESERVED5F', description: 'ISO-SAE reserved (0x5F)',                                                                  isPending: false },
  { code: 0x60, shortName: 'ISOSAERESERVED60', description: 'ISO-SAE reserved (0x60)',                                                                  isPending: false },
  { code: 0x61, shortName: 'ISOSAERESERVED61', description: 'ISO-SAE reserved (0x61)',                                                                  isPending: false },
  { code: 0x62, shortName: 'ISOSAERESERVED62', description: 'ISO-SAE reserved (0x62)',                                                                  isPending: false },
  { code: 0x63, shortName: 'ISOSAERESERVED63', description: 'ISO-SAE reserved (0x63)',                                                                  isPending: false },
  { code: 0x64, shortName: 'ISOSAERESERVED64', description: 'ISO-SAE reserved (0x64)',                                                                  isPending: false },
  { code: 0x65, shortName: 'ISOSAERESERVED65', description: 'ISO-SAE reserved (0x65)',                                                                  isPending: false },
  { code: 0x66, shortName: 'ISOSAERESERVED66', description: 'ISO-SAE reserved (0x66)',                                                                  isPending: false },
  { code: 0x67, shortName: 'ISOSAERESERVED67', description: 'ISO-SAE reserved (0x67)',                                                                  isPending: false },
  { code: 0x68, shortName: 'ISOSAERESERVED68', description: 'ISO-SAE reserved (0x68)',                                                                  isPending: false },
  { code: 0x69, shortName: 'ISOSAERESERVED69', description: 'ISO-SAE reserved (0x69)',                                                                  isPending: false },
  { code: 0x6A, shortName: 'ISOSAERESERVED6A', description: 'ISO-SAE reserved (0x6A)',                                                                  isPending: false },
  { code: 0x6B, shortName: 'ISOSAERESERVED6B', description: 'ISO-SAE reserved (0x6B)',                                                                  isPending: false },
  { code: 0x6C, shortName: 'ISOSAERESERVED6C', description: 'ISO-SAE reserved (0x6C)',                                                                  isPending: false },
  { code: 0x6D, shortName: 'ISOSAERESERVED6D', description: 'ISO-SAE reserved (0x6D)',                                                                  isPending: false },
  { code: 0x6E, shortName: 'ISOSAERESERVED6E', description: 'ISO-SAE reserved (0x6E)',                                                                  isPending: false },
  { code: 0x6F, shortName: 'ISOSAERESERVED6F', description: 'ISO-SAE reserved (0x6F)',                                                                  isPending: false },

  // ── 0x70–0x73: Named ─────────────────────────────────────────────────
  { code: 0x70, shortName: 'UDNA',   description: 'Upload/download not accepted — flash conditions not ready',                                          isPending: false },
  { code: 0x71, shortName: 'TDS',    description: 'Transfer data suspended — data transfer aborted by ECU',                                             isPending: false },
  { code: 0x72, shortName: 'GPF',    description: 'General programming failure — write/erase error',                                                    isPending: false },
  { code: 0x73, shortName: 'WBSC',   description: 'Wrong block sequence counter — transfer block number mismatch',                                      isPending: false },

  // ── 0x74–0x77: ISOSAEReserved ────────────────────────────────────────
  { code: 0x74, shortName: 'ISOSAERESERVED74', description: 'ISO-SAE reserved (0x74)',                                                                  isPending: false },
  { code: 0x75, shortName: 'ISOSAERESERVED75', description: 'ISO-SAE reserved (0x75)',                                                                  isPending: false },
  { code: 0x76, shortName: 'ISOSAERESERVED76', description: 'ISO-SAE reserved (0x76)',                                                                  isPending: false },
  { code: 0x77, shortName: 'ISOSAERESERVED77', description: 'ISO-SAE reserved (0x77)',                                                                  isPending: false },

  // ── 0x78: Named ──────────────────────────────────────────────────────
  { code: 0x78, shortName: 'RCRRP',  description: 'Response correctly received, request pending — ECU still processing; poll for final response',       isPending: true  },

  // ── 0x79–0x7D: ISOSAEReserved ────────────────────────────────────────
  { code: 0x79, shortName: 'ISOSAERESERVED79', description: 'ISO-SAE reserved (0x79)',                                                                  isPending: false },
  { code: 0x7A, shortName: 'ISOSAERESERVED7A', description: 'ISO-SAE reserved (0x7A)',                                                                  isPending: false },
  { code: 0x7B, shortName: 'ISOSAERESERVED7B', description: 'ISO-SAE reserved (0x7B)',                                                                  isPending: false },
  { code: 0x7C, shortName: 'ISOSAERESERVED7C', description: 'ISO-SAE reserved (0x7C)',                                                                  isPending: false },
  { code: 0x7D, shortName: 'ISOSAERESERVED7D', description: 'ISO-SAE reserved (0x7D)',                                                                  isPending: false },

  // ── 0x7E–0x7F: Named ─────────────────────────────────────────────────
  { code: 0x7E, shortName: 'SFNSIAS',  description: 'Sub-function not supported in active session',                                                     isPending: false },
  { code: 0x7F, shortName: 'SNSIAS',   description: 'Service not supported in active session',                                                          isPending: false },

  // ── 0x80: ISOSAEReserved ─────────────────────────────────────────────
  { code: 0x80, shortName: 'ISOSAERESERVED80', description: 'ISO-SAE reserved (0x80)',                                                                  isPending: false },

  // ── 0x81–0x8D: Named vehicle-condition NRCs ──────────────────────────
  { code: 0x81, shortName: 'RPMTOHIGH',                description: 'RPM too high — engine speed above allowed threshold for this operation',           isPending: false },
  { code: 0x82, shortName: 'RPMTOLOW',                 description: 'RPM too low — engine speed below allowed threshold',                              isPending: false },
  { code: 0x83, shortName: 'ENG_IS_RUNNING',           description: 'Engine is running — operation requires engine off',                               isPending: false },
  { code: 0x84, shortName: 'ENG_IS_NOT_RUNNING',       description: 'Engine is not running — operation requires engine running',                       isPending: false },
  { code: 0x85, shortName: 'ENG_RUN_TIME_TOO_LOW',     description: 'Engine run time too low — warm-up period incomplete',                             isPending: false },
  { code: 0x86, shortName: 'TEMP_TOO_HIGH',            description: 'Temperature too high',                                                            isPending: false },
  { code: 0x87, shortName: 'TEMP_TOO_LOW',             description: 'Temperature too low',                                                             isPending: false },
  { code: 0x88, shortName: 'VEHICLE_SPEED_TOO_HIGH',   description: 'Vehicle speed too high',                                                          isPending: false },
  { code: 0x89, shortName: 'VEHICLE_SPEED_TOO_LOW',    description: 'Vehicle speed too low',                                                           isPending: false },
  { code: 0x8A, shortName: 'THROTTLE_TOO_HIGH',        description: 'Throttle/pedal position too high',                                               isPending: false },
  { code: 0x8B, shortName: 'THROTTLE_TOO_LOW',         description: 'Throttle/pedal position too low',                                                isPending: false },
  { code: 0x8C, shortName: 'TRANS_RANGE_NOT_IN_NEUTRAL', description: 'Transmission range not in neutral',                                            isPending: false },
  { code: 0x8D, shortName: 'TRANS_RANGE_NOT_IN_GEAR',    description: 'Transmission range not in gear',                                               isPending: false },

  // ── 0x8E: ISOSAEReserved ─────────────────────────────────────────────
  { code: 0x8E, shortName: 'ISOSAERESERVED8E', description: 'ISO-SAE reserved (0x8E)',                                                                  isPending: false },

  // ── 0x8F–0x93: Named vehicle-condition NRCs ──────────────────────────
  { code: 0x8F, shortName: 'BRAKE_SWITCH_NOT_CLOSED',   description: 'Brake switch not closed (brake not pressed)',                                    isPending: false },
  { code: 0x90, shortName: 'SHIFTER_LEVER_NOT_IN_PARK', description: 'Shift lever not in park',                                                        isPending: false },
  { code: 0x91, shortName: 'TORQUE_CONV_CLUTCH_LOCKED', description: 'Torque converter clutch locked',                                                 isPending: false },
  { code: 0x92, shortName: 'VOLT_TOO_HIGH',             description: 'Voltage too high — supply voltage exceeds threshold',                            isPending: false },
  { code: 0x93, shortName: 'VOLT_TOO_LOW',              description: 'Voltage too low — supply voltage below threshold',                               isPending: false },
] as const;

/** Look up an NRC entry by code. Returns undefined for unknown codes. */
export function nrcEntry(code: number): NRCEntry | undefined {
  return NRC_TABLE.find(e => e.code === code);
}

/** Return a human-readable description of an NRC. Falls back to hex for unknown codes. */
export function nrcDescription(code: number): string {
  const e = nrcEntry(code);
  if (e) return `0x${code.toString(16).toUpperCase().padStart(2, '0')} ${e.shortName} — ${e.description}`;
  return `0x${code.toString(16).toUpperCase().padStart(2, '0')} (unknown NRC)`;
}

/** Returns true if the NRC represents a temporary/pending condition. */
export function nrcIsPending(code: number): boolean {
  return nrcEntry(code)?.isPending ?? false;
}
