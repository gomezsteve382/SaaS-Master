// SRT / Hellcat performance operations — built on top of the cipher,
// transport, and flash layers. These are the actual user-facing routines
// that an SRT Lab operator triggers from the UI.
//
// Each operation is a sequence of UDS frames + cipher steps + state checks,
// wrapped in a generator so the UI can drive it one phase at a time and
// surface progress.
//
// IMPORTANT — JURISDICTIONAL CAVEATS:
//   - Speed limiter modification: legal in US for off-road / track use,
//     illegal in EU on public roads, varies elsewhere
//   - DPF/EGR delete: illegal in US under Clean Air Act (EPA fines $7,500
//     per vehicle), illegal in EU
//   - Catalytic converter delete: similar to DPF
//   - Mileage correction: illegal in most jurisdictions for resale
//   - VIN cloning: illegal everywhere
//   - SGW bypass: gray area, depends on local right-to-repair laws
//   - Tune flashing for your OWNED vehicle's track use: generally legal
//
// This module IMPLEMENTS the technical routines. Use responsibly and only on
// vehicles you own, on closed-course / private property.

import { UDS_SID } from "./flashSequencer.js";
import { FCA_DIAGNOSTIC_CAN_IDS } from "./isotp.js";
import { unlockKeyBytes, unlockIdForTx } from "./algos.js";

/**
 * Speed limiter set/disable for Hellcat-class engines.
 *
 * UDS frame: 31 01 DF [speed_kmh_lo] [speed_kmh_hi]
 *   - 0x31 = RoutineControl
 *   - 0x01 = startRoutine
 *   - 0xDF = FCA-specific RoutineID (extracted from SendActiveDiagnostic3 IL
 *            adjacent to "Enter max speed within the allowable range,
 *            between 65 km/h and max allowable speed of [X]" string)
 *   - speed in km/h, little-endian 16-bit
 *
 * Preconditions:
 *   - Engine NOT running (or at idle in some platforms)
 *   - 10 03 (extended diagnostic session) entered
 *   - SecurityAccess unlocked
 *   - SGW unlocked (2018+)
 *
 * Common targets:
 *   - Disable (set to maximum): 350 km/h = 0x015E = [0x5E, 0x01]
 *   - 250 km/h "Euro autobahn unrestricted": [0xFA, 0x00]
 *   - 240 km/h Hellcat factory governed: [0xF0, 0x00]
 *   - 209 km/h base Charger SXT: [0xD1, 0x00]
 *   - 65 km/h hard floor (per AlfaOBD message text): [0x41, 0x00]
 *
 * @param {number} speedKmh  Target max speed in km/h (range 65-vehicle max)
 * @returns {Uint8Array}     UDS payload bytes
 */
export function buildSpeedLimiterFrame(speedKmh) {
  if (speedKmh < 65) throw new Error(`Speed limit minimum is 65 km/h (got ${speedKmh})`);
  if (speedKmh > 65535) throw new Error(`Speed limit out of range`);
  return new Uint8Array([
    UDS_SID.RoutineControl,
    0x01,
    0xdf,
    speedKmh & 0xff,
    (speedKmh >> 8) & 0xff,
  ]);
}

/**
 * Full sequence for setting speed limiter on a Hellcat PCM.
 * Drives session entry → SA → SGW (if 2018+) → speed-limit routine.
 *
 * @param {object} options
 * @param {number} options.speedKmh
 * @param {object} options.cipher         Cipher implementation (typically alfaHt for PCM default)
 * @param {boolean} options.requiresSgw  Auto-detected from year/platform
 */
