// Byte-equivalence: does marryModule(RFH→BCM / RFH→PCM) produce the SAME bytes
// as ModuleSync's sec16-only / sync-all writer sequence? If yes, delegating
// those actions to the engine is a no-op on the output and therefore safe.
const D = '/tmp/SaaS-Master/artifacts/srt-lab/src/lib/';
const { marryModule } = await import(D + 'marryModule.js');
const { parseModule, resolveBcmSec16 } = await import(D + 'parseModule.js');
const {
  writeBcmSec16Gen2, writeBcmFlatSec16, writePcmSec6, writeRfhSec16FromBcm,
} = await import(D + 'securityBytes.js');
const { rekeyVirginBcmFromRfhub } = await import(D + 'mpc5606bBcm.js');
const { reverse16 } = await import(D + 'immoSecret.js');

const ROOT = Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + 7) & 0xff);     // RFH-form master
const OTHER = Uint8Array.from({ length: 16 }, (_, i) => (i * 7 + 200) & 0xff);    // a different existing secret
const BCMROOT = reverse16(ROOT);
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
const firstDiff = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i; return -1; };
let pass = 0, fail = 0;
const T = (n, c, e = '') => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; console.log('  FAIL ' + n + '  ' + e); } };

// RFHUB Gen2 source carrying ROOT
const rfhGen2 = () => { const b = new Uint8Array(4096); b[0x500] = 0xAA; b[0x501] = 0x55; b[0x502] = 0x31; b[0x503] = 0x01; return b; };
const rfhSrc = () => writeRfhSec16FromBcm(rfhGen2(), BCMROOT).bytes;
// GPEC2A target
const gpec2a = () => { const b = new Uint8Array(4096); const v = '2C3CDXBG1KH100001'; for (let i = 0; i < 17; i++) b[i] = v.charCodeAt(i); return b; };

// ModuleSync sec16-only BCM sequence, replicated from the real writers:
//   engWriteBcmSec16Gen2(bcm, rfhSec16)  then  chainBcmFlatRepairIfStale (= writeBcmFlatSec16 canonical)
function moduleSyncBcmWrite(bcmBytes, rfhSec16) {
  const r1 = writeBcmSec16Gen2(bcmBytes, rfhSec16);
  const resolved = resolveBcmSec16(r1.bytes);
  if (!resolved || !resolved.bytes || resolved.blank) return r1.bytes;
  const flat = writeBcmFlatSec16(r1.bytes, resolved.bytes, { mode: 'canonical' });
  return flat.bytes;
}

console.log('--- BCM target: split-record BCM (already has a different secret) ---');
{
  const bcm = rekeyVirginBcmFromRfhub(new Uint8Array(65536).fill(0xFF), OTHER).bytes; // has split records w/ OTHER
  const ms = moduleSyncBcmWrite(bcm, ROOT);
  const mm = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: bcm } });
  T('marry produced BCM bytes', mm.ok && !!mm.bytes, mm.reason || '');
  const fd = mm.bytes ? firstDiff(ms, mm.bytes) : -2;
  T('marryModule(RFH→BCM) == ModuleSync BCM write', fd === -1, fd >= 0 ? `first diff @0x${fd.toString(16)} ms=0x${ms[fd].toString(16)} mm=0x${mm.bytes[fd].toString(16)}` : '');
}

console.log('--- BCM target: virgin BCM (no records) ---');
{
  const bcm = new Uint8Array(65536).fill(0xFF);
  // ModuleSync sec16-only requires existing records; on a virgin BCM it would
  // use rekey-virgin-bcm (a separate action). marryModule auto-rekeys. Compare
  // marryModule to the canonical rekey writer used by that action.
  const msRekey = rekeyVirginBcmFromRfhub(bcm, ROOT).bytes;
  const mm = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: bcm } });
  const fd = mm.bytes ? firstDiff(msRekey, mm.bytes) : -2;
  T('marryModule(RFH→virgin BCM) == rekeyVirginBcmFromRfhub', fd === -1, fd >= 0 ? `@0x${fd.toString(16)}` : (mm.reason || ''));
}

console.log('--- PCM target: GPEC2A SEC6 ---');
{
  const pcm = gpec2a();
  const ms = writePcmSec6(pcm, ROOT).bytes;            // ModuleSync engWritePcmSec6
  const mm = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: pcm } });
  const fd = mm.bytes ? firstDiff(ms, mm.bytes) : -2;
  T('marryModule(RFH→PCM) == ModuleSync writePcmSec6', fd === -1, fd >= 0 ? `@0x${fd.toString(16)}` : (mm.reason || ''));
}

console.log(`\nequivalence: ${pass} passed, ${fail} failed`);
console.log(fail ? 'NOT byte-equivalent — delegation would change output; do NOT delegate blindly' : 'BYTE-EQUIVALENT — delegating these actions to marryModule is output-safe');
process.exit(fail ? 1 : 0);
