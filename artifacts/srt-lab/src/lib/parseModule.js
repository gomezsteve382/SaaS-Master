import {crc16,crc8rf,rfhGen2VinCs} from './crc.js';
import {TC,TL,SKIM_VALUES,IMMO_REC,IMMO_KC,IMMO_BLOCK,SKIM_OFF} from './constants.js';

const fO=n=>"0x"+n.toString(16).toUpperCase().padStart(4,"0");

function countSkimRecs(d,base){let c=0;for(let i=0;i<IMMO_KC;i++){const o=base+i*IMMO_REC;if(o+IMMO_REC>d.length)break;const r=d.slice(o,o+IMMO_REC);if(!r.every(b=>b===0xFF||b===0x00))c++;}return c;}
function syncImmoBackup(d){if(d.length<0x40C0+IMMO_BLOCK||d.length<0x2000+IMMO_BLOCK)return null;const o=new Uint8Array(d);for(let i=0;i<IMMO_BLOCK;i++)o[0x2000+i]=o[0x40C0+i];return o;}

function extractVIN(data,offset,len){if(!len)len=17;if(offset+len>data.length)return null;const bytes=data.slice(offset,offset+len);for(let i=0;i<bytes.length;i++){if(bytes[i]<0x30||bytes[i]>0x5a)return null;}return String.fromCharCode.apply(null,bytes);}
function extractHex(data,offset,len){const r=[];for(let i=0;i<len;i++)r.push(data[offset+i].toString(16).padStart(2,"0").toUpperCase());return r.join(" ");}
function arrEq(a,b){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
function rd32(data,o){return(data[o]<<24)|(data[o+1]<<16)|(data[o+2]<<8)|data[o+3];}
function countAA50(d,s,n){let c=0;for(let i=0;i<n;i++)if(d[s+i*2]===0xaa&&d[s+i*2+1]===0x50)c++;return c;}
function countPat(d,a,b,c2,d2){let c=0;for(let i=0;i<d.length-3;i++)if(d[i]===a&&d[i+1]===b&&d[i+2]===c2&&d[i+3]===d2)c++;return c;}

function detectBySignature(data){
  const sz=data.length;
  if(sz>=4096&&sz<=20480){
    const b0=data[0],b1=data[1];
    const classMarker=data[0x10];
    const hasTcmMarker=(b0===0x00&&b1===0x00)||(b0===0xFF&&b1===0xFF);
    const tcmClass=classMarker>=0x01&&classMarker<=0x08;
    let has55AA=false;for(let i=0;i<Math.min(32,sz-1);i++)if(data[i]===0x55&&data[i+1]===0xAA){has55AA=true;break;}
    const hasA5=data[2]===0xA5||data[3]===0xA5||data[4]===0xA5;
    if((hasTcmMarker&&tcmClass)||(has55AA&&tcmClass)||(hasA5&&tcmClass))return'TCM';
  }
  if(sz>=1024&&sz<=10240){
    const tipmVariant=data[0x04]===0x36||data[0x04]===0x80||data[0x04]===0x81||data[0x04]===0x3C;
    let aaCount=0;for(let i=0;i<Math.min(16,sz);i++)if(data[i]===0xAA)aaCount++;
    const hasAaPattern=aaCount>=4;
    const tipmHeader=(data[0]===0x00&&data[1]===0x00)||(data[0]===0xFF&&data[1]===0xFF);
    if(tipmVariant&&(hasAaPattern||tipmHeader))return'TIPM';
  }
  return'UNKNOWN';
}

function parseModule(data,filename){
  const sz=data.length;let type='UNKNOWN';
  if(sz===65536||sz===131072){type='BCM';}
  else if(sz===8192||sz===16384){
    const sig=detectBySignature(data);
    type=sig!=='UNKNOWN'?sig:'95640';
  }
  else if(sz===4096){
    const sig4=detectBySignature(data);
    if(sig4!=='UNKNOWN'){type=sig4;}
    else{let va=true;for(let i=0;i<17&&i<sz;i++){const b=data[i];if(!((b>=0x30&&b<=0x39)||(b>=0x41&&b<=0x5A))){va=false;break;}}type=va?'GPEC2A':'RFHUB';}
  }
  else if(sz>131072)type='FW';
  if(type==='UNKNOWN'){
    const CANONICAL_SIZES=[65536,131072,8192,16384,4096];
    const nearCanonical=CANONICAL_SIZES.some(s=>Math.abs(sz-s)<=4096&&sz!==s);
    if(nearCanonical||sz>=512){const sig=detectBySignature(data);if(sig!=='UNKNOWN')type=sig;}
  }

  const info={type,filename,data,size:sz,name:TL[type]||type,color:TC[type]||'#9E9E9E'};
  if(type==='UNKNOWN')info.hexOnly=true;

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
    if(sz>0x3CE){
      const s6=data.slice(0x3C8,0x3CE);
      const s6blank=s6.every(b=>b===0xFF||b===0x00);
      const s6damaged=s6.every(b=>b===0xFF);
      info.pcmSec6={offset:0x3C8,raw:s6,hex:extractHex(data,0x3C8,6),blank:s6blank,damaged:s6damaged,
        immoState:s6damaged?'IMMO_DAMAGED':'SET'};
    }
  }else if(type==='RFHUB'){
    const knownOffsets=[0x0ea5,0x0eb9,0x0ecd,0x0ee1];
    // Gen2 (24C32, 4096 B): VINs stored byte-reversed; CS = rfhGen2VinCs (XOR^0x87)
    // Gen1 (24C16, 2048 B): VINs stored plain or mirrored; CS = crc8rf
    const rfhIsGen2=sz===4096;
    if(rfhIsGen2){
      info.vins=[];
      for(const o of knownOffsets){if(o+17>sz)continue;const st=data.slice(o,o+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);if(!/^[1-9A-HJ-NPR-Z]/.test(s))continue;const sc=o+17<sz?data[o+17]:0,cc=rfhGen2VinCs(st);info.vins.push({offset:o,vin:s,mirrored:true,sc,cc,crcOk:sc===cc});}
    }else{
      const knownVins=knownOffsets.map(o=>{const v=extractVIN(data,o);if(v)return{offset:o,vin:v,mirrored:false,sc:o+17<sz?data[o+17]:0,cc:crc8rf(data.slice(o,o+17)),crcOk:o+17<sz&&data[o+17]===crc8rf(data.slice(o,o+17))};return null;}).filter(v=>v);
      if(knownVins.length>0)info.vins=knownVins;
      else{info.vins=[];for(const o of knownOffsets){if(o+17>sz)continue;const st=data.slice(o,o+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);if(/^[1-9A-HJ-NPR-Z]/.test(s)){const sc=o+17<sz?data[o+17]:0,cc=crc8rf(st);info.vins.push({offset:o,vin:s,mirrored:true,sc,cc,crcOk:sc===cc});}}}
    }
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
    if(sz>=0x92+19){
      const raw17=data.slice(0x92,0x92+17);
      const notBlank=!raw17.every(b=>b===0xFF||b===0x00);
      if(notBlank){let s='';for(let i=0;i<17;i++)s+=String.fromCharCode(raw17[i]);
        const sc=(data[0x92+17]<<8)|data[0x92+18];const cc=crc16(raw17);
        if(/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))
          info.rfhVin92={offset:0x92,vin:s,storedCs:sc,calcCs:cc,csOk:sc===cc};
      }
    }
    info.sec16s=[];
    for(const[slot,off]of[[1,0xAE],[2,0xC0]]){
      if(off+18>sz)continue;
      const raw=data.slice(off,off+16);
      const cs=(data[off+16]<<8)|data[off+17];
      const blank=raw.every(b=>b===0xFF||b===0x00);
      const hex=Array.from(raw).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
      let csCalc=0;for(let i=0;i<16;i++)csCalc^=raw[i];csCalc=(csCalc<<8)|csCalc;
      info.sec16s.push({slot,offset:off,raw,hex,cs,csCalc,blank});
    }
    if(info.sec16s.length===2){
      info.sec16match=arrEq(Array.from(info.sec16s[0].raw),Array.from(info.sec16s[1].raw));
      info.sec16valid=!info.sec16s[0].blank&&info.sec16match;
    }
    info.rfhGen=sz===4096?'Gen2 (24C32)':sz===8192?'Gen2-x2 (8192B, unusual)':sz===2048?'Gen1 (24C16)':'Unknown';
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
    if(sz>=0x1B95){const v=extractVIN(data,0x1B82);if(v)info.vins.push({offset:0x1B82,vin:v});}
    info.skey=data.slice(0x40,0x50);info.skoff=0x40;info.skb=info.skey.every(b=>b===0xFF);
    info.fobBlank=data.slice(0x200,0x240).every(b=>b===0xFF);
    if(sz>=0x84A){
      const raw16=data.slice(0x838,0x848);
      const storedCs=(data[0x848]<<8)|data[0x849];
      const calcCs=crc16(raw16);
      const csOk=storedCs===calcCs;
      const blank=raw16.every(b=>b===0xFF||b===0x00);
      const hex=Array.from(raw16).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
      const reversed=new Uint8Array(16);for(let i=0;i<16;i++)reversed[i]=raw16[15-i];
      const reversedHex=Array.from(reversed).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
      info.bcmSec16={offset:0x838,raw:raw16,hex,reversed,reversedHex,storedCs,calcCs,csOk,blank};
    }
  }

  return info;
}

export {parseModule,countSkimRecs,syncImmoBackup,extractVIN,extractHex,arrEq,detectBySignature,fO};
