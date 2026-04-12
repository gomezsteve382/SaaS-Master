import React, { useState, useCallback, useMemo, useRef } from "react";
import FcaAnalyzerTab from "./FcaAnalyzerTab";

/* ═══ VERIFIED ENGINES ═══ */
function crc16(d,i=0xFFFF){let c=i;for(let x=0;x<d.length;x++){c^=d[x]<<8;for(let j=0;j<8;j++)c=c&0x8000?(c<<1)^0x1021:c<<1;c&=0xFFFF;}return c;}
function reflect8(b){let r=0;for(let i=0;i<8;i++){r=(r<<1)|(b&1);b>>=1;}return r;}
function crc8a(d){let c=0x0C;for(let x=0;x<d.length;x++){c^=reflect8(d[x]);for(let j=0;j<8;j++)c=c&0x80?((c<<1)^0x0C)&0xFF:(c<<1)&0xFF;}return c;}
const u32=n=>n>>>0;
function sxor(s,c){let k=u32(s);for(let i=0;i<5;i++)k=k&0x80000000?u32((k<<1)^u32(c)):u32(k<<1);return k;}
function cda6(s){let k=u32(s);k=u32(k^0x4B129F);k=u32((k<<3)|(k>>>29));k=u32(k+0x1234);k=u32(k^0xABCD);return u32((k>>>5)|(k<<27));}
const NT=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31],NS=[0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
function ngc(s){let k=0;for(let i=0;i<4;i++){let b=(u32(s)>>(i*8))&0xFF;k=u32(k^u32(((NT[b&0xF]^NT[(b>>4)&0xF])*NS[i%8])&0xFFFFFFFF));}return k;}
const TT={a:[0x727B,0xB301,0x08EB,0xB0BA,0xECA7,0x0ECC,0xD69A,0xE47E],b:[0x7A44,0x0201,0xF123,0x146E,0xCBC2,0x553F,0xD398,0x4EDC],c:[0x22B5,0x5767,0x4C5A,0xE443,0xC606,0x7544,0x0DFB,0x36D6],d:[0x632A,0x193B,0x914F,0x0F88,0x5E51,0x8DCD,0xDD6C,0x00DD]},TM=[0xBAEE,0xE000,0x1C00,0x0380,0x0070,0x0007];
function tipm(s,t='a'){const tb=TT[t]||TT.a;let v=s&0xFFFF,k=0;for(let i=0;i<tb.length;i++){let m=v&TM[i%TM.length],b=0,x=m;while(x){b^=x&1;x>>=1;}k=(k<<1)|b;k^=tb[i];k&=0xFFFF;}return k;}
const ALGOS=[{id:'gpec1',n:'GPEC1',h:'670269',fn:s=>sxor(s,670269)},{id:'gpec2',n:'GPEC2',h:'Continental',fn:s=>sxor(s,0xE72E3799)},{id:'gpec2f',n:'GPEC2 Flash',h:'Flash',fn:s=>sxor(s,0x966AEEB1)},{id:'gpec2e',n:'GPEC2 EPROM',h:'EPROM',fn:s=>sxor(s,0x3F711F5A)},{id:'gpec3',n:'GPEC3',h:'2018+',fn:s=>sxor(s,0x129D657F)},{id:'gpec2a',n:'GPEC2A',h:'GPEC2A',fn:s=>sxor(s,0xCE853A6F)},{id:'gpec15',n:'GPEC2 2015',h:'2015-18',fn:s=>sxor(s,0x47EC21F8)},{id:'ngc',n:'NGC',h:'DAIMLERCHRYSLER',fn:s=>ngc(s)},{id:'jtec',n:'JTEC',h:'Fixed 0000',fn:()=>0},{id:'cda6',n:'CDA6',h:'BCM/ABS/IPC',fn:s=>cda6(s)},{id:'t80',n:'TIPM 0x80',h:'t8001',fn:s=>tipm(s,'a')},{id:'t36',n:'TIPM 0x36',h:'t3605',fn:s=>tipm(s,'b')},{id:'t81',n:'TIPM 0x81',h:'t8101',fn:s=>tipm(s,'c')},{id:'t3c',n:'TIPM 0x3C',h:'t3c',fn:s=>tipm(s,'d')}];
const MODS=[{c:'ECM',n:'Engine',tx:0x7E0,rx:0x7E8},{c:'TCM',n:'Transmission',tx:0x7E1,rx:0x7E9},{c:'BCM',n:'Body Control',tx:0x742,rx:0x762},{c:'RFHUB',n:'RF Hub',tx:0x75F,rx:0x767},{c:'ABS',n:'Brakes',tx:0x760,rx:0x768},{c:'IPC',n:'Cluster',tx:0x745,rx:0x765},{c:'RADIO',n:'Uconnect',tx:0x772,rx:0x77A},{c:'DAMP',n:'Damping',tx:0x7E4,rx:0x7EC},{c:'EPS',n:'Steering',tx:0x75F,rx:0x769},{c:'TIPM',n:'Power Module',tx:0x74C,rx:0x76C}];

const SKIM_OFF=[{v:'Trackhawk',base:0x2000,ks:18,kc:6},{v:'SRT',base:0x40C0,ks:18,kc:6}];

/* ═══ VIN ═══ */
const TR={A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9};for(let d=0;d<=9;d++)TR[String(d)]=d;
const WT=[8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
const WMI={'1C4':'Chrysler US','2C3':'Dodge CA','1C6':'RAM US','2C4':'Chrysler CA','1J4':'Jeep US','1B3':'Dodge US','2B3':'Dodge CA','1J8':'Jeep US'};
const YR={A:2010,B:2011,C:2012,D:2013,E:2014,F:2015,G:2016,H:2017,J:2018,K:2019,L:2020,M:2021,N:2022,P:2023,R:2024,S:2025,T:2026};
function checkVin(v){if(!v||v.length!==17)return{ok:false};const u=v.toUpperCase();if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(u))return{ok:false,err:'Invalid chars'};let sum=0;for(let i=0;i<17;i++)sum+=(TR[u[i]]||0)*WT[i];const cd='0123456789X'[sum%11];return{ok:u[8]===cd,cd,wmi:u.slice(0,3),mfr:WMI[u.slice(0,3)]||'',yr:YR[u[9]]||'',err:u[8]!==cd?'Check digit: need '+cd:''};}
const hxb=d=>Array.from(d).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
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
    const knownVins=knownOffsets.map(o=>({offset:o,vin:extractVIN(data,o)})).filter(v=>v.vin);
    if(knownVins.length>0)info.vins=knownVins;
    else{info.vins=[];for(const o of knownOffsets){if(o+17>sz)continue;const st=data.slice(o,o+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);if(/^[1-9A-HJ-NPR-Z]/.test(s)){info.vins.push({offset:o,vin:s,mirrored:true});}}}
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
    const sb=data.slice(0x40C0,0x40E0);info.immoBlank=sb.every(b=>b===0xFF);
    if(!info.immoBlank){info.immo=data.slice(0x40C8,0x40DA);info.immoBak=data.slice(0x40F0,0x4102);info.immoOk=arrEq(info.immo,info.immoBak);}
    info.bakBlank=data.slice(0x2000,0x2020).every(b=>b===0xFF);
    if(!info.bakBlank)info.bak=data.slice(0x2000,0x2020);
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
  if(type==='RFHUB'){for(const off of[0xEA5,0xEB9,0xECD,0xEE1]){if(off+17>sz)continue;const st=data.slice(off,off+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);vins.push({off,vin:s,algo:'rfhub',coff:off+17,ok:true,cv:checkVin(s),mirrored:true});}}
  else if(type==='GPEC2A'){for(const off of[0,0x1F0,0x224]){if(off+17>sz)continue;let s='',v=true;for(let j=0;j<17;j++){const b=data[off+j];if(b<0x20||b>0x7E){v=false;break;}s+=String.fromCharCode(b);}if(v&&/^[1-9A-HJ-NPR-Z]/.test(s))vins.push({off,vin:s,algo:'none',coff:-1,ok:true,cv:checkVin(s)});}}
  else if(type==='95640'){for(const off of[0x275,0x288]){if(off+17>sz)continue;let s='',v=true;for(let j=0;j<17;j++){const b=data[off+j];if(b<0x20||b>0x7E){v=false;break;}s+=String.fromCharCode(b);}if(!v||!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))continue;const sc=data[off-1],cc=crc8a(data.slice(off,off+17));vins.push({off,vin:s,algo:'c8',coff:off-1,sc,cc,ok:sc===cc,cv:checkVin(s)});}}
  else if(type==='BCM'||type==='FW'){for(let i=0;i<=sz-19;i++){let v=true;for(let j=0;j<17;j++)if(data[i+j]<0x20||data[i+j]>0x7E){v=false;break;}if(!v)continue;let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(data[i+j]);if(!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))continue;const cv=checkVin(s);if(!cv.ok)continue;const sc=(data[i+17]<<8)|data[i+18],cc=crc16(data.slice(i,i+17));if(sc===cc){vins.push({off:i,vin:s,algo:'c16',coff:i+17,sc,cc,ok:true,cv});i+=16;}}
    if(type==='BCM'){for(const po of[0x4098,0x40B0]){if(po+10>sz)continue;let s='',ok=true;for(let j=0;j<8;j++){const b=data[po+j];if(b<0x20||b>0x7E){ok=false;break;}s+=String.fromCharCode(b);}if(!ok||s.length!==8)continue;const sc=(data[po+8]<<8)|data[po+9],cc=crc16(data.slice(po,po+8));partials.push({off:po,vin:s,algo:'c16',coff:po+8,sc,cc});}}
    else if(vins.length>0){const tail=vins[0].vin.slice(9);const tc=[];for(let k=0;k<8;k++)tc.push(tail.charCodeAt(k));for(let i=0;i<=sz-10;i++){let m=true;for(let j=0;j<8;j++)if(data[i+j]!==tc[j]){m=false;break;}if(!m)continue;if(vins.some(fv=>i>=fv.off&&i<fv.off+17))continue;const sc=(data[i+8]<<8)|data[i+9],cc=crc16(data.slice(i,i+8));if(sc===cc)partials.push({off:i,vin:tail,algo:'c16',coff:i+8,sc,cc});}}}
  let sec=null;
  if(type==='BCM'){sec={t:'bcm'};const sb=data.slice(0x40C0,0x40E0);sec.b1=sb.every(b=>b===0xFF);if(!sec.b1){sec.immo=data.slice(0x40C8,0x40DA);sec.immoBak=data.slice(0x40F0,0x4102);sec.immoOk=true;for(let j=0;j<sec.immo.length;j++)if(sec.immo[j]!==sec.immoBak[j]){sec.immoOk=false;break;}}sec.b2=data.slice(0x2000,0x2020).every(b=>b===0xFF);if(!sec.b2)sec.bak=data.slice(0x2000,0x2020);}
  else if(type==='95640'){sec={t:'95640'};sec.key=data.slice(0x40,0x50);sec.kb=sec.key.every(b=>b===0xFF);sec.fob=data.slice(0x200,0x240);sec.fb=sec.fob.every(b=>b===0xFF);}
  else if(type==='RFHUB'){sec={t:'rfhub'};sec.key=data.slice(0x40,0x50);sec.kb=sec.key.every(b=>b===0xFF);}
  else if(type==='GPEC2A'){sec={t:'gpec2a'};sec.skim=data[0x11];sec.on=data[0x11]===0x80;sec.key=data.slice(0x203,0x20B);sec.mir=data.slice(0x361,0x369);sec.km=true;for(let j=0;j<8;j++)if(sec.key[j]!==sec.mir[j]){sec.km=false;break;}sec.tr=[];for(let i=0;i<4;i++)sec.tr.push(data.slice(0x888+i*4,0x888+i*4+4));sec.zz=data[0xC8C]===0x5A;}
  return{name,size:sz,type,data,vins,partials,sec};}

