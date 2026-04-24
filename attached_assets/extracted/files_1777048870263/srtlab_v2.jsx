import React, { useState, useMemo, useCallback } from "react";

/* ═══ SRT LAB v2 — REAL DATA EDITION ═══
   36 bins · 10 VINs · 5 SEC16 chains · 12 algos */

/* ═══ CRYPTO ═══ */
const u32=n=>n>>>0;
function sxor(s,c){let k=u32(s);for(let i=0;i<5;i++)k=k&0x80000000?u32((k<<1)^u32(c)):u32(k<<1);return k;}
function cda6(s){let k=u32(s);k=u32(k^0x4B129F);k=u32((k<<3)|(k>>>29));k=u32(k+0x1234);k=u32(k^0xABCD);return u32((k>>>5)|(k<<27));}
const NT=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31],NS=[0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
function ngc(s){let k=0;for(let i=0;i<4;i++){let b=(u32(s)>>(i*8))&0xFF;k=u32(k^u32(((NT[b&0xF]^NT[(b>>4)&0xF])*NS[i%8])&0xFFFFFFFF));}return k;}
const TT={a:[0x727B,0xB301,0x08EB,0xB0BA,0xECA7,0x0ECC,0xD69A,0xE47E],b:[0x7A44,0x0201,0xF123,0x146E,0xCBC2,0x553F,0xD398,0x4EDC]};
const TM=[0xBAEE,0xE000,0x1C00,0x0380,0x0070,0x0007];
function tipm(s,t='a'){const tb=TT[t]||TT.a;let v=s&0xFFFF,k=0;for(let i=0;i<tb.length;i++){let m=v&TM[i%TM.length],b=0,x=m;while(x){b^=x&1;x>>=1;}k=(k<<1)|b;k^=tb[i];k&=0xFFFF;}return k;}
function cfGPEC(sd){const KB=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x33];function sk(b){let x=KB[b+3]<<3;x^=KB[b+2];x<<=2;x^=KB[b+1];x<<=3;x^=KB[b+0];return x&0xFFFF;}const K=[sk(0),sk(4),sk(8),sk(12)];function sw(x){return(((x&0xFF)<<8)|((x>>>8)&0xFF))&0xFFFF;}let v0=sw((sd>>>16)&0xFFFF),v1=sw(sd&0xFFFF),sum=0;for(let i=0;i<16;i++){sum=(sum+0xFFFF9E37)&0xFFFF;v0=(v0+((((v1<<4)+K[0])^((v1>>>5)+K[1]))^(sum+v1)))&0xFFFF;v1=(v1+((((v0<<4)+K[2])^((v0>>>5)+K[3]))^(sum+v0)))&0xFFFF;}return((sw(v0)<<16)|sw(v1))>>>0;}
const ALGOS=[{id:'cda6',n:'CDA6',h:'BCM/ABS/IPC',fn:s=>cda6(s)},{id:'gpec2',n:'GPEC2',h:'Continental',fn:s=>sxor(s,0xE72E3799)},{id:'gpec3',n:'GPEC3',h:'2018+',fn:s=>sxor(s,0x129D657F)},{id:'gpec2a',n:'GPEC2A',h:'GPEC2A',fn:s=>sxor(s,0xCE853A6F)},{id:'gpec_tea',n:'GPEC TEA',h:'gpec.dll',fn:s=>cfGPEC(s)},{id:'ecm',n:'ECM',h:'0x8A3C71',fn:s=>sxor(s,0x8A3C71)},{id:'tcm',n:'TCM',h:'0x6E4B92',fn:s=>sxor(s,0x6E4B92)},{id:'rfhub',n:'RFHUB',h:'0xD5F1',fn:s=>sxor(s,0xD5F1)},{id:'ngc',n:'NGC',h:'DAIMLERCHRYSLER',fn:s=>ngc(s)},{id:'t80',n:'TIPM 0x80',h:'t8001',fn:s=>tipm(s,'a')},{id:'t36',n:'TIPM 0x36',h:'t3605',fn:s=>tipm(s,'b')},{id:'gpec15',n:'GPEC 2015',h:'2015-18',fn:s=>sxor(s,0x47EC21F8)}];

