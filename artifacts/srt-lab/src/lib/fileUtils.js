import {crc16,crc8_42,crc8rf,rfhGen2VinCs,rfhGen2DetectMagic} from './crc.js';
import {IMMO_BLOCK,TR,WT,WMI,YR,TC,TL} from './constants.js';
import {arrEq,buildSizeWarn,typeFromFilename,CANONICAL_SIZES_BY_TYPE,looksLikeRealBcm,buildBcmContentWarn} from './parseModule.js';

const IMMO_REC_=24,IMMO_KC_=8;
const IMMO_BLK_=IMMO_REC_*IMMO_KC_;

function _detectBySignature(data){
  const sz=data.length;
  if(sz>=4096&&sz<=20480){const b0=data[0],b1=data[1];const cm=data[0x10];const hasTcm=(b0===0x00&&b1===0x00)||(b0===0xFF&&b1===0xFF);const tcmC=cm>=0x01&&cm<=0x08;let h55=false;for(let i=0;i<Math.min(32,sz-1);i++)if(data[i]===0x55&&data[i+1]===0xAA){h55=true;break;}const hA5=data[2]===0xA5||data[3]===0xA5||data[4]===0xA5;if((hasTcm&&tcmC)||(h55&&tcmC)||(hA5&&tcmC))return'TCM';}
  if(sz>=1024&&sz<=10240){const tv=data[0x04]===0x36||data[0x04]===0x80||data[0x04]===0x81||data[0x04]===0x3C;let aa=0;for(let i=0;i<Math.min(16,sz);i++)if(data[i]===0xAA)aa++;const hTh=(data[0]===0x00&&data[1]===0x00)||(data[0]===0xFF&&data[1]===0xFF);if(tv&&(aa>=4||hTh))return'TIPM';}
  return'UNKNOWN';
}

function _checkVin(v){
  if(!v||v.length!==17)return{ok:false};const u=v.toUpperCase();
  if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(u))return{ok:false,err:'Invalid chars'};
  let sum=0;for(let i=0;i<17;i++)sum+=(TR[u[i]]||0)*WT[i];
  const cd='0123456789X'[sum%11];
  return{ok:u[8]===cd,cd,wmi:u.slice(0,3),mfr:WMI[u.slice(0,3)]||'',yr:YR[u[9]]||'',err:u[8]!==cd?'Check digit: need '+cd:''};
}

function _countSkim(d,base){
  let c=0;for(let i=0;i<IMMO_KC_;i++){const o=base+i*IMMO_REC_;if(o+IMMO_REC_>d.length)break;const r=d.slice(o,o+IMMO_REC_);if(!r.every(b=>b===0xFF||b===0x00))c++;}return c;
}