function patchFile(f,nv){const out=new Uint8Array(f.data);const vb=new TextEncoder().encode(nv.toUpperCase());const log=[];
  for(const s of f.vins){if(s.mirrored){const m=[...vb].reverse();for(let j=0;j<17;j++)out[s.off+j]=m[j];log.push('0x'+s.off.toString(16).toUpperCase()+' mirrored');}else{for(let j=0;j<17;j++)out[s.off+j]=vb[j];if(s.algo==='c16'){const c=crc16(vb);out[s.coff]=(c>>8)&0xFF;out[s.coff+1]=c&0xFF;log.push('0x'+s.off.toString(16).toUpperCase()+' CRC16');}else if(s.algo==='c8'){const c=crc8a(vb);out[s.coff]=c;log.push('0x'+s.off.toString(16).toUpperCase()+' CRC8');}else log.push('0x'+s.off.toString(16).toUpperCase());}}
  if(f.partials){const tb=new TextEncoder().encode(nv.toUpperCase().slice(9));for(const s of f.partials){for(let j=0;j<8;j++)out[s.off+j]=tb[j];const c=crc16(tb);out[s.coff]=(c>>8)&0xFF;out[s.coff+1]=c&0xFF;log.push('0x'+s.off.toString(16).toUpperCase()+' partial');}}
  return{data:out,log};}

