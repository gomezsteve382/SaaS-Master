/* ==========================================================================
 * CANFLASH BYTE-VERIFIED ALGORITHMS
 * Source: Chrysler_J2534_Flash_Application/unlocks/*.dll
 * Each algorithm validated against the DLL's built-in verify() self-test.
 * This is the FIRST ground-truth seed-key catalog in this project — 
 * everything below produces byte-identical output to the factory Chrysler DLL.
 * ========================================================================== */

function cfRotR16(x,n){x&=0xFFFF;for(let i=0;i<n;i++){const b=x&1;x>>>=1;if(b)x|=0x8000;}return x&0xFFFF;}

// huntsville_bcm.dll — Chrysler BCM (also FCM)  SELF-TEST: 10/10 ✓
function cfBCM(seed){const T=[0x9C8E,0x4CC1,0xD3C2,0xE7EC,0x5FEB,0xCA78,0x432E,0x1FFA];
  const s=seed&0xFFFF;let v=T[(s>>>10)&7];v^=T[(s>>>7)&7];v^=T[(s>>>4)&7];v^=T[(s>>>13)&7];
  v^=T[s&7];v^=s;v^=0x64D1;return v&0xFFFF;}

// motorola_tipm7.dll — TIPM_7  SELF-TEST: 10/10 ✓
function cfTIPM(seed){const T=[0x33E2,0x6EF0,0x552D,0x865A,0xBBCF,0xBF62,0xD4EE,0x127F];
  const o=seed&0xFFFF,s=cfRotR16(o,1);let v=T[(s>>>12)&7];v^=T[(s>>>9)&7];v^=T[(s>>>6)&7];
  v^=T[(s>>>3)&7];v^=T[s&7];v^=o;v^=0x9736;return v&0xFFFF;}

// trw_abs.dll — ABS (TRW)  SELF-TEST: 10/10 ✓
function cfTrwABS(seed){const T=[0xF382,0xCE9D,0x35AF,0x426C,0x4863,0xF941,0x751D,0xEADF];
  const o=seed&0xFFFF,s=cfRotR16(o,3);let v=T[(s>>>12)&7];v^=T[(s>>>9)&7];v^=T[(s>>>6)&7];
  v^=T[(s>>>3)&7];v^=T[s&7];v^=o;v^=0xA59B;return v&0xFFFF;}

// bosch_abs.dll — ABS (Bosch)  SELF-TEST: 16/16 ✓
function cfBoschABS(seed){const T=[0x9E19,0x60EB,0xFD80,0xDBF2,0x456B,0x90D0,0xEB54,0xBE6A,
  0x356E,0x76D5,0xE11C,0xADCF,0x1A72,0x0AFB,0x91DA,0x4D04];
  const s=seed&0xFFFF;let v=0;for(let i=0;i<16;i++){if(s&(1<<i))v^=T[i];}return v&0xFFFF;}

// may_scofield_itm.dll — ITM  SELF-TEST: 8/8 ✓
function cfITM(seed){const T=[0x4398,0x7421,0xC1AB,0x36DD,0x508A,0x9BF6,0x638E,0x1409];
  const o=seed&0xFFFF,s=cfRotR16(o,2);let v=T[(s>>>13)&7];v^=T[(s>>>10)&7];v^=T[(s>>>7)&7];
  v^=T[(s>>>3)&7];v^=T[s&7];v^=o^0x2465;return v&0xFFFF;}

/* Helper: take a 16-bit seed from a byte array, return 2-byte key array */
function cfCall16(fn,seedBytes){
  const s=((seedBytes[0]&0xFF)<<8)|(seedBytes[1]&0xFF);
  const k=fn(s);
  return [(k>>>8)&0xFF,k&0xFF];
}

/* ==========================================================================
 * CANFLASH EXTENDED — 8 additional byte-verified algorithms
 * Validated via Unicorn CPU emulation of real DLLs (15-20 random seeds each).
 * Total verified count: 13 module families covering BCM, PCM, TCM, ABS, 
 * Radio, TIPM, ITM, WCM, RAK.
 * ========================================================================== */