export async function* setSpeedLimiter({ speedKmh, cipher, requiresSgw = false }) {
  if (requiresSgw) {
    yield { phase: "PRE_SGW", message: "SGW unlock required — run sgwUnlockSequence() first" };
  }
  yield { phase: 1, name: "EnterExtendedSession", uds: [UDS_SID.DSC, 0x03] };
  // SA cycle
  const seedResp = yield { phase: 2, name: "PCM_RequestSeed", uds: [UDS_SID.SecurityAccess, 0x01] };
  const seed = seedResp.subarray(2, 6);
  const key = cipher.unlockKey(seed);
  yield { phase: 3, name: "PCM_SendKey", uds: [UDS_SID.SecurityAccess, 0x02, ...key] };
  // Speed limiter routine
  const frame = buildSpeedLimiterFrame(speedKmh);
  yield { phase: 4, name: "SetSpeedLimit", uds: Array.from(frame) };
  // Reset to apply
  yield { phase: 5, name: "EcuReset", uds: [UDS_SID.ECUReset, 0x01] };
}

/**
 * Hellcat Track Mode / Drive Mode set.
 * SRT Hellcat / TrackHawk supports modes: Auto / Sport / Track / Custom.
 * Mode is selected via the UConnect display in stock; bench-set via PCM
 * routine 0x2065 (observed in catalog).
 *
 * @param {string} mode  'auto' | 'sport' | 'track' | 'custom'
 */
export function buildDriveModeFrame(mode) {
  const modes = { auto: 0x00, sport: 0x01, track: 0x02, custom: 0x03 };
  const m = modes[mode.toLowerCase()];
  if (m === undefined) throw new Error(`Unknown drive mode: ${mode}`);
  return new Uint8Array([UDS_SID.RoutineControl, 0x01, 0x20, 0x65, m]);
}

/**
 * Launch Control RPM target — Hellcat / SRT trans brake / launch RPM.
 * Range typically 1000-3500 RPM. Stock Hellcat launch = ~2350 RPM.
 *
 * @param {number} rpm  Launch RPM target
 */
export function buildLaunchRpmFrame(rpm) {
  if (rpm < 800 || rpm > 5000) throw new Error(`Launch RPM out of range: ${rpm}`);
  return new Uint8Array([
    UDS_SID.RoutineControl,
    0x01,
    0x20,
    0x66,
    rpm & 0xff,
    (rpm >> 8) & 0xff,
  ]);
}

/**
 * Disable Traction Control / ESC / Stability programmatically (vs. UI toggle).
 * The TCSM (Traction Control State Machine) responds to a routine that
 * forcibly toggles the "off" state. Useful for dyno runs and track use where
 * the operator wants programmatic control.
 *
 * UDS frame observed in AlfaOBD IL: 31 01 30 51 (RoutineControl start RID
 * 0x3051) and 31 01 30 52 paired with "Telltale - ESC Off:" and
 * "ASBM Traction Control Request:" string contexts.
 */
export function buildEscDisableFrame() {
  return new Uint8Array([UDS_SID.RoutineControl, 0x01, 0x30, 0x51]);
}
export function buildEscEnableFrame() {
  return new Uint8Array([UDS_SID.RoutineControl, 0x01, 0x30, 0x52]);
}

/**
 * Read current speed limiter setting (RDBI on PCM).
 * Returns the current target max speed in km/h.
 */
export function buildReadSpeedLimitFrame() {
  // DID 0x20DF observed: PCM stores current speed limit at this DID
  return new Uint8Array([UDS_SID.RDBI, 0x20, 0xdf]);
}

/**
 * Read Hellcat boost-related diagnostic data (RDBI on PCM).
 * Hellcat supercharger boost target / actual / wastegate position.
 */