function virginizeFile(f){const out=new Uint8Array(f.data);const log=[];
  if(f.type==='BCM'){f.vins.forEach(v=>{for(let j=0;j<19;j++)out[v.off+j]=0;});f.partials?.forEach(v=>{for(let j=0;j<10;j++)out[v.off+j]=0;});[0x2000,0x40C0].forEach(o=>{for(let i=0;i<32;i++)out[o+i]=0xFF;});log.push('VINs+CRC zeroed, SKIM cleared');}
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
  if(type==='RFHUB'&&hasMirrored){const mr=[...vb].reverse();offs.forEach(o=>{for(let i=0;i<17;i++)out[o+i]=mr[i];let s=0;for(let i=0;i<17;i++)s=(s+out[o+i])&0xff;out[o+17]=s;});}
  else{offs.forEach(o=>{for(let i=0;i<17;i++)out[o+i]=vb[i];});}
  if(type==='BCM'){offs.forEach(o=>{const c=crc16(vb);out[o+17]=(c>>8)&0xFF;out[o+18]=c&0xFF;});
    const tb=new TextEncoder().encode(vin.slice(9));for(const po of[0x4098,0x40B0]){if(po+10>out.length)continue;for(let i=0;i<8;i++)out[po+i]=tb[i];const c=crc16(tb);out[po+8]=(c>>8)&0xFF;out[po+9]=c&0xFF;}}
  if(type==='95640')offs.forEach(o=>{out[o-1]=crc8a(vb);});
  if(type==='RFHUB'&&!hasMirrored)offs.forEach(o=>{let s=0;for(let i=0;i<17;i++)s=(s+out[o+i])&0xff;out[o+17]=s;});
  return out;
}

