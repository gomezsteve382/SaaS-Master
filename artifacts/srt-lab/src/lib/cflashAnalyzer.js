// ECM C-Flash analyzer (Task #488).
//
// Pure functions over Uint8Array. No React, no DOM dependencies. Used by
// the CFlashTab UI plus the firmware-class branch of parseModule's
// `analyzeFile`. Tuner-signature scanning is also reused by the Dumps
// tab so a tuned firmware capture is flagged in both places.

const TUNER_SIGS = [
  { needle: bytes('DIABLO'),    label: 'DiabloSport' },
  { needle: bytes('TRINITY'),   label: 'DiabloSport Trinity' },
  { needle: bytes('PREDATOR'),  label: 'DiabloSport Predator' },
  { needle: bytes('HPTUNERS'),  label: 'HP Tuners' },
  { needle: bytes('HP TUNERS'), label: 'HP Tuners' },
  { needle: bytes('SCT'),       label: 'SCT' },
  { needle: bytes('LIVEWIRE'),  label: 'SCT Livewire' },
  { needle: bytes('COBB'),      label: 'COBB' },
  { needle: bytes('ACCESSPORT'),label: 'COBB Accessport' },
  { needle: bytes('JBA'),       label: 'JBA' },
  { needle: bytes('JET'),       label: 'JET Performance' },
];

// First eight bytes of the standard AES forward S-box. Detecting these in
// a flash image is a strong indicator that the bootloader carries an AES
// implementation — typical for GPEC2A and other Mopar PowerPC ECMs.
const AES_SBOX_HEAD = new Uint8Array([0x63,0x7C,0x77,0x7B,0xF2,0x6B,0x6F,0xC5]);

// MPC5xxx PowerPC reset vector preamble (`stwu r1,-16(r1)`-class entry
// points often start with this 4-byte pattern in Mopar flash images).
const PPC_RESET = new Uint8Array([0x00,0x5A,0x00,0x5A]);

function bytes(s){
  const out = new Uint8Array(s.length);
  for (let i=0;i<s.length;i++) out[i] = s.charCodeAt(i);
  return out;
}

