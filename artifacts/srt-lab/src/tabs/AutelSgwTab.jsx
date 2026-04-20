import React, {useState, useCallback, useEffect, useRef} from 'react';
import {C} from '../lib/constants.js';
import {useMasterVin} from '../lib/masterVinContext.jsx';
import {parseVinYear, vinHasSGW} from '../lib/vin.js';
import {
  bridgeClient, getAutelState, setAutelState, useBridgeStatus, DEFAULT_BRIDGE_URL,
} from '../lib/bridgeClient.js';
import {createBridgeEngine} from '../lib/bridgeEngine.js';
import {unlockKeyBytes} from '../lib/algos.js';
import {setSgwAuthenticated, clearSgwAuth, useSgwAuth, setSgwBypass} from '../lib/sgwAuth.js';

const SGW_TX = 0x74F;
const SGW_RX = 0x76F;

function Card({children,glow}){
  return <div style={{background:C.cd,borderRadius:14,padding:18,marginBottom:14,border:'1.5px solid '+C.bd,boxShadow:glow?'0 4px 18px rgba(211,47,47,0.10)':'0 2px 8px rgba(0,0,0,0.04)'}}>{children}</div>;
}
function Pill({color,children}){
  return <span style={{display:'inline-block',padding:'3px 9px',borderRadius:999,background:color+'18',color,border:'1px solid '+color+'55',fontSize:10,fontWeight:800,letterSpacing:1}}>{children}</span>;
}
function Row({k,v,mono}){
  return <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',borderBottom:'1px solid '+C.bd}}>
    <span style={{fontSize:11,fontWeight:700,color:C.ts,letterSpacing:.5}}>{k}</span>
    <span style={{fontFamily:mono?"'JetBrains Mono'":undefined,fontSize:12,fontWeight:800,color:C.tx}}>{v}</span>
  </div>;
}