/* ═══ VIN ═══ */
const TR={A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9};for(let d=0;d<=9;d++)TR[String(d)]=d;
const WT=[8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
const WMI={'1C4':'Chrysler/Jeep','2C3':'Dodge CA','2B3':'Dodge CA'};
const YR={A:2010,B:2011,C:2012,D:2013,E:2014,F:2015,G:2016,H:2017,J:2018,K:2019,L:2020,M:2021,N:2022};
function decVin(v){if(!v||v.length!==17)return null;let sum=0;for(let i=0;i<17;i++)sum+=(TR[v[i]]||0)*WT[i];const cd='0123456789X'[sum%11];return{ok:v[8]===cd,mfr:WMI[v.slice(0,3)]||'',yr:YR[v[9]]||''};}

/* ═══ FILE ENGINE ═══ */
function crc16(d,init=0xFFFF){let c=init;for(let x=0;x<d.length;x++){c^=d[x]<<8;for(let j=0;j<8;j++)c=c&0x8000?(c<<1)^0x1021:c<<1;c&=0xFFFF;}return c;}
const hxb=d=>Array.from(d).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');

function analyzeFile(buf,name){
  const data=new Uint8Array(buf),sz=data.length,nl=name.toUpperCase();
  let type='UNKNOWN';
  if(sz===4194304)type='INT_FLASH';else if(sz===262144||sz===393216)type='P_FLASH';
  else if(nl.includes('GPEC')&&(sz===4096||sz===8192))type='GPEC2A';
  else if(sz===65536)type='BCM';
  else if(sz===4096){let a=true;for(let i=0;i<17&&i<sz;i++)if(data[i]<0x30||data[i]>0x5A){a=false;break;}type=a?'GPEC2A':'RFHUB';}
  else if(sz===8192)type=nl.includes('GPEC')?'GPEC2A':'95640';
  const vins=[];
  if(type==='BCM'){for(let i=0;i<=sz-19;i++){let ok=true;for(let j=0;j<17;j++)if(data[i+j]<0x20||data[i+j]>0x7E){ok=false;break;}if(!ok)continue;let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(data[i+j]);if(!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))continue;const sc=(data[i+17]<<8)|data[i+18],cc=crc16(data.slice(i,i+17));if(sc===cc){vins.push({off:i,vin:s,algo:'CRC16',ok:true});i+=16;}}}
  else if(type==='RFHUB'){for(const off of[0xEA5,0xEB9,0xECD,0xEE1]){if(off+17>sz)continue;const ch=data.slice(off,off+17);if(ch.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=ch[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);if(/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))vins.push({off,vin:s,algo:'REV',ok:true});}}
  else if(type==='GPEC2A'){for(const off of[0,0x1F0,0x224]){if(off+17>sz)continue;let s='',v=true;for(let j=0;j<17;j++){const b=data[off+j];if(b<0x20||b>0x7E){v=false;break;}s+=String.fromCharCode(b);}if(v&&/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))vins.push({off,vin:s,algo:'ASCII',ok:true});}}
  let sec16=null;
  if(type==='RFHUB'){for(const off of[0x050E,0x0226]){if(off+16>sz)continue;const s=data.slice(off,off+16);if(s.every(b=>b===0xFF))continue;sec16={off,val:hxb(s),gen:off===0x050E?'Gen2':'Gen1'};break;}}
  let bcmSec=null;
  if(type==='BCM'){const recs=[];for(const base of[0x81A0,0x81C0,0x81E0]){if(base+32>sz)continue;const rec=data.slice(base,base+32);if(rec.every(b=>b===0xFF))continue;const s=rec.slice(1,17);recs.push({base,stored:hxb(s),allFF:s.every(b=>b===0xFF)});}if(recs.length)bcmSec=recs;}
  let gpecSec=null;
  if(type==='GPEC2A'){gpecSec={skim:sz>0x11?data[0x11]:null};if(sz>0x20B){gpecSec.key=hxb(data.slice(0x203,0x20B));gpecSec.mir=hxb(data.slice(0x361,0x369));gpecSec.km=gpecSec.key===gpecSec.mir;}if(sz>0xC8C)gpecSec.zz=data[0xC8C]===0x5A;for(let off=0;off<sz-10;off++){if(data[off]===0xFF&&data[off+1]===0xFF&&data[off+2]===0xFF&&data[off+3]===0xAA){const s6=data.slice(off+4,off+10);if(!s6.every(b=>b===0xFF)){gpecSec.sec6=hxb(s6);break;}}}}
  return{name,size:sz,type,data,vins,sec16,bcmSec,gpecSec};
}

function patchVin(f,nv){const out=new Uint8Array(f.data);const vb=new TextEncoder().encode(nv.toUpperCase());const log=[];
  for(const s of f.vins){if(s.algo==='REV'){const m=[...vb].reverse();for(let j=0;j<17;j++)out[s.off+j]=m[j];log.push(`0x${s.off.toString(16).toUpperCase()} REV`);}else if(s.algo==='CRC16'){for(let j=0;j<17;j++)out[s.off+j]=vb[j];const c=crc16(vb);out[s.off+17]=(c>>8)&0xFF;out[s.off+18]=c&0xFF;log.push(`0x${s.off.toString(16).toUpperCase()} CRC16`);}else{for(let j=0;j<17;j++)out[s.off+j]=vb[j];log.push(`0x${s.off.toString(16).toUpperCase()}`);}}
  return{data:out,log};}

