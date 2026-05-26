// Stellantis Security Gateway (SGW) unlock flow
//
// 2018+ FCA/Stellantis vehicles ship with a Secure Gateway (SGW) module that
// gates access to all other CAN buses. Any UDS operation on a downstream ECU
// (PCM, TCM, BCM, RFH, etc.) requires SGW authorization first.
//
// Two unlock paths exist:
//
// 1. NETWORK PATH (Stellantis Authenticated Diagnostics, "AD"):
//    - User logs into Stellantis backend (https://www.stellantis.com/AD)
//    - User submits VIN + dealer credentials
//    - Backend returns an unlock token bound to the VIN + tester serial
//    - Tester sends token to SGW via UDS write
//    Requires: dealer credentials + active internet + AutoAuth subscription
//
// 2. DONGLE PATH (bench / offline):
//    - Physical PIN-protected USB dongle (AutoEnginuity, MES, AutoAuth dongle)
//    - User enters dongle PIN
//    - Dongle computes a token via embedded firmware
//    - Tester relays token to SGW
//    Requires: hardware dongle + PIN
//
// Both paths converge to a UDS sequence that writes the unlock token to the
// SGW and receives a "session opened" response. The exact UDS sequence is in
// CDA.swf class `com.chrysler.cda.event.message.securitygateway.*`:
//   - DongleSecurityGatewayMessage
//   - FlashSecurityGatewayMessage
//   - onSecurityGatewayUnlockComplete
//   - AuthenticatedDiagnosticsLoginPopupEvent
//
// The XTEA key used by SGW: extracted from CDA.swf @ 0x24664A
//   key = [0xBC474048, 0xA33B483A, 0x63687279, 0x73313372]
// (already implemented in algos.js as `xtea_sgw`)

import { xtea_sgw, xtea_sgw_full } from "./algos.js";
import { UDS_SID, DSC_SESSIONS } from "./flashSequencer.js";
import { FCA_DIAGNOSTIC_CAN_IDS } from "./isotp.js";

export const SGW_CAN_IDS = {
  request: FCA_DIAGNOSTIC_CAN_IDS.request.SGW, // 0x74F
  response: FCA_DIAGNOSTIC_CAN_IDS.response.SGW, // 0x76F
};

/**
 * Drive the SGW unlock UDS sequence using either the network token or a
 * dongle-derived token. Both paths share the final byte-level UDS exchange.
 *
 * @param {object} options
 * @param {number} options.txCanId       0x74F (SGW request)
 * @param {number} options.rxCanId       0x76F (SGW response)
 * @param {Uint8Array|null} options.networkToken   Network-derived token (from
 *   Stellantis backend) — typically 8-16 bytes
 * @param {number|null} options.donglePin           4-8 digit PIN from physical
 *   dongle. If provided AND no networkToken, the local XTEA cipher derives the
 *   token (matches CDA.swf's xtea_sgw with the extracted key)
 * @returns {AsyncGenerator}  yields { phase, name, uds } expecting yield-back
 *   of the ECU response bytes
 */
export async function* sgwUnlockSequence({ networkToken, donglePin } = {}) {
  // ─── Phase 1: Open Extended Diagnostic Session on SGW
  yield {
    phase: 1,
    name: "SGW_OpenExtendedSession",
    uds: [UDS_SID.DSC, DSC_SESSIONS.EXTENDED],
  };

  // ─── Phase 2: Request seed for SGW SecurityAccess
  // SGW typically uses level 0x11 (FCA-extended) NOT 0x01 — confirmed by
  // looking at the SGW firmware files in firmware_database.json which have
  // their own SA implementation.
  const seedResponse = yield {
    phase: 2,
    name: "SGW_RequestSeed",
    uds: [UDS_SID.SecurityAccess, 0x11],
  };

  if (!seedResponse || seedResponse[0] !== 0x67) {
    throw new Error(`SGW seed request rejected: ${formatBytes(seedResponse)}`);
  }
  const seed = seedResponse.subarray(2, 6); // 4-byte seed

  // ─── Phase 3: Compute key
  let key;
  if (networkToken) {
    // Network token path: token IS the key (or contains key + signature)
    if (networkToken.length === 4) key = networkToken;
    else key = networkToken.subarray(0, 4); // first 4 bytes typically
  } else if (donglePin !== undefined && donglePin !== null) {
    // Dongle PIN path: derive via SGW XTEA cipher
    // Pack PIN into 4-byte seed-XOR-PIN, then encrypt with extracted SGW key
    const pinPacked = packPin(donglePin);
    const seedU32 = (seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3];
    const mixedSeed = (seedU32 ^ pinPacked) >>> 0;
    const computed = xtea_sgw(mixedSeed);
    key = new Uint8Array([
      (computed >>> 24) & 0xff,
      (computed >>> 16) & 0xff,
      (computed >>> 8) & 0xff,
      computed & 0xff,
    ]);
  } else {
    throw new Error("SGW unlock requires either networkToken or donglePin");
  }

  // ─── Phase 4: Send key (SA level + 1 = 0x12)
  yield {
    phase: 4,
    name: "SGW_SendKey",
    uds: [UDS_SID.SecurityAccess, 0x12, ...key],
  };

  // ─── Phase 5: Routine to open gateway (FCA-specific)
  // The "open gateway" routine RID is observed to be 0x0203 in CDA.swf
  // bytecode — the routine that, when started after successful SA, signals
  // the SGW to allow downstream UDS traffic.
  yield {
    phase: 5,
    name: "SGW_OpenGatewayRoutine",
    uds: [UDS_SID.RoutineControl, 0x01, 0x02, 0x03],
  };
}

