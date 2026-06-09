/**
 * bcmModuleManifest.js
 *
 * Derives a "Vehicle Module Manifest" from real UDS DID responses.
 * Sources:
 *   - TIPM CGW Config (DID 22 3B04, 22 3B05, 22 3B0B, 22 3B0C, 22 3B0D)
 *     → module presence bits (ABS, TCM, ORC, NTG4 Radio, RKE, etc.)
 *   - BCM BODY_PN_CONFIG (DID 22 01 23)
 *     → SKIM system present, A/C, etc.
 *   - BCM Proxy VIN Data (DID 22 20 23)
 *     → VIN string (ASCII, 17 chars at offset 3 of the positive response)
 *
 * Usage:
 *   import { buildModuleManifest, parseProxyVin } from './bcmModuleManifest.js';
 *
 *   // responses: Map<didHex, Uint8Array>  (positive response bytes, leading 62 xx xx stripped)
 *   const manifest = buildModuleManifest(responses);
 *   // → { modules: [{id, label, present, source, confidence}], vin, rawRows }
 */

import { readBits } from './cgwConfig.js';

// ─── Module presence bit definitions ────────────────────────────────────────
// Each entry: { id, label, did, byteOffset, bitInByte, source }
// did: the DID hex as sent (e.g. "3B04") — caller strips 62 hi lo header
// bitInByte: 0=MSB, 7=LSB within the byte at byteOffset
// globalBit: pre-computed MSB-first global bit offset within the DID payload
// (byteOffset * 8 + (7 - bitInByte) for MSB-first, but CGW_CONFIG uses
//  MSB-first bit numbering starting at 0 for the first bit of the payload)

const MODULE_PRESENCE_BITS = [
  // ── TIPM 3B04 — Cabin network modules ──────────────────────────────────
  { id: 'CCN',   label: 'CCN — Instrument Cluster',       did: '3B04', globalBit: 18 },
  { id: 'DDM',   label: 'DDM — Driver Door Module',       did: '3B04', globalBit: 19 },
  { id: 'SUSP',  label: 'SUSP — Suspension Module',       did: '3B04', globalBit: 24 },
  { id: 'ITM',   label: 'ITM — Intrusion Transceiver',    did: '3B04', globalBit: 29 },
  { id: 'WCM',   label: 'WCM — Wireless Control Module',  did: '3B04', globalBit: 43 },
  { id: 'PEM',   label: 'PEM — Passive Entry Module',     did: '3B04', globalBit: 55 },
  { id: 'PTCM',  label: 'PTCM — Power Top Control',       did: '3B04', globalBit: 56 },
  { id: 'ORC',   label: 'ORC — Occupant Restraint Ctrl',  did: '3B04', globalBit: 50 },
  { id: 'AMP',   label: 'AMP — Audio Amplifier',          did: '3B04', globalBit: 37 },
  { id: 'VES',   label: 'VES — Video Entertainment Sys',  did: '3B04', globalBit: 60 },
  { id: 'PLGM',  label: 'PLGM — Power LiftGate Module',   did: '3B04', globalBit: 47 },
  { id: 'CGW',   label: 'CGW — Central Gateway (SGW)',    did: '3B04', globalBit: 49 },

  // ── TIPM 3B05 — Powertrain modules ─────────────────────────────────────
  { id: 'ABS',   label: 'ABS/ESC — Antilock Brake Sys',   did: '3B05', globalBit: 16 },
  { id: 'PCM',   label: 'PCM/ECM — Powertrain Ctrl',      did: '3B05', globalBit: 17 },
  { id: 'TCM',   label: 'TCM — Transmission Ctrl',        did: '3B05', globalBit: 18 },
  { id: 'HCM',   label: 'HCM — Hybrid Control Module',    did: '3B05', globalBit: 25 },
  { id: 'ISG',   label: 'ISG — Integrated Starter-Gen',   did: '3B05', globalBit: 26 },

  // ── TIPM 3B0B — Vehicle config 2 ───────────────────────────────────────
  { id: 'RKE',       label: 'RKE — Remote Keyless Entry',   did: '3B0B', globalBit: 18 },
  { id: 'AIRBAG_S',  label: 'Side Airbag(s) Present',       did: '3B0B', globalBit: 96 },
  { id: 'TPMS',      label: 'TPMS Premium',                 did: '3B0B', globalBit: 98 },
  { id: 'REAR_FOG',  label: 'Rear Fog Lamps Present',       did: '3B0B', globalBit: 103 },
  { id: 'REAR_CAM',  label: 'Rear Camera Present',          did: '3B0B', globalBit: 114 },
  { id: 'INVERTER',  label: 'Inverter Present',             did: '3B0B', globalBit: 115 },
  { id: 'AC',        label: 'A/C Present',                  did: '3B0B', globalBit: 113 },

  // ── TIPM 3B0C — Vehicle config 3 ───────────────────────────────────────
  { id: 'NTG4_RADIO', label: 'NTG4 Radio (UConnect)',       did: '3B0C', globalBit: 121 },
  { id: 'EVIC',       label: 'EVIC Reconfigurable Display', did: '3B0C', globalBit: 123 },
  { id: 'PADDLE',     label: 'Paddle Shift Present',        did: '3B0C', globalBit: 138 },
  { id: 'WIN_ECU',    label: 'WIN ECU Present',             did: '3B0C', globalBit: 138 },

  // ── BCM 0123 — BODY_PN_CONFIG ───────────────────────────────────────────
  { id: 'SKIM',  label: 'SKIM / SKREEM / RFHUB',           did: '0123', globalBit: 34 },
  { id: 'AC_BCM',label: 'A/C (BCM config)',                 did: '0123', globalBit: 35 },
];