/* ═══ REAL DATA ═══ */
const DB=[{n:"ZO_BCM_SYNCED_KH728648",t:"BCM",s:"64KB",v:"2C3CDXGJ3KH728648",sec:"E2C19713BDD60C04",sn:"OLD donor SEC16 — MISMATCH",a:true,tg:"ZO"},{n:"21DFLASH_SCAT392_OG_ZO",t:"BCM",s:"64KB",v:"2C3CDXHG5EH219538",sec:"E2C19713BDD60C04",sn:"Donor VIN+SEC16",tg:"DONOR"},{n:"21DFLASH_SCAT392_OG_ZO_EDIT",t:"BCM",s:"64KB",v:"2C3CDXGJ3KH728648",sec:"E2C19713BDD60C04",sn:"VIN patched, SEC16 NOT updated",a:true,tg:"EDIT"},{n:"BCM_797_SYNC",t:"BCM",s:"64KB",v:"2C3CDXGJ3KH728648",sec:"DA69698916EC4504",sn:"✓ AB8015...",tg:"SYNC"},{n:"BCM_DFLASH_OG",t:"BCM",s:"64KB",v:"2C3CDXGJ3KH728648",sec:"DA69698916EC4504",sn:"✓ AB8015...",tg:"OG"},{n:"22_797BCM_VIRGIN",t:"BCM",s:"64KB",v:"2C3CDXCT1HH652640",sec:"2AC740845C415A04",sn:"✓ 816531...",tg:"VIRGIN"},{n:"BCM_HERMANADO_797",t:"BCM",s:"64KB",v:"2C3CDXCT1HH652640",sec:"DA69698916EC4504",sn:"✓ AB8015...",tg:"HERM"},{n:"BCM_HERMANADO²_797",t:"BCM",s:"64KB",v:"2C3CDXCT1HH652640",sec:"DA69698916EC4504",sn:"✓ AB8015...",tg:"HERM²"},{n:"VIN_CRC_797BCM_GH203366",t:"BCM",s:"64KB",v:"2C3CDXL95GH203366",sec:"2AC740845C415A04",sn:"✓ 816531...",tg:"CRC"},{n:"18_TRACKHAWK_BCM",t:"BCM",s:"64KB",v:"1C4RJFN99JC198740",sec:"(all FF)",sn:"No flash SEC16",tg:"TH"},{n:"18_TRACKHAWK_BCM_PATCHED",t:"BCM",s:"64KB",v:"1C4RJEAG9HC748138",sec:"(all FF)",sn:"No flash SEC16",tg:"TH²"},{n:"17SCAT_RAMON_BCM",t:"BCM",s:"64KB",v:"2C3CDXHG7GH214845",sec:"(all FF — gen1)",sn:"Gen1 no SEC16",tg:"17"},{n:"17SCAT_RAMON_EDIT",t:"BCM",s:"64KB",v:"2C3CDXEJ1FH857853",sec:"(all FF — gen1)",sn:"Gen1 no SEC16",tg:"17E"},
{n:"19_rfhub_EEE_OG",t:"RFH",s:"4KB",v:"2C3CDXGJ3KH728648",r16:"AB8015D77ED943C1AB45EC16896969DA",g:"G2",tg:"OG"},{n:"20CHRGR_RFHUB_OG",t:"RFH",s:"4KB",v:"2C3CDXCT1HH652640",r16:"AB8015D77ED943C1AB45EC16896969DA",g:"G2",tg:"OG"},{n:"20SCAT_RFHUB_ZO",t:"RFH",s:"4KB",v:"2C3CDXGJ3KH728648",r16:"CBBABBA95CB6303CDC876DB0330C0C51",g:"G2",tg:"ZO",a:true},{n:"21RFHUB_VIRGIN",t:"RFH",s:"4KB",v:"2C3CDXGJ3KH728648",r16:"816531F7CDE32E33C25A415C8440C72A",g:"G2",tg:"VIR"},{n:"22_797RFHUB_OG",t:"RFH",s:"4KB",v:"2C3CDXGJXNH176487",r16:"816531F7CDE32E33C25A415C8440C72A",g:"G2",tg:"OG"},{n:"FIXED_RFH_ZO",t:"RFH",s:"4KB",v:"2C3CDXGJ3KH728648",r16:"AB8015D77ED943C1AB45EC16896969DA",g:"G2",tg:"FIX"},{n:"RFH_HERM_19",t:"RFH",s:"4KB",v:"2C3CDXGJ3KH728648",r16:"AB8015D77ED943C1AB45EC16896969DA",g:"G2",tg:"H19"},{n:"RFH_HERM_20CHRGR",t:"RFH",s:"4KB",v:"2C3CDXCT1HH652640",r16:"AB8015D77ED943C1AB45EC16896969DA",g:"G2",tg:"H20"},{n:"VIN_CRC_797RFHUB",t:"RFH",s:"4KB",v:"2C3CDXL95GH203366",r16:"816531F7CDE32E33C25A415C8440C72A",g:"G2",tg:"CRC"},{n:"ZO_RFH_SYNCED_VIRGIN",t:"RFH",s:"4KB",v:"2C3CDXGJ3KH728648",r16:"CBBABBA95CB6303CDC876DB0330C0C51",g:"G2",tg:"ZO",a:true},{n:"17RFHUB_EEE_OG",t:"RFH",s:"4KB",v:"2C3CDXHG7GH214845",r16:"01042B11E7070B0103FFFFFFFFFFFF03",g:"G2",tg:"17"},{n:"angelrfhubog",t:"RFH",s:"4KB",v:"2B3CL5CT4BH572163",r16:"3685E20BA71FEF592144710B488A6B5A",g:"G1",tg:"ANG"},{n:"immovin_ad60",t:"RFH",s:"4KB",v:"2C3CDXGJ3KH728648",r16:"CBBABBA95CB6303CDC876DB0330C0C51",g:"G2",tg:"IMM"},{n:"immovin_f1bf",t:"RFH",s:"4KB",v:"2C3CDXEJ1FH857853",r16:"01042B11E7070B0103FFFFFFFFFFFF03",g:"G2",tg:"IMM"},
{n:"GPEC2A_ramtrx",t:"GPEC",s:"4KB",v:"2C3CDXGJ3KH728648",sk:"OFF",km:true,s6:"AB8015D77ED9",tg:"RTX"},{n:"GPEC2A_FH857853",t:"GPEC",s:"4KB",v:"2C3CDXEJ1FH857853",sk:"OFF",km:false,tg:"OG"},{n:"GPEC2A_Jailbreak",t:"GPEC",s:"8KB",v:"2C3CDXCT1HH652640",sk:"OFF",km:true,s6:"AB8015D77ED9",tg:"JB"},{n:"GPEC2A_OGZO",t:"GPEC",s:"4KB",v:"2C3CDXGJ3KH728648",sk:"OFF",km:true,s6:"CBBABBA95CB6",tg:"ZO"},{n:"GPEC2A_OG_FILES",t:"GPEC",s:"4KB",v:"2C3CDXGJ3KH728648",sk:"OFF",km:true,s6:"AB8015D77ED9",tg:"OG"},{n:"GPEC2A_ramtrx2",t:"GPEC",s:"4KB",v:"2C3CDXGJ3KH728648",sk:"OFF",km:true,s6:"AB8015D77ED9",tg:"RTX²"},
{n:"20CHRGR_P-FLASH",t:"FW",s:"384KB",v:"—",tg:"PF"},{n:"AGNRFHUBPFLASH",t:"FW",s:"256KB",v:"—",tg:"PF"},{n:"GPEC2A_INT_FLASH",t:"FW",s:"4096KB",v:"—",tg:"IF"}];

const CHAINS=[
  {id:'A',sec:'AB8015D77ED943C1AB45EC16896969DA',label:'Chain A — Primary Fleet',c:'#FF6D00',rfh:5,bcm:4,gpec:4,s6:'AB8015D77ED9',st:'VERIFIED'},
  {id:'B',sec:'CBBABBA95CB6303CDC876DB0330C0C51',label:'Chain B — ZO Vehicle',c:'#D32F2F',rfh:3,bcm:0,gpec:1,s6:'CBBABBA95CB6',st:'BROKEN',alert:true,note:'BCMs still have donor SEC16 E2C197...'},
  {id:'C',sec:'816531F7CDE32E33C25A415C8440C72A',label:'Chain C — 22 Redeye Virgin',c:'#2979FF',rfh:3,bcm:2,gpec:0,s6:'816531F7CDE3',st:'VERIFIED'},
  {id:'D',sec:'01042B11E7070B0103FFFFFFFFFFFF03',label:'Chain D — 17 Scat',c:'#AA00FF',rfh:2,bcm:0,gpec:0,s6:'01042B11E707',st:'GEN1',note:'Gen1 BCMs have no flash SEC16'},
  {id:'E',sec:'3685E20BA71FEF592144710B488A6B5A',label:'Chain E — Angel',c:'#00BFA5',rfh:1,bcm:0,gpec:0,s6:'3685E20BA71F',st:'ORPHAN'},
];

