import React, { useState, useCallback, useMemo, useRef } from "react";
import FcaAnalyzerTab from "./FcaAnalyzerTab";

/* ═══ VERIFIED ENGINES ═══ */
function crc16(d,i=0xFFFF){let c=i;for(let x=0;x<d.length;x++){c^=d[x]<<8;for(let j=0;j<8;j++)c=c&0x8000?(c<<1)^0x1021:c<<1;c&=0xFFFF;}return c;}
/* CRC-8 poly=0x26, init=0x00 — FCA 95640 EEPROM VIN checksum.
   GROUND-TRUTH VERIFIED: VIN "1C4RJFDJ7DC513874" → 0x9E (matches real dump).
   Source: SRTLabVINPatcher.jsx crc8p26() */
function crc8p26(d){let c=0x00;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&0x80?((c<<1)^0x26)&0xFF:(c<<1)&0xFF;}return c;}
/* CRC-8 reflected, poly=0xA0, init=0x54 — RFHUB EEE VIN checksum (1 byte after each reversed VIN).
   Source: SRTLabVINPatcher.jsx crc8ref() */
function crc8rf(d){let c=0x54;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&1?((c>>1)^0xA0):c>>1;}return c&0xFF;}
/* CRC-32 (Ethernet/ZIP/PNG), poly=0xEDB88320 reflected, init=0xFFFFFFFF, final XOR 0xFFFFFFFF.
   Source: ECMCalibrationManager.tsx computeCRC32(). Used for calibration file integrity checks. */
const CRC32_TABLE=(()=>{const t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[i]=c;}return t;})();
function crc32(d){let c=0xFFFFFFFF;for(let i=0;i<d.length;i++)c=CRC32_TABLE[(c^d[i])&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;}
/* Legacy alias kept for existing call sites — points to verified crc8p26 */
const crc8_42=crc8p26;
const u32=n=>n>>>0;
function sxor(s,c){let k=u32(s);for(let i=0;i<5;i++)k=k&0x80000000?u32((k<<1)^u32(c)):u32(k<<1);return k;}
function cda6(s){let k=u32(s);k=u32(k^0x4B129F);k=u32((k<<3)|(k>>>29));k=u32(k+0x1234);k=u32(k^0xABCD);return u32((k>>>5)|(k<<27));}
const NT=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31],NS=[0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
function ngc(s){let k=0;for(let i=0;i<4;i++){let b=(u32(s)>>(i*8))&0xFF;k=u32(k^u32(((NT[b&0xF]^NT[(b>>4)&0xF])*NS[i%8])&0xFFFFFFFF));}return k;}
const TT={a:[0x727B,0xB301,0x08EB,0xB0BA,0xECA7,0x0ECC,0xD69A,0xE47E],b:[0x7A44,0x0201,0xF123,0x146E,0xCBC2,0x553F,0xD398,0x4EDC],c:[0x22B5,0x5767,0x4C5A,0xE443,0xC606,0x7544,0x0DFB,0x36D6],d:[0x632A,0x193B,0x914F,0x0F88,0x5E51,0x8DCD,0xDD6C,0x00DD]},TM=[0xBAEE,0xE000,0x1C00,0x0380,0x0070,0x0007];
function tipm(s,t='a'){const tb=TT[t]||TT.a;let v=s&0xFFFF,k=0;for(let i=0;i<tb.length;i++){let m=v&TM[i%TM.length],b=0,x=m;while(x){b^=x&1;x>>=1;}k=(k<<1)|b;k^=tb[i];k&=0xFFFF;}return k;}
const ALGOS=[{id:'gpec1',n:'GPEC1',h:'670269',fn:s=>sxor(s,670269)},{id:'gpec2',n:'GPEC2',h:'Continental',fn:s=>sxor(s,0xE72E3799)},{id:'gpec2f',n:'GPEC2 Flash',h:'Flash',fn:s=>sxor(s,0x966AEEB1)},{id:'gpec2e',n:'GPEC2 EPROM',h:'EPROM',fn:s=>sxor(s,0x3F711F5A)},{id:'gpec3',n:'GPEC3',h:'2018+',fn:s=>sxor(s,0x129D657F)},{id:'gpec2a',n:'GPEC2A',h:'GPEC2A',fn:s=>sxor(s,0xCE853A6F)},{id:'gpec15',n:'GPEC2 2015',h:'2015-18',fn:s=>sxor(s,0x47EC21F8)},{id:'ngc',n:'NGC',h:'DAIMLERCHRYSLER',fn:s=>ngc(s)},{id:'jtec',n:'JTEC',h:'Fixed 0000',fn:()=>0},{id:'cda6',n:'CDA6',h:'BCM/ABS/IPC',fn:s=>cda6(s)},{id:'t80',n:'TIPM 0x80',h:'t8001',fn:s=>tipm(s,'a')},{id:'t36',n:'TIPM 0x36',h:'t3605',fn:s=>tipm(s,'b')},{id:'t81',n:'TIPM 0x81',h:'t8101',fn:s=>tipm(s,'c')},{id:'t3c',n:'TIPM 0x3C',h:'t3c',fn:s=>tipm(s,'d')}];
const MODS=[
{c:'ECM',n:'Engine',addrs:[{tx:0x7E0,rx:0x7E8}]},
{c:'TCM',n:'Transmission',addrs:[{tx:0x7E1,rx:0x7E9}]},
{c:'BCM',n:'Body Control',addrs:[{tx:0x742,rx:0x762},{tx:0x750,rx:0x758},{tx:0x6B0,rx:0x6B8},{tx:0x7B0,rx:0x7B8},{tx:0x620,rx:0x628}]},
{c:'RFHUB',n:'RF Hub',addrs:[{tx:0x75F,rx:0x767},{tx:0x742,rx:0x762},{tx:0x762,rx:0x76A},{tx:0x740,rx:0x748}]},
{c:'ABS',n:'Brakes',addrs:[{tx:0x760,rx:0x768},{tx:0x747,rx:0x74F},{tx:0x740,rx:0x748}]},
{c:'IPC',n:'Cluster',addrs:[{tx:0x745,rx:0x765},{tx:0x740,rx:0x748},{tx:0x746,rx:0x766},{tx:0x720,rx:0x728},{tx:0x742,rx:0x74A}]},
{c:'RADIO',n:'Uconnect',addrs:[{tx:0x772,rx:0x77A},{tx:0x754,rx:0x75C},{tx:0x753,rx:0x773},{tx:0x7D0,rx:0x7D8},{tx:0x7C8,rx:0x7D0}]},
{c:'ADCM',n:'Active Damping',addrs:[{tx:0x744,rx:0x764},{tx:0x745,rx:0x765},{tx:0x7A8,rx:0x7B0},{tx:0x7E4,rx:0x7EC},{tx:0x754,rx:0x75C}]},
{c:'EPS',n:'Steering',addrs:[{tx:0x75F,rx:0x767},{tx:0x761,rx:0x769},{tx:0x74A,rx:0x76A}]},
{c:'TIPM',n:'Power Module',addrs:[{tx:0x74C,rx:0x76C},{tx:0x74C,rx:0x754}]},
{c:'ORC',n:'Airbag',addrs:[{tx:0x758,rx:0x760},{tx:0x747,rx:0x767},{tx:0x744,rx:0x74C},{tx:0x730,rx:0x738}]},
{c:'HVAC',n:'Climate',addrs:[{tx:0x751,rx:0x759},{tx:0x743,rx:0x763},{tx:0x688,rx:0x690},{tx:0x7A0,rx:0x7A8}]},
{c:'DTCM',n:'Transfer Case',addrs:[{tx:0x7E2,rx:0x7EA},{tx:0x7A6,rx:0x7AE}]},
{c:'SCCM',n:'Steering Column',addrs:[{tx:0x744,rx:0x764},{tx:0x763,rx:0x76B},{tx:0x750,rx:0x758}]},
{c:'DDM',n:'Driver Door',addrs:[{tx:0x748,rx:0x768},{tx:0x640,rx:0x648}]},
{c:'SGW',n:'Gateway',addrs:[{tx:0x74F,rx:0x76F},{tx:0x7C0,rx:0x7C8},{tx:0x6C0,rx:0x6C8}]}
];

const SKIM_OFF=[{v:'Trackhawk',base:0x2000,ks:18,kc:6},{v:'SRT',base:0x40C0,ks:18,kc:6}];
const IMMO_REC=24,IMMO_KC=8,IMMO_BLOCK=IMMO_REC*IMMO_KC;
function countSkimRecs(d,base){let c=0;for(let i=0;i<IMMO_KC;i++){const o=base+i*IMMO_REC;if(o+IMMO_REC>d.length)break;const r=d.slice(o,o+IMMO_REC);if(!r.every(b=>b===0xFF||b===0x00))c++;}return c;}
function syncImmoBackup(d){if(d.length<0x40C0+IMMO_BLOCK||d.length<0x2000+IMMO_BLOCK)return null;const o=new Uint8Array(d);for(let i=0;i<IMMO_BLOCK;i++)o[0x2000+i]=o[0x40C0+i];return o;}

/* ═══ VIN ═══ */
const TR={A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9};for(let d=0;d<=9;d++)TR[String(d)]=d;
const WT=[8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
const WMI={'1C4':'Chrysler US','2C3':'Dodge CA','1C6':'RAM US','2C4':'Chrysler CA','1J4':'Jeep US','1B3':'Dodge US','2B3':'Dodge CA','1J8':'Jeep US'};
const YR={A:2010,B:2011,C:2012,D:2013,E:2014,F:2015,G:2016,H:2017,J:2018,K:2019,L:2020,M:2021,N:2022,P:2023,R:2024,S:2025,T:2026};
function checkVin(v){if(!v||v.length!==17)return{ok:false};const u=v.toUpperCase();if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(u))return{ok:false,err:'Invalid chars'};let sum=0;for(let i=0;i<17;i++)sum+=(TR[u[i]]||0)*WT[i];const cd='0123456789X'[sum%11];return{ok:u[8]===cd,cd,wmi:u.slice(0,3),mfr:WMI[u.slice(0,3)]||'',yr:YR[u[9]]||'',err:u[8]!==cd?'Check digit: need '+cd:''};}
const hxb=d=>Array.from(d).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');

/* ═══ VIN YEAR PARSING (SAE J853 position 10 char → model year) ═══ */
const MODEL_YEAR_CODES={A:1980,B:1981,C:1982,D:1983,E:1984,F:1985,G:1986,H:1987,J:1988,K:1989,L:1990,M:1991,N:1992,P:1993,R:1994,S:1995,T:1996,V:1997,W:1998,X:1999,Y:2000,'1':2001,'2':2002,'3':2003,'4':2004,'5':2005,'6':2006,'7':2007,'8':2008,'9':2009};
const MODEL_YEAR_CODES_2010_PLUS={A:2010,B:2011,C:2012,D:2013,E:2014,F:2015,G:2016,H:2017,J:2018,K:2019,L:2020,M:2021,N:2022,P:2023,R:2024,S:2025,T:2026};
function parseVinYear(vin){
  if(!vin||vin.length!==17)return null;
  const c=vin[9].toUpperCase();
  // Position 7 being alpha indicates 2010+ (vs numeric for 1980-2009)
  const is2010Plus=/[A-Z]/.test(vin[6]);
  const year=is2010Plus?MODEL_YEAR_CODES_2010_PLUS[c]:MODEL_YEAR_CODES[c];
  return year||null;
}
function vinHasSGW(vin){
  const y=parseVinYear(vin);
  return y!==null&&y>=2018;
}

/* ═══ VIN CHECK DIGIT VALIDATION (SAE J853) ═══ */
const VIN_TRANSLIT={A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,'0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9};
const VIN_WEIGHTS=[8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
function vinCheckDigitValid(vin){
  if(!vin||vin.length!==17)return false;
  if(/[IOQ]/i.test(vin))return false;
  let total=0;
  for(let i=0;i<17;i++){
    if(i===8)continue;
    const v=VIN_TRANSLIT[vin[i].toUpperCase()];
    if(v===undefined)return false;
    total+=v*VIN_WEIGHTS[i];
  }
  const r=total%11;
  const expected=r===10?'X':String(r);
  return vin[8].toUpperCase()===expected;
}

/* ═══ AUTEL VCI STATE (persisted to localStorage) ═══ */
function getAutelState(){
  try{return JSON.parse(localStorage.getItem('srtlab_autel')||'{}');}
  catch{return{};}
}
function setAutelState(s){
  try{localStorage.setItem('srtlab_autel',JSON.stringify(s));return true;}
  catch{return false;}
}

/* ═══ OTP PROTECTION REGISTRY ═══
   One-Time-Programmable memory — a wrong write is PERMANENT.
   Source: vault/shared/module-database.ts protectionLevel flags */
const OTP_MODULES={
  PCM:{name:'Powertrain Control Module',warning:'PCM contains OTP memory. VIN write is PERMANENT and cannot be undone.',riskLevel:'danger',canReprogram:false},
  TCM:{name:'Transmission Control Module',warning:'TCM contains OTP memory. VIN write is PERMANENT. Confirm VIN and title match before proceeding.',riskLevel:'danger',canReprogram:false},
  ORC:{name:'Occupant Restraint Controller',warning:'ORC (Airbag) contains OTP memory. Do NOT write VIN unless physically replacing module. A wrong write bricks the airbag system.',riskLevel:'danger',canReprogram:false},
  AIRBAG:{name:'Occupant Restraint Controller',warning:'ORC (Airbag) contains OTP memory. Do NOT write VIN unless physically replacing module.',riskLevel:'danger',canReprogram:false},
};
function isOtpModule(code){return code?OTP_MODULES[code.toUpperCase()]!==undefined:false;}
function getOtpInfo(code){return code?OTP_MODULES[code.toUpperCase()]||null:null;}

/* ═══ NRC (Negative Response Code) descriptions — ISO 14229 ═══ */
const NRC_DESC={
  0x10:'generalReject',
  0x11:'serviceNotSupported',
  0x12:'subFunctionNotSupported',
  0x13:'incorrectMessageLengthOrInvalidFormat',
  0x14:'responseTooLong',
  0x21:'busyRepeatRequest',
  0x22:'conditionsNotCorrect',
  0x24:'requestSequenceError — restart session and retry',
  0x25:'noResponseFromSubnetComponent',
  0x26:'failurePreventsExecutionOfRequestedAction',
  0x31:'requestOutOfRange',
  0x33:'securityAccessDenied',
  0x35:'invalidKey — wrong algorithm',
  0x36:'exceededNumberOfAttempts — 3 tries used, module may be locked',
  0x37:'requiredTimeDelayNotExpired — wait 10 seconds',
  0x70:'uploadDownloadNotAccepted',
  0x71:'transferDataSuspended',
  0x72:'generalProgrammingFailure',
  0x73:'wrongBlockSequenceCounter',
  0x78:'requestCorrectlyReceivedResponsePending',
  0x7E:'subFunctionNotSupportedInActiveSession',
  0x7F:'serviceNotSupportedInActiveSession',
};
function nrcName(code){return NRC_DESC[code]||`unknown (0x${code.toString(16).toUpperCase().padStart(2,'0')})`;}
function nrcRetryStrategy(code){
  switch(code){
    case 0x78:return{retry:true,waitMs:1000,reason:'Response pending — ECU still processing'};
    case 0x24:return{retry:true,waitMs:500,reason:'Sequence error — restart session and retry'};
    case 0x37:return{retry:true,waitMs:10000,reason:'Required time delay — wait 10 seconds'};
    case 0x21:return{retry:true,waitMs:500,reason:'Busy repeat request'};
    default:return{retry:false,waitMs:0,reason:''};
  }
}

/* ═══ OBDLINK EX / STN ADAPTER INIT SEQUENCE ═══
   AlphaOBD-matched initialization for reliable FCA communication.
   Source: vault/srtfinal/AlphaOBDProtocol.ts initAlphaOBDStyle() */
const OBDLINK_INIT_STN=[
  {cmd:'ATZ',desc:'Full reset',waitMs:2000},
  {cmd:'ATE0',desc:'Echo off'},
  {cmd:'ATI',desc:'Get firmware version'},
  {cmd:'STDI',desc:'STN device identification'},
  {cmd:'AT@1',desc:'Device description'},
  {cmd:'ATRV',desc:'Read battery voltage'},
  {cmd:'ATPP2CSV81',desc:'Enable MFG extended mode (programmable param 2C=0x81)'},
  {cmd:'ATPP2CON',desc:'Activate PP 2C'},
  {cmd:'ATPP2DSV01',desc:'Set CAN protocol options (programmable param 2D=0x01)'},
  {cmd:'ATPP2DON',desc:'Activate PP 2D'},
  {cmd:'ATZ',desc:'Reset to apply PP changes',waitMs:1500},
  {cmd:'ATE0',desc:'Echo off (again after reset)'},
  {cmd:'ATL0',desc:'Linefeeds off'},
  {cmd:'ATS1',desc:'Spaces ON (required for response parsing)'},
  {cmd:'ATH1',desc:'Headers ON (show CAN IDs in response)'},
  {cmd:'ATSP6',desc:'Protocol 6 = ISO 15765-4 CAN (11-bit, 500 kbps)'},
  {cmd:'ATAT2',desc:'Adaptive timing aggressive'},
  {cmd:'ATST96',desc:'Timeout = 600ms'},
  {cmd:'ATCAF1',desc:'CAN Auto Formatting ON (STN handles ISO-TP natively)'},
  {cmd:'STCSWM1',desc:'STN silent wakeup mode'},
  {cmd:'ATFCSH7E0',desc:'Flow control header (overridden per-module later)'},
  {cmd:'ATFCSD300000',desc:'FC ContinueToSend, BS=0, STmin=0'},
  {cmd:'ATFCSM1',desc:'Flow control mode 1 (auto respond to FC)'},
];
const OBDLINK_INIT_GENERIC_ELM=[
  {cmd:'ATZ',desc:'Full reset',waitMs:2000},
  {cmd:'ATE0',desc:'Echo off'},
  {cmd:'ATI',desc:'Get firmware version'},
  {cmd:'ATL0',desc:'Linefeeds off'},
  {cmd:'ATS1',desc:'Spaces ON'},
  {cmd:'ATH1',desc:'Headers ON'},
  {cmd:'ATSP6',desc:'Protocol 6 = ISO 15765-4 CAN'},
  {cmd:'ATAT2',desc:'Adaptive timing aggressive'},
  {cmd:'ATST96',desc:'Timeout = 600ms'},
  {cmd:'ATCAF1',desc:'CAN Auto Formatting ON'},
  {cmd:'ATFCSM1',desc:'Flow control mode 1'},
];

/* ═══ EXPANDED RFHUB CRC DATABASE ═══
   Per-VIN (poly, init) pairs. Reversed VIN as key (RFHUB stores VIN backwards).
   Source: production_vin_patcher.py + rfhub_vin_patcher_final.py */
const RFHUB_CRC_DATABASE={
  '023697HF3TKXDC3C2':{poly:0x589B,init:0xFFFF,vin:'2C3CDXKT3FH796320',desc:'2015 Challenger Scat Pack'},
  '497095HB2TD5JC3B2':{poly:0x535D,init:0x0000,vin:'2B3CJ5DT2BH590794',desc:'2011 Challenger'},
  '860171HN49LXDC3C2':{poly:0x49BF,init:0x0000,vin:'2C3CDXL94NH171068',desc:'2022 Charger SRT'},
  '284372HG5GBACC3C2':{poly:0x95A5,init:0x0000,vin:'2C3CCABG5GH273482',desc:'2016 300 SRT'},
  '737605HK3JFZDC3C2':{poly:0x71DE,init:0x4625,vin:'2C3CDZFK3HH506737',desc:'2017 Charger Hellcat'},
  '059005HH29CZDC3C2':{poly:0x048E,init:0x4625,vin:'2C3CDZC92HH500950',desc:'2017 Charger'},
  '063822HJ2GAZDC3C2':{poly:0x0465,init:0x4625,vin:'2C3CDZAG2JH228360',desc:'2018 Charger SRT'},
  '033415HH99CZDC3C2':{poly:0x1189,init:0x0C99,vin:'2C3CDZC99HH514330',desc:'2017 Charger'},
  '558935HM1JGXDC3C2':{poly:0x5F08,init:0x0C99,vin:'2C3CDXGJ1MH539855',desc:'2021 Charger'},
  '783061HL89LZDC3C2':{poly:0xD5F1,init:0x4625,vin:'2C3CDZL98LH160387',desc:'2020 Charger'},
  '945003HA6VD4JC3B2':{poly:0x8C5B,init:0xFFFF,vin:'2B3CJ4DV6AH300549',desc:'2010 Challenger (variant A)'},
  /* Note: VIN 2B3CJ4DV6AH300549 has conflicting data in two source files.
     Alt pair: poly=0xCEA2, init=0x4625. Try primary first, then alt on fail. */
};
/* Brute-force init values for unknown VINs */
const RFHUB_CRC_INIT_CANDIDATES=[0x0000,0x4625,0xFFFF,0x0C99,0x1234,0x5555,0xAAAA,0x8000];

/* ═══ EXPANDED SECURITY ACCESS CONSTANTS ═══
   Shift-XOR constants per module type (32-bit seed, 5 iterations default).
   Source: security_access.py + seed-key-algorithms.ts */
const SECURITY_CONSTANTS={
  BCM:{constant:0x4B129F,iterations:5,algo:'shift-xor',desc:'Body Control Module'},
  PCM:{constant:0x8A3C71,iterations:3,algo:'shift-xor',desc:'Powertrain Control Module (3 iterations, not 5)'},
  ECM:{constant:0x8A3C71,iterations:3,algo:'shift-xor',desc:'Engine Control Module'},
  TCM:{constant:0x6E4B92,iterations:5,algo:'shift-xor',desc:'Transmission Control Module'},
  RFHUB:{constant:0xD5F1,iterations:5,algo:'shift-xor',desc:'RF Hub / SKIM'},
  ABS:{constant:0x3F8A21,iterations:5,algo:'shift-xor',desc:'Anti-lock Braking System'},
  CCM:{constant:0x9C4E67,iterations:5,algo:'shift-xor',desc:'Cabin Compartment / Climate'},
  AIRBAG:{constant:0x4B129F,iterations:5,algo:'shift-xor',desc:'Airbag / ORC'},
  IPC:{constant:0x4B129F,iterations:5,algo:'shift-xor',desc:'Instrument Panel Cluster'},
  HVAC:{constant:0x4B129F,iterations:5,algo:'shift-xor',desc:'HVAC Control'},
};
/* ROL5+XOR security levels (alternate algorithm — older modules) */
const ROL5_SECURITY_LEVELS={
  0x01:{constant:0x4B92,name:'CDA Engineering',desc:'Standard diagnostic access'},
  0x03:{constant:0x82F1,name:'Bootloader',desc:'Flash reprogramming access'},
  0x05:{constant:0x1209,name:'Atlantis EOL',desc:'Dealer-level EOL programming'},
};
/* Verified test vectors — use these to sanity-check the algorithm */
const SECURITY_TEST_VECTORS={
  'rol5-L1':{seed:0x1234,level:0x01,expectedKey:0xA426},
  'rol5-L3':{seed:0xABCD,level:0x03,expectedKey:0xF5AE},
  'rol5-L5':{seed:0xFFFF,level:0x05,expectedKey:0xEEF6},
  'sbec-1':{seed:0x2E2A,algo:'sbec',expectedKey:0x48C0,formula:'(seed*4)+0x9018 & 0xFFFF'},
  'sbec-2':{seed:0x1234,algo:'sbec',expectedKey:0x3908},
  'sbec-3':{seed:0xFFFF,algo:'sbec',expectedKey:0x5014},
  'crc-ccitt':{data:'123456789',algo:'crc16-ccitt-false',expectedCrc:0x29B1},
};

/* ═══ BCM EEPROM OFFSETS BY YEAR (internal EEPROM chip reads) ═══
   For reading VIN from internal BCM EEPROM after chip extraction.
   Source: universal_module_handler.py ModuleOffsets class */
function getBcmEepromOffsets(year){
  if(!year||year<2018)return{vin:0x0100,bnumber:0x0120,secret:0x0140,mirrored:true,desc:'BCM EEPROM 2015-2017'};
  return{vin:0x0200,bnumber:0x0220,secret:0x0240,mirrored:true,desc:'BCM EEPROM 2018-2023'};
}

/* ═══ BCM DFLASH FILE VARIANT DETECTION ═══
   GROUND-TRUTH VERIFIED against real 2018 Trackhawk BCM dump with VIN 1C4RJFDJXEC365477.
   BCM DFLASH files use Freescale FEE (Flash EEPROM Emulation) — VIN is stored in a
   journal with 4 entries, each 32 bytes: 17-byte VIN + 15-byte metadata.
   The metadata contains a sequence marker (0x88/0x89/0x8C/0x8D) indicating write order
   and a per-record ID (0x56/0x57/0x52/0x53).
   File signatures:
     - 64KB + "FEE1000" at offset 4 → BCM DFLASH (Freescale FEE journal)
     - Header "00c05aff" + 8KB → 95640 external SPI EEPROM dump */
const BCM_FILE_VARIANTS={
  'DFLASH_64K':{
    size:65536,
    signatureOffset:4,
    signatureBytes:[0x46,0x45,0x45,0x31,0x30,0x30,0x30],  // "FEE1000"
    vinOffsets:[0x5320,0x5340,0x5360,0x5380],  // verified against Trackhawk dump
    metadataOffset:17,  // metadata starts 17 bytes after VIN
    metadataLen:15,
    entryStride:32,     // 17 VIN + 15 metadata
    journalBased:true,
    desc:'BCM DFLASH 64KB (Freescale FEE journal)',
  },
  'EXT_STANDARD_A_64K':{
    size:65536,
    signatureOffset:null,  // no FEE1000, fallback detection by content
    vinOffsets:[0x1298,0x12B8,0x12D8,0x12F8],
    crcOffset:0x1318,
    checksumAlgorithm:'crc16-ccitt',
    journalBased:false,
    desc:'BCM Extended Standard A 64KB',
  },
  'EXT_STANDARD_B_64K':{
    size:65536,
    signatureOffset:null,
    vinOffsets:[0x1328,0x1348,0x1368,0x1388],
    crcOffset:0x13A8,
    checksumAlgorithm:'crc16-ccitt',
    journalBased:false,
    desc:'BCM Extended Standard B 64KB',
  },
  'COMPACT_STANDARD_32K':{
    size:32768,
    signatureOffset:null,
    vinOffsets:[0x1298,0x12B8,0x12D8,0x12F8],
    crcOffset:0x1318,
    checksumAlgorithm:'crc16-ccitt',
    journalBased:false,
    desc:'BCM Compact Standard 32KB',
  },
  'COMPACT_DFLASH_32K':{
    size:32768,
    signatureOffset:null,
    vinOffsets:[0x22B8,0x22D8,0x22F8,0x2318],
    crcOffset:0x2338,
    checksumAlgorithm:'crc16-ccitt',
    partialVinOffsets:[0x2098,0x20B0],  // last 8 chars of VIN
    journalBased:false,
    desc:'BCM Compact DFLASH 32KB',
  },
  'CFLASH_128K':{
    size:131072,
    signatureOffset:null,
    vinOffsets:[0x8298,0x82B8,0x82D8,0x82F8],
    crcOffset:0x8318,
    checksumAlgorithm:'crc16-ccitt',
    journalBased:false,
    desc:'BCM CFLASH 128KB',
  },
  /* GROUND-TRUTH VERIFIED: 17 Scat Pack BCM full flash dump (VIN 2B3CJ4DV6AH300549)
     has VINs at 0x12B8/0x12D8/0x12F8/0x1318 (stride 0x20) with FEE1000 header at offset 4.
     1MB = 1,048,576 bytes = full BCM flash (not just the DFLASH section). */
  'FULL_FLASH_1M':{
    size:1048576,
    signatureOffset:4,
    signatureBytes:[0x46,0x45,0x45,0x31,0x30,0x30,0x30],  // "FEE1000"
    vinOffsets:[0x12B8,0x12D8,0x12F8,0x1318],
    crcOffsetMode:'after-vin',  // CRC is at VIN+17 big-endian, 2 bytes
    checksumAlgorithm:'crc16-ccitt',
    entryStride:32,
    journalBased:false,
    desc:'BCM full flash 1MB (64KB DFLASH + 960KB program)',
  },
  'EEPROM_95640_8K':{
    size:8192,
    signatureOffset:0,
    signatureBytes:[0x00,0xC0,0x5A,0xFF,0x01,0x00,0xC6,0x11],  // verified pattern
    vinOffsets:[0x0275,0x0288],
    vinPrefix:[0x00,0x9E],  // 2-byte prefix before each VIN
    crcOffsetMode:'before-vin',  // CRC-8 at VIN-1
    checksumAlgorithm:'crc8-p26',
    journalBased:false,
    desc:'FCA 95640 external SPI EEPROM 8KB',
  },
  'EEPROM_95640_16K':{
    size:16384,
    signatureOffset:null,  // some dumps may or may not have the signature
    vinOffsets:[0x0275,0x0288],  // same layout, larger chip (double-size)
    crcOffsetMode:'before-vin',
    checksumAlgorithm:'crc8-p26',
    journalBased:false,
    desc:'FCA 95640 external SPI EEPROM 16KB (double-dump)',
  },
};

/* Detect BCM file variant from raw dump bytes.
   Returns variant key and metadata, or null if unknown. */
function detectBcmFileVariant(data){
  if(!data||data.length===0)return null;
  const size=data.length;

  // Check signature-based variants first (DFLASH, 95640 EEPROM)
  for(const[key,v]of Object.entries(BCM_FILE_VARIANTS)){
    if(v.size!==size||v.signatureBytes===undefined)continue;
    let match=true;
    for(let i=0;i<v.signatureBytes.length;i++){
      if(data[v.signatureOffset+i]!==v.signatureBytes[i]){match=false;break;}
    }
    if(match)return{key,...v};
  }

  // Fall back to content-based detection for the non-FEE variants
  if(size===65536){
    // Check Extended DFLASH indicator at 0x4097/0x4098-0x40A0
    if(data[0x4097]!==0xFF||!Array.from(data.slice(0x4098,0x40A0)).every(b=>b===0xFF)){
      // Extended DFLASH — NOTE: this is the legacy offset set from production_vin_patcher.
      // The real Trackhawk BCM uses DFLASH_64K (FEE journal) instead. Flag as AMBIGUOUS.
      return{key:'EXT_DFLASH_LEGACY_64K',size:65536,
        vinOffsets:[0x52B8,0x52D8,0x52F8,0x5318],
        crcOffset:0x5338,
        checksumAlgorithm:'crc16-ccitt',
        partialVinOffsets:[0x4098,0x40B0],
        journalBased:false,
        desc:'BCM Extended DFLASH 64KB (legacy — verify offset match!)',
        warning:'Ambiguous variant. If FEE1000 header absent at offset 4, offsets may differ. Cross-check with Bench Analyzer before patching.'};
    }
    if(data[0x1298]!==0xFF)return{key:'EXT_STANDARD_A_64K',...BCM_FILE_VARIANTS.EXT_STANDARD_A_64K};
    if(data[0x1328]!==0xFF)return{key:'EXT_STANDARD_B_64K',...BCM_FILE_VARIANTS.EXT_STANDARD_B_64K};
  }else if(size===32768){
    if(data[0x2097]!==0xFF)return{key:'COMPACT_DFLASH_32K',...BCM_FILE_VARIANTS.COMPACT_DFLASH_32K};
    return{key:'COMPACT_STANDARD_32K',...BCM_FILE_VARIANTS.COMPACT_STANDARD_32K};
  }else if(size===131072){
    return{key:'CFLASH_128K',...BCM_FILE_VARIANTS.CFLASH_128K};
  }
  return null;
}

/* ═══ MODULE DUMP SIZE VALIDATION ═══
   Source: ECMCalibrationManager.tsx validateBinFile().
   Known-valid sizes per module type — rejects obviously wrong files. */
const MODULE_VALID_SIZES={
  ECM:[0x40000,0x80000,0x100000],    // 256KB, 512KB, 1MB
  PCM:[0x40000,0x80000,0x100000],    // 256KB, 512KB, 1MB
  TCM:[0x20000,0x40000],             // 128KB, 256KB
  BCM:[0x8000,0x10000,0x20000,0x100000],  // 32KB, 64KB, 128KB, 1MB (full flash)
  GWAY:[0x20000,0x40000],            // 128KB, 256KB
  RFHUB:[0x1000,0x2000,0x4000],      // 4KB (EEE), 8KB, 16KB
  EEPROM_95640:[0x2000,0x4000],      // 8KB, 16KB
};

/* Sanity-check a module dump file. Returns {valid, warnings}. */
function validateModuleDump(data,moduleType){
  const warnings=[];
  if(!data||data.length===0){return{valid:false,warnings:['Empty file']};}
  const validSizes=MODULE_VALID_SIZES[moduleType]||[];
  if(validSizes.length&&!validSizes.includes(data.length)){
    warnings.push(`Unexpected size ${data.length.toLocaleString()} bytes for ${moduleType} (expected: ${validSizes.map(s=>(s/1024).toFixed(0)+'KB').join(' or ')})`);
  }
  // Scan for blank/corrupt patterns
  let ffCount=0,zeroCount=0;
  for(let i=0;i<data.length;i++){
    if(data[i]===0xFF)ffCount++;
    else if(data[i]===0x00)zeroCount++;
  }
  if(ffCount/data.length>0.95)warnings.push('File is >95% 0xFF — appears blank/erased');
  if(zeroCount/data.length>0.95)warnings.push('File is >95% 0x00 — appears corrupt');
  return{valid:warnings.length===0,warnings};
}

const MFG_SIGNATURES=[
  {name:'Continental',patterns:['CONTINENTAL','GPEC','VDO'],modules:['ECM','PCM']},
  {name:'Bosch',patterns:['BOSCH','EDC','ME'],modules:['ECM','PCM','ABS']},
  {name:'Delphi',patterns:['DELPHI','DELCO'],modules:['ECM','BCM']},
  {name:'Denso',patterns:['DENSO','112000-'],modules:['ECM']},
  {name:'Siemens',patterns:['SIEMENS','SIM'],modules:['ECM','TCM']},
  {name:'Magneti Marelli',patterns:['MAGNETI','MARELLI','IAW'],modules:['BCM','ECM']},
  {name:'Visteon',patterns:['VISTEON'],modules:['RFHUB','HVAC']},
];
/* Part number format patterns */
const PART_NUMBER_PATTERNS={
  BCM:[/^P?68\d{6}[A-Z]{2}$/,/^68\d{6}[A-Z]{2}$/],
  ECM:[/^P?05\d{6}[A-Z]{2}$/,/^GPEC[0-9A-Z]+$/],
  SKIM:[/^P?56\d{6}[A-Z]{2}$/],
  RFHUB:[/^MC9S12XEG/],
};
const TC={BCM:'#FF6D00','95640':'#AA00FF',RFHUB:'#2979FF',GPEC2A:'#00BFA5',FW:'#9E9E9E'};
const TL={BCM:'BCM D-FLASH','95640':'FCA 95640',RFHUB:'RFHUB EEE',GPEC2A:'GPEC2A',FW:'Firmware'};

/* ═══ Helpers for enhanced parser ═══ */
function extractVIN(data,offset,len){if(!len)len=17;if(offset+len>data.length)return null;const bytes=data.slice(offset,offset+len);for(let i=0;i<bytes.length;i++){if(bytes[i]<0x30||bytes[i]>0x5a)return null;}return String.fromCharCode.apply(null,bytes);}
function extractHex(data,offset,len){const r=[];for(let i=0;i<len;i++)r.push(data[offset+i].toString(16).padStart(2,"0").toUpperCase());return r.join(" ");}
function arrEq(a,b){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
function rd32(data,o){return(data[o]<<24)|(data[o+1]<<16)|(data[o+2]<<8)|data[o+3];}
function countAA50(d,s,n){let c=0;for(let i=0;i<n;i++)if(d[s+i*2]===0xaa&&d[s+i*2+1]===0x50)c++;return c;}
function countPat(d,a,b,c2,d2){let c=0;for(let i=0;i<d.length-3;i++)if(d[i]===a&&d[i+1]===b&&d[i+2]===c2&&d[i+3]===d2)c++;return c;}
const SKIM_VALUES={0x80:"ENABLED",0x00:"DISABLED",0x02:"DISABLED (alt)"};
const fO=n=>"0x"+n.toString(16).toUpperCase().padStart(4,"0");

/* ═══ Enhanced Module Parser (merged from analyzer) ═══ */
function parseModule(data,filename){
  const sz=data.length;let type='UNKNOWN';
  if(sz===65536||sz===131072){type='BCM';for(let i=0;i<256&&i+7<=sz;i++){if(data[i]===0x46&&String.fromCharCode.apply(null,data.slice(i,i+7))==='FEE1000'){type='BCM';break;}}}
  else if(sz===8192||sz===16384)type='95640';
  else if(sz===4096){let va=true;for(let i=0;i<17&&i<sz;i++){const b=data[i];if(!((b>=0x30&&b<=0x39)||(b>=0x41&&b<=0x5A))){va=false;break;}}if(va){const sk=data[0x0011];if(sk===0x80||sk===0x00||sk===0x02||extractVIN(data,0x01f0))type='GPEC2A';else type='GPEC2A';}else type='RFHUB';}
  else if(sz>131072)type='FW';

  const info={type,filename,data,size:sz,name:TL[type]||type,color:TC[type]||'#9E9E9E'};

  if(type==='GPEC2A'){
    info.vins=[{offset:0x0000,vin:extractVIN(data,0x0000)},{offset:0x01f0,vin:extractVIN(data,0x01f0)},{offset:0x0224,vin:extractVIN(data,0x0224)}].filter(v=>v.vin);
    info.skimByte=data[0x0011];
    info.skimStatus=SKIM_VALUES[data[0x0011]]||"UNKNOWN (0x"+data[0x0011].toString(16).toUpperCase()+")";
    info.secretKey={offset:0x0203,bytes:data.slice(0x0203,0x020b),hex:extractHex(data,0x0203,8)};
    info.secretKeyMirror={offset:0x0361,bytes:data.slice(0x0361,0x0369),hex:extractHex(data,0x0361,8)};
    info.keyConsistent=arrEq(data.slice(0x0203,0x020b),data.slice(0x0361,0x0369));
    info.skey=data.slice(0x0203,0x020b);info.skoff=0x0203;info.skmoff=0x0361;info.skb=info.skey.every(b=>b===0xFF);
    info.transponderKeys=[];
    for(let i=0;i<4;i++){const o=0x0888+i*4;info.transponderKeys.push({offset:o,hex:extractHex(data,o,4)});}
    info.zzzzTamper={offset:0x0c8c,hex:extractHex(data,0x0c8c,8),intact:data[0x0c8c]===0x5a};
    info.partNumberStr=extractVIN(data,0x0fa1,13)||extractHex(data,0x0fa1,13);
    info.runtimeCounters={
      counterA:{offset:0x0e61,value:rd32(data,0x0e61),hex:extractHex(data,0x0e61,4)},
      counterB:{offset:0x0e69,value:rd32(data,0x0e69),hex:extractHex(data,0x0e69,4)},
      distance:{offset:0x0e6d,value:rd32(data,0x0e6d),hex:extractHex(data,0x0e6d,4)},
      keyCycles:{offset:0x0e75,value:rd32(data,0x0e75),hex:extractHex(data,0x0e75,4)},
    };
  }else if(type==='RFHUB'){
    const knownOffsets=[0x0ea5,0x0eb9,0x0ecd,0x0ee1];
    const knownVins=knownOffsets.map(o=>{const v=extractVIN(data,o);if(v)return{offset:o,vin:v,mirrored:false,sc:o+17<sz?data[o+17]:0,cc:crc8rf(data.slice(o,o+17)),crcOk:o+17<sz&&data[o+17]===crc8rf(data.slice(o,o+17))};return null;}).filter(v=>v);
    if(knownVins.length>0)info.vins=knownVins;
    else{info.vins=[];for(const o of knownOffsets){if(o+17>sz)continue;const st=data.slice(o,o+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);if(/^[1-9A-HJ-NPR-Z]/.test(s)){const sc=o+17<sz?data[o+17]:0,cc=crc8rf(st);info.vins.push({offset:o,vin:s,mirrored:true,sc,cc,crcOk:sc===cc});}}}
    if(data.length>=0x051e)info.vehicleSecret={offset:0x050e,bytes:data.slice(0x050e,0x051e),hex:extractHex(data,0x050e,16),endian:"big"};
    info.fobikSlots=countAA50(data,0x0880,10);
    info.securityMarkers=countPat(data,0xcc,0x66,0xaa,0x55);
    info.zzzzBlocks=countPat(data,0x5a,0x5a,0x5a,0x5a);
    info.partNumbers={};
    const hw=extractVIN(data,0x0808,10),sw=extractVIN(data,0x0812,10),cal=extractVIN(data,0x082c,14);
    if(hw)info.partNumbers.hw=hw;else if(data.length>=0x0812)info.partNumbers.hw=extractHex(data,0x0808,10);
    if(sw)info.partNumbers.sw=sw;else if(data.length>=0x081c)info.partNumbers.sw=extractHex(data,0x0812,10);
    if(cal)info.partNumbers.cal=cal;else if(data.length>=0x083a)info.partNumbers.cal=extractHex(data,0x082c,14);
    info.skey=data.slice(0x40,0x50);info.skoff=0x40;info.skb=info.skey.every(b=>b===0xFF);
  }else if(type==='BCM'){
    info.vins=[0x5320,0x5340,0x5360,0x5380].map(o=>({offset:o,vin:extractVIN(data,o)})).filter(v=>v.vin);
    info.partialVins=[];
    for(const po of[0x4098,0x40B0]){if(po+10>sz)continue;let s='',ok=true;for(let j=0;j<8;j++){const b=data[po+j];if(b<0x20||b>0x7E){ok=false;break;}s+=String.fromCharCode(b);}if(ok&&s.length===8){const sc=(data[po+8]<<8)|data[po+9],cc=crc16(data.slice(po,po+8));info.partialVins.push({offset:po,tail:s,storedCrc:sc,calcCrc:cc,crcOk:sc===cc});}}
    info.vehicleSecret={offset:0x40c9,bytes:data.slice(0x40c9,0x40d9),hex:extractHex(data,0x40c9,16),endian:"little"};
    info.securityLock={offset:0x8028,value:data[0x8028],locked:data[0x8028]===0x5a};
    info.fobikCount=data[0x5862];
    info.immoKeys=[0x81a4,0x81c4,0x81e4].map(o=>({offset:o,hex:extractHex(data,o,16)}));
    info.fobikParts=extractVIN(data,0x5818,10)||extractHex(data,0x5818,10);
    info.skey=data.slice(0x40c9,0x40d9);info.skoff=0x40c9;info.skb=info.skey.every(b=>b===0xFF);info.skEndian='little';
    info.immoRecs=countSkimRecs(data,0x40C0);info.immoBlank=info.immoRecs===0;
    info.bakRecs=countSkimRecs(data,0x2000);info.bakBlank=info.bakRecs===0;
    info.immoSynced=info.immoRecs>0&&info.bakRecs>0&&arrEq(data.slice(0x40C0,0x40C0+IMMO_BLOCK),data.slice(0x2000,0x2000+IMMO_BLOCK));
  }else if(type==='95640'){
    info.vins=[];
    for(const off of[0x275,0x288]){const v=extractVIN(data,off);if(v)info.vins.push({offset:off,vin:v});}
    info.skey=data.slice(0x40,0x50);info.skoff=0x40;info.skb=info.skey.every(b=>b===0xFF);
    info.fobBlank=data.slice(0x200,0x240).every(b=>b===0xFF);
  }

  return info;
}

/* ═══ Cross-module validation ═══ */
function crossValidate(modules){
  const issues=[],warnings=[],passed=[];
  const allVins=new Set();
  modules.forEach(m=>{if(m.vins)m.vins.forEach(v=>allVins.add(v.vin));});
  if(allVins.size===0)warnings.push("No VINs found.");
  else if(allVins.size===1)passed.push("VIN consistent: "+Array.from(allVins)[0]);
  else issues.push("VIN MISMATCH: "+Array.from(allVins).join(", "));

  const rfhub=modules.find(m=>m.type==="RFHUB");
  const bcm=modules.find(m=>m.type==="BCM");
  const gpec=modules.find(m=>m.type==="GPEC2A");
  const e95=modules.find(m=>m.type==="95640");

  if(rfhub&&rfhub.vehicleSecret&&bcm&&bcm.vehicleSecret){
    const rev=Array.from(bcm.vehicleSecret.bytes).reverse();
    if(arrEq(new Uint8Array(Array.from(rfhub.vehicleSecret.bytes)),new Uint8Array(rev)))
      passed.push("RFHUB ↔ BCM vehicle secret: MATCH (byte-reversed)");
    else issues.push("RFHUB ↔ BCM vehicle secret: MISMATCH!");
  }
  if(gpec&&gpec.secretKey&&bcm)warnings.push("GPEC↔BCM key comparison requires manual check (8B vs 16B)");
  if(gpec){
    if(gpec.skimByte===0x80)passed.push("GPEC2A SKIM: ENABLED (0x80)");
    else if(gpec.skimByte===0x00)warnings.push("GPEC2A SKIM: DISABLED (0x00) — bypassed");
    if(!gpec.keyConsistent)issues.push("GPEC2A secret key INCONSISTENT (0x0203 vs 0x0361)!");
    else passed.push("GPEC2A secret key consistent (0x0203 = 0x0361)");
    if(gpec.zzzzTamper&&!gpec.zzzzTamper.intact)warnings.push("GPEC2A ZZZZ tamper: CLEARED");
    else if(gpec.zzzzTamper&&gpec.zzzzTamper.intact)passed.push("GPEC2A ZZZZ tamper: INTACT");
  }
  if(bcm&&bcm.securityLock){if(bcm.securityLock.locked)passed.push("BCM lock: 0x5A LOCKED");else warnings.push("BCM lock: UNLOCKED");}
  if(rfhub){passed.push("RFHUB FOBIK: "+rfhub.fobikSlots+" slots");passed.push("RFHUB CC66AA55: "+rfhub.securityMarkers);}
  if(bcm){passed.push("BCM FOBIK: "+bcm.fobikCount+" keys");if(rfhub&&rfhub.fobikSlots!==bcm.fobikCount)warnings.push("Key count mismatch: RFHUB="+rfhub.fobikSlots+" BCM="+bcm.fobikCount);}
  if(e95){if(!e95.skb)passed.push("95640 secret key: SET");else warnings.push("95640 secret key: ERASED");}
  if(e95&&rfhub&&!e95.skb&&!rfhub.skb){
    if(arrEq(e95.skey,rfhub.skey))passed.push("95640 ↔ RFHUB secret key: MATCH");
    else issues.push("95640 ↔ RFHUB secret key: MISMATCH!");
  }
  return{issues,warnings,passed};
}

/* ═══ Hex diff ═══ */
function computeDiff(a,b){
  const changes=[],len=Math.max(a.length,b.length);
  for(let i=0;i<len;i++){if((a[i]||0)!==(b[i]||0))changes.push(i);}
  const groups=[];
  if(changes.length){let s=changes[0],p=changes[0];for(let i=1;i<changes.length;i++){if(changes[i]>p+1){groups.push([s,p]);s=changes[i];}p=changes[i];}groups.push([s,p]);}
  return{totalChanged:changes.length,groups,changedSet:new Set(changes)};
}

/* ═══ File analysis (legacy for DUMPS tab) ═══ */
function analyzeFile(buf,name){const data=new Uint8Array(buf);const sz=data.length;let type='unknown';
  if(sz===65536||sz===131072)type='BCM';else if(sz===8192||sz===16384)type='95640';else if(sz===4096){let a=true;for(let i=0;i<17&&i<sz;i++)if(data[i]<0x30||data[i]>0x5A){a=false;break;}type=a?'GPEC2A':'RFHUB';}else if(sz>131072)type='FW';
  const vins=[],partials=[];
  if(type==='RFHUB'){for(const off of[0xEA5,0xEB9,0xECD,0xEE1]){if(off+17>sz)continue;const st=data.slice(off,off+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);const sc=data[off+17],cc=crc8rf(st);vins.push({off,vin:s,algo:'c8',coff:off+17,sc,cc,ok:sc===cc,cv:checkVin(s),mirrored:true});}}
  else if(type==='GPEC2A'){for(const off of[0,0x1F0,0x224]){if(off+17>sz)continue;let s='',v=true;for(let j=0;j<17;j++){const b=data[off+j];if(b<0x20||b>0x7E){v=false;break;}s+=String.fromCharCode(b);}if(v&&/^[1-9A-HJ-NPR-Z]/.test(s))vins.push({off,vin:s,algo:'none',coff:-1,ok:true,cv:checkVin(s)});}}
  else if(type==='95640'){for(const off of[0x275,0x288]){if(off+17>sz)continue;let s='',v=true;for(let j=0;j<17;j++){const b=data[off+j];if(b<0x20||b>0x7E){v=false;break;}s+=String.fromCharCode(b);}if(!v||!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))continue;const sc=data[off-1],cc=crc8_42(data.slice(off,off+17));vins.push({off,vin:s,algo:'c8',coff:off-1,sc,cc,ok:sc===cc,cv:checkVin(s)});}}
  else if(type==='BCM'||type==='FW'){for(let i=0;i<=sz-19;i++){let v=true;for(let j=0;j<17;j++)if(data[i+j]<0x20||data[i+j]>0x7E){v=false;break;}if(!v)continue;let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(data[i+j]);if(!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))continue;const cv=checkVin(s);if(!cv.ok)continue;const sc=(data[i+17]<<8)|data[i+18],cc=crc16(data.slice(i,i+17));if(sc===cc){vins.push({off:i,vin:s,algo:'c16',coff:i+17,sc,cc,ok:true,cv});i+=16;}}
    if(type==='BCM'){for(const po of[0x4098,0x40B0]){if(po+10>sz)continue;let s='',ok=true;for(let j=0;j<8;j++){const b=data[po+j];if(b<0x20||b>0x7E){ok=false;break;}s+=String.fromCharCode(b);}if(!ok||s.length!==8)continue;const sc=(data[po+8]<<8)|data[po+9],cc=crc16(data.slice(po,po+8));partials.push({off:po,vin:s,algo:'c16',coff:po+8,sc,cc});}}
    else if(vins.length>0){const tail=vins[0].vin.slice(9);const tc=[];for(let k=0;k<8;k++)tc.push(tail.charCodeAt(k));for(let i=0;i<=sz-10;i++){let m=true;for(let j=0;j<8;j++)if(data[i+j]!==tc[j]){m=false;break;}if(!m)continue;if(vins.some(fv=>i>=fv.off&&i<fv.off+17))continue;const sc=(data[i+8]<<8)|data[i+9],cc=crc16(data.slice(i,i+8));if(sc===cc)partials.push({off:i,vin:tail,algo:'c16',coff:i+8,sc,cc});}}}
  let sec=null;
  if(type==='BCM'){sec={t:'bcm'};sec.immoRecs=countSkimRecs(data,0x40C0);sec.b1=sec.immoRecs===0;sec.bakRecs=countSkimRecs(data,0x2000);sec.b2=sec.bakRecs===0;sec.immoSynced=sec.immoRecs>0&&sec.bakRecs>0&&arrEq(data.slice(0x40C0,0x40C0+IMMO_BLOCK),data.slice(0x2000,0x2000+IMMO_BLOCK));}
  else if(type==='95640'){sec={t:'95640'};sec.key=data.slice(0x40,0x50);sec.kb=sec.key.every(b=>b===0xFF);sec.fob=data.slice(0x200,0x240);sec.fb=sec.fob.every(b=>b===0xFF);}
  else if(type==='RFHUB'){sec={t:'rfhub'};sec.key=data.slice(0x40,0x50);sec.kb=sec.key.every(b=>b===0xFF);}
  else if(type==='GPEC2A'){sec={t:'gpec2a'};sec.skim=data[0x11];sec.on=data[0x11]===0x80;sec.key=data.slice(0x203,0x20B);sec.mir=data.slice(0x361,0x369);sec.km=true;for(let j=0;j<8;j++)if(sec.key[j]!==sec.mir[j]){sec.km=false;break;}sec.tr=[];for(let i=0;i<4;i++)sec.tr.push(data.slice(0x888+i*4,0x888+i*4+4));sec.zz=data[0xC8C]===0x5A;}
  return{name,size:sz,type,data,vins,partials,sec};}

function patchFile(f,nv){const out=new Uint8Array(f.data);const vb=new TextEncoder().encode(nv.toUpperCase());const log=[];
  for(const s of f.vins){if(s.mirrored){const m=[...vb].reverse();for(let j=0;j<17;j++)out[s.off+j]=m[j];const stored=new Uint8Array(m);out[s.coff]=crc8rf(stored);log.push('0x'+s.off.toString(16).toUpperCase()+' mirrored CRC8');}else{for(let j=0;j<17;j++)out[s.off+j]=vb[j];if(s.algo==='c16'){const c=crc16(vb);out[s.coff]=(c>>8)&0xFF;out[s.coff+1]=c&0xFF;log.push('0x'+s.off.toString(16).toUpperCase()+' CRC16');}else if(s.algo==='c8'){const c=crc8_42(vb);out[s.coff]=c;log.push('0x'+s.off.toString(16).toUpperCase()+' CRC8');}else log.push('0x'+s.off.toString(16).toUpperCase());}}
  if(f.partials){const tb=new TextEncoder().encode(nv.toUpperCase().slice(9));for(const s of f.partials){for(let j=0;j<8;j++)out[s.off+j]=tb[j];const c=crc16(tb);out[s.coff]=(c>>8)&0xFF;out[s.coff+1]=c&0xFF;log.push('0x'+s.off.toString(16).toUpperCase()+' partial');}}
  if(f.type==='BCM'&&out.length>=0x40C0+IMMO_BLOCK&&out.length>=0x2000+IMMO_BLOCK){for(let i=0;i<IMMO_BLOCK;i++)out[0x2000+i]=out[0x40C0+i];log.push('IMMO backup synced');}
  return{data:out,log};}

function virginizeFile(f){const out=new Uint8Array(f.data);const log=[];
  if(f.type==='BCM'){f.vins.forEach(v=>{for(let j=0;j<19;j++)out[v.off+j]=0;});f.partials?.forEach(v=>{for(let j=0;j<10;j++)out[v.off+j]=0;});[0x2000,0x40C0].forEach(o=>{for(let i=0;i<IMMO_BLOCK;i++)out[o+i]=0xFF;});log.push('VINs+CRC zeroed, SKIM cleared');}
  else if(f.type==='95640'){[0x275,0x288].forEach(o=>{for(let j=-1;j<17;j++)out[o+j]=0;});for(let i=0;i<16;i++)out[0x40+i]=0xFF;log.push('VINs+CRC+key cleared');}
  else if(f.type==='RFHUB'){[0xEA5,0xEB9,0xECD,0xEE1].forEach(o=>{for(let j=0;j<18;j++)out[o+j]=0;});for(let i=0;i<16;i++)out[0x40+i]=0xFF;for(let i=0;i<64;i++)out[0x200+i]=0xFF;log.push('VINs+key+fobs cleared');}
  else if(f.type==='GPEC2A'){[0,0x1F0,0x224].forEach(o=>{for(let j=0;j<17;j++)out[o+j]=0;});log.push('VINs cleared');}
  return{data:out,log};}

/* ═══ Module VIN writer for enhanced parser ═══ */
function writeModuleVIN(data,type,vin,existingVins){
  if(vin.length!==17)return null;
  const out=new Uint8Array(data);const vb=new TextEncoder().encode(vin);
  let offs;
  if(type==='GPEC2A')offs=[0x0000,0x01f0,0x0224];
  else if(type==='BCM')offs=[0x5320,0x5340,0x5360,0x5380];
  else if(type==='RFHUB'&&existingVins&&existingVins.length>0)offs=existingVins.map(v=>v.offset);
  else if(type==='RFHUB')offs=[0x0ea5,0x0eb9,0x0ecd,0x0ee1];
  else if(type==='95640')offs=[0x275,0x288];
  else offs=[];
  const hasMirrored=existingVins&&existingVins.some(v=>v.mirrored);
  /* RFHUB EEE CRC: The byte at VIN+17 is a per-VIN checksum, but the exact algorithm
     used by MC9S12XEG384 RFHUB is NOT verified against real dumps. The crc8rf
     (poly=0xA0 reflected, init=0x54) matches SRTLabVINPatcher source but produces
     wrong values on real RFHUB dumps. Until validated, PRESERVE the existing CRC
     byte rather than overwriting with a guess that might brick the module. */
  if(type==='RFHUB'&&hasMirrored){const mr=[...vb].reverse();offs.forEach(o=>{for(let i=0;i<17;i++)out[o+i]=mr[i];/* CRC at o+17 intentionally NOT overwritten — algorithm unverified */});}
  else{offs.forEach(o=>{for(let i=0;i<17;i++)out[o+i]=vb[i];});}
  if(type==='BCM'){offs.forEach(o=>{const c=crc16(vb);out[o+17]=(c>>8)&0xFF;out[o+18]=c&0xFF;});
    const tb=new TextEncoder().encode(vin.slice(9));for(const po of[0x4098,0x40B0]){if(po+10>out.length)continue;for(let i=0;i<8;i++)out[po+i]=tb[i];const c=crc16(tb);out[po+8]=(c>>8)&0xFF;out[po+9]=c&0xFF;}}
  /* 95640 EEPROM CRC: VERIFIED against real dump — VIN "1C4RJFDJ7DC513874" → 0x9E.
     CRC-8 poly=0x26 init=0x00, stored 1 byte BEFORE each VIN (at o-1) */
  if(type==='95640')offs.forEach(o=>{out[o-1]=crc8p26(vb);});
  if(type==='RFHUB'&&!hasMirrored){/* non-mirrored case: CRC unverified, preserve existing */}
  if(type==='BCM'&&out.length>=0x40C0+IMMO_BLOCK&&out.length>=0x2000+IMMO_BLOCK)for(let i=0;i<IMMO_BLOCK;i++)out[0x2000+i]=out[0x40C0+i];
  return out;
}

function virginizeModule(data,type){
  const o=new Uint8Array(data);
  if(type==='GPEC2A'){o[0x0011]=0x00;for(let i=0x0203;i<0x020b;i++)o[i]=0x00;for(let i=0x0361;i<0x0369;i++)o[i]=0x00;for(let i=0x0888;i<0x0899;i++)o[i]=0xff;for(let i=0x0c8c;i<0x0c94;i++)o[i]=0x00;}
  else if(type==='RFHUB'){[0xEA5,0xEB9,0xECD,0xEE1].forEach(off=>{for(let j=0;j<18;j++)o[off+j]=0;});for(let i=0;i<16;i++)o[0x40+i]=0xFF;for(let i=0;i<64;i++)o[0x200+i]=0xFF;}
  else if(type==='BCM'){[0x5320,0x5340,0x5360,0x5380].forEach(off=>{for(let j=0;j<19;j++)o[off+j]=0;});[0x2000,0x40C0].forEach(base=>{for(let i=0;i<IMMO_BLOCK;i++)o[base+i]=0xFF;});}
  else if(type==='95640'){[0x275,0x288].forEach(off=>{for(let j=-1;j<17;j++)o[off+j]=0;});for(let i=0;i<16;i++)o[0x40+i]=0xFF;}
  return o;
}

/* ═══ DESIGN ═══ */
const C={bg:'#F4F1EC',cd:'#FFF',c2:'#FAF9F7',sr:'#D32F2F',sl:'#FF5252',bk:'#1A1A1A',a1:'#FF6D00',a2:'#00BFA5',a3:'#2979FF',a4:'#AA00FF',tx:'#1A1A1A',ts:'#5A5A5A',tm:'#9E9E9E',bd:'#E8E4DE',gn:'#00C853',wn:'#FFB300',er:'#FF1744'};
function Card({children,style={},glow,onClick}){const[h,setH]=useState(false);return<div onClick={onClick} onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)} style={{background:C.cd,borderRadius:16,padding:22,border:`1.5px solid ${h&&onClick?C.sr:C.bd}`,boxShadow:h&&onClick?'0 8px 32px rgba(211,47,47,0.12)':'0 2px 16px rgba(0,0,0,0.06)',transition:'all 0.3s',transform:h&&onClick?'translateY(-2px)':'none',cursor:onClick?'pointer':'default',position:'relative',overflow:'hidden',...style}}>{glow&&<div style={{position:'absolute',top:-40,right:-40,width:120,height:120,borderRadius:'50%',background:'radial-gradient(circle,#FF525215,transparent 70%)',pointerEvents:'none'}}/>}<div style={{position:'relative',zIndex:1}}>{children}</div></div>;}
function Tag({children,color=C.sr}){return<span style={{fontSize:10,fontWeight:800,padding:'3px 10px',borderRadius:8,background:color+'14',color,letterSpacing:.5,display:'inline-block',marginLeft:4}}>{children}</span>;}
function Btn({children,onClick,disabled,color=C.sr,full,outline}){const[h,setH]=useState(false);return<button onClick={onClick} disabled={disabled} onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)} style={{padding:'10px 20px',borderRadius:10,fontFamily:"'Nunito'",fontWeight:800,fontSize:12,border:outline?`2px solid ${color}33`:'none',cursor:disabled?'not-allowed':'pointer',background:disabled?'#E8E4DE':outline?(h?color+'10':'transparent'):(h?color:color+'DD'),color:disabled?C.tm:outline?color:'#fff',width:full?'100%':undefined,transition:'all 0.2s',letterSpacing:.5}}>{children}</button>;}
function SLine({type,msg}){const col={error:C.er,warn:C.wn,pass:C.gn};const ico={error:'✗',warn:'⚠',pass:'✓'};return<div style={{fontSize:12,color:col[type],padding:'4px 0',display:'flex',gap:8}}><span style={{fontWeight:700,minWidth:14}}>{ico[type]}</span><span>{msg}</span></div>;}
const TABS=[
  {id:'program',i:'🚀',l:'PROGRAM ALL',s:'BCM→RFHUB→ECM→ADCM'},
  {id:'vinprog',i:'🎯',l:'VIN PROGRAMMER',s:'All modules · 0xF190'},
  {id:'topology',i:'🗺️',l:'TOPOLOGY',s:'DTC · VIN · Health'},
  {id:'bcm',i:'🧠',l:'BCM',s:'VIN · CRC · Features'},
  {id:'rfhub',i:'🔑',l:'RFHUB',s:'VIN · Key Fobs'},
  {id:'ecm',i:'⚡',l:'ECM',s:'VIN · Tune · Cal'},
  {id:'adcm',i:'🏎️',l:'ACTIVE DAMPING',s:'VIN · Variant'},
  {id:'uds',i:'🔬',l:'UDS PROGRAMMER',s:'Universal · Raw'},
  {id:'backups',i:'💾',l:'BACKUPS',s:'History · Restore'},
  {id:'sessions',i:'📋',l:'SESSIONS',s:'Paper Trail · Reports'},
  {id:'autel',i:'🔐',l:'AUTEL SGW',s:'MaxiFlash VCI · J2534'},
  {id:'jailbreak',i:'💀',l:'JAILBREAK',s:'SRT · Demon · Hellcat'},
  {id:'dumps',i:'📂',l:'DUMPS',s:'VIN · Hex · Virginize'},
  {id:'obd',i:'📡',l:'LIVE OBD',s:'UDS · Scan · Write'},
  {id:'bench',i:'🔧',l:'BENCH',s:'Offline · Dumps'},
  {id:'seed',i:'🔑',l:'SEED→KEY',s:'14 Algorithms'},
  {id:'gpec',i:'🔓',l:'GPEC',s:'FW Unlock'},
  {id:'skim',i:'🛡️',l:'SECURITY',s:'Cross-Match'},
  {id:'gpec2a',i:'⚙️',l:'GPEC2A',s:'SKIM · Tamper'},
  {id:'analyzer',i:'🔬',l:'ANALYZER',s:'GPEC · RFHUB · BCM'},
];

/* ═══ MASTER VIN CONTEXT — shared across all module programmer tabs ═══ */
const MasterVinContext = React.createContext({vin:'',setVin:()=>{},moduleStatus:{},setModuleStatus:()=>{},setPg:()=>{}});

/* ═══ APP ═══ */
export default function App(){
  const[pg,setPg]=useState('program');
  const[files,setFiles]=useState([]);
  const[masterVin,setMasterVin]=useState('');
  /* Track program status per module: 'pending' | 'writing' | 'ok' | 'fail' */
  const[moduleStatus,setModuleStatus]=useState({BCM:'pending',RFHUB:'pending',ECM:'pending',ADCM:'pending'});
  const loadF=useCallback(fl=>{Promise.all(Array.from(fl).map(f=>new Promise(r=>{const rd=new FileReader();rd.onload=e=>r(analyzeFile(e.target.result,f.name));rd.readAsArrayBuffer(f);}))).then(res=>setFiles(p=>[...p,...res.filter(f=>f.type!=='unknown')]));},[]);
  const vinValid=masterVin.length===17&&/^[A-HJ-NPR-Z0-9]{17}$/i.test(masterVin);
  return<MasterVinContext.Provider value={{vin:masterVin,setVin:setMasterVin,moduleStatus,setModuleStatus,setPg}}>
  <div style={{minHeight:'100vh',background:C.bg,color:C.tx,fontFamily:"'Nunito',sans-serif"}}>
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;600;700&family=Righteous&display=swap" rel="stylesheet"/>
    <div style={{background:'linear-gradient(135deg,#1A1A1A 0%,#2D2D2D 40%,#D32F2F 100%)',position:'relative',overflow:'hidden'}}>
      <div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse at 80% 50%,rgba(255,82,82,0.3),transparent 60%)',pointerEvents:'none'}}/>
      <div style={{position:'relative',padding:'22px 28px 0',display:'flex',alignItems:'center',gap:14}}>
        <div style={{width:46,height:46,borderRadius:13,background:'linear-gradient(135deg,#FF5252,#D32F2F)',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 4px 20px rgba(211,47,47,0.4)'}}><span style={{fontFamily:"'Righteous'",fontSize:22,color:'#fff'}}>S</span></div>
        <div><div style={{fontFamily:"'Righteous'",fontSize:26,color:'#fff',letterSpacing:2}}>SRT LAB</div><div style={{fontSize:9,color:'rgba(255,255,255,0.4)',fontWeight:700,letterSpacing:6}}>JAILBREAK EDITION</div></div>
        {/* Master VIN inline in header */}
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:10,padding:'8px 14px',background:'rgba(0,0,0,0.3)',borderRadius:10,border:'1px solid rgba(255,255,255,0.15)'}}>
          <div style={{fontSize:9,color:'rgba(255,255,255,0.5)',fontWeight:800,letterSpacing:2}}>MASTER VIN</div>
          <input value={masterVin} onChange={e=>setMasterVin(e.target.value.toUpperCase().replace(/\s/g,'').slice(0,17))} maxLength={17} placeholder="17 characters" style={{width:190,padding:'6px 10px',border:'1.5px solid '+(masterVin.length===0?'rgba(255,255,255,0.2)':vinValid?'#00E676':'#FF5252'),borderRadius:6,fontSize:13,fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:1.5,background:'rgba(0,0,0,0.4)',color:'#fff',outline:'none'}}/>
          <div style={{fontSize:10,fontFamily:"'JetBrains Mono'",fontWeight:700,color:vinValid?'#00E676':masterVin.length===0?'rgba(255,255,255,0.4)':'#FF5252'}}>{masterVin.length}/17</div>
        </div>
      </div>
      {/* Module status strip — visible across all tabs */}
      {vinValid&&<div style={{padding:'8px 28px',background:'rgba(0,0,0,0.25)',display:'flex',gap:12,alignItems:'center',fontSize:10,fontFamily:"'JetBrains Mono'",fontWeight:700}}>
        <span style={{color:'rgba(255,255,255,0.4)',letterSpacing:2}}>BENCH STATUS:</span>
        {['BCM','RFHUB','ECM','ADCM'].map(m=>{
          const st=moduleStatus[m];
          const col={pending:'#999',writing:'#FFB300',ok:'#00E676',fail:'#FF5252'}[st];
          const icon={pending:'○',writing:'⏳',ok:'✓',fail:'✗'}[st];
          return<span key={m} style={{color:col,display:'flex',alignItems:'center',gap:4}}>
            {icon} {m}
          </span>;
        })}
        {/* Year + SGW indicator */}
        {(()=>{
          const y=parseVinYear(masterVin);
          const sgw=vinHasSGW(masterVin);
          const cdValid=vinCheckDigitValid(masterVin);
          return<>
            <span style={{marginLeft:'auto',color:'rgba(255,255,255,0.4)',letterSpacing:2}}>YEAR:</span>
            <span style={{color:y?'#E0E0E0':'#FF5252'}}>{y||'?'}</span>
            <span style={{color:'rgba(255,255,255,0.4)',letterSpacing:2}}>·</span>
            <span style={{color:sgw?'#FFB300':'#00E676'}}>{sgw?'🔐 SGW REQ':'🔓 DIRECT OK'}</span>
            <span style={{color:'rgba(255,255,255,0.4)',letterSpacing:2}}>·</span>
            <span style={{color:cdValid?'#00E676':'#FFB300'}}>{cdValid?'✓ VIN CHKSUM':'⚠ VIN CHKSUM'}</span>
          </>;
        })()}
      </div>}
      <div style={{display:'flex',padding:'12px 16px 0',overflowX:'auto',gap:2}}>
        {TABS.map(t=>{const a=pg===t.id;return<button key={t.id} onClick={()=>setPg(t.id)} style={{padding:'11px 16px 13px',border:'none',cursor:'pointer',background:a?C.bg:'transparent',borderRadius:'11px 11px 0 0',color:a?C.sr:'rgba(255,255,255,0.4)',fontFamily:"'Nunito'",fontWeight:a?900:700,fontSize:11,letterSpacing:1.2,transition:'all 0.25s',boxShadow:a?'0 -4px 16px rgba(0,0,0,0.06)':'none',whiteSpace:'nowrap'}}><span style={{fontSize:14,marginRight:4,filter:a?'none':'grayscale(1) brightness(2)'}}>{t.i}</span>{t.l}<div style={{fontSize:7,marginTop:1,opacity:.4}}>{t.s}</div></button>;})}
      </div>
    </div>
    <div style={{maxWidth:1100,margin:'0 auto',padding:'22px 22px 60px'}}>
      {pg==='program'&&<ProgramAllTab/>}
      {pg==='vinprog'&&<VinProgrammerTab/>}
      {pg==='topology'&&<TopologyTab/>}
      {pg==='bcm'&&<BcmTab/>}
      {pg==='rfhub'&&<RfhubTab/>}
      {pg==='ecm'&&<EcmTab/>}
      {pg==='adcm'&&<AdcmTab/>}
      {pg==='uds'&&<UdsTab/>}
      {pg==='backups'&&<BackupsTab/>}
      {pg==='sessions'&&<SessionsTab/>}
      {pg==='autel'&&<AutelTab/>}
      {pg==='jailbreak'&&<JailbreakTab/>}
      {pg==='dumps'&&<DumpsTab files={files} setFiles={setFiles} loadF={loadF}/>}
      {pg==='obd'&&<OBDTab/>}
      {pg==='bench'&&<BenchTab/>}
      {pg==='seed'&&<SeedTab/>}
      {pg==='gpec'&&<GpecTab/>}
      {pg==='skim'&&<SecurityTab/>}
      {pg==='gpec2a'&&<Gpec2aTab/>}
      {pg==='analyzer'&&<FcaAnalyzerTab/>}
    </div></div>
  </MasterVinContext.Provider>;
}

/* ═══ BENCH TAB ═══ */
function BenchTab(){
  const[mods,setMods]=useState([]);const[nv,setNv]=useState('');const[msg,setMsg]=useState('');const[log,setLog]=useState([]);
  const[benchConn,setBenchConn]=useState(false);const[benchBusy,setBenchBusy]=useState('');
  const benchEng=useRef(null);
  const addLog=(m,l='info')=>setLog(p=>[...p,{m,l,t:new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}]);
  const dl=(d,n)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();};

  const loadFiles=useCallback(fl=>{
    Array.from(fl).forEach(f=>{
      const r=new FileReader();
      r.onload=ev=>{
        const d=new Uint8Array(ev.target.result);
        const m=parseModule(d,f.name);
        if(m.type!=='UNKNOWN'){setMods(p=>[...p,m]);addLog('Loaded '+m.name+': '+f.name,'info');
          if(m.vins?.[0])addLog('  VIN: '+m.vins[0].vin,'rx');
        }else addLog('Unknown file: '+f.name,'error');
      };r.readAsArrayBuffer(f);
    });
  },[]);

  const writeAllVins=useCallback(()=>{
    if(nv.length!==17)return;
    mods.forEach((m,i)=>{
      const patched=writeModuleVIN(m.data,m.type,nv,m.vins);
      if(patched){dl(patched,'VIN_'+nv+'_'+m.filename);addLog(m.name+': VIN patched → '+nv,'rx');
        setMods(p=>{const u=[...p];u[i]=parseModule(patched,m.filename);return u;});
      }
    });
    setMsg('All modules patched with '+nv);
  },[mods,nv]);

  const doVirginRfhub=useCallback(()=>{
    const rf=mods.find(m=>m.type==='RFHUB');
    if(!rf){addLog('No RFHUB loaded','error');return;}
    const v=virginizeModule(rf.data,'RFHUB');
    dl(v,'VIRGIN_'+rf.filename);addLog('RFHUB virginized (bench)','rx');setMsg('RFHUB virginized');
  },[mods]);

  const doCrcPatch=useCallback(()=>{
    if(!mods.length){addLog('No modules loaded','error');return;}
    let patched=0;
    mods.forEach((m,idx)=>{
      const out=new Uint8Array(m.data);let fixes=0;
      if(m.type==='BCM'){
        for(let i=0;i<=out.length-19;i++){
          let v=true;for(let j=0;j<17;j++)if(out[i+j]<0x20||out[i+j]>0x7E){v=false;break;}
          if(!v)continue;let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(out[i+j]);
          if(!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))continue;
          const sc=(out[i+17]<<8)|out[i+18],cc=crc16(out.slice(i,i+17));
          if(sc!==cc){out[i+17]=(cc>>8)&0xFF;out[i+18]=cc&0xFF;addLog('  '+m.name+' @0x'+i.toString(16).toUpperCase()+': CRC16 '+sc.toString(16).toUpperCase()+' → '+cc.toString(16).toUpperCase(),'rx');fixes++;}
          i+=16;
        }
        for(const po of[0x4098,0x40B0]){if(po+10>out.length)continue;
          let pk=true;for(let j=0;j<8;j++)if(out[po+j]<0x20||out[po+j]>0x7E){pk=false;break;}if(!pk)continue;
          const sc=(out[po+8]<<8)|out[po+9],cc=crc16(out.slice(po,po+8));
          if(sc!==cc){out[po+8]=(cc>>8)&0xFF;out[po+9]=cc&0xFF;addLog('  '+m.name+' @0x'+po.toString(16).toUpperCase()+': partial CRC16 '+sc.toString(16).toUpperCase()+' → '+cc.toString(16).toUpperCase(),'rx');fixes++;}}
      }else if(m.type==='95640'){
        for(const off of[0x275,0x288]){if(off+17>out.length)continue;
          let v=true;for(let j=0;j<17;j++)if(out[off+j]<0x20||out[off+j]>0x7E){v=false;break;}if(!v)continue;
          const sc=out[off-1],cc=crc8_42(out.slice(off,off+17));
          if(sc!==cc){out[off-1]=cc;addLog('  '+m.name+' @0x'+off.toString(16).toUpperCase()+': CRC8 '+sc.toString(16).toUpperCase()+' → '+cc.toString(16).toUpperCase(),'rx');fixes++;}
        }
      }else if(m.type==='RFHUB'){
        for(const off of[0xEA5,0xEB9,0xECD,0xEE1]){if(off+18>out.length)continue;
          const st=out.slice(off,off+17);if(st.every(b=>b===0xFF||b===0))continue;
          const cc=crc8rf(st),sc=out[off+17];
          if(sc!==cc){out[off+17]=cc;addLog('  '+m.name+' @0x'+off.toString(16).toUpperCase()+': CRC8 '+sc.toString(16).toUpperCase()+' → '+cc.toString(16).toUpperCase(),'rx');fixes++;}
        }
      }
      if(fixes>0){dl(out,'CRC_PATCHED_'+m.filename);addLog(m.name+': '+fixes+' CRC(s) fixed → download','rx');patched++;
        setMods(p=>{const u=[...p];u[idx]=parseModule(out,m.filename);return u;});
      }else addLog(m.name+': all CRCs valid ✓','info');
    });
    setMsg(patched>0?patched+' module(s) CRC-patched':'All CRCs already valid');
  },[mods]);

  const benchConnect=useCallback(async()=>{
    try{
      if(!navigator.serial){addLog('Web Serial not available — use Chrome','error');return;}
      const port=await navigator.serial.requestPort();
      await port.open({baudRate:115200});
      const w=port.writable.getWriter();
      const rd=port.readable.getReader();
      const tdec=new TextDecoder();
      let rbuf='';
      const send=async(cmd,to=3000)=>{
        rbuf='';await w.write(new TextEncoder().encode(cmd+'\r'));addLog('TX > '+cmd,'tx');
        const deadline=Date.now()+to;
        while(Date.now()<deadline){
          try{
            const rp=rd.read();const tp=new Promise(r=>setTimeout(()=>r({value:undefined,done:true}),Math.min(500,deadline-Date.now())));
            const res=await Promise.race([rp,tp]);
            if(res.done||!res.value){if(Date.now()>=deadline)break;continue;}
            rbuf+=tdec.decode(res.value);
            const pi=rbuf.indexOf('>');
            if(pi!==-1){const r=rbuf.substring(0,pi).replace(/\r/g,'\n').replace(/\n+/g,'\n').trim();rbuf=rbuf.substring(pi+1);addLog('RX < '+r,'rx');return r;}
          }catch(e){break;}
        }
        const t=rbuf.replace(/\r/g,'\n').replace(/\n+/g,'\n').replace(/>/g,'').trim();if(t)addLog('RX (timeout) < '+t,'warn');return t;
      };
      await send('ATZ',2000);await new Promise(r=>setTimeout(r,500));
      await send('ATE0');
      const ati=await send('ATI');addLog('Firmware: '+ati,'info');
      const stdi=await send('STDI');
      const isSTN=!stdi.includes('?')&&!stdi.includes('ERROR')&&stdi.length>2;
      addLog('Bench adapter: '+(isSTN?'STN/OBDLink':'ELM327'),'info');
      if(isSTN){await send('ATPP2CSV81',2000);await send('ATPP2CON',2000);await send('ATPP2DSV01',2000);await send('ATPP2DON',2000);await send('ATZ',3000);await new Promise(r=>setTimeout(r,1000));await send('ATE0',2000);await new Promise(r=>setTimeout(r,200));addLog('MFG extended mode active','info');}
      await send('ATL0');await send('ATS1');await send('ATH1');await send('ATSP6');await send('ATAT2');await send('ATST96');
      if(isSTN){await send('ATCAF1');await send('ATFCSH7E0');await send('ATFCSD300000');await send('ATFCSM1');}
      else{await send('ATCAF1');await send('ATFCSM1');}
      let curTx=0,curRx=0;
      benchEng.current={send,isSTN,uds:async(tx,rx,data)=>{
        if(tx!==curTx){await send('ATSH'+tx.toString(16).toUpperCase().padStart(3,'0'));if(isSTN)await send('ATFCSH'+tx.toString(16).toUpperCase().padStart(3,'0'));curTx=tx;}
        if(rx!==curRx){await send('ATCRA'+rx.toString(16).toUpperCase().padStart(3,'0'));curRx=rx;}
        const h=Array.from(data).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
        const r=await send(h,5000);
        if(!r||/NO DATA|UNABLE TO CONNECT|CAN ERROR|BUS ERROR/.test(r))return{ok:false};
        if(r.includes('?')||r.includes('ERROR'))return{ok:false};
        const rxHex=rx.toString(16).toUpperCase().padStart(3,'0');
        const lines=r.split(/[\r\n]+/).map(l=>l.trim()).filter(l=>l.length>0);
        let all=[];
        for(const line of lines){if(line.includes('SEARCHING')||line==='OK')continue;const toks=line.split(/\s+/);if(toks.length<2)continue;const first=toks[0].toUpperCase();if(/^[0-9A-F]{3}$/.test(first)){if(first===rxHex){for(let i=1;i<toks.length;i++){if(/^[0-9A-Fa-f]{2}$/.test(toks[i]))all.push(parseInt(toks[i],16));}}}else{for(const t of toks){if(/^[0-9A-Fa-f]{2}$/.test(t))all.push(parseInt(t,16));}}}
        if(!all.length)return{ok:false};
        return{ok:true,d:new Uint8Array(all)};
      }};
      setBenchConn(true);addLog('Bench ready — HS-CAN 500kbps','info');
    }catch(e){addLog('Bench connect failed: '+e.message,'error');}
  },[]);

  const benchWriteModule=useCallback(async(tx,rx,label)=>{
    if(!benchEng.current||nv.length!==17)return;setBenchBusy('Writing '+label+'...');
    try{
      await benchEng.current.uds(tx,rx,[0x10,0x03]);
      const sr=await benchEng.current.uds(tx,rx,[0x27,0x01]);
      if(sr.ok&&sr.d){const sb=Array.from(sr.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
        if(sv){const k=cda6(sv);await benchEng.current.uds(tx,rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);addLog(label+' unlocked','rx');}}
      const vb=[...new TextEncoder().encode(nv)];
      for(const did of[0xF190,0x7B90,0x7B88]){const r=await benchEng.current.uds(tx,rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);addLog(label+' DID 0x'+did.toString(16).toUpperCase()+': '+(r.ok?'OK':'FAIL'),r.ok?'rx':'error');}
      await benchEng.current.uds(tx,rx,[0x11,0x01]);addLog(label+' VIN written + reset','rx');
    }catch(e){addLog(label+' error: '+e.message,'error');}finally{setBenchBusy('');}
  },[nv]);

  const benchReadVin=useCallback(async(tx,rx,label)=>{
    if(!benchEng.current)return;setBenchBusy('Reading '+label+'...');
    try{
      const r=await benchEng.current.uds(tx,rx,[0x22,0xF1,0x90]);
      if(r.ok&&r.d?.length>3){const vc=Array.from(r.d).filter(b=>b>=0x20&&b<=0x7E);const vin=String.fromCharCode(...vc).slice(-17);addLog(label+' VIN: '+vin,'rx');}
      else addLog(label+' read failed','error');
    }catch(e){addLog(label+' error: '+e.message,'error');}finally{setBenchBusy('');}
  },[]);

  const bcm=mods.find(m=>m.type==='BCM');
  const gpec=mods.find(m=>m.type==='GPEC2A');

  return<div style={{display:'grid',gridTemplateColumns:'1fr 300px',gap:16}}>
    <div>
      <Card glow style={{marginBottom:14}}>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
          <Btn onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin,.BIN';i.onchange=e=>loadFiles(e.target.files);i.click();}} color={C.a3} full>📂 Load Module Files (.bin)</Btn>
        </div>
        <div style={{fontSize:10,color:C.ts,marginTop:8}}>Auto-detects BCM D-FLASH · RFHUB EEE · GPEC2A · 95640</div>
      </Card>

      {mods.length>0&&<Card glow style={{marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:12}}>Detected Modules ({mods.length})</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {mods.map((m,i)=><div key={i} style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+C.bd,position:'relative'}}>
            <button onClick={()=>setMods(p=>p.filter((_,j)=>j!==i))} style={{position:'absolute',top:6,right:8,background:'none',border:'none',color:C.tm,cursor:'pointer',fontSize:12}}>✕</button>
            <div style={{fontSize:13,fontWeight:800,color:m.color}}>{m.name}</div>
            <div style={{fontSize:9,color:C.ts}}>{m.filename} · {(m.size/1024).toFixed(0)}KB</div>
            {m.vins?.[0]&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a1,fontWeight:700,marginTop:4}}>{m.vins[0].vin}</div>}
          </div>)}
        </div>
      </Card>}

      {mods.length>0&&<Card glow style={{marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>Write VIN to All Modules</div>
        <input value={nv} maxLength={17} placeholder="Enter 17-character VIN" onChange={e=>setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))}
          style={{width:'100%',padding:'12px 16px',borderRadius:12,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:16,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box'}}
          onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:10,alignItems:'center'}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:nv.length===17?C.sr:C.tm}}>{nv.length}/17</span>
          <Btn onClick={writeAllVins} disabled={nv.length!==17||!mods.length}>⚡ Patch + Download All</Btn>
        </div>
      </Card>}

      {mods.length>0&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>Quick Tools (Bench)</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <Btn onClick={()=>{if(!bcm){addLog('No BCM loaded','error');return;}addLog('BCM Proxi @0x2023: '+extractHex(bcm.data,0x2023,16),'rx');}} disabled={!bcm} color={C.a3} outline>📋 Read BCM Proxi</Btn>
          <Btn onClick={()=>{if(!gpec){addLog('No GPEC2A loaded','error');return;}addLog('SKIM State: '+(gpec.skimByte===0x80?'ENABLED':'DISABLED')+' (0x'+gpec.skimByte.toString(16).toUpperCase()+')','rx');}} disabled={!gpec} color={C.a2} outline>🛡️ Read SKIM State</Btn>
          <Btn onClick={doVirginRfhub} disabled={!mods.find(m=>m.type==='RFHUB')} color={C.er} outline>💀 Virginize RFHUB</Btn>
          <Btn onClick={()=>{if(!bcm){addLog('No BCM loaded','error');return;}if(bcm.immoBlank){addLog('BCM IMMO is blank — nothing to sync','warn');return;}const d=syncImmoBackup(bcm.data);if(!d){addLog('BCM file too small for IMMO sync','error');return;}dl(d,'IMMO_SYNCED_'+bcm.filename);addLog('IMMO backup synced: '+bcm.immoRecs+' keys → 0x2000','rx');setMods(p=>{const u=[...p];const idx=u.findIndex(m=>m.type==='BCM');u[idx]=parseModule(d,bcm.filename);return u;});setMsg('IMMO backup synced');}} disabled={!bcm} color={C.a1} outline>🔄 Sync IMMO Backup</Btn>
          <Btn onClick={doCrcPatch} disabled={!mods.length} color={C.sr}>🔧 CRC Patch All</Btn>
        </div>
        <div style={{marginTop:10,fontSize:10,color:C.ts}}>
          <div><b>Bench mode:</b> All operations work on loaded .bin files — no serial connection needed</div>
          <div><b>Downloads:</b> Each operation produces a modified .bin ready to write to chip</div>
        </div>
      </Card>}

      <Card glow style={{marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
          <div style={{fontSize:14,fontWeight:800}}>UDS Bench Tools</div>
          <Tag color={benchConn?C.gn:C.tm}>{benchConn?'CONNECTED':'OFFLINE'}</Tag>
        </div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
          <Btn onClick={benchConnect} disabled={benchConn} color={benchConn?C.gn:C.a3}>{benchConn?'✓ Bench Connected':'🔌 Connect OBDLink (Bench)'}</Btn>
        </div>
        {benchConn&&<>
          <input value={nv} maxLength={17} placeholder="Enter 17-character VIN" onChange={e=>setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))}
            style={{width:'100%',padding:'10px 14px',borderRadius:10,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box',marginBottom:10}}
            onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <span style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:800,color:nv.length===17?C.sr:C.tm}}>{nv.length}/17</span>
            {benchBusy&&<span style={{fontSize:10,color:C.wn,fontWeight:700}}>{benchBusy}</span>}
          </div>
          <div style={{fontSize:12,fontWeight:800,color:C.tx,marginBottom:8}}>Write VIN</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
            <Btn onClick={()=>benchWriteModule(0x7A8,0x7B0,'ADCM')} disabled={!!benchBusy||nv.length!==17} color={C.a4}>⚡ Write DAMP</Btn>
            <Btn onClick={()=>benchWriteModule(0x740,0x748,'IPC')} disabled={!!benchBusy||nv.length!==17} color={C.a1}>⚡ Write IPC</Btn>
            <Btn onClick={()=>benchWriteModule(0x7E0,0x7E8,'ECM')} disabled={!!benchBusy||nv.length!==17} color={C.a2}>⚡ Write ECM</Btn>
            <Btn onClick={()=>benchWriteModule(0x7E1,0x7E9,'TCM')} disabled={!!benchBusy||nv.length!==17} color={C.a3}>⚡ Write TCM</Btn>
            <Btn onClick={()=>benchWriteModule(0x750,0x758,'BCM')} disabled={!!benchBusy||nv.length!==17} color={C.sr}>⚡ Write BCM</Btn>
          </div>
          <div style={{fontSize:12,fontWeight:800,color:C.tx,marginBottom:8}}>Read VIN</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <Btn onClick={()=>benchReadVin(0x7A8,0x7B0,'ADCM')} disabled={!!benchBusy} color={C.a4} outline>📖 Read DAMP</Btn>
            <Btn onClick={()=>benchReadVin(0x740,0x748,'IPC')} disabled={!!benchBusy} color={C.a1} outline>📖 Read IPC</Btn>
            <Btn onClick={()=>benchReadVin(0x7E0,0x7E8,'ECM')} disabled={!!benchBusy} color={C.a2} outline>📖 Read ECM</Btn>
            <Btn onClick={()=>benchReadVin(0x7E1,0x7E9,'TCM')} disabled={!!benchBusy} color={C.a3} outline>📖 Read TCM</Btn>
            <Btn onClick={()=>benchReadVin(0x750,0x758,'BCM')} disabled={!!benchBusy} color={C.sr} outline>📖 Read BCM</Btn>
          </div>
          <div style={{marginTop:10,fontSize:10,color:C.ts}}>
            <div><b>Flow:</b> Extended session → CDA6 security → Write DIDs (F190/7B90/7B88) → ECU Reset</div>
            <div><b>Bench:</b> Power module with 12V supply, connect OBDLink to CAN H/L pins</div>
          </div>
        </>}
        {!benchConn&&<div style={{fontSize:10,color:C.ts}}>Connect OBDLink to write VINs to individual modules on the bench via UDS over CAN</div>}
      </Card>

      {msg&&<div style={{marginTop:10,padding:'8px 12px',borderRadius:8,background:C.gn+'10',border:'1px solid '+C.gn+'25',fontSize:11,fontWeight:700,color:C.gn}}>✓ {msg}</div>}
    </div>

    <div style={{background:C.cd,borderRadius:14,padding:14,border:'1px solid '+C.bd,maxHeight:600,overflow:'auto',boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
      <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:8,letterSpacing:2}}>BENCH LOG</div>
      {log.map((e,i)=><div key={i} style={{fontSize:9,fontFamily:"'JetBrains Mono'",padding:'2px 0',color:e.l==='error'?C.er:e.l==='tx'?C.a3:e.l==='rx'?C.sr:C.ts}}>
        <span style={{color:C.tm,marginRight:4}}>{e.t}</span>{e.m}
      </div>)}
      {!log.length&&<div style={{fontSize:11,color:C.tm,textAlign:'center',padding:30}}>Load files to see log</div>}
    </div>
  </div>;
}

/* ═══ SECURITY TAB (Cross-Vehicle Matcher with 4 sub-views) ═══ */
function SecurityTab(){
  const[mods,setMods]=useState([]);const[sub,setSub]=useState('overview');const[tv,setTv]=useState('');
  const[msg,setMsg]=useState('');const[dp,setDp]=useState([0,1]);const[tt,setTt]=useState(0);
  const[tr,setTr]=useState(null);const[flashList,setFlashList]=useState([]);const[keySrc,setKeySrc]=useState(-1);

  const addF=useCallback(fl=>{
    Array.from(fl).forEach(f=>{
      const r=new FileReader();
      r.onload=ev=>{
        const d=new Uint8Array(ev.target.result);
        const m=parseModule(d,f.name);
        if(m.type!=='UNKNOWN'&&m.type!=='FW')setMods(p=>{const u=[...p,m];if(!tv&&m.vins?.[0])setTv(m.vins[0].vin);return u;});
      };r.readAsArrayBuffer(f);
    });
  },[tv]);

  const dl=(d,n)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();};
  const rmMod=i=>setMods(p=>p.filter((_,j)=>j!==i));

  const allVins=useMemo(()=>{const s=new Set();mods.forEach(m=>{if(m.vins)m.vins.forEach(v=>s.add(v.vin));});return[...s];},[mods]);
  const vinBad=allVins.length>1;
  const val=useMemo(()=>mods.length>0?crossValidate(mods):null,[mods]);

  const skimG=useMemo(()=>{
    const bcmMod=mods.find(m=>m.type==='BCM');if(!bcmMod)return[];
    const r=[];for(const c of SKIM_OFF){if(c.base+c.ks*c.kc>bcmMod.size)continue;
      const keys=[];let has=false;
      for(let i=0;i<c.kc;i++){const o=c.base+i*c.ks;const kb=bcmMod.data.slice(o,o+c.ks);const hex=hxb(kb);if(!kb.every(b=>b===0xFF||b===0))has=true;keys.push({slot:i+1,off:o,hex,empty:kb.every(b=>b===0xFF||b===0)});}
      if(has)r.push({v:c.v,keys,base:c.base});}
    return r;
  },[mods]);

  const diff=useMemo(()=>{if(mods.length<2)return null;const a=mods[dp[0]]?.data,b=mods[dp[1]]?.data;return a&&b?computeDiff(a,b):null;},[mods,dp]);

  const sks=useMemo(()=>mods.filter(m=>m.skey&&!m.skb).map(m=>({idx:mods.indexOf(m),type:m.type,key:m.skey,fn:m.filename})),[mods]);
  const skBad=useMemo(()=>{if(sks.length<2)return false;for(let i=1;i<sks.length;i++)for(let j=0;j<sks[0].key.length;j++)if(sks[0].key[j]!==sks[i].key[j])return true;return false;},[sks]);

  function adaptKey(srcKey,srcEndian,dstEndian,dstLen){
    let k=Array.from(srcKey);
    if(srcEndian!==dstEndian&&srcEndian&&dstEndian)k=k.reverse();
    while(k.length<dstLen)k.push(0xFF);
    return new Uint8Array(k.slice(0,dstLen));
  }
  function keyWidthWarning(srcMod,dstMod){
    if(!srcMod||!dstMod||!srcMod.skey||!dstMod.skey)return null;
    if(srcMod.skey.length<dstMod.skey.length)return srcMod.type+' has '+srcMod.skey.length+'B key → '+dstMod.type+' needs '+dstMod.skey.length+'B (padded with 0xFF)';
    return null;
  }
  function syncKey(si,ti){const s=mods[si],t=mods[ti];if(!s.skey||s.skb||t.skoff===undefined)return;const p=new Uint8Array(t.data);const adapted=adaptKey(s.skey,s.skEndian,t.skEndian,Math.min(s.skey.length,16));for(let i=0;i<adapted.length;i++)p[t.skoff+i]=adapted[i];if(t.type==='GPEC2A'&&t.skmoff!==undefined)for(let i=0;i<Math.min(adapted.length,8);i++)p[t.skmoff+i]=adapted[i];dl(p,t.filename.replace(/\./,'_KEYSYNCED.'));setMods(prev=>{const u=[...prev];u[ti]=parseModule(p,t.filename);return u;});setMsg('Key from '+s.filename+' → '+t.filename);}

  function patchModVIN(i){
    if(tv.length!==17)return;const m=mods[i];
    const patched=writeModuleVIN(m.data,m.type,tv,m.vins);
    if(patched){const fn=m.filename.replace(/\./,'_VIN_'+tv+'.');dl(patched,fn);setMods(p=>{const u=[...p];u[i]=parseModule(patched,m.filename);return u;});setMsg('Patched '+m.name+' → '+tv);}
  }

  function matchAll(){
    if(!mods.length)return;const doVin=tv.length===17;
    const results=[];let srcKey=null;
    if(keySrc>=0&&mods[keySrc]&&mods[keySrc].skey&&!mods[keySrc].skb){const sk=mods[keySrc];srcKey={data:sk.skey,type:sk.type,fn:sk.filename,endian:sk.skEndian};}
    else{for(const m of mods){if(m.skey&&!m.skb){srcKey={data:m.skey,type:m.type,fn:m.filename,endian:m.skEndian};break;}}}
    mods.forEach((m,i)=>{
      let patched=doVin?writeModuleVIN(m.data,m.type,tv,m.vins):null;
      if(!patched)patched=new Uint8Array(m.data);
      if(srcKey&&m.skoff!==undefined){
        const adapted=adaptKey(srcKey.data,srcKey.endian,m.skEndian,Math.min(srcKey.data.length,16));
        let needsSync=m.skb;
        if(!needsSync&&m.skey){for(let j=0;j<Math.min(adapted.length,m.skey.length);j++)if(adapted[j]!==m.skey[j]){needsSync=true;break;}}
        if(needsSync){for(let j=0;j<adapted.length;j++)patched[m.skoff+j]=adapted[j];if(m.type==='GPEC2A'&&m.skmoff!==undefined)for(let j=0;j<Math.min(adapted.length,8);j++)patched[m.skmoff+j]=adapted[j];}
      }
      const fn='MATCHED_'+tv+'_'+m.filename;
      const flashNote=m.type==='BCM'?'Flash this BCM D-FLASH file':m.type==='RFHUB'?'Write this RFHUB to EEE chip':m.type==='GPEC2A'?'Write this GPEC2A to 95320 SPI chip':m.type==='95640'?'Write this 95640 EEPROM':'Flash this file';
      results.push({data:patched,fn,type:m.type,name:m.name,note:flashNote,original:m.filename});
      setMods(p=>{const u=[...p];u[i]=parseModule(patched,m.filename);return u;});
    });
    const postCheck=crossValidate(results.map(r=>parseModule(r.data,r.fn)));
    const statusNote=postCheck.issues.length===0?' — all checks passed':' — '+postCheck.issues.length+' issue(s) remain';
    setFlashList(results);setMsg('All modules matched'+(doVin?' to '+tv:'')+(srcKey?' with key from '+srcKey.fn:'')+statusNote);setSub('tools');
  }

  function doTool(action){
    const m=mods[tt];if(!m)return;let res=null;
    if(action==='virginize'){const d=virginizeModule(m.data,m.type);res={data:d,desc:m.name+' virginized: keys/VINs/SKIM cleared.'};}
    else if(action==='writeVin'&&tv.length===17){const d=writeModuleVIN(m.data,m.type,tv,m.vins);if(d)res={data:d,desc:'VIN updated to '+tv+' at '+(m.vins?m.vins.length:0)+' locations'+(m.type==='BCM'?' + IMMO backup synced':'')};}
    else if(action==='skimToggle'&&m.type==='GPEC2A'){const d=new Uint8Array(m.data);d[0x0011]=m.skimByte===0x80?0x00:0x80;res={data:d,desc:'SKIM: 0x'+m.skimByte.toString(16).toUpperCase()+' → 0x'+d[0x0011].toString(16).toUpperCase()};}
    else if(action==='extractKey'){let k=m.secretKey?m.secretKey.hex:m.vehicleSecret?m.vehicleSecret.hex:m.skey&&!m.skb?hxb(m.skey):'';res={keyHex:k,desc:'Extracted from '+m.type};}
    else if(action==='syncImmo'&&m.type==='BCM'){const d=syncImmoBackup(m.data);if(d)res={data:d,desc:'IMMO backup synced: '+countSkimRecs(m.data,0x40C0)+' SKIM records copied 0x40C0 → 0x2000'};else res={desc:'BCM file too small for IMMO sync'};}
    setTr(res);
  }
  const dlResult=()=>{if(!tr?.data)return;const b=new Blob([tr.data],{type:'application/octet-stream'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='modified_'+(mods[tt]?.filename||'module.bin');a.click();URL.revokeObjectURL(u);};

  const SUBS=[{id:'overview',l:'Overview'},{id:'security',l:'Security'},{id:'diff',l:'Diff'},{id:'tools',l:'Tools'}];
  const selSt={background:C.c2,color:C.tx,border:'1px solid '+C.bd,borderRadius:6,padding:'6px 12px',fontSize:12,fontFamily:'inherit'};

  return<div>
    <div onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin,.BIN';i.onchange=e=>addF(e.target.files);i.click();}} onDrop={e=>{e.preventDefault();addF(e.dataTransfer.files);}} onDragOver={e=>e.preventDefault()}>
      <Card style={{textAlign:'center',padding:'24px',cursor:'pointer',border:'2px dashed '+C.sr+'25',marginBottom:16}} onClick={()=>{}}>
        <span style={{fontSize:32}}>🛡️</span>
        <div style={{fontSize:16,fontWeight:900,color:C.sr,marginTop:4}}>Drop Module Files for Cross-Vehicle Matching</div>
        <div style={{fontSize:11,color:C.ts}}>BCM · 95640 · RFHUB EEE · GPEC2A — compare keys, sync VINs, match security bytes</div>
        {mods.length>0&&<Tag color={C.a3}>{mods.length} loaded</Tag>}
      </Card>
    </div>

    {mods.length>0&&<>
      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontSize:10,fontWeight:800,color:C.sr,letterSpacing:2,marginBottom:6}}>TARGET VIN</div>
        <input value={tv} maxLength={17} placeholder="17-char target VIN" onChange={e=>setTv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))} style={{width:'100%',padding:'10px 14px',borderRadius:10,border:'2px solid '+C.bd,background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:15,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box',color:C.tx}} onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
        {(vinBad||skBad)&&<div style={{marginTop:8}}>
          {sks.length>1&&<div style={{marginBottom:6,display:'flex',gap:8,alignItems:'center'}}>
            <span style={{fontSize:10,fontWeight:800,color:C.tm}}>Key Source:</span>
            <select value={keySrc} onChange={e=>setKeySrc(+e.target.value)} style={{background:C.c2,color:C.tx,border:'1px solid '+C.bd,borderRadius:6,padding:'4px 10px',fontSize:11,fontFamily:'inherit'}}>
              <option value={-1}>Auto (first with key)</option>
              {sks.map(s=><option key={s.idx} value={s.idx}>{s.fn} ({TL[s.type]||s.type})</option>)}
            </select>
          </div>}
          <Btn onClick={matchAll} disabled={vinBad&&tv.length!==17} full>⚡ Match All Modules{tv.length===17?' → '+tv:''} + Download Files to Flash</Btn>
          {vinBad&&tv.length!==17&&<div style={{fontSize:10,color:C.wn,marginTop:4}}>Enter a 17-char target VIN above to sync VINs</div>}
        </div>}
      </Card>

      <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
        <div style={{padding:'7px 12px',borderRadius:8,fontSize:11,fontWeight:800,background:vinBad?C.er+'10':C.gn+'10',color:vinBad?C.er:C.gn}}>{vinBad?'⚠ VIN MISMATCH — '+allVins.length+' different VINs':'✓ All VINs Match'}</div>
        {sks.length>0&&<div style={{padding:'7px 12px',borderRadius:8,fontSize:11,fontWeight:800,background:skBad?C.er+'10':C.gn+'10',color:skBad?C.er:C.gn}}>{skBad?'⚠ SECRET KEY MISMATCH':'✓ Secret Keys Match'}</div>}
      </div>

      <div style={{display:'flex',gap:2,marginBottom:16}}>
        {SUBS.map(s=><button key={s.id} onClick={()=>setSub(s.id)} style={{padding:'8px 18px',border:'none',cursor:'pointer',background:sub===s.id?C.sr:C.cd,color:sub===s.id?'#fff':C.ts,borderRadius:8,fontFamily:"'Nunito'",fontWeight:800,fontSize:11,letterSpacing:.8,transition:'all 0.2s'}}>{s.l}</button>)}
      </div>
    </>}

    {/* OVERVIEW SUB-TAB */}
    {sub==='overview'&&mods.length>0&&<div>
      {val&&<Card style={{marginBottom:16,padding:16}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>Cross-Module Validation</div>
        {val.issues.map((m,i)=><SLine key={'i'+i} type="error" msg={m}/>)}
        {val.warnings.map((m,i)=><SLine key={'w'+i} type="warn" msg={m}/>)}
        {val.passed.map((m,i)=><SLine key={'p'+i} type="pass" msg={m}/>)}
      </Card>}

      {mods.map((m,i)=><Card key={i} style={{marginBottom:14,padding:16}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
          <Tag color={m.color}>{m.name}</Tag>
          <span style={{fontSize:12,fontWeight:700}}>{m.filename}</span>
          <span style={{fontSize:10,color:C.tm}}>{(m.size/1024).toFixed(0)}KB</span>
          <button onClick={()=>rmMod(i)} style={{marginLeft:'auto',background:'none',border:'none',color:C.tm,cursor:'pointer',fontSize:14}}>✕</button>
        </div>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr>{['Offset','Category','Value','Detail'].map(h=><th key={h} style={{textAlign:'left',color:C.tm,fontWeight:600,padding:'6px 10px',borderBottom:'1px solid '+C.bd,fontSize:10,textTransform:'uppercase',letterSpacing:.5}}>{h}</th>)}</tr></thead>
            <tbody>
              {m.vins?.map((v,j)=><tr key={'v'+j}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(v.offset)}</td><td><Tag color={C.gn}>VIN {j+1}</Tag></td><td style={{padding:'5px 10px',color:C.gn,fontWeight:700,fontSize:12}}>{v.vin}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>{v.mirrored?'17B Mirrored':'17B ASCII'}{v.crcOk!==undefined&&<Tag color={v.crcOk?C.gn:C.er} style={{marginLeft:6}}>CRC8 {v.crcOk?'✓':'✗'}</Tag>}</td></tr>)}
              {m.partialVins?.map((pv,j)=><tr key={'pv'+j}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(pv.offset)}</td><td><Tag color={C.a2}>TAIL {j+1}</Tag></td><td style={{padding:'5px 10px',color:C.a2,fontWeight:700,fontSize:12}}>{pv.tail}</td><td style={{padding:'5px 10px',color:pv.crcOk?C.gn:C.er,fontSize:12}}>8B partial CRC {pv.crcOk?'✓':'✗'}</td></tr>)}
              {m.skimStatus!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x0011</td><td><Tag color={C.sr}>SKIM</Tag></td><td style={{padding:'5px 10px',color:m.skimByte===0x80?C.gn:C.er,fontWeight:700,fontSize:12}}>0x{m.skimByte.toString(16).toUpperCase()} — {m.skimStatus}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>Immobilizer byte</td></tr>}
              {m.secretKey&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(m.secretKey.offset)}</td><td><Tag color={C.a4}>SECRET</Tag></td><td style={{padding:'5px 10px',color:C.a4,fontWeight:700,fontSize:12}}>{m.secretKey.hex}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>8B sync key {m.keyConsistent?'✓':'✗'}</td></tr>}
              {m.vehicleSecret&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(m.vehicleSecret.offset)}</td><td><Tag color={C.a4}>SECRET</Tag></td><td style={{padding:'5px 10px',color:C.a4,fontWeight:700,fontSize:12}}>{m.vehicleSecret.hex}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>{m.vehicleSecret.endian}-endian 16B</td></tr>}
              {m.skey&&!m.vehicleSecret&&!m.secretKey&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(m.skoff)}</td><td><Tag color={C.a4}>SECRET</Tag></td><td style={{padding:'5px 10px',color:m.skb?C.tm:C.a4,fontWeight:700,fontSize:12}}>{m.skb?'ERASED':hxb(m.skey)}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>16B key</td></tr>}
              {m.transponderKeys?.map((tk,j)=><tr key={'t'+j}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(tk.offset)}</td><td><Tag color={C.a1}>FOBIK {j+1}</Tag></td><td style={{padding:'5px 10px',color:C.a1,fontSize:12}}>{tk.hex}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>Transponder</td></tr>)}
              {m.immoKeys?.map((ik,j)=><tr key={'k'+j}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(ik.offset)}</td><td><Tag color={C.a1}>IMMO {j+1}</Tag></td><td style={{padding:'5px 10px',color:C.a1,fontSize:12}}>{ik.hex}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>IMMO entry</td></tr>)}
              {m.zzzzTamper&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(m.zzzzTamper.offset)}</td><td><Tag color={C.wn}>TAMPER</Tag></td><td style={{padding:'5px 10px',color:m.zzzzTamper.intact?C.gn:C.wn,fontSize:12}}>{m.zzzzTamper.hex} — {m.zzzzTamper.intact?'INTACT':'CLEARED'}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>ZZZZ</td></tr>}
              {m.securityLock&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x8028</td><td><Tag color={C.sr}>LOCK</Tag></td><td style={{padding:'5px 10px',color:m.securityLock.locked?C.gn:C.wn,fontWeight:700,fontSize:12}}>0x{m.securityLock.value.toString(16).toUpperCase()}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>{m.securityLock.locked?'LOCKED':'UNLOCKED'}</td></tr>}
              {m.fobikSlots!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x0880</td><td><Tag color={C.a1}>FOBIK</Tag></td><td style={{padding:'5px 10px',color:C.a1,fontWeight:700,fontSize:12}}>{m.fobikSlots} slots</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>AA50 pattern</td></tr>}
              {m.fobikCount!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x5862</td><td><Tag color={C.a1}>FOBIK</Tag></td><td style={{padding:'5px 10px',color:C.a1,fontWeight:700,fontSize:12}}>{m.fobikCount} keys</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>BCM count</td></tr>}
              {m.partNumbers&&Object.entries(m.partNumbers).map(([k,v])=><tr key={k}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>—</td><td><Tag color={C.a3}>PN-{k.toUpperCase()}</Tag></td><td style={{padding:'5px 10px',fontSize:12}}>{v}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>Part#</td></tr>)}
              {m.partNumberStr&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x0FA1</td><td><Tag color={C.a3}>SRI</Tag></td><td style={{padding:'5px 10px',fontSize:12}}>{m.partNumberStr}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>SW Release</td></tr>}
              {m.runtimeCounters&&Object.entries(m.runtimeCounters).map(([k,v])=><tr key={k}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(v.offset)}</td><td><Tag color={C.tm}>CTR</Tag></td><td style={{padding:'5px 10px',fontSize:12}}>{v.hex} ({v.value.toLocaleString()})</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>{k}</td></tr>)}
              {m.immoBlank!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x40C0</td><td><Tag color={C.sr}>IMMO</Tag></td><td style={{padding:'5px 10px',color:m.immoBlank?C.wn:C.gn,fontWeight:700,fontSize:12}}>{m.immoBlank?'BLANK':m.immoRecs+' keys'}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>SKIM primary</td></tr>}
              {m.bakBlank!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x2000</td><td><Tag color={C.sr}>BACKUP</Tag></td><td style={{padding:'5px 10px',color:m.bakBlank?C.wn:C.gn,fontWeight:700,fontSize:12}}>{m.bakBlank?'BLANK':m.bakRecs+' keys'}{!m.bakBlank&&!m.immoBlank&&<Tag color={m.immoSynced?C.gn:C.wn}>{m.immoSynced?'SYNCED ✓':'OUT OF SYNC'}</Tag>}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>SKIM backup</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>)}

      {skimG.length>0&&<Card style={{marginTop:8,padding:16}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>🔐 SKIM Key Grid</div>
        {skimG.map((g,gi)=><div key={gi} style={{marginBottom:12}}>
          <div style={{fontSize:12,fontWeight:800,color:C.a1,marginBottom:6}}>{g.v} — 0x{g.base.toString(16).toUpperCase()}</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
            {g.keys.map(k=><div key={k.slot} style={{padding:10,borderRadius:10,background:C.c2,border:'1px solid '+(k.empty?C.bd:C.gn+'40')}}>
              <div style={{display:'flex',justifyContent:'space-between'}}><span style={{fontSize:10,fontWeight:700,color:C.tm}}>KEY {k.slot}</span><Tag color={k.empty?C.tm:C.gn}>{k.empty?'EMPTY':'SET'}</Tag></div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:8,color:k.empty?'#D5D0C8':C.ts,marginTop:4,wordBreak:'break-all'}}>{k.hex}</div>
            </div>)}
          </div>
        </div>)}
        <Btn onClick={()=>{let t='SKIM KEYS\n';skimG.forEach(g=>{t+=g.v+' @0x'+g.base.toString(16).toUpperCase()+'\n';g.keys.forEach(k=>{t+='  Key '+k.slot+': '+(k.empty?'EMPTY':k.hex)+'\n';});});navigator.clipboard?.writeText(t);setMsg('SKIM keys copied to clipboard');}} color={C.a1} outline>📋 Copy Keys</Btn>
      </Card>}
    </div>}

    {/* SECURITY SUB-TAB */}
    {sub==='security'&&mods.length>0&&<div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(320px,1fr))',gap:12}}>
        {mods.map((m,i)=>{const vinOk=m.vins?.length>0&&m.vins[0].vin===tv;return<Card key={i} style={{padding:16,borderLeft:'3px solid '+m.color,borderColor:vinOk?C.gn+'50':m.vins?.length&&tv.length===17?C.er+'40':C.bd}}>
          <div style={{fontWeight:800,color:m.color,marginBottom:8,fontSize:14}}>{m.name}</div>
          <div style={{fontSize:11,color:C.tm,marginBottom:8}}>{m.filename} · {(m.size/1024).toFixed(0)}KB</div>
          {m.vins?.[0]&&<div style={{fontSize:12,marginBottom:4}}>VIN: <span style={{fontFamily:"'JetBrains Mono'",fontWeight:800,color:vinOk?C.gn:C.er}}>{m.vins[0].vin}</span>{vinOk?<Tag color={C.gn}>MATCH</Tag>:<Tag color={C.er}>MISMATCH</Tag>}</div>}
          {m.skimStatus!==undefined&&<div style={{fontSize:11,marginBottom:4}}>SKIM: <span style={{color:m.skimByte===0x80?C.gn:C.er,fontWeight:700}}>{m.skimStatus}</span></div>}
          {m.secretKey&&<div style={{fontSize:11,marginBottom:4}}>Secret: <span style={{fontFamily:"'JetBrains Mono'",color:C.a4,fontSize:10}}>{m.secretKey.hex}</span> {m.keyConsistent?'✓':'✗'}</div>}
          {m.vehicleSecret&&<div style={{fontSize:11,marginBottom:4}}>Secret ({m.vehicleSecret.endian}): <span style={{fontFamily:"'JetBrains Mono'",color:C.a4,fontSize:10}}>{m.vehicleSecret.hex}</span></div>}
          {m.skey&&!m.vehicleSecret&&!m.secretKey&&<div style={{fontSize:11,marginBottom:4}}>Secret @0x{m.skoff.toString(16).toUpperCase()}: <span style={{fontFamily:"'JetBrains Mono'",color:m.skb?C.tm:C.a4,fontSize:10}}>{m.skb?'ERASED':hxb(m.skey)}</span>
            {(m.skb||skBad)&&sks.length>0&&<div style={{marginTop:4}}>
              <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>{sks.filter(s=>s.idx!==i).map(s=>{const w=keyWidthWarning(mods[s.idx],m);return<span key={s.idx} title={w||''}><Btn onClick={()=>syncKey(s.idx,i)} color={C.a4} outline>Copy from {TL[s.type]||s.type}{w?' ⚠':''}  </Btn></span>;})}</div>
              {sks.filter(s=>s.idx!==i).some(s=>keyWidthWarning(mods[s.idx],m))&&<div style={{fontSize:9,color:C.wn,marginTop:2}}>⚠ Key width mismatch — shorter keys padded with 0xFF</div>}
            </div>}
          </div>}
          {m.fobikSlots!==undefined&&<div style={{fontSize:11}}>FOBIK: <span style={{color:C.a1,fontWeight:700}}>{m.fobikSlots} slots</span> · CC66AA55: {m.securityMarkers} · ZZZZ: {m.zzzzBlocks}</div>}
          {m.fobikCount!==undefined&&<div style={{fontSize:11}}>FOBIK: <span style={{color:C.a1,fontWeight:700}}>{m.fobikCount} keys</span></div>}
          {m.securityLock&&<div style={{fontSize:11}}>Lock: <span style={{color:m.securityLock.locked?C.gn:C.wn,fontWeight:700}}>{m.securityLock.locked?'0x5A LOCKED':'UNLOCKED'}</span></div>}
          {m.zzzzTamper&&<div style={{fontSize:11}}>Tamper: <span style={{color:m.zzzzTamper.intact?C.gn:C.wn,fontWeight:700}}>{m.zzzzTamper.intact?'INTACT':'CLEARED'}</span></div>}
          {m.immoBlank!==undefined&&<div style={{fontSize:11,marginTop:4}}>Immo @0x40C0: <Tag color={m.immoBlank?C.wn:C.gn}>{m.immoBlank?'BLANK':m.immoRecs+' keys'}</Tag></div>}
          {m.bakBlank!==undefined&&<div style={{fontSize:11,marginTop:2}}>Backup @0x2000: <Tag color={m.bakBlank?C.tm:C.gn}>{m.bakBlank?'BLANK':m.bakRecs+' keys'}</Tag>{!m.bakBlank&&!m.immoBlank&&<Tag color={m.immoSynced?C.gn:C.wn}>{m.immoSynced?'SYNCED ✓':'OUT OF SYNC'}</Tag>}</div>}
          {m.fobBlank!==undefined&&<div style={{fontSize:11}}>Fob Data: <Tag color={m.fobBlank?C.tm:C.gn}>{m.fobBlank?'NONE':'HAS FOBS'}</Tag></div>}
          {tv.length===17&&<div style={{marginTop:8}}><Btn onClick={()=>patchModVIN(i)} full color={vinOk?C.gn:C.sr}>{vinOk?'↓ Download':'⚡ Patch → '+tv}</Btn></div>}
        </Card>;})}
      </div>
    </div>}

    {/* DIFF SUB-TAB */}
    {sub==='diff'&&<div>
      {mods.length<2?<Card style={{textAlign:'center',padding:30}}><div style={{color:C.tm}}>Load 2+ modules to compare.</div></Card>:<div>
        <div style={{display:'flex',gap:12,marginBottom:16,alignItems:'center'}}>
          <select value={dp[0]} onChange={e=>setDp([+e.target.value,dp[1]])} style={selSt}>{mods.map((m,i)=><option key={i} value={i}>{m.filename}</option>)}</select>
          <span style={{color:C.tm}}>↔</span>
          <select value={dp[1]} onChange={e=>setDp([dp[0],+e.target.value])} style={selSt}>{mods.map((m,i)=><option key={i} value={i}>{m.filename}</option>)}</select>
        </div>
        {diff&&<div>
          <div style={{fontSize:12,color:C.wn,marginBottom:12,fontWeight:700}}>{diff.totalChanged} bytes changed, {diff.groups.length} regions</div>
          <Card style={{padding:16,maxHeight:500,overflowY:'auto'}}>
            {diff.groups.slice(0,50).map(([s,e],gi)=>{
              const a=mods[dp[0]].data,b=mods[dp[1]].data;
              const ls=s&~0xf,le=(e|0xf)+1,lines=[];
              for(let o=ls;o<le&&o<Math.max(a.length,b.length);o+=16){
                const ha=[],hb=[];
                for(let j=0;j<16&&o+j<Math.max(a.length,b.length);j++){
                  const idx=o+j,va=a[idx]||0,vb=b[idx]||0,ch=diff.changedSet.has(idx);
                  ha.push({v:va.toString(16).padStart(2,'0').toUpperCase(),c:ch});
                  hb.push({v:vb.toString(16).padStart(2,'0').toUpperCase(),c:ch});
                }lines.push({o,ha,hb});
              }
              return<div key={gi} style={{marginBottom:12}}>
                <div style={{fontSize:10,color:C.tm,fontWeight:700}}>{fO(s)}–{fO(e)} ({e-s+1}B)</div>
                {lines.map((l,li)=><div key={li} style={{display:'flex',gap:16,fontSize:11,lineHeight:1.6,fontFamily:"'JetBrains Mono'"}}>
                  <span style={{color:C.a3,minWidth:40}}>{l.o.toString(16).toUpperCase().padStart(4,'0')}</span>
                  <span style={{minWidth:200}}>{l.ha.map((h,hi)=><span key={hi} style={{color:h.c?C.er:C.tm,marginRight:4}}>{h.v}</span>)}</span>
                  <span style={{color:C.tm}}>→</span>
                  <span>{l.hb.map((h,hi)=><span key={hi} style={{color:h.c?C.gn:C.tm,marginRight:4}}>{h.v}</span>)}</span>
                </div>)}
              </div>;
            })}
            {diff.groups.length>50&&<div style={{color:C.tm,fontSize:11}}>+{diff.groups.length-50} more regions</div>}
          </Card>
        </div>}
      </div>}
    </div>}

    {/* TOOLS SUB-TAB */}
    {sub==='tools'&&<div>
      {mods.length===0?<Card style={{textAlign:'center',padding:30}}><div style={{color:C.tm}}>Load a module first.</div></Card>:<div>
        <div style={{display:'flex',gap:12,marginBottom:16,alignItems:'center'}}>
          <span style={{fontSize:12,color:C.tm,fontWeight:700}}>Target:</span>
          <select value={tt} onChange={e=>setTt(+e.target.value)} style={selSt}>{mods.map((m,i)=><option key={i} value={i}>{m.filename} ({m.name})</option>)}</select>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:12}}>
          <Card style={{padding:16,borderTop:'3px solid '+C.gn}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>VIN Writer</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Update VIN at all locations with CRC.</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,color:tv.length===17?C.gn:C.tm,marginBottom:8}}>{tv||'Set target VIN above'} ({tv.length}/17)</div>
            <Btn onClick={()=>doTool('writeVin')} disabled={tv.length!==17} full>Write VIN</Btn>
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.sr}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>SKIM Manager</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Toggle SKIM byte at 0x0011 (GPEC2A).</div>
            {mods[tt]?.type==='GPEC2A'?<div>
              <div style={{fontSize:12,marginBottom:8}}>Current: <span style={{color:mods[tt].skimByte===0x80?C.gn:C.er,fontWeight:700}}>0x{mods[tt].skimByte.toString(16).toUpperCase()}</span></div>
              <Btn onClick={()=>doTool('skimToggle')} full>{mods[tt].skimByte===0x80?'Disable SKIM':'Enable SKIM'}</Btn>
            </div>:<div style={{fontSize:11,color:C.tm}}>Select a GPEC2A module.</div>}
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.wn}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Virginize Module</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Clear keys, SKIM, ZZZZ, VINs.</div>
            <Btn onClick={()=>doTool('virginize')} full color={C.wn}>Virginize {mods[tt]?.name||''}</Btn>
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.a4}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Extract Secret Key</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Extract immobilizer sync key.</div>
            <Btn onClick={()=>doTool('extractKey')} full color={C.a4}>Extract</Btn>
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.a1}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Sync IMMO Backup</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Copy SKIM keys 0x40C0 → 0x2000 (BCM only).</div>
            {mods[tt]?.type==='BCM'?<div>
              <div style={{fontSize:11,marginBottom:6}}>Primary: <Tag color={mods[tt].immoBlank?C.wn:C.gn}>{mods[tt].immoBlank?'BLANK':mods[tt].immoRecs+' keys'}</Tag></div>
              <div style={{fontSize:11,marginBottom:8}}>Backup: <Tag color={mods[tt].bakBlank?C.tm:C.gn}>{mods[tt].bakBlank?'BLANK':mods[tt].bakRecs+' keys'}</Tag>{!mods[tt].bakBlank&&!mods[tt].immoBlank&&<Tag color={mods[tt].immoSynced?C.gn:C.wn}>{mods[tt].immoSynced?'SYNCED ✓':'OUT OF SYNC'}</Tag>}</div>
              <Btn onClick={()=>doTool('syncImmo')} disabled={mods[tt].immoBlank} full color={C.a1}>🔄 Sync IMMO Backup</Btn>
            </div>:<div style={{fontSize:11,color:C.tm}}>Select a BCM module.</div>}
          </Card>
        </div>

        {tr&&<Card style={{marginTop:16,padding:16,borderLeft:'3px solid '+C.gn}}>
          <div style={{fontSize:13,fontWeight:800,color:C.gn,marginBottom:8}}>Result</div>
          <div style={{fontSize:12,marginBottom:8}}>{tr.desc}</div>
          {tr.keyHex&&<div style={{background:C.c2,padding:12,borderRadius:8,fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:700,color:C.a4,letterSpacing:1,marginBottom:8}}>{tr.keyHex}</div>}
          {tr.data&&<Btn onClick={dlResult} color={C.gn}>↓ Download Modified .bin</Btn>}
        </Card>}

        {flashList.length>0&&<Card style={{marginTop:16,padding:16,borderLeft:'3px solid '+C.a1}}>
          <div style={{fontSize:14,fontWeight:800,color:C.a1,marginBottom:12}}>📋 Files to Flash</div>
          <div style={{fontSize:11,color:C.ts,marginBottom:12}}>All modules have been matched to <b>{tv}</b>. Download each file and write it to the corresponding chip:</div>
          {flashList.map((f,i)=><div key={i} style={{padding:12,borderRadius:10,marginBottom:8,background:C.c2,border:'1px solid '+C.bd,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
            <div>
              <Tag color={TC[f.type]||C.tm}>{f.name}</Tag>
              <span style={{fontSize:11,fontWeight:700,marginLeft:8}}>{f.fn}</span>
              <div style={{fontSize:11,color:C.a1,fontWeight:700,marginTop:4}}>→ {f.note}</div>
            </div>
            <Btn onClick={()=>dl(f.data,f.fn)} color={C.gn} outline>↓ Download</Btn>
          </div>)}
        </Card>}
      </div>}
    </div>}

    {msg&&<div style={{marginTop:12,padding:'8px 12px',borderRadius:8,background:C.gn+'10',border:'1px solid '+C.gn+'25',fontSize:11,fontWeight:700,color:C.gn}}>✓ {msg}</div>}
    {!mods.length&&<div style={{textAlign:'center',padding:30,color:C.tm,fontSize:12}}>Drop BCM, RFHUB, 95640, GPEC2A files above to compare security</div>}
  </div>;
}

/* ═══ LIVE OBD TAB ═══ */
function OBDTab(){
  const[conn,setConn]=useState(false);const[found,setFound]=useState([]);const[nv,setNv]=useState('');
  const[busy,setBusy]=useState('');const[prog,setProg]=useState(0);const[log,setLog]=useState([]);
  const eng=useRef(null);
  const addLog=(m,l='info')=>setLog(p=>[...p,{m,l,t:new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}]);

  const connect=useCallback(async()=>{
    try{
      if(!navigator.serial){addLog('Web Serial not available — use Chrome','error');return;}
      const port=await navigator.serial.requestPort();
      await port.open({baudRate:115200});
      const w=port.writable.getWriter();
      /* Direct reader — matches AlphaOBDProtocol.ts readUntilPrompt() */
      const rd=port.readable.getReader();
      const tdec=new TextDecoder();
      let rbuf='';
      const send=async(cmd,to=3000)=>{
        rbuf='';await w.write(new TextEncoder().encode(cmd+'\r'));addLog('TX > '+cmd,'tx');
        const deadline=Date.now()+to;
        while(Date.now()<deadline){
          try{
            const rp=rd.read();const tp=new Promise(r=>setTimeout(()=>r({value:undefined,done:true}),Math.min(500,deadline-Date.now())));
            const res=await Promise.race([rp,tp]);
            if(res.done||!res.value){if(Date.now()>=deadline)break;continue;}
            rbuf+=tdec.decode(res.value);
            const pi=rbuf.indexOf('>');
            if(pi!==-1){const r=rbuf.substring(0,pi).replace(/\r/g,'\n').replace(/\n+/g,'\n').trim();rbuf=rbuf.substring(pi+1);addLog('RX < '+r,'rx');return r;}
          }catch(e){break;}
        }
        const t=rbuf.replace(/\r/g,'\n').replace(/\n+/g,'\n').replace(/>/g,'').trim();if(t)addLog('RX (timeout) < '+t,'warn');return t;
      };
      /* Phase 1: Reset + identify — matches AlphaOBDProtocol.ts initAlphaOBDStyle() */
      await send('ATZ',2000);await new Promise(r=>setTimeout(r,500));
      await send('ATE0');
      const ati=await send('ATI');addLog('Firmware: '+ati,'info');
      /* Phase 2: Detect STN chipset (OBDLink) — AlphaOBDProtocol.ts Phase 2 */
      const stdi=await send('STDI');
      const isSTN=!stdi.includes('?')&&!stdi.includes('ERROR')&&stdi.length>2;
      const at1=await send('AT@1');
      const rv=await send('ATRV');
      addLog('Adapter: '+(isSTN?'STN/OBDLink':'ELM327')+' | '+at1+' | '+rv,'info');
      /* Phase 3: STN programmable parameters — REQUIRED for body module access
         PP2C=81 enables MFG extended mode — opens full CAN ID range (0x600-0x7FF)
         Without this, OBDLink only processes standard OBD-II IDs (0x7E0-0x7EF)
         This is why only ECM responds without PP — it's in the standard range */
      if(isSTN){
        addLog('Setting MFG extended mode (PP2C=81, PP2D=01)...','info');
        await send('ATPP2CSV81',2000);
        await send('ATPP2CON',2000);
        await send('ATPP2DSV01',2000);
        await send('ATPP2DON',2000);
        /* Reset to apply — MUST wait for full reboot */
        await send('ATZ',3000);
        await new Promise(r=>setTimeout(r,1000));/* longer delay than AlphaOBD's 500ms */
        await send('ATE0',2000);
        await new Promise(r=>setTimeout(r,200));
        addLog('MFG extended mode active','info');
      }
      /* Phase 4: CAN protocol — AlphaOBDProtocol.ts Phase 4 */
      await send('ATL0');await send('ATS1');await send('ATH1');
      await send('ATSP6');
      await send('ATAT2');/* aggressive adaptive timing */
      await send('ATST96');/* 600ms timeout */
      /* Phase 5: ISO-TP config — AlphaOBDProtocol.ts Phase 5 */
      if(isSTN){
        await send('ATCAF1');
        await send('ATFCSH7E0');await send('ATFCSD300000');await send('ATFCSM1');
        addLog('STN: CAF ON, auto flow control','info');
      }else{
        await send('ATCAF1');await send('ATFCSM1');
        addLog('ELM327: CAF ON, flow control mode 1','info');
      }
      /* Store state for UDS */
      let curTx=0,curRx=0;
      eng.current={send,isSTN,uds:async(tx,rx,data)=>{
        /* Clear stale filter, then set new — per obd2-protocol.ts probeAddress() */
        if(tx!==curTx||rx!==curRx){
          await send('ATCRA');/* clear receive filter first */
          await send('ATSH'+tx.toString(16).toUpperCase().padStart(3,'0'));
          if(isSTN)await send('ATFCSH'+tx.toString(16).toUpperCase().padStart(3,'0'));
          await send('ATCRA'+rx.toString(16).toUpperCase().padStart(3,'0'));
          curTx=tx;curRx=rx;
        }
        const h=Array.from(data).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
        const r=await send(h,5000);
        if(!r||/NO DATA|UNABLE TO CONNECT|CAN ERROR|BUS ERROR/.test(r))return{ok:false,raw:r||''};
        if(r.includes('?')||r.includes('ERROR'))return{ok:false,raw:r};
        /* Parse response — accept ANY CAN ID in response (not just expected RX) */
        const lines=r.split(/[\r\n]+/).map(l=>l.trim()).filter(l=>l.length>0);
        let all=[];
        for(const line of lines){
          if(line.includes('SEARCHING')||line==='OK')continue;
          const toks=line.split(/\s+/);if(toks.length<2)continue;
          const first=toks[0].toUpperCase();
          if(/^[0-9A-F]{3}$/.test(first)){
            /* Accept response from any CAN ID — module might respond on unexpected ID */
            for(let i=1;i<toks.length;i++){if(/^[0-9A-Fa-f]{2}$/.test(toks[i]))all.push(parseInt(toks[i],16));}
          }else{for(const t of toks){if(/^[0-9A-Fa-f]{2}$/.test(t))all.push(parseInt(t,16));}}
        }
        if(!all.length)return{ok:false,raw:r};
        return{ok:true,d:new Uint8Array(all),raw:r};
      }};
      setConn(true);addLog('Ready — HS-CAN 500kbps','info');
    }catch(e){addLog('Connect failed: '+e.message,'error');}
  },[]);

  const scan=useCallback(async()=>{
    if(!eng.current)return;setBusy('Scanning...');setFound([]);
    const foundSet=new Set();const addMod=(c,n,tx,rx,vin)=>{const k=tx+':'+rx;if(foundSet.has(k))return;foundSet.add(k);setFound(p=>[...p,{c,n,tx,rx,vin}]);};

    /* ═══ LAYER 1: Passive CAN monitor — confirm bus is alive ═══ */
    addLog('── Layer 1: Passive CAN monitor (3s) ──','info');
    await eng.current.send('ATCRA');/* clear filter */
    const ma=await eng.current.send('ATMA',3500);
    await eng.current.send('\r');/* interrupt ATMA */
    await new Promise(r=>setTimeout(r,200));
    const busIds=new Set();
    if(ma){for(const line of ma.split(/[\r\n]+/)){const t=line.trim();if(/^[0-9A-Fa-f]{3}\s/.test(t))busIds.add(t.slice(0,3).toUpperCase());}}
    if(busIds.size>0)addLog('Bus alive: '+busIds.size+' CAN IDs seen ('+[...busIds].slice(0,10).join(',')+')','rx');
    else addLog('WARNING: No CAN traffic detected on pins 6/14','error');

    /* ═══ LAYER 2: Functional broadcast 0x7DF — find all responding modules ═══ */
    addLog('── Layer 2: Functional broadcast (read VIN from all) ──','info');
    await eng.current.send('ATCRA');/* clear RX filter — accept ALL responses */
    await eng.current.send('ATSH7DF');
    await eng.current.send('ATFCSH7DF');
    const bcast=await eng.current.send('22 F1 90',5000);
    if(bcast&&!bcast.includes('NO DATA')&&!bcast.includes('CAN ERROR')&&!bcast.includes('?')){
      addLog('Broadcast responses: '+bcast.substring(0,120),'rx');
      const blines=bcast.split(/[\r\n]+/);
      for(const bl of blines){const bt=bl.trim();if(/^[0-9A-Fa-f]{3}\s/.test(bt)){
        const rid=parseInt(bt.slice(0,3),16);
        /* RX ID → TX ID is typically RX-8 */
        const tid=rid-8;const tidH=tid.toString(16).toUpperCase().padStart(3,'0');const ridH=rid.toString(16).toUpperCase().padStart(3,'0');
        /* Find module name */
        let mname='UNK_'+tidH;for(const m of MODS){for(const a of m.addrs){if(a.rx===rid||a.tx===tid){mname=m.c;break;}}}
        /* Try to parse VIN from response */
        const toks=bt.split(/\s+/).slice(1).filter(s=>/^[0-9A-Fa-f]{2}$/.test(s)).map(s=>parseInt(s,16));
        let vin='(present)';
        if(toks.length>5){const vc=toks.filter(b=>b>=0x20&&b<=0x7E);const vs=String.fromCharCode(...vc);if(vs.length>=10)vin=vs.slice(-17);}
        addMod(mname,mname,tid,rid,vin);
        addLog('Found '+mname+' at TX:'+tidH+' RX:'+ridH,'rx');
      }}
    }else{addLog('Broadcast: '+(bcast||'no response'),'warn');}

    /* ═══ LAYER 3: Physical addressing — every known address on CAN-C ═══ */
    addLog('── Layer 3: Physical scan — all known addresses on CAN-C ──','info');
    await eng.current.send('ATSP6');/* make sure we're on 500kbps */
    /* Wakeup broadcast — per obd2-protocol.ts */
    await eng.current.send('ATCRA');await eng.current.send('ATSH7DF');
    try{await eng.current.send('3E 00',2000);}catch(e){}
    await new Promise(r=>setTimeout(r,300));
    for(const m of MODS){
      let hit=false;
      for(const a of m.addrs){
        const k=a.tx+':'+a.rx;if(foundSet.has(k))continue;
        try{
          /* Body modules respond better to Read VIN than TesterPresent — obd2-protocol.ts probeAddressVIA() */
          const probe=(m.c==='ECM'||m.c==='TCM'||m.c==='DTCM')?[0x3E,0x00]:[0x22,0xF1,0x90];
          const r=await eng.current.uds(a.tx,a.rx,probe);
          if(r.ok){
            const txH=a.tx.toString(16).toUpperCase().padStart(3,'0');
            addLog(m.c+' alive at TX:'+txH,'rx');
            let vin='(present)';
            if(probe[0]===0x22&&r.d?.length>3){const vc=Array.from(r.d).filter(b=>b>=0x20&&b<=0x7E);const vs=String.fromCharCode(...vc).slice(-17);if(vs.length>=10)vin=vs;}
            else if(probe[0]===0x3E){const vr=await eng.current.uds(a.tx,a.rx,[0x22,0xF1,0x90]);if(vr.ok&&vr.d?.length>3){const vc=Array.from(vr.d).filter(b=>b>=0x20&&b<=0x7E);const vs=String.fromCharCode(...vc).slice(-17);if(vs.length>=10)vin=vs;}}
            addMod(m.c,m.n,a.tx,a.rx,vin);if(vin!=='(present)')addLog(m.c+': '+vin,'rx');
            hit=true;break;
          }
        }catch(e){}
        await new Promise(r=>setTimeout(r,30));
      }
      if(!hit)addLog(m.c+': no response on CAN-C ('+m.addrs.length+' addrs)','warn');
    }

    /* ═══ LAYER 4: CAN-IHS via STP61 (pins 3/11, 125kbps) ═══ */
    if(eng.current.isSTN){
      addLog('── Layer 4: CAN-IHS (STP61, pins 3/11, 125kbps) ──','info');
      const sw1=await eng.current.send('STP61');
      const ok61=sw1.includes('OK')||(!sw1.includes('?')&&!sw1.includes('ERROR')&&sw1.trim().length>0);
      if(ok61){
        await eng.current.send('ATSP7');await new Promise(r=>setTimeout(r,300));
        await eng.current.send('ATCRA');await eng.current.send('ATH1');await eng.current.send('ATST50');
        /* Broadcast on CAN-IHS */
        await eng.current.send('ATSH7DF');await eng.current.send('ATFCSH7DF');
        const ihsBcast=await eng.current.send('22 F1 90',5000);
        if(ihsBcast&&!ihsBcast.includes('NO DATA')&&!ihsBcast.includes('CAN ERROR')){
          addLog('CAN-IHS broadcast responses: '+ihsBcast.substring(0,120),'rx');
          const il=ihsBcast.split(/[\r\n]+/);
          for(const bl of il){const bt=bl.trim();if(/^[0-9A-Fa-f]{3}\s/.test(bt)){
            const rid=parseInt(bt.slice(0,3),16);const tid=rid-8;
            let mname='IHS_'+tid.toString(16).toUpperCase();for(const m of MODS){for(const a of m.addrs){if(a.rx===rid||a.tx===tid){mname=m.c;break;}}}
            addMod(mname,mname,tid,rid,'(CAN-IHS)');
            addLog('Found '+mname+' on CAN-IHS at TX:'+tid.toString(16).toUpperCase().padStart(3,'0'),'rx');
          }}
        }
        /* Physical scan on CAN-IHS */
        for(const m of MODS){if(m.c==='ECM'||m.c==='TCM'||m.c==='DTCM')continue;
          for(const a of m.addrs){const k=a.tx+':'+a.rx;if(foundSet.has(k))continue;
            try{const r=await eng.current.uds(a.tx,a.rx,[0x3E,0x00]);
              if(r.ok){addMod(m.c,m.n,a.tx,a.rx,'(CAN-IHS)');addLog(m.c+' alive on CAN-IHS','rx');break;}
            }catch(e){}
            await new Promise(r=>setTimeout(r,30));
          }
        }
      }else{addLog('STP61 not supported: '+sw1,'warn');}

      /* ═══ LAYER 5: CAN-IHS at 500kbps (bench may run body bus at 500k) ═══ */
      addLog('── Layer 5: CAN-IHS pins 3/11 at 500kbps ──','info');
      await eng.current.send('ATSP6');await new Promise(r=>setTimeout(r,200));
      await eng.current.send('ATCRA');await eng.current.send('ATSH7DF');
      const ihs500=await eng.current.send('22 F1 90',4000);
      if(ihs500&&!ihs500.includes('NO DATA')&&!ihs500.includes('CAN ERROR')){
        addLog('CAN-IHS 500k responses: '+ihs500.substring(0,120),'rx');
        const il=ihs500.split(/[\r\n]+/);
        for(const bl of il){const bt=bl.trim();if(/^[0-9A-Fa-f]{3}\s/.test(bt)){
          const rid=parseInt(bt.slice(0,3),16);const tid=rid-8;
          let mname='IHS500_'+tid.toString(16).toUpperCase();for(const m of MODS){for(const a of m.addrs){if(a.rx===rid||a.tx===tid){mname=m.c;break;}}}
          addMod(mname,mname,tid,rid,'(IHS-500k)');
          addLog('Found '+mname+' on CAN-IHS 500k','rx');
        }}
      }

      /* Switch back to CAN-C */
      await eng.current.send('ATSP6');
      try{await eng.current.send('STP60');}catch(e){}
      await new Promise(r=>setTimeout(r,100));
      await eng.current.send('ATST96');
      addLog('── Back on CAN-C ──','info');
    }

    /* ═══ LAYER 6: Brute force sweep 0x600-0x7FF on CAN-C ═══ */
    if(foundSet.size<=1){
      addLog('── Layer 6: Brute force sweep 0x600-0x7FF ──','info');
      await eng.current.send('ATSP6');
      for(let tx=0x600;tx<=0x7FF;tx+=1){
        const rx=tx+8;const k=tx+':'+rx;if(foundSet.has(k))continue;
        try{
          await eng.current.send('ATSH'+tx.toString(16).toUpperCase().padStart(3,'0'));
          await eng.current.send('ATCRA'+rx.toString(16).toUpperCase().padStart(3,'0'));
          const r=await eng.current.send('3E 00',1500);
          if(r&&!r.includes('NO DATA')&&!r.includes('CAN ERROR')&&!r.includes('?')&&r.trim().length>3){
            const tidH=tx.toString(16).toUpperCase().padStart(3,'0');
            let mname='MODULE_'+tidH;for(const m of MODS){for(const a of m.addrs){if(a.tx===tx){mname=m.c;break;}}}
            addMod(mname,mname,tx,rx,'(brute)');
            addLog('FOUND at TX:'+tidH+' → '+r.substring(0,60),'rx');
          }
        }catch(e){}
        if(tx%32===0)addLog('Sweep: 0x'+tx.toString(16).toUpperCase()+'...','info');
      }
    }

    setBusy('');addLog('═══ Scan complete: found '+foundSet.size+' modules ═══','info');
  },[]);

  const writeAll=useCallback(async()=>{
    if(!eng.current||nv.length!==17)return;setBusy('Writing...');setProg(0);
    for(let i=0;i<found.length;i++){const m=found[i];
      await eng.current.uds(m.tx,m.rx,[0x10,0x03]);
      const sr=await eng.current.uds(m.tx,m.rx,[0x27,0x01]);
      if(sr.ok&&sr.d){const sb=Array.from(sr.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
        if(sv){const k=cda6(sv);await eng.current.uds(m.tx,m.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);addLog(m.c+' unlocked','rx');}}
      const vb=[...new TextEncoder().encode(nv)];
      for(const did of[0xF190,0x7B90,0x7B88]){const r=await eng.current.uds(m.tx,m.rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);addLog(m.c+' DID 0x'+did.toString(16).toUpperCase()+': '+(r.ok?'OK':'FAIL'),r.ok?'rx':'error');}
      await eng.current.uds(m.tx,m.rx,[0x11,0x01]);addLog(m.c+' reset sent','info');
      setProg(Math.round(((i+1)/found.length)*100));
    }setBusy('');addLog('All modules written','info');
  },[found,nv]);

  const readProxi=useCallback(async()=>{
    if(!eng.current)return;setBusy('Reading proxi...');
    const r=await eng.current.uds(0x750,0x758,[0x22,0x20,0x23]);
    if(r.ok)addLog('BCM Proxi: '+hxb(r.d),'rx');else addLog('Proxi read failed','error');
    setBusy('');
  },[]);

  const readSkim=useCallback(async()=>{
    if(!eng.current)return;setBusy('Reading SKIM...');
    const r=await eng.current.uds(0x750,0x758,[0x22,0x6E,0x9E,0xB0]);
    if(r.ok){const v=r.d?.length>0?r.d[r.d.length-1]:null;addLog('SKIM State: '+(v===0x80?'ENABLED':'DISABLED')+' (0x'+(v?.toString(16).toUpperCase()||'??')+')','rx');}
    else addLog('SKIM read failed','error');setBusy('');
  },[]);

  const writeOneModule=useCallback(async(tx,rx,label)=>{
    if(!eng.current||nv.length!==17)return;setBusy('Writing '+label+'...');
    try{
      await eng.current.uds(tx,rx,[0x10,0x03]);
      const sr=await eng.current.uds(tx,rx,[0x27,0x01]);
      if(sr.ok&&sr.d){const sb=Array.from(sr.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
        if(sv){const k=cda6(sv);await eng.current.uds(tx,rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);addLog(label+' unlocked','rx');}}
      const vb=[...new TextEncoder().encode(nv)];
      for(const did of[0xF190,0x7B90,0x7B88]){const r=await eng.current.uds(tx,rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);addLog(label+' DID 0x'+did.toString(16).toUpperCase()+': '+(r.ok?'OK':'FAIL'),r.ok?'rx':'error');}
      await eng.current.uds(tx,rx,[0x11,0x01]);addLog(label+' VIN written + reset','rx');
    }catch(e){addLog(label+' error: '+e.message,'error');}finally{setBusy('');}
  },[nv]);

  const virginRfhub=useCallback(async()=>{
    if(!eng.current)return;setBusy('Virginizing RFHUB...');
    await eng.current.uds(0x75F,0x767,[0x10,0x03]);
    const sr=await eng.current.uds(0x75F,0x767,[0x27,0x01]);
    if(sr.ok&&sr.d){const sb=Array.from(sr.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
      if(sv){const k=cda6(sv);await eng.current.uds(0x75F,0x767,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);}}
    const blank=new Array(17).fill(0x00);
    for(const did of[0xF190,0x7B90]){await eng.current.uds(0x75F,0x767,[0x2E,(did>>8)&0xFF,did&0xFF,...blank]);}
    await eng.current.uds(0x75F,0x767,[0x11,0x01]);
    addLog('RFHUB virginized over OBD','rx');setBusy('');
  },[]);

  return<div style={{display:'grid',gridTemplateColumns:'1fr 300px',gap:16}}>
    <div>
      <Card glow style={{marginBottom:14}}>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          <Btn onClick={connect} disabled={conn} color={conn?C.gn:C.a3} full>{conn?'✓ Connected to OBDLink':'🔌 Connect OBDLink EX'}</Btn>
          {conn&&<Btn onClick={scan} disabled={!!busy} color={C.a1}>{busy||'📡 Scan Modules'}</Btn>}
        </div>
      </Card>
      {found.length>0&&<Card glow style={{marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:12}}>Modules on Bus ({found.length})</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {found.map((m,i)=><div key={i} style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:13,fontWeight:800,color:C.sr}}>{m.c}</div>
            <div style={{fontSize:9,color:C.ts}}>{m.n} · TX 0x{m.tx.toString(16).toUpperCase()}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a1,fontWeight:700,marginTop:4}}>{m.vin}</div>
          </div>)}
        </div>
      </Card>}
      {conn&&<Card glow style={{marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>Write VIN to All Modules</div>
        <input value={nv} maxLength={17} placeholder="Enter 17-character VIN" onChange={e=>setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))}
          style={{width:'100%',padding:'12px 16px',borderRadius:12,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:16,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box'}}
          onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:10,alignItems:'center'}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:nv.length===17?C.sr:C.tm}}>{nv.length}/17</span>
          <Btn onClick={writeAll} disabled={nv.length!==17||!found.length||!!busy}>{busy||'⚡ Write to '+found.length+' modules'}</Btn>
        </div>
        {prog>0&&prog<100&&<div style={{marginTop:10,height:5,borderRadius:3,background:C.bd,overflow:'hidden'}}><div style={{height:'100%',width:prog+'%',background:'linear-gradient(90deg,#D32F2F,#FF5252)',borderRadius:3,transition:'width 0.4s'}}/></div>}
      </Card>}
      {conn&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>Quick Tools</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <Btn onClick={readProxi} disabled={!!busy} color={C.a3} outline>📋 Read BCM Proxi</Btn>
          <Btn onClick={readSkim} disabled={!!busy} color={C.a2} outline>🛡️ Read SKIM State</Btn>
          <Btn onClick={virginRfhub} disabled={!!busy} color={C.er} outline>💀 Virginize RFHUB</Btn>
        </div>
        <div style={{marginTop:12,fontSize:12,fontWeight:800,color:C.tx,marginBottom:8}}>Write VIN to Single Module</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <Btn onClick={()=>writeOneModule(0x7A8,0x7B0,'ADCM')} disabled={!!busy||nv.length!==17} color={C.a4} outline>🔧 Write DAMP</Btn>
          <Btn onClick={()=>writeOneModule(0x740,0x748,'IPC')} disabled={!!busy||nv.length!==17} color={C.a1} outline>🔧 Write IPC</Btn>
          <Btn onClick={()=>writeOneModule(0x7E0,0x7E8,'ECM')} disabled={!!busy||nv.length!==17} color={C.a2} outline>🔧 Write ECM</Btn>
          <Btn onClick={()=>writeOneModule(0x7E1,0x7E9,'TCM')} disabled={!!busy||nv.length!==17} color={C.a3} outline>🔧 Write TCM</Btn>
        </div>
        <div style={{marginTop:6,fontSize:9,color:C.wn}}>{nv.length!==17?'↑ Enter VIN above to enable individual writes':''}</div>
        <div style={{marginTop:10,fontSize:10,color:C.ts}}>
          <div><b>DIDs:</b> 0xF190 VIN · 0x7B90 Current · 0x7B88 Original · 0x2023 Proxi · 0x6E9EB0 SKIM</div>
          <div><b>Security:</b> Extended session (10 03) → Seed (27 01) → CDA6 key → Send (27 02) → Write (2E) → Reset (11 01)</div>
        </div>
      </Card>}
    </div>
    <div style={{background:C.cd,borderRadius:14,padding:14,border:'1px solid '+C.bd,maxHeight:600,overflow:'auto',boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
      <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:8,letterSpacing:2}}>UDS TRAFFIC LOG</div>
      {log.map((e,i)=><div key={i} style={{fontSize:9,fontFamily:"'JetBrains Mono'",padding:'2px 0',color:e.l==='error'?C.er:e.l==='tx'?C.a3:e.l==='rx'?C.sr:C.ts}}>
        <span style={{color:C.tm,marginRight:4}}>{e.t}</span>{e.m}
      </div>)}
      {!log.length&&<div style={{fontSize:11,color:C.tm,textAlign:'center',padding:30}}>Connect to see traffic</div>}
    </div>
  </div>;
}

/* ═══ DUMPS TAB ═══ */
function DumpsTab({files,setFiles,loadF}){
  const[sel,setSel]=useState(null);const[nv,setNv]=useState('');const[msg,setMsg]=useState('');
  const f=sel!==null?files[sel]:null;const cv=useMemo(()=>nv.length===17?checkVin(nv):null,[nv]);
  const dl=(d,n)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();};
  const doPatch=()=>{if(!f||nv.length!==17)return;const r=patchFile(f,nv);dl(r.data,'PATCHED_'+nv+'_'+f.name);const u=[...files];u[sel]=analyzeFile(r.data.buffer,f.name);setFiles(u);setMsg('Patched '+r.log.length+' locations');};
  const doVirgin=()=>{if(!f)return;const r=virginizeFile(f);dl(r.data,'VIRGIN_'+f.name);setMsg('Virginized: '+r.log.join(', '));};

  if(!files.length)return<div onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin,.BIN';i.onchange=e=>loadF(e.target.files);i.click();}} onDrop={e=>{e.preventDefault();loadF(e.dataTransfer.files);}} onDragOver={e=>e.preventDefault()}>
    <Card style={{textAlign:'center',padding:'60px 24px',cursor:'pointer',border:'2.5px dashed #D32F2F30'}} onClick={()=>{}}>
      <div style={{fontSize:52,marginBottom:10}}>📂</div>
      <div style={{fontSize:20,fontWeight:900,color:C.sr}}>Drop EEPROM or Firmware Files</div>
      <div style={{fontSize:13,color:C.ts,marginTop:6}}>Auto-detects BCM · 95640 · RFHUB EEE · GPEC2A</div>
      <div style={{display:'flex',gap:8,justifyContent:'center',marginTop:18,flexWrap:'wrap'}}>
        {[['BCM D-FLASH',C.a1],['95640',C.a4],['RFHUB EEE',C.a3],['GPEC2A',C.a2]].map(([l,c])=><Tag key={l} color={c}>{l}</Tag>)}
      </div>
    </Card></div>;

  return<div style={{display:'grid',gridTemplateColumns:'260px 1fr',gap:18,alignItems:'start'}}>
    <div>
      <Btn onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin,.BIN';i.onchange=e=>loadF(e.target.files);i.click();}} full>+ Add Files</Btn>
      <div style={{marginTop:10,display:'flex',flexDirection:'column',gap:7}}>
        {files.map((fi,i)=><Card key={i} onClick={()=>{setSel(i);setMsg('');}} style={{padding:13,borderColor:sel===i?C.sr:C.bd}}>
          <div style={{fontSize:12,fontWeight:800,color:sel===i?C.sr:C.tx,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{fi.name}</div>
          <div style={{display:'flex',gap:4,marginTop:5,alignItems:'center',flexWrap:'wrap'}}><Tag color={TC[fi.type]||C.tm}>{TL[fi.type]||fi.type}</Tag><span style={{fontSize:10,color:C.tm}}>{(fi.size/1024).toFixed(0)}KB</span><span style={{fontSize:10,color:C.tm}}>{fi.vins.length}V{fi.partials?.length>0?'+'+fi.partials.length+'p':''}</span></div>
          {fi.vins[0]&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a1,fontWeight:700,marginTop:5}}>{fi.vins[0].vin}</div>}
        </Card>)}
      </div>
      {files.length>=2&&<Card style={{marginTop:10,padding:12}}><div style={{fontSize:10,fontWeight:800,color:C.a1,marginBottom:4,letterSpacing:1}}>CROSS-MATCH</div>
        {(()=>{const vs={};files.forEach(fi=>fi.vins.forEach(v=>{vs[v.vin]=(vs[v.vin]||0)+1;}));return Object.entries(vs).map(([vin,ct])=><div key={vin} style={{fontSize:10,fontFamily:"'JetBrains Mono'"}}><span style={{color:ct===files.length?C.gn:C.wn}}>{vin}</span><span style={{color:C.tm,marginLeft:4}}>{ct}/{files.length}{ct===files.length?' ✓':''}</span></div>);})()}
      </Card>}
    </div>
    {f&&<div>
      <Card glow style={{marginBottom:14}}>
        <div style={{fontSize:16,fontWeight:900,marginBottom:14}}>⚡ PATCH VIN</div>
        <input value={nv} maxLength={17} placeholder="Enter new 17-character VIN" onChange={e=>setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))} style={{width:'100%',padding:'12px 16px',borderRadius:12,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:16,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box'}} onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:8,flexWrap:'wrap',gap:4}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:nv.length===17?C.gn:C.tm}}>{nv.length}/17</span>
          {cv&&<div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap'}}>
            {cv.ok?<Tag color={C.gn}>✓ Valid</Tag>:<Tag color={C.er}>{cv.err||'Invalid'}</Tag>}
            {cv.mfr&&<Tag color={C.a3}>{cv.mfr}</Tag>}
            {cv.yr&&<Tag color={C.a2}>{cv.yr}</Tag>}
          </div>}
        </div>
        <div style={{display:'flex',gap:8,marginTop:14,flexWrap:'wrap'}}>
          <Btn onClick={doPatch} disabled={nv.length!==17} full>⚡ Patch VIN + Download</Btn>
        </div>
        <div style={{display:'flex',gap:8,marginTop:8}}>
          <Btn onClick={doVirgin} color={C.er} outline>💀 Virginize</Btn>
          <Btn onClick={()=>dl(f.data,f.name)} color={C.a3} outline>💾 Download</Btn>
        </div>
        {msg&&<div style={{marginTop:10,padding:'9px 12px',borderRadius:10,background:C.gn+'10',border:'1px solid '+C.gn+'25',fontSize:11,color:C.gn,fontWeight:700}}>✓ {msg}</div>}
      </Card>
      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>VIN Locations ({f.vins.length} full{f.partials?.length>0?', '+f.partials.length+' partial':''})</div>
        {f.vins.map((v,i)=><div key={i} style={{padding:'8px 10px',borderRadius:8,marginBottom:4,background:C.c2,border:'1px solid '+C.bd,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:4}}>
          <div><span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>0x{v.off.toString(16).toUpperCase()} </span><span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:C.a1}}>{v.vin}</span>{v.mirrored&&<Tag color={C.a3}>MIRRORED</Tag>}</div>
          <div>{v.algo==='c16'&&<Tag color={C.gn}>CRC16 ✓</Tag>}{v.algo==='c8'&&<Tag color={v.ok?C.gn:C.wn}>CRC8 {v.ok?'✓':'!'}</Tag>}{v.algo==='none'&&<Tag color={C.a2}>No CRC</Tag>}</div>
        </div>)}
        {f.partials?.map((v,i)=><div key={'p'+i} style={{padding:'6px 10px',borderRadius:8,marginBottom:4,background:'#FFF8E1',border:'1px solid #FFE082',fontSize:11}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>0x{v.off.toString(16).toUpperCase()} </span><span style={{fontFamily:"'JetBrains Mono'",fontWeight:700,color:C.a1}}>…{v.vin}</span><Tag color={C.wn}>PARTIAL</Tag>
        </div>)}
      </Card>
      {f.sec&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 Security</div>
        {f.sec.t==='bcm'&&<><div style={{fontSize:11,marginBottom:6}}>Immo @0x40C0: <Tag color={f.sec.b1?C.wn:C.gn}>{f.sec.b1?'BLANK':f.sec.immoRecs+' SKIM keys'}</Tag></div><div style={{fontSize:11,marginBottom:6}}>Backup @0x2000: <Tag color={f.sec.b2?C.tm:C.gn}>{f.sec.b2?'BLANK':f.sec.bakRecs+' keys'}</Tag>{!f.sec.b2&&!f.sec.b1&&<Tag color={f.sec.immoSynced?C.gn:C.wn}>{f.sec.immoSynced?'SYNCED ✓':'OUT OF SYNC'}</Tag>}</div>{!f.sec.b1&&(f.sec.b2||!f.sec.immoSynced)&&<div style={{marginTop:6}}><Btn onClick={()=>{const d=syncImmoBackup(f.data);if(!d){setMsg('BCM file too small for IMMO sync');return;}dl(d,'IMMO_SYNCED_'+f.name);const u=[...files];u[sel]=analyzeFile(d.buffer,f.name);setFiles(u);setMsg('IMMO backup synced: '+f.sec.immoRecs+' keys copied to 0x2000');}} color={C.a1} outline>🔄 Sync IMMO Backup</Btn></div>}</>}
        {f.sec.t==='95640'&&<><div style={{fontSize:11,marginBottom:4}}>Secret Key @0x40: <Tag color={f.sec.kb?C.wn:C.gn}>{f.sec.kb?'ERASED':'SET'}</Tag></div>{!f.sec.kb&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a4,marginBottom:4}}>{hxb(f.sec.key)}</div>}<div style={{fontSize:11}}>Fob Data: <Tag color={f.sec.fb?C.tm:C.gn}>{f.sec.fb?'NONE':'HAS FOBS'}</Tag></div></>}
        {f.sec.t==='rfhub'&&<><div style={{fontSize:11,marginBottom:4}}>Secret Key @0x40: <Tag color={f.sec.kb?C.wn:C.gn}>{f.sec.kb?'ERASED':'SET'}</Tag></div>{!f.sec.kb&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a4}}>{hxb(f.sec.key)}</div>}</>}
        {f.sec.t==='gpec2a'&&<><div style={{fontSize:11,marginBottom:4}}>SKIM: <Tag color={f.sec.on?C.gn:C.wn}>{f.sec.on?'ENABLED 0x80':'OFF 0x'+f.sec.skim.toString(16).toUpperCase()}</Tag></div><div style={{fontSize:11,marginBottom:4}}>Secret Key: {!f.sec.key.every(b=>b===0xFF)?<><span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a4}}>{hxb(f.sec.key)}</span><Tag color={f.sec.km?C.gn:C.er}>{f.sec.km?'Mirror ✓':'MISMATCH'}</Tag></>:<Tag color={C.wn}>BLANK</Tag>}</div><div style={{fontSize:11}}>ZZZZ Tamper: <Tag color={f.sec.zz?C.gn:C.er}>{f.sec.zz?'INTACT':'TAMPERED'}</Tag></div></>}
      </Card>}
      <Card style={{padding:14}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:8}}>Hex Viewer</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,background:C.c2,borderRadius:10,padding:10,maxHeight:320,overflow:'auto',border:'1px solid '+C.bd}}>
          {Array.from({length:Math.min(32,Math.ceil(f.size/16))},(_,row)=>{const a=row*16;const bs=f.data.slice(a,Math.min(a+16,f.size));const iv=f.vins.some(v=>a+16>v.off&&a<v.off+17);return<div key={row} style={{display:'flex',gap:8,padding:'1px 4px',background:iv?'#D32F2F06':'transparent',borderRadius:3}}>
            <span style={{color:C.tm,minWidth:48,fontWeight:600}}>{a.toString(16).toUpperCase().padStart(6,'0')}</span>
            <span style={{flex:1}}>{Array.from(bs).map((b,j)=>{const isV=f.vins.some(v=>(a+j)>=v.off&&(a+j)<v.off+17);return<span key={j} style={{color:isV?C.sr:b===0xFF?'#D5D0C8':b===0?'#C8C3BB':C.ts,fontWeight:isV?800:400}}>{b.toString(16).toUpperCase().padStart(2,'0')} </span>;})}</span>
            <span style={{color:C.tm,minWidth:90,fontSize:9}}>{Array.from(bs).map(b=>b>=32&&b<=126?String.fromCharCode(b):'·').join('')}</span>
          </div>;})}
        </div>
      </Card>
    </div>}
  </div>;
}

/* ═══ SEED → KEY TAB ═══ */
function SeedTab(){
  const[al,setAl]=useState('gpec2');const[sh,setSh]=useState('');const[res,setRes]=useState(null);const[all,setAll]=useState(false);
  const calc=useCallback(()=>{
    const raw=sh.replace(/\s/g,'');const v=parseInt(raw,16);if(isNaN(v)||!raw)return;
    if(all){setRes({multi:true,results:ALGOS.map(a=>({n:a.n,h:a.h,k:a.fn(v).toString(16).toUpperCase().padStart(8,'0')})),seed:v.toString(16).toUpperCase().padStart(8,'0')});}
    else{const a=ALGOS.find(x=>x.id===al);if(!a)return;setRes({multi:false,n:a.n,seed:v.toString(16).toUpperCase().padStart(8,'0'),key:a.fn(v).toString(16).toUpperCase().padStart(8,'0')});}
  },[al,sh,all]);

  return<div style={{maxWidth:760}}>
    <Card glow>
      <div style={{fontSize:18,fontWeight:900,marginBottom:4}}>🔑 Seed → Key Calculator</div>
      <div style={{fontSize:12,color:C.ts,marginBottom:16}}>14 algorithms extracted from FCA security access routines</div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))',gap:6,marginBottom:16}}>
        {ALGOS.map(a=><div key={a.id} onClick={()=>{setAl(a.id);setAll(false);}} style={{
          padding:'9px 11px',borderRadius:10,cursor:'pointer',transition:'all 0.2s',
          background:al===a.id&&!all?C.sr+'12':C.c2,border:`1.5px solid ${al===a.id&&!all?C.sr:C.bd}`}}>
          <div style={{fontSize:11,fontWeight:800,color:al===a.id&&!all?C.sr:C.tx}}>{a.n}</div>
          <div style={{fontSize:8,color:C.tm}}>{a.h}</div>
        </div>)}
        <div onClick={()=>setAll(true)} style={{padding:'9px 11px',borderRadius:10,cursor:'pointer',background:all?C.a4+'12':C.c2,border:`1.5px solid ${all?C.a4:C.bd}`}}>
          <div style={{fontSize:11,fontWeight:800,color:all?C.a4:C.tx}}>ALL</div>
          <div style={{fontSize:8,color:C.tm}}>Run all 14</div>
        </div>
      </div>

      <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:2}}>SEED (HEX)</div>
      <input value={sh} placeholder="e.g. A1B2C3D4" onChange={e=>setSh(e.target.value.toUpperCase().replace(/[^A-F0-9\s]/g,''))}
        style={{width:'100%',padding:'14px 16px',borderRadius:12,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:20,fontWeight:700,letterSpacing:4,textAlign:'center',outline:'none',boxSizing:'border-box'}}
        onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}
        onKeyDown={e=>{if(e.key==='Enter')calc();}}/>
      <div style={{marginTop:12}}><Btn onClick={calc} disabled={!sh.trim()} full>Calculate Key</Btn></div>

      {res&&!res.multi&&<div style={{marginTop:20,padding:20,borderRadius:14,background:C.c2,border:'1.5px solid '+C.bd}}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 40px 1fr',gap:12,alignItems:'center'}}>
          <div><div style={{fontSize:9,color:C.tm,letterSpacing:2,marginBottom:6}}>SEED</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:26,fontWeight:800,color:C.a3}}>{res.seed}</div></div>
          <div style={{textAlign:'center',fontSize:20,color:C.tm}}>→</div>
          <div><div style={{fontSize:9,color:C.tm,letterSpacing:2,marginBottom:6}}>KEY</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:26,fontWeight:800,color:C.sr}}>{res.key}</div></div>
        </div>
        <div style={{marginTop:8,fontSize:11,color:C.tm}}>{res.n}</div>
      </div>}

      {res&&res.multi&&<div style={{marginTop:20}}>
        <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Seed: <span style={{fontFamily:"'JetBrains Mono'",color:C.a3}}>{res.seed}</span></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
          {res.results.map((r,i)=><div key={i} style={{padding:'10px 12px',borderRadius:10,background:C.c2,border:'1px solid '+C.bd,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div><div style={{fontSize:11,fontWeight:800,color:C.tx}}>{r.n}</div><div style={{fontSize:8,color:C.tm}}>{r.h}</div></div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:800,color:C.sr}}>{r.k}</div>
          </div>)}
        </div>
      </div>}
    </Card>
  </div>;
}

/* ═══ GPEC UNLOCK TAB ═══ */
function GpecTab(){
  const[fw,setFw]=useState(null);const[res,setRes]=useState(null);
  const load=useCallback(e=>{
    const f=e.target.files[0];if(!f)return;
    const r=new FileReader();r.onload=ev=>{const d=new Uint8Array(ev.target.result);setFw({name:f.name,data:d,size:d.length});setRes(null);};r.readAsArrayBuffer(f);
  },[]);
  const unlock=useCallback(()=>{
    if(!fw)return;const d=new Uint8Array(fw.data);
    if(d.length<=0x2FFFC){setRes({ok:false,msg:'File too small — need at least 192KB'});return;}
    const cur=d[0x2FFFC];
    if(cur===0x96){setRes({ok:false,msg:'Already unlocked (0x2FFFC = 0x96)'});return;}
    d[0x2FFFC]=0x96;setRes({ok:true,msg:'Unlock flag set: 0x2FFFC changed from 0x'+cur.toString(16).toUpperCase()+' → 0x96',data:d});
  },[fw]);
  const dl=useCallback(()=>{
    if(!res?.data)return;const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([res.data]));a.download='UNLOCKED_'+fw.name;a.click();
  },[res,fw]);

  return<div style={{maxWidth:640}}>
    <Card glow>
      <div style={{fontSize:18,fontWeight:900,marginBottom:4}}>🔓 GPEC Firmware Unlock</div>
      <div style={{fontSize:12,color:C.ts,marginBottom:20}}>Sets byte at offset 0x2FFFC to 0x96 — cracked from .NET IL disassembly</div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        <label style={{cursor:'pointer'}}>
          <div style={{padding:24,borderRadius:14,background:C.c2,border:'2px dashed '+C.bd,textAlign:'center',transition:'all 0.2s'}}>
            <div style={{fontSize:32}}>📂</div>
            <div style={{fontSize:12,fontWeight:800,color:C.ts,marginTop:6}}>Load Firmware</div>
            {fw&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a3,marginTop:6}}>{fw.name} ({(fw.size/1024).toFixed(0)}KB)</div>}
          </div>
          <input type="file" hidden onChange={load} accept=".bin,.BIN"/>
        </label>
        <div onClick={fw?unlock:undefined} style={{padding:24,borderRadius:14,background:fw?C.sr+'08':C.c2,border:'2px solid '+(fw?C.sr+'30':C.bd),textAlign:'center',cursor:fw?'pointer':'default',opacity:fw?1:0.4,transition:'all 0.2s'}}>
          <div style={{fontSize:32}}>🔓</div>
          <div style={{fontSize:12,fontWeight:800,color:C.sr,marginTop:6}}>Unlock</div>
        </div>
      </div>

      {fw&&<div style={{marginTop:14,padding:'10px 14px',borderRadius:10,background:C.c2,border:'1px solid '+C.bd}}>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts}}>
          <span style={{color:C.tm}}>0x2FFFC = </span>
          <span style={{fontWeight:800,color:fw.data.length>0x2FFFC?(fw.data[0x2FFFC]===0x96?C.gn:C.a1):C.er}}>
            {fw.data.length>0x2FFFC?'0x'+fw.data[0x2FFFC].toString(16).toUpperCase():'N/A'}
          </span>
          {fw.data.length>0x2FFFC&&fw.data[0x2FFFC]===0x96&&<span style={{color:C.gn,marginLeft:8}}>✓ Already unlocked</span>}
        </div>
      </div>}

      {res&&<div style={{marginTop:14,padding:16,borderRadius:12,background:res.ok?C.gn+'10':C.wn+'10',border:'1px solid '+(res.ok?C.gn:C.wn)+'30'}}>
        <div style={{fontSize:13,fontWeight:800,color:res.ok?C.gn:C.wn}}>{res.ok?'✓ ':'⚠ '}{res.msg}</div>
        {res.ok&&<div style={{marginTop:10}}><Btn onClick={dl} color={C.gn}>💾 Download Unlocked Firmware</Btn></div>}
      </div>}
    </Card>
  </div>;
}

/* ═══ GPEC2A TOOLS TAB (Piece 5) ═══ */
function Gpec2aTab(){
  const[f,setF]=useState(null);const[f2,setF2]=useState(null);const[msg,setMsg]=useState('');
  const load=(e,slot)=>{const fi=e.target.files[0];if(!fi)return;const r=new FileReader();r.onload=ev=>{const d=new Uint8Array(ev.target.result);if(d.length!==4096){setMsg('GPEC2A must be 4096 bytes');return;}const a=analyzeFile(d.buffer,fi.name);if(a.type!=='GPEC2A'){setMsg('Not a GPEC2A file');return;}if(slot===1)setF(a);else setF2(a);setMsg('');};r.readAsArrayBuffer(fi);};
  const dl=(d,n)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();};

  function toggleSkim(){if(!f)return;const p=new Uint8Array(f.data);p[0x11]=p[0x11]===0x80?0x00:0x80;setF(analyzeFile(p.buffer,f.name));dl(p,'SKIM_'+(p[0x11]===0x80?'ENABLED':'DISABLED')+'_'+f.name);setMsg('SKIM toggled to 0x'+p[0x11].toString(16).toUpperCase());}

  const diff=useMemo(()=>{if(!f||!f2)return[];const r=[];for(let i=0;i<Math.min(f.data.length,f2.data.length);i++)if(f.data[i]!==f2.data[i])r.push({off:i,a:f.data[i],b:f2.data[i]});return r;},[f,f2]);

  return<div>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
      <label style={{cursor:'pointer'}}><Card style={{textAlign:'center',padding:18}} onClick={()=>{}}>
        <div style={{fontSize:28}}>📂</div><div style={{fontSize:12,fontWeight:800,color:C.ts,marginTop:4}}>Load GPEC2A File 1</div>
        {f&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a2,marginTop:4}}>{f.name}</div>}
        <input type="file" hidden onChange={e=>load(e,1)} accept=".bin,.BIN"/>
      </Card></label>
      <label style={{cursor:'pointer'}}><Card style={{textAlign:'center',padding:18}} onClick={()=>{}}>
        <div style={{fontSize:28}}>📂</div><div style={{fontSize:12,fontWeight:800,color:C.ts,marginTop:4}}>Load File 2 (for diff)</div>
        {f2&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a2,marginTop:4}}>{f2.name}</div>}
        <input type="file" hidden onChange={e=>load(e,2)} accept=".bin,.BIN"/>
      </Card></label>
    </div>

    {f&&f.sec?.t==='gpec2a'&&<>
      <Card glow style={{marginBottom:14}}>
        <div style={{fontSize:16,fontWeight:900,marginBottom:12}}>⚙️ GPEC2A Analysis</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:14,borderRadius:12,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6}}>SKIM BYTE @ 0x0011</div>
            <div style={{fontSize:28,fontWeight:900,color:f.sec.on?C.gn:C.wn,fontFamily:"'JetBrains Mono'"}}>{f.sec.on?'ENABLED':'DISABLED'}</div>
            <div style={{fontSize:10,color:C.tm}}>0x{f.sec.skim.toString(16).toUpperCase().padStart(2,'0')}</div>
            <div style={{marginTop:8}}><Btn onClick={toggleSkim} color={f.sec.on?C.wn:C.gn} outline>{f.sec.on?'Disable SKIM':'Enable SKIM'}</Btn></div>
          </div>
          <div style={{padding:14,borderRadius:12,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6}}>ZZZZ TAMPER @ 0x0C8C</div>
            <div style={{fontSize:28,fontWeight:900,color:f.sec.zz?C.gn:C.er}}>{f.sec.zz?'INTACT':'TAMPERED'}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:9,color:C.ts,marginTop:4}}>{hxb(f.data.slice(0xC8C,0xC94))}</div>
          </div>
        </div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔑 Secret Key</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:10,color:C.tm,marginBottom:4}}>Primary @ 0x0203 (8B)</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:f.sec.key.every(b=>b===0xFF)?'#D5D0C8':C.a4}}>{hxb(f.sec.key)}</div>
          </div>
          <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:10,color:C.tm,marginBottom:4}}>Mirror @ 0x0361 (8B)</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:f.sec.mir.every(b=>b===0xFF)?'#D5D0C8':C.a4}}>{hxb(f.sec.mir)}</div>
          </div>
        </div>
        <div style={{marginTop:6,fontSize:10}}><Tag color={f.sec.km?C.gn:C.er}>{f.sec.km?'Primary = Mirror ✓':'MISMATCH'}</Tag></div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 Transponder Keys @ 0x0888</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {f.sec.tr.map((t,i)=>{const blank=t.every(b=>b===0xFF||b===0);return<div key={i} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+(blank?C.bd:C.gn+'40'),textAlign:'center'}}>
            <div style={{fontSize:10,fontWeight:700,color:C.tm}}>KEY {i+1}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:blank?'#D5D0C8':C.a4,marginTop:4}}>{hxb(t)}</div>
            <Tag color={blank?C.tm:C.gn}>{blank?'—':'SET'}</Tag>
          </div>;})}
        </div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>📊 Runtime Counters</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {[{n:'Counter 1',o:0xE61},{n:'Counter 2',o:0xE69},{n:'Counter 3',o:0xE6D},{n:'Counter 4',o:0xE75}].map(c=>{
            const v=(f.data[c.o]<<24|f.data[c.o+1]<<16|f.data[c.o+2]<<8|f.data[c.o+3])>>>0;
            return<div key={c.o} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd,textAlign:'center'}}>
              <div style={{fontSize:9,color:C.tm}}>{c.n}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.a1,marginTop:2}}>{v.toLocaleString()}</div>
              <div style={{fontSize:8,color:C.tm}}>0x{c.o.toString(16).toUpperCase()}</div>
            </div>;})}
        </div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:8}}>VINs</div>
        {f.vins.map((v,i)=><div key={i} style={{fontFamily:"'JetBrains Mono'",fontSize:12,marginBottom:4}}>
          <span style={{color:C.tm}}>0x{v.off.toString(16).toUpperCase().padStart(4,'0')}: </span>
          <span style={{fontWeight:800,color:C.a1}}>{v.vin}</span>
        </div>)}
      </Card>
    </>}

    {f&&f2&&<Card style={{padding:16}}>
      <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔀 Hex Diff — {diff.length} byte{diff.length!==1?'s':''} different</div>
      {diff.length===0&&<div style={{fontSize:12,color:C.gn,fontWeight:700}}>✓ Files are identical</div>}
      {diff.length>0&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,background:C.c2,borderRadius:8,padding:10,maxHeight:260,overflow:'auto',border:'1px solid '+C.bd}}>
        <div style={{display:'grid',gridTemplateColumns:'70px 1fr 1fr',gap:4,marginBottom:4}}>
          <span style={{fontWeight:700,color:C.tm}}>Offset</span><span style={{fontWeight:700,color:C.a1}}>File 1</span><span style={{fontWeight:700,color:C.a3}}>File 2</span>
        </div>
        {diff.slice(0,200).map((d,i)=><div key={i} style={{display:'grid',gridTemplateColumns:'70px 1fr 1fr',gap:4}}>
          <span style={{color:C.tm}}>0x{d.off.toString(16).toUpperCase().padStart(4,'0')}</span>
          <span style={{color:C.a1,fontWeight:700}}>0x{d.a.toString(16).toUpperCase().padStart(2,'0')}</span>
          <span style={{color:C.a3,fontWeight:700}}>0x{d.b.toString(16).toUpperCase().padStart(2,'0')}</span>
        </div>)}
        {diff.length>200&&<div style={{color:C.tm,marginTop:4}}>...and {diff.length-200} more</div>}
      </div>}
    </Card>}

    {msg&&<div style={{marginTop:10,padding:'8px 12px',borderRadius:8,background:C.gn+'10',fontSize:11,fontWeight:700,color:C.gn}}>✓ {msg}</div>}
    {!f&&<div style={{textAlign:'center',padding:30,color:C.tm,fontSize:12}}>Load a GPEC2A 4KB .bin file above</div>}
  </div>;
}

/* ═══ JAILBREAK OPTIONS — 50 SRT/Demon/Hellcat features ═══ */
const JAILBREAK_FEATURES=[
  {id:'vehicle_trim_level',n:'Vehicle Trim Level',d:'Configure vehicle trim level identification',did:0xDE01,off:0x00,opts:[{l:'SE',v:0},{l:'SXT',v:1},{l:'SXT Plus',v:2},{l:'GT',v:3},{l:'R/T',v:4},{l:'R/T Plus',v:5},{l:'R/T Scat Pack',v:6},{l:'Scat Pack Widebody',v:7},{l:'SRT 392',v:8},{l:'SRT Hellcat',v:9},{l:'Hellcat Widebody',v:10},{l:'SRT Hellcat Redeye',v:11},{l:'Redeye Widebody',v:12},{l:'SRT Jailbreak',v:13},{l:'SRT Super Stock',v:14},{l:'SRT Demon',v:15},{l:'SRT Demon 170',v:16}],notes:'Critical: Affects available features and performance settings'},
  {id:'engine_variant',n:'Engine Variant',d:'Engine configuration identifier',did:0xDE01,off:0x01,opts:[{l:'3.6L Pentastar V6',v:1},{l:'5.7L HEMI V8',v:2},{l:'6.4L HEMI 392 V8',v:3},{l:'6.2L Supercharged V8 (Hellcat)',v:4},{l:'6.2L Supercharged V8 (Redeye)',v:5},{l:'6.2L Supercharged V8 (Demon)',v:6},{l:'6.2L Supercharged V8 (Demon 170)',v:7}]},
  {id:'launch_control',n:'Launch Control',d:'Enable launch control system',did:0xDE01,off:0x10,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Available on SRT and performance models'},
  {id:'launch_control_rpm',n:'Launch Control RPM',d:'Target RPM for launch control',did:0xDE01,off:0x11,opts:[{l:'2000 RPM',v:20},{l:'2500 RPM',v:25},{l:'3000 RPM',v:30},{l:'3500 RPM',v:35},{l:'4000 RPM',v:40},{l:'4500 RPM',v:45},{l:'5000 RPM',v:50}],notes:'Optimal RPM varies by tire and conditions'},
  {id:'line_lock',n:'Line Lock',d:'Enable line lock for burnouts and tire warming',did:0xDE01,off:0x12,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'For track use only - holds front brakes while spinning rears'},
  {id:'line_lock_duration',n:'Line Lock Duration',d:'Maximum time line lock remains engaged',did:0xDE01,off:0x13,opts:[{l:'10 seconds',v:10},{l:'15 seconds',v:15},{l:'20 seconds',v:20},{l:'30 seconds',v:30},{l:'45 seconds',v:45}]},
  {id:'power_modes_available',n:'Power Modes Available',d:'Which drive modes are accessible',did:0xDE01,off:0x20,opts:[{l:'Street Only',v:1},{l:'Street + Sport',v:2},{l:'Street + Sport + Track',v:3},{l:'All Modes',v:4},{l:'All + Drag',v:5},{l:'SRT Modes',v:6}]},
  {id:'track_mode',n:'Track Mode',d:'Enable track mode for aggressive driving',did:0xDE01,off:0x21,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Adjusts throttle, transmission, and stability systems'},
  {id:'drag_mode',n:'Drag Mode',d:'Enable drag strip optimized mode',did:0xDE01,off:0x21,mask:0x02,opts:[{l:'Disabled',v:0},{l:'Enabled',v:2}],notes:'Optimizes for straight-line acceleration'},
  {id:'custom_mode',n:'Custom Drive Mode',d:'Enable user-configurable custom mode',did:0xDE01,off:0x21,mask:0x04,opts:[{l:'Disabled',v:0},{l:'Enabled',v:4}]},
  {id:'srt_performance_pages',n:'SRT Performance Pages',d:'Enable SRT performance monitoring pages',did:0xDE01,off:0x30,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Shows G-force meter, timers, gauges'},
  {id:'srt_pages_timers',n:'SRT Performance Timers',d:'Enable 0-60, 1/8 mile, 1/4 mile timers',did:0xDE01,off:0x30,mask:0x02,opts:[{l:'Disabled',v:0},{l:'Enabled',v:2}]},
  {id:'srt_pages_gauges',n:'SRT Performance Gauges',d:'Enable additional performance gauges',did:0xDE01,off:0x30,mask:0x04,opts:[{l:'Disabled',v:0},{l:'Enabled',v:4}],notes:'Oil temp, trans temp, boost pressure'},
  {id:'srt_pages_dyno',n:'SRT Dyno Test Page',d:'Enable on-board dyno testing feature',did:0xDE01,off:0x30,mask:0x08,opts:[{l:'Disabled',v:0},{l:'Enabled',v:8}]},
  {id:'trans_brake',n:'Trans Brake',d:'Enable transmission brake for drag racing',did:0xDE01,off:0x40,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Demon/Super Stock feature - holds trans while building boost'},
  {id:'trans_brake_rpm',n:'Trans Brake Target RPM',d:'RPM target when trans brake is engaged',did:0xDE01,off:0x41,opts:[{l:'2000 RPM',v:20},{l:'2200 RPM',v:22},{l:'2350 RPM',v:23},{l:'2500 RPM',v:25},{l:'2700 RPM',v:27}]},
  {id:'race_options_menu',n:'Race Options Menu',d:'Enable race options in driver settings',did:0xDE01,off:0x42,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}]},
  {id:'torque_reserve',n:'Torque Reserve',d:'Pre-load supercharger for faster launch',did:0xDE01,off:0x43,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Hellcat/Redeye/Demon feature - builds boost before launch'},
  {id:'torque_reserve_level',n:'Torque Reserve Level',d:'Amount of pre-load torque reserve',did:0xDE01,off:0x44,opts:[{l:'Low',v:1},{l:'Medium',v:2},{l:'High',v:3},{l:'Maximum',v:4}]},
  {id:'launch_assist',n:'Launch Assist',d:'Electronic launch assist system',did:0xDE01,off:0x45,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}]},
  {id:'esc_sport_mode',n:'ESC Sport Mode',d:'Electronic Stability Control sport setting',did:0xDE01,off:0x50,opts:[{l:'Full On',v:0},{l:'Sport',v:1},{l:'Track',v:2},{l:'Off',v:3}],notes:'Adjusts traction and stability thresholds'},
  {id:'traction_control_mode',n:'Traction Control Mode',d:'Traction control intervention level',did:0xDE01,off:0x51,opts:[{l:'Full',v:0},{l:'Sport',v:1},{l:'Minimal',v:2},{l:'Off',v:3}]},
  {id:'paddle_shifter_mode',n:'Paddle Shifter Mode',d:'Paddle shifter behavior',did:0xDE01,off:0x52,opts:[{l:'Auto Return',v:0},{l:'Manual Hold',v:1},{l:'Sport Auto',v:2}]},
  {id:'shift_light',n:'Shift Light',d:'Enable shift indicator light',did:0xDE01,off:0x53,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}]},
  {id:'shift_light_rpm',n:'Shift Light RPM',d:'RPM at which shift light activates',did:0xDE01,off:0x54,opts:[{l:'5000 RPM',v:50},{l:'5500 RPM',v:55},{l:'6000 RPM',v:60},{l:'6200 RPM',v:62},{l:'6400 RPM',v:64},{l:'6500 RPM',v:65}]},
  {id:'exhaust_mode',n:'Active Exhaust Mode',d:'Active exhaust valve settings',did:0xDE01,off:0x55,opts:[{l:'Auto',v:0},{l:'Quiet',v:1},{l:'Normal',v:2},{l:'Loud',v:3},{l:'Track',v:4}],notes:'Requires active exhaust option'},
  {id:'suspension_mode',n:'Adaptive Suspension Mode',d:'Adaptive damper settings',did:0xDE01,off:0x56,opts:[{l:'Auto',v:0},{l:'Comfort',v:1},{l:'Sport',v:2},{l:'Track',v:3}],notes:'Requires adaptive suspension'},
  {id:'steering_mode',n:'Steering Mode',d:'Electric power steering weight',did:0xDE01,off:0x57,opts:[{l:'Comfort',v:0},{l:'Normal',v:1},{l:'Sport',v:2}]},
  {id:'widebody_enabled',n:'Widebody Mode',d:'Enable widebody specific features',did:0xDE01,off:0x60,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Affects suspension and aero settings'},
  {id:'power_chiller',n:'Power Chiller',d:'Enable A/C-based supercharger cooling',did:0xDE01,off:0x61,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Demon/Super Stock feature - uses A/C to cool intercooler'},
  {id:'after_run_chiller',n:'After-Run Chiller',d:'Continue cooling after engine off',did:0xDE01,off:0x62,opts:[{l:'Disabled',v:0},{l:'1 minute',v:1},{l:'2 minutes',v:2},{l:'5 minutes',v:5},{l:'10 minutes',v:10}],notes:'Keeps supercharger cool between runs'},
  {id:'drag_mode_suspension',n:'Drag Mode Suspension',d:'Suspension settings for drag racing',did:0xDE01,off:0x63,opts:[{l:'Street',v:0},{l:'Soft Front / Stiff Rear',v:1},{l:'Drag Preset',v:2}],notes:'Optimizes weight transfer for drag launches'},
  {id:'rev_match',n:'Automatic Rev Match',d:'Automatic throttle blip on downshifts',did:0xDE01,off:0x64,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Manual transmission models'},
  {id:'supercharger_display',n:'Supercharger Boost Display',d:'Show supercharger boost gauge',did:0xDE02,off:0x00,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Hellcat/Redeye/Demon models'},
  {id:'intercooler_temp_display',n:'Intercooler Temperature Display',d:'Show intercooler coolant temperature',did:0xDE02,off:0x00,mask:0x02,opts:[{l:'Disabled',v:0},{l:'Enabled',v:2}]},
  {id:'oil_temp_display',n:'Oil Temperature Display',d:'Show engine oil temperature gauge',did:0xDE02,off:0x00,mask:0x04,opts:[{l:'Disabled',v:0},{l:'Enabled',v:4}]},
  {id:'trans_temp_display',n:'Transmission Temperature Display',d:'Show transmission fluid temperature',did:0xDE02,off:0x00,mask:0x08,opts:[{l:'Disabled',v:0},{l:'Enabled',v:8}]},
  {id:'g_force_meter',n:'G-Force Meter',d:'Show real-time G-force display',did:0xDE02,off:0x01,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}]},
  {id:'timer_0_60',n:'0-60 MPH Timer',d:'Built-in 0-60 mph acceleration timer',did:0xDE02,off:0x01,mask:0x02,opts:[{l:'Disabled',v:0},{l:'Enabled',v:2}]},
  {id:'timer_quarter_mile',n:'Quarter Mile Timer',d:'Built-in 1/4 mile elapsed time timer',did:0xDE02,off:0x01,mask:0x04,opts:[{l:'Disabled',v:0},{l:'Enabled',v:4}]},
  {id:'timer_eighth_mile',n:'1/8 Mile Timer',d:'Built-in 1/8 mile elapsed time timer',did:0xDE02,off:0x01,mask:0x08,opts:[{l:'Disabled',v:0},{l:'Enabled',v:8}]},
  {id:'reaction_time_display',n:'Reaction Time Display',d:'Show reaction time from launch',did:0xDE02,off:0x02,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}]},
  {id:'brake_temp_warning',n:'Brake Temperature Warning',d:'Alert when brake temperatures are high',did:0xDE02,off:0x10,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Requires brake temperature sensors'},
  {id:'drive_mode_memory',n:'Drive Mode Memory',d:'Remember last drive mode on restart',did:0xDE02,off:0x11,opts:[{l:'Reset to Default',v:0},{l:'Remember Last',v:1},{l:'Remember Sport',v:2},{l:'Remember All',v:3}]},
  {id:'launch_warning',n:'Launch Control Warning',d:'Show warning before launch control activation',did:0xDE02,off:0x12,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}]},
  {id:'performance_data_recorder',n:'Performance Data Recorder',d:'Record performance data to USB',did:0xDE02,off:0x20,mask:0x01,opts:[{l:'Disabled',v:0},{l:'Enabled',v:1}],notes:'Requires compatible USB storage'},
  {id:'valet_speed_limit',n:'Valet Speed Limit',d:'Maximum speed in valet mode',did:0xDE02,off:0x21,opts:[{l:'25 mph',v:25},{l:'35 mph',v:35},{l:'45 mph',v:45},{l:'55 mph',v:55}]},
  {id:'valet_rpm_limit',n:'Valet RPM Limit',d:'Maximum RPM in valet mode',did:0xDE02,off:0x22,opts:[{l:'3000 RPM',v:30},{l:'3500 RPM',v:35},{l:'4000 RPM',v:40},{l:'4500 RPM',v:45}]},
  {id:'throttle_response',n:'Throttle Response',d:'Accelerator pedal sensitivity',did:0xDE02,off:0x30,opts:[{l:'Comfort',v:0},{l:'Sport',v:1},{l:'Track',v:2}]},
  {id:'cylinder_deactivation',n:'Cylinder Deactivation (MDS)',d:'Multi-Displacement System control',did:0xDE02,off:0x31,opts:[{l:'Auto',v:0},{l:'Always Off',v:1}],notes:'Disabling improves performance but reduces fuel economy'},
];


function JailbreakTab(){
  const[conn,setConn]=useState(false);const[busy,setBusy]=useState('');
  const[log,setLog]=useState([]);const[bcmTx,setBcmTx]=useState(0x750);const[bcmRx,setBcmRx]=useState(0x758);
  const[values,setValues]=useState({});const[unlocked,setUnlocked]=useState(false);const[pending,setPending]=useState({});
  const[search,setSearch]=useState('');const[expanded,setExpanded]=useState({});
  const eng=useRef(null);
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-200),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  // Group by category for display
  const groups=useMemo(()=>{
    const g={'Vehicle Configuration':[],'Launch & Performance':[],'Drive Modes':[],'SRT Performance Pages':[],'Trans Brake & Race':[],'Handling & Stability':[],'Powertrain':[],'Aero & Cooling':[],'Gauges & Displays':[],'Telemetry':[],'Valet & Misc':[]};
    const map={'vehicle_trim_level':'Vehicle Configuration','engine_variant':'Vehicle Configuration',
      'launch_control':'Launch & Performance','launch_control_rpm':'Launch & Performance','line_lock':'Launch & Performance','line_lock_duration':'Launch & Performance','launch_assist':'Launch & Performance',
      'power_modes_available':'Drive Modes','track_mode':'Drive Modes','drag_mode':'Drive Modes','custom_mode':'Drive Modes','drive_mode_memory':'Drive Modes',
      'srt_performance_pages':'SRT Performance Pages','srt_pages_timers':'SRT Performance Pages','srt_pages_gauges':'SRT Performance Pages','srt_pages_dyno':'SRT Performance Pages',
      'trans_brake':'Trans Brake & Race','trans_brake_rpm':'Trans Brake & Race','race_options_menu':'Trans Brake & Race','torque_reserve':'Trans Brake & Race','torque_reserve_level':'Trans Brake & Race',
      'esc_sport_mode':'Handling & Stability','traction_control_mode':'Handling & Stability','paddle_shifter_mode':'Handling & Stability','suspension_mode':'Handling & Stability','steering_mode':'Handling & Stability','drag_mode_suspension':'Handling & Stability','rev_match':'Handling & Stability',
      'shift_light':'Powertrain','shift_light_rpm':'Powertrain','exhaust_mode':'Powertrain','throttle_response':'Powertrain','cylinder_deactivation':'Powertrain',
      'widebody_enabled':'Aero & Cooling','power_chiller':'Aero & Cooling','after_run_chiller':'Aero & Cooling',
      'supercharger_display':'Gauges & Displays','intercooler_temp_display':'Gauges & Displays','oil_temp_display':'Gauges & Displays','trans_temp_display':'Gauges & Displays',
      'g_force_meter':'Telemetry','timer_0_60':'Telemetry','timer_quarter_mile':'Telemetry','timer_eighth_mile':'Telemetry','reaction_time_display':'Telemetry','performance_data_recorder':'Telemetry','launch_warning':'Telemetry','brake_temp_warning':'Telemetry',
      'valet_speed_limit':'Valet & Misc','valet_rpm_limit':'Valet & Misc'};
    JAILBREAK_FEATURES.forEach(f=>{const c=map[f.id]||'Valet & Misc';g[c].push(f);});
    return Object.entries(g).filter(([,v])=>v.length>0);
  },[]);

  const filtered=useMemo(()=>{
    if(!search)return groups;
    const s=search.toLowerCase();
    return groups.map(([cat,feats])=>[cat,feats.filter(f=>f.id.toLowerCase().includes(s)||f.n.toLowerCase().includes(s)||f.d.toLowerCase().includes(s))]).filter(([,v])=>v.length>0);
  },[groups,search]);

  const connect=useCallback(async()=>{
    if(!navigator.serial){addLog('Web Serial not supported','error');return;}
    try{
      const port=await navigator.serial.requestPort();await port.open({baudRate:115200});
      const w=port.writable.getWriter();const rd=port.readable.getReader();const tdec=new TextDecoder();
      let rbuf='';
      const send=async(cmd,to=3000)=>{rbuf='';await w.write(new TextEncoder().encode(cmd+'\r'));addLog('TX > '+cmd,'tx');
        const deadline=Date.now()+to;
        while(Date.now()<deadline){
          try{const rp=rd.read();const tp=new Promise(r=>setTimeout(()=>r({value:undefined,done:true}),Math.min(500,deadline-Date.now())));
            const res=await Promise.race([rp,tp]);
            if(res.done||!res.value){if(Date.now()>=deadline)break;continue;}
            rbuf+=tdec.decode(res.value);const pi=rbuf.indexOf('>');
            if(pi!==-1){const r=rbuf.substring(0,pi).replace(/\r/g,'\n').replace(/\n+/g,'\n').trim();rbuf=rbuf.substring(pi+1);addLog('RX < '+r,'rx');return r;}
          }catch(e){break;}
        }
        const t=rbuf.replace(/\r/g,'\n').replace(/\n+/g,'\n').replace(/>/g,'').trim();if(t)addLog('RX (to) < '+t,'warn');return t;
      };
      await send('ATZ',3000);await new Promise(r=>setTimeout(r,800));
      await send('ATE0');const ati=await send('ATI');
      const stdi=await send('STDI');const isSTN=!stdi.includes('?')&&stdi.length>2;
      addLog('Adapter: '+(isSTN?'STN/OBDLink':'ELM327')+' ('+ati+')','info');
      if(isSTN){
        addLog('Setting MFG extended mode...','info');
        await send('ATPP2CSV81',2000);await send('ATPP2CON',2000);
        await send('ATPP2DSV01',2000);await send('ATPP2DON',2000);
        await send('ATZ',3000);await new Promise(r=>setTimeout(r,1000));
        await send('ATE0',2000);await new Promise(r=>setTimeout(r,200));
      }
      await send('ATL0');await send('ATS1');await send('ATH1');
      await send('ATSP6');await send('ATAT2');await send('ATST96');await send('ATCAF1');
      if(isSTN){await send('ATFCSH7E0');await send('ATFCSD300000');await send('ATFCSM1');}
      let curTx=0,curRx=0;
      eng.current={send,isSTN,uds:async(tx,rx,data)=>{
        if(tx!==curTx||rx!==curRx){
          await send('ATCRA');await send('ATSH'+hx(tx,3));
          if(isSTN)await send('ATFCSH'+hx(tx,3));
          await send('ATCRA'+hx(rx,3));curTx=tx;curRx=rx;
        }
        const h=Array.from(data).map(b=>hx(b)).join(' ');const r=await send(h,4000);
        if(!r||/NO DATA|CAN ERROR|UNABLE|BUS/.test(r))return{ok:false,raw:r||''};
        if(r.includes('?')||r.includes('ERROR'))return{ok:false,raw:r};
        const lines=r.split(/[\r\n]+/).map(l=>l.trim()).filter(Boolean);
        let all=[];
        for(const line of lines){
          if(line.includes('SEARCHING')||line==='OK')continue;
          const toks=line.split(/\s+/);
          if(toks.length<2)continue;
          if(/^[0-9A-F]{3}$/.test(toks[0].toUpperCase())){
            for(let i=1;i<toks.length;i++)if(/^[0-9A-Fa-f]{2}$/.test(toks[i]))all.push(parseInt(toks[i],16));
          }else{for(const t of toks)if(/^[0-9A-Fa-f]{2}$/.test(t))all.push(parseInt(t,16));}
        }
        if(!all.length)return{ok:false,raw:r};
        return{ok:true,d:new Uint8Array(all),raw:r};
      }};
      setConn(true);addLog('Connected','info');
    }catch(e){addLog('Connect failed: '+e.message,'error');}
  },[addLog]);

  const findBCM=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Finding BCM...');
    const cands=[[0x750,0x758,'CDA6'],[0x742,0x762,'CLAUDE'],[0x7E0,0x7E8,'Legacy'],[0x6B0,0x6B8,'DarkVIN']];
    for(const[tx,rx,lbl]of cands){
      addLog('Trying '+lbl+' @ TX:0x'+hx(tx,3),'info');
      const r=await eng.current.uds(tx,rx,[0x22,0xF1,0x90]);
      if(r.ok){setBcmTx(tx);setBcmRx(rx);addLog('BCM found @ '+lbl+' TX:0x'+hx(tx,3)+' RX:0x'+hx(rx,3),'rx');setBusy('');return;}
      await new Promise(r=>setTimeout(r,100));
    }
    addLog('BCM not found on any known address','error');setBusy('');
  },[addLog]);

  const unlock=useCallback(async()=>{
    if(!eng.current)return;setBusy('Unlocking BCM...');
    addLog('Entering extended session (10 03)...','info');
    let r=await eng.current.uds(bcmTx,bcmRx,[0x10,0x03]);
    if(!r.ok){addLog('Session failed','error');setBusy('');return;}
    addLog('Requesting seed (27 01)...','info');
    r=await eng.current.uds(bcmTx,bcmRx,[0x27,0x01]);
    if(!r.ok||!r.d||r.d.length<4){addLog('Seed request failed','error');setBusy('');return;}
    const sb=Array.from(r.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
    addLog('Seed: 0x'+hx(sv,8),'info');
    const k=cda6(sv);addLog('CDA6 key: 0x'+hx(k,8),'info');
    r=await eng.current.uds(bcmTx,bcmRx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
    if(r.ok){setUnlocked(true);addLog('BCM UNLOCKED','rx');}else addLog('Key rejected — try other algorithms','error');
    setBusy('');
  },[bcmTx,bcmRx,addLog]);

  const readAll=useCallback(async()=>{
    if(!eng.current||!unlocked){addLog('Unlock BCM first','error');return;}
    setBusy('Reading features...');
    const dids=[...new Set(JAILBREAK_FEATURES.map(f=>f.did))];const newVals={};
    for(const did of dids){
      addLog('Reading DID 0x'+hx(did,4)+'...','info');
      const r=await eng.current.uds(bcmTx,bcmRx,[0x22,(did>>8)&0xFF,did&0xFF]);
      if(r.ok&&r.d){
        // Response format: 62 DID_HI DID_LO [bytes]
        const data=r.d.length>3?Array.from(r.d).slice(3):Array.from(r.d);
        newVals[did]=data;addLog('DID 0x'+hx(did,4)+': '+data.length+' bytes','rx');
      }else{addLog('DID 0x'+hx(did,4)+': no response','warn');}
    }
    setValues(newVals);setPending({});setBusy('');addLog('Read complete','info');
  },[bcmTx,bcmRx,unlocked,addLog]);

  const setFeature=useCallback((feat,newValue)=>{
    setPending(p=>{const n={...p};n[feat.id]={feat,value:newValue};return n;});
  },[]);

  const writePending=useCallback(async()=>{
    if(!eng.current||!unlocked){addLog('Unlock BCM first','error');return;}
    const keys=Object.keys(pending);if(!keys.length){addLog('No pending changes','info');return;}
    setBusy('Writing '+keys.length+' features...');

    // Group pending by DID
    const byDid={};
    for(const id of keys){const p=pending[id];const d=p.feat.did;if(!byDid[d])byDid[d]=[];byDid[d].push(p);}

    for(const did of Object.keys(byDid).map(Number)){
      const cur=values[did]?[...values[did]]:new Array(256).fill(0);
      // Apply all pending changes for this DID
      for(const p of byDid[did]){
        const f=p.feat;
        if(f.mask!==undefined){
          cur[f.off]=(cur[f.off]&~f.mask)|(p.value&f.mask);
        }else{
          cur[f.off]=p.value&0xFF;
        }
      }
      // Determine payload length — use actual read length or default
      const origLen=(values[did]||[]).length||256;
      const payload=cur.slice(0,origLen);
      addLog('Writing DID 0x'+hx(did,4)+' ('+payload.length+' bytes)...','info');
      const r=await eng.current.uds(bcmTx,bcmRx,[0x2E,(did>>8)&0xFF,did&0xFF,...payload]);
      if(r.ok)addLog('DID 0x'+hx(did,4)+' written','rx');else addLog('DID 0x'+hx(did,4)+' failed','error');
      setValues(v=>({...v,[did]:payload}));
    }

    // ECU Reset
    addLog('Sending ECU reset (11 01)...','info');
    await eng.current.uds(bcmTx,bcmRx,[0x11,0x01]);
    setPending({});setBusy('');addLog('Write complete + reset','info');
  },[bcmTx,bcmRx,unlocked,pending,values,addLog]);

  const applyProfile=useCallback((profName)=>{
    const profiles={
      'srt-full':{
        srt_performance_pages:1,srt_pages_timers:2,srt_pages_gauges:4,srt_pages_dyno:8,
        launch_control:1,track_mode:1,drag_mode:2,race_options_menu:1,
        g_force_meter:1,timer_0_60:2,timer_quarter_mile:4,timer_eighth_mile:8,reaction_time_display:1,
        shift_light:1,performance_data_recorder:1,
      },
      'demon':{
        vehicle_trim_level:15,engine_variant:6,widebody_enabled:1,
        power_chiller:1,after_run_chiller:5,trans_brake:1,torque_reserve:1,torque_reserve_level:4,
        srt_performance_pages:1,srt_pages_timers:2,srt_pages_gauges:4,srt_pages_dyno:8,
        launch_control:1,track_mode:1,drag_mode:2,race_options_menu:1,drag_mode_suspension:2,
        supercharger_display:1,intercooler_temp_display:2,oil_temp_display:4,trans_temp_display:8,
        g_force_meter:1,timer_0_60:2,timer_quarter_mile:4,timer_eighth_mile:8,
      },
      'hellcat':{
        vehicle_trim_level:9,engine_variant:4,
        srt_performance_pages:1,srt_pages_timers:2,srt_pages_gauges:4,
        launch_control:1,track_mode:1,torque_reserve:1,torque_reserve_level:3,
        shift_light:1,supercharger_display:1,oil_temp_display:4,
      },
      'track':{
        track_mode:1,launch_control:1,shift_light:1,race_options_menu:1,
        performance_data_recorder:1,srt_performance_pages:1,srt_pages_gauges:4,
        g_force_meter:1,brake_temp_warning:1,
      },
    };
    const prof=profiles[profName];if(!prof){addLog('Unknown profile','error');return;}
    const newPending={};
    for(const[fid,val]of Object.entries(prof)){
      const feat=JAILBREAK_FEATURES.find(f=>f.id===fid);
      if(feat)newPending[fid]={feat,value:val};
    }
    setPending(newPending);addLog('Profile "'+profName+'" staged — '+Object.keys(newPending).length+' changes. Click WRITE to apply.','info');
  },[addLog]);

  const getCurrentValue=(feat)=>{
    const raw=values[feat.did];if(!raw||feat.off>=raw.length)return null;
    const b=raw[feat.off];
    if(feat.mask!==undefined)return b&feat.mask;
    return b;
  };

  const cardBg='linear-gradient(135deg,#0F0F1A 0%,#1A1A2E 100%)';

  return<div>
    {/* HEADER */}
    <Card style={{background:'linear-gradient(135deg,#1A0A0A 0%,#3D1515 40%,#8B0000 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:6}}>
        <div style={{fontSize:32}}>💀</div>
        <div>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>JAILBREAK OPTIONS</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>SRT · DEMON · HELLCAT · REDEYE</div>
        </div>
        <div style={{marginLeft:'auto',fontSize:11,padding:'6px 12px',background:conn?'#00C85333':'#FF174433',borderRadius:8,border:'1px solid '+(conn?'#00C853':'#FF1744')}}>
          {conn?(unlocked?'● BCM UNLOCKED':'● CONNECTED'):'○ DISCONNECTED'}
        </div>
      </div>
      <div style={{fontSize:12,opacity:.8,marginTop:8}}>
        Configure 50 performance features on the BCM. Requires OBDLink EX + MFG extended mode.
      </div>
    </Card>

    {/* CONTROLS */}
    <Card style={{marginBottom:18}}>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
        {!conn&&<Btn onClick={connect} color={C.sr}>🔌 Connect OBDLink</Btn>}
        {conn&&<Btn onClick={findBCM} disabled={!!busy} color={C.a3}>{busy==='Finding BCM...'?'Searching...':'🎯 Find BCM'}</Btn>}
        {conn&&<Btn onClick={unlock} disabled={!!busy} color={C.a4}>🔓 Unlock BCM</Btn>}
        {unlocked&&<Btn onClick={readAll} disabled={!!busy} color={C.a2}>📖 Read All Features</Btn>}
        {unlocked&&Object.keys(pending).length>0&&<Btn onClick={writePending} disabled={!!busy} color={C.sr}>💾 Write {Object.keys(pending).length} Changes</Btn>}
      </div>
      <div style={{fontSize:11,color:C.ts,marginBottom:10}}>
        BCM Address: TX 0x{hx(bcmTx,3)} · RX 0x{hx(bcmRx,3)}
      </div>

      {/* PROFILES */}
      <div style={{padding:12,background:'#FFF8F0',borderRadius:10,border:'1px solid '+C.bd,marginBottom:10}}>
        <div style={{fontSize:11,fontWeight:800,color:C.sr,marginBottom:8,letterSpacing:1}}>🚀 QUICK PROFILES</div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          <Btn onClick={()=>applyProfile('srt-full')} outline color={C.sr}>SRT Full</Btn>
          <Btn onClick={()=>applyProfile('demon')} outline color={C.sr}>Demon Package</Btn>
          <Btn onClick={()=>applyProfile('hellcat')} outline color={C.sr}>Hellcat</Btn>
          <Btn onClick={()=>applyProfile('track')} outline color={C.sr}>Track Mode</Btn>
        </div>
      </div>

      <input placeholder="Search features..." value={search} onChange={e=>setSearch(e.target.value)} style={{width:'100%',padding:'10px 14px',fontSize:13,border:'1px solid '+C.bd,borderRadius:8,fontFamily:"'Nunito'"}}/>
    </Card>

    {/* FEATURES BY CATEGORY */}
    {filtered.map(([cat,feats])=>{
      const exp=expanded[cat]!==false;
      return<Card key={cat} style={{marginBottom:14,padding:0,overflow:'hidden'}}>
        <div onClick={()=>setExpanded(e=>({...e,[cat]:!exp}))} style={{cursor:'pointer',padding:'16px 20px',background:'linear-gradient(90deg,#1A0A0A,#2D1515)',color:'#fff',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div>
            <div style={{fontFamily:"'Righteous'",fontSize:16,letterSpacing:1}}>{cat}</div>
            <div style={{fontSize:10,opacity:.6,marginTop:2}}>{feats.length} features</div>
          </div>
          <div style={{fontSize:18}}>{exp?'▾':'▸'}</div>
        </div>
        {exp&&<div style={{padding:'14px 18px'}}>
          {feats.map(f=>{
            const cur=getCurrentValue(f);
            const p=pending[f.id];
            const displayVal=p?p.value:cur;
            return<div key={f.id} style={{padding:'12px 0',borderBottom:'1px solid '+C.bd}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6,gap:12,flexWrap:'wrap'}}>
                <div style={{flex:'1 1 280px'}}>
                  <div style={{fontWeight:800,fontSize:13,color:p?C.sr:C.tx}}>{f.n}{p&&' ⚡'}</div>
                  <div style={{fontSize:11,color:C.ts,marginTop:2}}>{f.d}</div>
                  {f.notes&&<div style={{fontSize:10,color:C.a1,marginTop:3,fontStyle:'italic'}}>ⓘ {f.notes}</div>}
                  <div style={{fontSize:9,color:C.tm,marginTop:3,fontFamily:"'JetBrains Mono'"}}>
                    DID 0x{hx(f.did,4)} · offset 0x{hx(f.off,2)}{f.mask!==undefined?' · mask 0x'+hx(f.mask,2):''}
                  </div>
                </div>
                <div style={{flex:'0 0 auto'}}>
                  <select value={displayVal??''} onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v))setFeature(f,v);}} style={{padding:'8px 12px',border:'1.5px solid '+(p?C.sr:C.bd),borderRadius:8,fontSize:12,minWidth:180,fontFamily:"'Nunito'",fontWeight:700,background:p?'#FFF0F0':'#FFF'}}>
                    <option value="">{cur===null?'(not read)':'Select...'}</option>
                    {f.opts.map(o=><option key={o.v} value={o.v}>{o.l} (0x{hx(o.v)})</option>)}
                  </select>
                </div>
              </div>
            </div>;
          })}
        </div>}
      </Card>;
    })}

    {/* LOG */}
    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{fontWeight:800,fontSize:12,color:'#FF5252',marginBottom:10,letterSpacing:2}}>📋 UDS LOG</div>
      <div style={{maxHeight:320,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Connect adapter to begin</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}


/* ═══ ACTIVE DAMPING MODULE (ADM/SDM/ADCM) VIN WRITER + CONFIG ═══
   Based on captured Alpha OBD 2.5.7.0 UDS flow:
   - 31 01 03 12 (Start routine 0x0312 — unlock config)
   - 2E F1 90 [VIN] (Write primary VIN)
   - 2E 7B 90 [VIN] (Write secondary/current VIN)
   - 19 02 08 (Read DTCs)
   - 14 FF FF FF (Clear DTCs)
   - 11 01 (ECU reset)
   Security: SBEC2/SBEC3 (key = seed*4 + 0x9018) */

const ADCM_MODULES=[
  {id:'ADM',  tx:0x744, rx:0x764, n:'Active Dampening Module',   veh:'Challenger/Charger/Trackhawk SRT'},
  {id:'SDM',  tx:0x745, rx:0x765, n:'Suspension Dampening Module', veh:'Durango SRT, Ram 1500 Air Susp'},
  {id:'ADCM', tx:0x7A8, rx:0x7B0, n:'Active Damping Control Module', veh:'Generic / Alpha OBD detected'},
];

const ADCM_VARIANTS=[
  {id:'challenger_srt',     n:'Dodge Challenger SRT',       code:0x01, notes:'5.7L/6.4L HEMI'},
  {id:'challenger_hellcat', n:'Dodge Challenger Hellcat',   code:0x02, notes:'6.2L Supercharged'},
  {id:'challenger_redeye',  n:'Dodge Challenger Redeye',    code:0x03, notes:'6.2L SC 797hp'},
  {id:'challenger_demon',   n:'Dodge Challenger Demon',     code:0x04, notes:'6.2L SC 840hp drag'},
  {id:'challenger_demon170',n:'Dodge Challenger Demon 170', code:0x05, notes:'6.2L SC 1025hp E85'},
  {id:'charger_srt',        n:'Dodge Charger SRT',          code:0x06, notes:'5.7L/6.4L HEMI sedan'},
  {id:'charger_hellcat',    n:'Dodge Charger Hellcat',      code:0x07, notes:'6.2L Supercharged sedan'},
  {id:'charger_redeye',     n:'Dodge Charger Redeye',       code:0x08, notes:'6.2L SC Redeye sedan'},
  {id:'trackhawk',          n:'Jeep Grand Cherokee Trackhawk', code:0x09, notes:'6.2L SC SUV'},
  {id:'gc_srt',             n:'Jeep Grand Cherokee SRT',    code:0x0A, notes:'6.4L HEMI SUV'},
  {id:'durango_srt',        n:'Dodge Durango SRT',          code:0x0B, notes:'6.4L HEMI 3-row'},
  {id:'durango_hellcat',    n:'Dodge Durango Hellcat',      code:0x0C, notes:'6.2L SC 3-row'},
  {id:'ram_limited',        n:'Ram 1500 Limited Air Susp',  code:0x0D, notes:'Air suspension'},
  {id:'gc_l',               n:'Jeep Grand Cherokee L',      code:0x0E, notes:'Air suspension 3-row'},
];

function AdcmTab(){
  const{vin:masterVin,setModuleStatus}=React.useContext(MasterVinContext);
  const[conn,setConn]=useState(false);const[busy,setBusy]=useState('');
  const[log,setLog]=useState([]);const[mod,setMod]=useState(ADCM_MODULES[2]);
  const[vin,setVin]=useState('');const[curVinF190,setCurVinF190]=useState('');const[curVin7B90,setCurVin7B90]=useState('');
  const[variant,setVariant]=useState(ADCM_VARIANTS[0].id);const[unlocked,setUnlocked]=useState(false);
  const[dtcs,setDtcs]=useState([]);
  const[showConfirmModal,setShowConfirmModal]=useState(false);
  const eng=useRef(null);const[adapter,setAdapter]=useState('');
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-300),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');
  /* Sync Master VIN into local VIN when masterVin changes */
  React.useEffect(()=>{if(masterVin&&masterVin.length===17)setVin(masterVin);},[masterVin]);
  /* Report status back to MasterVinContext */
  React.useEffect(()=>{
    if(curVinF190&&masterVin){
      const match=curVinF190===masterVin;
      if(match)setModuleStatus(p=>({...p,ADCM:'ok'}));
    }
  },[curVinF190,masterVin,setModuleStatus]);

  /* SBEC algorithm for ADM/SDM (per ACTIVE_DAMPENING_MODULES.md) */
  const sbecKey=(seed)=>u32((seed*4+0x9018));

  const connect=useCallback(async()=>{
    if(!navigator.serial){addLog('Web Serial not supported — use Chrome/Edge','error');return;}
    try{
      const port=await navigator.serial.requestPort();await port.open({baudRate:115200});
      const w=port.writable.getWriter();const rd=port.readable.getReader();const tdec=new TextDecoder();
      let rbuf='';
      const send=async(cmd,to=3000)=>{rbuf='';await w.write(new TextEncoder().encode(cmd+'\r'));addLog('TX > '+cmd,'tx');
        const deadline=Date.now()+to;
        while(Date.now()<deadline){
          try{const rp=rd.read();const tp=new Promise(r=>setTimeout(()=>r({value:undefined,done:true}),Math.min(500,deadline-Date.now())));
            const res=await Promise.race([rp,tp]);
            if(res.done||!res.value){if(Date.now()>=deadline)break;continue;}
            rbuf+=tdec.decode(res.value);const pi=rbuf.indexOf('>');
            if(pi!==-1){const r=rbuf.substring(0,pi).replace(/\r/g,'\n').replace(/\n+/g,'\n').trim();rbuf=rbuf.substring(pi+1);addLog('RX < '+r,'rx');return r;}
          }catch(e){break;}
        }
        const t=rbuf.replace(/\r/g,'\n').replace(/\n+/g,'\n').replace(/>/g,'').trim();if(t)addLog('RX (to) < '+t,'warn');return t;
      };
      /* LESSON FROM LIVE TEST 11/3/2025:
         - ATCAF1 (auto ISO-TP) is the RIGHT choice — let adapter handle framing
         - ATCAF0 manual mode causes Init Failed cascades on OBDLink
         - Module DOES respond with Flow Control (30 08 14...) proving comms work
         - Add small delays between init commands to prevent overrun */
      await send('ATZ',3000);await new Promise(r=>setTimeout(r,1200));
      await send('ATE0');await new Promise(r=>setTimeout(r,150));
      const ati=await send('ATI');setAdapter(ati);
      await new Promise(r=>setTimeout(r,150));
      const stdi=await send('STDI');const isSTN=!stdi.includes('?')&&stdi.length>2;
      addLog('Adapter: '+(isSTN?'STN/OBDLink':'ELM327')+' ('+ati+')','info');
      if(isSTN){
        addLog('Applying MFG extended mode (required for body module access)...','info');
        await send('ATPP2CSV81',2000);await new Promise(r=>setTimeout(r,200));
        await send('ATPP2CON',2000);await new Promise(r=>setTimeout(r,200));
        await send('ATPP2DSV01',2000);await new Promise(r=>setTimeout(r,200));
        await send('ATPP2DON',2000);await new Promise(r=>setTimeout(r,200));
        await send('ATZ',3000);await new Promise(r=>setTimeout(r,1500));
        await send('ATE0',2000);await new Promise(r=>setTimeout(r,200));
      }
      await send('ATL0');await new Promise(r=>setTimeout(r,80));
      await send('ATS1');await new Promise(r=>setTimeout(r,80));
      await send('ATH1');await new Promise(r=>setTimeout(r,80));
      await send('ATSP6');await new Promise(r=>setTimeout(r,80));
      await send('ATAT2');await new Promise(r=>setTimeout(r,80));
      /* STPTO3000 — STN 3-second programmable timeout for slow body modules */
      if(isSTN){await send('STPTO3000',1500);addLog('STN timeout set to 3000ms','info');await new Promise(r=>setTimeout(r,100));}
      await send('ATST96');await new Promise(r=>setTimeout(r,80));
      /* ALWAYS use ATCAF1 — auto ISO-TP framing. Live test proved ATCAF0 fails. */
      await send('ATCAF1');addLog('ATCAF1 — auto ISO-TP framing (multi-frame handled by adapter)','info');
      await new Promise(r=>setTimeout(r,80));
      if(isSTN){
        await send('ATFCSH7E0');await new Promise(r=>setTimeout(r,80));
        await send('ATFCSD300000');await new Promise(r=>setTimeout(r,80));
        await send('ATFCSM1');await new Promise(r=>setTimeout(r,80));
      }
      let curTx=0,curRx=0;
      eng.current={send,isSTN,uds:async(tx,rx,data,timeout)=>{
        /* Switch headers if target module changed */
        if(tx!==curTx||rx!==curRx){
          await send('ATCRA');await new Promise(r=>setTimeout(r,50));
          await send('ATSH'+hx(tx,3));await new Promise(r=>setTimeout(r,50));
          if(isSTN){await send('ATFCSH'+hx(tx,3));await new Promise(r=>setTimeout(r,50));}
          await send('ATCRA'+hx(rx,3));await new Promise(r=>setTimeout(r,50));
          curTx=tx;curRx=rx;
        }
        /* Multi-frame writes (>7 payload bytes) need longer timeout for flow control handshake */
        const tm=timeout||(data.length>7?8000:4000);
        const h=Array.from(data).map(b=>hx(b)).join(' ');
        const r=await send(h,tm);
        if(!r||/NO DATA|CAN ERROR|UNABLE|BUS/.test(r))return{ok:false,raw:r||''};
        if(r.includes('?')||r.includes('ERROR'))return{ok:false,raw:r};
        const lines=r.split(/[\r\n]+/).map(l=>l.trim()).filter(Boolean);
        let all=[];
        for(const line of lines){
          if(line.includes('SEARCHING')||line==='OK')continue;
          const toks=line.split(/\s+/);
          if(toks.length<2)continue;
          if(/^[0-9A-F]{3}$/.test(toks[0].toUpperCase())){
            for(let i=1;i<toks.length;i++)if(/^[0-9A-Fa-f]{2}$/.test(toks[i]))all.push(parseInt(toks[i],16));
          }else{for(const t of toks)if(/^[0-9A-Fa-f]{2}$/.test(t))all.push(parseInt(t,16));}
        }
        if(!all.length)return{ok:false,raw:r};
        return{ok:true,d:new Uint8Array(all),raw:r};
      }};
      setConn(true);addLog('Connected','info');
    }catch(e){addLog('Connect failed: '+e.message,'error');}
  },[addLog]);

  const disconnect=useCallback(()=>{
    setConn(false);setUnlocked(false);eng.current=null;addLog('Disconnected','info');
  },[addLog]);

  /* Read VIN from a specific DID */
  const readVin=useCallback(async(did,label)=>{
    if(!eng.current)return null;
    const r=await eng.current.uds(mod.tx,mod.rx,[0x22,(did>>8)&0xFF,did&0xFF]);
    if(r.ok&&r.d&&r.d.length>=3){
      const data=Array.from(r.d);
      /* Positive: 62 DID_HI DID_LO [17 bytes] */
      const pl=data.slice(3);
      const ascii=pl.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
      if(ascii.length>=10){addLog(label+' = '+ascii,'rx');return ascii.slice(-17);}
    }
    addLog(label+' (DID 0x'+hx(did,4)+'): no response','warn');return null;
  },[mod,addLog]);

  const readBothVins=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading VINs...');
    addLog('Entering extended session (10 03)...','info');
    await eng.current.uds(mod.tx,mod.rx,[0x10,0x03]);
    addLog('─── Reading VINs from '+mod.id+' ───','info');
    const v1=await readVin(0xF190,'DID 0xF190 (Primary VIN)');
    const v2=await readVin(0x7B90,'DID 0x7B90 (Current VIN)');
    setCurVinF190(v1||'');setCurVin7B90(v2||'');
    setBusy('');
  },[mod,readVin,addLog]);

  /* Alpha OBD flow: start routine 0x0312 = unlock config mode */
  const startRoutine=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Starting routine 0x0312...');
    addLog('─── Alpha OBD Init Sequence ───','info');
    addLog('Extended session (10 03)...','info');
    await eng.current.uds(mod.tx,mod.rx,[0x10,0x03]);
    addLog('TesterPresent (3E 80)...','info');
    await eng.current.uds(mod.tx,mod.rx,[0x3E,0x80]);
    addLog('Start Routine 0x0312 (31 01 03 12)...','info');
    const r=await eng.current.uds(mod.tx,mod.rx,[0x31,0x01,0x03,0x12]);
    if(r.ok&&r.d&&r.d[0]===0x71){
      addLog('✓ Routine 0x0312 accepted — '+mod.id+' config unlocked','rx');
      setUnlocked(true);
    }else{
      addLog('Routine 0x0312 rejected — trying security unlock fallback','warn');
      /* Fallback: SBEC seed-key unlock */
      const s=await eng.current.uds(mod.tx,mod.rx,[0x27,0x01]);
      if(s.ok&&s.d&&s.d.length>=4){
        const sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
        addLog('Seed: 0x'+hx(sv,8),'info');
        const k=sbecKey(sv);addLog('SBEC Key: 0x'+hx(k,8)+' [(seed*4)+0x9018]','info');
        const kr=await eng.current.uds(mod.tx,mod.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
        if(kr.ok){addLog('✓ SBEC unlock succeeded','rx');setUnlocked(true);}
        else{addLog('Both routine and SBEC failed — check CAN address','error');}
      }
    }
    setBusy('');
  },[mod,addLog]);

  /* Test Connection — quick sanity check before any writes
     Runs TesterPresent + reads VIN to verify module is responsive
     If this fails, stop before attempting writes */
  const testConnection=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Testing connection...');
    addLog('═══ CONNECTION TEST ═══','info');
    addLog('1. TesterPresent (3E 00)...','info');
    const tp=await eng.current.uds(mod.tx,mod.rx,[0x3E,0x00]);
    if(tp.ok&&tp.d&&tp.d[0]===0x7E){addLog('✓ Module is alive','rx');}
    else{addLog('✗ TesterPresent failed — module not responding on 0x'+hx(mod.tx,3),'error');setBusy('');return;}
    addLog('2. Read VIN 0xF190 (22 F1 90)...','info');
    const v1=await eng.current.uds(mod.tx,mod.rx,[0x22,0xF1,0x90]);
    if(v1.ok&&v1.d&&v1.d[0]===0x62){
      const vinStr=Array.from(v1.d).slice(3).filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
      addLog('✓ VIN readable: '+vinStr.slice(-17),'rx');setCurVinF190(vinStr.slice(-17));
    }else{addLog('✗ VIN read failed — DID 0xF190 not supported or session needed','warn');}
    addLog('3. Extended session (10 03)...','info');
    const ds=await eng.current.uds(mod.tx,mod.rx,[0x10,0x03]);
    if(ds.ok&&ds.d&&ds.d[0]===0x50){addLog('✓ Extended session OK — ready for write operations','rx');}
    else{addLog('✗ Session failed — module may not support extended mode','warn');}
    addLog('═══ TEST COMPLETE ═══','info');
    addLog('If all 3 checks passed, you can safely run Start Routine + Write VIN','info');
    setBusy('');
  },[mod,addLog]);
  /* UDS Negative Response Code decoder — helps debug write failures */
  const decodeNRC=(code)=>{
    const nrc={0x10:'General reject',0x11:'Service not supported',0x12:'Subfunction not supported',
      0x13:'Incorrect length',0x22:'Conditions not correct',0x24:'Sequence error',
      0x31:'Request out of range (DID not supported?)',0x33:'Security access denied (unlock expired?)',
      0x35:'Invalid key',0x36:'Exceeded number of attempts',0x37:'Required time delay not expired',
      0x78:'Response pending (wait)',0x7E:'Subfunction not supported in session',0x7F:'Service not supported in session'};
    return nrc[code]||('NRC 0x'+code.toString(16).toUpperCase());
  };

  /* Refresh unlock if session timed out — keep the module alive during multi-step writes */
  const refreshUnlock=useCallback(async()=>{
    addLog('Refreshing session (3E 00 + 31 01 03 12)...','info');
    await eng.current.uds(mod.tx,mod.rx,[0x3E,0x00]);
    const r=await eng.current.uds(mod.tx,mod.rx,[0x31,0x01,0x03,0x12]);
    if(r.ok&&r.d&&r.d[0]===0x71){addLog('✓ Session refreshed','rx');return true;}
    addLog('Session refresh failed','warn');return false;
  },[mod,addLog]);

  /* Write VIN to a specific DID with NRC decoding and auto-retry on session expiry */
  const writeVinToDid=useCallback(async(did,label)=>{
    if(!vin||vin.length!==17){addLog('Enter valid 17-char VIN first','error');return false;}
    const vb=Array.from(vin.toUpperCase()).map(c=>c.charCodeAt(0));
    addLog('Writing '+label+' (2E '+hx((did>>8)&0xFF)+' '+hx(did&0xFF)+' + 17 VIN bytes)...','info');
    let r=await eng.current.uds(mod.tx,mod.rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);
    /* Check for negative response */
    if(r.ok&&r.d&&r.d[0]===0x7F){
      const nrc=r.d.length>2?r.d[2]:0;
      addLog('✗ '+label+' NRC: '+decodeNRC(nrc),'error');
      /* Auto-retry on security expiry (0x33) — refresh session and try once more */
      if(nrc===0x33){
        addLog('Attempting auto-recovery — refreshing unlock...','warn');
        if(await refreshUnlock()){
          await new Promise(r=>setTimeout(r,300));
          addLog('Retry '+label+'...','info');
          r=await eng.current.uds(mod.tx,mod.rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);
        }
      }
    }
    if(r.ok&&r.d&&r.d[0]===0x6E){
      addLog('✓ '+label+' written OK','rx');return true;
    }else if(r.ok&&r.d&&r.d[0]===0x7F){
      /* Still negative after retry */
      return false;
    }else{
      addLog('✗ '+label+' write failed: '+(r.raw||'no response')+' — check connection','error');return false;
    }
  },[vin,mod,addLog,refreshUnlock]);

  /* Write BOTH VINs — opens Read-First modal first */
  const writeBothVins=useCallback(()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(!vin||vin.length!==17){addLog('Enter valid 17-char VIN','error');return;}
    if(!unlocked){addLog('Run Start Routine 0x0312 first to unlock','error');return;}
    setShowConfirmModal(true);
  },[vin,unlocked,addLog]);

  const executeWriteBothVins=useCallback(async(confirmData)=>{
    setShowConfirmModal(false);
    const oldVinF190=curVinF190;
    const oldVin7B90=curVin7B90;
    setBusy('Writing both VINs...');
    addLog('═══ WRITING BOTH VINs TO '+mod.id+' ═══','info');
    if(confirmData.technician)addLog('Technician: '+confirmData.technician,'info');
    if(confirmData.titleRef)addLog('Title reference: '+confirmData.titleRef,'info');
    /* SAFETY NET: auto-backup module before any write */
    addLog('Creating safety backup before write...','info');
    await backupModule(eng.current.uds,mod.tx,mod.rx,'ADCM',addLog,hx);
    addLog('Target VIN: '+vin.toUpperCase(),'info');
    const okF190=await writeVinToDid(0xF190,'DID 0xF190 (Primary)');
    await new Promise(r=>setTimeout(r,200));
    const ok7B90=await writeVinToDid(0x7B90,'DID 0x7B90 (Current)');
    await new Promise(r=>setTimeout(r,200));
    /* Bonus: try 0x7B88 (Original VIN) too */
    const ok7B88=await writeVinToDid(0x7B88,'DID 0x7B88 (Original)');
    addLog('─── Verifying ───','info');
    const v1=await readVin(0xF190,'Verify 0xF190');
    const v2=await readVin(0x7B90,'Verify 0x7B90');
    setCurVinF190(v1||'');setCurVin7B90(v2||'');
    const match1=v1===vin.toUpperCase();const match2=v2===vin.toUpperCase();
    const allOk=match1&&match2;
    addLog(match1?'✓ 0xF190 MATCH':'✗ 0xF190 mismatch',match1?'rx':'warn');
    addLog(match2?'✓ 0x7B90 MATCH':'✗ 0x7B90 mismatch',match2?'rx':'warn');
    /* PAPER TRAIL */
    logSession({
      module:'ADCM',
      operation:'VIN Write (dual DID)',
      oldVin:oldVinF190||oldVin7B90,
      newVin:vin.toUpperCase(),
      moduleAddr:{tx:mod.tx,rx:mod.rx},
      adapter:eng.current.adapter||'ELM327/STN',
      success:allOk,
      technician:confirmData.technician,
      titleRef:confirmData.titleRef,
      titleNotes:confirmData.titleNotes,
      preWriteConfirmed:confirmData.preWriteConfirmed,
      dids:[
        {did:'0xF190',value:v1,match:match1},
        {did:'0x7B90',value:v2,match:match2},
      ],
    });
    addLog('📄 Session logged to paper trail','info');
    setBusy('');
  },[vin,mod,writeVinToDid,readVin,addLog,curVinF190,curVin7B90]);

  /* Configure vehicle model/variant */
  const writeVariant=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(!unlocked){addLog('Run Start Routine 0x0312 first','error');return;}
    const v=ADCM_VARIANTS.find(x=>x.id===variant);if(!v)return;
    setBusy('Writing vehicle variant...');
    addLog('─── Configuring '+mod.id+' for '+v.n+' ───','info');
    /* Write variant code to configuration DID 0xF1A1 (Suspension Mode) and 0xDE10 (Vehicle Config) */
    const cfgDids=[
      {did:0xF1A1, label:'Suspension Mode',    val:[v.code]},
      {did:0xDE10, label:'Vehicle Config',      val:[v.code]},
      {did:0xDE11, label:'Variant Code',        val:[v.code,0x00]},
    ];
    for(const c of cfgDids){
      addLog('Writing '+c.label+' (DID 0x'+hx(c.did,4)+')='+c.val.map(b=>'0x'+hx(b)).join(' ')+'...','info');
      const r=await eng.current.uds(mod.tx,mod.rx,[0x2E,(c.did>>8)&0xFF,c.did&0xFF,...c.val]);
      if(r.ok&&r.d&&r.d[0]===0x6E)addLog('✓ '+c.label+' written','rx');
      else addLog('  '+c.label+' not supported / rejected','warn');
      await new Promise(r=>setTimeout(r,150));
    }
    addLog('Variant configuration complete for '+v.n,'info');
    setBusy('');
  },[variant,mod,unlocked,addLog]);

  /* Read DTCs — exact Alpha OBD flow: 19 02 08 */
  const readDtcs=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading DTCs...');
    addLog('ReadDTCInformation (19 02 08)...','info');
    const r=await eng.current.uds(mod.tx,mod.rx,[0x19,0x02,0x08]);
    if(r.ok&&r.d){
      const d=Array.from(r.d);
      const list=[];
      /* Response: 59 02 [mask] [DTC1_hi DTC1_mid DTC1_lo status] × N */
      for(let i=3;i+3<d.length;i+=4){
        const dtc=(d[i]<<16)|(d[i+1]<<8)|d[i+2];const st=d[i+3];
        if(dtc===0)continue;
        const prefix=(d[i]>>6)===0?'P':(d[i]>>6)===1?'C':(d[i]>>6)===2?'B':'U';
        const code=prefix+hx((d[i]&0x3F),1)+hx(d[i+1])+hx(d[i+2]);
        list.push({code,status:st,statusText:decodeDtcStatus(st)});
        addLog('DTC: '+code+' status=0x'+hx(st)+' ['+decodeDtcStatus(st)+']','warn');
      }
      setDtcs(list);
      if(!list.length)addLog('✓ No DTCs stored','rx');
    }
    setBusy('');
  },[mod,addLog]);

  /* Clear DTCs — exact Alpha OBD flow: 14 FF FF FF */
  const clearDtcs=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Clearing DTCs...');
    addLog('ClearDiagnosticInformation (14 FF FF FF)...','info');
    const r=await eng.current.uds(mod.tx,mod.rx,[0x14,0xFF,0xFF,0xFF]);
    if(r.ok&&r.d&&r.d[0]===0x54){
      addLog('✓ DTCs cleared','rx');setDtcs([]);
    }else{
      addLog('Clear failed: '+(r.raw||'no response'),'error');
    }
    setBusy('');
  },[mod,addLog]);

  /* ECU Reset — 11 01 */
  const ecuReset=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Resetting ECU...');
    addLog('ECUReset hard (11 01)...','info');
    const r=await eng.current.uds(mod.tx,mod.rx,[0x11,0x01]);
    if(r.ok&&r.d&&r.d[0]===0x51){addLog('✓ ECU reset accepted','rx');}
    else addLog('Reset: '+(r.raw||'no response'),'warn');
    setUnlocked(false);setBusy('');
  },[mod,addLog]);

  /* FULL SEQUENCE — one-click Alpha OBD replay */
  const runFullSequence=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(!vin||vin.length!==17){addLog('Enter valid 17-char VIN','error');return;}
    setBusy('Running full Alpha OBD sequence...');
    addLog('╔════════════════════════════════════╗','info');
    addLog('║  FULL ADCM PROGRAMMING SEQUENCE    ║','info');
    addLog('╚════════════════════════════════════╝','info');
    /* 1. Routine unlock */
    await startRoutine();await new Promise(r=>setTimeout(r,300));
    /* 2. Write both VINs */
    await writeBothVins();await new Promise(r=>setTimeout(r,300));
    /* 3. Write variant config */
    await writeVariant();await new Promise(r=>setTimeout(r,300));
    /* 4. Read DTCs */
    await readDtcs();await new Promise(r=>setTimeout(r,300));
    /* 5. Clear DTCs */
    await clearDtcs();await new Promise(r=>setTimeout(r,300));
    /* 6. Reset */
    await ecuReset();
    addLog('═══ SEQUENCE COMPLETE ═══','info');
    setBusy('');
  },[vin,startRoutine,writeBothVins,writeVariant,readDtcs,clearDtcs,ecuReset,addLog]);

  /* VIN validation — catches I/O/Q and reports exact position of bad char */
  const vinValid=vin.length===17&&/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin);
  const vinIssue=useMemo(()=>{
    if(vin.length===0)return 'Enter 17-character VIN';
    if(vin.length<17)return 'Only '+vin.length+'/17 characters — VIN must be exactly 17';
    if(vin.length>17)return 'Too long — '+vin.length+' chars, max is 17';
    /* Check each char */
    const bad=['I','O','Q'];
    for(let i=0;i<vin.length;i++){
      const c=vin[i].toUpperCase();
      if(bad.includes(c))return 'Invalid char "'+c+'" at position '+(i+1)+' (I/O/Q not allowed in VINs)';
      if(!/[A-Z0-9]/.test(c))return 'Invalid char "'+vin[i]+'" at position '+(i+1);
    }
    /* Optional: check digit validation (position 9) */
    return '✓ Valid VIN format';
  },[vin]);

  return<div>
    {showConfirmModal&&<ReadFirstModal
      module="ADCM"
      currentState={[
        {label:'Current VIN (DID 0xF190)',value:curVinF190},
        {label:'Current VIN (DID 0x7B90)',value:curVin7B90},
        {label:'Module',value:mod.id+' at TX 0x'+hx(mod.tx,3)+' / RX 0x'+hx(mod.rx,3)},
        {label:'Security',value:unlocked?'Unlocked (Routine 0x0312)':'Not unlocked'},
      ]}
      newVin={vin.toUpperCase()}
      onConfirm={executeWriteBothVins}
      onCancel={()=>{setShowConfirmModal(false);addLog('Write cancelled at confirmation step','warn');}}
    />}
    {/* HEADER */}
    <Card style={{background:'linear-gradient(135deg,#0A1A3D 0%,#1E3A6F 40%,#0066CC 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:6}}>
        <div style={{fontSize:32}}>🏎️</div>
        <div>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>ACTIVE DAMPING</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>ADM · SDM · ADCM · VIN + VARIANT</div>
        </div>
        <div style={{marginLeft:'auto',fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
          {!conn?'○ DISCONNECTED':unlocked?'● UNLOCKED':'● CONNECTED'}
        </div>
      </div>
      <div style={{fontSize:12,opacity:.85,marginTop:8}}>
        Dedicated Active Damping programming — writes VIN to F190 + 7B90 + 7B88 and configures vehicle variant. Matches Alpha OBD 2.5.7.0 sequence.
      </div>
    </Card>

    {/* MODULE + VARIANT SELECTORS */}
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
      <Card>
        <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>📡 MODULE</div>
        {ADCM_MODULES.map(m=>{
          const a=mod.id===m.id;
          return<div key={m.id} onClick={()=>setMod(m)} style={{padding:'10px 12px',marginBottom:6,borderRadius:8,cursor:'pointer',border:'2px solid '+(a?C.a3:C.bd),background:a?C.a3+'10':'#fff',transition:'all 0.2s'}}>
            <div style={{fontWeight:800,fontSize:13,color:a?C.a3:C.tx}}>{m.id} <span style={{fontSize:10,fontWeight:600,color:C.ts}}>TX:0x{hx(m.tx,3)} · RX:0x{hx(m.rx,3)}</span></div>
            <div style={{fontSize:11,color:C.ts,marginTop:2}}>{m.n}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:2,fontStyle:'italic'}}>{m.veh}</div>
          </div>;
        })}
      </Card>
      <Card>
        <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>🚗 VEHICLE VARIANT</div>
        <select value={variant} onChange={e=>setVariant(e.target.value)} style={{width:'100%',padding:'10px 12px',border:'1.5px solid '+C.bd,borderRadius:8,fontSize:13,fontFamily:"'Nunito'",fontWeight:700,marginBottom:10}}>
          {ADCM_VARIANTS.map(v=><option key={v.id} value={v.id}>{v.n}</option>)}
        </select>
        {(()=>{const v=ADCM_VARIANTS.find(x=>x.id===variant);return v&&<div style={{padding:10,background:'#F8F6F2',borderRadius:8,fontSize:11}}>
          <div style={{color:C.ts}}><b>Code:</b> 0x{hx(v.code)}</div>
          <div style={{color:C.ts,marginTop:3}}><b>Notes:</b> {v.notes}</div>
          <div style={{color:C.a1,marginTop:6,fontSize:10,fontStyle:'italic'}}>Writes to DID 0xF1A1, 0xDE10, 0xDE11</div>
        </div>;})()}
      </Card>
    </div>

    {/* CONNECTION */}
    <Card style={{marginBottom:14}}>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
        {!conn&&<Btn onClick={connect} color={C.a3}>🔌 Connect Adapter</Btn>}
        {conn&&<Btn onClick={disconnect} outline color={C.ts}>Disconnect</Btn>}
        {conn&&<Btn onClick={testConnection} disabled={!!busy} color={C.gn}>🧪 Test Connection</Btn>}
        {conn&&<Btn onClick={readBothVins} disabled={!!busy} color={C.a2}>📖 Read Both VINs</Btn>}
        {conn&&<Btn onClick={startRoutine} disabled={!!busy} color={C.a4}>🔓 Start Routine 0x0312</Btn>}
        <div style={{marginLeft:'auto',fontSize:10,color:C.ts,padding:'4px 10px',background:'#F0F8FF',borderRadius:6,border:'1px solid #B0D4F0'}}>
          ATCAF1 auto ISO-TP · validated on bench 11/3
        </div>
      </div>
      {adapter&&<div style={{marginTop:8,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>Adapter: {adapter} · Target: {mod.id} @ TX 0x{hx(mod.tx,3)} / RX 0x{hx(mod.rx,3)}</div>}
    </Card>

    {/* VIN PANEL */}
    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:12,letterSpacing:2}}>🔑 VIN PROGRAMMING</div>
      
      {/* Current values */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,letterSpacing:1,fontWeight:700}}>DID 0xF190 (Primary)</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,marginTop:4,color:curVinF190?C.tx:C.tm}}>{curVinF190||'(not read)'}</div>
        </div>
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,letterSpacing:1,fontWeight:700}}>DID 0x7B90 (Current)</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,marginTop:4,color:curVin7B90?C.tx:C.tm}}>{curVin7B90||'(not read)'}</div>
        </div>
      </div>

      {/* VIN input */}
      <div style={{marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
          <div style={{fontSize:11,color:C.ts,fontWeight:700}}>NEW VIN (17 characters)</div>
          <div style={{fontSize:11,color:vin.length===17?C.gn:C.ts,fontFamily:"'JetBrains Mono'",fontWeight:700}}>{vin.length}/17</div>
        </div>
        <input value={vin} onChange={e=>setVin(e.target.value.toUpperCase().replace(/\s/g,'').slice(0,17))} maxLength={17} placeholder="2C3CDZFJ5NH123456" style={{width:'100%',padding:'12px 16px',border:'2px solid '+(vin.length===0?C.bd:vinValid?C.gn:C.er),borderRadius:10,fontSize:16,fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:2}}/>
        {/* Position ruler — shows each char slot with current value */}
        <div style={{display:'flex',gap:2,marginTop:6,fontFamily:"'JetBrains Mono'",fontSize:9}}>
          {Array.from({length:17}).map((_,i)=>{
            const c=vin[i]||'';const bad=c&&['I','O','Q'].includes(c.toUpperCase());
            return<div key={i} style={{flex:1,textAlign:'center',padding:'2px 0',borderRadius:3,background:bad?C.er+'22':c?C.gn+'22':'#F0F0F0',border:'1px solid '+(bad?C.er:c?C.gn:C.bd),color:bad?C.er:c?C.gn:C.tm,fontWeight:700}}>
              <div style={{fontSize:7}}>{i+1}</div>
              <div style={{fontSize:11}}>{c||'·'}</div>
            </div>;
          })}
        </div>
        <div style={{fontSize:10,color:vin.length===0?C.tm:vinValid?C.gn:C.er,marginTop:6}}>
          {vinValid?'✓ Valid VIN format':vinIssue}
        </div>
      </div>

      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <Btn onClick={writeBothVins} disabled={!!busy||!vinValid||!unlocked} color={C.sr}>💾 Write Both VINs (F190 + 7B90 + 7B88)</Btn>
        <Btn onClick={writeVariant} disabled={!!busy||!unlocked} color={C.a4}>🚗 Write Variant Config</Btn>
      </div>
    </Card>

    {/* DTCs */}
    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:12,letterSpacing:2}}>⚠️ DIAGNOSTIC TROUBLE CODES</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
        <Btn onClick={readDtcs} disabled={!!busy||!conn} color={C.a3} outline>📋 Read DTCs (19 02 08)</Btn>
        <Btn onClick={clearDtcs} disabled={!!busy||!conn} color={C.wn} outline>🗑️ Clear DTCs (14 FF FF FF)</Btn>
        <Btn onClick={ecuReset} disabled={!!busy||!conn} color={C.er} outline>⚡ ECU Reset (11 01)</Btn>
      </div>
      {dtcs.length>0?<div style={{padding:10,background:'#FFF8F0',border:'1px solid '+C.wn+'44',borderRadius:8}}>
        {dtcs.map((d,i)=><div key={i} style={{fontSize:12,padding:'3px 0',fontFamily:"'JetBrains Mono'"}}>⚠ {d.code} — status 0x{hx(d.status)}</div>)}
      </div>:<div style={{fontSize:11,color:C.tm,fontStyle:'italic'}}>No DTCs read yet</div>}
    </Card>

    {/* ONE-CLICK FULL SEQUENCE */}
    <Card style={{marginBottom:14,background:'linear-gradient(135deg,#FFF8F0 0%,#FFE5CC 100%)',border:'2px solid '+C.a1}}>
      <div style={{fontWeight:800,fontSize:13,color:C.a1,marginBottom:8,letterSpacing:1}}>🚀 ONE-CLICK FULL ALPHA OBD SEQUENCE</div>
      <div style={{fontSize:11,color:C.ts,marginBottom:12}}>
        Runs the complete captured Alpha OBD flow: Routine 0x0312 → Write both VINs → Write variant → Read DTCs → Clear DTCs → Reset
      </div>
      <Btn onClick={runFullSequence} disabled={!!busy||!vinValid||!conn} color={C.a1} full>
        {busy||'▶️ RUN FULL PROGRAMMING SEQUENCE'}
      </Btn>
    </Card>

    {/* LOG */}
    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:12,color:'#4FC3F7',letterSpacing:2}}>📋 UDS LOG</div>
        <button onClick={()=>setLog([])} style={{fontSize:10,color:'#666',background:'transparent',border:'1px solid #333',padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>CLEAR</button>
      </div>
      <div style={{maxHeight:380,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Connect adapter to begin</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}


/* ═════════════════════════════════════════════════════════════════
   SHARED UDS HELPERS — used by BCM/RFHUB/ECM/ADCM/UDS tabs
   ═════════════════════════════════════════════════════════════════ */

/* CRC-16/CCITT-FALSE — BCM checksum (poly 0x1021, init 0xFFFF, big-endian)
   From production_vin_patcher.py — verified on 6 BCM variants */
function crc16ccitt(data){
  let crc=0xFFFF;
  for(const b of data){
    crc^=(b<<8);
    for(let i=0;i<8;i++){
      if(crc&0x8000)crc=((crc<<1)^0x1021)&0xFFFF;
      else crc=(crc<<1)&0xFFFF;
    }
  }
  return crc;
}

/* CRC-16 generic — RFHUB (VIN-specific poly/init) */
function crc16generic(data,poly,init){
  let crc=init;
  for(const b of data){
    crc^=(b<<8);
    for(let i=0;i<8;i++){
      if(crc&0x8000)crc=((crc<<1)^poly)&0xFFFF;
      else crc=(crc<<1)&0xFFFF;
    }
  }
  return crc;
}

/* RFHUB known algorithms — VIN-specific CRC polynomials from production data */
const RFHUB_KNOWN_ALGOS={
  '2C3CDXKT3FH796320':{poly:0x589B,init:0xFFFF},
  '2B3CJ4DV6AH300549':{poly:0x8C5B,init:0xFFFF},
  '2B3CJ5DT2BH590794':{poly:0x535D,init:0x0000},
  '2C3CDZFK3HH506737':{poly:0x71DE,init:0x4625},
  '2C3CDZC99HH514330':{poly:0x1189,init:0x0C99},
  '2C3CDXGJ1MH539855':{poly:0x5F08,init:0x0C99},
};

/* UDS Negative Response Code decoder */
function decodeNRC(code){
  const nrc={0x10:'General reject',0x11:'Service not supported',0x12:'Subfunction not supported',
    0x13:'Incorrect length',0x22:'Conditions not correct',0x24:'Sequence error',
    0x31:'Request out of range',0x33:'Security access denied',0x35:'Invalid key',
    0x36:'Exceeded attempts',0x37:'Required time delay not expired',0x78:'Response pending',
    0x7E:'Subfunction not supported in session',0x7F:'Service not supported in session'};
  return nrc[code]||('NRC 0x'+code.toString(16).toUpperCase());
}

/* DTC Status Byte decoder — SAE J2012 / ISO 14229-1 DTCStatusMask bits.
   Each DTC in a 19 02 response has a status byte; decode its 8 bits for user display. */
function decodeDtcStatus(byte){
  const flags=[];
  if(byte&0x01)flags.push('Active');
  if(byte&0x02)flags.push('Pending');
  if(byte&0x04)flags.push('Confirmed');
  if(byte&0x08)flags.push('MIL On');
  if(byte&0x10)flags.push('Test Not Completed');
  if(byte&0x20)flags.push('Failed Since Clear');
  if(byte&0x40)flags.push('Failed This Cycle');
  if(byte&0x80)flags.push('Warning Indicator');
  return flags.length?flags.join(', '):'Stored';
}

/* Shared adapter init — validated 11/3 bench test
   Returns: {send, uds, isSTN, adapter, disconnect} or null */
async function initAdapter(addLog,hxFn){
  if(!navigator.serial){addLog('Web Serial not supported — use Chrome/Edge','error');return null;}
  try{
    const port=await navigator.serial.requestPort();await port.open({baudRate:115200});
    const w=port.writable.getWriter();const rd=port.readable.getReader();const tdec=new TextDecoder();
    let rbuf='';
    const send=async(cmd,to=3000)=>{rbuf='';await w.write(new TextEncoder().encode(cmd+'\r'));addLog('TX > '+cmd,'tx');
      const deadline=Date.now()+to;
      while(Date.now()<deadline){
        try{const rp=rd.read();const tp=new Promise(r=>setTimeout(()=>r({value:undefined,done:true}),Math.min(500,deadline-Date.now())));
          const res=await Promise.race([rp,tp]);
          if(res.done||!res.value){if(Date.now()>=deadline)break;continue;}
          rbuf+=tdec.decode(res.value);const pi=rbuf.indexOf('>');
          if(pi!==-1){const r=rbuf.substring(0,pi).replace(/\r/g,'\n').replace(/\n+/g,'\n').trim();rbuf=rbuf.substring(pi+1);addLog('RX < '+r,'rx');return r;}
        }catch(e){break;}
      }
      const t=rbuf.replace(/\r/g,'\n').replace(/\n+/g,'\n').replace(/>/g,'').trim();if(t)addLog('RX (to) < '+t,'warn');return t;
    };
    await send('ATZ',3000);await new Promise(r=>setTimeout(r,1200));
    await send('ATE0');await new Promise(r=>setTimeout(r,150));
    const ati=await send('ATI');
    await new Promise(r=>setTimeout(r,150));
    const stdi=await send('STDI');const isSTN=!stdi.includes('?')&&stdi.length>2;
    addLog('Adapter: '+(isSTN?'STN/OBDLink':'ELM327')+' ('+ati+')','info');
    if(isSTN){
      await send('ATPP2CSV81',2000);await new Promise(r=>setTimeout(r,200));
      await send('ATPP2CON',2000);await new Promise(r=>setTimeout(r,200));
      await send('ATPP2DSV01',2000);await new Promise(r=>setTimeout(r,200));
      await send('ATPP2DON',2000);await new Promise(r=>setTimeout(r,200));
      await send('ATZ',3000);await new Promise(r=>setTimeout(r,1500));
      await send('ATE0',2000);await new Promise(r=>setTimeout(r,200));
    }
    await send('ATL0');await new Promise(r=>setTimeout(r,80));
    await send('ATS1');await new Promise(r=>setTimeout(r,80));
    await send('ATH1');await new Promise(r=>setTimeout(r,80));
    await send('ATSP6');await new Promise(r=>setTimeout(r,80));
    await send('ATAT2');await new Promise(r=>setTimeout(r,80));
    if(isSTN){await send('STPTO3000',1500);await new Promise(r=>setTimeout(r,100));}
    await send('ATST96');await new Promise(r=>setTimeout(r,80));
    await send('ATCAF1');await new Promise(r=>setTimeout(r,80));
    if(isSTN){
      await send('ATFCSH7E0');await new Promise(r=>setTimeout(r,80));
      await send('ATFCSD300000');await new Promise(r=>setTimeout(r,80));
      await send('ATFCSM1');await new Promise(r=>setTimeout(r,80));
    }
    let curTx=0,curRx=0;
    const uds=async(tx,rx,data,timeout)=>{
      if(tx!==curTx||rx!==curRx){
        await send('ATCRA');await new Promise(r=>setTimeout(r,50));
        await send('ATSH'+hxFn(tx,3));await new Promise(r=>setTimeout(r,50));
        if(isSTN){await send('ATFCSH'+hxFn(tx,3));await new Promise(r=>setTimeout(r,50));}
        await send('ATCRA'+hxFn(rx,3));await new Promise(r=>setTimeout(r,50));
        curTx=tx;curRx=rx;
      }
      const tm=timeout||(data.length>7?8000:4000);
      const h=Array.from(data).map(b=>hxFn(b)).join(' ');
      const r=await send(h,tm);
      if(!r||/NO DATA|CAN ERROR|UNABLE|BUS/.test(r))return{ok:false,raw:r||''};
      if(r.includes('?')||r.includes('ERROR'))return{ok:false,raw:r};
      const lines=r.split(/[\r\n]+/).map(l=>l.trim()).filter(Boolean);
      let all=[];
      for(const line of lines){
        if(line.includes('SEARCHING')||line==='OK')continue;
        const toks=line.split(/\s+/);
        if(toks.length<2)continue;
        if(/^[0-9A-F]{3}$/.test(toks[0].toUpperCase())){
          for(let i=1;i<toks.length;i++)if(/^[0-9A-Fa-f]{2}$/.test(toks[i]))all.push(parseInt(toks[i],16));
        }else{for(const t of toks)if(/^[0-9A-Fa-f]{2}$/.test(t))all.push(parseInt(t,16));}
      }
      if(!all.length)return{ok:false,raw:r};
      return{ok:true,d:new Uint8Array(all),raw:r};
    };
    /* readVoltage — reads ATRV (battery/bench voltage) — critical pre-flight check
       Returns voltage as a number (volts) or null if read failed */
    const readVoltage=async()=>{
      const r=await send('ATRV',2000);
      if(!r)return null;
      /* Format: "14.6V" or similar */
      const m=r.match(/(\d+\.\d+)\s*V?/i);
      return m?parseFloat(m[1]):null;
    };
    return{send,uds,isSTN,adapter:ati,readVoltage};
  }catch(e){addLog('Init failed: '+e.message,'error');return null;}
}

/* Parse VIN string from UDS response bytes */
function parseVinFromResponse(d){
  if(!d||d.length<3)return null;
  const payload=d[0]===0x62?Array.from(d).slice(3):Array.from(d);
  const ascii=payload.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
  return ascii.length>=10?ascii.slice(-17):null;
}

/* ═════════════════════════════════════════════════════════════════
   MODULE BACKUP SERVICE
   Read critical DIDs from a module before any write + store in localStorage
   Based on vault/server/module-backup-service.ts
   ═════════════════════════════════════════════════════════════════ */

/* Critical DIDs per module — what we back up before writing anything */
const CRITICAL_DIDS={
  BCM:[
    {did:0xF190,name:'VIN',critical:true},
    {did:0xF187,name:'Part Number'},
    {did:0xF189,name:'Software Version'},
    {did:0xF191,name:'Hardware Version'},
    {did:0xF18C,name:'Serial Number'},
    {did:0xF1A0,name:'BCM Config',critical:true},
    {did:0xF1A1,name:'BCM Feature Bytes',critical:true},
    {did:0xF1D0,name:'Key Fob Data'},
    {did:0xF1D1,name:'SKIM Data',critical:true},
    {did:0x7B90,name:'Current VIN',critical:true},
    {did:0x7B88,name:'Original VIN',critical:true},
  ],
  RFHUB:[
    {did:0xF190,name:'VIN',critical:true},
    {did:0xF187,name:'Part Number'},
    {did:0xF189,name:'Software Version'},
    {did:0xF18C,name:'PIN / Serial',critical:true},
    {did:0xF1E0,name:'Tire Sensors'},
    {did:0xF1E1,name:'Secret Key',critical:true},
  ],
  ECM:[
    {did:0xF190,name:'VIN',critical:true},
    {did:0xF187,name:'Part Number'},
    {did:0xF189,name:'Software Version'},
    {did:0xF191,name:'Hardware Version'},
    {did:0xF18C,name:'Serial Number'},
    {did:0xF194,name:'Software Fingerprint'},
    {did:0xF195,name:'Calibration ID'},
    {did:0xF40D,name:'Odometer',critical:true},
    {did:0xF1C1,name:'Engine Hours'},
    {did:0xF1C0,name:'Calibration Data',critical:true},
  ],
  ADCM:[
    {did:0xF190,name:'VIN',critical:true},
    {did:0xF187,name:'Part Number'},
    {did:0xF189,name:'Software Version'},
    {did:0xF1A1,name:'Suspension Mode'},
    {did:0xDE10,name:'Vehicle Config'},
    {did:0xDE11,name:'Variant Code'},
    {did:0x7B90,name:'Current VIN',critical:true},
    {did:0x7B88,name:'Original VIN',critical:true},
  ],
};

/* Create a backup of all critical DIDs from a module */
async function backupModule(engUds,tx,rx,moduleType,addLog,hxFn){
  const dids=CRITICAL_DIDS[moduleType];
  if(!dids){addLog('No backup profile for '+moduleType,'warn');return null;}
  addLog('═══ CREATING MODULE BACKUP: '+moduleType+' ═══','info');
  addLog('Reading '+dids.length+' critical DIDs before any writes...','info');
  /* Ensure extended session */
  await engUds(tx,rx,[0x10,0x03]);
  const backup={
    module:moduleType,
    tx:tx,rx:rx,
    timestamp:new Date().toISOString(),
    dids:{},
  };
  let successCount=0;
  for(const d of dids){
    const r=await engUds(tx,rx,[0x22,(d.did>>8)&0xFF,d.did&0xFF]);
    if(r.ok&&r.d&&r.d[0]===0x62){
      const raw=Array.from(r.d).slice(3);
      const hex=raw.map(b=>hxFn(b)).join('');
      const ascii=raw.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
      backup.dids[d.did]={name:d.name,critical:!!d.critical,hex,ascii:ascii.length>=3?ascii:'',bytes:raw};
      addLog('  0x'+hxFn(d.did,4)+' ('+d.name+'): '+hex,'rx');
      successCount++;
    }else{
      backup.dids[d.did]={name:d.name,critical:!!d.critical,hex:'',bytes:[],missing:true};
      addLog('  0x'+hxFn(d.did,4)+' ('+d.name+'): not readable','warn');
    }
  }
  addLog('Backup complete: '+successCount+'/'+dids.length+' DIDs captured','info');
  /* Save to localStorage keyed by module+VIN+timestamp */
  const vin=backup.dids[0xF190]?.ascii?.slice(-17)||'unknown';
  const key='srtlab_backup_'+moduleType+'_'+vin+'_'+Date.now();
  try{
    localStorage.setItem(key,JSON.stringify(backup));
    /* Keep index of all backups */
    const idx=JSON.parse(localStorage.getItem('srtlab_backup_index')||'[]');
    idx.unshift({key,module:moduleType,vin,timestamp:backup.timestamp,didCount:successCount});
    /* Keep only 50 most recent backups */
    if(idx.length>50){
      const toRemove=idx.slice(50);
      toRemove.forEach(b=>localStorage.removeItem(b.key));
    }
    localStorage.setItem('srtlab_backup_index',JSON.stringify(idx.slice(0,50)));
    addLog('✓ Backup saved to localStorage: '+key,'info');
  }catch(e){addLog('Failed to save backup: '+e.message,'error');}
  return backup;
}

/* Restore a module from a backup — writes back the original DIDs
   Only writes DIDs marked as 'critical' unless fullRestore is true */
async function restoreModule(engUds,tx,rx,backup,addLog,hxFn,fullRestore=false){
  if(!backup||!backup.dids){addLog('Invalid backup data','error');return false;}
  addLog('═══ RESTORING MODULE: '+backup.module+' ═══','info');
  addLog('Backup timestamp: '+backup.timestamp,'info');
  /* Need extended session + security unlock BEFORE this function is called */
  let restoredCount=0;let failedCount=0;
  for(const[didStr,data] of Object.entries(backup.dids)){
    const did=parseInt(didStr);
    if(!data.bytes||data.bytes.length===0){continue;}
    if(!fullRestore&&!data.critical){continue;}
    addLog('Restoring 0x'+hxFn(did,4)+' ('+data.name+')...','info');
    const r=await engUds(tx,rx,[0x2E,(did>>8)&0xFF,did&0xFF,...data.bytes]);
    if(r.ok&&r.d&&r.d[0]===0x6E){
      addLog('  ✓ Restored','rx');restoredCount++;
    }else{
      if(r.ok&&r.d&&r.d[0]===0x7F)addLog('  NRC: '+decodeNRC(r.d[2]||0),'error');
      else addLog('  Failed','error');
      failedCount++;
    }
    await new Promise(r=>setTimeout(r,200));
  }
  addLog('Restore: '+restoredCount+' success, '+failedCount+' failed','info');
  return failedCount===0;
}

/* Get list of saved backups */
function getBackupList(moduleType){
  try{
    const idx=JSON.parse(localStorage.getItem('srtlab_backup_index')||'[]');
    return moduleType?idx.filter(b=>b.module===moduleType):idx;
  }catch{return[];}
}

function getBackup(key){
  try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}
}

/* ═════════════════════════════════════════════════════════════════
   SESSION LOG SERVICE — paper trail of all write operations
   Every write records: timestamp, module, before/after VIN, source/title info,
   user confirmation of "read first" check, full UDS log.
   Stored in localStorage, exportable to JSON/PDF.
   ═════════════════════════════════════════════════════════════════ */
function logSession(entry){
  try{
    const sessions=JSON.parse(localStorage.getItem('srtlab_sessions')||'[]');
    const record={
      id:'sess_'+Date.now()+'_'+Math.random().toString(36).slice(2,8),
      timestamp:new Date().toISOString(),
      ...entry,
    };
    sessions.unshift(record);
    /* Keep 500 most recent sessions */
    const trimmed=sessions.slice(0,500);
    localStorage.setItem('srtlab_sessions',JSON.stringify(trimmed));
    return record;
  }catch(e){console.error('Session log failed:',e);return null;}
}

function getSessions(filter){
  try{
    const s=JSON.parse(localStorage.getItem('srtlab_sessions')||'[]');
    if(!filter)return s;
    return s.filter(x=>(!filter.module||x.module===filter.module)&&(!filter.vin||x.newVin===filter.vin||x.oldVin===filter.vin));
  }catch{return[];}
}

function deleteSession(id){
  try{
    const s=JSON.parse(localStorage.getItem('srtlab_sessions')||'[]');
    localStorage.setItem('srtlab_sessions',JSON.stringify(s.filter(x=>x.id!==id)));
  }catch{}
}

/* Export sessions as formatted HTML report (printable to PDF via browser) */
function generateSessionReport(sessions,shopInfo){
  const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SRT Lab Session Report</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:800px;margin:20px auto;padding:20px;color:#222;line-height:1.5}
h1{border-bottom:3px solid #D32F2F;padding-bottom:8px;margin-bottom:4px}
.shop{color:#666;font-size:13px;margin-bottom:20px}
.sess{border:1px solid #ddd;border-radius:8px;padding:16px;margin:14px 0;page-break-inside:avoid}
.sess h3{margin:0 0 10px;font-size:16px;display:flex;justify-content:space-between}
.sess h3 .mod{color:#D32F2F}
.sess h3 .ts{color:#666;font-size:12px;font-weight:normal}
.grid{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;margin:10px 0}
.grid span:nth-child(odd){color:#666;font-weight:bold}
.vin{font-family:'Courier New',monospace;font-weight:bold;color:#D32F2F}
.title-ref{background:#FFF8F0;padding:8px 12px;border-left:3px solid #FFB300;margin:8px 0;font-size:12px}
.result{display:inline-block;padding:3px 10px;border-radius:4px;font-weight:bold;font-size:11px}
.ok{background:#E8F5E9;color:#1B5E20}
.fail{background:#FFEBEE;color:#B71C1C}
.sig{margin-top:30px;padding-top:20px;border-top:1px solid #ddd;font-size:12px;color:#666}
.sig-line{margin-top:30px;border-bottom:1px solid #333;width:300px}
@media print{body{margin:0}.sess{page-break-inside:avoid}}
</style></head><body>
<h1>SRT Lab — Module Programming Report</h1>
<div class="shop">
${shopInfo.shopName?'<b>'+shopInfo.shopName+'</b><br>':''}
${shopInfo.address||''}
${shopInfo.license?'<br>Dealer License: '+shopInfo.license:''}
${shopInfo.tech?'<br>Technician: '+shopInfo.tech:''}
<br>Report Generated: ${new Date().toLocaleString()}
<br>Sessions Included: ${sessions.length}
</div>
${sessions.map(s=>`
<div class="sess">
<h3><span class="mod">${s.module} — ${s.operation||'VIN Write'}</span><span class="ts">${new Date(s.timestamp).toLocaleString()}</span></h3>
<div class="grid">
<span>Result:</span><span><span class="result ${s.success?'ok':'fail'}">${s.success?'✓ SUCCESS':'✗ FAILED'}</span></span>
<span>Old VIN:</span><span class="vin">${s.oldVin||'(not read)'}</span>
<span>New VIN:</span><span class="vin">${s.newVin||'—'}</span>
${s.moduleAddr?`<span>Module Address:</span><span>TX 0x${s.moduleAddr.tx.toString(16).toUpperCase()} / RX 0x${s.moduleAddr.rx.toString(16).toUpperCase()}</span>`:''}
${s.adapter?`<span>Adapter:</span><span>${s.adapter}</span>`:''}
${s.technician?`<span>Technician:</span><span>${s.technician}</span>`:''}
${s.preWriteConfirmed?`<span>Pre-Write Review:</span><span>✓ Confirmed at ${new Date(s.preWriteConfirmed).toLocaleTimeString()}</span>`:''}
</div>
${s.titleRef?`<div class="title-ref"><b>Title Reference:</b> ${s.titleRef}${s.titleNotes?' — '+s.titleNotes:''}</div>`:''}
${s.notes?`<div style="font-size:12px;color:#555;margin-top:8px"><b>Notes:</b> ${s.notes}</div>`:''}
</div>
`).join('')}
<div class="sig">
<p>I certify that the above module programming operations were performed on modules legitimately in my possession, with VINs corresponding to vehicles documented in my records.</p>
<div class="sig-line"></div>Signature / Date
</div>
</body></html>`;
  return html;
}

/* ═════════════════════════════════════════════════════════════════
   READ-FIRST CONFIRMATION MODAL
   Blocks any write until user reads the current state and confirms.
   Returns a Promise<{confirmed, titleRef, notes}> or null if cancelled.
   ═════════════════════════════════════════════════════════════════ */
function ReadFirstModal({module,currentState,newVin,onConfirm,onCancel}){
  const[reviewed,setReviewed]=useState(false);
  const[possessionCert,setPossessionCert]=useState(false);
  const[otpAck,setOtpAck]=useState(false);
  const[titleRef,setTitleRef]=useState('');
  const[titleNotes,setTitleNotes]=useState('');
  const[technician,setTechnician]=useState(()=>localStorage.getItem('srtlab_tech')||'');
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  const vinYear=parseVinYear(newVin);
  const needsSGW=vinHasSGW(newVin);
  const autelCfg=getAutelState();
  const bridgeOK=autelCfg.lastTestResult==='ok';
  const cdValid=vinCheckDigitValid(newVin);
  const otp=getOtpInfo(module);

  const canConfirm=reviewed&&possessionCert&&(otp?otpAck:true)&&titleRef.trim().length>0&&technician.trim().length>0;

  const handleConfirm=()=>{
    if(!canConfirm)return;
    if(technician)localStorage.setItem('srtlab_tech',technician);
    onConfirm({reviewed,possessionCert,otpAck,titleRef,titleNotes,technician,preWriteConfirmed:new Date().toISOString(),vinYear,sgwRouting:needsSGW?'autel-maxiflash':'direct',isOtp:!!otp});
  };

  return<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
    <div style={{background:'#fff',borderRadius:14,maxWidth:680,width:'100%',maxHeight:'90vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.5)'}}>
      {/* Header */}
      <div style={{padding:'20px 24px',background:'linear-gradient(135deg,#1A1A1A 0%,#D32F2F 100%)',color:'#fff',borderRadius:'14px 14px 0 0'}}>
        <div style={{fontSize:10,letterSpacing:3,opacity:.7,fontWeight:700}}>PRE-WRITE CONFIRMATION</div>
        <div style={{fontFamily:"'Righteous'",fontSize:22,letterSpacing:1,marginTop:4}}>⚠ READ BEFORE WRITING</div>
        <div style={{fontSize:12,opacity:.9,marginTop:6}}>Review the current module state. Once written, the old VIN is overwritten.</div>
      </div>

      <div style={{padding:24}}>
        {/* OTP DANGER BANNER — permanent write warning */}
        {otp&&<div style={{marginBottom:16,padding:14,background:'#B71C1C',color:'#fff',borderRadius:8,border:'3px solid #F44336'}}>
          <div style={{fontSize:13,fontWeight:900,letterSpacing:2,marginBottom:6}}>☠ OTP MEMORY — PERMANENT WRITE</div>
          <div style={{fontSize:12,lineHeight:1.5,marginBottom:10}}>{otp.warning}</div>
          <label style={{display:'flex',alignItems:'flex-start',gap:8,padding:10,background:'rgba(0,0,0,0.3)',borderRadius:6,cursor:'pointer'}}>
            <input type="checkbox" checked={otpAck} onChange={e=>setOtpAck(e.target.checked)} style={{width:18,height:18,cursor:'pointer',marginTop:2}}/>
            <span style={{fontSize:11,fontWeight:800,lineHeight:1.4}}>
              I understand this is a ONE-TIME PROGRAMMABLE module. A wrong VIN here cannot be undone
              — the module will be permanently bricked. I have verified the VIN matches the title
              and have a backup of the current state.
            </span>
          </label>
        </div>}

        {/* VIN validity + SGW routing banner */}
        <div style={{marginBottom:16,padding:12,background:needsSGW?(bridgeOK?'#FFF3E0':'#FFEBEE'):'#E8F5E9',border:'1.5px solid '+(needsSGW?(bridgeOK?'#FFB300':'#FF5252'):'#00C853'),borderRadius:8}}>
          <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',fontSize:12,fontWeight:700}}>
            <span style={{color:cdValid?'#2E7D32':'#F57C00'}}>{cdValid?'✓ VIN Check Digit Valid':'⚠ VIN Check Digit Invalid'}</span>
            <span style={{color:'#999'}}>·</span>
            <span>Year: {vinYear||'?'}</span>
            <span style={{color:'#999'}}>·</span>
            {needsSGW
              ?<span style={{color:bridgeOK?'#F57C00':'#C62828'}}>🔐 Requires SGW → {bridgeOK?'Autel MaxiFlash ready':'Autel bridge NOT connected'}</span>
              :<span style={{color:'#2E7D32'}}>🔓 Direct OBDLink connection OK</span>
            }
          </div>
          {needsSGW&&!bridgeOK&&<div style={{marginTop:8,fontSize:11,color:'#C62828',fontWeight:700}}>
            ⚠ This 2018+ vehicle requires the Autel MaxiFlash VCI. Go to AUTEL SGW tab → run bridge test before proceeding.
          </div>}
        </div>

        {/* Current state display */}
        <div style={{marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:2,marginBottom:8}}>CURRENT STATE — {module}</div>
          <div style={{background:'#FFF8F0',border:'2px solid #FFB300',borderRadius:8,padding:14}}>
            {currentState.length===0?<div style={{fontSize:12,color:'#999',fontStyle:'italic'}}>No prior state was read. Strongly recommended: cancel this write, run "Read VINs" first, then try again.</div>:
            currentState.map((item,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:i<currentState.length-1?'1px solid #FFE0B2':'none'}}>
                <div style={{fontSize:11,fontWeight:700,color:'#666'}}>{item.label}</div>
                <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:item.value?'#D84315':'#999'}}>{item.value||'(empty)'}</div>
              </div>
            ))}
          </div>
        </div>

        {/* New VIN display */}
        <div style={{marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:2,marginBottom:8}}>WRITING NEW VALUE</div>
          <div style={{background:'#E8F5E9',border:'2px solid #00C853',borderRadius:8,padding:14}}>
            <div style={{fontSize:10,color:'#2E7D32',fontWeight:700,marginBottom:4}}>Target VIN (from Master VIN bar)</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:18,fontWeight:800,letterSpacing:2,color:'#1B5E20'}}>{newVin}</div>
          </div>
        </div>

        {/* Title reference - paper trail */}
        <div style={{marginBottom:18,background:'#F0F8FF',border:'1px solid #B0D4F0',borderRadius:8,padding:14}}>
          <div style={{fontSize:11,fontWeight:800,color:'#1976D2',letterSpacing:2,marginBottom:10}}>📄 TITLE REFERENCE (paper trail · required)</div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,color:'#666',marginBottom:3,fontWeight:700}}>TITLE NUMBER / STOCK # / DOCUMENT REF <span style={{color:'#C62828'}}>*</span></div>
            <input value={titleRef} onChange={e=>setTitleRef(e.target.value)} placeholder="e.g. Stock 2024-087, Title #FL4820193X" style={{width:'100%',padding:10,border:'1.5px solid '+(titleRef.trim()?'#B0D4F0':'#FFCDD2'),borderRadius:6,fontSize:13,fontFamily:"'JetBrains Mono'"}}/>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,color:'#666',marginBottom:3,fontWeight:700}}>NOTES (optional)</div>
            <textarea value={titleNotes} onChange={e=>setTitleNotes(e.target.value)} placeholder="e.g. Replacement BCM for 2017 Challenger, module from licensed recycler, title VIN matches" rows={2} style={{width:'100%',padding:10,border:'1.5px solid #B0D4F0',borderRadius:6,fontSize:12,resize:'vertical',fontFamily:"'Nunito'"}}/>
          </div>
          <div>
            <div style={{fontSize:10,color:'#666',marginBottom:3,fontWeight:700}}>TECHNICIAN NAME <span style={{color:'#C62828'}}>*</span></div>
            <input value={technician} onChange={e=>setTechnician(e.target.value)} placeholder="Your name" style={{width:'100%',padding:10,border:'1.5px solid '+(technician.trim()?'#B0D4F0':'#FFCDD2'),borderRadius:6,fontSize:13}}/>
          </div>
        </div>

        {/* Review checkbox */}
        <label style={{display:'flex',alignItems:'flex-start',gap:10,padding:12,background:reviewed?'#E8F5E9':'#FFF3E0',border:'2px solid '+(reviewed?'#00C853':'#FFB300'),borderRadius:8,cursor:'pointer',marginBottom:10}}>
          <input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)} style={{width:20,height:20,cursor:'pointer',marginTop:2}}/>
          <span style={{fontSize:12,fontWeight:700,color:reviewed?'#1B5E20':'#E65100'}}>
            I have reviewed the current module state shown above and confirm the new VIN is correct.
          </span>
        </label>

        {/* Lawful possession certification - stronger */}
        <label style={{display:'flex',alignItems:'flex-start',gap:10,padding:12,background:possessionCert?'#E8F5E9':'#FFEBEE',border:'2px solid '+(possessionCert?'#00C853':'#FF5252'),borderRadius:8,cursor:'pointer',marginBottom:18}}>
          <input type="checkbox" checked={possessionCert} onChange={e=>setPossessionCert(e.target.checked)} style={{width:20,height:20,cursor:'pointer',marginTop:2}}/>
          <span style={{fontSize:12,fontWeight:700,color:possessionCert?'#1B5E20':'#B71C1C',lineHeight:1.5}}>
            I certify under my business license, as the above-named technician, that this module is in my lawful possession
            and the VIN "{newVin}" matches the title, registration, or other documentation I have on file for this vehicle.
            I understand this certification is recorded in the session paper trail with a timestamp.
          </span>
        </label>

        {/* Action buttons */}
        <div style={{display:'flex',gap:10}}>
          <button onClick={onCancel} style={{flex:1,padding:'14px 20px',background:'#F5F5F5',border:'1.5px solid #ccc',borderRadius:8,fontSize:14,fontWeight:700,cursor:'pointer',color:'#666'}}>
            Cancel
          </button>
          <button onClick={handleConfirm} disabled={!canConfirm} style={{flex:2,padding:'14px 20px',background:canConfirm?(otp?'linear-gradient(135deg,#B71C1C,#7F0000)':'linear-gradient(135deg,#D32F2F,#B71C1C)'):'#ccc',border:'none',borderRadius:8,fontSize:14,fontWeight:800,color:'#fff',cursor:canConfirm?'pointer':'not-allowed',letterSpacing:1}}>
            {canConfirm?(otp?'☠ CONFIRM PERMANENT OTP WRITE':'✓ CONFIRM & PROCEED WITH WRITE'):'Fill required fields →'}
          </button>
        </div>
      </div>
    </div>
  </div>;
}


/* ═════════════════════════════════════════════════════════════════
   BCM PROGRAMMER TAB
   VIN + CRC + all features on one screen
   ═════════════════════════════════════════════════════════════════ */
function BcmTab(){
  const{vin:masterVin,setModuleStatus}=React.useContext(MasterVinContext);
  const[conn,setConn]=useState(false);const[unlocked,setUnlocked]=useState(false);
  const[busy,setBusy]=useState('');const[log,setLog]=useState([]);
  const[curVin,setCurVin]=useState({});const[algo,setAlgo]=useState('');
  const[bcmAddr,setBcmAddr]=useState({tx:0x750,rx:0x758,name:'CDA6 primary'});
  const[backupCount,setBackupCount]=useState(getBackupList('BCM').length);
  const[showConfirmModal,setShowConfirmModal]=useState(false);
  const eng=useRef(null);
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-300),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  const BCM_CANDIDATES=[
    {tx:0x750,rx:0x758,name:'CDA6 primary (2017 Scat Pack)'},
    {tx:0x742,rx:0x762,name:'Legacy/DarkVIN'},
    {tx:0x7E0,rx:0x7E8,name:'Pre-2016'},
    {tx:0x6B0,rx:0x6B8,name:'DarkVIN alt'},
  ];

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(e){eng.current=e;setConn(true);addLog('Connected — ready for BCM ops','info');}
  },[addLog]);

  const findBcm=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Finding BCM...');
    for(const c of BCM_CANDIDATES){
      addLog('Probing '+c.name+' TX:0x'+hx(c.tx,3)+'...','info');
      const r=await eng.current.uds(c.tx,c.rx,[0x22,0xF1,0x90]);
      if(r.ok){setBcmAddr(c);addLog('✓ BCM found at '+c.name,'rx');setBusy('');return c;}
    }
    addLog('BCM not found on any address','error');setBusy('');return null;
  },[addLog]);

  const readVins=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading VINs...');
    await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x10,0x03]);
    const vins={};
    for(const did of [0xF190,0x7B90,0x7B88]){
      const r=await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x22,(did>>8)&0xFF,did&0xFF]);
      const v=r.ok?parseVinFromResponse(r.d):null;
      vins[did]=v;
      addLog('DID 0x'+hx(did,4)+': '+(v||'(no response)'),v?'rx':'warn');
    }
    setCurVin(vins);setBusy('');
  },[bcmAddr,addLog]);

  /* Backup BCM — reads all critical DIDs and saves to localStorage */
  const backupBcm=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Backing up BCM...');
    const backup=await backupModule(eng.current.uds,bcmAddr.tx,bcmAddr.rx,'BCM',addLog,hx);
    if(backup){
      setBackupCount(getBackupList('BCM').length);
      addLog('✓ BCM backup saved — can restore if write fails','info');
    }
    setBusy('');
  },[bcmAddr,addLog]);

  /* CDA6 security unlock — proven on real BCMs */
  const unlockBcm=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Unlocking BCM...');
    addLog('Entering extended session (10 03)...','info');
    await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x10,0x03]);
    addLog('Requesting seed (27 01)...','info');
    const s=await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x27,0x01]);
    if(!s.ok||!s.d||s.d.length<4){addLog('Seed request failed','error');setBusy('');return;}
    const sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
    addLog('Seed: 0x'+hx(sv,8),'info');
    /* Try CDA6 first (most common for Scat Pack era) */
    const algosToTry=[
      {n:'CDA6',fn:s=>cda6(s)},
      {n:'BCM Standard',fn:s=>(s*0x9D+0x1234)&0xFFFFFFFF},
      {n:'BCM FCA',fn:s=>((s^0xABCDEF12)*0x4D+0x5678)&0xFFFFFFFF},
    ];
    for(const a of algosToTry){
      const k=a.fn(sv);
      addLog('Trying '+a.n+' key 0x'+hx(k,8)+'...','info');
      const r=await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
      if(r.ok&&r.d&&r.d[0]===0x67){
        addLog('✓ UNLOCKED with '+a.n,'rx');setUnlocked(true);setAlgo(a.n);setBusy('');return;
      }
    }
    addLog('All algorithms failed','error');setBusy('');
  },[bcmAddr,addLog]);

  /* writeVin starts the flow — opens confirmation modal first */
  const writeVin=useCallback(()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(masterVin.length!==17){addLog('Master VIN must be 17 chars','error');return;}
    if(!unlocked){addLog('Unlock BCM first','error');return;}
    /* Open the Read-First modal — write only proceeds after user confirms */
    setShowConfirmModal(true);
  },[masterVin,unlocked,addLog]);

  /* executeWriteVin runs after modal confirmation */
  const executeWriteVin=useCallback(async(confirmData)=>{
    setShowConfirmModal(false);
    const oldVinSnapshot=curVin[0xF190]||null;
    setBusy('Writing VIN...');
    setModuleStatus(p=>({...p,BCM:'writing'}));
    addLog('═══ BCM VIN WRITE ═══','info');
    if(confirmData.technician)addLog('Technician: '+confirmData.technician,'info');
    if(confirmData.titleRef)addLog('Title reference: '+confirmData.titleRef,'info');
    /* PRE-FLIGHT: voltage check */
    const volts=await eng.current.readVoltage();
    if(volts!==null){
      addLog('Bench voltage: '+volts.toFixed(1)+'V','info');
      if(volts<12.4){
        addLog('⚠ WARNING: Voltage below 12.4V — writes may fail or corrupt module','warn');
        if(!window.confirm('Voltage is '+volts.toFixed(1)+'V (below 12.4V safe threshold). Continue anyway?')){
          addLog('Write aborted by user due to low voltage','error');
          setBusy('');setModuleStatus(p=>({...p,BCM:'pending'}));return;
        }
      }
    }else addLog('Could not read voltage — proceeding without check','warn');
    /* SAFETY NET: auto-backup module before any write */
    addLog('Creating safety backup before write...','info');
    const backup=await backupModule(eng.current.uds,bcmAddr.tx,bcmAddr.rx,'BCM',addLog,hx);
    if(backup)setBackupCount(getBackupList('BCM').length);
    addLog('Target: '+masterVin,'info');
    /* Calculate CRC16-CCITT of 8-char short VIN for reference */
    const shortVin=masterVin.slice(-8);
    const shortVinBytes=Array.from(shortVin).map(c=>c.charCodeAt(0));
    const crc=crc16ccitt(shortVinBytes);
    addLog('Short VIN: '+shortVin+' | CRC16-CCITT: 0x'+hx(crc,4),'info');
    const vb=Array.from(masterVin).map(c=>c.charCodeAt(0));
    let allOk=true;
    for(const did of [0xF190,0x7B90,0x7B88]){
      addLog('Writing DID 0x'+hx(did,4)+'...','info');
      const r=await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);
      if(r.ok&&r.d&&r.d[0]===0x6E){addLog('✓ 0x'+hx(did,4)+' written','rx');}
      else{
        if(r.ok&&r.d&&r.d[0]===0x7F){addLog('✗ 0x'+hx(did,4)+' NRC: '+decodeNRC(r.d[2]||0),'error');}
        else addLog('✗ 0x'+hx(did,4)+' failed','error');
        allOk=false;
      }
      await new Promise(r=>setTimeout(r,200));
    }
    /* Verify */
    addLog('─── Verifying ───','info');
    const verifiedVins={};
    for(const did of [0xF190,0x7B90,0x7B88]){
      const r=await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x22,(did>>8)&0xFF,did&0xFF]);
      const v=r.ok?parseVinFromResponse(r.d):null;
      verifiedVins[did]=v;
      const match=v===masterVin;
      addLog('0x'+hx(did,4)+': '+(match?'✓ MATCH':'✗ '+(v||'no response')),match?'rx':'warn');
      if(!match)allOk=false;
    }
    setCurVin(verifiedVins);
    setModuleStatus(p=>({...p,BCM:allOk?'ok':'fail'}));
    addLog(allOk?'═══ BCM VIN WRITE COMPLETE ═══':'═══ BCM VIN WRITE HAD FAILURES ═══',allOk?'info':'error');
    /* PAPER TRAIL: log the session */
    logSession({
      module:'BCM',
      operation:'VIN Write',
      oldVin:oldVinSnapshot,
      newVin:masterVin,
      moduleAddr:{tx:bcmAddr.tx,rx:bcmAddr.rx},
      adapter:eng.current.adapter||'ELM327/STN',
      voltage:volts,
      algorithm:algo,
      success:allOk,
      technician:confirmData.technician,
      titleRef:confirmData.titleRef,
      titleNotes:confirmData.titleNotes,
      preWriteConfirmed:confirmData.preWriteConfirmed,
      dids:Object.keys(verifiedVins).map(d=>({did:'0x'+hx(parseInt(d),4),value:verifiedVins[d]})),
    });
    addLog('📄 Session logged to paper trail','info');
    setBusy('');
  },[masterVin,bcmAddr,addLog,setModuleStatus,curVin,algo]);

  const ecuReset=useCallback(async()=>{
    if(!eng.current)return;
    addLog('Sending ECU reset (11 01)...','info');
    await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x11,0x01]);
    addLog('Reset sent — wait ~3 sec for BCM to come back','info');
    setUnlocked(false);
  },[bcmAddr,addLog]);

  const vinValid=masterVin.length===17;
  return<div>
    {showConfirmModal&&<ReadFirstModal
      module="BCM"
      currentState={[
        {label:'Primary VIN (DID 0xF190)',value:curVin[0xF190]},
        {label:'Current VIN (DID 0x7B90)',value:curVin[0x7B90]},
        {label:'Original VIN (DID 0x7B88)',value:curVin[0x7B88]},
        {label:'Module Address',value:'TX 0x'+hx(bcmAddr.tx,3)+' / RX 0x'+hx(bcmAddr.rx,3)},
        {label:'Unlock Algorithm',value:algo||'(not unlocked)'},
      ]}
      newVin={masterVin}
      onConfirm={executeWriteVin}
      onCancel={()=>{setShowConfirmModal(false);addLog('Write cancelled at confirmation step','warn');}}
    />}
    <Card style={{background:'linear-gradient(135deg,#3D0A0A 0%,#8B0000 40%,#D32F2F 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🧠</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>BCM PROGRAMMER</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>BODY CONTROL MODULE · VIN + CRC + FEATURES</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
          {!conn?'○ DISCONNECTED':unlocked?'● UNLOCKED ('+algo+')':'● CONNECTED'}
        </div>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>⚡ CONTROLS</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {!conn&&<Btn onClick={connect} color={C.sr}>🔌 Connect</Btn>}
        {conn&&<Btn onClick={findBcm} disabled={!!busy} color={C.a3}>🎯 Find BCM</Btn>}
        {conn&&<Btn onClick={readVins} disabled={!!busy} color={C.a2}>📖 Read VINs</Btn>}
        {conn&&<Btn onClick={backupBcm} disabled={!!busy} color={C.gn}>💾 Backup Module</Btn>}
        {conn&&<Btn onClick={unlockBcm} disabled={!!busy} color={C.a4}>🔓 Unlock (CDA6)</Btn>}
        {conn&&<Btn onClick={writeVin} disabled={!!busy||!unlocked||!vinValid} color={C.sr}>💾 Write Master VIN</Btn>}
        {conn&&<Btn onClick={ecuReset} disabled={!!busy} color={C.er} outline>⚡ ECU Reset</Btn>}
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>
        Target: {bcmAddr.name} · TX 0x{hx(bcmAddr.tx,3)} · RX 0x{hx(bcmAddr.rx,3)}
      </div>
      {backupCount>0&&<div style={{marginTop:8,fontSize:10,color:C.gn}}>
        ✓ {backupCount} backup{backupCount===1?'':'s'} saved for this module
      </div>}
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>🔑 VIN STATUS</div>
      {!vinValid&&<div style={{padding:10,background:'#FFF8F0',border:'1px solid '+C.wn,borderRadius:8,fontSize:12,color:C.wn,marginBottom:10}}>
        ⚠ Enter a valid 17-char Master VIN at the top of the page
      </div>}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
        {[{did:0xF190,l:'Primary VIN'},{did:0x7B90,l:'Current VIN'},{did:0x7B88,l:'Original VIN'}].map(x=>{
          const v=curVin[x.did];const match=v&&v===masterVin;
          return<div key={x.did} style={{padding:10,background:match?'#E8F5E9':v?'#FFF8F0':'#F8F6F2',borderRadius:8,border:'1px solid '+(match?C.gn:v?C.wn:C.bd)}}>
            <div style={{fontSize:9,color:C.ts,letterSpacing:1,fontWeight:700}}>DID 0x{hx(x.did,4)} · {x.l}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,marginTop:4,color:match?C.gn:v?C.wn:C.tm}}>{v||'(not read)'}</div>
            {match&&<div style={{fontSize:9,color:C.gn,marginTop:2}}>✓ matches Master VIN</div>}
          </div>;
        })}
      </div>
    </Card>

    {/* Short VIN + CRC display */}
    {vinValid&&<Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>🔢 SHORT VIN CHECKSUM (CRC16-CCITT)</div>
      <div style={{fontFamily:"'JetBrains Mono'",fontSize:12,display:'grid',gridTemplateColumns:'auto 1fr',gap:'8px 16px'}}>
        <span style={{color:C.ts}}>Short VIN (last 8):</span><span style={{fontWeight:700}}>{masterVin.slice(-8)}</span>
        <span style={{color:C.ts}}>CRC16-CCITT:</span><span style={{fontWeight:700,color:C.a3}}>0x{hx(crc16ccitt(Array.from(masterVin.slice(-8)).map(c=>c.charCodeAt(0))),4)}</span>
        <span style={{color:C.ts}}>Flash locations:</span><span style={{fontSize:10,color:C.tm}}>0x0098 (primary) · 0x00B0 (backup)</span>
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.ts,fontStyle:'italic'}}>
        BCM firmware auto-updates these internal flash locations when DID 0xF190 is written via UDS.
      </div>
    </Card>}

    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{fontWeight:800,fontSize:12,color:'#FF5252',marginBottom:10,letterSpacing:2}}>📋 LOG</div>
      <div style={{maxHeight:320,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Ready</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}


/* ═════════════════════════════════════════════════════════════════
   RFHUB PROGRAMMER TAB
   VIN + key fob programming
   ═════════════════════════════════════════════════════════════════ */
function RfhubTab(){
  const{vin:masterVin,setModuleStatus}=React.useContext(MasterVinContext);
  const[conn,setConn]=useState(false);const[unlocked,setUnlocked]=useState(false);
  const[busy,setBusy]=useState('');const[log,setLog]=useState([]);
  const[curVin,setCurVin]=useState(null);const[pin,setPin]=useState('');
  const[keysProgrammed,setKeysProgrammed]=useState(null);
  const[pinAttempts,setPinAttempts]=useState(0);const[pinExtractInfo,setPinExtractInfo]=useState('');
  const[showConfirmModal,setShowConfirmModal]=useState(false);
  const[rfhubAddr,setRfhubAddr]=useState({tx:0x75F,rx:0x767,name:'Primary (LX/LD)'});
  const eng=useRef(null);
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-300),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');
  const sbecKey=s=>u32((s*4+0x9018));

  const RFHUB_CANDIDATES=[
    {tx:0x75F,rx:0x767,name:'Primary LX/LD (Scat Pack)'},
    {tx:0x742,rx:0x762,name:'Alternate'},
    {tx:0x762,rx:0x76A,name:'FGA variant'},
    {tx:0x740,rx:0x748,name:'Legacy'},
  ];

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(e){eng.current=e;setConn(true);addLog('Connected — ready for RFHUB ops','info');}
  },[addLog]);

  const findRfhub=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Finding RFHUB...');
    for(const c of RFHUB_CANDIDATES){
      addLog('Probing '+c.name+' TX:0x'+hx(c.tx,3)+'...','info');
      const r=await eng.current.uds(c.tx,c.rx,[0x22,0xF1,0x90]);
      if(r.ok){setRfhubAddr(c);addLog('✓ RFHUB found at '+c.name,'rx');setBusy('');return c;}
    }
    addLog('RFHUB not found','error');setBusy('');return null;
  },[addLog]);

  const readVin=useCallback(async()=>{
    if(!eng.current)return;
    setBusy('Reading VIN...');
    await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x10,0x03]);
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x22,0xF1,0x90]);
    const v=r.ok?parseVinFromResponse(r.d):null;
    setCurVin(v);addLog('RFHUB VIN: '+(v||'(no response)'),v?'rx':'warn');
    setBusy('');
  },[rfhubAddr,addLog]);

  const unlockRfhub=useCallback(async()=>{
    if(!eng.current)return;
    setBusy('Unlocking RFHUB...');
    await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x10,0x03]);
    const s=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x27,0x01]);
    if(!s.ok||!s.d||s.d.length<4){addLog('Seed request failed','error');setBusy('');return;}
    const sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
    addLog('Seed: 0x'+hx(sv,8),'info');
    const k=sbecKey(sv);
    addLog('SBEC Key: 0x'+hx(k,8)+' [(seed*4)+0x9018]','info');
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
    if(r.ok&&r.d&&r.d[0]===0x67){setUnlocked(true);addLog('✓ RFHUB UNLOCKED','rx');}
    else addLog('Unlock failed','error');
    setBusy('');
  },[rfhubAddr,addLog]);

  /* Extract PIN from RFHUB — per PIN_EXTRACTION_ALGORITHM.md
     PIN stored at DID 0xF18C in BCD format (byte1 nibbles = digits 1-2, byte2 nibbles = digits 3-4)
     Fallback DIDs: 0xF18D, 0xF1A0 */
  const extractPin=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Extracting PIN from RFHUB...');
    addLog('═══ PIN EXTRACTION ═══','info');
    /* Need extended session */
    await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x10,0x03]);
    /* Try each PIN DID in order */
    const pinDids=[0xF18C,0xF18D,0xF1A0];
    for(const did of pinDids){
      addLog('Reading DID 0x'+hx(did,4)+'...','info');
      const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x22,(did>>8)&0xFF,did&0xFF]);
      if(!r.ok||!r.d||r.d[0]!==0x62){
        if(r.ok&&r.d&&r.d[0]===0x7F){addLog('  DID 0x'+hx(did,4)+' NRC: '+decodeNRC(r.d[2]||0),'warn');}
        continue;
      }
      /* Response: 62 DID_HI DID_LO [byte1] [byte2] */
      const raw=Array.from(r.d).slice(3,5);
      if(raw.length<2){addLog('  DID 0x'+hx(did,4)+' too short','warn');continue;}
      const rawHex=raw.map(b=>hx(b)).join(' ');
      addLog('  Raw bytes: '+rawHex,'info');
      /* Try BCD decode first */
      const d1=(raw[0]>>4)&0x0F,d2=raw[0]&0x0F,d3=(raw[1]>>4)&0x0F,d4=raw[1]&0x0F;
      if(d1<=9&&d2<=9&&d3<=9&&d4<=9){
        const extracted=`${d1}${d2}${d3}${d4}`;
        setPin(extracted);
        setPinExtractInfo('PIN '+extracted+' extracted via BCD from DID 0x'+hx(did,4));
        addLog('✓ PIN extracted (BCD): '+extracted+' from DID 0x'+hx(did,4),'rx');
        setBusy('');return;
      }
      /* Try binary decode (some modules use uint16) */
      const bin=(raw[0]<<8)|raw[1];
      if(bin>=1000&&bin<=9999){
        const extracted=bin.toString().padStart(4,'0');
        setPin(extracted);
        setPinExtractInfo('PIN '+extracted+' extracted via binary from DID 0x'+hx(did,4));
        addLog('✓ PIN extracted (binary): '+extracted+' from DID 0x'+hx(did,4),'rx');
        setBusy('');return;
      }
      addLog('  DID 0x'+hx(did,4)+' data not a valid PIN format','warn');
    }
    addLog('✗ PIN extraction failed — PIN not found at any known DID','error');
    addLog('Module may need unlock first, or PIN stored at nonstandard DID','warn');
    setBusy('');
  },[rfhubAddr,addLog]);

  const writeVin=useCallback(()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(masterVin.length!==17){addLog('Master VIN must be 17 chars','error');return;}
    if(!unlocked){addLog('Unlock RFHUB first','error');return;}
    setShowConfirmModal(true);
  },[masterVin,unlocked,addLog]);

  const executeWriteVin=useCallback(async(confirmData)=>{
    setShowConfirmModal(false);
    const oldVinSnapshot=curVin;
    setBusy('Writing VIN to RFHUB...');
    setModuleStatus(p=>({...p,RFHUB:'writing'}));
    addLog('═══ RFHUB VIN WRITE ═══','info');
    if(confirmData.technician)addLog('Technician: '+confirmData.technician,'info');
    if(confirmData.titleRef)addLog('Title reference: '+confirmData.titleRef,'info');
    /* SAFETY NET: auto-backup module before any write */
    addLog('Creating safety backup before write...','info');
    await backupModule(eng.current.uds,rfhubAddr.tx,rfhubAddr.rx,'RFHUB',addLog,hx);
    /* Show CRC algorithm for this VIN if known */
    const knownAlgo=RFHUB_KNOWN_ALGOS[masterVin];
    if(knownAlgo)addLog('Known CRC algorithm: poly=0x'+hx(knownAlgo.poly,4)+' init=0x'+hx(knownAlgo.init,4),'info');
    else addLog('VIN not in known algorithm DB — RFHUB firmware will compute CRC','warn');
    const vb=Array.from(masterVin).map(c=>c.charCodeAt(0));
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x2E,0xF1,0x90,...vb]);
    let ok=false;
    if(r.ok&&r.d&&r.d[0]===0x6E){ok=true;addLog('✓ VIN written','rx');}
    else if(r.ok&&r.d&&r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'error');
    else addLog('Write failed','error');
    /* Verify */
    const vr=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x22,0xF1,0x90]);
    const v=vr.ok?parseVinFromResponse(vr.d):null;
    setCurVin(v);
    const match=v===masterVin;
    addLog(match?'✓ VERIFIED: VIN matches':'✗ VERIFY FAIL: '+(v||'no response'),match?'rx':'warn');
    setModuleStatus(p=>({...p,RFHUB:(ok&&match)?'ok':'fail'}));
    /* PAPER TRAIL */
    logSession({
      module:'RFHUB',
      operation:'VIN Write',
      oldVin:oldVinSnapshot,
      newVin:masterVin,
      moduleAddr:{tx:rfhubAddr.tx,rx:rfhubAddr.rx},
      adapter:eng.current.adapter||'ELM327/STN',
      success:ok&&match,
      technician:confirmData.technician,
      titleRef:confirmData.titleRef,
      titleNotes:confirmData.titleNotes,
      preWriteConfirmed:confirmData.preWriteConfirmed,
    });
    addLog('📄 Session logged to paper trail','info');
    setBusy('');
  },[masterVin,rfhubAddr,addLog,setModuleStatus,curVin]);

  /* Key fob programming — Routine 0x0401 Learn new key
     NOTE: PIN placement in routine request is NOT documented in source files.
     We try 3 common FCA formats sequentially:
     1. PIN as 4 separate digit bytes: 31 01 04 01 [d1] [d2] [d3] [d4]
     2. PIN as 2 packed BCD bytes: 31 01 04 01 [d1d2] [d3d4]
     3. PIN as 4 ASCII bytes: 31 01 04 01 '1' '2' '3' '4'
     4. No PIN (PIN may be sent via different service like SecurityAccess 27 03)
     If one returns 0x71 positive, we proceed. */
  const programNewKey=useCallback(async()=>{
    if(!eng.current||!unlocked){addLog('Unlock RFHUB first','error');return;}
    if(pin.length!==4){addLog('Enter 4-digit PIN','error');return;}
    setBusy('Programming new key fob...');
    addLog('═══ KEY FOB PROGRAMMING (EXPERIMENTAL) ═══','info');
    addLog('⚠ PIN format not in source docs — trying 4 common FCA encodings','warn');
    addLog('PIN: '+pin,'info');
    const d=pin.split('').map(c=>parseInt(c,10));
    const pinFormats=[
      {name:'4 digit bytes',bytes:d},
      {name:'2 BCD bytes',bytes:[(d[0]<<4)|d[1],(d[2]<<4)|d[3]]},
      {name:'4 ASCII bytes',bytes:pin.split('').map(c=>c.charCodeAt(0))},
      {name:'no PIN',bytes:[]},
    ];
    let accepted=null;
    for(const fmt of pinFormats){
      const cmdBytes=[0x31,0x01,0x04,0x01,...fmt.bytes];
      addLog('Trying '+fmt.name+': '+cmdBytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' '),'info');
      const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,cmdBytes);
      if(r.ok&&r.d&&r.d[0]===0x71){accepted=fmt;break;}
      if(r.ok&&r.d&&r.d[0]===0x7F){
        const nrc=r.d[2]||0;
        addLog('  NRC: '+decodeNRC(nrc),'warn');
        /* NRC 0x22 means the routine itself has a precondition — stop trying different PINs */
        if(nrc===0x22){addLog('Conditions not correct — check ignition state / session','error');break;}
      }
      await new Promise(r=>setTimeout(r,300));
    }
    if(accepted){
      addLog('✓ Routine accepted using '+accepted.name,'rx');
      addLog('>>> HOLD UNLOCK BUTTON ON NEW FOB within 10 seconds <<<','info');
      addLog('Waiting 12 seconds...','info');
      await new Promise(r=>setTimeout(r,12000));
      /* Request routine results (control type 0x03) to confirm */
      addLog('Checking routine results (31 03 04 01)...','info');
      const status=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x31,0x03,0x04,0x01]);
      if(status.ok&&status.d&&status.d[0]===0x71){
        addLog('✓ Routine results: '+Array.from(status.d).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' '),'rx');
        /* Success — reset attempt counter */
        setPinAttempts(0);
      }else addLog('Status inconclusive — click Locate Keys to verify count increased','warn');
    }else{
      /* PIN rejected — increment attempt counter */
      const newAttempts=pinAttempts+1;
      setPinAttempts(newAttempts);
      addLog('✗ All PIN formats rejected — attempt '+newAttempts+'/3 used','error');
      if(newAttempts>=3){
        addLog('🛑 MAXIMUM ATTEMPTS REACHED — RFHUB may now require dealer unlock','error');
        addLog('Do NOT try again. Dealer scan tool required to reset attempt counter.','error');
      }else{
        addLog('⚠ '+(3-newAttempts)+' attempt(s) remaining before permanent lockout','warn');
      }
    }
    setBusy('');
  },[rfhubAddr,unlocked,pin,addLog,pinAttempts]);

  const locateKeys=useCallback(async()=>{
    if(!eng.current||!unlocked){addLog('Unlock RFHUB first','error');return;}
    setBusy('Locating programmed keys...');
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x31,0x01,0x04,0x03]);
    if(r.ok&&r.d&&r.d[0]===0x71){
      /* Response format varies — count key slots */
      const slots=r.d.length>5?Array.from(r.d).slice(5):[];
      const count=slots.filter(b=>b!==0).length;
      setKeysProgrammed(count);
      addLog('✓ Keys programmed: '+count,'rx');
      addLog('Slot data: '+slots.map(b=>hx(b)).join(' '),'info');
    }else addLog('Locate failed','error');
    setBusy('');
  },[rfhubAddr,unlocked,addLog]);

  const eraseAllKeys=useCallback(async()=>{
    if(!eng.current||!unlocked)return;
    if(!window.confirm('Erase ALL programmed keys from RFHUB? You will need to re-program at least one key to start the vehicle.'))return;
    setBusy('Erasing all keys...');
    addLog('Routine 0x0404 Erase All Keys...','info');
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x31,0x01,0x04,0x04]);
    if(r.ok&&r.d&&r.d[0]===0x71){addLog('✓ All keys erased','rx');setKeysProgrammed(0);}
    else addLog('Erase failed','error');
    setBusy('');
  },[rfhubAddr,unlocked,addLog]);

  const vinValid=masterVin.length===17;
  return<div>
    {showConfirmModal&&<ReadFirstModal
      module="RFHUB"
      currentState={[
        {label:'Current VIN (DID 0xF190)',value:curVin},
        {label:'Module Address',value:'TX 0x'+hx(rfhubAddr.tx,3)+' / RX 0x'+hx(rfhubAddr.rx,3)},
        {label:'Security',value:unlocked?'Unlocked (SBEC)':'Not unlocked'},
      ]}
      newVin={masterVin}
      onConfirm={executeWriteVin}
      onCancel={()=>{setShowConfirmModal(false);addLog('Write cancelled at confirmation step','warn');}}
    />}
    <Card style={{background:'linear-gradient(135deg,#0A3D3D 0%,#006B6B 40%,#00BFA5 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🔑</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>RFHUB PROGRAMMER</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>RF HUB · VIN · KEY FOBS</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
          {!conn?'○ DISCONNECTED':unlocked?'● UNLOCKED':'● CONNECTED'}
        </div>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:10,letterSpacing:2}}>⚡ CONTROLS</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {!conn&&<Btn onClick={connect} color={C.a2}>🔌 Connect</Btn>}
        {conn&&<Btn onClick={findRfhub} disabled={!!busy} color={C.a3}>🎯 Find RFHUB</Btn>}
        {conn&&<Btn onClick={readVin} disabled={!!busy} color={C.a2}>📖 Read VIN</Btn>}
        {conn&&<Btn onClick={unlockRfhub} disabled={!!busy} color={C.a4}>🔓 Unlock (SBEC)</Btn>}
        {conn&&<Btn onClick={writeVin} disabled={!!busy||!unlocked||!vinValid} color={C.a2}>💾 Write Master VIN</Btn>}
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>
        Target: {rfhubAddr.name} · TX 0x{hx(rfhubAddr.tx,3)} · RX 0x{hx(rfhubAddr.rx,3)}
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:10,letterSpacing:2}}>🔑 VIN STATUS</div>
      <div style={{padding:12,background:curVin===masterVin?'#E8F5E9':curVin?'#FFF8F0':'#F8F6F2',borderRadius:8,border:'1px solid '+(curVin===masterVin?C.gn:curVin?C.wn:C.bd)}}>
        <div style={{fontSize:10,color:C.ts,letterSpacing:1,fontWeight:700}}>Current VIN on RFHUB (DID 0xF190)</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,marginTop:4}}>{curVin||'(not read)'}</div>
        {curVin===masterVin&&<div style={{fontSize:10,color:C.gn,marginTop:4}}>✓ matches Master VIN</div>}
      </div>
    </Card>

    {/* KEY FOB PROGRAMMING */}
    <Card style={{marginBottom:14,background:'linear-gradient(135deg,#FFF8F0 0%,#FFE0B2 100%)',border:'2px solid '+C.a1}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:13,color:C.a1,letterSpacing:1}}>🔑 KEY FOB PROGRAMMING</div>
        <div style={{fontSize:9,fontWeight:800,padding:'3px 8px',background:C.wn+'22',color:C.wn,borderRadius:4,letterSpacing:1,border:'1px solid '+C.wn+'55'}}>⚠ EXPERIMENTAL</div>
      </div>
      <div style={{padding:10,background:'#FFFDE7',border:'1px solid '+C.wn+'55',borderRadius:6,fontSize:11,color:C.ts,marginBottom:12,lineHeight:1.5}}>
        <b>Heads up:</b> The exact PIN encoding for routine 0x0401 is not documented in our source files.
        This tool auto-tries 4 common FCA formats. If one works, we log which one so we can hard-code it later.
        Use bench-only first — don't risk locking out a customer's RFHUB.
      </div>
      <div style={{marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
          <div style={{fontSize:11,color:C.ts,fontWeight:700}}>4-DIGIT PIN (auto-extract or enter manually)</div>
          <div style={{fontSize:10,color:pinAttempts>=2?C.er:pinAttempts===1?C.wn:C.ts,fontFamily:"'JetBrains Mono'",fontWeight:700}}>
            Attempts: {pinAttempts}/3 {pinAttempts>=2&&'⚠'}
          </div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,'').slice(0,4))} maxLength={4} placeholder="----" style={{width:120,padding:'10px 14px',border:'2px solid '+(pin.length===4?C.gn:C.bd),borderRadius:8,fontSize:18,fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:8,textAlign:'center'}}/>
          <Btn onClick={extractPin} disabled={!!busy||!conn} color={C.a3} outline>🔍 Extract PIN from RFHUB</Btn>
        </div>
        {pinExtractInfo&&<div style={{marginTop:8,padding:8,background:'#E8F5E9',borderRadius:6,fontSize:11,fontFamily:"'JetBrains Mono'",color:C.gn}}>
          ✓ {pinExtractInfo}
        </div>}
      </div>
      {pinAttempts>=2&&<div style={{padding:10,background:'#FFEBEE',border:'2px solid '+C.er,borderRadius:6,fontSize:11,color:C.er,marginBottom:12,fontWeight:700}}>
        ⚠ CRITICAL: {3-pinAttempts} attempt{3-pinAttempts===1?'':'s'} remaining. 3 wrong PINs = PERMANENT RFHUB LOCKOUT requiring dealer unlock.
      </div>}
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <Btn onClick={programNewKey} disabled={!!busy||!unlocked||pin.length!==4||pinAttempts>=3} color={C.a1}>➕ Program New Key (0x0401)</Btn>
        <Btn onClick={locateKeys} disabled={!!busy||!unlocked} color={C.a3} outline>📍 Locate Keys (0x0403)</Btn>
        <Btn onClick={eraseAllKeys} disabled={!!busy||!unlocked} color={C.er} outline>🗑️ Erase All (0x0404)</Btn>
      </div>
      {keysProgrammed!==null&&<div style={{marginTop:10,padding:8,background:'#fff',borderRadius:6,fontSize:12,fontWeight:700}}>
        Programmed keys: <span style={{color:C.a1}}>{keysProgrammed}</span> / 8
      </div>}
      <div style={{marginTop:10,fontSize:10,color:C.ts,fontStyle:'italic'}}>
        After clicking "Program New Key", hold the UNLOCK button on the new fob within 10 seconds.
      </div>
    </Card>

    {/* CRC ALGORITHM INFO */}
    {vinValid&&<Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:10,letterSpacing:2}}>🔢 RFHUB CRC ALGORITHM</div>
      {RFHUB_KNOWN_ALGOS[masterVin]?<div style={{fontFamily:"'JetBrains Mono'",fontSize:12}}>
        <div>✓ Known algorithm: poly=0x{hx(RFHUB_KNOWN_ALGOS[masterVin].poly,4)} init=0x{hx(RFHUB_KNOWN_ALGOS[masterVin].init,4)}</div>
      </div>:<div style={{fontSize:12,color:C.wn}}>
        ⚠ Unknown VIN — firmware will compute CRC on-the-fly during UDS write. No brute-force needed.
      </div>}
    </Card>}

    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{fontWeight:800,fontSize:12,color:'#00BFA5',marginBottom:10,letterSpacing:2}}>📋 LOG</div>
      <div style={{maxHeight:320,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Ready</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}


/* ═════════════════════════════════════════════════════════════════
   ECM PROGRAMMER TAB
   VIN + tune info + all security algos
   ═════════════════════════════════════════════════════════════════ */
function EcmTab(){
  const{vin:masterVin,setModuleStatus}=React.useContext(MasterVinContext);
  const[conn,setConn]=useState(false);const[unlocked,setUnlocked]=useState(false);
  const[busy,setBusy]=useState('');const[log,setLog]=useState([]);
  const[curVin,setCurVin]=useState(null);const[ecmInfo,setEcmInfo]=useState({});
  const[algo,setAlgo]=useState('');
  const[showConfirmModal,setShowConfirmModal]=useState(false);
  const ecmAddr={tx:0x7E0,rx:0x7E8};
  const eng=useRef(null);
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-300),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  /* All 17 security algorithms for ECM */
  const ECM_ALGOS=[
    {n:'GPEC2 (Continental)',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0xE72E3799):u32(k<<1);}return k;}},
    {n:'GPEC2 Flash',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0x966AEEB1):u32(k<<1);}return k;}},
    {n:'GPEC2 EPROM',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0x3F711F5A):u32(k<<1);}return k;}},
    {n:'GPEC3 (2018+)',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0x129D657F):u32(k<<1);}return k;}},
    {n:'GPEC2A',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0xCE853A6F):u32(k<<1);}return k;}},
    {n:'GPEC2 2015',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0x47EC21F8):u32(k<<1);}return k;}},
    {n:'GPEC1',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^670269):u32(k<<1);}return k;}},
    {n:'NGC',fn:s=>{const NT=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31];const NS=[0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];let k=0;for(let i=0;i<4;i++){let b=(u32(s)>>(i*8))&0xFF;k=u32(k^u32(((NT[b&0xF]^NT[(b>>4)&0xF])*NS[i%8])&0xFFFFFFFF));}return k;}},
    {n:'SBEC (legacy)',fn:s=>u32(s*4+0x9018)},
    {n:'JTEC',fn:()=>0},
  ];

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(e){eng.current=e;setConn(true);addLog('Connected — ready for ECM ops','info');}
  },[addLog]);

  const readInfo=useCallback(async()=>{
    if(!eng.current)return;
    setBusy('Reading ECM info...');
    await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x10,0x03]);
    const info={};
    const reads=[
      {did:0xF190,label:'VIN'},
      {did:0xF187,label:'Part Number'},
      {did:0xF189,label:'Software Version'},
      {did:0xF18C,label:'Serial Number'},
      {did:0xF191,label:'Hardware Number'},
      {did:0xF194,label:'Software Fingerprint'},
      {did:0xF195,label:'Cal ID'},
    ];
    for(const r of reads){
      const res=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x22,(r.did>>8)&0xFF,r.did&0xFF]);
      if(res.ok&&res.d&&res.d[0]===0x62){
        const data=Array.from(res.d).slice(3);
        const ascii=data.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('').trim();
        const hex=data.map(b=>hx(b)).join(' ');
        info[r.did]={label:r.label,ascii,hex};
        addLog(r.label+' (0x'+hx(r.did,4)+'): '+(ascii||hex),'rx');
        if(r.did===0xF190)setCurVin(ascii.slice(-17));
      }else addLog(r.label+' (0x'+hx(r.did,4)+'): no response','warn');
    }
    setEcmInfo(info);setBusy('');
  },[addLog]);

  const unlockEcm=useCallback(async()=>{
    if(!eng.current)return;
    setBusy('Unlocking ECM (trying all algos)...');
    await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x10,0x03]);
    let s=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x27,0x01]);
    if(!s.ok||!s.d||s.d.length<4){addLog('Seed request failed','error');setBusy('');return;}
    let sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
    addLog('Seed: 0x'+hx(sv,8),'info');
    for(const a of ECM_ALGOS){
      const k=a.fn(sv);
      addLog('Try '+a.n+' key=0x'+hx(k,8)+'...','info');
      const r=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
      if(r.ok&&r.d&&r.d[0]===0x67){
        addLog('✓ UNLOCKED with '+a.n,'rx');setUnlocked(true);setAlgo(a.n);setBusy('');return;
      }
      /* Re-request seed after each failure (some modules lock after N bad attempts) */
      await new Promise(r=>setTimeout(r,300));
      s=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x27,0x01]);
      if(s.ok&&s.d&&s.d.length>=4){sb=Array.from(s.d).slice(-4);sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);}
      else{addLog('Re-seed failed — module may be timed-out','warn');break;}
    }
    addLog('All algorithms failed — ECM may need different platform algo','error');
    setBusy('');
  },[addLog]);

  const writeVin=useCallback(()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(masterVin.length!==17){addLog('Master VIN must be 17 chars','error');return;}
    if(!unlocked){addLog('Unlock ECM first','error');return;}
    setShowConfirmModal(true);
  },[masterVin,unlocked,addLog]);

  const executeWriteVin=useCallback(async(confirmData)=>{
    setShowConfirmModal(false);
    const oldVinSnapshot=curVin;
    setBusy('Writing ECM VIN...');
    setModuleStatus(p=>({...p,ECM:'writing'}));
    addLog('═══ ECM VIN WRITE ═══','info');
    if(confirmData.technician)addLog('Technician: '+confirmData.technician,'info');
    if(confirmData.titleRef)addLog('Title reference: '+confirmData.titleRef,'info');
    /* SAFETY NET: auto-backup module before any write */
    addLog('Creating safety backup before write...','info');
    await backupModule(eng.current.uds,ecmAddr.tx,ecmAddr.rx,'ECM',addLog,hx);
    const vb=Array.from(masterVin).map(c=>c.charCodeAt(0));
    const r=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x2E,0xF1,0x90,...vb]);
    let ok=false;
    if(r.ok&&r.d&&r.d[0]===0x6E){ok=true;addLog('✓ VIN written','rx');}
    else if(r.ok&&r.d&&r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'error');
    else addLog('Write failed','error');
    const vr=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x22,0xF1,0x90]);
    const v=vr.ok?parseVinFromResponse(vr.d):null;
    setCurVin(v);
    const match=v===masterVin;
    addLog(match?'✓ VERIFIED':'✗ VERIFY FAIL: '+(v||'no response'),match?'rx':'warn');
    setModuleStatus(p=>({...p,ECM:(ok&&match)?'ok':'fail'}));
    /* PAPER TRAIL */
    logSession({
      module:'ECM',
      operation:'VIN Write',
      oldVin:oldVinSnapshot,
      newVin:masterVin,
      moduleAddr:{tx:ecmAddr.tx,rx:ecmAddr.rx},
      adapter:eng.current.adapter||'ELM327/STN',
      algorithm:algo,
      success:ok&&match,
      technician:confirmData.technician,
      titleRef:confirmData.titleRef,
      titleNotes:confirmData.titleNotes,
      preWriteConfirmed:confirmData.preWriteConfirmed,
    });
    addLog('📄 Session logged to paper trail','info');
    setBusy('');
  },[masterVin,addLog,setModuleStatus,curVin,algo]);

  const vinValid=masterVin.length===17;
  return<div>
    {showConfirmModal&&<ReadFirstModal
      module="ECM"
      currentState={[
        {label:'Current VIN (DID 0xF190)',value:curVin},
        {label:'Part Number',value:ecmInfo[0xF187]?.ascii},
        {label:'Software Version',value:ecmInfo[0xF189]?.ascii},
        {label:'Calibration ID',value:ecmInfo[0xF195]?.ascii},
        {label:'Module Address',value:'TX 0x'+hx(ecmAddr.tx,3)+' / RX 0x'+hx(ecmAddr.rx,3)},
        {label:'Unlock Algorithm',value:algo||'(not unlocked)'},
      ]}
      newVin={masterVin}
      onConfirm={executeWriteVin}
      onCancel={()=>{setShowConfirmModal(false);addLog('Write cancelled at confirmation step','warn');}}
    />}
    <Card style={{background:'linear-gradient(135deg,#3D2D0A 0%,#8B6B00 40%,#FFB300 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>⚡</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>ECM PROGRAMMER</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>ENGINE CONTROL MODULE · VIN · TUNE</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
          {!conn?'○ DISCONNECTED':unlocked?'● UNLOCKED ('+algo+')':'● CONNECTED'}
        </div>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.wn,marginBottom:10,letterSpacing:2}}>⚡ CONTROLS</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {!conn&&<Btn onClick={connect} color={C.wn}>🔌 Connect</Btn>}
        {conn&&<Btn onClick={readInfo} disabled={!!busy} color={C.a2}>📖 Read ECM Info</Btn>}
        {conn&&<Btn onClick={unlockEcm} disabled={!!busy} color={C.a4}>🔓 Unlock (Auto-Try All)</Btn>}
        {conn&&<Btn onClick={writeVin} disabled={!!busy||!unlocked||!vinValid} color={C.sr}>💾 Write Master VIN</Btn>}
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>
        ECM at TX 0x{hx(ecmAddr.tx,3)} · RX 0x{hx(ecmAddr.rx,3)}
      </div>
    </Card>

    {/* ECM INFO DISPLAY */}
    {Object.keys(ecmInfo).length>0&&<Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.wn,marginBottom:10,letterSpacing:2}}>🔍 ECM DATA</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr',gap:6}}>
        {Object.entries(ecmInfo).map(([did,info])=>(
          <div key={did} style={{padding:8,background:'#F8F6F2',borderRadius:6,fontSize:11}}>
            <div style={{color:C.ts,fontWeight:700}}>{info.label} (DID 0x{hx(parseInt(did),4)})</div>
            <div style={{fontFamily:"'JetBrains Mono'",marginTop:2,color:C.tx,fontWeight:700}}>{info.ascii||info.hex}</div>
          </div>
        ))}
      </div>
    </Card>}

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.wn,marginBottom:10,letterSpacing:2}}>🔑 VIN STATUS</div>
      <div style={{padding:12,background:curVin===masterVin?'#E8F5E9':curVin?'#FFF8F0':'#F8F6F2',borderRadius:8,border:'1px solid '+(curVin===masterVin?C.gn:curVin?C.wn:C.bd)}}>
        <div style={{fontSize:10,color:C.ts,letterSpacing:1,fontWeight:700}}>Current VIN on ECM (DID 0xF190)</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,marginTop:4}}>{curVin||'(not read)'}</div>
        {curVin===masterVin&&<div style={{fontSize:10,color:C.gn,marginTop:4}}>✓ matches Master VIN</div>}
      </div>
    </Card>

    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{fontWeight:800,fontSize:12,color:'#FFB300',marginBottom:10,letterSpacing:2}}>📋 LOG</div>
      <div style={{maxHeight:320,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Ready</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}


/* ═════════════════════════════════════════════════════════════════
   UDS PROGRAMMER — universal raw UDS workshop
   ═════════════════════════════════════════════════════════════════ */
function UdsTab(){
  const[conn,setConn]=useState(false);const[busy,setBusy]=useState('');
  const[log,setLog]=useState([]);
  const[txAddr,setTxAddr]=useState('0x750');const[rxAddr,setRxAddr]=useState('0x758');
  const[rawCmd,setRawCmd]=useState('');const[didHex,setDidHex]=useState('F190');
  const[writeDid,setWriteDid]=useState('F190');const[writeData,setWriteData]=useState('');
  const[session,setSession]=useState('03');
  const[routineCtrl,setRoutineCtrl]=useState('01');const[routineId,setRoutineId]=useState('0312');const[routineData,setRoutineData]=useState('');
  const[selectedModule,setSelectedModule]=useState('BCM');
  const eng=useRef(null);
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-400),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');
  const hexToBytes=s=>{const clean=s.replace(/[^0-9a-fA-F]/g,'');const out=[];for(let i=0;i<clean.length;i+=2)out.push(parseInt(clean.substring(i,i+2),16));return out;};

  const MODULE_PRESETS={
    BCM:{tx:0x750,rx:0x758},RFHUB:{tx:0x75F,rx:0x767},
    ECM:{tx:0x7E0,rx:0x7E8},TCM:{tx:0x7E1,rx:0x7E9},
    ABS:{tx:0x760,rx:0x768},IPC:{tx:0x740,rx:0x748},
    ORC:{tx:0x758,rx:0x760},ADCM:{tx:0x7A8,rx:0x7B0},
    RADIO:{tx:0x772,rx:0x77A},HVAC:{tx:0x751,rx:0x759},
    EPS:{tx:0x761,rx:0x769},SCCM:{tx:0x74D,rx:0x76D},
    TIPM:{tx:0x74C,rx:0x76C},AMP:{tx:0x7A0,rx:0x7A8},
    BSM:{tx:0x770,rx:0x778},TPMS:{tx:0x752,rx:0x75A},
  };

  const loadPreset=(m)=>{
    const p=MODULE_PRESETS[m];if(!p)return;
    setTxAddr('0x'+hx(p.tx,3));setRxAddr('0x'+hx(p.rx,3));setSelectedModule(m);
    addLog('Loaded preset: '+m+' TX:0x'+hx(p.tx,3)+' RX:0x'+hx(p.rx,3),'info');
  };

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(e){eng.current=e;setConn(true);addLog('Connected','info');}
  },[addLog]);

  const parseAddr=(s)=>parseInt(s.replace('0x',''),16);

  const sendRaw=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const bytes=hexToBytes(rawCmd);
    if(!bytes.length){addLog('Enter hex bytes','error');return;}
    setBusy('Sending...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    addLog('Raw: '+bytes.map(b=>hx(b)).join(' ')+' → TX 0x'+hx(tx,3),'info');
    const r=await eng.current.uds(tx,rx,bytes);
    if(r.ok&&r.d){
      if(r.d[0]===0x7F){addLog('NRC: '+decodeNRC(r.d[2]||0),'warn');}
      else addLog('✓ OK','rx');
    }else addLog('No response or error: '+(r.raw||'(timeout)'),'error');
    setBusy('');
  },[txAddr,rxAddr,rawCmd,addLog]);

  const readDid=useCallback(async()=>{
    if(!eng.current)return;
    const did=parseInt(didHex,16);
    setBusy('Reading DID 0x'+hx(did,4)+'...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x22,(did>>8)&0xFF,did&0xFF]);
    if(r.ok&&r.d){
      if(r.d[0]===0x62){
        const data=Array.from(r.d).slice(3);
        const ascii=data.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
        const hexOut=data.map(b=>hx(b)).join(' ');
        addLog('DID 0x'+hx(did,4)+' HEX: '+hexOut,'rx');
        if(ascii.length>=3)addLog('DID 0x'+hx(did,4)+' ASCII: '+ascii,'rx');
      }else if(r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'warn');
    }else addLog('No response','error');
    setBusy('');
  },[didHex,txAddr,rxAddr,addLog]);

  const writeDidAction=useCallback(async()=>{
    if(!eng.current)return;
    const did=parseInt(writeDid,16);
    const data=hexToBytes(writeData);
    if(!data.length){addLog('Enter data bytes','error');return;}
    setBusy('Writing DID 0x'+hx(did,4)+'...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x2E,(did>>8)&0xFF,did&0xFF,...data]);
    if(r.ok&&r.d){
      if(r.d[0]===0x6E)addLog('✓ Written','rx');
      else if(r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'warn');
    }else addLog('No response','error');
    setBusy('');
  },[writeDid,writeData,txAddr,rxAddr,addLog]);

  const startSession=useCallback(async()=>{
    if(!eng.current)return;
    const s=parseInt(session,16);
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x10,s]);
    if(r.ok&&r.d&&r.d[0]===0x50)addLog('✓ Session 0x'+hx(s)+' active','rx');
    else addLog('Session failed','error');
  },[session,txAddr,rxAddr,addLog]);

  const testerPresent=useCallback(async()=>{
    if(!eng.current)return;
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x3E,0x00]);
    if(r.ok&&r.d&&r.d[0]===0x7E)addLog('✓ Module alive','rx');
    else addLog('No TesterPresent response','warn');
  },[txAddr,rxAddr,addLog]);

  const routine=useCallback(async()=>{
    if(!eng.current)return;
    const ctrl=parseInt(routineCtrl,16);
    const rid=parseInt(routineId,16);
    const data=hexToBytes(routineData);
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    setBusy('Routine...');
    const cmd=[0x31,ctrl,(rid>>8)&0xFF,rid&0xFF,...data];
    addLog('Routine: '+cmd.map(b=>hx(b)).join(' '),'info');
    const r=await eng.current.uds(tx,rx,cmd);
    if(r.ok&&r.d){
      if(r.d[0]===0x71)addLog('✓ Routine OK: '+Array.from(r.d).map(b=>hx(b)).join(' '),'rx');
      else if(r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'warn');
    }else addLog('No response','error');
    setBusy('');
  },[routineCtrl,routineId,routineData,txAddr,rxAddr,addLog]);

  const readDtcs=useCallback(async()=>{
    if(!eng.current)return;
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x19,0x02,0x08]);
    if(r.ok&&r.d){
      const d=Array.from(r.d);
      let count=0;
      for(let i=3;i+3<d.length;i+=4){
        const dtc=(d[i]<<16)|(d[i+1]<<8)|d[i+2];if(dtc===0)continue;
        const prefix=['P','C','B','U'][(d[i]>>6)&3];
        const code=prefix+hx((d[i]&0x3F),1)+hx(d[i+1])+hx(d[i+2]);
        addLog('DTC: '+code+' status=0x'+hx(d[i+3])+' ['+decodeDtcStatus(d[i+3])+']','warn');count++;
      }
      if(!count)addLog('✓ No DTCs','rx');
    }
  },[txAddr,rxAddr,addLog]);

  const clearDtcs=useCallback(async()=>{
    if(!eng.current)return;
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x14,0xFF,0xFF,0xFF]);
    if(r.ok&&r.d&&r.d[0]===0x54)addLog('✓ DTCs cleared','rx');
    else addLog('Clear failed','error');
  },[txAddr,rxAddr,addLog]);

  const reset=useCallback(async()=>{
    if(!eng.current)return;
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x11,0x01]);
    if(r.ok&&r.d&&r.d[0]===0x51)addLog('✓ ECU reset','rx');
    else addLog('Reset failed','warn');
  },[txAddr,rxAddr,addLog]);

  return<div>
    <Card style={{background:'linear-gradient(135deg,#0A0A3D 0%,#1E1E6F 40%,#4A00E0 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🔬</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>UDS PROGRAMMER</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>UNIVERSAL · RAW COMMANDS · ANY MODULE</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:conn?'#00C85333':'#FF174433',borderRadius:8,border:'1px solid '+(conn?'#00C853':'#FF1744')}}>
          {conn?'● CONNECTED':'○ DISCONNECTED'}
        </div>
      </div>
    </Card>

    {/* MODULE PRESETS */}
    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>📡 MODULE PRESETS</div>
      <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:10}}>
        {Object.keys(MODULE_PRESETS).map(m=>(
          <button key={m} onClick={()=>loadPreset(m)} style={{padding:'6px 10px',fontSize:10,fontWeight:800,borderRadius:6,border:'1.5px solid '+(selectedModule===m?C.a4:C.bd),background:selectedModule===m?C.a4+'15':'#fff',color:selectedModule===m?C.a4:C.ts,cursor:'pointer'}}>{m}</button>
        ))}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto',gap:10,alignItems:'end'}}>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>TX ADDRESS</div>
          <input value={txAddr} onChange={e=>setTxAddr(e.target.value)} style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>RX ADDRESS</div>
          <input value={rxAddr} onChange={e=>setRxAddr(e.target.value)} style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        {!conn&&<Btn onClick={connect} color={C.a4}>🔌 Connect</Btn>}
      </div>
    </Card>

    {/* RAW COMMAND */}
    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>⚡ RAW UDS COMMAND</div>
      <div style={{display:'flex',gap:10,alignItems:'end'}}>
        <div style={{flex:1}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>HEX BYTES (e.g. 22 F1 90 or 22F190)</div>
          <input value={rawCmd} onChange={e=>setRawCmd(e.target.value)} placeholder="22 F1 90" style={{width:'100%',padding:10,fontFamily:"'JetBrains Mono'",fontSize:14,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <Btn onClick={sendRaw} disabled={!!busy||!conn} color={C.a4}>▶ Send</Btn>
      </div>
    </Card>

    {/* QUICK OPS */}
    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>🎛️ QUICK OPERATIONS</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
        {/* Read DID */}
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:6,fontWeight:700}}>READ DID (0x22)</div>
          <div style={{display:'flex',gap:6}}>
            <input value={didHex} onChange={e=>setDidHex(e.target.value)} placeholder="F190" style={{flex:1,padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
            <Btn onClick={readDid} disabled={!!busy||!conn} color={C.a2}>Read</Btn>
          </div>
        </div>
        {/* Write DID */}
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:6,fontWeight:700}}>WRITE DID (0x2E)</div>
          <div style={{display:'flex',gap:6,marginBottom:6}}>
            <input value={writeDid} onChange={e=>setWriteDid(e.target.value)} placeholder="F190" style={{flex:1,padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
            <Btn onClick={writeDidAction} disabled={!!busy||!conn} color={C.sr}>Write</Btn>
          </div>
          <input value={writeData} onChange={e=>setWriteData(e.target.value)} placeholder="data bytes (hex)" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        {/* Session */}
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:6,fontWeight:700}}>DIAG SESSION (0x10)</div>
          <div style={{display:'flex',gap:6}}>
            <select value={session} onChange={e=>setSession(e.target.value)} style={{flex:1,padding:8,fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}>
              <option value="01">01 - Default</option>
              <option value="02">02 - Programming</option>
              <option value="03">03 - Extended</option>
              <option value="04">04 - Safety</option>
            </select>
            <Btn onClick={startSession} disabled={!!busy||!conn} color={C.a3}>Enter</Btn>
          </div>
        </div>
        {/* Tester Present */}
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:6,fontWeight:700}}>SESSION CONTROL</div>
          <div style={{display:'flex',gap:6}}>
            <Btn onClick={testerPresent} disabled={!!busy||!conn} color={C.gn} outline>🟢 Tester Present</Btn>
            <Btn onClick={reset} disabled={!!busy||!conn} color={C.er} outline>⚡ Reset (11 01)</Btn>
          </div>
        </div>
      </div>
    </Card>

    {/* ROUTINE CONTROL */}
    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>🔧 ROUTINE CONTROL (0x31)</div>
      <div style={{display:'grid',gridTemplateColumns:'auto 1fr 1fr auto',gap:8,alignItems:'end'}}>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>CONTROL</div>
          <select value={routineCtrl} onChange={e=>setRoutineCtrl(e.target.value)} style={{padding:8,fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}>
            <option value="01">01 Start</option>
            <option value="02">02 Stop</option>
            <option value="03">03 Results</option>
          </select>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>ROUTINE ID</div>
          <input value={routineId} onChange={e=>setRoutineId(e.target.value)} placeholder="0312" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>DATA (optional)</div>
          <input value={routineData} onChange={e=>setRoutineData(e.target.value)} placeholder="hex" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <Btn onClick={routine} disabled={!!busy||!conn} color={C.a4}>Execute</Btn>
      </div>
    </Card>

    {/* DTC */}
    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>⚠️ DIAGNOSTICS</div>
      <div style={{display:'flex',gap:8}}>
        <Btn onClick={readDtcs} disabled={!!busy||!conn} color={C.a3} outline>📋 Read DTCs (19 02 08)</Btn>
        <Btn onClick={clearDtcs} disabled={!!busy||!conn} color={C.wn} outline>🗑️ Clear DTCs (14 FF FF FF)</Btn>
      </div>
    </Card>

    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:12,color:'#B388FF',letterSpacing:2}}>📋 LOG</div>
        <button onClick={()=>setLog([])} style={{fontSize:10,color:'#666',background:'transparent',border:'1px solid #333',padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>CLEAR</button>
      </div>
      <div style={{maxHeight:380,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Ready — send a command to begin</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}


/* ═════════════════════════════════════════════════════════════════
   UNIFIED VIN PROGRAMMER — all FCA modules, single tab
   ═════════════════════════════════════════════════════════════════ */

/* Master module map: every FCA module that stores a VIN.
   All use UDS DID 0xF190 for VIN read/write (standard Stellantis pattern).
   Security access algorithm + constant varies per module family.
   Addresses list primary + alternate variants we auto-probe. */
const MODULE_VIN_MAP=[
  {code:'ECM',name:'Engine Control Module',addrs:[{tx:0x7E0,rx:0x7E8}],algo:'shiftXor32',constant:0x8A3C71,iter:3,did:0xF190,otp:false,note:'GPEC2 family, 3 iterations'},
  {code:'TCM',name:'Transmission Control Module',addrs:[{tx:0x7E1,rx:0x7E9}],algo:'shiftXor32',constant:0x6E4B92,iter:5,did:0xF190,otp:true,note:'OTP — write-once. Bench harness or in-car OBD.'},
  {code:'BCM',name:'Body Control Module',addrs:[{tx:0x750,rx:0x758},{tx:0x7B0,rx:0x7B8},{tx:0x7E0,rx:0x7E8},{tx:0x6B0,rx:0x6B8}],algo:'cda6',constant:0x4B129F,iter:5,did:0xF190,otp:false,note:'CDA6-L1, auto-probes 4 address variants'},
  {code:'RFHUB',name:'RF Hub Module',addrs:[{tx:0x75F,rx:0x767},{tx:0x742,rx:0x762},{tx:0x762,rx:0x76A}],algo:'shiftXor32',constant:0xD5F1,iter:5,did:0xF190,otp:false,note:'RH850, 2018+'},
  {code:'ABS',name:'Anti-Lock Brake / ESC',addrs:[{tx:0x760,rx:0x768},{tx:0x740,rx:0x748}],algo:'cda6',constant:0x3F8A21,iter:5,did:0xF190,otp:false},
  {code:'IPC',name:'Instrument Panel Cluster',addrs:[{tx:0x740,rx:0x748},{tx:0x720,rx:0x728}],algo:'cda6',constant:0x4B129F,iter:5,did:0xF190,otp:false},
  {code:'ORC',name:'Occupant Restraint Controller',addrs:[{tx:0x758,rx:0x760},{tx:0x730,rx:0x738}],algo:'cda6',constant:0x4B129F,iter:5,did:0xF190,otp:true,note:'OTP — AIRBAG module, write-once. Extreme caution.'},
  {code:'EPS',name:'Electric Power Steering',addrs:[{tx:0x75F,rx:0x77F},{tx:0x761,rx:0x769}],algo:'cda6',constant:0x4B129F,iter:5,did:0xF190,otp:false},
  {code:'HVAC',name:'HVAC Control',addrs:[{tx:0x751,rx:0x759},{tx:0x743,rx:0x763}],algo:'cda6',constant:0x4B129F,iter:5,did:0xF190,otp:false},
  {code:'SKIM',name:'Sentry Key Immobilizer / WCM',addrs:[{tx:0x744,rx:0x764}],algo:'skimwcm',constant:0x94A6C5D3,iter:1,did:0xF190,otp:false,note:'XOR + ROL13 + MUL'},
  {code:'ADCM',name:'Active Damping Control',addrs:[{tx:0x7A8,rx:0x7B0}],algo:'cda6',constant:0x4B129F,iter:5,did:0xF190,otp:false,note:'SRT/Hellcat adaptive damping'},
  {code:'TPM',name:'Tire Pressure Monitor',addrs:[{tx:0x752,rx:0x75A},{tx:0x747,rx:0x757}],algo:'cda6',constant:0x4B129F,iter:5,did:0xF190,otp:false},
  {code:'DTCM',name:'Transfer Case Module (4WD)',addrs:[{tx:0x7E2,rx:0x7EA}],algo:'shiftXor32',constant:0x6E4B92,iter:5,did:0xF190,otp:false,note:'Trackhawk/AWD'},
  {code:'RDM',name:'Radio / Uconnect',addrs:[{tx:0x754,rx:0x75C},{tx:0x772,rx:0x77A}],algo:'cda6',constant:0x4B129F,iter:5,did:0xF190,otp:false},
];

function VinProgrammerTab(){
  const{vin:masterVin}=React.useContext(MasterVinContext);
  const vinValid=masterVin.length===17&&/^[A-HJ-NPR-Z0-9]{17}$/i.test(masterVin);
  const[selected,setSelected]=useState(new Set());
  const[eng,setEng]=useState(null);
  const[busy,setBusy]=useState('');
  const[log,setLog]=useState([]);
  const[moduleResults,setModuleResults]=useState({});
  const engRef=useRef(null);
  const addLog=useCallback((msg,type='info')=>{setLog(p=>[{t:new Date().toLocaleTimeString(),msg,type},...p.slice(0,200)]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  const connect=useCallback(async()=>{
    setBusy('Connecting...');
    const a=await initAdapter(addLog,hx);
    if(a){engRef.current=a;setEng(a);addLog('✓ Adapter connected','pass');}
    setBusy('');
  },[addLog]);

  const disconnect=useCallback(async()=>{
    if(engRef.current?.disconnect){await engRef.current.disconnect();}
    engRef.current=null;setEng(null);addLog('Disconnected','info');
  },[addLog]);

  /* Toggle selection */
  const toggleMod=useCallback((code)=>{
    setSelected(p=>{const s=new Set(p);if(s.has(code))s.delete(code);else s.add(code);return s;});
  },[]);
  const selectAll=useCallback(()=>{setSelected(new Set(MODULE_VIN_MAP.filter(m=>!m.otp).map(m=>m.code)));},[]);
  const selectNone=useCallback(()=>{setSelected(new Set());},[]);

  /* Compute key using module-specific algorithm */
  const computeKey=useCallback((algo,constant,iter,seed)=>{
    let k=seed>>>0;
    if(algo==='shiftXor32'){
      for(let i=0;i<iter;i++){k=(k&0x80000000)?((k<<1)^constant)>>>0:(k<<1)>>>0;}
      return new Uint8Array([(k>>>24)&0xFF,(k>>>16)&0xFF,(k>>>8)&0xFF,k&0xFF]);
    }
    if(algo==='cda6'){
      k=(k^constant)>>>0;k=((k<<3)|(k>>>29))>>>0;k=(k+0x1234)>>>0;k=(k^0xABCD)>>>0;k=((k>>>5)|(k<<27))>>>0;
      return new Uint8Array([(k>>>24)&0xFF,(k>>>16)&0xFF,(k>>>8)&0xFF,k&0xFF]);
    }
    if(algo==='skimwcm'){
      k=(k^0x94A6C5D3)>>>0;k=((k<<13)|(k>>>19))>>>0;k=Math.imul(k,0x4D)>>>0;k=(k^0x6B8A9C2E)>>>0;
      return new Uint8Array([(k>>>24)&0xFF,(k>>>16)&0xFF,(k>>>8)&0xFF,k&0xFF]);
    }
    return new Uint8Array(4);
  },[]);

  /* Read current VIN from a single module */
  const readOne=useCallback(async(m)=>{
    if(!engRef.current){addLog('Connect first','error');return null;}
    for(const a of m.addrs){
      try{
        const r=await engRef.current.uds(a.tx,a.rx,[0x22,0xF1,0x90]);
        if(r.ok&&r.d?.length>3){
          const vc=Array.from(r.d).filter(b=>b>=0x20&&b<=0x7E);
          const vin=String.fromCharCode(...vc).slice(-17);
          if(vin.length>=10){
            addLog(`${m.code} @ ${hx(a.tx,3)}: ${vin}`,'pass');
            return{addr:a,currentVin:vin};
          }
        }
      }catch(e){}
    }
    addLog(`${m.code}: no response on any address`,'warn');
    return null;
  },[addLog]);

  /* Write VIN to a single module */
  const writeOne=useCallback(async(m,targetVin)=>{
    if(!engRef.current){addLog('Connect first','error');return{ok:false,err:'Not connected'};}
    /* Find live address first */
    let addr=null;
    for(const a of m.addrs){
      try{
        const r=await engRef.current.uds(a.tx,a.rx,[0x22,0xF1,0x90]);
        if(r.ok){addr=a;break;}
      }catch(e){}
    }
    if(!addr){addLog(`${m.code}: not responding`,'error');return{ok:false,err:'Not alive'};}
    /* Extended diagnostic session */
    addLog(`${m.code}: 10 03 (Extended Session)`,'info');
    const sess=await engRef.current.uds(addr.tx,addr.rx,[0x10,0x03]);
    if(!sess.ok){addLog(`${m.code}: session failed`,'error');return{ok:false,err:'Session failed'};}
    /* Security access — request seed */
    addLog(`${m.code}: 27 01 (Request Seed)`,'info');
    const seedResp=await engRef.current.uds(addr.tx,addr.rx,[0x27,0x01]);
    if(!seedResp.ok||!seedResp.d||seedResp.d.length<5){addLog(`${m.code}: seed request failed`,'error');return{ok:false,err:'Seed failed'};}
    /* Seed is bytes 2..5 (after 67 01) */
    const seedBytes=seedResp.d.slice(2,6);
    const seed=((seedBytes[0]<<24)|(seedBytes[1]<<16)|(seedBytes[2]<<8)|seedBytes[3])>>>0;
    addLog(`${m.code}: seed=0x${hx(seed,8)}`,'info');
    /* Compute key */
    const key=computeKey(m.algo,m.constant,m.iter,seed);
    addLog(`${m.code}: key=${Array.from(key).map(b=>hx(b)).join('')}`,'info');
    /* Send key */
    addLog(`${m.code}: 27 02 ${Array.from(key).map(b=>hx(b)).join(' ')} (Send Key)`,'info');
    const keyResp=await engRef.current.uds(addr.tx,addr.rx,[0x27,0x02,...key]);
    if(!keyResp.ok){
      const nrc=keyResp.d?.[2];
      addLog(`${m.code}: security denied ${nrc?`NRC 0x${hx(nrc)} (${decodeNRC(nrc)})`:''}`,'error');
      return{ok:false,err:'Security failed'};
    }
    addLog(`${m.code}: ✓ Security unlocked`,'pass');
    /* Write VIN via WriteDataByIdentifier */
    const vinBytes=new TextEncoder().encode(targetVin);
    const didHi=(m.did>>8)&0xFF,didLo=m.did&0xFF;
    addLog(`${m.code}: 2E ${hx(didHi)} ${hx(didLo)} [${targetVin}]`,'info');
    const writeResp=await engRef.current.uds(addr.tx,addr.rx,[0x2E,didHi,didLo,...vinBytes]);
    if(!writeResp.ok){
      const nrc=writeResp.d?.[2];
      addLog(`${m.code}: write failed ${nrc?`NRC 0x${hx(nrc)}`:''}`,'error');
      return{ok:false,err:'Write failed'};
    }
    addLog(`${m.code}: ✓ VIN written`,'pass');
    /* Verify readback */
    const verify=await engRef.current.uds(addr.tx,addr.rx,[0x22,0xF1,0x90]);
    if(verify.ok&&verify.d){
      const vc=Array.from(verify.d).filter(b=>b>=0x20&&b<=0x7E);
      const vinRead=String.fromCharCode(...vc).slice(-17);
      const match=vinRead===targetVin;
      addLog(`${m.code}: readback ${match?'✓':'✗'} ${vinRead}`,match?'pass':'error');
      return{ok:match,newVin:vinRead};
    }
    return{ok:true,note:'Written, verify skipped'};
  },[addLog,computeKey]);

  /* Scan selected modules to read current VINs */
  const scanSelected=useCallback(async()=>{
    if(!engRef.current){addLog('Connect adapter first','error');return;}
    if(selected.size===0){addLog('Select at least one module','warn');return;}
    setBusy('Scanning...');
    const results={};
    for(const code of selected){
      const m=MODULE_VIN_MAP.find(x=>x.code===code);
      const r=await readOne(m);
      results[code]={module:m,...(r||{currentVin:null})};
    }
    setModuleResults(results);
    setBusy('');
  },[selected,readOne,addLog]);

  /* Program selected modules with master VIN */
  const programSelected=useCallback(async()=>{
    if(!engRef.current){addLog('Connect adapter first','error');return;}
    if(!vinValid){addLog('Enter valid 17-char VIN in header','error');return;}
    if(selected.size===0){addLog('Select at least one module','warn');return;}
    /* Check for OTP modules */
    const otpSelected=[...selected].filter(c=>MODULE_VIN_MAP.find(m=>m.code===c)?.otp);
    if(otpSelected.length>0){
      const confirm=window.confirm(`⚠️ DANGER: The following modules are OTP (one-time programmable):\n\n${otpSelected.join(', ')}\n\nWriting to these is PERMANENT and CANNOT be undone.\nA failed write can BRICK the module.\n\nProceed anyway?`);
      if(!confirm){addLog('Cancelled by user','warn');return;}
    }
    setBusy('Programming...');
    const results={};
    for(const code of selected){
      const m=MODULE_VIN_MAP.find(x=>x.code===code);
      addLog(`━━━ ${m.code} (${m.name}) ━━━`,'info');
      const r=await writeOne(m,masterVin.toUpperCase());
      results[code]={module:m,...r,newVin:r.ok?masterVin.toUpperCase():(moduleResults[code]?.currentVin||null)};
    }
    setModuleResults(p=>({...p,...results}));
    setBusy('');
    const okCount=Object.values(results).filter(r=>r.ok).length;
    addLog(`✓ Complete: ${okCount}/${selected.size} successful`,okCount===selected.size?'pass':'warn');
  },[selected,vinValid,masterVin,writeOne,addLog,moduleResults]);

  return<div style={{display:'flex',flexDirection:'column',gap:22}}>
    {/* Header */}
    <div style={{background:'linear-gradient(135deg,#1A1A1A,#2A2A2A)',borderRadius:16,padding:'22px 26px',color:'#fff'}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:3,color:'#FF5252',marginBottom:6}}>UNIFIED VIN PROGRAMMER</div>
      <div style={{fontSize:24,fontFamily:"'Righteous'",letterSpacing:1}}>All modules · One target VIN</div>
      <div style={{fontSize:12,color:'rgba(255,255,255,0.6)',marginTop:4}}>Write master VIN to any combination of {MODULE_VIN_MAP.length} FCA modules via UDS 0xF190</div>
    </div>

    {/* Adapter connection */}
    <Card>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
        <div style={{fontSize:14,fontWeight:800}}>OBD ADAPTER</div>
        <div style={{fontSize:11,color:eng?C.gn:C.tm,fontWeight:700}}>{eng?'● CONNECTED':'○ DISCONNECTED'}</div>
      </div>
      <div style={{display:'flex',gap:10}}>
        {!eng?<Btn onClick={connect} disabled={busy==='Connecting...'}>{busy==='Connecting...'?'CONNECTING...':'🔌 CONNECT OBD'}</Btn>:<Btn onClick={disconnect} outline>DISCONNECT</Btn>}
      </div>
    </Card>

    {/* Module selection grid */}
    <Card>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:800}}>SELECT MODULES TO PROGRAM</div>
        <div style={{display:'flex',gap:8}}>
          <Btn onClick={selectAll} outline color={C.sr}>ALL (safe)</Btn>
          <Btn onClick={selectNone} outline color={C.tm}>NONE</Btn>
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:10}}>
        {MODULE_VIN_MAP.map(m=>{
          const sel=selected.has(m.code);
          const r=moduleResults[m.code];
          const borderCol=sel?C.sr:m.otp?C.wn:C.bd;
          const bgCol=sel?C.sr+'12':m.otp?C.wn+'08':'#fff';
          return<div key={m.code} onClick={()=>toggleMod(m.code)} style={{border:`2px solid ${borderCol}`,background:bgCol,borderRadius:10,padding:'12px 14px',cursor:'pointer',transition:'all 0.15s',position:'relative'}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
              <input type="checkbox" checked={sel} onChange={()=>{}} style={{margin:0,accentColor:C.sr}}/>
              <div style={{fontSize:13,fontWeight:900,color:C.tx}}>{m.code}</div>
              {m.otp&&<Tag color={C.wn}>OTP</Tag>}
            </div>
            <div style={{fontSize:10,color:C.tm,marginBottom:6,lineHeight:1.4}}>{m.name}</div>
            <div style={{fontSize:9,fontFamily:"'JetBrains Mono'",color:C.tm}}>
              {m.addrs.length} addr · {m.algo}
            </div>
            {r&&r.currentVin&&<div style={{fontSize:10,fontFamily:"'JetBrains Mono'",fontWeight:700,marginTop:6,padding:'4px 6px',background:C.bg,borderRadius:4,color:r.currentVin===masterVin.toUpperCase()?C.gn:C.wn}}>
              {r.currentVin===masterVin.toUpperCase()?'✓':'⚠'} {r.currentVin}
            </div>}
            {r&&r.ok===true&&<div style={{fontSize:10,color:C.gn,fontWeight:800,marginTop:4}}>✓ WRITTEN</div>}
            {r&&r.ok===false&&<div style={{fontSize:10,color:C.er,fontWeight:800,marginTop:4}}>✗ {r.err}</div>}
          </div>;
        })}
      </div>
    </Card>

    {/* Actions */}
    <Card>
      <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>ACTIONS</div>
      <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
        <Btn onClick={scanSelected} disabled={!eng||busy||selected.size===0} outline color={C.bl}>🔍 SCAN SELECTED ({selected.size})</Btn>
        <Btn onClick={programSelected} disabled={!eng||busy||selected.size===0||!vinValid} color={C.sr}>🚀 PROGRAM TO MASTER VIN</Btn>
      </div>
      {!vinValid&&<div style={{fontSize:11,color:C.wn,marginTop:10}}>⚠ Enter valid 17-char VIN in header to enable programming</div>}
      {busy&&<div style={{fontSize:12,color:C.sr,marginTop:10,fontWeight:700}}>⏳ {busy}</div>}
    </Card>

    {/* Live log */}
    <Card>
      <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>LIVE LOG</div>
      <div style={{maxHeight:360,overflowY:'auto',background:'#0F0F0F',color:'#E0E0E0',padding:14,borderRadius:8,fontFamily:"'JetBrains Mono'",fontSize:11,lineHeight:1.5}}>
        {log.length===0?<div style={{color:C.tm}}>Waiting for activity...</div>:log.map((l,i)=>{
          const col={info:'#A0A0A0',pass:'#00E676',error:'#FF5252',warn:'#FFB300',tx:'#64B5F6',rx:'#81C784'}[l.type]||'#E0E0E0';
          return<div key={i} style={{color:col,marginBottom:2}}><span style={{color:'#666',marginRight:8}}>{l.t}</span>{l.msg}</div>;
        })}
      </div>
    </Card>
  </div>;
}

/* ═════════════════════════════════════════════════════════════════
   TOPOLOGY TAB — hierarchical DTC + VIN scanner with real-time status
   ═════════════════════════════════════════════════════════════════ */

function TopologyTab(){
  const{vin:masterVin}=React.useContext(MasterVinContext);
  const[eng,setEng]=useState(null);
  const[busy,setBusy]=useState('');
  const[scanPct,setScanPct]=useState(0);
  const[log,setLog]=useState([]);
  const[moduleData,setModuleData]=useState({});
  const engRef=useRef(null);
  const addLog=useCallback((msg,type='info')=>{setLog(p=>[{t:new Date().toLocaleTimeString(),msg,type},...p.slice(0,200)]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  const connect=useCallback(async()=>{
    setBusy('Connecting...');
    const a=await initAdapter(addLog,hx);
    if(a){engRef.current=a;setEng(a);addLog('✓ Adapter connected','pass');}
    setBusy('');
  },[addLog]);

  /* Organize modules by bus category for topology display */
  const BUS_GROUPS={
    POWERTRAIN:{label:'POWERTRAIN',color:'#FF5252',modules:['ECM','TCM','DTCM']},
    BODY:{label:'BODY',color:'#2979FF',modules:['BCM','IPC','HVAC','RDM','RFHUB']},
    CHASSIS:{label:'CHASSIS',color:'#00BFA5',modules:['ABS','EPS','TPM']},
    SAFETY:{label:'SAFETY',color:'#FFB300',modules:['ORC','SKIM']},
    PERFORMANCE:{label:'SRT PERFORMANCE',color:'#AA00FF',modules:['ADCM']},
  };

  /* Scan all known modules in parallel-ish with VIN + DTC */
  const fullScan=useCallback(async()=>{
    if(!engRef.current){addLog('Connect adapter first','error');return;}
    setBusy('Scanning topology...');
    setModuleData({});
    setScanPct(0);
    const results={};
    const totalMods=MODULE_VIN_MAP.length;
    for(let i=0;i<MODULE_VIN_MAP.length;i++){
      const m=MODULE_VIN_MAP[i];
      let alive=false,vin=null,dtcCount=0,addr=null;
      /* Probe each address */
      for(const a of m.addrs){
        try{
          const vinResp=await engRef.current.uds(a.tx,a.rx,[0x22,0xF1,0x90]);
          if(vinResp.ok){
            alive=true;addr=a;
            if(vinResp.d?.length>3){
              const vc=Array.from(vinResp.d).filter(b=>b>=0x20&&b<=0x7E);
              const v=String.fromCharCode(...vc).slice(-17);
              if(v.length>=10)vin=v;
            }
            /* Read DTCs — 19 02 08 (confirmed DTCs) */
            try{
              const dtcResp=await engRef.current.uds(a.tx,a.rx,[0x19,0x02,0x08]);
              if(dtcResp.ok&&dtcResp.d){
                const d=Array.from(dtcResp.d);
                for(let j=3;j+3<d.length;j+=4){
                  const code=(d[j]<<16)|(d[j+1]<<8)|d[j+2];
                  if(code!==0)dtcCount++;
                }
              }
            }catch(e){}
            break;
          }
        }catch(e){}
      }
      results[m.code]={module:m,alive,vin,dtcCount,addr};
      addLog(`${m.code}: ${alive?(vin?`✓ VIN ${vin}`:'✓ present'):'✗ no response'}${dtcCount?`, ${dtcCount} DTCs`:''}`,alive?(vin?'pass':'info'):'warn');
      setScanPct(Math.round(((i+1)/totalMods)*100));
      setModuleData({...results});
    }
    setBusy('');
  },[addLog]);

  /* Color a module based on state */
  const colorForModule=useCallback((code)=>{
    const r=moduleData[code];
    if(!r)return{bg:'#E0E0E0',text:'#999',border:'#D0D0D0'};
    if(!r.alive)return{bg:'#F5F5F5',text:'#999',border:'#D0D0D0'};
    if(r.dtcCount>0)return{bg:'#FFEBEE',text:'#C62828',border:'#FF5252'};
    if(r.vin){
      const vinMatch=masterVin&&r.vin===masterVin.toUpperCase();
      return{bg:vinMatch?'#E8F5E9':'#E3F2FD',text:vinMatch?'#2E7D32':'#1565C0',border:vinMatch?'#00C853':'#2979FF'};
    }
    return{bg:'#E8F5E9',text:'#2E7D32',border:'#00C853'};
  },[moduleData,masterVin]);

  return<div style={{display:'flex',flexDirection:'column',gap:22}}>
    {/* Header */}
    <div style={{background:'linear-gradient(135deg,#1A1A1A,#2A2A2A)',borderRadius:16,padding:'22px 26px',color:'#fff'}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:3,color:'#FF5252',marginBottom:6}}>VEHICLE TOPOLOGY</div>
      <div style={{fontSize:24,fontFamily:"'Righteous'",letterSpacing:1}}>Live module scan · VIN · DTCs</div>
      <div style={{fontSize:12,color:'rgba(255,255,255,0.6)',marginTop:4}}>Hierarchical diagnostic view of all FCA modules on the bus</div>
    </div>

    {/* Color legend */}
    <Card>
      <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>LEGEND</div>
      <div style={{display:'flex',gap:18,flexWrap:'wrap'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}><div style={{width:18,height:18,borderRadius:4,background:'#E0E0E0',border:'2px solid #D0D0D0'}}/><span style={{fontSize:12}}>Not responding</span></div>
        <div style={{display:'flex',alignItems:'center',gap:8}}><div style={{width:18,height:18,borderRadius:4,background:'#E8F5E9',border:'2px solid #00C853'}}/><span style={{fontSize:12}}>Alive · No DTCs · VIN matches</span></div>
        <div style={{display:'flex',alignItems:'center',gap:8}}><div style={{width:18,height:18,borderRadius:4,background:'#E3F2FD',border:'2px solid #2979FF'}}/><span style={{fontSize:12}}>Alive · Has VIN (mismatch)</span></div>
        <div style={{display:'flex',alignItems:'center',gap:8}}><div style={{width:18,height:18,borderRadius:4,background:'#FFEBEE',border:'2px solid #FF5252'}}/><span style={{fontSize:12}}>Alive · Has DTCs</span></div>
      </div>
    </Card>

    {/* Controls */}
    <Card>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
        <div style={{fontSize:14,fontWeight:800}}>OBD ADAPTER</div>
        <div style={{fontSize:11,color:eng?C.gn:C.tm,fontWeight:700}}>{eng?'● CONNECTED':'○ DISCONNECTED'}</div>
      </div>
      <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
        {!eng?<Btn onClick={connect} disabled={busy==='Connecting...'}>{busy==='Connecting...'?'CONNECTING...':'🔌 CONNECT OBD'}</Btn>:null}
        <Btn onClick={fullScan} disabled={!eng||!!busy} color={C.sr}>🔍 SCAN ALL MODULES</Btn>
      </div>
      {busy&&<div style={{marginTop:12}}>
        <div style={{fontSize:11,color:C.sr,fontWeight:700,marginBottom:6}}>⏳ {busy} · {scanPct}%</div>
        <div style={{height:6,background:C.bg,borderRadius:3,overflow:'hidden'}}>
          <div style={{height:'100%',width:scanPct+'%',background:`linear-gradient(90deg,${C.sr},#FF8A80)`,transition:'width 0.3s'}}/>
        </div>
      </div>}
    </Card>

    {/* Topology — tree layout */}
    <Card>
      <div style={{fontSize:14,fontWeight:800,marginBottom:14}}>TOPOLOGY · {Object.keys(moduleData).filter(k=>moduleData[k].alive).length}/{MODULE_VIN_MAP.length} alive</div>
      {/* Root: OBD Adapter */}
      <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:0}}>
        <div style={{padding:'14px 24px',background:'linear-gradient(135deg,#1A1A1A,#2A2A2A)',color:'#fff',borderRadius:10,fontSize:13,fontWeight:900,letterSpacing:2}}>
          🔌 OBD ADAPTER · CAN-C
        </div>
        {/* Vertical line */}
        <div style={{width:2,height:20,background:C.bd}}/>
        {/* Bus group branches */}
        <div style={{display:'grid',gridTemplateColumns:`repeat(${Object.keys(BUS_GROUPS).length},1fr)`,gap:12,width:'100%',position:'relative'}}>
          {/* Horizontal connector */}
          <div style={{position:'absolute',top:-2,left:'8%',right:'8%',height:2,background:C.bd}}/>
          {Object.entries(BUS_GROUPS).map(([key,group])=>{
            const modules=MODULE_VIN_MAP.filter(m=>group.modules.includes(m.code));
            return<div key={key} style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
              {/* Vertical drop */}
              <div style={{width:2,height:20,background:C.bd}}/>
              {/* Group header */}
              <div style={{padding:'8px 14px',background:group.color,color:'#fff',borderRadius:8,fontSize:10,fontWeight:900,letterSpacing:2,whiteSpace:'nowrap'}}>
                {group.label}
              </div>
              {/* Vertical to modules */}
              <div style={{width:2,height:14,background:C.bd}}/>
              {/* Module boxes */}
              <div style={{display:'flex',flexDirection:'column',gap:8,width:'100%',alignItems:'center'}}>
                {modules.map(m=>{
                  const col=colorForModule(m.code);
                  const r=moduleData[m.code];
                  return<div key={m.code} style={{padding:'10px 12px',background:col.bg,color:col.text,border:`2px solid ${col.border}`,borderRadius:8,fontSize:11,fontWeight:800,minWidth:110,textAlign:'center',transition:'all 0.3s'}}>
                    <div style={{fontSize:12,fontWeight:900}}>{m.code}</div>
                    {r&&<div style={{fontSize:8,fontWeight:700,marginTop:2,opacity:0.8}}>
                      {!r.alive?'NO RESP':r.dtcCount?`${r.dtcCount} DTCs`:r.vin?(masterVin&&r.vin===masterVin.toUpperCase()?'VIN ✓':'VIN ≠'):'OK'}
                    </div>}
                    {r&&r.vin&&<div style={{fontSize:7,fontFamily:"'JetBrains Mono'",marginTop:3,opacity:0.7,wordBreak:'break-all'}}>{r.vin.slice(-6)}</div>}
                  </div>;
                })}
              </div>
            </div>;
          })}
        </div>
      </div>
    </Card>

    {/* Detail table */}
    {Object.keys(moduleData).length>0&&<Card>
      <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>MODULE DETAILS</div>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',fontSize:11,borderCollapse:'collapse'}}>
          <thead>
            <tr style={{background:C.bg,borderBottom:`2px solid ${C.bd}`}}>
              <th style={{textAlign:'left',padding:8}}>Module</th>
              <th style={{textAlign:'left',padding:8}}>Address</th>
              <th style={{textAlign:'left',padding:8}}>Status</th>
              <th style={{textAlign:'left',padding:8}}>VIN</th>
              <th style={{textAlign:'left',padding:8}}>DTCs</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(moduleData).map(([code,r])=>{
              const vinMatch=masterVin&&r.vin===masterVin.toUpperCase();
              return<tr key={code} style={{borderBottom:`1px solid ${C.bd}`}}>
                <td style={{padding:8,fontWeight:700}}>{code}</td>
                <td style={{padding:8,fontFamily:"'JetBrains Mono'",fontSize:10}}>{r.addr?`${hx(r.addr.tx,3)}/${hx(r.addr.rx,3)}`:'—'}</td>
                <td style={{padding:8,color:r.alive?C.gn:C.tm,fontWeight:700}}>{r.alive?'ALIVE':'NO RESP'}</td>
                <td style={{padding:8,fontFamily:"'JetBrains Mono'",fontSize:10,color:vinMatch?C.gn:r.vin?C.wn:C.tm}}>{r.vin||'—'}</td>
                <td style={{padding:8,color:r.dtcCount?C.er:C.tm,fontWeight:700}}>{r.dtcCount||0}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </Card>}

    {/* Live log */}
    <Card>
      <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>SCAN LOG</div>
      <div style={{maxHeight:280,overflowY:'auto',background:'#0F0F0F',color:'#E0E0E0',padding:14,borderRadius:8,fontFamily:"'JetBrains Mono'",fontSize:11,lineHeight:1.5}}>
        {log.length===0?<div style={{color:C.tm}}>Waiting for scan...</div>:log.map((l,i)=>{
          const col={info:'#A0A0A0',pass:'#00E676',error:'#FF5252',warn:'#FFB300'}[l.type]||'#E0E0E0';
          return<div key={i} style={{color:col,marginBottom:2}}><span style={{color:'#666',marginRight:8}}>{l.t}</span>{l.msg}</div>;
        })}
      </div>
    </Card>
  </div>;
}

/* ═════════════════════════════════════════════════════════════════
   PROGRAM ALL — master wizard, runs BCM→RFHUB→ECM→ADCM in sequence
   ═════════════════════════════════════════════════════════════════ */
function ProgramAllTab(){
  const{vin:masterVin,moduleStatus,setPg}=React.useContext(MasterVinContext);
  const vinValid=masterVin.length===17&&/^[A-HJ-NPR-Z0-9]{17}$/i.test(masterVin);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');
  const[verifyBusy,setVerifyBusy]=useState(false);
  const[verifyResults,setVerifyResults]=useState(null);
  const[verifyLog,setVerifyLog]=useState([]);
  const vlog=(m,t='info')=>setVerifyLog(p=>[...p.slice(-100),{t:new Date().toLocaleTimeString(),m,type:t}]);

  /* Cross-module VIN verification — reads VIN from all 4 modules in one pass
     Runs full adapter init, probes each module, compares all VINs */
  const verifyAllVins=useCallback(async()=>{
    setVerifyBusy(true);
    setVerifyResults(null);
    setVerifyLog([]);
    vlog('═══ CROSS-MODULE VIN VERIFICATION ═══','info');
    const eng=await initAdapter(vlog,hx);
    if(!eng){setVerifyBusy(false);return;}
    const targets=[
      {key:'BCM',name:'Body Control',tx:0x750,rx:0x758,color:C.sr},
      {key:'RFHUB',name:'RF Hub',tx:0x75F,rx:0x767,color:C.a2},
      {key:'ECM',name:'Engine',tx:0x7E0,rx:0x7E8,color:C.wn},
      {key:'ADCM',name:'Active Damping',tx:0x7A8,rx:0x7B0,color:C.a3},
    ];
    const results={};
    for(const t of targets){
      vlog('Reading '+t.key+' at TX:0x'+hx(t.tx,3)+'...','info');
      /* Enter extended session */
      await eng.uds(t.tx,t.rx,[0x10,0x03]);
      /* Read VIN */
      const r=await eng.uds(t.tx,t.rx,[0x22,0xF1,0x90]);
      if(r.ok&&r.d&&r.d[0]===0x62){
        const vin=parseVinFromResponse(r.d);
        results[t.key]={vin,ok:!!vin,match:vin===masterVin,tx:t.tx,rx:t.rx,name:t.name,color:t.color};
        vlog(t.key+': '+(vin||'(empty)')+(vin===masterVin?' ✓ MATCH':vin?' ✗ MISMATCH':' ✗ NO VIN'),vin===masterVin?'rx':'warn');
      }else{
        results[t.key]={vin:null,ok:false,match:false,error:r.raw||'no response',tx:t.tx,rx:t.rx,name:t.name,color:t.color};
        vlog(t.key+': ✗ NO RESPONSE','error');
      }
    }
    const allMatch=Object.values(results).every(r=>r.match);
    vlog(allMatch?'═══ ALL VINs MATCH ═══':'═══ MISMATCH DETECTED ═══',allMatch?'rx':'error');
    setVerifyResults(results);
    setVerifyBusy(false);
  },[masterVin]);

  const steps=[
    {order:1,key:'BCM',icon:'🧠',name:'Body Control Module',color:C.sr,addr:'0x750/0x758',algo:'CDA6',tab:'bcm',
     ops:['VIN write (F190, 7B90, 7B88)','CRC16-CCITT auto-calc','Feature unlock available']},
    {order:2,key:'RFHUB',icon:'🔑',name:'RF Hub Module',color:C.a2,addr:'0x75F/0x767',algo:'SBEC',tab:'rfhub',
     ops:['VIN write (F190)','VIN-specific CRC','Key fob programming (0x0401-0x0404)']},
    {order:3,key:'ECM',icon:'⚡',name:'Engine Control Module',color:C.wn,addr:'0x7E0/0x7E8',algo:'Auto (10 algos)',tab:'ecm',
     ops:['VIN write (F190)','Read ECU info','10 security algos auto-try']},
    {order:4,key:'ADCM',icon:'🏎️',name:'Active Damping Module',color:C.a3,addr:'0x7A8/0x7B0',algo:'Routine 0x0312',tab:'adcm',
     ops:['VIN write (F190, 7B90, 7B88)','Variant config','Routine unlock']},
  ];

  const crc=vinValid?crc16ccitt(Array.from(masterVin.slice(-8)).map(c=>c.charCodeAt(0))):0;

  return<div>
    {/* HERO */}
    <Card style={{background:'linear-gradient(135deg,#0A0A0A 0%,#2D2D2D 40%,#D32F2F 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:12}}>
        <div style={{fontSize:40}}>🚀</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:28,letterSpacing:2}}>PROGRAM ALL</div>
          <div style={{fontSize:11,opacity:.7,letterSpacing:3,fontWeight:700}}>BENCH MASTER · BCM → RFHUB → ECM → ADCM</div>
        </div>
      </div>
      <div style={{fontSize:13,opacity:.9,lineHeight:1.6}}>
        Program all 4 bench modules to match the Master VIN. This is a guided workflow —
        step through each tab in order. Each tab's status bar updates automatically.
      </div>
    </Card>

    {/* MASTER VIN STATUS */}
    {!vinValid?<Card style={{marginBottom:18,background:'#FFF3E0',border:'2px solid '+C.wn}}>
      <div style={{fontSize:14,fontWeight:800,color:C.wn}}>⚠ No Master VIN Set</div>
      <div style={{fontSize:12,color:C.ts,marginTop:6}}>Enter a 17-character VIN in the top-right input before starting.</div>
    </Card>:<Card style={{marginBottom:18,background:'linear-gradient(135deg,#E8F5E9 0%,#C8E6C9 100%)',border:'2px solid '+C.gn}}>
      <div style={{display:'grid',gridTemplateColumns:'1fr auto',gap:14,alignItems:'center'}}>
        <div>
          <div style={{fontSize:11,fontWeight:800,color:C.gn,letterSpacing:2,marginBottom:4}}>✓ MASTER VIN LOCKED</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:22,fontWeight:800,letterSpacing:2,color:C.tx}}>{masterVin}</div>
          <div style={{fontSize:11,color:C.ts,marginTop:4,fontFamily:"'JetBrains Mono'"}}>
            Short VIN: <b>{masterVin.slice(-8)}</b> · CRC16-CCITT: <b>0x{hx(crc,4)}</b>
          </div>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:10,color:C.ts,letterSpacing:1,marginBottom:4}}>ALL 4 MODULES</div>
          <div style={{fontSize:32,fontWeight:900,color:C.gn}}>{['BCM','RFHUB','ECM','ADCM'].filter(k=>moduleStatus[k]==='ok').length}/4</div>
          <div style={{fontSize:10,color:C.ts}}>programmed</div>
        </div>
      </div>
    </Card>}

    {/* CROSS-MODULE VIN VERIFICATION */}
    <Card style={{marginBottom:14,background:verifyResults&&Object.values(verifyResults).every(r=>r.match)?'linear-gradient(135deg,#E8F5E9 0%,#C8E6C9 100%)':'#FAFAFA'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div>
          <div style={{fontWeight:800,fontSize:13,color:C.tx,letterSpacing:1}}>🔍 CROSS-MODULE VIN VERIFICATION</div>
          <div style={{fontSize:10,color:C.ts,marginTop:4}}>Read VIN from all 4 modules at once, compare against Master VIN</div>
        </div>
        <Btn onClick={verifyAllVins} disabled={verifyBusy||!vinValid} color={C.a3}>
          {verifyBusy?'⏳ Verifying...':'▶ Verify All 4 Modules'}
        </Btn>
      </div>
      {verifyResults&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8,marginBottom:12}}>
        {Object.entries(verifyResults).map(([key,r])=>{
          const bg=r.match?'#E8F5E9':r.vin?'#FFEBEE':'#F5F5F5';
          const border=r.match?C.gn:r.vin?C.er:C.bd;
          const icon=r.match?'✓':r.vin?'✗':'○';
          const iconColor=r.match?C.gn:r.vin?C.er:C.tm;
          return<div key={key} style={{padding:10,background:bg,borderRadius:8,border:'2px solid '+border}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{fontWeight:800,fontSize:12,color:r.color}}>{key}</div>
              <div style={{fontSize:16,color:iconColor,fontWeight:900}}>{icon}</div>
            </div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:9,color:r.vin?(r.match?C.gn:C.er):C.tm,marginTop:4,wordBreak:'break-all'}}>
              {r.vin||(r.error||'no data')}
            </div>
          </div>;
        })}
      </div>}
      {verifyLog.length>0&&<div style={{background:'#0D0D15',color:'#E0E0E0',borderRadius:6,padding:10,maxHeight:150,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.5}}>
        {verifyLog.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>}
    </Card>

    {/* WORKFLOW STEPS */}
    <div style={{marginBottom:14,fontSize:13,fontWeight:800,color:C.ts,letterSpacing:2}}>BENCH WORKFLOW</div>
    {steps.map(s=>{
      const st=moduleStatus[s.key]||'pending';
      const stColor={pending:C.tm,writing:C.wn,ok:C.gn,fail:C.er}[st];
      const stLabel={pending:'PENDING',writing:'WRITING...',ok:'✓ COMPLETE',fail:'✗ FAILED'}[st];
      return<Card key={s.key} style={{marginBottom:12,borderLeft:'5px solid '+s.color,padding:0,overflow:'hidden'}}>
        <div style={{padding:'16px 20px',display:'grid',gridTemplateColumns:'auto 1fr auto auto',gap:16,alignItems:'center'}}>
          <div style={{width:40,height:40,borderRadius:10,background:s.color+'20',display:'flex',alignItems:'center',justifyContent:'center',fontSize:22}}>{s.icon}</div>
          <div>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{fontSize:10,fontFamily:"'JetBrains Mono'",color:C.tm,fontWeight:800}}>STEP {s.order}</div>
              <div style={{fontFamily:"'Righteous'",fontSize:18,color:s.color}}>{s.key}</div>
              <div style={{fontSize:11,color:C.ts}}>— {s.name}</div>
            </div>
            <div style={{display:'flex',gap:12,marginTop:4,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>
              <span>📡 {s.addr}</span>
              <span>🔐 {s.algo}</span>
            </div>
            <div style={{marginTop:8}}>
              {s.ops.map((o,i)=><div key={i} style={{fontSize:11,color:C.ts,marginTop:2}}>• {o}</div>)}
            </div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{padding:'4px 12px',borderRadius:6,fontSize:10,fontWeight:800,letterSpacing:1,background:stColor+'20',color:stColor,border:'1px solid '+stColor+'44'}}>{stLabel}</div>
          </div>
          <Btn onClick={()=>setPg(s.tab)} color={s.color}>
            Open {s.key} →
          </Btn>
        </div>
      </Card>;
    })}

    {/* TIPS */}
    <Card style={{marginTop:18,background:'#F0F8FF',border:'1px solid #B0D4F0'}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a3,marginBottom:10,letterSpacing:2}}>💡 BENCH TIPS</div>
      <div style={{fontSize:12,color:C.ts,lineHeight:1.8}}>
        <div>• <b>Always BCM first</b> — it's the master and other modules check against its VIN</div>
        <div>• <b>Keep ignition ON</b> during the entire session — sleeping modules = session timeout</div>
        <div>• <b>Single harness</b> means you only need to connect the adapter once per module tab</div>
        <div>• <b>Read before write</b> — always read current VIN first to confirm comms</div>
        <div>• <b>Test Connection button</b> in each tab does a 3-point sanity check safely</div>
        <div>• <b>If unlock fails</b>, ignition cycle the bench (off 10sec, on) and retry</div>
      </div>
    </Card>
  </div>;
}


/* ═════════════════════════════════════════════════════════════════
   BACKUPS TAB — view/restore module backups
   ═════════════════════════════════════════════════════════════════ */
function BackupsTab(){
  const[backups,setBackups]=useState(getBackupList());
  const[selected,setSelected]=useState(null);
  const[selectedData,setSelectedData]=useState(null);
  const[filter,setFilter]=useState('all');
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  const refresh=useCallback(()=>{
    setBackups(getBackupList());
  },[]);

  const loadBackup=useCallback((key)=>{
    setSelected(key);
    setSelectedData(getBackup(key));
  },[]);

  const deleteBackup=useCallback((key)=>{
    if(!window.confirm('Delete this backup? Cannot be undone.'))return;
    localStorage.removeItem(key);
    const idx=JSON.parse(localStorage.getItem('srtlab_backup_index')||'[]');
    localStorage.setItem('srtlab_backup_index',JSON.stringify(idx.filter(b=>b.key!==key)));
    if(selected===key){setSelected(null);setSelectedData(null);}
    refresh();
  },[selected,refresh]);

  const downloadBackup=useCallback((key)=>{
    const data=getBackup(key);if(!data)return;
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download='srtlab_backup_'+data.module+'_'+(data.dids[0xF190]?.ascii?.slice(-17)||'unknown')+'.json';
    a.click();
    URL.revokeObjectURL(url);
  },[]);

  const clearAll=useCallback(()=>{
    if(!window.confirm('Delete ALL '+backups.length+' backups? Cannot be undone.'))return;
    backups.forEach(b=>localStorage.removeItem(b.key));
    localStorage.removeItem('srtlab_backup_index');
    setSelected(null);setSelectedData(null);
    refresh();
  },[backups,refresh]);

  const filtered=filter==='all'?backups:backups.filter(b=>b.module===filter);
  const moduleCounts={};
  backups.forEach(b=>{moduleCounts[b.module]=(moduleCounts[b.module]||0)+1;});

  return<div>
    <Card style={{background:'linear-gradient(135deg,#0A3D1A 0%,#1E6F3A 40%,#00BFA5 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>💾</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>MODULE BACKUPS</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>PRE-WRITE SNAPSHOTS · ONE-CLICK RESTORE</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:'rgba(255,255,255,0.15)',borderRadius:8}}>
          {backups.length} backup{backups.length===1?'':'s'}
        </div>
      </div>
      <div style={{fontSize:12,opacity:.85,marginTop:10}}>
        Every write operation automatically creates a snapshot of all critical DIDs.
        If a write goes wrong, restore from here. Max 50 backups kept (auto-rotates).
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:800,color:C.ts,letterSpacing:2}}>FILTER:</div>
        <button onClick={()=>setFilter('all')} style={{padding:'6px 12px',fontSize:11,fontWeight:800,borderRadius:6,border:'1.5px solid '+(filter==='all'?C.a2:C.bd),background:filter==='all'?C.a2+'15':'#fff',color:filter==='all'?C.a2:C.ts,cursor:'pointer'}}>All ({backups.length})</button>
        {Object.entries(moduleCounts).map(([m,n])=>(
          <button key={m} onClick={()=>setFilter(m)} style={{padding:'6px 12px',fontSize:11,fontWeight:800,borderRadius:6,border:'1.5px solid '+(filter===m?C.a2:C.bd),background:filter===m?C.a2+'15':'#fff',color:filter===m?C.a2:C.ts,cursor:'pointer'}}>{m} ({n})</button>
        ))}
        <div style={{marginLeft:'auto',display:'flex',gap:8}}>
          <Btn onClick={refresh} color={C.a3} outline>🔄 Refresh</Btn>
          {backups.length>0&&<Btn onClick={clearAll} color={C.er} outline>🗑️ Clear All</Btn>}
        </div>
      </div>
    </Card>

    {backups.length===0?<Card style={{textAlign:'center',padding:40,color:C.tm}}>
      <div style={{fontSize:40,marginBottom:10}}>📭</div>
      <div style={{fontSize:14,fontWeight:700,color:C.ts}}>No backups yet</div>
      <div style={{fontSize:11,marginTop:6}}>Backups are created automatically every time you write to a module.</div>
    </Card>:<div style={{display:'grid',gridTemplateColumns:'1fr 1.5fr',gap:14}}>
      {/* BACKUP LIST */}
      <Card style={{padding:0,overflow:'hidden'}}>
        <div style={{padding:'12px 16px',background:'#F8F6F2',fontSize:11,fontWeight:800,color:C.ts,letterSpacing:2,borderBottom:'1px solid '+C.bd}}>
          BACKUP HISTORY ({filtered.length})
        </div>
        <div style={{maxHeight:600,overflowY:'auto'}}>
          {filtered.map(b=>{
            const isSel=selected===b.key;
            const date=new Date(b.timestamp);
            return<div key={b.key} onClick={()=>loadBackup(b.key)} style={{padding:'12px 16px',borderBottom:'1px solid '+C.bd,cursor:'pointer',background:isSel?C.a2+'10':'#fff',borderLeft:'3px solid '+(isSel?C.a2:'transparent'),transition:'all 0.15s'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{fontWeight:800,fontSize:13,color:isSel?C.a2:C.tx}}>{b.module}</div>
                <div style={{fontSize:9,color:C.tm,fontFamily:"'JetBrains Mono'"}}>{b.didCount} DIDs</div>
              </div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.ts,marginTop:3}}>{b.vin}</div>
              <div style={{fontSize:10,color:C.tm,marginTop:3}}>{date.toLocaleString()}</div>
            </div>;
          })}
        </div>
      </Card>

      {/* BACKUP DETAILS */}
      {selectedData?<Card style={{padding:0,overflow:'hidden'}}>
        <div style={{padding:'12px 16px',background:'linear-gradient(90deg,#0A3D1A,#1E6F3A)',color:'#fff',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{fontSize:10,opacity:.7,letterSpacing:2,fontWeight:700}}>BACKUP DETAILS</div>
            <div style={{fontFamily:"'Righteous'",fontSize:16,letterSpacing:1}}>{selectedData.module}</div>
          </div>
          <div style={{display:'flex',gap:6}}>
            <button onClick={()=>downloadBackup(selected)} style={{padding:'6px 12px',fontSize:11,fontWeight:800,borderRadius:6,border:'1px solid rgba(255,255,255,0.3)',background:'rgba(255,255,255,0.1)',color:'#fff',cursor:'pointer'}}>⬇ Download</button>
            <button onClick={()=>deleteBackup(selected)} style={{padding:'6px 12px',fontSize:11,fontWeight:800,borderRadius:6,border:'1px solid #FF525255',background:'#FF525222',color:'#fff',cursor:'pointer'}}>🗑 Delete</button>
          </div>
        </div>
        <div style={{padding:16}}>
          <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'6px 12px',fontSize:11,marginBottom:16}}>
            <span style={{color:C.ts}}>Created:</span><span style={{fontFamily:"'JetBrains Mono'"}}>{new Date(selectedData.timestamp).toLocaleString()}</span>
            <span style={{color:C.ts}}>TX / RX:</span><span style={{fontFamily:"'JetBrains Mono'"}}>0x{hx(selectedData.tx,3)} / 0x{hx(selectedData.rx,3)}</span>
            <span style={{color:C.ts}}>DIDs captured:</span><span style={{fontFamily:"'JetBrains Mono'",fontWeight:700}}>{Object.keys(selectedData.dids).length}</span>
          </div>

          <div style={{padding:10,background:'#FFF8F0',border:'1px solid '+C.wn,borderRadius:6,fontSize:11,color:C.ts,marginBottom:14,lineHeight:1.5}}>
            <b>⚠ Restore is manual for safety:</b> To restore, go to the module's tab, connect,
            unlock, then use the UDS Programmer tab to write back each DID shown below.
            Automated restore requires a separate "Restore" button we can add later.
          </div>

          <div style={{fontSize:10,fontWeight:800,color:C.ts,letterSpacing:2,marginBottom:8}}>DID SNAPSHOT</div>
          <div style={{maxHeight:380,overflowY:'auto'}}>
            {Object.entries(selectedData.dids).map(([did,data])=>(
              <div key={did} style={{padding:'8px 10px',borderBottom:'1px solid '+C.bd,background:data.critical?'#FFF8F0':'#FAFAFA'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div style={{fontSize:11,fontWeight:800,color:data.critical?C.sr:C.tx}}>
                    {data.critical&&'🔴 '}0x{hx(parseInt(did),4)} · {data.name}
                  </div>
                  {data.missing&&<div style={{fontSize:9,color:C.er,fontWeight:700}}>NOT READABLE</div>}
                </div>
                {data.ascii&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a2,marginTop:3,fontWeight:700}}>"{data.ascii}"</div>}
                {data.hex&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm,marginTop:2,wordBreak:'break-all'}}>{data.hex}</div>}
              </div>
            ))}
          </div>
        </div>
      </Card>:<Card style={{textAlign:'center',padding:40,color:C.tm}}>
        <div style={{fontSize:40,marginBottom:10}}>👈</div>
        <div style={{fontSize:13,fontWeight:700,color:C.ts}}>Select a backup to view details</div>
      </Card>}
    </div>}
  </div>;
}


/* ═════════════════════════════════════════════════════════════════
   SESSIONS TAB — paper trail viewer + report generator
   ═════════════════════════════════════════════════════════════════ */
function SessionsTab(){
  const[sessions,setSessions]=useState(getSessions());
  const[selected,setSelected]=useState(null);
  const[filter,setFilter]=useState('all');
  const[shopInfo,setShopInfo]=useState(()=>{
    try{return JSON.parse(localStorage.getItem('srtlab_shopinfo')||'{}');}
    catch{return{};}
  });
  const[editingShop,setEditingShop]=useState(false);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  const refresh=useCallback(()=>setSessions(getSessions()),[]);

  const handleDelete=useCallback((id)=>{
    if(!window.confirm('Delete this session record? This removes it from your paper trail.'))return;
    deleteSession(id);
    if(selected===id)setSelected(null);
    refresh();
  },[selected,refresh]);

  const saveShopInfo=useCallback(()=>{
    localStorage.setItem('srtlab_shopinfo',JSON.stringify(shopInfo));
    setEditingShop(false);
  },[shopInfo]);

  const generateReport=useCallback((sessionsToInclude)=>{
    const html=generateSessionReport(sessionsToInclude,shopInfo);
    const blob=new Blob([html],{type:'text/html'});
    const url=URL.createObjectURL(blob);
    const w=window.open(url,'_blank');
    if(w){setTimeout(()=>w.print(),500);}
    else{
      /* Popup blocked - offer download */
      const a=document.createElement('a');
      a.href=url;
      a.download='srtlab_report_'+new Date().toISOString().slice(0,10)+'.html';
      a.click();
    }
  },[shopInfo]);

  const exportJson=useCallback((sessionsToInclude)=>{
    const blob=new Blob([JSON.stringify({generated:new Date().toISOString(),shopInfo,sessions:sessionsToInclude},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download='srtlab_sessions_'+new Date().toISOString().slice(0,10)+'.json';
    a.click();
    URL.revokeObjectURL(url);
  },[shopInfo]);

  const filtered=filter==='all'?sessions:sessions.filter(s=>s.module===filter);
  const moduleCounts={};
  sessions.forEach(s=>{moduleCounts[s.module]=(moduleCounts[s.module]||0)+1;});
  const successCount=filtered.filter(s=>s.success).length;
  const failCount=filtered.length-successCount;

  const selectedSession=selected?sessions.find(s=>s.id===selected):null;

  return<div>
    <Card style={{background:'linear-gradient(135deg,#1A0A3D 0%,#3A1E6F 40%,#8E24AA 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>📋</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>SESSION PAPER TRAIL</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>PROGRAMMING HISTORY · PRINTABLE REPORTS · RECORDS</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:'rgba(255,255,255,0.15)',borderRadius:8}}>
          {sessions.length} session{sessions.length===1?'':'s'}
        </div>
      </div>
      <div style={{fontSize:12,opacity:.85,marginTop:10}}>
        Complete log of every programming operation. Each record includes VIN before/after,
        title reference, technician name, timestamp, and write results. Export as HTML report
        for printing or as JSON for archiving. Keeps the last 500 sessions.
      </div>
    </Card>

    {/* SHOP INFO CARD */}
    <Card style={{marginBottom:14}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a4,letterSpacing:2}}>🏢 SHOP INFORMATION (appears on reports)</div>
        {!editingShop&&<button onClick={()=>setEditingShop(true)} style={{fontSize:11,padding:'6px 12px',background:C.a4+'15',color:C.a4,border:'1px solid '+C.a4,borderRadius:6,fontWeight:700,cursor:'pointer'}}>✏️ Edit</button>}
      </div>
      {editingShop?<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4,fontWeight:700}}>SHOP NAME</div>
          <input value={shopInfo.shopName||''} onChange={e=>setShopInfo({...shopInfo,shopName:e.target.value})} style={{width:'100%',padding:8,border:'1px solid '+C.bd,borderRadius:6,fontSize:13}}/>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4,fontWeight:700}}>DEALER LICENSE #</div>
          <input value={shopInfo.license||''} onChange={e=>setShopInfo({...shopInfo,license:e.target.value})} style={{width:'100%',padding:8,border:'1px solid '+C.bd,borderRadius:6,fontSize:13,fontFamily:"'JetBrains Mono'"}}/>
        </div>
        <div style={{gridColumn:'1 / 3'}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:4,fontWeight:700}}>ADDRESS</div>
          <input value={shopInfo.address||''} onChange={e=>setShopInfo({...shopInfo,address:e.target.value})} style={{width:'100%',padding:8,border:'1px solid '+C.bd,borderRadius:6,fontSize:13}}/>
        </div>
        <div style={{gridColumn:'1 / 3',display:'flex',gap:8}}>
          <Btn onClick={saveShopInfo} color={C.gn}>💾 Save</Btn>
          <Btn onClick={()=>setEditingShop(false)} color={C.tm} outline>Cancel</Btn>
        </div>
      </div>:<div style={{fontSize:13,color:C.tx,lineHeight:1.6}}>
        {shopInfo.shopName?<div style={{fontWeight:700}}>{shopInfo.shopName}</div>:<div style={{color:C.tm,fontStyle:'italic'}}>No shop name set — click Edit to add</div>}
        {shopInfo.address&&<div style={{fontSize:11,color:C.ts}}>{shopInfo.address}</div>}
        {shopInfo.license&&<div style={{fontSize:11,color:C.ts,fontFamily:"'JetBrains Mono'"}}>License: {shopInfo.license}</div>}
      </div>}
    </Card>

    {/* STATS + FILTERS */}
    <Card style={{marginBottom:14}}>
      <div style={{display:'flex',gap:16,marginBottom:14}}>
        <div style={{flex:1,padding:14,background:'#E8F5E9',borderRadius:8,textAlign:'center'}}>
          <div style={{fontSize:24,fontWeight:900,color:C.gn}}>{successCount}</div>
          <div style={{fontSize:10,color:C.ts,fontWeight:700,letterSpacing:1}}>SUCCESSFUL</div>
        </div>
        <div style={{flex:1,padding:14,background:'#FFEBEE',borderRadius:8,textAlign:'center'}}>
          <div style={{fontSize:24,fontWeight:900,color:C.er}}>{failCount}</div>
          <div style={{fontSize:10,color:C.ts,fontWeight:700,letterSpacing:1}}>FAILED</div>
        </div>
        <div style={{flex:1,padding:14,background:'#F0F8FF',borderRadius:8,textAlign:'center'}}>
          <div style={{fontSize:24,fontWeight:900,color:C.a3}}>{filtered.length}</div>
          <div style={{fontSize:10,color:C.ts,fontWeight:700,letterSpacing:1}}>SHOWN</div>
        </div>
        <div style={{flex:1,padding:14,background:'#F8F6F2',borderRadius:8,textAlign:'center'}}>
          <div style={{fontSize:24,fontWeight:900,color:C.tx}}>{sessions.length}</div>
          <div style={{fontSize:10,color:C.ts,fontWeight:700,letterSpacing:1}}>TOTAL</div>
        </div>
      </div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
        <div style={{fontSize:11,fontWeight:800,color:C.ts,letterSpacing:2}}>FILTER:</div>
        <button onClick={()=>setFilter('all')} style={{padding:'6px 12px',fontSize:11,fontWeight:800,borderRadius:6,border:'1.5px solid '+(filter==='all'?C.a4:C.bd),background:filter==='all'?C.a4+'15':'#fff',color:filter==='all'?C.a4:C.ts,cursor:'pointer'}}>All ({sessions.length})</button>
        {Object.entries(moduleCounts).map(([m,n])=>(
          <button key={m} onClick={()=>setFilter(m)} style={{padding:'6px 12px',fontSize:11,fontWeight:800,borderRadius:6,border:'1.5px solid '+(filter===m?C.a4:C.bd),background:filter===m?C.a4+'15':'#fff',color:filter===m?C.a4:C.ts,cursor:'pointer'}}>{m} ({n})</button>
        ))}
        <div style={{marginLeft:'auto',display:'flex',gap:8}}>
          {filtered.length>0&&<>
            <Btn onClick={()=>generateReport(filtered)} color={C.gn}>📄 Print Report ({filtered.length})</Btn>
            <Btn onClick={()=>exportJson(filtered)} color={C.a2} outline>⬇ Export JSON</Btn>
          </>}
          <Btn onClick={refresh} color={C.a3} outline>🔄 Refresh</Btn>
        </div>
      </div>
    </Card>

    {/* SESSIONS LIST + DETAIL */}
    {sessions.length===0?<Card style={{textAlign:'center',padding:40,color:C.tm}}>
      <div style={{fontSize:40,marginBottom:10}}>📭</div>
      <div style={{fontSize:14,fontWeight:700,color:C.ts}}>No sessions yet</div>
      <div style={{fontSize:11,marginTop:6}}>Programming operations will appear here automatically after each write.</div>
    </Card>:<div style={{display:'grid',gridTemplateColumns:'1fr 1.5fr',gap:14}}>
      <Card style={{padding:0,overflow:'hidden'}}>
        <div style={{padding:'12px 16px',background:'#F8F6F2',fontSize:11,fontWeight:800,color:C.ts,letterSpacing:2,borderBottom:'1px solid '+C.bd}}>
          SESSIONS ({filtered.length})
        </div>
        <div style={{maxHeight:600,overflowY:'auto'}}>
          {filtered.map(s=>{
            const isSel=selected===s.id;
            const date=new Date(s.timestamp);
            return<div key={s.id} onClick={()=>setSelected(s.id)} style={{padding:'12px 16px',borderBottom:'1px solid '+C.bd,cursor:'pointer',background:isSel?C.a4+'10':'#fff',borderLeft:'3px solid '+(isSel?C.a4:s.success?C.gn:C.er),transition:'all 0.15s'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{fontWeight:800,fontSize:13,color:isSel?C.a4:C.tx}}>{s.module}</div>
                <div style={{fontSize:10,padding:'2px 6px',borderRadius:4,fontWeight:800,background:s.success?'#E8F5E9':'#FFEBEE',color:s.success?C.gn:C.er}}>{s.success?'✓ OK':'✗ FAIL'}</div>
              </div>
              <div style={{fontSize:10,color:C.ts,marginTop:3}}>{s.operation||'Write'}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.tx,marginTop:3}}>{s.newVin||'—'}</div>
              {s.titleRef&&<div style={{fontSize:10,color:C.a3,marginTop:3}}>📄 {s.titleRef}</div>}
              <div style={{fontSize:10,color:C.tm,marginTop:3}}>{date.toLocaleString()}</div>
            </div>;
          })}
        </div>
      </Card>

      {selectedSession?<Card style={{padding:0,overflow:'hidden'}}>
        <div style={{padding:'12px 16px',background:'linear-gradient(90deg,#1A0A3D,#3A1E6F)',color:'#fff',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{fontSize:10,opacity:.7,letterSpacing:2,fontWeight:700}}>SESSION DETAIL</div>
            <div style={{fontFamily:"'Righteous'",fontSize:16,letterSpacing:1}}>{selectedSession.module} — {selectedSession.operation||'Write'}</div>
          </div>
          <div style={{display:'flex',gap:6}}>
            <button onClick={()=>generateReport([selectedSession])} style={{padding:'6px 12px',fontSize:11,fontWeight:800,borderRadius:6,border:'1px solid rgba(255,255,255,0.3)',background:'rgba(255,255,255,0.1)',color:'#fff',cursor:'pointer'}}>📄 Print</button>
            <button onClick={()=>handleDelete(selectedSession.id)} style={{padding:'6px 12px',fontSize:11,fontWeight:800,borderRadius:6,border:'1px solid #FF525255',background:'#FF525222',color:'#fff',cursor:'pointer'}}>🗑 Delete</button>
          </div>
        </div>
        <div style={{padding:16}}>
          {/* Result badge */}
          <div style={{padding:'10px 14px',background:selectedSession.success?'#E8F5E9':'#FFEBEE',borderRadius:8,marginBottom:14,display:'flex',justifyContent:'space-between',alignItems:'center',border:'1px solid '+(selectedSession.success?C.gn:C.er)+'55'}}>
            <div style={{fontSize:12,fontWeight:800,color:selectedSession.success?C.gn:C.er}}>
              {selectedSession.success?'✓ WRITE SUCCEEDED':'✗ WRITE FAILED'}
            </div>
            <div style={{fontSize:11,color:C.ts}}>{new Date(selectedSession.timestamp).toLocaleString()}</div>
          </div>

          {/* VIN change */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
            <div style={{padding:10,background:'#FFF8F0',borderRadius:8,border:'1px solid '+C.wn+'55'}}>
              <div style={{fontSize:9,color:C.ts,letterSpacing:2,fontWeight:700,marginBottom:4}}>OLD VIN (before write)</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,color:C.wn}}>{selectedSession.oldVin||'(not read)'}</div>
            </div>
            <div style={{padding:10,background:'#E8F5E9',borderRadius:8,border:'1px solid '+C.gn+'55'}}>
              <div style={{fontSize:9,color:C.ts,letterSpacing:2,fontWeight:700,marginBottom:4}}>NEW VIN (written)</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,color:C.gn}}>{selectedSession.newVin||'—'}</div>
            </div>
          </div>

          {/* Title reference */}
          {selectedSession.titleRef&&<div style={{padding:12,background:'#F0F8FF',border:'1px solid #B0D4F0',borderRadius:8,marginBottom:14}}>
            <div style={{fontSize:10,color:C.a3,fontWeight:800,letterSpacing:2,marginBottom:6}}>📄 TITLE REFERENCE</div>
            <div style={{fontSize:13,fontWeight:700,color:C.tx}}>{selectedSession.titleRef}</div>
            {selectedSession.titleNotes&&<div style={{fontSize:11,color:C.ts,marginTop:6,fontStyle:'italic'}}>{selectedSession.titleNotes}</div>}
          </div>}

          {/* Technical details */}
          <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'6px 14px',fontSize:11}}>
            {selectedSession.technician&&<>
              <span style={{color:C.ts,fontWeight:700}}>Technician:</span><span>{selectedSession.technician}</span>
            </>}
            {selectedSession.moduleAddr&&<>
              <span style={{color:C.ts,fontWeight:700}}>Module Address:</span><span style={{fontFamily:"'JetBrains Mono'"}}>TX 0x{hx(selectedSession.moduleAddr.tx,3)} / RX 0x{hx(selectedSession.moduleAddr.rx,3)}</span>
            </>}
            {selectedSession.adapter&&<>
              <span style={{color:C.ts,fontWeight:700}}>Adapter:</span><span>{selectedSession.adapter}</span>
            </>}
            {selectedSession.algorithm&&<>
              <span style={{color:C.ts,fontWeight:700}}>Security Algorithm:</span><span>{selectedSession.algorithm}</span>
            </>}
            {selectedSession.voltage!==undefined&&selectedSession.voltage!==null&&<>
              <span style={{color:C.ts,fontWeight:700}}>Bench Voltage:</span><span>{selectedSession.voltage.toFixed(1)}V</span>
            </>}
            {selectedSession.preWriteConfirmed&&<>
              <span style={{color:C.ts,fontWeight:700}}>Pre-Write Review:</span><span>✓ Confirmed {new Date(selectedSession.preWriteConfirmed).toLocaleTimeString()}</span>
            </>}
            <span style={{color:C.ts,fontWeight:700}}>Session ID:</span><span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>{selectedSession.id}</span>
          </div>

          {/* DIDs written */}
          {selectedSession.dids&&selectedSession.dids.length>0&&<div style={{marginTop:14}}>
            <div style={{fontSize:10,color:C.ts,fontWeight:800,letterSpacing:2,marginBottom:6}}>DIDs VERIFIED</div>
            {selectedSession.dids.map((d,i)=>(
              <div key={i} style={{padding:'6px 10px',background:'#FAFAFA',borderRadius:4,marginBottom:3,fontSize:11,display:'flex',justifyContent:'space-between'}}>
                <span style={{fontFamily:"'JetBrains Mono'",fontWeight:700}}>{d.did}</span>
                <span style={{fontFamily:"'JetBrains Mono'",color:d.match!==false?C.gn:C.er}}>{d.value||'(empty)'}</span>
              </div>
            ))}
          </div>}
        </div>
      </Card>:<Card style={{textAlign:'center',padding:40,color:C.tm}}>
        <div style={{fontSize:40,marginBottom:10}}>👈</div>
        <div style={{fontSize:13,fontWeight:700,color:C.ts}}>Select a session to view details</div>
      </Card>}
    </div>}
  </div>;
}


/* ═════════════════════════════════════════════════════════════════
   AUTEL SGW TAB — MaxiFlash VCI / J2534 bridge integration
   ═════════════════════════════════════════════════════════════════ */
function AutelTab(){
  const{vin,setPg}=useContext(MasterVinContext);
  const[cfg,setCfg]=useState(()=>{
    const s=getAutelState();
    return{
      bridgeUrl:s.bridgeUrl||'http://localhost:8765',
      vciSerial:s.vciSerial||'',
      subscription:s.subscription||'',
      subscriptionExpiry:s.subscriptionExpiry||'',
      autoRouteSgw:s.autoRouteSgw!==false,
      lastTested:s.lastTested||null,
      lastTestResult:s.lastTestResult||null,
    };
  });
  const[editing,setEditing]=useState(false);
  const[testing,setTesting]=useState(false);
  const[testLog,setTestLog]=useState([]);
  const[bridgeStatus,setBridgeStatus]=useState('unknown');

  const save=useCallback(()=>{
    setAutelState(cfg);
    setEditing(false);
  },[cfg]);

  const addTestLog=useCallback((msg,level='info')=>{
    setTestLog(l=>[...l,{time:new Date().toLocaleTimeString(),msg,level}]);
  },[]);

  const testBridge=useCallback(async()=>{
    setTesting(true);
    setTestLog([]);
    addTestLog('Testing connection to J2534 bridge at '+cfg.bridgeUrl+'...');
    try{
      const ctrl=new AbortController();
      const timeout=setTimeout(()=>ctrl.abort(),4000);
      const res=await fetch(cfg.bridgeUrl+'/status',{signal:ctrl.signal});
      clearTimeout(timeout);
      if(!res.ok)throw new Error('HTTP '+res.status);
      const data=await res.json();
      addTestLog('✓ Bridge responding','ok');
      addTestLog('Bridge version: '+(data.version||'unknown'));
      if(data.vci){
        addTestLog('✓ VCI detected: '+data.vci.name+' (SN: '+data.vci.serial+')','ok');
        addTestLog('Firmware: '+(data.vci.firmware||'unknown'));
        if(data.vci.sgwCapable)addTestLog('✓ SGW capability present','ok');
        else addTestLog('⚠ VCI does not report SGW capability','warn');
      }else{
        addTestLog('⚠ No VCI connected to bridge','warn');
      }
      setBridgeStatus('ok');
      const newCfg={...cfg,lastTested:new Date().toISOString(),lastTestResult:'ok',vciSerial:data.vci?.serial||cfg.vciSerial};
      setCfg(newCfg);
      setAutelState(newCfg);
    }catch(e){
      addTestLog('✗ Connection failed: '+(e.message||e),'err');
      addTestLog('Is the bridge daemon running? Start with: python3 j2534_bridge.py','warn');
      setBridgeStatus('fail');
      const newCfg={...cfg,lastTested:new Date().toISOString(),lastTestResult:'fail'};
      setCfg(newCfg);
      setAutelState(newCfg);
    }
    setTesting(false);
  },[cfg,addTestLog]);

  const vinYear=parseVinYear(vin);
  const vinNeedsSGW=vinHasSGW(vin);

  return<div>
    <Card style={{background:'linear-gradient(135deg,#0F1419 0%,#1A2332 40%,#D32F2F 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🔐</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>AUTEL SGW ACCESS</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>MAXIFLASH VCI · J2534 PASSTHRU · 2018+ VEHICLES</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',borderRadius:8,background:bridgeStatus==='ok'?'rgba(0,200,83,0.25)':bridgeStatus==='fail'?'rgba(255,23,68,0.25)':'rgba(255,255,255,0.15)',border:'1px solid '+(bridgeStatus==='ok'?'#00C853':bridgeStatus==='fail'?'#FF1744':'rgba(255,255,255,0.3)')}}>
          {bridgeStatus==='ok'?'✓ BRIDGE CONNECTED':bridgeStatus==='fail'?'✗ BRIDGE OFFLINE':'⏸ NOT TESTED'}
        </div>
      </div>
      <div style={{fontSize:12,opacity:.9,marginTop:10,lineHeight:1.5}}>
        The Autel MaxiFlash VCI is a licensed J2534 PassThru device with SGW authentication built into
        firmware. Your laptop talks to the VCI; the VCI talks to the vehicle — including through the
        Secure Gateway on 2018+ FCA/Stellantis vehicles. No extracted keys needed.
      </div>
    </Card>

    {/* VIN ROUTING STATUS */}
    {vin&&vin.length===17&&<Card style={{marginBottom:14,background:vinNeedsSGW?'#FFF3E0':'#E8F5E9',borderLeft:'4px solid '+(vinNeedsSGW?C.wn:C.gn)}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:28}}>{vinNeedsSGW?'⚠️':'✓'}</div>
        <div style={{flex:1}}>
          <div style={{fontSize:11,color:C.ts,letterSpacing:2,fontWeight:800,marginBottom:4}}>CURRENT MASTER VIN · ROUTING</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:800,color:C.tx}}>{vin}</div>
          <div style={{fontSize:12,color:C.ts,marginTop:6}}>
            Model Year: <strong>{vinYear||'unknown'}</strong>
            {vinNeedsSGW
              ?<span style={{color:C.wn,fontWeight:700}}> · SGW Required → Route through Autel MaxiFlash VCI</span>
              :<span style={{color:C.gn,fontWeight:700}}> · Pre-SGW → Direct OBDLink EX connection OK</span>
            }
          </div>
          {vinNeedsSGW&&bridgeStatus!=='ok'&&<div style={{marginTop:8,padding:8,background:'#FFEBEE',borderRadius:6,fontSize:11,color:C.er,fontWeight:700}}>
            ⚠ Bridge not connected. Start the J2534 bridge daemon before programming this vehicle.
          </div>}
        </div>
      </div>
    </Card>}

    {/* CONFIGURATION */}
    <Card style={{marginBottom:14}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a4,letterSpacing:2}}>⚙️ VCI CONFIGURATION</div>
        {!editing&&<button onClick={()=>setEditing(true)} style={{fontSize:11,padding:'6px 12px',background:C.a4+'15',color:C.a4,border:'1px solid '+C.a4,borderRadius:6,fontWeight:700,cursor:'pointer'}}>✏️ Edit</button>}
      </div>
      {editing?<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        <div style={{gridColumn:'1 / 3'}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:4,fontWeight:700,letterSpacing:1}}>J2534 BRIDGE URL (local daemon)</div>
          <input value={cfg.bridgeUrl} onChange={e=>setCfg({...cfg,bridgeUrl:e.target.value})} placeholder="http://localhost:8765" style={{width:'100%',padding:8,border:'1px solid '+C.bd,borderRadius:6,fontSize:13,fontFamily:"'JetBrains Mono'"}}/>
          <div style={{fontSize:10,color:C.tm,marginTop:3}}>Runs on your laptop; wraps Autel's MaxiFlashJ2534.dll with an HTTP API</div>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4,fontWeight:700,letterSpacing:1}}>VCI SERIAL #</div>
          <input value={cfg.vciSerial} onChange={e=>setCfg({...cfg,vciSerial:e.target.value})} placeholder="e.g. VCI123456789" style={{width:'100%',padding:8,border:'1px solid '+C.bd,borderRadius:6,fontSize:13,fontFamily:"'JetBrains Mono'"}}/>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4,fontWeight:700,letterSpacing:1}}>SUBSCRIPTION TIER</div>
          <select value={cfg.subscription} onChange={e=>setCfg({...cfg,subscription:e.target.value})} style={{width:'100%',padding:8,border:'1px solid '+C.bd,borderRadius:6,fontSize:13}}>
            <option value="">— none —</option>
            <option value="standard">Standard</option>
            <option value="gold">Gold (SGW included)</option>
            <option value="platinum">Platinum (SGW + programming)</option>
          </select>
        </div>
        <div style={{gridColumn:'1 / 3'}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:4,fontWeight:700,letterSpacing:1}}>SUBSCRIPTION EXPIRY</div>
          <input type="date" value={cfg.subscriptionExpiry} onChange={e=>setCfg({...cfg,subscriptionExpiry:e.target.value})} style={{padding:8,border:'1px solid '+C.bd,borderRadius:6,fontSize:13}}/>
        </div>
        <div style={{gridColumn:'1 / 3',display:'flex',alignItems:'center',gap:8,padding:10,background:'#F8F6F2',borderRadius:6}}>
          <input type="checkbox" id="autoRoute" checked={cfg.autoRouteSgw} onChange={e=>setCfg({...cfg,autoRouteSgw:e.target.checked})}/>
          <label htmlFor="autoRoute" style={{fontSize:12,cursor:'pointer',fontWeight:700}}>Auto-route 2018+ VINs through MaxiFlash VCI (recommended)</label>
        </div>
        <div style={{gridColumn:'1 / 3',display:'flex',gap:8}}>
          <Btn onClick={save} color={C.gn}>💾 Save Configuration</Btn>
          <Btn onClick={()=>{const s=getAutelState();setCfg({...s,bridgeUrl:s.bridgeUrl||'http://localhost:8765'});setEditing(false);}} color={C.tm} outline>Cancel</Btn>
        </div>
      </div>:<div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'8px 16px',fontSize:13}}>
        <span style={{color:C.ts,fontWeight:700}}>Bridge URL:</span>
        <span style={{fontFamily:"'JetBrains Mono'"}}>{cfg.bridgeUrl}</span>
        <span style={{color:C.ts,fontWeight:700}}>VCI Serial:</span>
        <span style={{fontFamily:"'JetBrains Mono'"}}>{cfg.vciSerial||<em style={{color:C.tm}}>auto-detect on test</em>}</span>
        <span style={{color:C.ts,fontWeight:700}}>Subscription:</span>
        <span>{cfg.subscription?cfg.subscription.charAt(0).toUpperCase()+cfg.subscription.slice(1):<em style={{color:C.tm}}>not set</em>}
          {cfg.subscriptionExpiry&&<span style={{color:C.tm,marginLeft:8}}>· expires {cfg.subscriptionExpiry}</span>}
        </span>
        <span style={{color:C.ts,fontWeight:700}}>Auto-route:</span>
        <span style={{color:cfg.autoRouteSgw?C.gn:C.tm,fontWeight:700}}>{cfg.autoRouteSgw?'✓ Enabled':'✗ Disabled'}</span>
        <span style={{color:C.ts,fontWeight:700}}>Last Test:</span>
        <span>{cfg.lastTested
          ?<span>{new Date(cfg.lastTested).toLocaleString()} · <span style={{color:cfg.lastTestResult==='ok'?C.gn:C.er,fontWeight:700}}>{cfg.lastTestResult==='ok'?'✓ OK':'✗ Failed'}</span></span>
          :<em style={{color:C.tm}}>never</em>
        }</span>
      </div>}
    </Card>

    {/* CONNECTION TEST */}
    <Card style={{marginBottom:14}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a3,letterSpacing:2}}>🔌 BRIDGE CONNECTION TEST</div>
        <Btn onClick={testBridge} disabled={testing} color={C.a3}>{testing?'⏳ Testing...':'▶ Run Test'}</Btn>
      </div>
      <div style={{fontSize:11,color:C.ts,marginBottom:10}}>
        Tests the local J2534 bridge daemon and detects the connected MaxiFlash VCI.
        The bridge daemon is a small Python service that exposes Autel's J2534 DLL as a localhost HTTP API.
      </div>
      {testLog.length>0&&<div style={{background:'#0F1419',color:'#E0E0E0',fontFamily:"'JetBrains Mono'",fontSize:11,padding:12,borderRadius:8,maxHeight:240,overflowY:'auto'}}>
        {testLog.map((l,i)=>(
          <div key={i} style={{marginBottom:3,color:l.level==='ok'?'#00E676':l.level==='err'?'#FF5252':l.level==='warn'?'#FFC107':'#E0E0E0'}}>
            <span style={{color:'#757575'}}>[{l.time}]</span> {l.msg}
          </div>
        ))}
      </div>}
    </Card>

    {/* SETUP INSTRUCTIONS */}
    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.wn,letterSpacing:2,marginBottom:10}}>📋 FIRST-TIME SETUP</div>
      <div style={{fontSize:12,color:C.tx,lineHeight:1.7}}>
        <div style={{marginBottom:14,padding:10,background:'#FFF8F0',borderRadius:6,border:'1px solid '+C.wn+'33'}}>
          <div style={{fontWeight:800,marginBottom:4}}>1. Install Autel MaxiPC suite</div>
          <div style={{color:C.ts,fontSize:11}}>Download from autel.com. Includes MaxiFlashJ2534.dll which the bridge wraps.</div>
        </div>
        <div style={{marginBottom:14,padding:10,background:'#FFF8F0',borderRadius:6,border:'1px solid '+C.wn+'33'}}>
          <div style={{fontWeight:800,marginBottom:4}}>2. Register VCI to Autel account with active subscription</div>
          <div style={{color:C.ts,fontSize:11}}>SGW access requires Gold or Platinum tier. Verify by logging into Autel web portal.</div>
        </div>
        <div style={{marginBottom:14,padding:10,background:'#FFF8F0',borderRadius:6,border:'1px solid '+C.wn+'33'}}>
          <div style={{fontWeight:800,marginBottom:4}}>3. Run j2534_bridge.py on your laptop</div>
          <div style={{color:C.ts,fontSize:11}}>The Python bridge loads MaxiFlashJ2534.dll and exposes localhost endpoints for this app. See README for details.</div>
          <pre style={{marginTop:8,padding:8,background:'#0F1419',color:'#E0E0E0',borderRadius:4,fontSize:10,overflow:'auto'}}>python3 j2534_bridge.py --dll "C:\Program Files\Autel\MaxiFlashJ2534.dll" --port 8765</pre>
        </div>
        <div style={{marginBottom:14,padding:10,background:'#FFF8F0',borderRadius:6,border:'1px solid '+C.wn+'33'}}>
          <div style={{fontWeight:800,marginBottom:4}}>4. Click "Run Test" above to verify</div>
          <div style={{color:C.ts,fontSize:11}}>Once green, all 2018+ VINs will auto-route through the VCI.</div>
        </div>
      </div>
    </Card>

    {/* SGW-PROTECTED MODULES REFERENCE */}
    <Card>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,letterSpacing:2,marginBottom:10}}>📖 WHAT SGW PROTECTS (2018+)</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,fontSize:12}}>
        <div>
          <div style={{fontWeight:800,color:C.er,marginBottom:6}}>🔒 Protected (requires SGW auth)</div>
          <ul style={{margin:0,paddingLeft:18,lineHeight:1.7,color:C.ts}}>
            <li>ECM/PCM programming (Service 0x27, 0x2E, 0x34/36/37)</li>
            <li>TCM programming</li>
            <li>BCM VIN write (DID 0xF190 via 0x2E)</li>
            <li>RFHUB/WCM key programming</li>
            <li>ABS/ESC module configuration</li>
            <li>Immobilizer PIN operations</li>
          </ul>
        </div>
        <div>
          <div style={{fontWeight:800,color:C.gn,marginBottom:6}}>🔓 Unprotected (direct OBDLink works)</div>
          <ul style={{margin:0,paddingLeft:18,lineHeight:1.7,color:C.ts}}>
            <li>Read DTCs (Service 0x19)</li>
            <li>Read data parameters (Service 0x22)</li>
            <li>Read VIN (DID 0xF190 via 0x22)</li>
            <li>Read calibration info (0xF18C, 0xF187, 0xF189)</li>
            <li>Clear DTCs (Service 0x14)</li>
            <li>Standard OBD-II Mode 01/02/03/09</li>
          </ul>
        </div>
      </div>
    </Card>
  </div>;
}