export default function AutelSgwTab(){
  const{vin,vinValid}=useMasterVin();
  const[urlDraft,setUrlDraft]=useState(()=>getAutelState().url||DEFAULT_BRIDGE_URL);
  const{connected,status,error,refresh}=useBridgeStatus(5000);
  const sgwAuth=useSgwAuth();
  const[busy,setBusy]=useState(false);
  const[lines,setLines]=useState([]);
  const logRef=useRef(null);

  const log=useCallback((msg,type='info')=>{
    setLines(p=>[...p.slice(-200),{ts:new Date().toLocaleTimeString(),msg,type}]);
  },[]);
  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[lines]);

  const save=useCallback(()=>{
    setAutelState({url:urlDraft.trim()||DEFAULT_BRIDGE_URL});
    log(`Saved bridge URL: ${urlDraft}`,'pass');
    refresh(urlDraft);
  },[urlDraft,refresh,log]);

  const runTest=useCallback(async()=>{
    setBusy(true);
    setLines([]);
    log(`Probing bridge at ${urlDraft}…`,'info');
    const st=await bridgeClient.status(urlDraft);
    if(!st||!st.ok){
      log(`[FAIL] /status — ${st?.error||'unreachable'}`,'error');
      log(`Hint: run "python3 j2534_bridge.py --dll <path>" on this machine.`,'warn');
      setBusy(false);return;
    }
    log(`[OK] /status — vendor=${st.vendor||'?'} platform=${st.platform||'?'}`,'pass');
    log(`     deviceOpen=${st.deviceOpen} channelConnected=${st.channelConnected}`,'info');
    if(!st.deviceOpen){
      log(`Calling /open…`,'info');
      const o=await bridgeClient.open(urlDraft);
      if(!o.ok){log(`[FAIL] /open — ${o.error}`,'error');setBusy(false);return;}
      log(`[OK] PassThruOpen — deviceId=${o.deviceId}`,'pass');
      if(o.versions){
        log(`     firmware=${o.versions.firmware||'?'} dll=${o.versions.dll||'?'} api=${o.versions.api||'?'}`,'info');
      }
      if(o.deviceSerial)log(`     serial=${o.deviceSerial}`,'info');
    }else{
      log(`[OK] device already open — deviceId=${st.deviceId}`,'pass');
      if(st.versions){
        log(`     firmware=${st.versions.firmware||'?'} dll=${st.versions.dll||'?'} api=${st.versions.api||'?'}`,'info');
      }
      if(st.deviceSerial)log(`     serial=${st.deviceSerial}`,'info');
    }
    setAutelState({url:urlDraft,vendor:st.vendor,dllPath:st.dllPath,lastOk:Date.now()});
    log(`Configuration saved to localStorage (srtlab_autel).`,'pass');
    refresh(urlDraft);
    setBusy(false);
  },[urlDraft,log,refresh]);

  const doOpen=useCallback(async()=>{
    setBusy(true);
    const r=await bridgeClient.open(urlDraft);
    log(r.ok?`PassThruOpen ok — deviceId=${r.deviceId}`:`PassThruOpen failed: ${r.error}`,r.ok?'pass':'error');
    refresh(urlDraft);setBusy(false);
  },[urlDraft,log,refresh]);

  const doClose=useCallback(async()=>{
    setBusy(true);
    const r=await bridgeClient.close(urlDraft);
    log(r.ok?'PassThruClose ok':`PassThruClose failed: ${r.error}`,r.ok?'pass':'error');
    // Closing the bridge invalidates any existing SGW auth — the next
    // open() gets a fresh device handle and the truck's session timed
    // out the moment we lost the channel anyway.
    clearSgwAuth();
    refresh(urlDraft);setBusy(false);
  },[urlDraft,log,refresh]);

  // Real seed/key dance against the SGW (tx 0x74F / rx 0x76F). On a
  // 67 02 we mark the auth state as live for this VIN; on any NRC,
  // framing error, or transport failure we clear the auth so the
  // gate fails closed and the tech sees the error here, not later
  // when their write silently drops.
  const authenticateSgw=useCallback(async()=>{
    if(!vinValid){log('Cannot authenticate — no valid 17-char Master VIN loaded','error');return;}
    if(!vinHasSGW(vin)){
      log(`Master VIN model year ${parseVinYear(vin)||'?'} doesn't require SGW — skipping authentication.`,'warn');
      return;
    }
    setBusy(true);
    log(`═══ SGW AUTHENTICATE — VIN ${vin} ═══`,'info');
    const br=await createBridgeEngine({addLog:log,url:urlDraft});
    if(!br.ok){
      log(`🛑 Bridge engine unavailable: ${br.error}`,'error');
      clearSgwAuth();
      setBusy(false);
      return;
    }
    const eng=br.engine;
    // Diagnostic session 0x03 (extended) — required before the SGW
    // accepts a 27 01.
    log('→ 10 03 (extended diagnostic session)','info');
    const ds=await eng.uds(SGW_TX,SGW_RX,[0x10,0x03]);
    if(!ds.ok||!ds.d||ds.d[0]!==0x50){
      const nrc=ds.d&&ds.d[0]===0x7F?ds.d[2]:null;
      log(`🛑 SGW 10 03 ${nrc!=null?`NRC 0x${nrc.toString(16).toUpperCase()}`:'no response'}`,'error');
      clearSgwAuth();
      setBusy(false);
      return;
    }
    log('→ 27 01 (request SGW seed)','info');
    const sr=await eng.uds(SGW_TX,SGW_RX,[0x27,0x01]);
    if(!sr.ok||!sr.d||sr.d.length<6||sr.d[0]!==0x67){
      const nrc=sr.d&&sr.d[0]===0x7F?sr.d[2]:null;
      log(`🛑 SGW 27 01 ${nrc!=null?`NRC 0x${nrc.toString(16).toUpperCase()}`:'no/short response'}`,'error');
      clearSgwAuth();
      setBusy(false);
      return;
    }
    const seedBytes=Array.from(sr.d).slice(2);
    log(`← seed (${seedBytes.length}B): ${seedBytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ')}`,'rx');
    const keyBytes=unlockKeyBytes('xtea_sgw',seedBytes);
    if(!keyBytes){
      log('🛑 xtea_sgw failed to derive a key from the seed — internal error','error');
      clearSgwAuth();
      setBusy(false);
      return;
    }
    log(`→ 27 02 + key (${keyBytes.length}B): ${keyBytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ')}`,'info');
    const kr=await eng.uds(SGW_TX,SGW_RX,[0x27,0x02,...keyBytes]);
    if(kr.ok&&kr.d&&kr.d[0]===0x67){
      log(`✓ SGW UNLOCKED — auth valid for ${vin} (10 min)`,'pass');
      setSgwAuthenticated(vin);
      setBusy(false);
      return;
    }
    const nrc=kr.d&&kr.d[0]===0x7F?kr.d[2]:null;
    log(`🛑 SGW 27 02 ${nrc!=null?`NRC 0x${nrc.toString(16).toUpperCase()}`:'no response'} — key rejected`,'error');
    clearSgwAuth();
    setBusy(false);
  },[vin,vinValid,urlDraft,log]);

  // Manual gate clear so the tech can force a re-auth without closing
  // the bridge.
  const dropAuth=useCallback(()=>{
    clearSgwAuth();
    log('SGW auth cleared — next write will require AUTHENTICATE SGW','warn');
  },[log]);

  const sgwReq=vinValid&&vinHasSGW(vin);
  const yr=parseVinYear(vin);

  const lineColor={info:C.ts,warn:C.wn,error:C.er,pass:C.gn};

  return <div>
    <Card glow>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:8,flexWrap:'wrap'}}>
        <span style={{fontSize:30}}>🔐</span>
        <div style={{flex:1,minWidth:240}}>
          <div style={{fontSize:18,fontWeight:900,letterSpacing:1}}>AUTEL SGW</div>
          <div style={{fontSize:11,color:C.ts,fontWeight:700,letterSpacing:1.5}}>SECURE GATEWAY · J2534 BRIDGE</div>
        </div>
        {connected
          ?<Pill color={C.gn}>✓ BRIDGE CONNECTED</Pill>
          :<Pill color={C.er}>✗ BRIDGE OFFLINE</Pill>}
        {sgwReq?<Pill color={C.a1}>🔐 SGW REQUIRED ({yr})</Pill>
              :vinValid?<Pill color={C.tm}>SGW NOT REQUIRED ({yr||'?'})</Pill>
                       :<Pill color={C.tm}>NO VIN LOADED</Pill>}
        {sgwAuth.bypassed
          ?<Pill color={C.a1}>⚙ BENCH BYPASS</Pill>
          :sgwAuth.authenticated
            ?<Pill color={C.gn}>✓ SGW AUTH ({Math.ceil(sgwAuth.remainingMs/1000/60)}m left)</Pill>
            :sgwReq?<Pill color={C.er}>⚠ SGW NOT AUTHENTICATED</Pill>
                   :null}
      </div>
      <div style={{fontSize:12,color:C.ts,lineHeight:1.6}}>
        Routes UDS traffic for 2018+ FCA vehicles through your Autel MaxiFlash (or any
        compatible J2534 PassThru device) so the secure-gateway authentication
        happens locally on the cable. The bridge runs as a small Python daemon —
        download <b>j2534_bridge.py</b> from the Desktop Driver card and follow
        <b> README_J2534_BRIDGE.md</b>.
      </div>
    </Card>

    <Card>
      <div style={{fontSize:11,fontWeight:800,color:C.ts,letterSpacing:2,marginBottom:10}}>BRIDGE CONNECTION</div>
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginBottom:12}}>
        <label style={{fontSize:11,fontWeight:700,color:C.ts,minWidth:90}}>Bridge URL</label>
        <input value={urlDraft} onChange={e=>setUrlDraft(e.target.value)} placeholder={DEFAULT_BRIDGE_URL}
          style={{flex:1,minWidth:240,padding:'9px 12px',borderRadius:8,border:'1.5px solid '+C.bd,fontFamily:"'JetBrains Mono'",fontSize:13,background:C.c2,color:C.tx,outline:'none'}}/>
        <button onClick={save} disabled={busy} style={{padding:'9px 16px',borderRadius:8,border:'none',background:C.sr,color:'#fff',fontWeight:800,fontSize:11,letterSpacing:1,cursor:'pointer'}}>SAVE CONFIGURATION</button>
        <button onClick={runTest} disabled={busy} style={{padding:'9px 16px',borderRadius:8,border:'none',background:busy?C.bd:'#1A1A1A',color:'#fff',fontWeight:800,fontSize:11,letterSpacing:1,cursor:busy?'wait':'pointer'}}>{busy?'RUNNING…':'RUN TEST'}</button>
        <button onClick={doOpen} disabled={busy||!connected} style={{padding:'9px 14px',borderRadius:8,border:'1.5px solid '+C.bd,background:'#fff',color:C.tx,fontWeight:800,fontSize:11,cursor:'pointer',opacity:(busy||!connected)?.5:1}}>OPEN</button>
        <button onClick={doClose} disabled={busy||!connected} style={{padding:'9px 14px',borderRadius:8,border:'1.5px solid '+C.bd,background:'#fff',color:C.tx,fontWeight:800,fontSize:11,cursor:'pointer',opacity:(busy||!connected)?.5:1}}>CLOSE</button>
      </div>

      {/* SGW seed/key dance — explicitly separate from bridge connect.
          Plugging in the cable is NOT authentication. The button below
          actually runs 27 01/02 against tx 0x74F and only marks the gate
          open on a 67 02 reply. Other tabs read this state via useSgwAuth. */}
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',padding:'10px 12px',borderRadius:8,background:sgwAuth.bypassed?'#FFF3E0':sgwReq?(sgwAuth.authenticated?'#E8F5E9':'#FFF3E0'):'#F5F5F5',border:'1px solid '+(sgwAuth.bypassed?C.a1:sgwReq?(sgwAuth.authenticated?C.gn:C.a1):C.bd),marginBottom:12}}>
        <div style={{flex:1,minWidth:240,fontSize:12,color:C.ts,lineHeight:1.5}}>
          <b style={{color:C.tx}}>SGW Authentication.</b>{' '}
          {sgwAuth.bypassed
            ?<><b style={{color:'#E65100'}}>BENCH BYPASS ACTIVE.</b> All SGW gates are open — every BCM / RFHUB / ECM / ADCM write will be sent regardless of seed/key state. Use this only when the gateway is physically out of the harness. <b>Turn off before plugging into a vehicle.</b></>
            :sgwReq
              ?(sgwAuth.authenticated
                  ?<>Authenticated for VIN <b style={{fontFamily:"'JetBrains Mono'"}}>{sgwAuth.vin}</b> · expires in <b>{Math.floor(sgwAuth.remainingMs/60000)}m {Math.floor((sgwAuth.remainingMs%60000)/1000).toString().padStart(2,'0')}s</b>. BCM / RFHUB / ECM / ADCM writes are unblocked.</>
                  :<>Required for this VIN. Click <b>AUTHENTICATE SGW</b> to run the seed/key dance against <code>0x74F</code>. Other tabs will refuse to write until this turns green.</>)
              :<>Not required for this VIN. Other tabs gate on bridge reachability only.</>}
        </div>
        <button onClick={authenticateSgw} disabled={busy||!connected||!vinValid||!sgwReq||sgwAuth.bypassed} style={{padding:'9px 16px',borderRadius:8,border:'none',background:(busy||!connected||!vinValid||!sgwReq||sgwAuth.bypassed)?C.bd:C.sr,color:'#fff',fontWeight:800,fontSize:11,letterSpacing:1,cursor:(busy||!connected||!vinValid||!sgwReq||sgwAuth.bypassed)?'not-allowed':'pointer',opacity:(busy||!connected||!vinValid||!sgwReq||sgwAuth.bypassed)?.6:1}}>
          {busy?'WORKING…':'AUTHENTICATE SGW'}
        </button>
        {sgwAuth.authenticated&&!sgwAuth.bypassed&&<button onClick={dropAuth} disabled={busy} style={{padding:'9px 14px',borderRadius:8,border:'1.5px solid '+C.bd,background:'#fff',color:C.tx,fontWeight:800,fontSize:11,cursor:'pointer'}}>CLEAR AUTH</button>}
      </div>

      {/* Bench bypass — for when the SGW is physically out of the harness
          (bench loom, jumpered out, or pre-2018 vehicle plugged into a
          bench harness that originally carried a gateway). Persists in
          localStorage so it survives page reload, surfaces a loud orange
          banner above so it cannot be forgotten. */}
      <label style={{display:'flex',gap:10,alignItems:'flex-start',padding:'10px 12px',borderRadius:8,background:sgwAuth.bypassed?'#FFE0B2':C.c2,border:'1.5px solid '+(sgwAuth.bypassed?C.a1:C.bd),cursor:'pointer',marginBottom:12}}>
        <input type="checkbox" checked={sgwAuth.bypassed} onChange={e=>{
          setSgwBypass(e.target.checked);
          log(e.target.checked?'BENCH BYPASS ENABLED — all SGW gates open. Disable before connecting to a vehicle.':'Bench bypass disabled — SGW gates re-armed.', e.target.checked?'warn':'pass');
        }} style={{marginTop:2,width:16,height:16,cursor:'pointer'}}/>
        <div style={{flex:1,fontSize:12,color:C.tx,lineHeight:1.5}}>
          <b>Bench mode — SGW physically bypassed.</b> Skips the seed/key gate entirely so writes go through without authentication. Use only when the gateway is removed or jumpered out of the harness. <b style={{color:'#E65100'}}>Disable before reconnecting to a vehicle</b> — the gate exists to stop SGW NRCs that look like random write failures.
        </div>
      </label>
      {error&&!connected&&<div style={{padding:10,borderRadius:8,background:'#FFEBEE',border:'1.5px solid '+C.er,fontSize:12,color:'#B71C1C',marginBottom:8}}>
        Cannot reach bridge: <b>{error}</b>
      </div>}
      {connected&&status&&<div style={{padding:12,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
        <Row k="Vendor" v={status.vendor||'—'}/>
        <Row k="DLL Path" v={status.dllPath||'(not set)'} mono/>
        <Row k="Platform" v={`${status.platform||'?'} · Python ${status.pythonVersion||'?'}`}/>
        <Row k="Bridge version" v={status.bridgeVersion||'—'}/>
        <Row k="Device open" v={status.deviceOpen?`yes (id ${status.deviceId})`:'no'}/>
        {status.deviceSerial&&<Row k="Device serial" v={status.deviceSerial} mono/>}
        <Row k="Channel connected" v={status.channelConnected?`yes (ch ${status.channelId})`:'no'}/>
        {status.versions&&<>
          <Row k="VCI firmware" v={status.versions.firmware||'—'} mono/>
          <Row k="DLL version" v={status.versions.dll||'—'} mono/>
          <Row k="J2534 API" v={status.versions.api||'—'} mono/>
        </>}
      </div>}
    </Card>

    <Card>
      <div style={{fontSize:11,fontWeight:800,color:C.ts,letterSpacing:2,marginBottom:10}}>SGW POLICY (READ-ONLY)</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div style={{padding:10,borderRadius:8,background:sgwReq?'#FFF3E0':'#F5F5F5',border:'1px solid '+(sgwReq?C.a1:C.bd)}}>
          <div style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1.5}}>MASTER VIN</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:800,color:vinValid?C.tx:C.tm,marginTop:2}}>{vin||'(not set)'}</div>
          <div style={{fontSize:10,color:C.ts,marginTop:4}}>
            {vinValid?<>Model year <b>{yr||'unknown'}</b> · {sgwReq?<span style={{color:C.a1,fontWeight:800}}>SGW required</span>:<span style={{color:C.gn,fontWeight:800}}>SGW not required</span>}</>:'Enter a 17-character VIN above to evaluate.'}
          </div>
        </div>
        <div style={{padding:10,borderRadius:8,background:'#F5F5F5',border:'1px solid '+C.bd,fontSize:11,color:C.ts,lineHeight:1.5}}>
          <b style={{color:C.tx}}>Rule:</b> US-market FCA vehicles from MY 2018 onward
          ship with the Secure Gateway module (SGWM). Writes to BCM / RFHUB / ECM /
          ADCM through the OBD-II port require SGW authentication, which the Autel
          VCI handles on-cable using your Autel subscription.
        </div>
      </div>
    </Card>

    <Card>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
        <div style={{fontSize:11,fontWeight:800,color:C.ts,letterSpacing:2}}>BRIDGE LOG</div>
        <button onClick={()=>setLines([])} style={{padding:'5px 10px',borderRadius:6,border:'1px solid '+C.bd,background:'#fff',fontSize:10,fontWeight:700,cursor:'pointer',color:C.ts}}>CLEAR</button>
      </div>
      <div ref={logRef} style={{background:'#0F0F0F',color:'#E8E8E8',borderRadius:8,padding:12,minHeight:140,maxHeight:280,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:11,lineHeight:1.55}}>
        {lines.length===0?<span style={{color:'#666'}}>Click <b>RUN TEST</b> to probe the local bridge…</span>:
          lines.map((l,i)=><div key={i}><span style={{color:'#666'}}>{l.ts}</span> <span style={{color:lineColor[l.type]||'#E8E8E8'}}>{l.msg}</span></div>)}
      </div>
    </Card>
  </div>;
}