const VINS=[{v:'2C3CDXGJ3KH728648',a:'ZO',y:2019,b:'Scat Pack',r:54,p:true},{v:'2C3CDXCT1HH652640',a:'22 Redeye',y:2017,b:'Charger 6.2',r:23},{v:'2C3CDXHG7GH214845',a:'Ramon',y:2016,b:'17 Scat',r:8},{v:'2C3CDXEJ1FH857853',a:'Edit target',y:2015,b:'Charger',r:11},{v:'2C3CDXL95GH203366',a:'VIN CRC',y:2016,b:'Charger',r:8},{v:'1C4RJFN99JC198740',a:'TH OG',y:2018,b:'Trackhawk',r:4},{v:'1C4RJEAG9HC748138',a:'TH patch',y:2017,b:'Trackhawk',r:4},{v:'2C3CDXHG5EH219538',a:'ZO Donor',y:2014,b:'Charger',r:4},{v:'2C3CDXGJXNH176487',a:'22 RFH',y:2022,b:'Charger',r:4},{v:'2B3CL5CT4BH572163',a:'Angel',y:2011,b:'Charger',r:4}];

/* ═══ DESIGN ═══ */
const C={bg:'#08080C',cd:'#111116',c2:'#18181F',sr:'#D32F2F',a1:'#FF6D00',a2:'#00BFA5',a3:'#2979FF',a4:'#AA00FF',tx:'#E0DDD8',ts:'#777',tm:'#444',bd:'#252530',gn:'#00C853',wn:'#FFB300',er:'#FF1744'};
const TC={BCM:'#FF6D00',RFH:'#2979FF',GPEC:'#00BFA5',FW:'#777'};

function T({children,color=C.sr,sm}){return<span style={{fontSize:sm?7:8,fontWeight:800,padding:sm?'1px 4px':'2px 6px',borderRadius:4,background:color+'18',color,letterSpacing:.3,display:'inline-block',lineHeight:1.4}}>{children}</span>;}
function Btn({children,onClick,disabled,color=C.sr,full,outline,sm}){const[h,setH]=useState(false);return<button onClick={onClick} disabled={disabled} onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)} style={{padding:sm?'4px 8px':'7px 14px',borderRadius:6,fontWeight:800,fontSize:sm?8:10,border:outline?`1.5px solid ${color}44`:'none',cursor:disabled?'not-allowed':'pointer',background:disabled?'#333':outline?(h?color+'12':'transparent'):(h?color:color+'CC'),color:disabled?'#555':outline?color:'#fff',width:full?'100%':undefined,transition:'all .15s',letterSpacing:.4,fontFamily:'inherit'}}>{children}</button>;}

const TABS=[{id:'dash',i:'📊',l:'DASHBOARD'},{id:'inv',i:'📂',l:'INVENTORY'},{id:'sec',i:'🔗',l:'SEC16'},{id:'vins',i:'🚗',l:'VIN MAP'},{id:'seed',i:'🔑',l:'SEED→KEY'},{id:'live',i:'📤',l:'LIVE ANALYZE'}];

export default function App(){
  const[tab,setTab]=useState('dash');
  return(
    <div style={{minHeight:'100vh',background:C.bg,color:C.tx,fontFamily:'"JetBrains Mono",ui-monospace,monospace'}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0;}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}@keyframes f{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{background:'linear-gradient(135deg,#0A0A0F,#141418 50%,#1A0A0A)',borderBottom:`1px solid ${C.bd}`,position:'sticky',top:0,zIndex:100}}>
        <div style={{maxWidth:1200,margin:'0 auto',padding:'8px 16px',display:'flex',alignItems:'center',gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:'linear-gradient(135deg,#FF5252,#8B0000)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:15,color:'#fff',fontWeight:900,boxShadow:'0 4px 16px rgba(211,47,47,0.4)'}}>S</div>
          <div style={{flex:1}}><div style={{fontSize:14,fontWeight:900,letterSpacing:3,color:'#fff'}}>SRT LAB</div><div style={{fontSize:6,letterSpacing:4,color:'rgba(255,255,255,0.2)',fontWeight:700}}>36 DUMPS · 10 VINS · 5 SEC16 CHAINS</div></div>
          <span style={{width:5,height:5,borderRadius:'50%',background:C.gn,boxShadow:`0 0 6px ${C.gn}`,animation:'p 2s infinite'}}/><span style={{fontSize:7,color:C.ts}}>v2 JAILBREAK</span>
        </div>
        <div style={{maxWidth:1200,margin:'0 auto',display:'flex',gap:1,padding:'0 16px',overflowX:'auto'}}>
          {TABS.map(t=>{const a=tab===t.id;return<button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'6px 10px 8px',border:'none',cursor:'pointer',background:a?C.bg:'transparent',borderRadius:'6px 6px 0 0',color:a?C.sr:'rgba(255,255,255,0.25)',fontWeight:a?900:600,fontSize:8,letterSpacing:.6,transition:'all .15s',whiteSpace:'nowrap',fontFamily:'inherit',display:'flex',alignItems:'center',gap:3}}><span style={{fontSize:10}}>{t.i}</span>{t.l}</button>;})}
        </div>
      </div>
      <div style={{maxWidth:1200,margin:'0 auto',padding:'14px 16px 50px'}}>
        {tab==='dash'&&<Dash/>}{tab==='inv'&&<Inv/>}{tab==='sec'&&<Sec/>}{tab==='vins'&&<Vmap/>}{tab==='seed'&&<Seed/>}{tab==='live'&&<Live/>}
      </div>
    </div>);
}

