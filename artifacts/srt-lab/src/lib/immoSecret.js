/* immoSecret.js — SINGLE SOURCE OF TRUTH for the immobilizer-secret byte
 * relationships across BCM / RFHUB / PCM.
 *
 * This is a LEAF module: it imports nothing, so it can be imported anywhere
 * (parseModule, securityBytes, keyProgWizard, the analyzers, the UI) with zero
 * risk of an import cycle. Every place that needs to turn one module's secret
 * into another module's secret MUST call these helpers instead of hand-rolling
 * the byte loop — that hand-rolled loop was previously copy-pasted in 7+ files,
 * which is the "preview/writer gating drift" bug class the project keeps hitting.
 *
 * The ground-truth relationships (see .agents/memory/module-sync-source-of-truth.md):
 *   - The 16-byte SEC16 secret is stored byte-REVERSED between BCM and RFHUB.
 *       BCM SEC16 = reverse(RFH SEC16)   and   RFH SEC16 = reverse(BCM SEC16)
 *     Reversal is its own inverse, so both directions are the *same* operation.
 *   - The PCM (GPEC2A) immobilizer secret is the first 6 bytes of the RFH form:
 *       PCM SEC6 = RFH_SEC16[0:6] = reverse(BCM_SEC16)[0:6]
 *
 * All helpers return a fresh Uint8Array and never mutate their input.
 */

/** Number of bytes in a SEC16 immobilizer secret. */
export const SEC16_LEN = 16;
/** Number of bytes in a PCM (GPEC2A) SEC6 immobilizer secret. */
export const SEC6_LEN = 6;

function toBytes(v, who) {
  if (v == null) throw new Error(`${who}: secret is null/undefined`);
  // Accept Uint8Array, Array, or anything array-like of byte values.
  const out = v instanceof Uint8Array ? v : Uint8Array.from(v);
  return out;
}

/**
 * Reverse a 16-byte SEC16 secret. This is the BCM<->RFH transform in BOTH
 * directions (reversal is an involution). Throws unless the input is exactly
 * 16 bytes, so a truncated/oversized buffer can never silently produce a
 * wrong-length secret that downstream writers would stamp into a module.
 *
 * @param {Uint8Array|number[]} sec16 exactly 16 bytes
 * @returns {Uint8Array} a new 16-byte reversed copy
 */
export function reverse16(sec16) {
  const b = toBytes(sec16, 'reverse16');
  if (b.length !== SEC16_LEN) {
    throw new Error(`reverse16: expected ${SEC16_LEN} bytes, got ${b.length}`);
  }
  const out = new Uint8Array(SEC16_LEN);
  for (let i = 0; i < SEC16_LEN; i++) out[i] = b[SEC16_LEN - 1 - i];
  return out;
}

/** BCM SEC16 from RFH SEC16. Alias of {@link reverse16}. */
export const bcmSec16FromRfh = reverse16;

/** RFH SEC16 from BCM SEC16. Alias of {@link reverse16} (same operation). */
export const rfhSec16FromBcm = reverse16;

/**
 * PCM SEC6 from an RFH-form SEC16: the first 6 bytes.
 * @param {Uint8Array|number[]} rfhSec16 at least 6 bytes (16 in practice)
 * @returns {Uint8Array} a new 6-byte copy
 */
export function pcmSec6FromRfh(rfhSec16) {
  const b = toBytes(rfhSec16, 'pcmSec6FromRfh');
  if (b.length < SEC6_LEN) {
    throw new Error(`pcmSec6FromRfh: need at least ${SEC6_LEN} bytes, got ${b.length}`);
  }
  return new Uint8Array(b.slice(0, SEC6_LEN));
}

/**
 * PCM SEC6 from a BCM-form SEC16: reverse to RFH form, then take 6 bytes.
 * @param {Uint8Array|number[]} bcmSec16 exactly 16 bytes
 * @returns {Uint8Array} a new 6-byte copy
 */
export function pcmSec6FromBcm(bcmSec16) {
  return pcmSec6FromRfh(reverse16(bcmSec16));
}

/**
 * Derive every dependent secret from the authoritative RFH-form SEC16.
 * Kept for back-compat with securityBytes.deriveAllFromSec16.
 * @param {Uint8Array|number[]} rfhSec16 exactly 16 bytes
 * @returns {{ bcmSec16: Uint8Array, rfhubSec16: Uint8Array, pcmSec6: Uint8Array }}
 */
export function deriveAllFromRfh(rfhSec16) {
  const b = toBytes(rfhSec16, 'deriveAllFromRfh');
  if (b.length !== SEC16_LEN) {
    throw new Error(`deriveAllFromRfh: rfhSec16 must be exactly ${SEC16_LEN} bytes`);
  }
  return {
    bcmSec16: reverse16(b),
    rfhubSec16: new Uint8Array(b),
    pcmSec6: pcmSec6FromRfh(b),
  };
}

/**
 * Derive every dependent secret from the authoritative BCM-form SEC16.
 * This is the direction your bench workflow actually uses: a married BCM is the
 * source of truth, and an unmarried RFHUB/PCM gets re-derived to join the set.
 * @param {Uint8Array|number[]} bcmSec16 exactly 16 bytes
 * @returns {{ bcmSec16: Uint8Array, rfhubSec16: Uint8Array, pcmSec6: Uint8Array }}
 */
export function deriveAllFromBcm(bcmSec16) {
  const b = toBytes(bcmSec16, 'deriveAllFromBcm');
  if (b.length !== SEC16_LEN) {
    throw new Error(`deriveAllFromBcm: bcmSec16 must be exactly ${SEC16_LEN} bytes`);
  }
  return {
    bcmSec16: new Uint8Array(b),
    rfhubSec16: reverse16(b),
    pcmSec6: pcmSec6FromBcm(b),
  };
}
