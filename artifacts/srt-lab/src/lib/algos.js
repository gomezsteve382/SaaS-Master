const u32=n=>n>>>0;
function sxor(s,c){let k=u32(s);for(let i=0;i<5;i++)k=k&0x80000000?u32((k<<1)^u32(c)):u32(k<<1);return k;}
function cda6(s){let k=u32(s);k=u32(k^0x4B129F);k=u32((k<<3)|(k>>>29));k=u32(k+0x1234);k=u32(k^0xABCD);return u32((k>>>5)|(k<<27));}
const NT=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31],NS=[0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
function ngc(s){let k=0;for(let i=0;i<4;i++){let b=(u32(s)>>(i*8))&0xFF;k=u32(k^u32(((NT[b&0xF]^NT[(b>>4)&0xF])*NS[i%8])&0xFFFFFFFF));}return k;}
const TT={a:[0x727B,0xB301,0x08EB,0xB0BA,0xECA7,0x0ECC,0xD69A,0xE47E],b:[0x7A44,0x0201,0xF123,0x146E,0xCBC2,0x553F,0xD398,0x4EDC],c:[0x22B5,0x5767,0x4C5A,0xE443,0xC606,0x7544,0x0DFB,0x36D6],d:[0x632A,0x193B,0x914F,0x0F88,0x5E51,0x8DCD,0xDD6C,0x00DD]},TM=[0xBAEE,0xE000,0x1C00,0x0380,0x0070,0x0007];
function tipm(s,t='a'){const tb=TT[t]||TT.a;let v=s&0xFFFF,k=0;for(let i=0;i<tb.length;i++){let m=v&TM[i%TM.length],b=0,x=m;while(x){b^=x&1;x>>=1;}k=(k<<1)|b;k^=tb[i];k&=0xFFFF;}return k;}

// ─── SGW XTEA ─────────────────────────────────────────────────────────────
// Key extracted from CDA.swf constant pool @ 0x24664A. Stored in the SWF as
// two 16-char ASCII-hex strings ("BC474048A33B483A" + "6368727973313372"),
// hex-decoded into a 16-byte (128-bit) XTEA key. Algorithm class is
// com.hurlant.crypto.symmetric.XTeaKey @ 0x22ca32 (NUM_ROUNDS=32, standard
// delta 0x9E3779B9). See docs/SGW_XTEA_ALGORITHM.md for the full extraction
// notes and worked example.
const SGW_XTEA_KEY=[0xBC474048,0xA33B483A,0x63687279,0x73313372];
const XTEA_DELTA=0x9E3779B9, XTEA_ROUNDS=32;
function xteaEncryptBlock(v0,v1,k){
  v0=u32(v0); v1=u32(v1); let sum=0;
  for(let i=0;i<XTEA_ROUNDS;i++){
    v0=u32(v0+((((v1<<4)^(v1>>>5))>>>0)+v1^(sum+k[sum&3])));
    sum=u32(sum+XTEA_DELTA);
    v1=u32(v1+((((v0<<4)^(v0>>>5))>>>0)+v0^(sum+k[(sum>>>11)&3])));
  }
  return [u32(v0),u32(v1)];
}
function xteaDecryptBlock(v0,v1,k){
  v0=u32(v0); v1=u32(v1); let sum=u32(XTEA_DELTA*XTEA_ROUNDS);
  for(let i=0;i<XTEA_ROUNDS;i++){
    v1=u32(v1-((((v0<<4)^(v0>>>5))>>>0)+v0^(sum+k[(sum>>>11)&3])));
    sum=u32(sum-XTEA_DELTA);
    v0=u32(v0-((((v1<<4)^(v1>>>5))>>>0)+v1^(sum+k[sum&3])));
  }
  return [u32(v0),u32(v1)];
}
// Seed → key transform for SGW security access (UDS 27 01/02). The 4-byte
// seed is loaded into v0; v1 is initialized to the seed-complement so a
// zero seed never collapses to a zero block. The high word of the encrypted
// XTEA block is returned as the 4-byte key, matching the existing 4-byte
// 27-02 framing used by the rest of the unlock flow. Full 8-byte response
// available via xtea_sgw_full() when the SGW is configured for an 8-byte key.
function xtea_sgw(seed){
  const s=u32(seed);
  const [c0]=xteaEncryptBlock(s,u32(~s),SGW_XTEA_KEY);
  return c0;
}
function xtea_sgw_full(seed){
  const s=u32(seed);
  return xteaEncryptBlock(s,u32(~s),SGW_XTEA_KEY);
}

// ─── AlfaOBD seed-key primitives ──────────────────────────────────────────
// Reverse-engineered from AlfaOBD.exe's inner .NET assembly (Dotfuscator-
// obfuscated). Three standalone methods plus a parameterized linear core
// that 380 per-ECU wrappers reduce to. Reference port:
// attached_assets/alfaobd_seedkey_1776573875649.{js,py}.
//
// IMPORTANT — NON-STANDARD XTEA CONSTANTS:
// ALFA_XTEA_KEY/DELTA below are AlfaOBD's own values, lifted from the .NET
// IL of `ad::f` and `ad::ao`. They are intentionally distinct from the
// SGW_XTEA_KEY / 0x9E3779B9 used by the FCA Secure Gateway above — do NOT
// collapse the two into one shared XTEA primitive. SGW XTEA = CDA.swf
// extraction (32 rounds, standard delta). AlfaOBD XTEA = .NET extraction
// (64 rounds, custom delta 0x8F750A1D, distinct 4-word key).
const ALFA_XTEA_KEY=[0x9B127D51,0x5BA41903,0x4FE87269,0x6BC361D8];
const ALFA_XTEA_DELTA=0x8F750A1D, ALFA_XTEA_ROUNDS=64;
function alfaXtea64(v1,v8){
  v1=u32(v1); v8=u32(v8); let sum=0;
  for(let i=0;i<ALFA_XTEA_ROUNDS;i++){
    const inner1=u32(u32((v8<<4)^(v8>>>5))+v8);
    v1=u32(v1+u32(inner1^u32(sum+ALFA_XTEA_KEY[sum&3])));
    sum=u32(sum+ALFA_XTEA_DELTA);
    const inner2=u32(u32((v1<<4)^(v1>>>5))+v1);
    v8=u32(v8+u32(inner2^u32(sum+ALFA_XTEA_KEY[(sum>>>11)&3])));
  }
  return [u32(v1),u32(v8)];
}

// w6: parameterized linear cipher. Each per-ECU wrapper reduces to a
// (r, s) constant pair. 380 catalogued wrappers live in
// AOBD_W6 (alfaobdAlgorithms.generated.js). Input is the 4 raw seed
// bytes (Uint8Array | number[] | tuple), output is a Uint8Array(4).
function alfaW6(seedBytes,r,s){
  const sb=Array.from(seedBytes||[]);
  if(sb.length<4) throw new Error('alfaW6: seed must be at least 4 bytes');
  const s0=sb[0]&0xFF,s1=sb[1]&0xFF,s2=sb[2]&0xFF,s3=sb[3]&0xFF;
  const v0=u32((s0<<24)|(s1<<16)|(s2<<8)|s3);
  let v1=u32((s1<<24)|(s0<<16)|(s3<<8)|s2);
  v1=u32((v1<<11)|(v1>>>22));
  const v2=u32(s&v0);
  v1=u32(v1^u32(r)^v2);
  return new Uint8Array([(v1>>>24)&0xFF,(v1>>>16)&0xFF,(v1>>>8)&0xFF,v1&0xFF]);
}

// ht is literally w6 with AlfaOBD's hard-coded (0x41AA42BB, 0x22BA9A31).
// We define it as such on purpose so the equivalence is visible in the
// source rather than buried in a comment. Verified byte-for-byte against
// the reference Python impl in algos.alfaobd.test.mjs.
function alfaHt(seedBytes){ return alfaW6(seedBytes,0x41AA42BB,0x22BA9A31); }

// f: AlfaOBD XTEA, seed packed LITTLE-ENDIAN. Triggered when
// af::ix=true && af::ge=51 && af::aj=5.
function alfaF(seedBytes){
  const sb=Array.from(seedBytes||[]);
  if(sb.length<4) throw new Error('alfaF: seed must be at least 4 bytes');
  const v1Init=u32((sb[3]<<24)|(sb[2]<<16)|(sb[1]<<8)|sb[0]);
  const [v1]=alfaXtea64(v1Init,0);
  return new Uint8Array([(v1>>>24)&0xFF,(v1>>>16)&0xFF,(v1>>>8)&0xFF,v1&0xFF]);
}

// ao: AlfaOBD XTEA, seed packed BIG-ENDIAN. Triggered for UCONNECT
// (eEcutype 0x149) and RADIO_FGA (0x14E) at security access level 5.
// Wired into UNLOCK_FALLBACK so any 0x67 01 → 4-byte seed on a body-bus
// CAN ID retries with this transform after CDA6/GPEC fail.
function alfaAo(seedBytes){
  const sb=Array.from(seedBytes||[]);
  if(sb.length<4) throw new Error('alfaAo: seed must be at least 4 bytes');
  const v1Init=u32((sb[0]<<24)|(sb[1]<<16)|(sb[2]<<8)|sb[3]);
  const [v1]=alfaXtea64(v1Init,0);
  return new Uint8Array([(v1>>>24)&0xFF,(v1>>>16)&0xFF,(v1>>>8)&0xFF,v1&0xFF]);
}

// Lookup wrapper by name from the catalog. Lazy-imported so the 31KB
// generated module isn't pulled into the algos.js import graph for
// callers that only need the SGW XTEA bits.
import { AOBD_W6 } from "./alfaobdAlgorithms.generated.js";
function alfaW6By(seedBytes,name){
  const rs=AOBD_W6[name];
  if(!rs) return null;
  return alfaW6(seedBytes,rs[0],rs[1]);
}

// Helper for the seed-key picker: takes a u32 seed (so it slots into
// the existing ALGOS.fn(seed) signature) and returns a u32 key.
function _seedU32ToBytes(s){
  s=u32(s);
  return [(s>>>24)&0xFF,(s>>>16)&0xFF,(s>>>8)&0xFF,s&0xFF];
}
function _bytesToU32(b){ return u32((b[0]<<24)|(b[1]<<16)|(b[2]<<8)|b[3]); }
function alfaHtU32(seed){ return _bytesToU32(alfaHt(_seedU32ToBytes(seed))); }
function alfaFU32(seed){ return _bytesToU32(alfaF(_seedU32ToBytes(seed))); }
function alfaAoU32(seed){ return _bytesToU32(alfaAo(_seedU32ToBytes(seed))); }
function alfaW6ByU32(name){
  return (seed)=>{
    const k=alfaW6By(_seedU32ToBytes(seed),name);
    return k?_bytesToU32(k):0;
  };
}

const ALGOS=[
  {id:'gpec1',n:'GPEC1',h:'670269',fn:s=>sxor(s,670269)},
  {id:'gpec2',n:'GPEC2',h:'Continental',fn:s=>sxor(s,0xE72E3799)},
  {id:'gpec2f',n:'GPEC2 Flash',h:'Flash',fn:s=>sxor(s,0x966AEEB1)},
  {id:'gpec2e',n:'GPEC2 EPROM',h:'EPROM',fn:s=>sxor(s,0x3F711F5A)},
  {id:'gpec3',n:'GPEC3',h:'2018+',fn:s=>sxor(s,0x129D657F)},
  {id:'gpec2a',n:'GPEC2A',h:'GPEC2A',fn:s=>sxor(s,0xCE853A6F)},
  {id:'gpec15',n:'GPEC2 2015',h:'2015-18',fn:s=>sxor(s,0x47EC21F8)},
  {id:'ngc',n:'NGC',h:'DAIMLERCHRYSLER',fn:s=>ngc(s)},
  {id:'jtec',n:'JTEC',h:'Fixed 0000',fn:()=>0},
  {id:'sbec',n:'SBEC (legacy)',h:'(seed*4)+0x9018',fn:s=>u32(s*4+0x9018)},
  {id:'cda6',n:'CDA6',h:'BCM/ABS/IPC',fn:s=>cda6(s)},
  {id:'xtea_sgw',n:'SGW (XTEA)',h:'2018+ Secure Gateway (CDA.swf)',fn:s=>xtea_sgw(s)},
  {id:'t80',n:'TIPM 0x80',h:'t8001',fn:s=>tipm(s,'a')},
  {id:'t36',n:'TIPM 0x36',h:'t3605',fn:s=>tipm(s,'b')},
  {id:'t81',n:'TIPM 0x81',h:'t8101',fn:s=>tipm(s,'c')},
  {id:'t3c',n:'TIPM 0x3C',h:'t3c',fn:s=>tipm(s,'d')},
  // ── AlfaOBD seed-key family (RE'd from AlfaOBD.exe .NET IL) ──
  {id:'alfa_ht',n:'AlfaOBD ht',h:'w6(0x41AA42BB,0x22BA9A31)',fn:alfaHtU32},
  {id:'alfa_f', n:'AlfaOBD f',  h:'XTEA64 LE seed',           fn:alfaFU32},
  {id:'alfa_ao',n:'AlfaOBD ao', h:'XTEA64 BE — UCONNECT/RADIO_FGA L5',fn:alfaAoU32},
  // Directly-hittable w6 family wrappers (per AOBD_DISPATCH). The other
  // dispatcher rows resolve to w7 wrappers whose cipher core is not yet
  // ported; they are surfaced as parameter rows in the SeedTab w7 panel.
  {id:'alfa_w6_tt',n:'AlfaOBD w6/tt',h:'family 27 / level 5',fn:alfaW6ByU32('tt')},
  {id:'alfa_w6_tu',n:'AlfaOBD w6/tu',h:'family 27 / level 3',fn:alfaW6ByU32('tu')},
  {id:'alfa_w6_tv',n:'AlfaOBD w6/tv',h:'family 27 / level 1',fn:alfaW6ByU32('tv')},
  {id:'alfa_w6_ez',n:'AlfaOBD w6/ez',h:'family 66 / level 3',fn:alfaW6ByU32('ez')},
  // Catch-all picker entry: SeedTab special-cases this id and shows
  // (a) a wrapper-name input (auto-resolves through AOBD_W6) and
  // (b) a manual (r, s) hex input pair so the operator can try any of
  // the 380 catalogued wrappers, or even a bench-derived (r, s) that
  // hasn't been catalogued yet, without polluting the picker grid.
  // The bare `fn` returns 0; the SeedTab interaction is the source of
  // truth for what gets computed.
  {id:'alfa_w6_custom',n:'AlfaOBD w6 (custom)',h:'wrapper name or manual (r, s)',fn:()=>0,custom:'alfa_w6'},
];

// Look up an unlock algorithm by the id used in MODULE_TARGETS.unlock.
// Returns a u32 key for the given u32 seed, or null if the id is unknown.
// Prefer unlockKeyBytes for AlfaOBD primitives — those care about byte
// order and round-tripping through u32 silently corrupts `alfa_f`.
function unlockKey(unlockId, seedU32){
  if(unlockId==='xtea_sgw') return xtea_sgw(seedU32);
  if(unlockId==='cda6'||!unlockId) return cda6(seedU32);
  if(unlockId==='alfa_ht') return alfaHtU32(seedU32);
  if(unlockId==='alfa_f')  return alfaFU32(seedU32);
  if(unlockId==='alfa_ao') return alfaAoU32(seedU32);
  if(unlockId && unlockId.startsWith('alfa_w6/')){
    const fn=alfaW6ByU32(unlockId.slice('alfa_w6/'.length));
    return fn(seedU32);
  }
  const a=ALGOS.find(x=>x.id===unlockId);
  return a?u32(a.fn(seedU32)):null;
}

// Byte-oriented unlock: takes the raw seed bytes from the UDS 67 01 response
// and returns the key bytes to send back in 27 02. For SGW XTEA, when the
// gateway hands us an 8-byte seed we feed both halves into XTEA and return
// the full 8-byte ciphertext block; legacy 4-byte SGW seeds keep the existing
// 4-byte response. All other algorithms remain 4-byte in / 4-byte out.
// Returns null on unknown algorithm or insufficient seed bytes.
function unlockKeyBytes(unlockId, seedBytes){
  const sb=Array.from(seedBytes||[]);
  if(sb.length<4) return null;
  if(unlockId==='xtea_sgw' && sb.length>=8){
    const v0=u32((sb[0]<<24)|(sb[1]<<16)|(sb[2]<<8)|sb[3]);
    const v1=u32((sb[4]<<24)|(sb[5]<<16)|(sb[6]<<8)|sb[7]);
    const [c0,c1]=xteaEncryptBlock(v0,v1,SGW_XTEA_KEY);
    return [(c0>>>24)&0xFF,(c0>>>16)&0xFF,(c0>>>8)&0xFF,c0&0xFF,
            (c1>>>24)&0xFF,(c1>>>16)&0xFF,(c1>>>8)&0xFF,c1&0xFF];
  }
  // AlfaOBD primitives are byte-native — bypass the u32 round-trip so we
  // don't accidentally swap LE/BE seed framing for `f` vs `ao`.
  if(unlockId==='alfa_ht'){ const k=alfaHt(sb); return Array.from(k); }
  if(unlockId==='alfa_f'){  const k=alfaF(sb);  return Array.from(k); }
  if(unlockId==='alfa_ao'){ const k=alfaAo(sb); return Array.from(k); }
  if(unlockId && unlockId.startsWith('alfa_w6/')){
    const name=unlockId.slice('alfa_w6/'.length);
    const k=alfaW6By(sb,name);
    return k?Array.from(k):null;
  }
  let sv=0;for(let i=0;i<4;i++)sv=(sv<<8)|sb[i];sv=u32(sv);
  const k=unlockKey(unlockId,sv);
  if(k===null) return null;
  return [(k>>>24)&0xFF,(k>>>16)&0xFF,(k>>>8)&0xFF,k&0xFF];
}

// Pick the unlock algorithm id based on the UDS tx address. The 2018+ FCA
// Secure Gateway lives at 0x74F/0x76F and uses XTEA; everything else on the
// CDA6 bus continues to use the legacy CDA6 transform.
function unlockIdForTx(tx){
  return tx===0x74F?'xtea_sgw':'cda6';
}

// Per-module preferred unlock algorithm by scan code (MODS[].c). Powertrain
// modules (ECM/TCM/DAMP/ADCM) historically use the GPEC2 sxor-0xE72E3799
// constant; body-bus modules use CDA6; TIPM uses its own table; SGW uses
// XTEA. Anything not listed falls through to unlockIdForTx(tx) below.
const MOD_UNLOCK = {
  ECM:'gpec2', TCM:'gpec2', DAMP:'gpec2', ADCM:'gpec2',
  BCM:'cda6', RFHUB:'cda6', ABS:'cda6', IPC:'cda6',
  EPS:'cda6', RADIO:'cda6', ORC:'cda6', HVAC:'cda6',
  DTCM:'cda6', SCCM:'cda6', DDM:'cda6',
  TIPM:'t80',
  SGW:'xtea_sgw',
};

// Fallback unlock chain — tried in order when the preferred algorithm is
// rejected with NRC 0x35 (invalid key). Covers the realistic universe of
// FCA/Stellantis seed→key transforms; 0x74F (SGW) bypasses this list.
// `alfa_ao` follows CDA6 directly so a UCONNECT / RADIO_FGA at access
// level 5 authenticates without needing a per-module override; the four
// dispatcher-mapped w6 wrappers (families 27 + 66) come after the GPEC
// XOR family so a body-bus ECU that turns out to be one of those gets
// covered too. Order is documented and tested.
const UNLOCK_FALLBACK = [
  'cda6','alfa_ao','gpec2','gpec3','gpec2a','gpec15',
  'alfa_w6_tt','alfa_w6_tu','alfa_w6_tv','alfa_w6_ez',
];

// Tx address ranges that live on the body bus and therefore should be
// retried with the AlfaOBD body-bus algorithms (`alfa_ao` + the four
// dispatcher-mapped w6 wrappers). Today this is "anything that isn't
// the SGW gateway 0x74F" — pickUnlockChain stays conservative and lets
// UNLOCK_FALLBACK supply all algorithms in declared order.
function isBodyBusTx(tx){ return tx !== 0x74F; }

// Build an ordered unlock-algorithm chain to try for a given tx + module
// code. SGW (tx 0x74F) is always XTEA-only — no fallback. Otherwise the
// preferred algorithm (MOD_UNLOCK[code] or unlockIdForTx(tx) for unknown
// modules) is tried first, then UNLOCK_FALLBACK with duplicates stripped.
// Body-bus modules also pick up the dispatcher-mapped w6 wrappers — see
// AOBD_DISPATCH for which family/level combinations resolve to which
// wrapper. Non-body-bus tx ids stay on the legacy chain.
function pickUnlockChain(tx, code){
  if(tx===0x74F) return ['xtea_sgw'];
  const pref = (code && MOD_UNLOCK[code]) || unlockIdForTx(tx);
  const out = [pref];
  if(!isBodyBusTx(tx)){
    // Non body-bus: legacy chain only, drop the alfa_* tails.
    for(const id of UNLOCK_FALLBACK){
      if(id.startsWith('alfa_')) continue;
      if(!out.includes(id)) out.push(id);
    }
    return out;
  }
  for(const id of UNLOCK_FALLBACK) if(!out.includes(id)) out.push(id);
  return out;
}

// Encode a UDS DID (DataIdentifier) into request bytes. ISO 14229 DIDs are
// 16-bit (e.g. 0xF190 VIN), but FCA exposes 24-bit module-specific DIDs in
// the 0x6E_____ space (e.g. 0x6E2025 BCM proxi VIN slot). Truncating to
// 16-bit silently writes 0x2025 — a different DID — and corrupts unrelated
// data. Encoder picks 2-byte vs 3-byte form based on magnitude.
function encodeDid(did){
  if(did<0||!Number.isInteger(did)) throw new Error('encodeDid: bad did '+did);
  if(did<=0xFFFF) return [(did>>>8)&0xFF, did&0xFF];
  if(did<=0xFFFFFF) return [(did>>>16)&0xFF, (did>>>8)&0xFF, did&0xFF];
  throw new Error('encodeDid: did too large 0x'+did.toString(16));
}

// Per-module VIN write DID list. Default = ISO 14229 standard chain
// (F190 = VIN, 7B90 = current VIN copy, 7B88 = original VIN copy). BCM and
// RFHUB carry an additional FCA-specific 24-bit copy in the 0x6E2025/0x6E2027
// configuration block; EPS keeps F190 plus its own 0x6EF190 mirror.
const VIN_WRITE_DIDS = {
  default: [0xF190, 0x7B90, 0x7B88],
  BCM:     [0xF190, 0x7B90, 0x7B88, 0x6E2025],
  RFHUB:   [0xF190, 0x7B90, 0x7B88, 0x6E2027],
  EPS:     [0xF190, 0x6EF190],
};
function vinWriteDids(code){
  return VIN_WRITE_DIDS[code] || VIN_WRITE_DIDS.default;
}

// Decode a UDS 0x22 ReadDataByIdentifier positive response and return the
// trailing-17 ASCII characters — the universal "VIN tail". Works for both
// 16-bit DIDs (62 DH DL ...) and 24-bit DIDs (62 DH DM DL ...). Returns
// '' when the response isn't a positive 0x62 frame or doesn't contain at
// least 17 printable bytes after the DID echo. This keeps the per-DID
// read-back compare uniform across F190 / 7B90 / 7B88 / 6E2025 / 6E2027 /
// 6EF190 — every one of those slots is a 17-byte VIN string in practice.
function vinFromReadResponse(d, did){
  if(!d || d.length<2 || d[0]!==0x62) return '';
  const dh = encodeDid(did);
  // Confirm the echoed DID bytes match what we asked for; if not, reject.
  if(d.length < 1+dh.length) return '';
  for(let i=0;i<dh.length;i++) if(d[1+i]!==dh[i]) return '';
  const payload = Array.from(d).slice(1+dh.length).filter(b=>b>=0x20&&b<=0x7E);
  if(payload.length<8) return '';
  // Up to 17 chars trailing — covers full VIN (F190/7B90/7B88) and the
  // 8-char "VIN tail" mirror that BCM's 0x6E2025 / RFHUB's 0x6E2027
  // typically return. Caller decides what comparison rule to apply.
  return String.fromCharCode(...payload).slice(-17);
}

// DIDs that store only the trailing-8 of the VIN (sequence number portion)
// instead of the full 17-character VIN. Confirmed for FCA Body Control
// (0x6E2025) and RF Hub (0x6E2027).
const VIN_TAIL8_DIDS = new Set([0x6E2025, 0x6E2027]);

// Compare a read-back string against the new VIN using DID-specific rules.
// - Full-17 DIDs (F190 / 7B90 / 7B88 / 6EF190): require exact match on
//   the full 17 characters.
// - 8-char mirror DIDs (0x6E2025 / 0x6E2027): accept either the full
//   VIN (some ECUs replicate it) OR the 8-character VIN tail.
function vinReadbackOk(did, tail, nv){
  if(typeof tail !== 'string' || tail.length===0 || typeof nv !== 'string' || nv.length!==17) return false;
  if(tail===nv) return true;
  if(VIN_TAIL8_DIDS.has(did) && tail.length===8 && tail===nv.slice(-8)) return true;
  return false;
}

// NRC-aware security access: walks pickUnlockChain(tx,code), requesting a
// fresh seed before each attempt and trying the next algorithm only when
// the ECU rejects the key with NRC 0x35 (invalid key). Returns the algo id
// that succeeded, true if the seed was already zero (already unlocked), or
// false on terminal failure. addLog is optional (info/warn/rx/error).
async function tryUnlock(uds, tx, rx, code, addLog, label, accessLevel) {
  const chain = pickUnlockChain(tx, code);
  return tryUnlockWithChain(uds, tx, rx, chain, addLog, label || code || ('0x' + tx.toString(16).toUpperCase()), accessLevel);
}

// Same as tryUnlock but takes an explicit, ordered list of algorithm ids.
// Used by vinProgrammer when a registry row carries an `unlockChain`
// override (e.g. ECM tab's 10-algo platform sweep).
//
// ISO 14229 SecurityAccess: odd sub-functions request a seed
// (01/03/05/07/…), the next even sub-function (02/04/06/08/…) sends the
// computed key back. accessLevel must therefore be odd. The default of
// 0x01 mirrors the historical behavior — every existing call site that
// doesn't pass a level still gets level-1 seed/key, so behavior is
// unchanged for the dozens of CDA6/Alfa rows that use level 1.
//
// NRC handling (Task #501):
// • 0x36 exceededNumberOfAttempts — the ECU has locked the security
//   access state machine. Trying another algorithm is pointless until the
//   module power-cycles or the lockout timer expires; we stop the chain
//   immediately and surface the lockout to the caller.
// • 0x37 requiredTimeDelayNotExpired — the ECU is rate-limiting after a
//   bad key. Spec lets the response carry an extended-record byte holding
//   the remaining delay in seconds (some FCA modules do, others don't).
//   When present we sleep that long and retry the SAME algorithm exactly
//   once; otherwise we retry once after a conservative default delay.
function nrcLabel(n) {
  if (n === 0x35) return 'invalidKey';
  if (n === 0x36) return 'exceededNumberOfAttempts';
  if (n === 0x37) return 'requiredTimeDelayNotExpired';
  return 'NRC';
}

async function tryUnlockWithChain(uds, tx, rx, chain, addLog, label, accessLevel, opts) {
  const lbl = label || ('0x' + tx.toString(16).toUpperCase());
  const seedSF = (typeof accessLevel === 'number' && accessLevel >= 1 && accessLevel <= 0x3D)
    ? (accessLevel | 1) // force odd, in case a caller passes the key sub-function by mistake
    : 0x01;
  const keySF = seedSF + 1;
  // Tests can inject a synchronous sleeper; production uses real setTimeout.
  const sleep = (opts && typeof opts.sleep === 'function')
    ? opts.sleep
    : (ms) => new Promise(r => setTimeout(r, ms));
  const defaultRetryMs = (opts && typeof opts.defaultRetryMs === 'number')
    ? opts.defaultRetryMs
    : 1500;

  for (let i = 0; i < chain.length; i++) {
    const aid = chain[i];

    // Inner retry loop for NRC 0x37 — at most one extra attempt of the
    // same algorithm so a slow-but-recoverable module gets a chance.
    let retriesLeft = 1;

    while (true) {
      const sr = await uds(tx, rx, [0x27, seedSF]);
      if (!(sr && sr.ok && sr.d && sr.d.length >= 2)) {
        addLog && addLog(lbl + ' seed read failed', 'error');
        return false;
      }
      if (sr.d[0] === 0x7F) {
        const nrc = sr.d[2];
        if (nrc === 0x36) {
          addLog && addLog(lbl + ' seed NRC 0x36 (' + nrcLabel(nrc) + ') — module lockout, stopping chain', 'error');
          return false;
        }
        if (nrc === 0x37 && retriesLeft > 0) {
          const delayMs = (sr.d.length >= 4 ? sr.d[3] * 1000 : 0) || defaultRetryMs;
          addLog && addLog(lbl + ' seed NRC 0x37 — waiting ' + delayMs + ' ms then retry-after', 'warn');
          retriesLeft--;
          await sleep(delayMs);
          continue;
        }
        addLog && addLog(lbl + ' seed NRC 0x' + (nrc || 0).toString(16).toUpperCase() + ' (' + nrcLabel(nrc) + ')', 'error');
        return false;
      }
      if (sr.d[0] !== 0x67 || sr.d.length < 6) {
        addLog && addLog(lbl + ' seed bad framing: ' + Array.from(sr.d).slice(0, 6).map(b => b.toString(16)).join(' '), 'error');
        return false;
      }
      const sb = Array.from(sr.d).slice(2);
      if (!sb.some(b => b !== 0)) {
        addLog && addLog(lbl + ' already unlocked (zero seed)', 'rx');
        return true;
      }
      const kb = unlockKeyBytes(aid, sb);
      if (kb === null) { break; } // skip this algo, advance the chain
      const kr = await uds(tx, rx, [0x27, keySF, ...kb]);
      if (kr && kr.ok && kr.d && kr.d[0] === 0x67) {
        addLog && addLog(lbl + ' UNLOCKED via ' + aid + ' (' + kb.length + 'B key, level 0x' + seedSF.toString(16).toUpperCase().padStart(2, '0') + ')', 'rx');
        return aid;
      }
      const nrc = (kr && kr.ok && kr.d && kr.d[0] === 0x7F) ? kr.d[2] : null;
      addLog && addLog(lbl + ' ' + aid + ' rejected' + (nrc != null ? (' (NRC 0x' + nrc.toString(16).toUpperCase() + ' ' + nrcLabel(nrc) + ')') : ''), 'warn');

      if (nrc === 0x36) {
        // Hard lockout — abort everything; another algorithm won't fare
        // any better until the module is power-cycled.
        addLog && addLog(lbl + ' lockout until module reset (NRC 0x36)', 'error');
        return false;
      }
      if (nrc === 0x37 && retriesLeft > 0) {
        // Mirror the seed-side spec: byte after the NRC is delay-in-seconds
        // when the ECU reports it. Sleep that long, then retry the same
        // algorithm exactly once.
        const delayMs = (kr.d.length >= 4 ? kr.d[3] * 1000 : 0) || defaultRetryMs;
        addLog && addLog(lbl + ' ' + aid + ' retry-after ' + delayMs + ' ms', 'warn');
        retriesLeft--;
        await sleep(delayMs);
        continue;
      }
      // Any other NRC (0x35 invalidKey, 0x33 securityAccessDenied, etc) —
      // walk to the next algorithm in the chain.
      break;
    }
  }
  addLog && addLog(lbl + ' all unlock algorithms exhausted', 'error');
  return false;
}

export {
  u32,sxor,cda6,ngc,tipm,
  xteaEncryptBlock,xteaDecryptBlock,xtea_sgw,xtea_sgw_full,SGW_XTEA_KEY,
  alfaHt,alfaF,alfaAo,alfaW6,alfaW6By,
  ALFA_XTEA_KEY,ALFA_XTEA_DELTA,ALFA_XTEA_ROUNDS,
  unlockKey,unlockKeyBytes,unlockIdForTx,
  MOD_UNLOCK,UNLOCK_FALLBACK,pickUnlockChain,tryUnlock,tryUnlockWithChain,
  encodeDid,VIN_WRITE_DIDS,vinWriteDids,vinFromReadResponse,vinReadbackOk,VIN_TAIL8_DIDS,
  ALGOS,
};