function findSeq(haystack, needle, start=0, end=haystack.length){
  if (!needle.length) return -1;
  const stop = Math.min(end, haystack.length) - needle.length;
  outer: for (let i=start; i<=stop; i++){
    for (let j=0;j<needle.length;j++){
      if (haystack[i+j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Detect Mopar 68xxxxxx part-number style cal IDs (8 ASCII chars starting
// with "68"). Returns the first one found.
function findCalId(buf){
  const len = buf.length;
  for (let i=0;i<len-8;i++){
    if (buf[i] !== 0x36 || buf[i+1] !== 0x38) continue; // "68"
    let ok = true;
    for (let k=0;k<8;k++){
      const b = buf[i+k];
      const isDigit = b >= 0x30 && b <= 0x39;
      const isUpper = b >= 0x41 && b <= 0x5A;
      if (!isDigit && !isUpper) { ok = false; break; }
    }
    if (ok) return { calId: String.fromCharCode(...buf.subarray(i,i+8)), offset: i };
  }
  return null;
}

// Look for the typical "MM/DD/YY" build-date string near common offsets.
function findBuildDate(buf){
  const len = Math.min(buf.length, 0x80000);
  for (let i=0;i<len-8;i++){
    if (buf[i+2] !== 0x2F || buf[i+5] !== 0x2F) continue; // "/" / "/"
    const d0=buf[i], d1=buf[i+1], d3=buf[i+3], d4=buf[i+4], d6=buf[i+6], d7=buf[i+7];
    const isd = (b)=>b>=0x30&&b<=0x39;
    if (isd(d0)&&isd(d1)&&isd(d3)&&isd(d4)&&isd(d6)&&isd(d7)){
      return { date: String.fromCharCode(d0,d1,0x2F,d3,d4,0x2F,d6,d7), offset: i };
    }
  }
  return null;
}

function scanTunerSigs(buf){
  const hits = [];
  for (const sig of TUNER_SIGS){
    const off = findSeq(buf, sig.needle);
    if (off >= 0) hits.push({ label: sig.label, offset: off });
  }
  // Dedupe by label, keep first hit.
  const seen = new Set();
  return hits.filter(h => {
    if (seen.has(h.label)) return false;
    seen.add(h.label); return true;
  });
}

function bootloaderSig(buf){
  if (buf.length < 8) return null;
  return Array.from(buf.subarray(0,8))
    .map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
}

// Analyze a firmware-class capture (>=128 KB by default; the parseModule
// call sites already gate on size). Returns a structured record matching
// the v3 reference's `f.security` shape.
//
// Options let the caller short-circuit the AES sweep on very large
// images — the default (whole file) is fine for the 1-4 MB GPEC2A
// captures we actually flash.
export function analyzeCflash(buf, opts){
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const o = opts || {};
  const aesSearchEnd = typeof o.aesSearchEnd === 'number' ? o.aesSearchEnd : data.length;

  const isPPC = data.length >= 4 &&
    data[0] === PPC_RESET[0] && data[1] === PPC_RESET[1] &&
    data[2] === PPC_RESET[2] && data[3] === PPC_RESET[3];

  let aesSbox;
  const aesAt = findSeq(data, AES_SBOX_HEAD, 0, aesSearchEnd);
  if (aesAt >= 0) aesSbox = aesAt;

  // GPEC2A unlock-byte signature: writing 0x96 to 0x2FFFC marks the
  // image as unlocked for re-flashing. 0xFF or absent = locked.
  let unlocked;
  if (data.length > 0x2FFFC) unlocked = data[0x2FFFC] === 0x96;

  const calRec = findCalId(data);
  const dateRec = findBuildDate(data);
  const tunerSigs = scanTunerSigs(data);

  return {
    isPPC,
    aesSbox,
    unlocked,
    calId: calRec ? calRec.calId : null,
    calIdOffset: calRec ? calRec.offset : null,
    buildDate: dateRec,
    tunerSigs,
    bootloaderSig: bootloaderSig(data),
  };
}

// Plain in-memory byte diff. Used by the worker source below and by the
// vitest unit tests. Keeps the algorithm pure for easy verification.
export function diffBuffers(a, b){
  const A = a instanceof Uint8Array ? a : new Uint8Array(a);
  const B = b instanceof Uint8Array ? b : new Uint8Array(b);
  const len = Math.min(A.length, B.length);
  let totalDiffs = 0;
  let firstDiff = -1;
  let lastDiff = -1;
  const blocks = [];
  let inDiff = false;
  let diffStart = 0;
  for (let i=0;i<len;i++){
    if (A[i] !== B[i]){
      totalDiffs++;
      if (firstDiff < 0) firstDiff = i;
      lastDiff = i;
      if (!inDiff){ inDiff = true; diffStart = i; }
    } else if (inDiff){
      blocks.push({ start: diffStart, end: i });
      inDiff = false;
    }
  }
  if (inDiff) blocks.push({ start: diffStart, end: len });
  return { totalDiffs, firstDiff, lastDiff, blocks, sizeA: A.length, sizeB: B.length, len };
}

// Source for an inline Web Worker that runs `diffBuffers` off the main
// thread. The CFlashTab spins up a worker via `Blob` URL so 4 MB × 4 MB
// diffs do not freeze the React render loop.
export const DIFF_WORKER_SOURCE = `
self.onmessage = function(ev){
  var A = new Uint8Array(ev.data.a);
  var B = new Uint8Array(ev.data.b);
  var len = A.length < B.length ? A.length : B.length;
  var totalDiffs = 0, firstDiff = -1, lastDiff = -1;
  var blocks = [];
  var inDiff = false, diffStart = 0;
  for (var i=0; i<len; i++){
    if (A[i] !== B[i]){
      totalDiffs++;
      if (firstDiff < 0) firstDiff = i;
      lastDiff = i;
      if (!inDiff){ inDiff = true; diffStart = i; }
    } else if (inDiff){
      blocks.push({start:diffStart,end:i});
      inDiff = false;
    }
  }
  if (inDiff) blocks.push({start:diffStart,end:len});
  self.postMessage({ totalDiffs:totalDiffs, firstDiff:firstDiff, lastDiff:lastDiff,
                     blocks:blocks, sizeA:A.length, sizeB:B.length, len:len });
};
`;

export function runDiffInWorker(a, b){
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL){
    return Promise.resolve(diffBuffers(a, b));
  }
  return new Promise((resolve, reject) => {
    let url;
    try {
      const blob = new Blob([DIFF_WORKER_SOURCE], { type: 'application/javascript' });
      url = URL.createObjectURL(blob);
      const w = new Worker(url);
      w.onmessage = (ev) => {
        try { URL.revokeObjectURL(url); } catch {}
        w.terminate();
        resolve(ev.data);
      };
      w.onerror = (err) => {
        try { URL.revokeObjectURL(url); } catch {}
        w.terminate();
        // Fall back to in-thread diff so the UI still gets a result.
        try { resolve(diffBuffers(a, b)); } catch (e) { reject(err || e); }
      };
      const aBuf = a instanceof Uint8Array ? a.buffer : a;
      const bBuf = b instanceof Uint8Array ? b.buffer : b;
      w.postMessage({ a: aBuf, b: bBuf });
    } catch (err) {
      if (url) try { URL.revokeObjectURL(url); } catch {}
      try { resolve(diffBuffers(a, b)); } catch (e) { reject(err || e); }
    }
  });
}

export { TUNER_SIGS, scanTunerSigs };
