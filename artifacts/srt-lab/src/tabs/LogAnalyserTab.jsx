import React, {useState, useMemo, useCallback, useEffect} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {
  parseCandumpLog,
  idStats, iddiff,
  reassembleIsoTp, decodeUdsSession,
  COMMON_ID_PAIRS, suggestIdPairs,
  bcmDiffToProposals,
} from "@workspace/uds";
import {consumeAnalyserHandoff} from "../lib/canRecorder.js";

const HEX = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const idLabel = (id, ext) => '0x' + id.toString(16).toUpperCase().padStart(ext ? 8 : 3, '0');
const hexBytes = (d) => Array.from(d).map(HEX).join(' ');

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(String(e.target.result || ''));
    r.onerror = reject;
    r.readAsText(file);
  });
}

function FileDrop({label, onText, testId}) {
  const [over, setOver] = useState(false);
  const onChange = async (e) => {
    const f = e.target.files?.[0];
    if (f) onText(await readFile(f), f.name);
  };
  const onDrop = async (e) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) onText(await readFile(f), f.name);
  };
  return (
    <div data-testid={testId}
         onDragOver={(e) => { e.preventDefault(); setOver(true); }}
         onDragLeave={() => setOver(false)}
         onDrop={onDrop}
         style={{padding:14,border:`2px dashed ${over ? C.sr : C.bd}`,borderRadius:10,textAlign:'center',background:over ? C.sr+'10' : 'transparent',transition:'all 0.15s'}}>
      <div style={{fontSize:11,fontWeight:800,color:C.tm,letterSpacing:1.5,marginBottom:8}}>{label}</div>
      <div style={{fontSize:10,color:C.tm,marginBottom:6}}>drag a .log here, or browse:</div>
      <input type="file" accept=".log,.txt,.candump" onChange={onChange}
             style={{fontSize:12,fontFamily:"'JetBrains Mono'"}}/>
    </div>
  );
}

function PanelHeader({children, count}) {
  return (
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
      <div style={{fontSize:12,fontWeight:900,color:C.tx,letterSpacing:1.5}}>{children}</div>
      {count != null && <div style={{fontSize:10,color:C.tm,fontFamily:'JetBrains Mono'}}>{count} rows</div>}
    </div>
  );
}

const SORT_KEYS = ['id', 'count', 'firstTs', 'lastTs', 'meanDt'];

function fmtHistogram(h) {
  if (!h || !h.length) return '—';
  const parts = [];
  for (let i = 0; i < h.length; i++) if (h[i]) parts.push(`${i}:${h[i]}`);
  return parts.join(' ') || '—';
}

function parseTextSafe(text) {
  if (!text) return {frames: [], err: ''};
  try { return {frames: parseCandumpLog(text), err: ''}; }
  catch (e) { return {frames: [], err: String(e.message || e)}; }
}