function Dash(){
  const stats=[{n:'Files',v:'36',c:C.sr},{n:'BCM',v:'13',c:C.a1},{n:'RFHUB',v:'14',c:C.a3},{n:'GPEC2A',v:'6',c:C.a2},{n:'Firmware',v:'3',c:C.ts},{n:'VINs',v:'10',c:C.a4},{n:'SEC16 Chains',v:'5',c:C.wn},{n:'Seed Algos',v:'12',c:C.gn}];
  return(<div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14}}>
      {stats.map((s,i)=><div key={i} style={{padding:12,borderRadius:8,background:C.cd,border:`1px solid ${C.bd}`,animation:'f .3s ease-out',animationDelay:`${i*.04}s`,animationFillMode:'both'}}>
        <div style={{fontSize:20,fontWeight:900,color:s.c}}>{s.v}</div><div style={{fontSize:8,fontWeight:800,color:C.tx,marginTop:1}}>{s.n}</div>
      </div>)}
    </div>
    <div style={{padding:14,borderRadius:10,background:'#1A0808',border:`1.5px solid ${C.er}33`,marginBottom:14}}>
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}><span style={{fontSize:14}}>⚠️</span><span style={{fontSize:11,fontWeight:900,color:C.er}}>ZO VEHICLE — SEC16 CHAIN BROKEN</span></div>
      <div style={{fontSize:9,lineHeight:1.7,color:C.ts}}>
        <span style={{color:C.tx,fontWeight:700}}>2C3CDXGJ3KH728648</span> — ZO BCMs contain <span style={{color:C.wn,fontWeight:700}}>donor SEC16 (E2C197...)</span> from ...EH219538<br/>
        ZO RFH SEC16 = <span style={{color:C.a1,fontWeight:700}}>CBBABBA95CB6...</span><br/>
        BCM needs: <span style={{color:C.gn,fontWeight:700}}>510C0C33B06D87DC3C30B65CA9BBBACB</span> (reversed)<br/>
        <span style={{color:C.ts}}>→ This is why FOBIK enrollment fails</span>
      </div>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
      {CHAINS.map(ch=><div key={ch.id} style={{padding:10,borderRadius:8,background:C.cd,border:`1.5px solid ${ch.alert?C.er+'44':ch.c+'33'}`}}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span style={{fontSize:9,fontWeight:800,color:ch.c}}>{ch.label}</span><T color={ch.st==='VERIFIED'?C.gn:ch.st==='BROKEN'?C.er:C.wn} sm>{ch.st}</T></div>
        <div style={{fontSize:7,color:C.ts,wordBreak:'break-all'}}>{ch.sec.slice(0,20)}...</div>
        <div style={{display:'flex',gap:2,marginTop:3}}><T color={C.a3} sm>{ch.rfh}R</T><T color={C.a1} sm>{ch.bcm}B</T><T color={C.a2} sm>{ch.gpec}G</T></div>
      </div>)}
    </div>
  </div>);
}

function Inv(){
  const[f,sF]=useState('ALL');
  const types=['ALL','BCM','RFH','GPEC','FW'];
  const fl=f==='ALL'?DB:DB.filter(x=>x.t===f);
  return(<div>
    <div style={{display:'flex',gap:3,marginBottom:10,flexWrap:'wrap'}}>{types.map(t=><Btn key={t} onClick={()=>sF(t)} color={TC[t]||C.sr} outline={f!==t} sm>{t} ({t==='ALL'?DB.length:DB.filter(x=>x.t===t).length})</Btn>)}</div>
    <div style={{display:'grid',gap:4}}>
      {fl.map((d,i)=><div key={i} style={{padding:8,borderRadius:6,background:C.cd,border:`1px solid ${d.a?C.er+'44':C.bd}`,display:'grid',gridTemplateColumns:'200px 1fr auto',gap:8,alignItems:'center',fontSize:8}}>
        <div><div style={{display:'flex',gap:2,marginBottom:2}}><T color={TC[d.t]||C.ts} sm>{d.t}</T><T color={d.a?C.er:C.tm} sm>{d.tg}</T></div><div style={{fontWeight:700,color:C.tx,fontSize:8}}>{d.n}</div><div style={{color:C.tm,fontSize:7}}>{d.s}</div></div>
        <div>{d.v&&d.v!=='—'&&<div style={{color:C.a1,fontWeight:700,letterSpacing:.5}}>{d.v}</div>}{d.r16&&<div style={{fontSize:6,color:C.a3,wordBreak:'break-all',marginTop:1}}>SEC16: {d.r16}</div>}{d.sec&&<div style={{fontSize:6,color:d.a?C.wn:C.ts,marginTop:1}}>BCM: {d.sec}</div>}{d.sn&&<div style={{fontSize:6,color:d.a?C.er:C.gn,marginTop:1}}>{d.sn}</div>}{d.s6&&<div style={{fontSize:6,color:C.a2,marginTop:1}}>SEC6: {d.s6}</div>}</div>
        <div style={{textAlign:'right'}}>{d.sk!==undefined&&<div style={{fontSize:7,color:C.wn}}>SKIM {d.sk}</div>}{d.km!==undefined&&<div style={{fontSize:7,color:d.km?C.gn:C.er}}>KEY {d.km?'✓':'✗'}</div>}</div>
      </div>)}
    </div>
  </div>);
}

