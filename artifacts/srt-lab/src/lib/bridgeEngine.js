/* bridgeEngine — wraps the local J2534 HTTP bridge daemon (j2534_bridge.py)
   into the same `{ok, d, raw}` UDS interface that initAdapter exposes.

   When a VIN's model year requires FCA Secure-Gateway (vinHasSGW), the BCM /
   RFHUB / ECM / ADCM tabs route their writes through this engine so the Autel
   MaxiFlash cable performs SGW authentication. If the bridge daemon is not
   reachable, createBridgeEngine() returns null with an error message logged
   via addLog and the caller MUST abort the write. */

import {getStatus, open as openBridge, connect as bridgeConnect, setFilter, sendMsg, readMsg, getAutelState} from './bridgeClient.js';

const PROTOCOL_ISO15765 = 6;
const ISO15765_FRAME_PAD = 0x40;

function hexToBytes(hex){
  if(!hex)return [];
  const clean=String(hex).replace(/\s+/g,'');
  const out=[];
  for(let i=0;i+1<clean.length;i+=2){
    const b=parseInt(clean.substr(i,2),16);
    if(!isNaN(b))out.push(b);
  }
  return out;
}

function bytesToHex(arr){
  return Array.from(arr).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
}

/* Build a uds-compatible engine on top of the bridge daemon.
   Returns { ok:true, engine } on success or { ok:false, error } on failure.
   The caller is expected to:
     - check sgwReq before calling
     - log the error and abort the write when ok===false */
export async function createBridgeEngine({addLog, url}={}){
  const bridgeUrl=url||getAutelState().url;
  const log=(m,t='info')=>{try{addLog&&addLog(m,t);}catch{}};

  log('SGW required → routing UDS through Autel J2534 bridge ('+bridgeUrl+')','info');
  const st=await getStatus(bridgeUrl);
  if(!st||!st.ok){
    return {ok:false,error:'J2534 bridge not reachable: '+(st?.error||'no response')};
  }
  const isOpen=st.opened||st.deviceOpen;
  const isConnected=st.connected||st.channelConnected;
  if(!isOpen){
    log('Opening bridge device...','info');
    const o=await openBridge(bridgeUrl);
    if(!o.ok)return {ok:false,error:'Bridge /open failed: '+(o.error||'unknown')};
  }
  if(!isConnected){
    log('Connecting ISO15765 channel @ 500 kbit/s...','info');
    const c=await bridgeConnect({protocol:PROTOCOL_ISO15765,flags:0,baudrate:500000},bridgeUrl);
    if(!c.ok)return {ok:false,error:'Bridge /connect failed: '+(c.error||'unknown')};
  }
  log('✓ Bridge ready — vendor: '+(st.vendor||'unknown')+(st.versions?.firmware?' fw '+st.versions.firmware:''),'rx');

  let lastTx=-1,lastRx=-1;

  const uds=async(tx,rx,data,timeoutMs)=>{
    const tm=timeoutMs||(data.length>7?8000:4000);
    if(tx!==lastTx||rx!==lastRx){
      const f=await setFilter({txId:tx,rxId:rx},bridgeUrl);
      if(!f.ok)return {ok:false,raw:'bridge setFilter: '+(f.error||'failed')};
      lastTx=tx;lastRx=rx;
    }
    const dataHex=bytesToHex(data);
    const sm=await sendMsg({txId:tx,data:dataHex,flags:ISO15765_FRAME_PAD,timeoutMs:1000},bridgeUrl);
    if(!sm.ok)return {ok:false,raw:'bridge sendMsg: '+(sm.error||'failed')};
    const deadline=Date.now()+tm;
    while(Date.now()<deadline){
      const remaining=deadline-Date.now();
      const slice=Math.min(1500,Math.max(150,remaining));
      const r=await readMsg({timeoutMs:slice},bridgeUrl);
      if(!r||!r.ok)return {ok:false,raw:'bridge readMsg: '+(r?.error||'failed')};
      const m=r.msg;
      if(!m||!m.data)continue;
      if(typeof m.canId==='number'&&rx&&m.canId!==rx){
        // Drop TX echoes / messages from other modules
        continue;
      }
      const bytes=hexToBytes(m.data);
      if(!bytes.length)continue;
      // 0x7F xx 0x78 = response pending — keep waiting
      if(bytes.length>=3&&bytes[0]===0x7F&&bytes[2]===0x78)continue;
      return {ok:true,d:new Uint8Array(bytes),raw:m.data};
    }
    return {ok:false,raw:'bridge: timeout after '+tm+'ms'};
  };

  return {
    ok:true,
    engine:{
      uds,
      adapter:'Autel J2534 ('+(st.vendor||'bridge')+')',
      readVoltage:async()=>null,
      isBridge:true,
      // Task #488 — surface bridge vendor + firmware so the ECM
      // flasher can render them in its bench banner.
      vendor: st.vendor || null,
      firmware: (st.versions && st.versions.firmware) || null,
      versions: st.versions || null,
    },
  };
}

