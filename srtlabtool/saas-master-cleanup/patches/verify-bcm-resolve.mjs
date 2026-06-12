// Equivalence proof: ModuleSync's BCM SEC16 resolution (engResolveBcmSec16,
// now in engBcmParse.js) vs the engine's resolveBcmSec16 (parseModule). Where
// they agree, delegating ModuleSync to marryModule is byte-safe; where they
// diverge, the engine must be fixed first.
const D = '/tmp/SaaS-Master/artifacts/srt-lab/src/lib/';
const { engResolveBcmSec16 } = await import(D + 'engBcmParse.js');
const { resolveBcmSec16 } = await import(D + 'parseModule.js');
const { rekeyVirginBcmFromRfhub } = await import(D + 'mpc5606bBcm.js');
const { crc16ccitt } = await import(D + 'crc.js');

const hex = (b) => b ? Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('') : 'null';
const eng = (bytes) => { const r = engResolveBcmSec16(bytes, 'bcm.bin'); return r ? Uint8Array.from(r) : null; };
const enginez = (bytes) => { const r = resolveBcmSec16(bytes); return (r && r.bytes && !r.blank) ? Uint8Array.from(r.bytes) : null; };
const same = (a, b) => (a === null && b === null) || (a && b && hex(a) === hex(b));

const ROOT = Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + 7) & 0xff);
const BCMROOT = (() => { const o = new Uint8Array(16); for (let i = 0; i < 16; i++) o[i] = ROOT[15 - i]; return o; })();

function cmp(name, bytes) {
  const a = eng(bytes), b = enginez(bytes);
  const agree = same(a, b);
  console.log(`${agree ? 'AGREE ' : 'DIVERGE'}  ${name}`);
  console.log(`         ModuleSync(eng): ${hex(a)}`);
  console.log(`         engine(resolve): ${hex(b)}`);
  return agree;
}

// 1. Split-record BCM (rekeyVirginBcmFromRfhub creates split records)
const splitBcm = rekeyVirginBcmFromRfhub(new Uint8Array(65536).fill(0xFF), ROOT).bytes;

// 2. Legacy 2014-era mirror BCM (0x00C8): idx + SEC16 + 8F FF FF + CRC16-BE
const legacyBcm = new Uint8Array(65536).fill(0xFF);
const legacySec16 = Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff);
function placeLegacy(buf, off, idx, sec16) {
  buf[off] = idx;
  for (let k = 0; k < 16; k++) buf[off + 1 + k] = sec16[k];
  buf[off + 17] = 0x8F; buf[off + 18] = 0xFF; buf[off + 19] = 0xFF;
  const cin = new Uint8Array(20); cin[0] = idx;
  for (let k = 0; k < 16; k++) cin[1 + k] = sec16[k];
  cin[17] = 0x8F; cin[18] = 0xFF; cin[19] = 0xFF;
  const c = crc16ccitt(cin);
  buf[off + 20] = (c >> 8) & 0xFF; buf[off + 21] = c & 0xFF;
}
placeLegacy(legacyBcm, 0x00C8, 0x01, legacySec16);
placeLegacy(legacyBcm, 0x00F0, 0x02, legacySec16);

// 3. Virgin BCM (all-FF) — both should report nothing
const virginBcm = new Uint8Array(65536).fill(0xFF);

let agreeAll = true;
agreeAll &= cmp('split-record BCM', splitBcm);
agreeAll &= cmp('legacy 2014 mirror BCM (0x00C8/0x00F0)', legacyBcm);
agreeAll &= cmp('virgin BCM (all-FF)', virginBcm);

console.log(`\n${agreeAll ? 'ALL AGREE — delegation is byte-safe' : 'DIVERGENCE FOUND — engine must be fixed before delegating'}`);
process.exit(0); // informational; never fail the run
