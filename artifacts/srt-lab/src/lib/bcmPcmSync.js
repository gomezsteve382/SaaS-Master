/* ============================================================================
 * bcmPcmSync.js — single source of truth for the BCM/RFH → PCM sync
 * transformations that used to live inline inside TwinTab.jsx and
 * SecurityTab.jsx.
 *
 * Task #404 unified the LOW-LEVEL byte writer (`writePcmSec6`) so every
 * production caller stamps the SEC6 record (FF FF FF AA marker @ 0x3C4
 * + 6 secret bytes @ 0x3C8) the same way. Task #406 extends that
 * unification to the WHOLE-FILE transformation so the four UI/library
 * paths that drive a sync from a tab button can be tested as actual
 * exported functions instead of closures inside JSX components — and so
 * any future "drift" in one tab fails the round-trip test in
 * `pcmSec6.fullFileRoundTrip.test.js` immediately.
 *
 * Production callers (with file:line refs at extraction time):
 *   - TwinTab.jsx                 → applyPcmFromBcm
 *   - SecurityTab.jsx (matchAll)  → applyPcmFromRfhWithVin
 *   - SecurityTab.jsx (rfhPcmSync)→ applyPcmSec6FromRfh
 *   - SecurityTab.jsx (syncGpecRfh) → applyPcmFromRfhWithVin
 *
 * The fifth path — `rfhPcmPair.applyRfhToPcm` — keeps its own wrapper
 * (it also drives an optional IMMO-byte repair toggle and consumes a
 * pre-parsed RFH/PCM info pair) but ultimately delegates to the same
 * `writePcmSec6` engine writer this module also calls.
 * ============================================================================ */

import { writePcmSec6 } from './securityBytes.js';
import { writeModuleVIN } from './fileUtils.js';

/**
 * P1 — TwinTab.applyPcmFromBcm.
 *
 * Inputs:
 *   pcmBuf            — Uint8Array, canonical 4096 or 8192 B GPEC2A image.
 *   bcmSec16Stored    — Uint8Array, the 16-byte BCM-stored SEC16 (read from
 *                       BCM_SEC16_OFFSETS[0] = 0x40C9 in TwinTab's parser).
 *                       BCM stores the SEC16 byte-reversed relative to the
 *                       RFHUB EEPROM; this function reverses it back so the
 *                       engine writer's first-6-byte slice yields the same
 *                       SEC6 a real bench would derive from the RFH side.
 *
 * Returns: { bytes, ok } from writePcmSec6 — `bytes` is the patched PCM
 * (a fresh Uint8Array; the input is not mutated), `ok` is false on a
 * non-canonical PCM size (engine writer refuses).
 */
export function applyPcmFromBcm(pcmBuf, bcmSec16Stored) {
  const sec16Rev = new Uint8Array(16);
  for (let i = 0; i < 16; i++) sec16Rev[i] = bcmSec16Stored[15 - i];
  return writePcmSec6(pcmBuf, sec16Rev);
}

/**
 * P4 — SecurityTab.doTool('rfhPcmSync').
 *
 * The "Import SEC6 from RFHUB" button. Pure SEC6 import — no VIN write.
 *
 * Inputs:
 *   pcmBuf       — Uint8Array, canonical 4096 or 8192 B GPEC2A image.
 *   rfhSec16Raw  — Uint8Array, the 16-byte RFH-form SEC16 (slot 1 raw,
 *                  as produced by parseModule's `info.sec16s[0].raw`).
 *
 * Returns: { bytes, ok } from writePcmSec6.
 */
export function applyPcmSec6FromRfh(pcmBuf, rfhSec16Raw) {
  return writePcmSec6(pcmBuf, rfhSec16Raw);
}

/**
 * P3 / P5 — SecurityTab.matchAll (GPEC2A branch) and
 * SecurityTab.syncGpecRfh.
 *
 * Both paths share the same two-step transformation:
 *   1. writeModuleVIN(GPEC2A) — patch all three PCM VIN slots to `vin`
 *      (no-op if `vin` is already there).
 *   2. writePcmSec6 — stamp the marker @ 0x3C4 and SEC6 @ 0x3C8 from
 *      the first 6 bytes of `rfhSec16Raw`.
 *
 * Inputs:
 *   pcmBuf       — Uint8Array, canonical 4096 or 8192 B GPEC2A image.
 *   rfhSec16Raw  — Uint8Array, RFH-form SEC16 (slot 1 raw).
 *   vin          — 17-char VIN string.
 *   pcmVins      — array of {offset} from parseModule (PCM's existing
 *                  VIN slots); writeModuleVIN uses these for GPEC2A
 *                  parity with parseModule's view of the file.
 *
 * Returns: { bytes, ok } from writePcmSec6 (post both writes).
 *   - If writeModuleVIN refuses (vin.length !== 17), falls back to a
 *     copy of pcmBuf and proceeds to the SEC6 write — same fallback the
 *     original SecurityTab code uses so a broken VIN can't block SEC6.
 */
export function applyPcmFromRfhWithVin(pcmBuf, rfhSec16Raw, vin, pcmVins) {
  let patched = writeModuleVIN(pcmBuf, 'GPEC2A', vin, pcmVins);
  if (!patched) patched = new Uint8Array(pcmBuf);
  return writePcmSec6(patched, rfhSec16Raw);
}
