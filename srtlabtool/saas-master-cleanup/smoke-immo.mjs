// Import-and-behave smoke test for every edited module.
const base = '/tmp/SaaS-Master/artifacts/srt-lab/src/lib/';
const mods = [
  'immoSecret.js', 'securityBytes.js', 'parseModule.js', 'bcmPcmSync.js',
  'gpec2aPcmAnalyzer.js', 'rfhPcmPair.js', 'mpc5606bBcm.js',
  'keyProgWizard.js', 'liveImmo.js',
];
let bad = 0;
for (const m of mods) {
  try { await import(base + m); console.log('OK   import', m); }
  catch (e) { bad++; console.error('FAIL import', m, '->', e.message.split('\n')[0]); }
}

// behavioral: securityBytes derivation path must round-trip through the core
const { deriveAllFromSec16, writePcmSec6, writeRfhSec16FromBcm } = await import(base + 'securityBytes.js');
const { reverse16, deriveAllFromBcm } = await import(base + 'immoSecret.js');
const rfh = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
const d = deriveAllFromSec16(rfh);
const ok1 = reverse16(d.bcmSec16).every((b, i) => b === rfh[i]);          // bcm reverses back to rfh
const ok2 = deriveAllFromBcm(d.bcmSec16).pcmSec6.every((b, i) => b === d.pcmSec6[i]); // sec6 consistent
// writePcmSec6 on a 4096 canonical buffer stamps marker+sec6 from rfh[0:6]
const pcm = new Uint8Array(4096).fill(0xff);
const w = writePcmSec6(pcm, rfh);
const ok3 = w.ok && [...rfh.slice(0, 6)].every((b, i) => w.bytes[0x3C8 + i] === b)
  && [0xff, 0xff, 0xff, 0xaa].every((b, i) => w.bytes[0x3C4 + i] === b);
console.log('behavior bcm-roundtrip:', ok1, ' sec6-consistent:', ok2, ' pcmSec6-write:', ok3);
process.exit(bad === 0 && ok1 && ok2 && ok3 ? 0 : 1);
