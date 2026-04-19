import React, {useState, useCallback, useContext, useMemo, useEffect} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {crc16ccitt} from "../lib/crc.js";
import {initAdapter} from "../lib/initAdapter.js";
import {createBridgeEngine} from "../lib/bridgeEngine.js";
import {useBridgeStatus} from "../lib/bridgeClient.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import {logSession} from "../lib/paperTrail.js";
import {partitionForVin, getRow} from "../lib/moduleRegistry.js";
import {programVin} from "../lib/vinProgrammer.js";

const STATUS_COLORS = {
  pending: '#777',
  running: '#FFB300',
  ok:      '#00C853',
  fail:    '#FF1744',
  skipped: '#888',
  blocked: '#B71C1C',
};

const REASON_LABELS = {
  preflight: 'preflight read failed',
  unlock:    'unlock chain exhausted',
  write:     'WriteByID rejected',
  verify:    'read-back mismatch',
};

export default function ProgramAllTab(){
  const{vin:masterVin,vinValid,moduleStatus,setPg,setModuleStatus}=useContext(MasterVinContext);
  const{connected:bridgeConnected}=useBridgeStatus(5000);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  // ── partition the registry against the current Master VIN ──
  const partition = useMemo(
    () => partitionForVin(vinValid ? masterVin : ''),
    [masterVin, vinValid]
  );

  // ── universal-batch state ──
  // selection: tx → boolean (default: every writable row checked)
  const [selection, setSelection] = useState({});
  const [stopOnFail, setStopOnFail] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResults, setBatchResults] = useState({}); // tx → { status, reason?, before?, after?, unlockAlgo? }
  const [batchLog, setBatchLog] = useState([]);
  const blog = useCallback((m, t='info') => {
    setBatchLog(p => [...p.slice(-300), { t: new Date().toLocaleTimeString(), m, type: t }]);
  }, []);

  const allWritable = partition.writable;
  const sgwBlockedRows = partition.blockedBySgw;
  const sgwBatchBlocked = sgwBlockedRows.length > 0 && !bridgeConnected;

  // Initialize selection on first VIN load — every vin-writable row is
  // checked unless the user has previously unchecked it for that address.
  useEffect(() => {
    if (!vinValid) return;
    setSelection(prev => {
      // Preserve any prior toggles for addresses still in the list.
      const next = {};
      for (const r of allWritable) {
        next[r.tx] = (r.tx in prev) ? prev[r.tx] : true;
      }
      return next;
    });
    // allWritable is a derived array — re-derived on every VIN change but
    // referentially stable per VIN, so depending on masterVin/vinValid is
    // sufficient to drive the (re)init.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterVin, vinValid]);

  const toggleSelection = useCallback((tx) => {
    setSelection(p => ({ ...p, [tx]: !p[tx] }));
  }, []);
  const selectAll = useCallback((value) => {
    setSelection(allWritable.reduce((acc, r) => { acc[r.tx] = value; return acc; }, {}));
  }, [allWritable]);

  const runBatch = useCallback(async () => {
    if (!vinValid) { blog('Master VIN must be valid before running a batch', 'error'); return; }
    const targets = allWritable.filter(r => selection[r.tx]);
    if (targets.length === 0) { blog('No modules selected', 'warn'); return; }

    setBatchBusy(true);
    setBatchResults({});
    setBatchLog([]);
    blog(`═══ UNIVERSAL VIN BATCH — ${targets.length} module${targets.length===1?'':'s'} ═══`, 'info');
    blog(`Target VIN: ${masterVin}`, 'info');

    // Decide which uds engine to use. If any selected row needs SGW we
    // route the whole batch through the bridge; otherwise we use the
    // standard ELM/STN serial engine.
    const needsBridge = targets.some(r => r.sgwRequired);
    let activeEng = null;
    if (needsBridge) {
      blog('🔐 SGW required — opening bridge engine…', 'info');
      const br = await createBridgeEngine({ addLog: (m,t)=>blog(m,t) });
      if (!br.ok) {
        blog('🛑 Bridge unavailable: ' + br.error, 'error');
        blog('Open the AUTEL SGW tab, start j2534_bridge.py, then retry.', 'error');
        setBatchBusy(false);
        return;
      }
      activeEng = br.engine;
    } else {
      blog('Connecting to ELM/STN adapter…', 'info');
      activeEng = await initAdapter((m,t)=>blog(m,t), hx);
      if (!activeEng) { blog('Adapter init failed — aborting batch', 'error'); setBatchBusy(false); return; }
    }

    let okCount = 0, failCount = 0, skipCount = 0;
    for (const row of targets) {
      blog(`── ${row.code} (TX 0x${hx(row.tx,3)}) ──`, 'info');
      setBatchResults(p => ({ ...p, [row.tx]: { status: 'running' } }));

      const r = await programVin({
        eng: activeEng,
        row,
        vin: masterVin,
        addLog: (m,t)=>blog(`  ${m}`, t),
      });

      if (r.ok) {
        okCount++;
        blog(`✓ ${row.code} verified`, 'rx');
        setBatchResults(p => ({ ...p, [row.tx]: { status: 'ok', before: r.beforeVin, after: r.afterVin, unlockAlgo: r.unlockAlgo } }));
      } else {
        failCount++;
        const why = REASON_LABELS[r.reason] || r.reason || 'unknown';
        blog(`✗ ${row.code} failed (${why})`, 'error');
        setBatchResults(p => ({ ...p, [row.tx]: { status: 'fail', reason: r.reason, before: r.beforeVin, after: r.afterVin, errors: r.errors } }));
      }

      // Mirror status into the existing per-tab traffic light when this
      // row maps to one of the four bench tabs.
      if (['BCM','RFHUB','ECM','ADCM'].includes(row.code)) {
        setModuleStatus(p => ({ ...p, [row.code]: r.ok ? 'ok' : 'fail' }));
      }

      try {
        logSession({
          module: row.code,
          operation: 'Universal VIN Write',
          newVin: masterVin,
          oldVin: r.beforeVin,
          moduleAddr: { tx: row.tx, rx: row.rx },
          adapter: activeEng?.adapter || (needsBridge ? 'Autel J2534 (bridge)' : 'ELM327/STN'),
          sgwRouted: needsBridge,
          success: r.ok,
          unlockAlgo: r.unlockAlgo,
          dids: r.didResults.map(d => ({ did: '0x' + d.did.toString(16).toUpperCase(), value: d.readback, match: d.match })),
          errors: r.errors,
        });
      } catch { /* ignore */ }

      if (!r.ok && stopOnFail) {
        // Determine remaining targets without depending on the (stale)
        // batchResults captured by useCallback — use the index of the
        // current row in `targets` instead.
        const idx = targets.indexOf(row);
        const remaining = targets.slice(idx + 1);
        blog(`⏸ stop-on-fail enabled — ${remaining.length} module(s) skipped`, 'warn');
        setBatchResults(p => {
          const out = { ...p };
          for (const rr of remaining) if (!out[rr.tx]) out[rr.tx] = { status: 'skipped' };
          return out;
        });
        skipCount = remaining.length;
        break;
      }
    }

    blog(`═══ DONE — ${okCount} ok · ${failCount} fail${skipCount?` · ${skipCount} skipped`:''} ═══`,
      failCount === 0 ? 'rx' : 'warn');
    setBatchBusy(false);
    // batchResults intentionally omitted from deps — we use functional
    // setState updates throughout, so re-binding mid-batch on every state
    // change would be wasteful and risk stale closures inside the loop.
  }, [vinValid, masterVin, allWritable, selection, stopOnFail, blog, setModuleStatus]);

  // ── classic 4-step bench-workflow data (kept for the per-tab nav cards) ──
  const benchSteps = [
    {order:1,key:'BCM',  icon:'🧠',name:'Body Control Module',     color:C.sr,tab:'bcm'},
    {order:2,key:'RFHUB',icon:'🔑',name:'RF Hub Module',           color:C.a2,tab:'rfhub'},
    {order:3,key:'ECM',  icon:'⚡',name:'Engine Control Module',   color:C.wn,tab:'ecm'},
    {order:4,key:'ADCM', icon:'🏎️',name:'Active Damping Module',  color:C.a3,tab:'adcm'},
  ];

  const crc = vinValid ? crc16ccitt(Array.from(masterVin.slice(-8)).map(c=>c.charCodeAt(0))) : 0;
  const selectedCount = allWritable.filter(r => selection[r.tx]).length;

  return <div data-testid="programall-tab">
    <Card style={{background:'linear-gradient(135deg,#0A0A0A 0%,#2D2D2D 40%,#D32F2F 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:12}}>
        <div style={{fontSize:40}}>🚀</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:28,letterSpacing:2}}>PROGRAM ALL</div>
          <div style={{fontSize:11,opacity:.7,letterSpacing:3,fontWeight:700}}>UNIVERSAL OBD VIN PROGRAMMER · {allWritable.length} MODULES</div>
        </div>
      </div>
      <div style={{fontSize:13,opacity:.9,lineHeight:1.6}}>
        Push the Master VIN to every VIN-capable module on the bus from a single
        screen. Each row preflights with a read, walks the unlock chain, writes
        every VIN DID, and verifies by reading back. Unsupported modules and
        SGW are listed for reference.
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
          <div style={{fontSize:10,color:C.ts,letterSpacing:1,marginBottom:4}}>SELECTED</div>
          <div style={{fontSize:32,fontWeight:900,color:C.gn}}>{selectedCount}<span style={{fontSize:18,color:C.ts}}>/{allWritable.length}</span></div>
          <div style={{fontSize:10,color:C.ts}}>writable modules</div>
        </div>
      </div>
    </Card>}

    {/* ── Universal batch runner ── */}
    <Card data-testid="universal-runner" style={{marginBottom:18,border:'2px solid '+C.tx}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{fontWeight:900,fontSize:14,color:C.tx,letterSpacing:1}}>🛰️ UNIVERSAL BATCH RUNNER</div>
          <div style={{fontSize:11,color:C.ts,marginTop:2}}>Programs every selected VIN-writable module sequentially.</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <label style={{fontSize:11,color:C.ts,display:'flex',alignItems:'center',gap:6,cursor:'pointer'}}>
            <input type="checkbox" checked={stopOnFail} onChange={e=>setStopOnFail(e.target.checked)} disabled={batchBusy}/>
            stop on first fail
          </label>
          <Btn onClick={()=>selectAll(true)} disabled={batchBusy} color={C.a3} outline>select all</Btn>
          <Btn onClick={()=>selectAll(false)} disabled={batchBusy} color={C.tm} outline>clear</Btn>
          <Btn onClick={runBatch} disabled={batchBusy||!vinValid||selectedCount===0||sgwBatchBlocked} color={C.sr}>
            {batchBusy?'⏳ Running…':`▶ Program ${selectedCount} module${selectedCount===1?'':'s'}`}
          </Btn>
        </div>
      </div>

      {sgwBatchBlocked&&<div style={{padding:10,background:'#FFEBEE',border:'2px solid '+C.er,borderRadius:8,marginBottom:12,fontSize:12,color:'#B71C1C'}}>
        🛑 <b>SGW required</b> — this VIN ({masterVin.slice(0,4)}…) targets a 2018+ secure-gateway vehicle.
        {' '}Open the <a href="#" onClick={e=>{e.preventDefault();setPg('autel');}} style={{color:C.sr,fontWeight:800}}>AUTEL SGW tab</a>,
        start j2534_bridge.py, then retry. <b>{sgwBlockedRows.length}</b> module(s) currently require the bridge.
      </div>}

      <div data-testid="universal-grid" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))',gap:8}}>
        {allWritable.map(r => {
          const sel = !!selection[r.tx];
          const res = batchResults[r.tx] || { status: 'pending' };
          const stColor = STATUS_COLORS[res.status] || STATUS_COLORS.pending;
          return <label key={r.tx} data-testid={'urow-'+r.code} style={{
            display:'flex',gap:8,alignItems:'flex-start',padding:10,
            background:sel?'#F8FFF8':'#F5F5F5',
            border:'1.5px solid '+(sel?C.gn:C.bd),borderRadius:8,cursor:batchBusy?'not-allowed':'pointer',
            opacity:batchBusy?.85:1,
          }}>
            <input type="checkbox" checked={sel} disabled={batchBusy}
              onChange={()=>toggleSelection(r.tx)} style={{marginTop:2}}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',justifyContent:'space-between',gap:6,alignItems:'center'}}>
                <div style={{fontWeight:800,fontSize:12,color:C.tx}}>{r.code}</div>
                <div data-testid={'ustat-'+r.code} style={{fontSize:9,fontWeight:800,padding:'2px 6px',borderRadius:4,background:stColor+'22',color:stColor,border:'1px solid '+stColor+'66',letterSpacing:1}}>
                  {res.status.toUpperCase()}
                </div>
              </div>
              <div style={{fontSize:10,color:C.ts,marginTop:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{r.name}</div>
              <div style={{fontSize:9,color:C.tm,fontFamily:"'JetBrains Mono'",marginTop:2}}>
                TX 0x{hx(r.tx,3)} · {r.unlockId||'auto'}{r.sgwRequired?' · SGW':''}
              </div>
              {res.status==='fail'&&<div style={{fontSize:9,color:C.er,marginTop:2}}>{REASON_LABELS[res.reason]||res.reason}</div>}
              {res.status==='ok'&&res.unlockAlgo&&res.unlockAlgo!==true&&<div style={{fontSize:9,color:C.gn,marginTop:2}}>via {res.unlockAlgo}</div>}
            </div>
          </label>;
        })}
      </div>

      {batchLog.length>0&&<div style={{marginTop:14,background:'#0D0D15',color:'#E0E0E0',borderRadius:6,padding:10,maxHeight:240,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.5}}>
        {batchLog.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>}
    </Card>

    {/* ── Reference panels: SGW / unsupported / pending-W7 ── */}
    {(partition.unsupported.length>0||partition.pendingW7.length>0)&&<Card style={{marginBottom:14,background:'#FAFAFA'}}>
      <div style={{fontWeight:800,fontSize:11,color:C.ts,letterSpacing:2,marginBottom:10}}>📋 NOT IN BATCH</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
        <div>
          <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6}}>Unsupported / no VIN slot</div>
          {partition.unsupported.map(r=><div key={r.tx} style={{fontSize:11,color:C.ts,fontFamily:"'JetBrains Mono'",marginBottom:2}}>
            <b style={{color:C.tx}}>{r.code}</b> · 0x{hx(r.tx,3)} — {r.notes||r.name}
          </div>)}
          {partition.unsupported.length===0&&<div style={{fontSize:11,color:C.tm,fontStyle:'italic'}}>none</div>}
        </div>
        <div>
          <div style={{fontSize:11,fontWeight:800,color:C.wn,marginBottom:6}}>Pending W7 cipher (task #145)</div>
          {partition.pendingW7.map(r=><div key={r.tx} style={{fontSize:11,color:C.ts,fontFamily:"'JetBrains Mono'",marginBottom:2}}>
            <b style={{color:C.tx}}>{r.code}</b> · 0x{hx(r.tx,3)} — algorithm pending
          </div>)}
          {partition.pendingW7.length===0&&<div style={{fontSize:11,color:C.tm,fontStyle:'italic'}}>none</div>}
        </div>
      </div>
    </Card>}

    {/* ── Classic 4-tab bench workflow nav cards ── */}
    <div style={{marginBottom:14,fontSize:13,fontWeight:800,color:C.ts,letterSpacing:2}}>BENCH WORKFLOW (DEDICATED TABS)</div>
    {benchSteps.map(s=>{
      const st=moduleStatus[s.key]||'pending';
      const stColor={pending:C.tm,writing:C.wn,ok:C.gn,fail:C.er}[st];
      const stLabel={pending:'PENDING',writing:'WRITING...',ok:'✓ COMPLETE',fail:'✗ FAILED'}[st];
      const row=getRow(s.key);
      return<Card key={s.key} data-testid={'workflow-'+s.key} style={{marginBottom:12,borderLeft:'5px solid '+s.color,padding:0,overflow:'hidden'}}>
        <div style={{padding:'16px 20px',display:'grid',gridTemplateColumns:'auto 1fr auto auto',gap:16,alignItems:'center'}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:40,height:40,borderRadius:10,background:s.color+'15',display:'flex',alignItems:'center',justifyContent:'center',fontSize:22}}>{s.icon}</div>
            <div style={{fontSize:24,fontWeight:900,color:s.color,fontFamily:"'Righteous'"}}>{s.order}</div>
          </div>
          <div>
            <div style={{fontWeight:800,fontSize:14,color:C.tx}}>{s.name}</div>
            <div style={{fontSize:10,color:C.ts,fontFamily:"'JetBrains Mono'",marginTop:2}}>
              {row?`TX 0x${hx(row.tx,3)} · ${row.unlockId||'auto'}`:''}
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
        <div>• <b>Universal Batch</b> reads each module's current VIN before any write — burns nothing if the address is wrong</div>
        <div>• <b>Always BCM first</b> — it's the master and other modules check against its VIN</div>
        <div>• <b>2018+ vehicles</b> need the Autel bridge online (AUTEL SGW tab) — the batch refuses to start otherwise</div>
        <div>• <b>Skip-on-fail</b> (default) keeps going through the list. Toggle <b>stop-on-fail</b> for sensitive bench rigs</div>
        <div>• <b>Per-tab status badges</b> at the bottom mirror BCM/RFHUB/ECM/ADCM batch results</div>
      </div>
    </Card>
  </div>;
}