function analyzeFile(buf,name){
  const data=new Uint8Array(buf);const sz=data.length;let type='UNKNOWN';
  if(sz===65536||sz===131072)type='BCM';
  else if(sz===8192||sz===16384){const sig=_detectBySignature(data);type=sig!=='UNKNOWN'?sig:'95640';}
  else if(sz===4096){const sig4=_detectBySignature(data);if(sig4!=='UNKNOWN'){type=sig4;}else{let a=true;for(let i=0;i<17&&i<sz;i++)if(data[i]<0x30||data[i]>0x5A){a=false;break;}type=a?'GPEC2A':'RFHUB';}}
  else if(sz>131072)type='FW';
  if(type==='UNKNOWN'){const CANONICAL_SIZES=[65536,131072,8192,16384,4096];const nearCanonical=CANONICAL_SIZES.some(s=>Math.abs(sz-s)<=4096&&sz!==s);if(nearCanonical||sz>=512){const sig=_detectBySignature(data);if(sig!=='UNKNOWN')type=sig;}}
  // Filename hint — see parseModule.js. Two rules: rescue the FW bucket, and
  // reclassify BCM-sized captures that lack BCM content when the filename
  // explicitly names GPEC2A or 95640.
  const _fnType=typeFromFilename(name);
  if(_fnType&&_fnType!==type){
    if(type==='FW')type=_fnType;
    else if(type==='BCM'&&(_fnType==='GPEC2A'||_fnType==='95640')&&!looksLikeRealBcm(data))type=_fnType;
  }
  const sizeWarn=buildSizeWarn(type,sz);
  const contentWarn=type==='BCM'?buildBcmContentWarn(data):null;
  const vins=[],partials=[];
  // Gen2 (24C32, 4096 B): CS = rfhGen2VinCs (XOR^0x87); Gen1 (24C16, 2048 B): CS = crc8rf
  if(type==='RFHUB'){const rfhIsGen2=sz===4096;let rfhMagic=0xDB;if(rfhIsGen2){for(const _o of[0xEA5,0xEB9,0xECD,0xEE1]){const _st=data.slice(_o,_o+17);const _sc=_o+17<sz?data[_o+17]:0;if(!_st.every(b=>b===0xFF||b===0)&&_sc!==0x00&&_sc!==0xFF){rfhMagic=rfhGen2DetectMagic(_st,_sc);break;}}}for(const off of[0xEA5,0xEB9,0xECD,0xEE1]){if(off+17>sz)continue;const st=data.slice(off,off+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);const sc=data[off+17],cc=rfhIsGen2?rfhGen2VinCs(st,rfhMagic):crc8rf(st);vins.push({off,vin:s,algo:'c8',coff:off+17,sc,cc,ok:sc===cc,cv:_checkVin(s),mirrored:true});}}
  else if(type==='GPEC2A'){for(const off of[0,0x1F0,0x224]){if(off+17>sz)continue;let s='',v=true;for(let j=0;j<17;j++){const b=data[off+j];if(b<0x20||b>0x7E){v=false;break;}s+=String.fromCharCode(b);}if(v&&/^[1-9A-HJ-NPR-Z]/.test(s))vins.push({off,vin:s,algo:'none',coff:-1,ok:true,cv:_checkVin(s)});}}
  else if(type==='95640'){for(const off of[0x275,0x288]){if(off+17>sz)continue;let s='',v=true;for(let j=0;j<17;j++){const b=data[off+j];if(b<0x20||b>0x7E){v=false;break;}s+=String.fromCharCode(b);}if(!v||!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))continue;const sc=data[off-1],cc=crc8_42(data.slice(off,off+17));vins.push({off,vin:s,algo:'c8',coff:off-1,sc,cc,ok:sc===cc,cv:_checkVin(s)});}}
  else if(type==='BCM'||type==='FW'){for(let i=0;i<=sz-19;i++){let v=true;for(let j=0;j<17;j++)if(data[i+j]<0x20||data[i+j]>0x7E){v=false;break;}if(!v)continue;let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(data[i+j]);if(!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))continue;const cv=_checkVin(s);if(!cv.ok)continue;const sc=(data[i+17]<<8)|data[i+18],cc=crc16(data.slice(i,i+17));if(sc===cc){vins.push({off:i,vin:s,algo:'c16',coff:i+17,sc,cc,ok:true,cv});i+=16;}}
    if(type==='BCM'){for(const po of[0x4098,0x40B0]){if(po+10>sz)continue;let s='',ok=true;for(let j=0;j<8;j++){const b=data[po+j];if(b<0x20||b>0x7E){ok=false;break;}s+=String.fromCharCode(b);}if(!ok||s.length!==8)continue;const sc=(data[po+8]<<8)|data[po+9],cc=crc16(data.slice(po,po+8));partials.push({off:po,vin:s,algo:'c16',coff:po+8,sc,cc});}}
    else if(vins.length>0){const tail=vins[0].vin.slice(9);const tc=[];for(let k=0;k<8;k++)tc.push(tail.charCodeAt(k));for(let i=0;i<=sz-10;i++){let m=true;for(let j=0;j<8;j++)if(data[i+j]!==tc[j]){m=false;break;}if(!m)continue;if(vins.some(fv=>i>=fv.off&&i<fv.off+17))continue;const sc=(data[i+8]<<8)|data[i+9],cc=crc16(data.slice(i,i+8));if(sc===cc)partials.push({off:i,vin:tail,algo:'c16',coff:i+8,sc,cc});}}}
  let sec=null;
  if(type==='BCM'){sec={t:'bcm'};sec.immoRecs=_countSkim(data,0x40C0);sec.b1=sec.immoRecs===0;sec.bakRecs=_countSkim(data,0x2000);sec.b2=sec.bakRecs===0;sec.immoSynced=sec.immoRecs>0&&sec.bakRecs>0&&arrEq(data.slice(0x40C0,0x40C0+IMMO_BLK_),data.slice(0x2000,0x2000+IMMO_BLK_));}
  else if(type==='95640'){sec={t:'95640'};sec.key=data.slice(0x40,0x50);sec.kb=sec.key.every(b=>b===0xFF);sec.fob=data.slice(0x200,0x240);sec.fb=sec.fob.every(b=>b===0xFF);}
  else if(type==='RFHUB'){sec={t:'rfhub'};sec.key=data.slice(0x40,0x50);sec.kb=sec.key.every(b=>b===0xFF);}
  else if(type==='GPEC2A'){sec={t:'gpec2a'};sec.skim=data[0x0011];sec.on=data[0x0011]===0x80;sec.key=data.slice(0x0203,0x020B);sec.km=arrEq(data.slice(0x0203,0x020B),data.slice(0x0361,0x0369));sec.zz=data[0x0c8c]===0x5a;if(sz>0x3CE){const s6=data.slice(0x3C8,0x3CE);sec.pcmSec6={hex:Array.from(s6).map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' '),damaged:s6.every(b=>b===0xFF),raw:s6};}}
  return{type,name:TL[type]||type,color:TC[type]||'#9E9E9E',size:sz,data,vins,partials,sec,hexOnly:type==='UNKNOWN',sizeWarn,contentWarn};
}

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

