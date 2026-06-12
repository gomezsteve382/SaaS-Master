// End-to-end test of marryModule against fixtures built with the real writers.
const D = '/tmp/SaaS-Master/artifacts/srt-lab/src/lib/';
const { marryModule } = await import(D + 'marryModule.js');
const { parseModule, resolveBcmSec16 } = await import(D + 'parseModule.js');
const { writeRfhSec16FromBcm } = await import(D + 'securityBytes.js');
const { rekeyVirginBcmFromRfhub } = await import(D + 'mpc5606bBcm.js');
const { reverse16 } = await import(D + 'immoSecret.js');

const eq = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
let pass = 0, failN = 0;
const T = (name, cond, extra = '') => { if (cond) { pass++; console.log('  OK  ' + name); } else { failN++; console.log('  FAIL ' + name + '  ' + extra); } };

const ROOT = Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + 7) & 0xff); // RFH-form root
const BCMROOT = reverse16(ROOT);

// ---- build a GPEC2A target (4096, VIN at offset 0 so parseModule detects GPEC2A) ----
function gpec2a(fill = 0x00) {
  const b = new Uint8Array(4096).fill(fill);
  const vin = '2C3CDXBG1KH100001';
  for (let i = 0; i < 17; i++) b[i] = vin.charCodeAt(i);
  return b;
}
// ---- build an RFHUB Gen2 target (4096, AA5531 header @0x500, non-VIN first bytes) ----
function rfhGen2() {
  const b = new Uint8Array(4096).fill(0x00);
  b[0x500] = 0xAA; b[0x501] = 0x55; b[0x502] = 0x31; b[0x503] = 0x01;
  return b;
}

console.log('--- source detection sanity ---');
const rfhSrc = writeRfhSec16FromBcm(rfhGen2(), BCMROOT).bytes; // RFHUB carrying ROOT
const srcInfo = parseModule(rfhSrc, 'src');
T('RFHUB source parses as RFHUB', srcInfo.type === 'RFHUB', 'got ' + srcInfo.type);

console.log('--- 1. marry GPEC2A PCM from RFHUB source ---');
let r = marryModule({ source: { bytes: rfhSrc }, target: { bytes: gpec2a() } });
T('marry GPEC2A ok', r.ok, JSON.stringify(r.checks?.filter(c => !c.pass)));
T('  op = pcm-sec6', r.op === 'pcm-sec6');
T('  verified true', r.verified);
T('  grounding bench', r.grounding?.level === 'bench-verified', r.grounding?.level);
if (r.bytes) {
  const re = parseModule(r.bytes, 're');
  const sec6 = re.pcmSec6?.raw;
  T('  PCM SEC6 == root[0:6]', sec6 && eq(Array.from(sec6).slice(0, 6), Array.from(ROOT).slice(0, 6)), sec6 && Array.from(sec6).slice(0,6).join(','));
}

console.log('--- 2. marry RFHUB Gen2 from RFHUB source ---');
r = marryModule({ source: { bytes: rfhSrc }, target: { bytes: rfhGen2() } });
T('marry RFHUB ok', r.ok, JSON.stringify(r.checks?.filter(c => !c.pass)));
T('  verified true', r.verified);
if (r.bytes) {
  const slot = parseModule(r.bytes, 're').sec16s?.[0]?.raw;
  T('  RFH slot1 == root', slot && eq(Array.from(slot).slice(0, 16), Array.from(ROOT)));
}

console.log('--- 3. refuse blank source ---');
r = marryModule({ source: { bytes: rfhGen2() }, target: { bytes: gpec2a() } }); // rfhGen2() has no secret
T('blank source refused', !r.ok && /blank|virgin|absent|usable/i.test(r.reason || ''), r.reason);

console.log('--- 4. unverified target (Gen1, 2048) gate ---');
const gen1 = new Uint8Array(2048).fill(0x00);
r = marryModule({ source: { bytes: rfhSrc }, target: { bytes: gen1, info: { type: 'RFHUB' } } });
T('Gen1 refused without allowUnverifiedTarget', !r.ok && /unverified|allowUnverifiedTarget/i.test(r.reason || ''), r.reason);
r = marryModule({ source: { bytes: rfhSrc }, target: { bytes: gen1, info: { type: 'RFHUB' } }, allowUnverifiedTarget: true });
T('Gen1 attempted with opt-in (writer ran)', r.op === 'rfh-gen1-sec16' && r.writer === 'writeRfhSec16Gen1');

console.log('--- 5. BCM-as-source (your bench case) marry into GPEC2A ---');
let bcmSrc;
try {
  bcmSrc = rekeyVirginBcmFromRfhub(new Uint8Array(65536).fill(0xFF), ROOT).bytes;
} catch (e) { bcmSrc = null; console.log('  (rekeyVirginBcmFromRfhub:', e.message, ')'); }
if (bcmSrc) {
  const bi = parseModule(bcmSrc, 'bcmsrc');
  const rb = resolveBcmSec16(bcmSrc);
  T('BCM source resolves SEC16 == reverse(root)', rb?.bytes && eq(Array.from(rb.bytes), Array.from(BCMROOT)), rb?.source);
  r = marryModule({ source: { bytes: bcmSrc, info: bi }, target: { bytes: gpec2a() } });
  T('marry GPEC2A from BCM source ok', r.ok, JSON.stringify(r.checks?.filter(c => !c.pass)));
}

console.log(`\nmarryModule: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