function Sec(){
  return(<div>
    <div style={{padding:10,borderRadius:8,background:C.cd,border:`1px solid ${C.bd}`,marginBottom:12,fontSize:8,lineHeight:1.7,color:C.ts}}>
      <span style={{fontWeight:900,color:C.sr}}>SEC16 PAIRING:</span> <span style={{color:C.a3}}>RFH SEC16</span> (16B @ 0x050E) → <span style={{color:C.a1}}>BCM</span> stores <span style={{color:C.tx,fontWeight:700}}>reverse()</span> @ 0x81A0/C0/E0 → <span style={{color:C.a2}}>PCM SEC6</span> = first 6 bytes after FF FF FF AA
    </div>
    {CHAINS.map(ch=><div key={ch.id} style={{padding:12,borderRadius:10,background:C.cd,border:`1.5px solid ${ch.alert?C.er+'55':ch.c+'33'}`,marginBottom:10}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <div style={{display:'flex',alignItems:'center',gap:6}}><div style={{width:8,height:8,borderRadius:2,background:ch.c}}/><span style={{fontSize:10,fontWeight:900,color:ch.c}}>{ch.label}</span></div>
        <T color={ch.st==='VERIFIED'?C.gn:ch.st==='BROKEN'?C.er:C.wn}>{ch.st}</T>
      </div>
      <div style={{padding:6,borderRadius:4,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:6}}>
        <div style={{fontSize:6,color:C.tm,letterSpacing:2}}>SEC16</div>
        <div style={{fontSize:9,fontWeight:800,color:ch.c,letterSpacing:.8,wordBreak:'break-all',fontFamily:'monospace'}}>{ch.sec}</div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
        <div style={{padding:6,borderRadius:4,background:C.a3+'08',border:`1px solid ${C.a3}18`}}>
          <div style={{fontSize:7,fontWeight:800,color:C.a3,marginBottom:3}}>RFHUB ({ch.rfh})</div>
          {DB.filter(d=>d.t==='RFH'&&d.r16===ch.sec).map(d=><div key={d.n} style={{fontSize:6,color:C.ts,marginBottom:1}}><T color={C.tm} sm>{d.tg}</T> {d.v?.slice(-6)}</div>)}
        </div>
        <div style={{padding:6,borderRadius:4,background:(ch.bcm?C.a1:C.er)+'08',border:`1px solid ${ch.bcm?C.a1:C.er}18`}}>
          <div style={{fontSize:7,fontWeight:800,color:ch.bcm?C.a1:C.er,marginBottom:3}}>BCM ({ch.bcm})</div>
          {ch.bcm?DB.filter(d=>d.t==='BCM'&&d.sec&&!d.sec.startsWith('(')&&!d.a).slice(0,ch.bcm).map(d=><div key={d.n} style={{fontSize:6,color:C.ts,marginBottom:1}}><T color={C.tm} sm>{d.tg}</T> {d.v?.slice(-6)}</div>):null}
          {ch.note&&<div style={{fontSize:6,color:C.er,marginTop:2,fontWeight:700}}>{ch.note}</div>}
        </div>
        <div style={{padding:6,borderRadius:4,background:C.a2+'08',border:`1px solid ${C.a2}18`}}>
          <div style={{fontSize:7,fontWeight:800,color:C.a2,marginBottom:3}}>GPEC SEC6</div>
          <div style={{fontSize:7,color:C.a2,fontWeight:700}}>{ch.s6}</div>
          {DB.filter(d=>d.t==='GPEC'&&d.s6===ch.s6).map(d=><div key={d.n} style={{fontSize:6,color:C.ts,marginBottom:1}}>{d.n}</div>)}
        </div>
      </div>
    </div>)}
  </div>);
}

function Vmap(){
  const[sel,setSel]=useState(null);
  const sf=sel?DB.filter(d=>d.v===sel):[];
  return(<div style={{display:'grid',gridTemplateColumns:'280px 1fr',gap:12,alignItems:'start'}}>
    <div>{VINS.map(v=><div key={v.v} onClick={()=>setSel(v.v)} style={{padding:8,borderRadius:6,background:sel===v.v?C.c2:C.cd,border:`1.5px solid ${sel===v.v?C.a1:C.bd}`,marginBottom:3,cursor:'pointer'}}>
      <div style={{display:'flex',justifyContent:'space-between'}}><span style={{fontSize:8,fontWeight:800,color:sel===v.v?C.a1:C.tx,letterSpacing:.3}}>{v.v}</span><span style={{fontSize:7,color:C.tm}}>{v.r}</span></div>
      <div style={{display:'flex',gap:2,marginTop:2}}><T color={v.p?C.sr:C.tm} sm>{v.a}</T><T color={C.a3} sm>{v.y}</T><T color={C.a2} sm>{v.b}</T></div>
    </div>)}</div>
    <div>{sel?<><div style={{fontSize:10,fontWeight:900,color:C.a1,marginBottom:6,letterSpacing:.8}}>{sel}</div>
      <div style={{display:'grid',gap:3}}>{sf.map((d,i)=><div key={i} style={{padding:6,borderRadius:4,background:C.cd,border:`1px solid ${d.a?C.er+'44':C.bd}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div><div style={{display:'flex',gap:2}}><T color={TC[d.t]||C.ts} sm>{d.t}</T><T color={d.a?C.er:C.tm} sm>{d.tg}</T></div><div style={{fontSize:7,fontWeight:700,color:C.tx,marginTop:1}}>{d.n}</div></div>
        <div style={{textAlign:'right',fontSize:6,color:C.ts}}>{d.r16&&<div style={{color:C.a3}}>{d.r16.slice(0,12)}...</div>}{d.s6&&<div style={{color:C.a2}}>SEC6:{d.s6}</div>}</div>
      </div>)}</div>
    </>:<div style={{padding:30,textAlign:'center',color:C.tm,fontSize:9}}>Select a VIN</div>}</div>
  </div>);
}

function Seed(){
  const[sh,setSh]=useState('');const[al,setAl]=useState('cda6');const[all,setAll]=useState(false);const[res,setRes]=useState(null);
  const calc=()=>{const v=parseInt(sh.replace(/\s/g,''),16);if(isNaN(v))return;if(all)setRes({m:true,s:v.toString(16).toUpperCase().padStart(8,'0'),r:ALGOS.map(a=>({n:a.n,h:a.h,k:a.fn(v).toString(16).toUpperCase().padStart(8,'0')}))});else{const a=ALGOS.find(x=>x.id===al);if(!a)return;setRes({m:false,n:a.n,s:v.toString(16).toUpperCase().padStart(8,'0'),k:a.fn(v).toString(16).toUpperCase().padStart(8,'0')});}};
  return(<div style={{maxWidth:640}}>
    <div style={{padding:14,borderRadius:10,background:C.cd,border:`1.5px solid ${C.bd}`}}>
      <div style={{fontSize:12,fontWeight:900,color:C.sr,marginBottom:3}}>🔑 Seed → Key</div>
      <div style={{fontSize:8,color:C.ts,marginBottom:10}}>{ALGOS.length} FCA security algorithms</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(80px,1fr))',gap:2,marginBottom:10}}>
        {ALGOS.map(a=><div key={a.id} onClick={()=>{setAl(a.id);setAll(false);}} style={{padding:'4px 6px',borderRadius:4,cursor:'pointer',background:al===a.id&&!all?C.sr+'18':C.c2,border:`1px solid ${al===a.id&&!all?C.sr:C.bd}`}}>
          <div style={{fontSize:8,fontWeight:800,color:al===a.id&&!all?C.sr:C.tx}}>{a.n}</div><div style={{fontSize:5,color:C.tm}}>{a.h}</div>
        </div>)}
        <div onClick={()=>setAll(true)} style={{padding:'4px 6px',borderRadius:4,cursor:'pointer',background:all?C.a4+'18':C.c2,border:`1px solid ${all?C.a4:C.bd}`}}>
          <div style={{fontSize:8,fontWeight:800,color:all?C.a4:C.tx}}>ALL</div><div style={{fontSize:5,color:C.tm}}>Run 12</div>
        </div>
      </div>
      <input value={sh} placeholder="SEED HEX" onChange={e=>setSh(e.target.value.toUpperCase().replace(/[^A-F0-9]/g,''))} onKeyDown={e=>{if(e.key==='Enter')calc();}}
        style={{width:'100%',padding:'8px 10px',borderRadius:6,border:`2px solid ${C.bd}`,background:C.c2,color:C.tx,fontSize:14,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box',fontFamily:'monospace'}} onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
      <div style={{marginTop:6}}><Btn onClick={calc} disabled={!sh.trim()} full>Calculate</Btn></div>
      {res&&!res.m&&<div style={{marginTop:12,padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 20px 1fr',alignItems:'center'}}>
          <div><div style={{fontSize:6,color:C.tm}}>SEED</div><div style={{fontSize:16,fontWeight:800,color:C.a3,fontFamily:'monospace'}}>{res.s}</div></div>
          <div style={{textAlign:'center',color:C.tm}}>→</div>
          <div><div style={{fontSize:6,color:C.tm}}>KEY</div><div style={{fontSize:16,fontWeight:800,color:C.sr,fontFamily:'monospace'}}>{res.k}</div></div>
        </div><div style={{fontSize:7,color:C.tm,marginTop:3}}>{res.n}</div>
      </div>}
      {res&&res.m&&<div style={{marginTop:12}}><div style={{fontSize:9,fontWeight:800,marginBottom:4}}>Seed: <span style={{color:C.a3}}>{res.s}</span></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:2}}>{res.r.map((r,i)=><div key={i} style={{padding:'4px 6px',borderRadius:4,background:C.c2,border:`1px solid ${C.bd}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{fontSize:7,fontWeight:800}}>{r.n}</div><div style={{fontSize:9,fontWeight:800,color:C.sr,fontFamily:'monospace'}}>{r.k}</div>
        </div>)}</div>
      </div>}
    </div>
  </div>);
}

function Live(){
  const[files,setFiles]=useState([]);const[sel,setSel]=useState(null);const[nv,setNv]=useState('');const[msg,setMsg]=useState('');
  const loadF=useCallback(fl=>{Promise.all(Array.from(fl).map(f=>new Promise(r=>{const rd=new FileReader();rd.onload=e=>r(analyzeFile(e.target.result,f.name));rd.readAsArrayBuffer(f);}))).then(res=>setFiles(p=>[...p,...res.filter(f=>f.type!=='UNKNOWN')]));},[]);
  const f=sel!==null?files[sel]:null;
  const dl=(d,n)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();};
  const doPatch=()=>{if(!f||nv.length!==17)return;const r=patchVin(f,nv);dl(r.data,'PATCHED_'+nv+'_'+f.name);setMsg(`${r.log.length} patched: ${r.log.join(', ')}`);};
  if(!files.length)return(<div onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin';i.onchange=e=>loadF(e.target.files);i.click();}} onDrop={e=>{e.preventDefault();loadF(e.dataTransfer.files);}} onDragOver={e=>e.preventDefault()} style={{cursor:'pointer'}}>
    <div style={{textAlign:'center',padding:'40px 16px',border:`2px dashed ${C.sr}33`,borderRadius:12,background:C.cd}}>
      <div style={{fontSize:32,marginBottom:6,opacity:.5}}>📤</div><div style={{fontSize:12,fontWeight:900,color:C.sr}}>Drop .bin Files</div>
      <div style={{fontSize:9,color:C.ts,marginTop:3}}>Auto-detects BCM · RFHUB · GPEC2A · Firmware</div>
    </div></div>);
  return(<div style={{display:'grid',gridTemplateColumns:'200px 1fr',gap:12,alignItems:'start'}}>
    <div><Btn onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin';i.onchange=e=>loadF(e.target.files);i.click();}} full sm>+ Add</Btn>
      <div style={{marginTop:6}}>{files.map((fi,i)=><div key={i} onClick={()=>{setSel(i);setMsg('');}} style={{padding:6,borderRadius:6,background:sel===i?C.c2:C.cd,border:`1.5px solid ${sel===i?C.sr:C.bd}`,marginBottom:3,cursor:'pointer'}}>
        <div style={{fontSize:8,fontWeight:800,color:sel===i?C.sr:C.tx,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{fi.name}</div>
        <div style={{display:'flex',gap:2,marginTop:2}}><T color={TC[fi.type]||C.tm} sm>{fi.type}</T><span style={{fontSize:6,color:C.tm}}>{(fi.size/1024).toFixed(0)}K</span></div>
        {fi.vins[0]&&<div style={{fontSize:7,color:C.a1,fontWeight:700,marginTop:1}}>{fi.vins[0].vin}</div>}
      </div>)}</div>
    </div>
    {f&&<div>
      <div style={{padding:12,borderRadius:8,background:C.cd,border:`1px solid ${C.bd}`,marginBottom:8}}>
        <div style={{fontSize:10,fontWeight:900,color:C.sr,marginBottom:6}}>⚡ VIN PATCH</div>
        <input value={nv} maxLength={17} placeholder="17-char VIN" onChange={e=>setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))}
          style={{width:'100%',padding:'6px 8px',borderRadius:6,border:`2px solid ${C.bd}`,background:C.c2,color:C.tx,fontSize:11,fontWeight:700,letterSpacing:2,textAlign:'center',outline:'none',boxSizing:'border-box',fontFamily:'monospace'}} onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:3}}><span style={{fontSize:8,color:nv.length===17?C.gn:C.tm}}>{nv.length}/17</span>
          {nv.length===17&&(()=>{const d=decVin(nv);return d?.ok?<span style={{fontSize:8,color:C.gn}}>✓ {d.mfr} {d.yr}</span>:<span style={{fontSize:8,color:C.er}}>Bad CD</span>;})()}
        </div>
        <div style={{display:'flex',gap:4,marginTop:6}}><Btn onClick={doPatch} disabled={nv.length!==17} sm>⚡ Patch+DL</Btn><Btn onClick={()=>dl(f.data,f.name)} color={C.a3} outline sm>💾 OG</Btn></div>
        {msg&&<div style={{marginTop:4,padding:'4px 6px',borderRadius:4,background:C.gn+'12',fontSize:7,color:C.gn,fontWeight:700}}>✓ {msg}</div>}
      </div>
      <div style={{padding:8,borderRadius:6,background:C.cd,border:`1px solid ${C.bd}`,marginBottom:8}}>
        <div style={{fontSize:9,fontWeight:800,marginBottom:4}}>VINs ({f.vins.length})</div>
        {f.vins.map((v,i)=><div key={i} style={{padding:'3px 5px',borderRadius:3,background:C.c2,marginBottom:1,display:'flex',justifyContent:'space-between',fontSize:7}}>
          <span><span style={{color:C.tm}}>0x{v.off.toString(16).toUpperCase()}</span> <span style={{color:C.a1,fontWeight:800}}>{v.vin}</span></span><T color={C.gn} sm>{v.algo}✓</T>
        </div>)}
      </div>
      {f.sec16&&<div style={{padding:8,borderRadius:6,background:C.cd,border:`1px solid ${C.bd}`,marginBottom:8}}>
        <div style={{fontSize:9,fontWeight:800,marginBottom:3}}>🔐 SEC16</div>
        <div style={{fontSize:7,color:C.a3,wordBreak:'break-all',fontWeight:700}}>{f.sec16.val}</div>
        <div style={{fontSize:6,color:C.tm}}>{f.sec16.gen} @ 0x{f.sec16.off.toString(16).toUpperCase()}</div>
      </div>}
      {f.bcmSec&&<div style={{padding:8,borderRadius:6,background:C.cd,border:`1px solid ${C.bd}`,marginBottom:8}}>
        <div style={{fontSize:9,fontWeight:800,marginBottom:3}}>🔐 BCM SEC16</div>
        {f.bcmSec.map((r,i)=><div key={i} style={{fontSize:7,marginBottom:1}}><span style={{color:C.tm}}>0x{r.base.toString(16).toUpperCase()}: </span><span style={{color:r.allFF?C.wn:C.a1,fontWeight:700,wordBreak:'break-all'}}>{r.allFF?'(FF)':r.stored}</span></div>)}
      </div>}
      {f.gpecSec&&<div style={{padding:8,borderRadius:6,background:C.cd,border:`1px solid ${C.bd}`,marginBottom:8}}>
        <div style={{fontSize:9,fontWeight:800,marginBottom:3}}>🔐 GPEC</div>
        <div style={{fontSize:7}}>SKIM: <T color={f.gpecSec.skim===0x80?C.gn:C.wn} sm>{f.gpecSec.skim===0x80?'ON':'OFF'}</T></div>
        {f.gpecSec.key&&<div style={{fontSize:7,marginTop:1}}>Key: <span style={{color:C.a2}}>{f.gpecSec.key}</span> {f.gpecSec.km?<T color={C.gn} sm>✓</T>:<T color={C.er} sm>✗</T>}</div>}
        {f.gpecSec.sec6&&<div style={{fontSize:7,marginTop:1}}>SEC6: <span style={{color:C.a2,fontWeight:700}}>{f.gpecSec.sec6}</span></div>}
      </div>}
      <div style={{padding:8,borderRadius:6,background:C.cd,border:`1px solid ${C.bd}`}}>
        <div style={{fontSize:9,fontWeight:800,marginBottom:3}}>HEX</div>
        <div style={{fontSize:7,background:C.c2,borderRadius:4,padding:4,maxHeight:180,overflow:'auto',fontFamily:'monospace',lineHeight:1.5}}>
          {Array.from({length:Math.min(20,Math.ceil(f.size/16))},(_,row)=>{const a=row*16;const bs=f.data.slice(a,Math.min(a+16,f.size));const iv=f.vins.some(v=>a+16>v.off&&a<v.off+17);return<div key={row} style={{display:'flex',gap:3,background:iv?'rgba(211,47,47,0.04)':'transparent'}}>
            <span style={{color:C.tm,minWidth:32,fontSize:6}}>{a.toString(16).toUpperCase().padStart(6,'0')}</span>
            <span style={{flex:1,fontSize:6,wordBreak:'break-all'}}>{Array.from(bs).map((b,j)=>{const isV=f.vins.some(v=>(a+j)>=v.off&&(a+j)<v.off+17);return<span key={j} style={{color:isV?C.sr:b===0xFF?'#1A1A1A':C.ts}}>{b.toString(16).toUpperCase().padStart(2,'0')} </span>;})}</span>
          </div>;})}
        </div>
      </div>
    </div>}
  </div>);
}