function writeModuleVIN(data,type,vin,existingVins){
  if(vin.length!==17)return null;
  const out=new Uint8Array(data);const vb=new TextEncoder().encode(vin);
  let offs;
  if(type==='GPEC2A')offs=[0x0000,0x01f0,0x0224];
  // BCM: prefer parsed offsets so we hit the actual VIN bytes on Redeye 2020+
  // dumps (which carry an 8-byte FEE record header — VIN at base+8 → CRC at
  // base+25 → 5-byte trailer). Fall back to the legacy header-less layout
  // (base+0) only when no parsed slots are available.
  else if(type==='BCM'&&existingVins&&existingVins.length>0)offs=existingVins.map(v=>v.offset);
  else if(type==='BCM')offs=[0x5320,0x5340,0x5360,0x5380];
  else if(type==='RFHUB'&&existingVins&&existingVins.length>0)offs=existingVins.map(v=>v.offset);
  else if(type==='RFHUB')offs=[0x0ea5,0x0eb9,0x0ecd,0x0ee1];
  else if(type==='95640')offs=[0x275,0x288];
  else offs=[];
  const hasMirrored=existingVins&&existingVins.some(v=>v.mirrored);
  if(type==='RFHUB'&&hasMirrored){const mr=[...vb].reverse();offs.forEach(o=>{for(let i=0;i<17;i++)out[o+i]=mr[i];out[o+17]=crc8rf(new Uint8Array(mr));});}
  else{offs.forEach(o=>{for(let i=0;i<17;i++)out[o+i]=vb[i];});}
  if(type==='BCM'){offs.forEach(o=>{const c=crc16(vb);out[o+17]=(c>>8)&0xFF;out[o+18]=c&0xFF;});
    const tb=new TextEncoder().encode(vin.slice(9));for(const po of[0x4098,0x40B0]){if(po+10>out.length)continue;for(let i=0;i<8;i++)out[po+i]=tb[i];const c=crc16(tb);out[po+8]=(c>>8)&0xFF;out[po+9]=c&0xFF;}}
  if(type==='95640')offs.forEach(o=>{out[o-1]=crc8_42(vb);});
  if(type==='RFHUB'&&!hasMirrored)offs.forEach(o=>{out[o+17]=crc8rf(out.slice(o,o+17));});
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

function syncImmoBackupF(data){
  if(data.length<0x40C0+IMMO_BLOCK||data.length<0x2000+IMMO_BLOCK)return null;
  const o=new Uint8Array(data);for(let i=0;i<IMMO_BLOCK;i++)o[0x2000+i]=o[0x40C0+i];return o;
}

export {analyzeFile,patchFile,virginizeFile,writeModuleVIN,virginizeModule,syncImmoBackupF};
