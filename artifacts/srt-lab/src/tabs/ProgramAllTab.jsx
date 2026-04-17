import React, {useState, useCallback, useContext} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {crc16ccitt} from "../lib/crc.js";
import {initAdapter, parseVinFromResponse} from "../lib/initAdapter.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import {logSession} from "../lib/paperTrail.js";

export default function ProgramAllTab(){
  const{vin:masterVin,vinValid,moduleStatus,setPg}=useContext(MasterVinContext);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');
  const[verifyBusy,setVerifyBusy]=useState(false);
  const[verifyResults,setVerifyResults]=useState(null);
  const[verifyLog,setVerifyLog]=useState([]);
  const vlog=(m,t='info')=>setVerifyLog(p=>[...p.slice(-100),{t:new Date().toLocaleTimeString(),m,type:t}]);

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
      await eng.uds(t.tx,t.rx,[0x10,0x03]);
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
    try{
      logSession({
        module:'ALL',
        operation:'Cross-module VIN Verify',
        newVin:masterVin,
        success:allMatch,
        adapter:eng.adapter||'ELM327/STN',
        dids:Object.entries(results).map(([k,r])=>({did:k,value:r.vin||'(none)'})),
      });
    }catch(e){/* ignore */}
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

  return <div data-testid="programall-tab">
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

    {!vinValid?<Card style={{marginBottom:18,background:'#FFF3E0',border:'2px solid '+C.wn}}>
      <div style={{fontSize:14,fontWeight:800,color:C.wn}}>⚠ No Master VIN Set</div>
      <div style={{fontSize:12,color:C.ts,marginTop:6}}>Enter a 17-character VIN in the top-right input before starting.</div>
    </Card>:<Card data-testid="master-vin-card" style={{marginBottom:18,background:'linear-gradient(135deg,#E8F5E9 0%,#C8E6C9 100%)',border:'2px solid '+C.gn}}>
      <div style={{display:'grid',gridTemplateColumns:'1fr auto',gap:14,alignItems:'center'}}>
        <div>
          <div style={{fontSize:11,fontWeight:800,color:C.gn,letterSpacing:2,marginBottom:4}}>✓ MASTER VIN LOCKED</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:22,fontWeight:800,letterSpacing:2,color:C.tx}}>{masterVin}</div>
          <div style={{fontSize:11,color:C.ts,marginTop:4,fontFamily:"'JetBrains Mono'"}}>
            Short VIN: <b>{masterVin.slice(-8)}</b> · CRC16-CCITT: <b data-testid="programall-crc">0x{hx(crc,4)}</b>
          </div>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:10,color:C.ts,letterSpacing:1,marginBottom:4}}>ALL 4 MODULES</div>
          <div style={{fontSize:32,fontWeight:900,color:C.gn}}>{['BCM','RFHUB','ECM','ADCM'].filter(k=>moduleStatus[k]==='ok').length}/4</div>
          <div style={{fontSize:10,color:C.ts}}>programmed</div>
        </div>
      </div>
    </Card>}

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
      {verifyResults&&<div data-testid="verify-results" style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8,marginBottom:12}}>
        {Object.entries(verifyResults).map(([key,r])=>{
          const bg=r.match?'#E8F5E9':r.vin?'#FFEBEE':'#F5F5F5';
          const border=r.match?C.gn:r.vin?C.er:C.bd;
          const icon=r.match?'✓':r.vin?'✗':'○';
          const iconColor=r.match?C.gn:r.vin?C.er:C.tm;
          return<div key={key} data-testid={'verify-'+key} style={{padding:10,background:bg,borderRadius:8,border:'2px solid '+border}}>
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

    <div style={{marginBottom:14,fontSize:13,fontWeight:800,color:C.ts,letterSpacing:2}}>BENCH WORKFLOW</div>
    {steps.map(s=>{
      const st=moduleStatus[s.key]||'pending';
      const stColor={pending:C.tm,writing:C.wn,ok:C.gn,fail:C.er}[st];
      const stLabel={pending:'PENDING',writing:'WRITING...',ok:'✓ COMPLETE',fail:'✗ FAILED'}[st];
      return<Card key={s.key} data-testid={'workflow-'+s.key} style={{marginBottom:12,borderLeft:'5px solid '+s.color,padding:0,overflow:'hidden'}}>
        <div style={{padding:'16px 20px',display:'grid',gridTemplateColumns:'auto 1fr auto auto',gap:16,alignItems:'center'}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:40,height:40,borderRadius:10,background:s.color+'15',display:'flex',alignItems:'center',justifyContent:'center',fontSize:22}}>{s.icon}</div>
            <div style={{fontSize:24,fontWeight:900,color:s.color,fontFamily:"'Righteous'"}}>{s.order}</div>
          </div>
          <div>
            <div style={{fontWeight:800,fontSize:14,color:C.tx}}>{s.name}</div>
            <div style={{fontSize:10,color:C.ts,fontFamily:"'JetBrains Mono'",marginTop:2}}>{s.addr} · {s.algo}</div>
            <div style={{fontSize:10,color:C.ts,marginTop:4}}>
              {s.ops.map((o,i)=><span key={i} style={{marginRight:10}}>• {o}</span>)}
            </div>
          </div>
          <div style={{textAlign:'right'}}>
            <div data-testid={'workflow-status-'+s.key} style={{padding:'4px 12px',borderRadius:6,fontSize:10,fontWeight:800,letterSpacing:1,background:stColor+'20',color:stColor,border:'1px solid '+stColor+'44'}}>{stLabel}</div>
          </div>
          <Btn onClick={()=>setPg(s.tab)} color={s.color}>
            Open {s.key} →
          </Btn>
        </div>
      </Card>;
    })}

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
