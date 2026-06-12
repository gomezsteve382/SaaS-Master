const D = '/tmp/SaaS-Master/artifacts/srt-lab/src/lib/';
const { marryAll } = await import(D + 'marryModule.js');
const { parseModule } = await import(D + 'parseModule.js');
const { rekeyVirginBcmFromRfhub } = await import(D + 'mpc5606bBcm.js');
const { reverse16 } = await import(D + 'immoSecret.js');

const eq = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
let pass = 0, failN = 0;
const T = (n, c, e = '') => { if (c) { pass++; console.log('  OK  ' + n); } else { failN++; console.log('  FAIL ' + n + '  ' + e); } };

const ROOT = Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + 7) & 0xff);
const gpec2a = () => { const b = new Uint8Array(4096); const v = '2C3CDXBG1KH100001'; for (let i = 0; i < 17; i++) b[i] = v.charCodeAt(i); return b; };
const rfhGen2 = () => { const b = new Uint8Array(4096); b[0x500] = 0xAA; b[0x501] = 0x55; b[0x502] = 0x31; b[0x503] = 0x01; return b; };
const bcmSrc = () => rekeyVirginBcmFromRfhub(new Uint8Array(65536).fill(0xFF), ROOT).bytes;

console.log('--- 1. marry all 3 (BCM + RFHUB + PCM) ---');
let r = marryAll({ bcm: { bytes: bcmSrc() }, rfhub: { bytes: rfhGen2() }, pcm: { bytes: gpec2a() }, vin: '2C3CDXBG1KH100001' });
T('ok', r.ok, JSON.stringify(r.checks.filter(c => !c.pass)));
T('crossSync', r.crossSync);
T('2 files emitted', r.files.length === 2, 'files=' + r.files.map(f => f.name).join(','));
T('source = BCM', r.source === 'BCM');
if (r.results.rfhub?.bytes) {
  const slot = parseModule(r.results.rfhub.bytes, 're').sec16s?.[0]?.raw;
  T('  RFHUB slot1 == ROOT', slot && eq(Array.from(slot).slice(0, 16), Array.from(ROOT)));
}
if (r.results.pcm?.bytes) {
  const sec6 = parseModule(r.results.pcm.bytes, 're').pcmSec6?.raw;
  T('  PCM SEC6 == ROOT[0:6]', sec6 && eq(Array.from(sec6).slice(0, 6), Array.from(ROOT).slice(0, 6)));
}
T('  both share the BCM root (in sync)',
  r.results.rfhub && r.results.pcm
  && eq(Array.from(parseModule(r.results.rfhub.bytes).sec16s[0].raw).slice(0, 6),
        Array.from(parseModule(r.results.pcm.bytes).pcmSec6.raw).slice(0, 6)));

console.log('--- 2. only RFHUB target → 1 file ---');
r = marryAll({ bcm: { bytes: bcmSrc() }, rfhub: { bytes: rfhGen2() } });
T('ok with single target', r.ok, JSON.stringify(r.checks.filter(c => !c.pass)));
T('1 file', r.files.length === 1);

console.log('--- 3. refusals ---');
T('no BCM → bail', !marryAll({ rfhub: { bytes: rfhGen2() } }).ok);
T('no targets → bail', !marryAll({ bcm: { bytes: bcmSrc() } }).ok);
T('virgin BCM source → fail (blank secret)', !marryAll({ bcm: { bytes: new Uint8Array(65536).fill(0xFF) }, pcm: { bytes: gpec2a() } }).ok);

console.log(`\nmarryAll: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