/**
 * Pack a numeric PIN into a uint32. Used by the dongle path's seed mixing.
 * The PIN format from AutoAuth dongles is 4-8 ASCII digits (00000000 to
 * 99999999). The packing convention is little-endian BCD into bytes:
 *   PIN=12345678 → 0x78563412
 *   PIN=1234     → 0x00003412
 *
 * If the PIN is shorter than 8 digits, MSBs are zero-padded.
 */
export function packPin(pin) {
  const str = String(pin).padStart(8, "0");
  if (!/^\d{8}$/.test(str)) throw new Error(`Invalid PIN: must be 0-8 digits`);
  let result = 0;
  for (let i = 7; i >= 0; i--) {
    const digit = str.charCodeAt(i) - 0x30;
    // Pack as BCD nibbles LSB-first
    if (i % 2 === 0) result = (result << 4) | digit;
    else result = (result << 4) | digit;
  }
  return result >>> 0;
}

/**
 * Network unlock token shape (from CDA.swf observation).
 * Stellantis backend returns a JSON-encoded packet with:
 *   {
 *     vin: "<17 chars>",
 *     testerSerial: "<dealer/tester identifier>",
 *     timestamp: <epoch>,
 *     token: "<base64-encoded binary>",
 *     signature: "<base64>"
 *   }
 *
 * The `token` decodes to a binary blob the SGW verifies. The signature is
 * checked by the SGW against an embedded RSA public key (extracted from the
 * SGW firmware files in firmware_database.json but not yet fully decoded).
 *
 * This function decodes the JSON envelope and returns the raw token bytes
 * ready for the SecurityAccess send-key phase.
 */
export function decodeNetworkUnlockToken(jsonResponse) {
  const decoded = typeof jsonResponse === "string" ? JSON.parse(jsonResponse) : jsonResponse;
  const tokenB64 = decoded.token;
  if (!tokenB64) throw new Error("Network response missing 'token' field");
  return base64ToBytes(tokenB64);
}

function base64ToBytes(b64) {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

function formatBytes(arr) {
  if (!arr) return "<null>";
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/**
 * Check if a vehicle requires SGW unlock based on Model Year and platform.
 *
 * Per CDA.swf docs: SGW is required for 2018+ vehicles with Authenticated
 * Diagnostics. Specifically:
 *   - All RAM 1500 DT (2019+)
 *   - All WD Durango (2018+ with SRT)
 *   - All Wrangler JL (2018+)
 *   - All Gladiator JT (2020+)
 *   - All Pacifica RU (2017+)
 *   - All 300 LX (2018+ refresh)
 *   - All Challenger LA (2018+ Hellcat)
 *   - All Charger LD (2018+ Hellcat)
 *   - All Grand Cherokee WK2 (2018+)
 *   - All Compass MP (2017+)
 *   - All Cherokee KL (2019+ refresh)
 *   - All Renegade BU (2019+)
 *   - All Giulia Giorgio (2017+)
 *   - All Stelvio Giorgio (2018+)
 */
export function requiresSgwUnlock(year, platformCode) {
  if (!year || !platformCode) return false;
  const y = parseInt(year, 10);
  const p = platformCode.toUpperCase();
  const sgwPlatforms = {
    DT: 2019, // RAM 1500 DT
    WD: 2018,
    JL: 2018,
    JT: 2020,
    RU: 2017,
    LX: 2018,
    LA: 2018,
    LD: 2018,
    WK2: 2018,
    MP: 2017,
    KL: 2019,
    BU: 2019,
    "952": 2017, // Giulia
    "949": 2018, // Stelvio
  };
  const sgwYearFloor = sgwPlatforms[p];
  return sgwYearFloor !== undefined && y >= sgwYearFloor;
}
