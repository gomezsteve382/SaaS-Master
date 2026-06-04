// Signal Discovery — candidate decoders & correlation math.
//
// Ports the TUMFTM "Holistic Approach for Automated Reverse Engineering of
// UDS Data" methodology (DOI 10.3390/wevj16070384, Apache-2.0). Pure module:
// no I/O, no React, fully unit-testable.

/* ─────────────────────── candidate decoders ─────────────────────── */

export const CANDIDATE_DECODERS = [
  { name: "u8", width: 1, signed: false, big: true },
  { name: "i8", width: 1, signed: true, big: true },
  { name: "u16BE", width: 2, signed: false, big: true },
  { name: "u16LE", width: 2, signed: false, big: false },
  { name: "i16BE", width: 2, signed: true, big: true },
  { name: "i16LE", width: 2, signed: true, big: false },
  { name: "u32BE", width: 4, signed: false, big: true },
  { name: "u32LE", width: 4, signed: false, big: false },
  { name: "i32BE", width: 4, signed: true, big: true },
  { name: "i32LE", width: 4, signed: true, big: false },
];

/**
 * Decode a slice of bytes as a numeric value. Returns NaN if the slice
 * does not fit at the requested offset.
 */
export function decodeBytes(bytes, decoder, offset) {
  const { width, signed, big } = decoder;
  if (!bytes || offset < 0 || offset + width > bytes.length) return NaN;
  let v = 0;
  if (big) {
    for (let i = 0; i < width; i++) v = (v << 8) | (bytes[offset + i] & 0xff);
  } else {
    for (let i = width - 1; i >= 0; i--) v = (v << 8) | (bytes[offset + i] & 0xff);
  }
  // Force unsigned 32-bit then sign-extend if signed. We use numeric
  // 2**N rather than bit shifts because `1 << 32` wraps to 1 in JS,
  // which would silently break the i32BE/i32LE decoders.
  v = v >>> 0;
  if (signed) {
    const range = Math.pow(2, width * 8);
    const sign = range / 2;
    if (v >= sign) v -= range;
  }
  return v;
}

/**
 * Yield every candidate (decoder, byteOffset) for a sample of the given
 * length. Used by the matcher to brute-force decode candidates.
 */
export function* enumerateCandidates(sampleLen) {
  for (const dec of CANDIDATE_DECODERS) {
    for (let off = 0; off + dec.width <= sampleLen; off++) {
      yield { decoder: dec, offset: off };
    }
  }
}

/* ────────────────────── hex helpers (testable) ──────────────────── */

export function hexToBytes(hex) {
  if (!hex) return new Uint8Array(0);
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  if (!bytes) return "";
  return Array.from(bytes)
    .map((b) => (b & 0xff).toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/* ────────────────────── correlation math ────────────────────────── */

/**
 * Pearson correlation. Returns NaN when either input has zero variance
 * (so the matcher rejects it instead of mis-labelling as r=0).
 */
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return NaN;
  return num / Math.sqrt(dx2 * dy2);
}

/**
 * Ordinary least-squares y = a*x + b. Returns null when x has zero
 * variance.
 */
export function linearRegression(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; den += dx * dx;
  }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = my - slope * mx;
  return { slope, intercept };
}

/**
 * Brute-force every (decoder × offset) candidate against a single
 * ground-truth PID series and return the best match by |r|. Returns
 * null when no candidate produced a finite correlation.
 *
 * Inputs:
 *   sampleBytes  — array of Uint8Array, one per time point
 *   groundTruth  — array of numbers (must match sampleBytes.length)
 *
 * Output is the slope/intercept that map decoded raw → ground-truth
 * units, plus the |r|² goodness-of-fit. Caller surfaces the absolute
 * sign (negative slope is fine — temperature in raw bytes can run
 * inverted to the OBD-PID).
 */
export function bestCandidate(sampleBytes, groundTruth) {
  const n = Math.min(sampleBytes.length, groundTruth.length);
  if (n < 3) return null;
  // All sample lengths should be equal in normal use; take the min so
  // a single short row doesn't crash the loop.
  let sampleLen = Infinity;
  for (let i = 0; i < n; i++) {
    sampleLen = Math.min(sampleLen, sampleBytes[i].length);
  }
  if (!Number.isFinite(sampleLen) || sampleLen === 0) return null;

  let best = null;
  const ys = groundTruth.slice(0, n);
  for (const { decoder, offset } of enumerateCandidates(sampleLen)) {
    const xs = new Array(n);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const v = decodeBytes(sampleBytes[i], decoder, offset);
      if (!Number.isFinite(v)) { ok = false; break; }
      xs[i] = v;
    }
    if (!ok) continue;
    const r = pearson(xs, ys);
    if (!Number.isFinite(r)) continue;
    const r2 = r * r;
    if (!best || r2 > best.rSquared) {
      const reg = linearRegression(xs, ys);
      best = {
        decoder: decoder.name,
        byteOffset: offset,
        r,
        rSquared: r2,
        slope: reg ? reg.slope : null,
        intercept: reg ? reg.intercept : null,
      };
    }
  }
  return best;
}