export const HELLCAT_BOOST_DIDS = {
  WASTEGATE_FEEDBACK: 0xa017, // 'Wastegate H-Bridge:' related
  BOOST_INLET_C1_REQUEST: 0xa019,
  BOOST_INLET_C1_FEEDBACK: 0xa01a,
  BOOST_INLET_C2_REQUEST: 0xa01b,
  BOOST_INLET_C2_FEEDBACK: 0xa01c,
  BOOST_INLET_S_REQUEST: 0xa01d,
  BOOST_INLET_S_FEEDBACK: 0xa01e,
  BOOST_OUTLET_C1_REQUEST: 0xa01f,
  BOOST_OUTLET_C1_FEEDBACK: 0xa020,
  BOOST_SEPARATION_VALVE_REQUEST: 0xa023,
  BOOST_SEPARATION_VALVE_FEEDBACK: 0xa024,
  SUPERCHARGER_SPEED: 0xa055,
  MANIFOLD_ABSOLUTE_PRESSURE: 0xa067,
  INTAKE_AIR_TEMP_PRE_SC: 0x010b,
  INTAKE_AIR_TEMP_POST_SC: 0x010c,
};

/**
 * Build a multi-DID RDBI request to poll all Hellcat boost telemetry.
 * Useful for SRT Lab's live monitoring during track sessions.
 */
export function buildHellcatBoostMonitorFrame() {
  // Combine multiple DIDs into a single RDBI request (FCA supports multi-DID)
  const dids = [
    HELLCAT_BOOST_DIDS.BOOST_INLET_C1_FEEDBACK,
    HELLCAT_BOOST_DIDS.BOOST_OUTLET_C1_FEEDBACK,
    HELLCAT_BOOST_DIDS.SUPERCHARGER_SPEED,
    HELLCAT_BOOST_DIDS.MANIFOLD_ABSOLUTE_PRESSURE,
    HELLCAT_BOOST_DIDS.INTAKE_AIR_TEMP_PRE_SC,
    HELLCAT_BOOST_DIDS.INTAKE_AIR_TEMP_POST_SC,
  ];
  const payload = [UDS_SID.RDBI];
  for (const did of dids) {
    payload.push((did >> 8) & 0xff, did & 0xff);
  }
  return new Uint8Array(payload);
}

/**
 * Parse a multi-DID RDBI response into a {didHex: bytes} map.
 * Format: 62 [DID1 hi] [DID1 lo] [data1...] [DID2 hi] [DID2 lo] [data2...]
 * Caller must know data length per DID (FCA-specific, looked up in catalog).
 */
export function parseHellcatBoostResponse(response, didLengths) {
  if (response[0] !== 0x62) throw new Error(`Not a positive RDBI response: 0x${response[0].toString(16)}`);
  const result = {};
  let offset = 1;
  while (offset < response.length) {
    const did = (response[offset] << 8) | response[offset + 1];
    const len = didLengths[did] || 2;
    result[`0x${did.toString(16).toUpperCase().padStart(4, "0")}`] = response.subarray(
      offset + 2,
      offset + 2 + len,
    );
    offset += 2 + len;
  }
  return result;
}

/**
 * Convenience: full Hellcat "Track Day" preset.
 * Disables ESC, sets launch RPM to 2350, opens performance datalog DIDs.
 * Returns an async generator the UI can drive.
 */
export async function* hellcatTrackDayPreset({ cipher, launchRpm = 2350 }) {
  yield { phase: 1, name: "EnterExtendedSession", uds: [UDS_SID.DSC, 0x03] };
  const seedResp = yield { phase: 2, name: "PCM_RequestSeed", uds: [UDS_SID.SecurityAccess, 0x01] };
  const key = cipher.unlockKey(seedResp.subarray(2, 6));
  yield { phase: 3, name: "PCM_SendKey", uds: [UDS_SID.SecurityAccess, 0x02, ...key] };
  yield { phase: 4, name: "DisableESC", uds: Array.from(buildEscDisableFrame()) };
  yield { phase: 5, name: "SetLaunchRpm", uds: Array.from(buildLaunchRpmFrame(launchRpm)) };
  yield { phase: 6, name: "SetTrackMode", uds: Array.from(buildDriveModeFrame("track")) };
  yield { phase: 7, name: "ReadyForTrack", message: "All track preset routines applied" };
}