function virginizeModule(data,type){
  const o=new Uint8Array(data);
  if(type==='GPEC2A'){o[0x0011]=0x00;for(let i=0x0203;i<0x020b;i++)o[i]=0x00;for(let i=0x0361;i<0x0369;i++)o[i]=0x00;for(let i=0x0888;i<0x0899;i++)o[i]=0xff;for(let i=0x0c8c;i<0x0c94;i++)o[i]=0x00;}
  else if(type==='RFHUB'){[0xEA5,0xEB9,0xECD,0xEE1].forEach(off=>{for(let j=0;j<18;j++)o[off+j]=0;});for(let i=0;i<16;i++)o[0x40+i]=0xFF;for(let i=0;i<64;i++)o[0x200+i]=0xFF;}
  else if(type==='BCM'){[0x5320,0x5340,0x5360,0x5380].forEach(off=>{for(let j=0;j<19;j++)o[off+j]=0;});[0x2000,0x40C0].forEach(base=>{for(let i=0;i<32;i++)o[base+i]=0xFF;});}
  else if(type==='95640'){[0x275,0x288].forEach(off=>{for(let j=-1;j<17;j++)o[off+j]=0;});for(let i=0;i<16;i++)o[0x40+i]=0xFF;}
  return o;
}

/* ═══ DESIGN ═══ */
const C={bg:'#F4F1EC',cd:'#FFF',c2:'#FAF9F7',sr:'#D32F2F',sl:'#FF5252',bk:'#1A1A1A',a1:'#FF6D00',a2:'#00BFA5',a3:'#2979FF',a4:'#AA00FF',tx:'#1A1A1A',ts:'#5A5A5A',tm:'#9E9E9E',bd:'#E8E4DE',gn:'#00C853',wn:'#FFB300',er:'#FF1744'};
function Card({children,style={},glow,onClick}){const[h,setH]=useState(false);return<div onClick={onClick} onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)} style={{background:C.cd,borderRadius:16,padding:22,border:`1.5px solid ${h&&onClick?C.sr:C.bd}`,boxShadow:h&&onClick?'0 8px 32px rgba(211,47,47,0.12)':'0 2px 16px rgba(0,0,0,0.06)',transition:'all 0.3s',transform:h&&onClick?'translateY(-2px)':'none',cursor:onClick?'pointer':'default',position:'relative',overflow:'hidden',...style}}>{glow&&<div style={{position:'absolute',top:-40,right:-40,width:120,height:120,borderRadius:'50%',background:'radial-gradient(circle,#FF525215,transparent 70%)',pointerEvents:'none'}}/>}<div style={{position:'relative',zIndex:1}}>{children}</div></div>;}
function Tag({children,color=C.sr}){return<span style={{fontSize:10,fontWeight:800,padding:'3px 10px',borderRadius:8,background:color+'14',color,letterSpacing:.5,display:'inline-block',marginLeft:4}}>{children}</span>;}
function Btn({children,onClick,disabled,color=C.sr,full,outline}){const[h,setH]=useState(false);return<button onClick={onClick} disabled={disabled} onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)} style={{padding:'10px 20px',borderRadius:10,fontFamily:"'Nunito'",fontWeight:800,fontSize:12,border:outline?`2px solid ${color}33`:'none',cursor:disabled?'not-allowed':'pointer',background:disabled?'#E8E4DE':outline?(h?color+'10':'transparent'):(h?color:color+'DD'),color:disabled?C.tm:outline?color:'#fff',width:full?'100%':undefined,transition:'all 0.2s',letterSpacing:.5}}>{children}</button>;}
function SLine({type,msg}){const col={error:C.er,warn:C.wn,pass:C.gn};const ico={error:'✗',warn:'⚠',pass:'✓'};return<div style={{fontSize:12,color:col[type],padding:'4px 0',display:'flex',gap:8}}><span style={{fontWeight:700,minWidth:14}}>{ico[type]}</span><span>{msg}</span></div>;}
const TABS=[{id:'dumps',i:'📂',l:'DUMPS',s:'VIN · Hex · Virginize'},{id:'obd',i:'📡',l:'LIVE OBD',s:'UDS · Scan · Write'},{id:'bench',i:'🔧',l:'BENCH',s:'Offline · Dumps'},{id:'seed',i:'🔑',l:'SEED→KEY',s:'14 Algorithms'},{id:'gpec',i:'🔓',l:'GPEC',s:'FW Unlock'},{id:'skim',i:'🛡️',l:'SECURITY',s:'Cross-Match'},{id:'gpec2a',i:'⚙️',l:'GPEC2A',s:'SKIM · Tamper'},{id:'analyzer',i:'🔬',l:'ANALYZER',s:'GPEC · RFHUB · BCM'}];

