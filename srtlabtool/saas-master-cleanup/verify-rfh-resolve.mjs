// Does ModuleSync's RFH master (engParseRfh.sec16.slot1) match the engine's
// RFHUB resolution (parseModule sec16s[0] / vehicleSecret)? Delegating the
// RFH-source sync actions is only safe where they agree.
const D = '/tmp/SaaS-Master/artifacts/srt-lab/src/lib/';
const { parseModule } = await import(D + 'parseModule.js');
const hex = (b) => (b ? Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('') : 'null');

// engParseRfh's master-secret resolution (slot1), replicated verbatim
function engRfhSlot1(bytes) {
  const gen2Hdr = bytes[0x0500] === 0xAA && bytes[0x0501] === 0x55 && bytes[0x0502] === 0x31 && bytes[0x0503] === 0x01;
  const gen2BySize = bytes.length === 4096 || bytes.length === 8192;
  if ((gen2Hdr || gen2BySize) && bytes.length >= 0x0532) return bytes.slice(0x050E, 0x051E);
  if (bytes.length >= 0x00D0) return bytes.slice(0x00AE, 0x00BE);
  return null;
}
function engineRfhSlot1(bytes) {
  const info = parseModule(bytes, 'rfh');
  return info?.sec16s?.[0]?.raw || info?.vehicleSecret?.bytes || null;
}
const same = (a, b) => (a == null && b == null) || (a && b && hex(Uint8Array.from(a)) === hex(Uint8Array.from(b)));

const SECRET = Uint8Array.from({ length: 16 }, (_, i) => (i * 13 + 5) & 0xff);

function cmp(name, bytes) {
  const a = engRfhSlot1(bytes), b = engineRfhSlot1(bytes);
  const ok = same(a, b);
  console.log(`${ok ? 'AGREE ' : 'DIVERGE'}  ${name}`);
  console.log(`         ModuleSync(engParseRfh): ${hex(a)}`);
  console.log(`         engine(parseModule)    : ${hex(b)}`);
  return ok;
}

// Gen2 (4096, AA5531 banner, secret @0x050E)
const gen2 = new Uint8Array(4096);
gen2[0x500] = 0xAA; gen2[0x501] = 0x55; gen2[0x502] = 0x31; gen2[0x503] = 0x01;
gen2.set(SECRET, 0x050E); gen2.set(SECRET, 0x0522);

// Gen2-EEE (4096, NON-canonical banner FF FF 00 00, secret @0x050E)
const eee = new Uint8Array(4096);
eee[0x500] = 0xFF; eee[0x501] = 0xFF; eee[0x502] = 0x00; eee[0x503] = 0x00;
eee.set(SECRET, 0x050E); eee.set(SECRET, 0x0522);

// Gen1 (2048) — put the secret at BOTH candidate offsets so we isolate WHERE each reads
const gen1Both = new Uint8Array(2048);
gen1Both.set(SECRET, 0x00AE);   // parseModule's offset
gen1Both.set(SECRET, 0x0226);   // engParseRfh's offset

// Gen1 with secret ONLY at engParseRfh's 0x0226
const gen1_0226 = new Uint8Array(2048);
gen1_0226.set(SECRET, 0x0226);

// Gen1 with secret ONLY at parseModule's 0x00AE
const gen1_00AE = new Uint8Array(2048);
gen1_00AE.set(SECRET, 0x00AE);

let agreeAll = true;
agreeAll &= cmp('Gen2 (canonical banner)', gen2);
agreeAll &= cmp('Gen2-EEE (non-canonical banner)', eee);
agreeAll &= cmp('Gen1 (secret at BOTH offsets)', gen1Both);
agreeAll &= cmp('Gen1 (secret only @0x0226 — engParseRfh)', gen1_0226);
agreeAll &= cmp('Gen1 (secret only @0x00AE — parseModule)', gen1_00AE);

console.log(`\n${agreeAll ? 'ALL AGREE' : 'DIVERGENCE — Gen1 offset differs; Gen1 RFH-master delegation is NOT safe'}`);
process.exit(0);
