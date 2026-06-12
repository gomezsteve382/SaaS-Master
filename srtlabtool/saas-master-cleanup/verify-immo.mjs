// Standalone equivalence harness — no test toolchain needed.
// Proves immoSecret.js matches (a) the existing securityBytes.deriveAllFromSec16
// and (b) the old hand-rolled loops that were copy-pasted across the codebase.
import { deriveAllFromSec16 } from '/tmp/SaaS-Master/artifacts/srt-lab/src/lib/securityBytes.js';
import {
  reverse16, pcmSec6FromRfh, pcmSec6FromBcm,
  deriveAllFromRfh, deriveAllFromBcm,
} from '/tmp/SaaS-Master/artifacts/srt-lab/src/lib/immoSecret.js';

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (a) => Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');

// old hand-rolled forms found in the codebase:
const oldReverse = (s) => { const o = new Uint8Array(16); for (let i = 0; i < 16; i++) o[i] = s[15 - i]; return o; };
const oldSec6FromRfh = (rfh) => new Uint8Array(rfh.slice(0, 6));

let n = 0, fail = 0;
const check = (name, cond, extra = '') => { n++; if (!cond) { fail++; console.error(`FAIL: ${name} ${extra}`); } };

for (let t = 0; t < 100000; t++) {
  const rfh = new Uint8Array(16);
  for (let i = 0; i < 16; i++) rfh[i] = (Math.random() * 256) | 0;
  const bcm = oldReverse(rfh);

  // new reverse16 == old loop, both directions
  check('reverse16==oldReverse(rfh)', eq(reverse16(rfh), oldReverse(rfh)));
  check('reverse16==oldReverse(bcm)', eq(reverse16(bcm), oldReverse(bcm)));
  // involution
  check('reverse is involutive', eq(reverse16(reverse16(rfh)), rfh));
  // sec6 helpers == old slice
  check('pcmSec6FromRfh==oldSlice', eq(pcmSec6FromRfh(rfh), oldSec6FromRfh(rfh)));
  check('pcmSec6FromBcm==reverse(bcm)[0:6]', eq(pcmSec6FromBcm(bcm), oldSec6FromRfh(oldReverse(bcm))));

  // deriveAll matches the existing securityBytes canonical (from RFH)
  const want = deriveAllFromSec16(rfh);
  const gotR = deriveAllFromRfh(rfh);
  check('deriveAllFromRfh.bcm', eq(gotR.bcmSec16, want.bcmSec16));
  check('deriveAllFromRfh.rfh', eq(gotR.rfhubSec16, want.rfhubSec16));
  check('deriveAllFromRfh.sec6', eq(gotR.pcmSec6, want.pcmSec6));

  // deriveAllFromBcm is the symmetric direction and stays self-consistent
  const gotB = deriveAllFromBcm(bcm);
  check('BCM-source round-trips to same RFH', eq(gotB.rfhubSec16, rfh));
  check('BCM-source same sec6 as RFH-source', eq(gotB.pcmSec6, want.pcmSec6));
}

// length guards must throw
for (const bad of [new Uint8Array(15), new Uint8Array(17), new Uint8Array(0)]) {
  let threw = false; try { reverse16(bad); } catch { threw = true; }
  check(`reverse16 rejects len ${bad.length}`, threw);
}

console.log(`checks: ${n}  failures: ${fail}`);
process.exit(fail ? 1 : 0);