// ─── Module categories for display grouping ──────────────────────────────────
export const MODULE_CATEGORIES = {
  powertrain: ['PCM', 'TCM', 'ABS', 'HCM', 'ISG'],
  body:       ['CCN', 'DDM', 'WCM', 'PEM', 'PTCM', 'PLGM', 'ITM', 'SUSP', 'CGW'],
  safety:     ['ORC', 'AIRBAG_S'],
  comfort:    ['AC', 'AC_BCM', 'REAR_CAM', 'REAR_FOG', 'INVERTER', 'TPMS'],
  infotainment: ['NTG4_RADIO', 'AMP', 'VES', 'EVIC'],
  security:   ['SKIM', 'RKE'],
  performance: ['PADDLE', 'WIN_ECU'],
};

// ─── Parse the VIN from a BCM Proxy VIN Data (DID 2023) response ────────────
/**
 * @param {Uint8Array|number[]} responseBytes  Full positive response including 62 20 23 header
 * @returns {string|null}  17-char VIN or null
 */
export function parseProxyVin(responseBytes) {
  const buf = responseBytes instanceof Uint8Array
    ? responseBytes
    : new Uint8Array(responseBytes || []);
  // Positive response: 62 20 23 <payload>
  // VIN is ASCII at offset 3, 17 bytes
  if (buf.length < 20) return null;
  if (buf[0] !== 0x62) return null;
  try {
    const vin = String.fromCharCode(...buf.slice(3, 20));
    // Validate: VIN chars are alphanumeric (no I, O, Q)
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return vin;
    return null;
  } catch {
    return null;
  }
}

// ─── Build the full module manifest from a map of DID responses ─────────────
/**
 * @param {Map<string, Uint8Array>|Object} responses
 *   Keys are DID hex strings (e.g. "3B04", "3B05", "0123", "2023").
 *   Values are the FULL positive response bytes (including 62 hi lo header).
 *   The function strips the 3-byte header automatically.
 *
 * @returns {{
 *   modules: Array<{id, label, category, present, confidence, source}>,
 *   vin: string|null,
 *   rawRows: Array<{did, name, raw, label}>,
 *   didsCovered: string[],
 *   didsMissing: string[],
 * }}
 */
export function buildModuleManifest(responses) {
  // Normalize to Map
  const respMap = responses instanceof Map
    ? responses
    : new Map(Object.entries(responses));

  // Strip 62 hi lo header from each response
  const payloads = new Map();
  for (const [did, bytes] of respMap) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (buf.length >= 3 && buf[0] === 0x62) {
      payloads.set(did.toUpperCase(), buf.slice(3));
    } else if (buf.length > 0) {
      // Already stripped
      payloads.set(did.toUpperCase(), buf);
    }
  }

  const didsCovered = [...payloads.keys()];
  const didsNeeded = [...new Set(MODULE_PRESENCE_BITS.map(b => b.did.toUpperCase()))];
  const didsMissing = didsNeeded.filter(d => !payloads.has(d));

  const modules = [];
  const rawRows = [];

  for (const entry of MODULE_PRESENCE_BITS) {
    const didKey = entry.did.toUpperCase();
    const payload = payloads.get(didKey);

    let present = null;
    let confidence = 'unknown';

    if (payload) {
      const raw = readBits(payload, entry.globalBit, 1);
      if (raw !== null) {
        present = raw === 1;
        confidence = 'confirmed';
        rawRows.push({
          did: entry.did,
          name: entry.label,
          raw,
          label: raw === 1 ? 'Set' : 'Not Set',
        });
      } else {
        confidence = 'out_of_range';
      }
    } else {
      confidence = 'no_data';
    }

    // Determine category
    let category = 'other';
    for (const [cat, ids] of Object.entries(MODULE_CATEGORIES)) {
      if (ids.includes(entry.id)) { category = cat; break; }
    }

    modules.push({
      id: entry.id,
      label: entry.label,
      category,
      present,
      confidence,
      source: `DID ${entry.did} bit ${entry.globalBit}`,
    });
  }

  // Parse VIN from 2023 response if available
  const vin2023 = respMap.get('2023') || respMap.get('0x2023');
  const vin = vin2023 ? parseProxyVin(
    vin2023 instanceof Uint8Array ? vin2023 : new Uint8Array(vin2023)
  ) : null;

  return { modules, vin, rawRows, didsCovered, didsMissing };
}

// ─── Convenience: group manifest modules by category ────────────────────────
export function groupManifestByCategory(manifest) {
  const groups = {};
  for (const mod of manifest.modules) {
    if (!groups[mod.category]) groups[mod.category] = [];
    groups[mod.category].push(mod);
  }
  return groups;
}

// ─── DIDs required to build a complete manifest ──────────────────────────────
export const MANIFEST_REQUIRED_DIDS = [
  { did: '3B04', request: '22 3B 04', label: 'TIPM Cabin Network Config' },
  { did: '3B05', request: '22 3B 05', label: 'TIPM Powertrain Config' },
  { did: '3B0B', request: '22 3B 0B', label: 'TIPM Vehicle Config 2' },
  { did: '3B0C', request: '22 3B 0C', label: 'TIPM Vehicle Config 3' },
  { did: '0123', request: '22 01 23', label: 'BCM Body Config (SKIM)' },
  { did: '2023', request: '22 20 23', label: 'BCM Proxy VIN Data' },
];