/* Re-issue the extended-session + seed/key unlock on a freshly-routed engine
   (typically the bridge engine returned by createBridgeEngine). The unlock the
   tech ran on the simulator/ELM channel does not carry over once SGW routing
   flips us to the Autel cable, so we must re-run it on the bridge channel
   before the first 2E write or the module will reject with an NRC.

   algoFn(seed:number) -> number  computes the key from the seed, using the
   same algorithm that succeeded on the sim channel.

   Returns {ok:true} on success or {ok:false, error, nrc?} on failure. */
export async function reUnlockSeedKey(engine,tx,rx,algoFn,{addLog,hx}={}){
  const log=(m,t='info')=>{try{addLog&&addLog(m,t);}catch{}};
  const _hx=hx||((n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0'));
  if(!engine||typeof engine.uds!=='function')return {ok:false,error:'no engine'};
  if(typeof algoFn!=='function')return {ok:false,error:'no unlock algorithm available — run sim-channel unlock first'};
  log('Re-running unlock on bridge channel (10 03)...','info');
  const ds=await engine.uds(tx,rx,[0x10,0x03]);
  if(!ds.ok)return {ok:false,error:'bridge 10 03 failed: '+(ds.raw||'no response')};
  if(ds.d&&ds.d[0]===0x7F){
    const nrc=ds.d.length>2?ds.d[2]:0;
    return {ok:false,nrc,error:'bridge 10 03 NRC 0x'+_hx(nrc)};
  }
  log('Requesting seed on bridge (27 01)...','info');
  const s=await engine.uds(tx,rx,[0x27,0x01]);
  if(!s||!s.ok||!s.d||s.d.length===0)return {ok:false,error:'bridge 27 01 failed: '+(s?.raw||'no response')};
  if(s.d[0]===0x7F){
    const nrc=s.d.length>2?s.d[2]:0;
    return {ok:false,nrc,error:'bridge 27 01 NRC 0x'+_hx(nrc)};
  }
  if(s.d.length<4)return {ok:false,error:'bridge 27 01 short response: '+(s.raw||'')};
  const sb=Array.from(s.d).slice(-4);
  let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=sv>>>0;
  log('Bridge seed: 0x'+_hx(sv,8),'info');
  const k=(algoFn(sv)>>>0);
  log('Bridge key: 0x'+_hx(k,8),'info');
  const r=await engine.uds(tx,rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
  if(r.ok&&r.d&&r.d[0]===0x67){log('✓ Bridge channel unlocked','rx');return {ok:true};}
  if(r.ok&&r.d&&r.d[0]===0x7F){
    const nrc=r.d.length>2?r.d[2]:0;
    return {ok:false,nrc,error:'bridge 27 02 NRC 0x'+_hx(nrc)};
  }
  return {ok:false,error:'bridge 27 02 no response: '+(r?.raw||'')};
}

/* Re-run an ADCM-style routine unlock (Routine 0x0312) on the bridge channel,
   with SBEC seed/key fallback that matches AdcmTab.startRoutine(). */
export async function reUnlockAdcmRoutine(engine,tx,rx,{addLog,hx}={}){
  const log=(m,t='info')=>{try{addLog&&addLog(m,t);}catch{}};
  const _hx=hx||((n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0'));
  if(!engine||typeof engine.uds!=='function')return {ok:false,error:'no engine'};
  log('Re-running ADCM unlock on bridge channel (10 03)...','info');
  await engine.uds(tx,rx,[0x10,0x03]);
  await engine.uds(tx,rx,[0x3E,0x80]);
  const r=await engine.uds(tx,rx,[0x31,0x01,0x03,0x12]);
  if(r.ok&&r.d&&r.d[0]===0x71){log('✓ Bridge ADCM routine 0x0312 accepted','rx');return {ok:true};}
  if(r.ok&&r.d&&r.d[0]===0x7F)log('Bridge routine 0x0312 NRC 0x'+_hx(r.d[2]||0)+' — falling back to SBEC seed/key','warn');
  const s=await engine.uds(tx,rx,[0x27,0x01]);
  if(!s||!s.ok||!s.d||s.d.length===0)return {ok:false,error:'bridge 27 01 failed: '+(s?.raw||'no response')};
  if(s.d[0]===0x7F){
    const nrc=s.d.length>2?s.d[2]:0;
    return {ok:false,nrc,error:'bridge 27 01 NRC 0x'+_hx(nrc)};
  }
  if(s.d.length<4)return {ok:false,error:'bridge 27 01 short response: '+(s.raw||'')};
  const sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=sv>>>0;
  log('Bridge seed: 0x'+_hx(sv,8),'info');
  const k=((sv*4+0x9018)>>>0);
  log('Bridge SBEC key: 0x'+_hx(k,8),'info');
  const kr=await engine.uds(tx,rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
  if(kr.ok&&kr.d&&kr.d[0]===0x67){log('✓ Bridge SBEC unlock succeeded','rx');return {ok:true};}
  if(kr.ok&&kr.d&&kr.d[0]===0x7F){
    const nrc=kr.d.length>2?kr.d[2]:0;
    return {ok:false,nrc,error:'bridge 27 02 NRC 0x'+_hx(nrc)};
  }
  return {ok:false,error:'bridge 27 02 no response'};
}
