const u32=n=>n>>>0;
function sxor(s,c){let k=u32(s);for(let i=0;i<5;i++)k=k&0x80000000?u32((k<<1)^u32(c)):u32(k<<1);return k;}
function cda6(s){let k=u32(s);k=u32(k^0x4B129F);k=u32((k<<3)|(k>>>29));k=u32(k+0x1234);k=u32(k^0xABCD);return u32((k>>>5)|(k<<27));}
const NT=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31],NS=[0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
// NGC 14×32-bit pre-computation table — extracted from VILLAIN memory dump
// (VILLAIN_COMPLETE_EXTRACTION.md §"NGC Pre-Computation Table"). Used by the
// ngc_trans_unlock_level5 variant for transmission controllers. Exported for
// reference and future NGC-trans algo integration.
const NGC_PRE=[0x2796144E,0xC55A3FD5,0x4D5C406D,0xB08EF250,0x91FF47E1,0x2481F456,0xC393FC49,0x3A4EFF33,0x1EADCC75,0xD9BDD2F5,0x679705B4,0x42CF5086,0x415D9886,0x19111199];
function ngc(s){let k=0;for(let i=0;i<4;i++){let b=(u32(s)>>(i*8))&0xFF;k=u32(k^u32(((NT[b&0xF]^NT[(b>>4)&0xF])*NS[i%8])&0xFFFFFFFF));}return k;}
// TT keys: a=t8001 (SA 0x80), b=t3605 (SA 0x36/0x05), c=t8101 (SA 0x81),
//          d=t3c (SA 0x3C), e=t3608 (SA 0x08), f=tc605 (SA 0xC6/0x05)
// All six tables confirmed from VILLAIN_COMPLETE_EXTRACTION.md.
const TT={a:[0x727B,0xB301,0x08EB,0xB0BA,0xECA7,0x0ECC,0xD69A,0xE47E],b:[0x7A44,0x0201,0xF123,0x146E,0xCBC2,0x553F,0xD398,0x4EDC],c:[0x22B5,0x5767,0x4C5A,0xE443,0xC606,0x7544,0x0DFB,0x36D6],d:[0x632A,0x193B,0x914F,0x0F88,0x5E51,0x8DCD,0xDD6C,0x00DD],e:[0x9110,0x4E8A,0xEA2C,0xE235,0xB73F,0xE6E5,0x5916,0x16CC],f:[0x53CE,0xE73D,0x2255,0xB1BA,0xDA02,0x70BE,0xBB65,0x81A4]},TM=[0xBAEE,0xE000,0x1C00,0x0380,0x0070,0x0007];
function tipm(s,t='a'){const tb=TT[t]||TT.a;let v=s&0xFFFF,k=0;for(let i=0;i<tb.length;i++){let m=v&TM[i%TM.length],b=0,x=m;while(x){b^=x&1;x>>=1;}k=(k<<1)|b;k^=tb[i];k&=0xFFFF;}return k;}
// TIPM SA-level routing: maps the UDS SecurityAccess seed sub-function to the
// correct TIPM lookup table key. Used by tipmByLevel() and reflected in ALGOS.
const TIPM_SA_DISPATCH = Object.freeze({
  0x80:'a', 0x01:'a',            // t8001 (default)
  0x36:'b', 0x05:'b', 0x10:'b', // t3605
  0x81:'c',                      // t8101
  0x3C:'c', 0x37:'d',            // t3c
  0x08:'e', 0x88:'e',            // t3608
  0xC6:'f', 0xC5:'f',            // tc605
});
function tipmByLevel(s,saLevel){return tipm(s,TIPM_SA_DISPATCH[saLevel&0xFF]||'a');}

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
// Factory-verified FCA seed/key (byte-verified vs the unlock DLLs in
// tools/python-bridge/.../canflash_seedkey.py). Preferred over the ad-hoc
// sxor/cda6 guesses below for module families that have a verified algorithm.
import { unlockKeyBytesByModule, VERIFIED_BY_CODE } from "@workspace/uds";

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

// ─── Asset-sweep ports (promoted into the live unlock chain) ─────────────
// Hand-ported from canonical Python in srtlab_canflash_algos.py and
// srt_lab.py via tools/asset-sweep. Each function is named to match its
// canonical tag (so the asset-sweep comparator marks the corresponding
// Python source as `coverageStatus: "already-implemented"` on the next
// run and the EXTENDED_ALGORITHMS catalog auto-shrinks). Vector-verified
// against the original Python expressions — see ports.mjs git history
// for the original 8-vector pinned tables.

// Aisin AS68RC/AS69RC TCM — 3-stage sub/add/imul/not chain, indexed by seed&7.
function aisin_tcm(seed){
  seed=seed>>>0;
  const STACK=[
    0x2345,0x6789,0xabc7,0xcdef,0x0123,0x2345,0x6789,0xabcd,
    0x2345,0x6789,0xabc7,0xcdef,0x0123,0x2345,0x6789,0xabcd,
  ];
  const idx=seed&7;
  let eax=seed;
  const mod_ax=(v)=>{eax=((eax&0xFFFF0000)|(v&0xFFFF))>>>0;};
  mod_ax((eax&0xFFFF)-STACK[idx+0]);
  eax=(eax+0x7E55)>>>0;
  mod_ax(((eax&0xFFFF)*STACK[idx+1])&0xFFFF);
  eax=(~eax)>>>0;
  mod_ax((eax&0xFFFF)-STACK[idx+3]);
  mod_ax((eax&0xFFFF)+STACK[idx+2]);
  mod_ax(((eax&0xFFFF)*STACK[idx+4])&0xFFFF);
  eax=(~eax)>>>0;
  mod_ax((eax&0xFFFF)-STACK[idx+6]);
  mod_ax((eax&0xFFFF)+STACK[idx+5]);
  mod_ax(((eax&0xFFFF)*STACK[idx+7])&0xFFFF);
  eax=(~eax)>>>0;
  return eax;
}

// Alpine RA3/RA4 radio — LCG pair (mul=0x32A95B7F, add=0x52D8) ^ 0x58C2.
// arg2 always 0 in every Chrysler dispatcher path.
function alpine_radio(seed){
  const a=(Math.imul(seed>>>0,0x32A95B7F|0)+0x52D8)>>>0;
  const b=(Math.imul(0,0x32A95B7F|0)+0x52D8)>>>0;
  return (a^b^0x58C2)>>>0;
}

// BCM FCA (BCM 2016+, srt_lab.py) — ((seed ^ 0xABCDEF12) * 0x4D + 0x5678).
// Distinct from cfBCM (huntsville_bcm.dll) above — different transform.
function bcm_fca(seed){
  return (Math.imul((seed^0xABCDEF12)>>>0,0x4D)+0x5678)>>>0;
}

// BCM Standard (BCM 2007-2015, srt_lab.py) — seed * 0x9D + 0x1234.
function bcm_standard(seed){
  return (Math.imul(seed>>>0,0x9D)+0x1234)>>>0;
}

// Cummins ISB 6.7L (CM2100/CM2200) — 16-entry table, 4 rotating XORs +
// (seed + 0x55111511). Index = (seed >>> 20) & 0xF.
function cummins_849(seed){
  seed=seed>>>0;
  const T=[
    0x1ce32951,0x8bb28c39,0x76c6da1a,0xe0b69a47,
    0xf356024c,0x60af852b,0x63a12ac7,0x53ff8daf,
    0xa8f7e36c,0x63e92252,0x2cd56fe4,0x2e3ef306,
    0x5b0a976f,0xdb6cfa03,0x19ccb5a4,0x8113b235,
  ];
  const idx=(seed>>>20)&0xF;
  let k=T[(idx+2)&0xF];
  k=(k^T[(idx+3)&0xF])>>>0;
  k=(k^T[(idx+1)&0xF])>>>0;
  k=(k^T[(idx+0)&0xF])>>>0;
  const edx=(seed+0x55111511)>>>0;
  return (k^edx)>>>0;
}

// DCX PowerTrain Control Module — Park-Miller LCG pair ^ 0xF3DD1133.
// Same multiplier as alpine_rak but distinct mixing constant.
function dcx_ptcm(seed){
  const a=(Math.imul(seed>>>0,0x41C64E6D|0)+0x3039)>>>0;
  const b=(Math.imul(0,0x41C64E6D|0)+0x3039)>>>0;
  return (a^b^0xF3DD1133)>>>0;
}

// Mercedes EGS52 (7G-Tronic) — (seed ^ 0x5AA5A5A5) * 0x5AA5A5A5.
// Product exceeds 2^53 — Math.imul mandatory.
function egs52(seed){
  return Math.imul((seed^0x5AA5A5A5)>>>0,0x5AA5A5A5|0)>>>0;
}

// Mitsubishi RAR (5" UConnect 3) — ((seed ^ 0x7368) * 2 + 0x2A) ^ 0x6974.
function mitsubishi_rar(seed){
  const eax=(seed^0x7368)>>>0;
  const ecx=((eax<<1)+0x2A)>>>0;
  return (ecx^0x6974)>>>0;
}

// PowerTrain Integrated Module (LX) — 5 table XORs over a 8-entry u16 table.
// i2 packing intentionally drops bit 7 then OR's bit 6 of seed back in
// (matches the Python source byte-for-byte).
function ptim_lx(seed){
  seed=seed>>>0;
  const T=[0xd785,0xd95b,0x68e7,0x8a4f,0x7f8b,0x8ae8,0x6f21,0x9a69];
  const i0=(seed>>>13)&7;
  const i1=(seed>>>10)&7;
  const i2=((seed>>>7)&6)|((seed>>>6)&1);
  const i3=(seed>>>3)&7;
  const i4=seed&7;
  let k=T[i0];
  k=(k^T[i1])>>>0;
  k=(k^T[i2])>>>0;
  k=(k^T[i3])>>>0;
  k=(k^T[i4])>>>0;
  k=(k^(seed&0xFFFF))>>>0;
  return ((seed&0xFFFF0000)|(k&0xFFFF))>>>0;
}

// ─── VILLAIN-verified sxor constants ──────────────────────────────────
// Primary constants (q1) were already present and match VILLAIN exactly.
// Secondary constants (q2/q3/q4) are the alt-level variants extracted
// from VILLAIN_COMPLETE_EXTRACTION.md and cross-checked against the
// alfaobdAlgorithms.generated.js w6 wrapper table (entries 'iu' and 'iv'
// confirm q1/q2 for GPEC2 base and GPEC2 Flash respectively).
//
// AUDIT RESULT (VILLAIN vs algos.js — source: VILLAIN_COMPLETE_EXTRACTION.md
//               extracted from VILLAIN_GPEC_COMPLETE_EXTRACTION.zip):
//   GPEC1  670269                              ✓ MATCH (primary)
//   GPEC2  q1=0xE72E3799 q2=0x1B64DB03        ✓ q1 MATCH  ✓ q2 ADDED
//   GPEC2F q1=0x966AEEB1 q2=0x440BCE28        ✓ q1 MATCH  ✓ q2 ADDED
//   GPEC2E q1=0x3F711F5A q2=0xC3573AE9        ✓ q1 MATCH  ✓ q2/q3/q4 ADDED
//          q3=0x725EF016 q4=0x58329671
//   GPEC3E q1=0x129D657F q2=0xD0726B89        ✓ q1 MATCH  ✓ q2 ADDED
//   GPEC15 q1=0x47EC21F8 q2=0xCFB81A2E        ✓ q1 MATCH  ✓ q2 ADDED
//   GPEC2A q1=0xCE853A6F q2=0x3BA8FDC7        ✓ q1 MATCH  ✓ q2 ADDED
//   NGC NT (DAIMLERCHRYSLER1 16B)             ✓ MATCH
//   NGC NS (shift_format 8 entries)           ✓ MATCH
//   NGC 14×32-bit pre-computation table       ✓ ADDED (NGC_PRE, 14 entries)
//   TIPM TM bitmask [0xBAEE…0x0007]           ✓ MATCH
//   TIPM t8001 (SA 0x80)   TT.a               ✓ MATCH
//   TIPM t3605 (SA 0x36)   TT.b               ✓ MATCH
//   TIPM t8101 (SA 0x81)   TT.c               ✓ MATCH
//   TIPM t3c   (SA 0x3C)   TT.d               ✓ MATCH
//   TIPM t3608 (SA 0x08)   TT.e               ✓ ADDED
//   TIPM tc605 (SA 0xC6)   TT.f               ✓ ADDED
// SA routing: TIPM_SA_DISPATCH maps SA level → TT table key (see line ~18).
// All six TIPM tables now present; tipmByLevel(seed, saLevel) routes correctly.

const ALGOS=[
  {id:'gpec1',n:'GPEC1',h:'670269',fn:s=>sxor(s,670269)},
  {id:'gpec2',n:'GPEC2',h:'Continental',fn:s=>sxor(s,0xE72E3799)},
  {id:'gpec2_q2',n:'GPEC2 q2',h:'0x1B64DB03 (VILLAIN q2)',fn:s=>sxor(s,0x1B64DB03)},
  {id:'gpec2f',n:'GPEC2 Flash',h:'Flash',fn:s=>sxor(s,0x966AEEB1)},
  {id:'gpec2f_q2',n:'GPEC2 Flash q2',h:'0x440BCE28 (VILLAIN q2)',fn:s=>sxor(s,0x440BCE28)},
  {id:'gpec2e',n:'GPEC2 EPROM',h:'EPROM',fn:s=>sxor(s,0x3F711F5A)},
  {id:'gpec2e_q2',n:'GPEC2 EPROM q2',h:'0xC3573AE9 (VILLAIN q2)',fn:s=>sxor(s,0xC3573AE9)},
  {id:'gpec2e_q3',n:'GPEC2 EPROM q3',h:'0x725EF016 (VILLAIN q3)',fn:s=>sxor(s,0x725EF016)},
  {id:'gpec2e_q4',n:'GPEC2 EPROM q4',h:'0x58329671 (VILLAIN q4)',fn:s=>sxor(s,0x58329671)},
  {id:'gpec3',n:'GPEC3',h:'2018+',fn:s=>sxor(s,0x129D657F)},
  {id:'gpec3_q2',n:'GPEC3 EPROM q2',h:'0xD0726B89 (VILLAIN q2)',fn:s=>sxor(s,0xD0726B89)},
  {id:'gpec2a',n:'GPEC2A',h:'GPEC2A',fn:s=>sxor(s,0xCE853A6F)},
  {id:'gpec2a_q2',n:'GPEC2A EPROM q2',h:'0x3BA8FDC7 (VILLAIN q2)',fn:s=>sxor(s,0x3BA8FDC7)},
  {id:'gpec15',n:'GPEC2 2015',h:'2015-18',fn:s=>sxor(s,0x47EC21F8)},
  {id:'gpec15_q2',n:'GPEC2 2015 q2',h:'0xCFB81A2E (VILLAIN q2)',fn:s=>sxor(s,0xCFB81A2E)},
  {id:'ngc',n:'NGC',h:'DAIMLERCHRYSLER',fn:s=>ngc(s)},
  {id:'jtec',n:'JTEC',h:'Fixed 0000',fn:()=>0},
  {id:'sbec',n:'SBEC (legacy)',h:'(seed*4)+0x9018',fn:s=>u32(s*4+0x9018)},
  {id:'cda6',n:'CDA6',h:'BCM/ABS/IPC',fn:s=>cda6(s)},
  {id:'xtea_sgw',n:'SGW (XTEA)',h:'2018+ Secure Gateway (CDA.swf)',fn:s=>xtea_sgw(s)},
  {id:'t80',  n:'TIPM 0x80',h:'t8001 (VILLAIN confirmed)',fn:s=>tipm(s,'a')},
  {id:'t36',  n:'TIPM 0x36',h:'t3605 (VILLAIN confirmed)',fn:s=>tipm(s,'b')},
  {id:'t81',  n:'TIPM 0x81',h:'t8101 (VILLAIN confirmed)',fn:s=>tipm(s,'c')},
  {id:'t3c',  n:'TIPM 0x3C',h:'t3c   (VILLAIN confirmed)',fn:s=>tipm(s,'d')},
  {id:'t3608',n:'TIPM 0x08',h:'t3608 (VILLAIN confirmed)',fn:s=>tipm(s,'e')},
  {id:'tc605',n:'TIPM 0xC6',h:'tc605 (VILLAIN confirmed)',fn:s=>tipm(s,'f')},
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
  // ── Asset-sweep promotions (formerly EXTENDED_ALGORITHMS) ──
  // Each id matches the canonical tag stripped from the original Python
  // name so loadKnownAlgorithmTags() picks them up and the next sweep
  // marks the asset finding as `already-implemented`.
  {id:'aisin_tcm',     n:'Aisin AS68/69 TCM',          h:'AS68RC/AS69RC TCM',                   fn:s=>aisin_tcm(s)},
  {id:'alpine_radio',  n:'Alpine RA3/RA4',             h:'mid-spec UConnect 4 radio',           fn:s=>alpine_radio(s)},
  {id:'bcm_fca',       n:'BCM FCA',                    h:'BCM 2016+ (srt_lab.py)',              fn:s=>bcm_fca(s)},
  {id:'bcm_standard',  n:'BCM Standard',               h:'BCM 2007-2015 (srt_lab.py)',          fn:s=>bcm_standard(s)},
  {id:'cummins_849',   n:'Cummins ISB 6.7L',           h:'CM2100/CM2200',                       fn:s=>cummins_849(s)},
  {id:'dcx_ptcm',      n:'DCX PTCM',                   h:'PowerTrain Control Module',           fn:s=>dcx_ptcm(s)},
  {id:'egs52',         n:'Mercedes EGS52',             h:'7G-Tronic transmission',              fn:s=>egs52(s)},
  {id:'mitsubishi_rar',n:'Mitsubishi RAR',             h:'5" UConnect 3 radio',                 fn:s=>mitsubishi_rar(s)},
  {id:'ptim_lx',       n:'PTIM (LX)',                  h:'PowerTrain Integrated Module',        fn:s=>ptim_lx(s)},
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
  // `verified:<dll>` chain entries resolve to the factory-verified seed/key in
  // @workspace/uds (handles its own 2-/4-/8-byte wire framing, incl. <4-byte
  // seeds the legacy path below rejects).
  if(unlockId && unlockId.startsWith('verified:')){
    return unlockKeyBytesByModule(unlockId.slice('verified:'.length), seedBytes);
  }
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
// sourced from CDA SWF SecurityGatewayCommand / FlashSecurityGatewayMessage
// orchestration classes plus MOD_UNLOCK confirmation against the
// flasherStateMachine.js Task #488 spec. Mirrored into
// tools/cda-extractor/out/cdaFlashSequences.generated.json.
const MOD_UNLOCK = {
  ECM:'gpec2', TCM:'gpec2', DAMP:'gpec2', ADCM:'gpec2',
  BCM:'cda6', RFHUB:'cda6', ABS:'cda6', IPC:'cda6',
  EPS:'cda6', RADIO:'cda6', ORC:'cda6', HVAC:'cda6',
  DTCM:'cda6', SCCM:'cda6', DDM:'cda6',
  TIPM:'t80',
  SGW:'xtea_sgw',
};

// Ordered fallback chain — tried in order when the preferred algorithm is
// rejected with NRC 0x35 (invalid key). Secondary VILLAIN constants (q2/q3/q4)
// follow their primary immediately so a module that switched SA levels still
// resolves before we burn attempts on unrelated algorithm families.
const UNLOCK_FALLBACK = [
  'cda6','alfa_ao',
  'gpec2','gpec2_q2',
  'gpec3','gpec3_q2',
  'gpec2a','gpec2a_q2',
  'gpec15','gpec15_q2',
  'gpec2e','gpec2e_q2','gpec2e_q3','gpec2e_q4',
  'gpec2f','gpec2f_q2',
  't80','t36','t81','t3c','t3608','tc605',
  'alfa_w6_tt','alfa_w6_tu','alfa_w6_tv','alfa_w6_ez',
];

// ─── VILLAIN SA-level dispatch map ────────────────────────────────────
// Maps UDS SecurityAccess seed sub-function (odd) to the preferred
// algorithm id, derived from the VILLAIN dispatch table. Callers that
// know the SA level (e.g. the workflow runner) can use pickChainForSA()
// instead of pickUnlockChain() to skip irrelevant algorithm families
// and reach the correct one first.
//
// SA 0x60 (EPS) also requires diagnostic session 0x67 and seed DID
// 0x6706 to be established before the 27 SF exchange; those prerequisites
// are handled by the calling workflow, not here.
const SA_DISPATCH = Object.freeze({
  0x05: 'gpec2',    // GPEC2-style power-train
  0x10: 'gpec2',    // GPEC2-style power-train (alt level)
  0x36: 'gpec2',    // VILLAIN dispatch: 0x36 → gpec2 base
  0x42: 'gpec2',    // VILLAIN dispatch: 0x42 → gpec2 base
  0x44: 'gpec2',    // VILLAIN dispatch: 0x44 → gpec2 base
  0x08: 'ngc',      // NGC standard unlock
  0x88: 'ngc',      // NGC standard unlock (high-byte variant)
  0x01: 'ngc',      // NGC level-5 (VILLAIN: SA 0x01 → level-5)
  0x80: 'ngc',      // NGC level-5 (VILLAIN: SA 0x80 → level-5)
  0x81: 'ngc',      // NGC level-5 (VILLAIN: SA 0x81 → level-5)
  0x34: 'jtec',     // JTEC: fixed key 0x00000000
  0x60: 'cda6',     // EPS: session 0x67, seed DID 0x6706 required
  0x0C: 'cummins_849', // Cummins ISB 6.7L (CM2100/CM2200)
});

// ─── AlfaOBD eEcutype idx=14 "SA hint" cross-reference (NO mapping) ────
// The asset-sweep recovered an offline XOR-salt-14 dump of AlfaOBD.exe's
// encrypted eEcutype string pool (see unlock_catalog_extended.json
// §alfaobd_ecu_string_dumps + tools/asset-sweep/REPORT.md). Field idx=14
// was labelled a "SA-level hint" and yielded:
//   eEcutype 1126 MARELLI6F3_CAN → "0"
//   eEcutype 1367 CCN            → "20"
//   eEcutype 1520 TBM2 (RFHUB)   → "29"
//
// These were cross-referenced against AlfaOBD's actual SecurityAccess
// dispatch (Method[1307] abf, salt=17 — see masterCipherDispatch.generated.js
// and alfaobdAlgorithms.generated.js AOBD_DISPATCH). Result: NO MATCH, and
// the hint is NOT a cipher-routing constant:
//   1. AlfaOBD selects the cipher by the ECU's *cipher-family index* at
//      idx[12] (BCM=family_3, ECM=family_11) plus the per-ECU code string —
//      NOT idx[14]. The catalogued family-dispatch set is
//      {17,21,22,27,31,37,39,66}; none of 0/20/29 appear in it.
//   2. idx[14] is the eEcutype *device-type* list (BCM_FAMILY_DEEP records
//      idx14_device_types=["16","51","79"]), a vehicle/variant classifier,
//      not an SA seed sub-function level.
//   3. The recovered values 0/20/29 are absent from the 177-key abf
//      ECU-code→cipher table (ECU_CODE_TO_CIPHER) as well.
// Conclusion: the idx=14 "SA hint" cannot be promoted into SA_DISPATCH or a
// new AOBD_SA_DISPATCH table. The real selector (idx[12] cipher-family) is
// not present in these particular string-pool dumps, so no SA-level→algorithm
// mapping is confirmed. Left as a documented dead end pending a bench seed/key
// capture that pins an eEcutype to an observed SA level + accepted key.

// Build an ordered unlock chain given a known SA seed sub-function level.
// Preferred algorithm comes first, then UNLOCK_FALLBACK with duplicates
// stripped. Returns the same format as pickUnlockChain so callers are
// interchangeable.
function pickChainForSA(saLevel) {
  const preferred = SA_DISPATCH[saLevel & 0xFF];
  if (!preferred) {
    return ['cda6', ...UNLOCK_FALLBACK.filter(id => id !== 'cda6')];
  }
  const out = [preferred];
  for (const id of UNLOCK_FALLBACK) if (!out.includes(id)) out.push(id);
  return out;
}

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
  // Prefer factory-verified algorithms for known families, tried before the
  // ad-hoc sxor/cda6 chain so the correct key lands first (fewest 27 attempts,
  // lowest lockout risk). A wrong family/framing falls through on NRC 0x35.
  const verified = (code && VERIFIED_BY_CODE[code]) ? VERIFIED_BY_CODE[code].map(n=>'verified:'+n) : [];
  const pref = (code && MOD_UNLOCK[code]) || unlockIdForTx(tx);
  const out = [...verified];
  if(!out.includes(pref)) out.push(pref);
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
// sourced from CDA SWF localized string "The Proxi String is read from the
// BCM using command 222023" (= UDS 0x22 ReadDataByIdentifier with DID 0x2025
// in the 0x6E__ FCA block) and the per-module unlock map MOD_UNLOCK below.
// Mirrored into tools/cda-extractor/out/cdaVinWrite.generated.json.
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
// saLevel (optional): when provided, uses pickChainForSA(saLevel) instead of
// pickUnlockChain(tx, code) so the VILLAIN SA-level dispatch map is honored
// (e.g. SA 0x42 → gpec2 first, SA 0x08 → ngc first). Callers that don't
// know the SA level in advance (most UI flows) leave it undefined and get the
// module-code / tx-address based chain as before.
async function tryUnlock(uds, tx, rx, code, addLog, label, accessLevel, saLevel) {
  const chain = (saLevel != null)
    ? pickChainForSA(saLevel)
    : pickUnlockChain(tx, code);
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

  // Task #567 — track whether any algorithm in the chain hit a 0x33/0x34
  // NRC, so we can probe for UDS 0x29 once after the chain is exhausted.
  let sawAuthDenialNrc = null;

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
      // walk to the next algorithm in the chain. We remember whether we
      // saw a 0x33/0x34 along the way so we can probe for UDS 0x29
      // Authentication once after the chain is exhausted, instead of
      // probing mid-chain (which would burn cycles when the next wrapper
      // would have unlocked the module anyway).
      if (nrc === 0x33 || nrc === 0x34){
        sawAuthDenialNrc = nrc;
      }
      break;
    }
  }
  // Task #567 — chain exhausted with at least one 0x33/0x34 along the way.
  // Probe 0x29 once. If the module supports it, flag the detection and
  // surface the canonical refusal so the operator sees WHY no algorithm
  // could unlock it. If not, fall through to the standard exhausted log.
  if (sawAuthDenialNrc != null){
    try {
      const {
        detect0x29, auth29RefusalMessage, auth29UnlockedMessage,
        attemptAuth29Unlock, getAuth29Strategy,
      } = await import('./auth29.js');
      const { flagAuth29Detected, flagAuth29Unlocked } = await import('./auth29State.js');
      const probe = await detect0x29({ uds }, tx, rx);
      addLog && addLog(lbl + ' 0x29 probe → ' + probe.classification + (probe.nrc != null ? (' (NRC 0x' + probe.nrc.toString(16).toUpperCase() + ')') : ''), 'info');
      if (probe.supports){
        // Task #572 — if the operator (or a vendor preset) registered a
        // 0x29 strategy for this tx-id, run the real challenge/response
        // handshake instead of refusing. Successful handshake returns
        // the special string 'auth29' so writer-side `=== false` gates
        // still skip the chain-driven seed/key path while exposing the
        // unlock to callers that want to proceed (the flasher does this
        // directly; the unlock-chain callers treat any non-false return
        // as success and proceed to their own writes).
        const strategy = (opts && typeof opts.auth29Strategy === 'function')
          ? opts.auth29Strategy
          : getAuth29Strategy(tx);
        if (strategy){
          addLog && addLog(lbl + ' running 0x29 challenge/response handshake', 'info');
          const hs = await attemptAuth29Unlock({ uds }, tx, rx, {
            strategy, deauth: false,
            ...((opts && opts.auth29Options) || {}),
          });
          if (hs.authenticated){
            try { flagAuth29Unlocked({ tx, rx, label: lbl, statusInfo: hs.statusInfo }); } catch {}
            addLog && addLog(lbl + ' ' + auth29UnlockedMessage() + ' · statusInfo=0x' + ((hs.statusInfo|0).toString(16).toUpperCase()), 'rx');
            return 'auth29';
          }
          try { flagAuth29Detected({ tx, rx, label: lbl, nrc: sawAuthDenialNrc }); } catch {}
          addLog && addLog(lbl + ' 0x29 handshake failed at ' + hs.phase + ': ' + (hs.error || 'unknown'), 'error');
          return false;
        }
        try { flagAuth29Detected({ tx, rx, label: lbl, nrc: sawAuthDenialNrc }); } catch {}
        addLog && addLog(lbl + ' ' + auth29RefusalMessage(), 'error');
        // Return `false` (not an object) so every existing caller that
        // gates writes on `=== false` (vinProgrammer, OBDTab, BenchTab,
        // etc.) treats this as a hard unlock failure. The detection is
        // still surfaced to the operator via the auth29State flag (UI
        // banners) and the canonical refusal log line above.
        return false;
      }
    } catch (e) {
      addLog && addLog(lbl + ' 0x29 probe error: ' + (e && e.message ? e.message : e), 'warn');
    }
  }
  addLog && addLog(lbl + ' all unlock algorithms exhausted', 'error');
  return false;
}

export {
  u32,sxor,cda6,ngc,tipm,tipmByLevel,
  xteaEncryptBlock,xteaDecryptBlock,xtea_sgw,xtea_sgw_full,SGW_XTEA_KEY,
  alfaHt,alfaF,alfaAo,alfaW6,alfaW6By,
  ALFA_XTEA_KEY,ALFA_XTEA_DELTA,ALFA_XTEA_ROUNDS,
  unlockKey,unlockKeyBytes,unlockIdForTx,
  MOD_UNLOCK,UNLOCK_FALLBACK,pickUnlockChain,tryUnlock,tryUnlockWithChain,
  SA_DISPATCH,pickChainForSA,
  TIPM_SA_DISPATCH,NGC_PRE,
  encodeDid,VIN_WRITE_DIDS,vinWriteDids,vinFromReadResponse,vinReadbackOk,VIN_TAIL8_DIDS,
  ALGOS,
};