// yazaki_fcm.dll — BCM on LX platform (Scat Pack/Hellcat).  emu 20/20 ✓
function cfYazakiFCM(seed){const T=[0x4F44,0xCAAC,0x005A,0x5A10,0x92C8,0x8DFF,0xA1B6,0x7973];
  const s=seed&0xFFFF;const c=((((s>>>1)&0x20)|(s&0x18))>>>3);
  let v=T[s&7];v^=T[c&7];v^=T[(s>>>7)&7];v^=T[(s>>>10)&7];v^=T[(s>>>13)&7];
  v^=s;v^=0x632A;return v&0xFFFF;}

// ngc_engine.dll — Older NGC PCM.  emu 20/20 ✓
function cfNGCEngine(seed){const T=[0x8A4F,0x5245,0x9308,0xD997,0xF4F5,0xE324,0xC76F,0x5535];
  const o=seed&0xFFFF,s=cfRotR16(o,1);
  let v=T[(s>>>10)&7];v^=T[(s>>>7)&7];v^=T[(s>>>3)&7];v^=T[(s>>>13)&7];v^=T[s&7];
  v^=o;v^=0x537E;return v&0xFFFF;}

// ngc_transmission.dll — TCM (ZF 8HP, etc).  emu 20/20 ✓
function cfNGCTrans(seed){const T=[0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
  const o=seed&0xFFFF,s=cfRotR16(o,4);
  let v=T[(s>>>10)&7];v^=T[(s>>>7)&7];v^=T[(s>>>4)&7];v^=T[(s>>>1)&7];v^=T[(s>>>13)&7];
  v^=o;v^=0x1EA4;return v&0xFFFF;}

// venom_pcm.dll — Venom PCM.  Self-test 5/5, emu 20/20 ✓
function cfVenomPCM(seed){const T=[0x7431,0x1E6D,0x02EA,0xF917,0xAC52,0x377B,0x21E2,0xCA48];
  const o=seed&0xFFFF,c=cfRotR16(o,3);
  let v=T[(c>>>11)&7];v^=T[(c>>>6)&7];v^=T[(c>>>2)&7];v^=T[c&7];v^=T[(c>>>9)&7];
  v^=o;v^=0xAB56;return v&0xFFFF;}

// huntsville_radio.dll — Radio RAQ/REF.  emu 15/15 ✓
function cfHuntsvilleRadio(seed){const T=[0x715F,0x36BD,0x2E05,0xAA38,0x8952,0x1FDC,0x6255,0xE379];
  const s=seed&0xFFFF;
  let v=T[s&7];v^=T[(s>>>4)&7];v^=T[(s>>>7)&7];v^=T[(s>>>10)&7];v^=T[(s>>>13)&7];
  v^=s;v^=0xCA59;return v&0xFFFF;}

// wcm.dll — Wireless Control Module.  emu 20/20 ✓
function cfWCM(seed){const T=[0x4435,0x1001,0x6324,0x5565,0x9932,0x0638,0x0017,0x3968,
  0x7656,0x8239,0x2743,0x6897,0x6460,0x0054,0x9078,0x6546];
  const s=seed&0xFFFF;
  const ebx=(T[s&0xF]&0xFF00)|(s&0xFF);
  let eax=(T[(s>>>8)&0xF]+s)>>>0;
  eax=Math.imul(eax,ebx)&0xFFFF;
  return eax;}

// alpine_rak.dll — 2-arg RAK keyless entry.  emu 20/20 ✓
// seed_lo and seed_hi are each 32-bit; returns 32-bit key.
function cfAlpineRAK(seedLo,seedHi){
  const a=(Math.imul(seedLo,0x41C64E6D)+0x3039)>>>0;
  const b=(Math.imul(seedHi,0x41C64E6D)+0x3039)>>>0;
  return (a^b^0x4E2B)>>>0;}

// gpec.dll — Modern Stellantis PCM (Scat Pack, Hellcat, SRT).  emu 15/15 ✓
// 16-round TEA Feistel with 16-bit halves, key="DAIMLERCHRYSLER3".
function cfGPEC(seedDword){
  const KB=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x33];
  function sk(b){let x=KB[b+3]<<3;x^=KB[b+2];x<<=2;x^=KB[b+1];x<<=3;x^=KB[b+0];return x&0xFFFF;}
  const K=[sk(0),sk(4),sk(8),sk(12)];
  function sw(x){return (((x&0xFF)<<8)|((x>>>8)&0xFF))&0xFFFF;}
  let v0=sw((seedDword>>>16)&0xFFFF);
  let v1=sw(seedDword&0xFFFF);
  let sum=0;
  for(let i=0;i<16;i++){
    sum=(sum+0xFFFF9E37)&0xFFFF;
    v0=(v0+((((v1<<4)+K[0])^((v1>>>5)+K[1]))^(sum+v1)))&0xFFFF;
    v1=(v1+((((v0<<4)+K[2])^((v0>>>5)+K[3]))^(sum+v0)))&0xFFFF;
  }
  return ((sw(v0)<<16)|sw(v1))>>>0;}