export default function LogAnalyserTab() {
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const [nameA, setNameA] = useState('');
  const [nameB, setNameB] = useState('');
  const [tx, setTx] = useState('0x7E0');
  const [rx, setRx] = useState('0x7E8');
  const [filter, setFilter] = useState('');
  const [showOnlyNrc, setShowOnlyNrc] = useState(false);
  const [sortKey, setSortKey] = useState('count');
  const [sortDir, setSortDir] = useState('desc');

  // Pull a live-capture handoff from the recorder hook on mount.
  useEffect(() => {
    const h = consumeAnalyserHandoff();
    if (h) { setTextA(h.text); setNameA(h.name); }
  }, []);

  const parsedA = useMemo(() => parseTextSafe(textA), [textA]);
  const parsedB = useMemo(() => parseTextSafe(textB), [textB]);
  const framesA = parsedA.frames;
  const framesB = parsedB.frames;
  const errA = parsedA.err;
  const errB = parsedB.err;

  const stats = useMemo(() => idStats(framesA), [framesA]);
  const sortedStats = useMemo(() => {
    const arr = stats.slice();
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0;
      return av < bv ? -dir : av > bv ? dir : 0;
    });
    return arr;
  }, [stats, sortKey, sortDir]);
  const toggleSort = useCallback((k) => {
    setSortKey(prev => {
      if (prev === k) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return prev; }
      setSortDir(k === 'id' ? 'asc' : 'desc');
      return k;
    });
  }, []);

  const diff = useMemo(() => (textB ? iddiff(framesA, framesB) : null), [framesA, framesB, textB]);

  const txN = parseInt(String(tx).replace(/^0x/i, ''), 16);
  const rxN = parseInt(String(rx).replace(/^0x/i, ''), 16);

  const eventsA = useMemo(() => {
    if (!framesA.length || Number.isNaN(txN) || Number.isNaN(rxN)) return [];
    const pairs = reassembleIsoTp(framesA, {tx: txN, rx: rxN});
    return decodeUdsSession(pairs);
  }, [framesA, txN, rxN]);

  const eventsB = useMemo(() => {
    if (!framesB.length || Number.isNaN(txN) || Number.isNaN(rxN)) return [];
    const pairs = reassembleIsoTp(framesB, {tx: txN, rx: rxN});
    return decodeUdsSession(pairs);
  }, [framesB, txN, rxN]);

  const filteredEvents = useMemo(() => {
    let evs = eventsA;
    if (showOnlyNrc) evs = evs.filter(e => e.kind === 'response' && !e.ok);
    if (filter) {
      const f = filter.toLowerCase();
      evs = evs.filter(e => (e.human || '').toLowerCase().includes(f) ||
        hexBytes(e.raw).toLowerCase().includes(f));
    }
    return evs;
  }, [eventsA, filter, showOnlyNrc]);

  const suggestions = useMemo(() => suggestIdPairs(framesA), [framesA]);

  const proposals = useMemo(() => {
    if (!eventsA.length || !eventsB.length) return [];
    return bcmDiffToProposals(eventsA, eventsB);
  }, [eventsA, eventsB]);

  const [acceptStatus, setAcceptStatus] = useState(null);
  const buildPayload = useCallback(() => ({
    beforeFile: nameA, afterFile: nameB,
    txId: idLabel(txN, txN > 0x7FF), rxId: idLabel(rxN, rxN > 0x7FF),
    proposals: proposals.map(p => ({
      did: '0x' + p.did.toString(16).toUpperCase().padStart(4, '0'),
      beforeBytes: hexBytes(p.beforeBytes),
      afterBytes: hexBytes(p.afterBytes),
      firstDiffOffset: p.firstDiffOffset,
      suggestedFieldName: p.suggestedFieldName,
      notes: 'Human review required before merging into bcmFeatureCatalog.generated.js',
    })),
  }), [proposals, nameA, nameB, txN, rxN]);

  const acceptProposals = useCallback(async () => {
    setAcceptStatus({kind: 'pending', msg: 'appending to bcmCatalogProposals.json…'});
    try {
      const payload = buildPayload();
      payload.proposals.forEach(p => { p.beforeFile = payload.beforeFile; p.afterFile = payload.afterFile; p.txId = payload.txId; p.rxId = payload.rxId; });
      const r = await fetch('/api/bcm-catalog-proposals', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`HTTP ${r.status} — ${t.slice(0, 200)}`);
      }
      const j = await r.json();
      setAcceptStatus({kind: 'ok', msg: `appended ${j.accepted} proposal(s) — review queue now holds ${j.total} entries (file: artifacts/srt-lab/src/lib/bcmCatalogProposals.json)`});
    } catch (e) {
      setAcceptStatus({kind: 'err', msg: `accept failed: ${String(e.message || e)} — falling back: use DOWNLOAD to save the JSON locally and append manually.`});
    }
  }, [buildPayload]);

  const downloadProposals = useCallback(() => {
    const out = {
      generatedAt: new Date().toISOString(),
      beforeFile: nameA, afterFile: nameB,
      txId: idLabel(txN, txN > 0x7FF), rxId: idLabel(rxN, rxN > 0x7FF),
      proposals: proposals.map(p => ({
        did: '0x' + p.did.toString(16).toUpperCase().padStart(4, '0'),
        beforeBytes: hexBytes(p.beforeBytes),
        afterBytes: hexBytes(p.afterBytes),
        firstDiffOffset: p.firstDiffOffset,
        suggestedFieldName: p.suggestedFieldName,
        notes: 'Human review required before merging into bcmFeatureCatalog.generated.js',
      })),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'bcmCatalogProposals.json';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [proposals, nameA, nameB, txN, rxN]);

  const sortHeader = (label, k) => (
    <th onClick={() => toggleSort(k)} style={{padding:'4px 6px',cursor:'pointer',userSelect:'none',whiteSpace:'nowrap'}}>
      {label}{sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div data-testid="log-analyser-tab" style={{display:'grid',gap:18}}>
      <Card>
        <div style={{fontFamily:"'Righteous'",fontSize:18,color:C.sr,letterSpacing:2,marginBottom:6}}>📜 LOG ANALYSER</div>
        <div style={{fontSize:11,color:C.ts,marginBottom:14}}>
          Drop a candump <code style={{background:C.c2,padding:'1px 6px',borderRadius:4}}>.log</code>
          (or paste below) to see per-ID stats and a UDS-decoded timeline. Add a second log to enable
          iddiff and the "Grow catalog from diff" workflow.
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
          <div>
            <FileDrop testId="log-analyser-drop-a" label={nameA ? `A · ${nameA}` : 'CAPTURE A · drop .log'}
                      onText={(t, n) => { setTextA(t); setNameA(n); }}/>
            <textarea data-testid="log-analyser-paste-a" value={textA} onChange={e => { setTextA(e.target.value); setNameA(e.target.value ? 'pasted-A' : ''); }}
                      placeholder="…or paste candump lines here"
                      style={{width:'100%',height:80,marginTop:6,fontFamily:'JetBrains Mono',fontSize:10,padding:6,border:`1px solid ${C.bd}`,borderRadius:8}}/>
            {errA && <div style={{color:C.er,fontSize:11,marginTop:4}}>⚠ {errA}</div>}
            <div style={{fontSize:10,color:C.tm,marginTop:4,fontFamily:'JetBrains Mono'}}>{framesA.length} frames</div>
          </div>
          <div>
            <FileDrop testId="log-analyser-drop-b" label={nameB ? `B · ${nameB}` : 'CAPTURE B · drop .log (optional)'}
                      onText={(t, n) => { setTextB(t); setNameB(n); }}/>
            <textarea data-testid="log-analyser-paste-b" value={textB} onChange={e => { setTextB(e.target.value); setNameB(e.target.value ? 'pasted-B' : ''); }}
                      placeholder="…or paste candump lines here"
                      style={{width:'100%',height:80,marginTop:6,fontFamily:'JetBrains Mono',fontSize:10,padding:6,border:`1px solid ${C.bd}`,borderRadius:8}}/>
            {errB && <div style={{color:C.er,fontSize:11,marginTop:4}}>⚠ {errB}</div>}
            <div style={{fontSize:10,color:C.tm,marginTop:4,fontFamily:'JetBrains Mono'}}>{framesB.length} frames</div>
          </div>
        </div>

        <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
          <label style={{fontSize:11,fontWeight:700,color:C.ts}}>TX</label>
          <input data-testid="log-analyser-tx" value={tx} onChange={e => setTx(e.target.value)}
                 style={{width:90,padding:'6px 8px',border:`1px solid ${C.bd}`,borderRadius:6,fontFamily:'JetBrains Mono',fontSize:12}}/>
          <label style={{fontSize:11,fontWeight:700,color:C.ts}}>RX</label>
          <input data-testid="log-analyser-rx" value={rx} onChange={e => setRx(e.target.value)}
                 style={{width:90,padding:'6px 8px',border:`1px solid ${C.bd}`,borderRadius:6,fontFamily:'JetBrains Mono',fontSize:12}}/>
          {(suggestions.length ? suggestions : COMMON_ID_PAIRS.slice(0, 4)).map(p => (
            <button key={`${p.tx}-${p.rx}`} onClick={() => { setTx('0x' + p.tx.toString(16).toUpperCase()); setRx('0x' + p.rx.toString(16).toUpperCase()); }}
                    style={{padding:'4px 10px',border:`1px solid ${C.bd}`,borderRadius:6,background:C.c2,fontSize:10,cursor:'pointer',fontFamily:"'Nunito'"}}>
              {p.label} ({idLabel(p.tx)}/{idLabel(p.rx)})
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <PanelHeader count={filteredEvents.length}>UDS TIMELINE</PanelHeader>
        <div style={{display:'flex',gap:10,marginBottom:8,alignItems:'center'}}>
          <input data-testid="log-analyser-filter" value={filter} onChange={e => setFilter(e.target.value)}
                 placeholder="search service / DID / NRC / hex"
                 style={{flex:1,padding:'6px 10px',border:`1px solid ${C.bd}`,borderRadius:6,fontSize:12}}/>
          <label style={{fontSize:11,color:C.ts,display:'flex',gap:4,alignItems:'center'}}>
            <input type="checkbox" checked={showOnlyNrc} onChange={e => setShowOnlyNrc(e.target.checked)}/>
            NRC only
          </label>
        </div>
        <div style={{maxHeight:360,overflowY:'auto',border:`1px solid ${C.bd}`,borderRadius:8}}>
          {filteredEvents.length === 0 && (
            <div style={{padding:14,fontSize:11,color:C.tm,textAlign:'center'}}>
              {framesA.length ? 'No UDS pairs decoded for this TX/RX. Try a suggested pair.' : 'Load a candump capture to begin.'}
            </div>
          )}
          {filteredEvents.map((e, i) => {
            const isReq = e.kind === 'request';
            const colour = isReq ? C.a3 : (e.ok ? C.gn : C.er);
            return (
              <div key={i} style={{display:'grid',gridTemplateColumns:'80px 50px 1fr',padding:'6px 10px',borderBottom:`1px solid ${C.bd}`,fontSize:11,fontFamily:'JetBrains Mono',gap:8}}>
                <div style={{color:C.tm}}>{e.ts.toFixed(3)}</div>
                <div style={{color:colour,fontWeight:800}}>{isReq ? 'TX→' : '←RX'}</div>
                <div>
                  <div style={{color:C.tx}}>{e.human}</div>
                  <div style={{color:C.tm,fontSize:10,marginTop:2}}>{hexBytes(e.raw)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <PanelHeader count={sortedStats.length}>ID STATS</PanelHeader>
        <div style={{fontSize:10,color:C.tm,marginBottom:6}}>click any column header to sort · current: {sortKey} {sortDir}</div>
        <div style={{maxHeight:340,overflowY:'auto'}}>
          <table data-testid="log-analyser-stats" style={{width:'100%',fontSize:11,fontFamily:'JetBrains Mono',borderCollapse:'collapse'}}>
            <thead>
              <tr style={{textAlign:'left',color:C.tm,borderBottom:`1px solid ${C.bd}`,position:'sticky',top:0,background:C.cd}}>
                {sortHeader('ID', 'id')}
                {sortHeader('Count', 'count')}
                {sortHeader('First t', 'firstTs')}
                {sortHeader('Last t', 'lastTs')}
                {sortHeader('ΔT̄ (ms)', 'meanDt')}
                <th style={{padding:'4px 6px'}}>Length histogram (len:n)</th>
                <th style={{padding:'4px 6px'}}>Sample</th>
              </tr>
            </thead>
            <tbody>
              {sortedStats.map(s => (
                <tr key={`${s.ext}-${s.id}`} style={{borderBottom:`1px solid ${C.bd}`}}>
                  <td style={{padding:'4px 6px',color:C.sr,fontWeight:700}}>{idLabel(s.id, s.ext)}</td>
                  <td style={{padding:'4px 6px'}}>{s.count}</td>
                  <td style={{padding:'4px 6px',color:C.ts}}>{s.firstTs.toFixed(3)}</td>
                  <td style={{padding:'4px 6px',color:C.ts}}>{s.lastTs.toFixed(3)}</td>
                  <td style={{padding:'4px 6px'}}>{(s.meanDt * 1000).toFixed(2)}</td>
                  <td style={{padding:'4px 6px',color:C.ts}}>{fmtHistogram(s.lengthHistogram)}</td>
                  <td style={{padding:'4px 6px',color:C.ts}}>{hexBytes(s.sample)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <PanelHeader count={diff ? (diff.onlyInA.length + diff.onlyInB.length + diff.common.length) : 0}>IDDIFF (A vs B)</PanelHeader>
        {!diff && <div style={{fontSize:11,color:C.tm,padding:14,textAlign:'center'}}>Load capture B to enable iddiff.</div>}
        {diff && (
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,fontSize:10,fontFamily:'JetBrains Mono'}}>
            {[['only A', diff.onlyInA, C.a1], ['common', diff.common, C.gn], ['only B', diff.onlyInB, C.a3]].map(([label, list, col]) => (
              <div key={label}>
                <div style={{fontWeight:800,color:col,marginBottom:4,letterSpacing:1}}>{label.toUpperCase()} ({list.length})</div>
                <div style={{maxHeight:260,overflowY:'auto',border:`1px solid ${C.bd}`,borderRadius:6,padding:4}}>
                  {list.map(e => (
                    <div key={`${e.ext}-${e.id}`}>{idLabel(e.id, e.ext)} <span style={{color:C.tm}}>({e.countA}/{e.countB})</span></div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <PanelHeader count={proposals.length}>GROW CATALOG FROM DIFF</PanelHeader>
        <div style={{fontSize:11,color:C.ts,marginBottom:10}}>
          Load <strong>before</strong> + <strong>after</strong> captures around a single BCM toggle
          (RECORD before · flip the toggle in the cluster · RECORD after · diff). Each row is a
          candidate field. Review every entry — proposals are written to a JSON review file, never
          merged into <code>bcmFeatureCatalog.generated.js</code> automatically.
        </div>
        {proposals.length === 0 && (
          <div style={{fontSize:11,color:C.tm,padding:14,textAlign:'center'}}>
            {(eventsA.length && eventsB.length) ? 'No WriteDataByIdentifier deltas detected between the two captures.' : 'Load both captures and pick the BCM TX/RX pair.'}
          </div>
        )}
        {proposals.length > 0 && (
          <>
            <div style={{maxHeight:240,overflowY:'auto',border:`1px solid ${C.bd}`,borderRadius:8,fontSize:11,fontFamily:'JetBrains Mono'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead>
                  <tr style={{color:C.tm,textAlign:'left',borderBottom:`1px solid ${C.bd}`}}>
                    <th style={{padding:'4px 6px'}}>DID</th>
                    <th>Before</th>
                    <th>After</th>
                    <th>Suggested name</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map(p => (
                    <tr key={p.did} style={{borderBottom:`1px solid ${C.bd}`}}>
                      <td style={{padding:'4px 6px',color:C.sr,fontWeight:700}}>0x{p.did.toString(16).toUpperCase().padStart(4, '0')}</td>
                      <td>{hexBytes(p.beforeBytes)}</td>
                      <td>{hexBytes(p.afterBytes)}</td>
                      <td style={{color:C.a3}}>{p.suggestedFieldName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{marginTop:10,display:'flex',gap:8,flexWrap:'wrap'}}>
              <Btn data-testid="log-analyser-accept-proposals" onClick={acceptProposals} color={C.gn}>✓ ACCEPT → append to bcmCatalogProposals.json</Btn>
              <Btn data-testid="log-analyser-download-proposals" onClick={downloadProposals} outline>📥 DOWNLOAD .json</Btn>
            </div>
            {acceptStatus && (
              <div data-testid="log-analyser-accept-status" style={{marginTop:8,fontSize:11,color: acceptStatus.kind === 'ok' ? C.gn : acceptStatus.kind === 'err' ? C.er : C.tm}}>
                {acceptStatus.msg}
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