/* ═══ APP ═══ */
export default function App(){const[pg,setPg]=useState('dumps');const[files,setFiles]=useState([]);
  const loadF=useCallback(fl=>{Promise.all(Array.from(fl).map(f=>new Promise(r=>{const rd=new FileReader();rd.onload=e=>r(analyzeFile(e.target.result,f.name));rd.readAsArrayBuffer(f);}))).then(res=>setFiles(p=>[...p,...res.filter(f=>f.type!=='unknown')]));},[]);
  return<div style={{minHeight:'100vh',background:C.bg,color:C.tx,fontFamily:"'Nunito',sans-serif"}}>
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;600;700&family=Righteous&display=swap" rel="stylesheet"/>
    <div style={{background:'linear-gradient(135deg,#1A1A1A 0%,#2D2D2D 40%,#D32F2F 100%)',position:'relative',overflow:'hidden'}}>
      <div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse at 80% 50%,rgba(255,82,82,0.3),transparent 60%)',pointerEvents:'none'}}/>
      <div style={{position:'relative',padding:'22px 28px 0',display:'flex',alignItems:'center',gap:14}}>
        <div style={{width:46,height:46,borderRadius:13,background:'linear-gradient(135deg,#FF5252,#D32F2F)',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 4px 20px rgba(211,47,47,0.4)'}}><span style={{fontFamily:"'Righteous'",fontSize:22,color:'#fff'}}>S</span></div>
        <div><div style={{fontFamily:"'Righteous'",fontSize:26,color:'#fff',letterSpacing:2}}>SRT LAB</div><div style={{fontSize:9,color:'rgba(255,255,255,0.4)',fontWeight:700,letterSpacing:6}}>JAILBREAK EDITION</div></div>
      </div>
      <div style={{display:'flex',padding:'12px 16px 0',overflowX:'auto',gap:2}}>
        {TABS.map(t=>{const a=pg===t.id;return<button key={t.id} onClick={()=>setPg(t.id)} style={{padding:'11px 16px 13px',border:'none',cursor:'pointer',background:a?C.bg:'transparent',borderRadius:'11px 11px 0 0',color:a?C.sr:'rgba(255,255,255,0.4)',fontFamily:"'Nunito'",fontWeight:a?900:700,fontSize:11,letterSpacing:1.2,transition:'all 0.25s',boxShadow:a?'0 -4px 16px rgba(0,0,0,0.06)':'none',whiteSpace:'nowrap'}}><span style={{fontSize:14,marginRight:4,filter:a?'none':'grayscale(1) brightness(2)'}}>{t.i}</span>{t.l}<div style={{fontSize:7,marginTop:1,opacity:.4}}>{t.s}</div></button>;})}
      </div>
    </div>
    <div style={{maxWidth:1100,margin:'0 auto',padding:'22px 22px 60px'}}>
      {pg==='dumps'&&<DumpsTab files={files} setFiles={setFiles} loadF={loadF}/>}
      {pg==='obd'&&<OBDTab/>}
      {pg==='bench'&&<BenchTab/>}
      {pg==='seed'&&<SeedTab/>}
      {pg==='gpec'&&<GpecTab/>}
      {pg==='skim'&&<SecurityTab/>}
      {pg==='gpec2a'&&<Gpec2aTab/>}
      {pg==='analyzer'&&<FcaAnalyzerTab/>}
    </div></div>;}

/* ═══ BENCH TAB ═══ */
function BenchTab(){
  const[mods,setMods]=useState([]);const[nv,setNv]=useState('');const[msg,setMsg]=useState('');const[log,setLog]=useState([]);
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
          const sc=out[off-1],cc=crc8a(out.slice(off,off+17));
          if(sc!==cc){out[off-1]=cc;addLog('  '+m.name+' @0x'+off.toString(16).toUpperCase()+': CRC8 '+sc.toString(16).toUpperCase()+' → '+cc.toString(16).toUpperCase(),'rx');fixes++;}
        }
      }else if(m.type==='RFHUB'){
        for(const off of[0xEA5,0xEB9,0xECD,0xEE1]){if(off+18>out.length)continue;
          const st=out.slice(off,off+17);if(st.every(b=>b===0xFF||b===0))continue;
          let s=0;for(let j=0;j<17;j++)s=(s+out[off+j])&0xFF;
          const sc=out[off+17];
          if(sc!==s){out[off+17]=s;addLog('  '+m.name+' @0x'+off.toString(16).toUpperCase()+': Boot CRC '+sc.toString(16).toUpperCase()+' → '+s.toString(16).toUpperCase(),'rx');fixes++;}
        }
      }
      if(fixes>0){dl(out,'CRC_PATCHED_'+m.filename);addLog(m.name+': '+fixes+' CRC(s) fixed → download','rx');patched++;
        setMods(p=>{const u=[...p];u[idx]=parseModule(out,m.filename);return u;});
      }else addLog(m.name+': all CRCs valid ✓','info');
    });
    setMsg(patched>0?patched+' module(s) CRC-patched':'All CRCs already valid');
  },[mods]);

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
          <Btn onClick={doCrcPatch} disabled={!mods.length} color={C.sr}>🔧 CRC Patch All</Btn>
        </div>
        <div style={{marginTop:10,fontSize:10,color:C.ts}}>
          <div><b>Bench mode:</b> All operations work on loaded .bin files — no serial connection needed</div>
          <div><b>Downloads:</b> Each operation produces a modified .bin ready to write to chip</div>
        </div>
      </Card>}

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
    else if(action==='writeVin'&&tv.length===17){const d=writeModuleVIN(m.data,m.type,tv,m.vins);if(d)res={data:d,desc:'VIN updated to '+tv+' at '+(m.vins?m.vins.length:0)+' locations'};}
    else if(action==='skimToggle'&&m.type==='GPEC2A'){const d=new Uint8Array(m.data);d[0x0011]=m.skimByte===0x80?0x00:0x80;res={data:d,desc:'SKIM: 0x'+m.skimByte.toString(16).toUpperCase()+' → 0x'+d[0x0011].toString(16).toUpperCase()};}
    else if(action==='extractKey'){let k=m.secretKey?m.secretKey.hex:m.vehicleSecret?m.vehicleSecret.hex:m.skey&&!m.skb?hxb(m.skey):'';res={keyHex:k,desc:'Extracted from '+m.type};}
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
              {m.vins?.map((v,j)=><tr key={'v'+j}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(v.offset)}</td><td><Tag color={C.gn}>VIN {j+1}</Tag></td><td style={{padding:'5px 10px',color:C.gn,fontWeight:700,fontSize:12}}>{v.vin}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>{v.mirrored?'17B Mirrored':'17B ASCII'}</td></tr>)}
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
              {m.immoBlank!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x40C0</td><td><Tag color={C.sr}>IMMO</Tag></td><td style={{padding:'5px 10px',color:m.immoBlank?C.wn:C.gn,fontWeight:700,fontSize:12}}>{m.immoBlank?'BLANK':'SET'}{!m.immoBlank&&(m.immoOk?' ✓':' BACKUP MISMATCH')}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>BCM immobilizer</td></tr>}
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
          {m.immoBlank!==undefined&&<div style={{fontSize:11,marginTop:4}}>Immo @0x40C0: <Tag color={m.immoBlank?C.wn:C.gn}>{m.immoBlank?'BLANK':'SET'}</Tag>{!m.immoBlank&&<Tag color={m.immoOk?C.gn:C.er}>Backup {m.immoOk?'✓':'MISMATCH'}</Tag>}</div>}
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
      const dec=new TextDecoderStream();port.readable.pipeTo(dec.writable).catch(()=>{});
      const rd=dec.readable.getReader();let buf='';
      (async()=>{try{while(true){const{value,done}=await rd.read();if(done)break;if(value)buf+=value;}}catch(e){}})();
      const send=async(cmd,to=2000)=>{buf='';await w.write(new TextEncoder().encode(cmd+'\r'));addLog('TX > '+cmd,'tx');const s=Date.now();while(Date.now()-s<to){if(buf.includes('>')){const r=buf.replace(/>/g,'').trim();addLog('RX < '+r,'rx');return r;}await new Promise(r=>setTimeout(r,50));}return buf.trim();};
      await send('ATZ',3000);await new Promise(r=>setTimeout(r,500));
      addLog('Adapter: '+(await send('ATI')),'info');
      for(const c of['ATE0','ATL0','ATS1','ATH1','ATCAF1','ATCFC1','ATAL','ATSP6']){await send(c);await new Promise(r=>setTimeout(r,80));}
      eng.current={send,uds:async(tx,rx,data)=>{
        await send('ATSH'+tx.toString(16).toUpperCase().padStart(3,'0'));
        await send('ATCRA'+rx.toString(16).toUpperCase().padStart(3,'0'));
        const h=Array.from(data).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
        const r=await send(h,5000);
        if(!r||r.includes('NO DATA')||r.includes('ERROR'))return{ok:false};
        const ls=r.split(/\r?\n/).map(l=>l.trim()).filter(l=>/^[0-9A-F\s]+$/i.test(l));
        let all=[];ls.forEach(l=>{(l.replace(/\s/g,'').match(/.{2}/g)||[]).forEach(x=>all.push(parseInt(x,16)));});
        return{ok:true,d:new Uint8Array(all)};
      }};
      setConn(true);addLog('Ready — HS-CAN 500kbps','info');
    }catch(e){addLog('Connect failed: '+e.message,'error');}
  },[]);

  const scan=useCallback(async()=>{
    if(!eng.current)return;setBusy('Scanning...');setFound([]);
    for(const m of MODS){try{
      const r=await eng.current.uds(m.tx,m.rx,[0x22,0xF1,0x90]);
      if(r.ok&&r.d?.length>3){const vc=Array.from(r.d).filter(b=>b>=0x20&&b<=0x7E);const vin=String.fromCharCode(...vc).slice(-17);
        if(vin.length>=10){setFound(p=>[...p,{...m,vin}]);addLog(m.c+': '+vin,'rx');}}
    }catch(e){}}
    setBusy('');addLog('Scan complete','info');
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
    const r=await eng.current.uds(0x742,0x762,[0x22,0x20,0x23]);
    if(r.ok)addLog('BCM Proxi: '+hxb(r.d),'rx');else addLog('Proxi read failed','error');
    setBusy('');
  },[]);

  const readSkim=useCallback(async()=>{
    if(!eng.current)return;setBusy('Reading SKIM...');
    const r=await eng.current.uds(0x742,0x762,[0x22,0x6E,0x9E,0xB0]);
    if(r.ok){const v=r.d?.length>0?r.d[r.d.length-1]:null;addLog('SKIM State: '+(v===0x80?'ENABLED':'DISABLED')+' (0x'+(v?.toString(16).toUpperCase()||'??')+')','rx');}
    else addLog('SKIM read failed','error');setBusy('');
  },[]);

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
          <div>{v.algo==='c16'&&<Tag color={C.gn}>CRC16 ✓</Tag>}{v.algo==='c8'&&<Tag color={v.ok?C.gn:C.wn}>CRC8 {v.ok?'✓':'!'}</Tag>}{v.algo==='rfhub'&&<Tag color={C.a3}>Boot CRC</Tag>}{v.algo==='none'&&<Tag color={C.a2}>No CRC</Tag>}</div>
        </div>)}
        {f.partials?.map((v,i)=><div key={'p'+i} style={{padding:'6px 10px',borderRadius:8,marginBottom:4,background:'#FFF8E1',border:'1px solid #FFE082',fontSize:11}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>0x{v.off.toString(16).toUpperCase()} </span><span style={{fontFamily:"'JetBrains Mono'",fontWeight:700,color:C.a1}}>…{v.vin}</span><Tag color={C.wn}>PARTIAL</Tag>
        </div>)}
      </Card>
      {f.sec&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 Security</div>
        {f.sec.t==='bcm'&&<><div style={{fontSize:11,marginBottom:6}}>Immo @0x40C0: <Tag color={f.sec.b1?C.wn:C.gn}>{f.sec.b1?'BLANK':'SET'}</Tag>{!f.sec.b1&&<Tag color={f.sec.immoOk?C.gn:C.er}>Backup {f.sec.immoOk?'✓':'MISMATCH'}</Tag>}</div><div style={{fontSize:11}}>Backup @0x2000: <Tag color={f.sec.b2?C.tm:C.gn}>{f.sec.b2?'BLANK':'SET'}</Tag></div></>}
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