/* Helper: build a 4-byte key array from 32-bit integer (big-endian) */
function cfCall32(fn,seedBytes){
  const s=((seedBytes[0]&0xFF)<<24)|((seedBytes[1]&0xFF)<<16)|((seedBytes[2]&0xFF)<<8)|(seedBytes[3]&0xFF);
  const k=fn(s)>>>0;
  return [(k>>>24)&0xFF,(k>>>16)&0xFF,(k>>>8)&0xFF,k&0xFF];
}

/* 2-arg helper for alpine_rak style modules */
function cfCall32x2(fn,seedBytes){
  // Expects 8 bytes: first 4 = seed_lo, next 4 = seed_hi (big-endian each)
  const lo=((seedBytes[0]&0xFF)<<24)|((seedBytes[1]&0xFF)<<16)|((seedBytes[2]&0xFF)<<8)|(seedBytes[3]&0xFF);
  const hi=((seedBytes[4]&0xFF)<<24)|((seedBytes[5]&0xFF)<<16)|((seedBytes[6]&0xFF)<<8)|(seedBytes[7]&0xFF);
  const k=fn(lo>>>0,hi>>>0)>>>0;
  return [(k>>>24)&0xFF,(k>>>16)&0xFF,(k>>>8)&0xFF,k&0xFF];
}


/* CANFLASH MODULE MAP — AUTHORITATIVE CAN IDs from ecu_info */
const CANFLASH_MAP={
  'BCM':{tx:0x0620,rx:0x0504,algo:cfBCM,name:'huntsville_bcm.dll'},
  'TIPM_7':{tx:0x0620,rx:0x0504,algo:cfTIPM,name:'motorola_tipm7.dll'},
  'ABS_TRW':{tx:0x0784,rx:0x0785,algo:cfTrwABS,name:'trw_abs.dll'},
  'ABS_BOSCH':{tx:0x0784,rx:0x0785,algo:cfBoschABS,name:'bosch_abs.dll'},
  'ITM':{tx:0x0670,rx:0x050E,algo:cfITM,name:'may_scofield_itm.dll'},
};

/* Extended CANFLASH_MAP with all 13 verified modules */
Object.assign(CANFLASH_MAP,{
  'BCM_LX':{tx:0x0620,rx:0x0504,algo:cfYazakiFCM,name:'yazaki_fcm.dll'},
  'PCM_NGC':{tx:0x07E0,rx:0x07E8,algo:cfNGCEngine,name:'ngc_engine.dll'},
  'TCM':{tx:0x07E1,rx:0x07E9,algo:cfNGCTrans,name:'ngc_transmission.dll'},
  'PCM_VENOM':{tx:0x07E0,rx:0x07E8,algo:cfVenomPCM,name:'venom_pcm.dll'},
  'PCM_GPEC':{tx:0x07E0,rx:0x07E8,algo:cfGPEC,name:'gpec.dll',bits:32},
  'RADIO':{tx:0x06B0,rx:0x0516,algo:cfHuntsvilleRadio,name:'huntsville_radio.dll'},
  'WCM':{tx:0x0600,rx:0x0500,algo:cfWCM,name:'wcm.dll'},
  'RAK':{tx:0x06B0,rx:0x0516,algo:cfAlpineRAK,name:'alpine_rak.dll',bits:64},
});

/* MODULE SPECS — how to program a VIN for each of the 13 verified modules.
   Derived from: canflash ecu_info structs, VILLAIN VIN programming guide,
   and dump-verified EEPROM layouts (RFHUB: 4 copies at 0xEA5/EB9/ECD/EE1). */
const MODULE_SPECS = {
  'BCM_LX':       {securityLevel:3,sessionType:0x03,vinDidKwp:0x90,vinDidOriginalKwp:0x88,canTx:0x0620,canRx:0x0504,unlockAlgo:'cfYazakiFCM',description:'BCM — Scat Pack/Hellcat/LX platform'},
  'BCM_STANDARD': {securityLevel:3,sessionType:0x03,vinDidKwp:0x90,vinDidOriginalKwp:0x88,canTx:0x0620,canRx:0x0504,unlockAlgo:'cfBCM',description:'BCM — standard Chrysler'},
  'TIPM_7':       {securityLevel:3,sessionType:0x03,vinDidKwp:0x90,vinDidOriginalKwp:0x88,canTx:0x0620,canRx:0x0504,unlockAlgo:'cfTIPM',description:'TIPM 7'},
  'ABS_TRW':      {securityLevel:1,sessionType:0x03,vinDidKwp:0x90,canTx:0x0784,canRx:0x0785,unlockAlgo:'cfTrwABS',description:'ABS TRW'},
  'ABS_BOSCH':    {securityLevel:1,sessionType:0x03,vinDidKwp:0x90,canTx:0x0784,canRx:0x0785,unlockAlgo:'cfBoschABS',description:'ABS Bosch'},
  'ITM':          {securityLevel:3,sessionType:0x03,vinDidKwp:0x90,canTx:0x0670,canRx:0x050E,unlockAlgo:'cfITM',description:'ITM'},
  'PCM_NGC':      {securityLevel:3,sessionType:0x03,vinDidKwp:0xE1,canTx:0x07E0,canRx:0x07E8,unlockAlgo:'cfNGCEngine',description:'PCM older NGC'},
  'PCM_GPEC':     {securityLevel:3,sessionType:0x03,vinDidKwp:0xE1,vinDidUds:0xF190,canTx:0x07E0,canRx:0x07E8,unlockAlgo:'cfGPEC',description:'PCM modern Stellantis (Scat Pack/Hellcat SRT)'},
  'PCM_VENOM':    {securityLevel:3,sessionType:0x03,vinDidKwp:0xE1,canTx:0x07E0,canRx:0x07E8,unlockAlgo:'cfVenomPCM',description:'PCM Venom'},
  'TCM':          {securityLevel:3,sessionType:0x03,vinDidKwp:0x90,canTx:0x07E1,canRx:0x07E9,unlockAlgo:'cfNGCTrans',description:'TCM (ZF 8HP)'},
  'RADIO':        {securityLevel:1,sessionType:0x03,vinDidKwp:0x90,canTx:0x06B0,canRx:0x0516,unlockAlgo:'cfHuntsvilleRadio',description:'Radio RAQ/REF'},
  'RAK':          {securityLevel:5,sessionType:0x03,canTx:0x06B0,canRx:0x0516,unlockAlgo:'cfAlpineRAK',unlockArgs:2,description:'RAK (2-arg keyless)'},
  'WCM':          {securityLevel:5,sessionType:0x03,vinDidKwp:0x90,canTx:0x0600,canRx:0x0500,unlockAlgo:'cfWCM',eepromVinOffsets:[0x0EA5,0x0EB9,0x0ECD,0x0EE1],description:'WCM / RFHUB'},
};

export {
  cfRotR16,
  cfBCM, cfTIPM, cfTrwABS, cfBoschABS, cfITM,
  cfYazakiFCM, cfNGCEngine, cfNGCTrans, cfVenomPCM, cfHuntsvilleRadio,
  cfWCM, cfAlpineRAK, cfGPEC,
  cfCall16, cfCall32, cfCall32x2,
  CANFLASH_MAP, MODULE_SPECS,
};
