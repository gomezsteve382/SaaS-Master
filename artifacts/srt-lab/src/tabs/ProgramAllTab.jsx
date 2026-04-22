import React, {useState, useCallback, useContext, useMemo, useEffect} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {crc16ccitt} from "../lib/crc.js";
import {initAdapter} from "../lib/initAdapter.js";
import {createBridgeEngine} from "../lib/bridgeEngine.js";
import {useBridgeStatus} from "../lib/bridgeClient.js";
import {useSgwAuth, isSgwAuthenticated} from "../lib/sgwAuth.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import {partitionForVin, getRow} from "../lib/moduleRegistry.js";
import {programVin} from "../lib/vinProgrammer.js";
import {backupModule} from "../lib/backups.js";

/* Dev-only test hook: when the dev server URL carries
   `?testEngine=stop-on-fail-ecm`, install a deterministic stub uds engine
   on window.__SRT_TEST_ENGINE__. The runner picks the stub up in place of
   initAdapter()/createBridgeEngine() so the Playwright suite can exercise
   the universal batch UI without real hardware or browser-internal JS
   injection. The stub fails ECM (tx 0x7E0) preflight and returns positive
   responses for every other tx so stop-on-fail can be observed end-to-end. */
if (typeof window !== 'undefined'
    && import.meta.env?.DEV
    && !window.__SRT_TEST_ENGINE__) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('testEngine') === 'stop-on-fail-ecm') {
      // eslint-disable-next-line no-console
      console.log('[srt-lab test hook] installing stub uds engine for stop-on-fail-ecm');
      const VIN_BYTES = Array.from('1C3CCBBG7HN500001').map(c => c.charCodeAt(0));
      window.__SRT_TEST_ENGINE__ = {
        adapter: 'TEST_STUB',
        uds: async (tx, _rx, bytes) => {
          if (tx === 0x7E0) return { ok: false, raw: 'no response' };
          const sid = bytes[0];
          if (sid === 0x22) return { ok: true, d: [0x62, ...bytes.slice(1), ...VIN_BYTES], raw: 'OK' };
          if (sid === 0x2E) return { ok: true, d: [0x6E, ...bytes.slice(1, 3)], raw: 'OK' };
          if (sid === 0x10) return { ok: true, d: [0x50, bytes[1], 0,0,0,0], raw: 'OK' };
          if (sid === 0x27) {
            if (bytes[1] & 1) return { ok: true, d: [0x67, bytes[1], 1,2,3,4,5,6], raw: 'OK' };
            return { ok: true, d: [0x67, bytes[1]], raw: 'OK' };
          }
          return { ok: true, d: [bytes[0] + 0x40], raw: 'OK' };
        },
      };
    }
  } catch { /* ignore — query parsing is best-effort */ }
}

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

// sessionStorage key for resumable batch state. Bumped if the persisted
// shape ever changes — older snapshots are then ignored on mount.
const RESUME_KEY = 'srt-lab.programall.resume.v1';

export default function ProgramAllTab(){
  const{vin:masterVin,vinValid,moduleStatus,setPg,setModuleStatus}=useContext(MasterVinContext);
  const{connected:bridgeConnected}=useBridgeStatus(5000);
  const sgwAuth=useSgwAuth();
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  // ── partition the registry against the current Master VIN ──
  const partition = useMemo(
    () => partitionForVin(vinValid ? masterVin : ''),
    [masterVin, vinValid]
  );

  // ── universal-batch state ──
  // selection: tx → boolean (default: every writable row checked)
  const [selection, setSelection] = useState({});
  // perRowVin: tx → string. When non-empty AND 17 chars, overrides masterVin
  // for that row only. Lets a tech write a different VIN to one specific
  // module (e.g. when transplanting a module from another VIN-locked car).
  const [perRowVin, setPerRowVin] = useState({});
  const [stopOnFail, setStopOnFail] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [batchResults, setBatchResults] = useState({}); // tx → { status, reason?, before?, after?, unlockAlgo?, errors? }
  // currentVins: tx → string|null. Populated by the "Read all current VINs"
  // preflight scan (no writes), shown next to each row.
  const [currentVins, setCurrentVins] = useState({});
  const [expandedErrors, setExpandedErrors] = useState({}); // tx → bool
  const [batchLog, setBatchLog] = useState([]);
  // Resumable-batch state. `savedSession` is the snapshot read from
  // sessionStorage on mount — when non-null we render a "Resume previous
  // batch?" banner. `sessionLoaded` gates the persist effect so the first
  // render doesn't clobber the saved snapshot before we've consumed it.
  const [savedSession, setSavedSession] = useState(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const blog = useCallback((m, t='info') => {
    setBatchLog(p => [...p.slice(-300), { t: new Date().toLocaleTimeString(), m, type: t }]);
  }, []);

  // ── On mount: look for an interrupted batch in sessionStorage ──
  // sessionStorage survives a page reload / in-tab navigation (but not
  // closing the tab itself), which covers the "USB unplug / browser
  // refresh / voltage drop while the tab stayed open" recovery flow.
  // Surviving a full tab close is tracked as a follow-up.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const txs = s && s.batchResults ? Object.keys(s.batchResults) : [];
        // Only offer a resume if the snapshot has at least one row that
        // wasn't fully verified — i.e. fail/pending/running/skipped.
        const incomplete = txs.some(tx => {
          const st = s.batchResults[tx]?.status;
          return st && st !== 'ok';
        });
        if (incomplete) setSavedSession(s);
        else { try { sessionStorage.removeItem(RESUME_KEY); } catch { /* ignore */ } }
      }
    } catch { /* ignore corrupt snapshot */ }
    setSessionLoaded(true);
  }, []);

  // ── Persist the in-flight batch on every relevant state change ──
  // We only write when the batch has actually started (batchResults is
  // non-empty) so an idle tab doesn't pollute sessionStorage. The
  // snapshot is cleared once every targeted row has verified ok.
  useEffect(() => {
    if (!sessionLoaded) return;
    if (!vinValid) return;
    const txs = Object.keys(batchResults);
    if (txs.length === 0) return;
    const allOk = !batchBusy && txs.every(tx => batchResults[tx].status === 'ok');
    try {
      if (allOk) {
        sessionStorage.removeItem(RESUME_KEY);
      } else {
        sessionStorage.setItem(RESUME_KEY, JSON.stringify({
          vin: masterVin,
          selection,
          perRowVin,
          batchResults,
          ts: Date.now(),
        }));
      }
    } catch { /* quota / private mode — silently ignore */ }
  }, [sessionLoaded, vinValid, masterVin, selection, perRowVin, batchResults, batchBusy]);

  const allWritable = partition.writable;
  const sgwBlockedRows = partition.blockedBySgw;
  // Two distinct gates:
  //   1. Bridge reachable — daemon is running, cable is plugged in.
  //   2. SGW authenticated — actual seed/key exchange succeeded for this VIN.
  // Both must be true before the runner will dispatch SGW-required rows.
  // Without (2), the SGW will silently reject every downstream WriteByID.
  const sgwAuthOk = sgwAuth.authenticated && sgwAuth.vin === masterVin;
  const sgwBatchBlocked = sgwBlockedRows.length > 0 && (!bridgeConnected || !sgwAuthOk);

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
  const setRowVin = useCallback((tx, v) => {
    setPerRowVin(p => ({ ...p, [tx]: (v || '').toUpperCase() }));
  }, []);
  const toggleErrors = useCallback((tx) => {
    setExpandedErrors(p => ({ ...p, [tx]: !p[tx] }));
  }, []);

  // Pre-entry "Read all current VINs" — preflight every selected row by
  // sending 0x22 0xF1 0x90 (no writes, no unlock). Populates currentVins
  // so the per-row card can show the on-bus VIN before the tech commits.
  const scanCurrentVins = useCallback(async () => {
    const targets = allWritable.filter(r => selection[r.tx]);
    if (targets.length === 0) { blog('Nothing selected to scan', 'warn'); return; }
    setScanBusy(true);
    blog(`═══ PREFLIGHT SCAN — ${targets.length} module${targets.length===1?'':'s'} ═══`, 'info');
    const needsBridge = targets.some(r => r.sgwRequired);
    let eng = null;
    // Test hook: when window.__SRT_TEST_ENGINE__ is set (Playwright suite),
    // bypass the real serial / bridge engines and use the injected stub.
    if (typeof window !== 'undefined' && window.__SRT_TEST_ENGINE__) {
      blog('🧪 using stubbed test engine', 'info');
      eng = window.__SRT_TEST_ENGINE__;
    } else if (needsBridge) {
      // Bridge reachable AND SGW authenticated for this VIN — both gates
      // apply to preflight reads too, because every 0x22 to a body-bus
      // module on a 2018+ truck still has to traverse the SGW.
      if (!isSgwAuthenticated(masterVin)) {
        blog('🛑 SGW not authenticated for this VIN — open AUTEL SGW tab and click AUTHENTICATE SGW first', 'error');
        setScanBusy(false);
        return;
      }
      const br = await createBridgeEngine({ addLog: (m,t)=>blog(m,t) });
      if (!br.ok) { blog('Bridge unavailable — aborting scan: '+br.error, 'error'); setScanBusy(false); return; }
      eng = br.engine;
    } else {
      eng = await initAdapter((m,t)=>blog(m,t), hx);
      if (!eng) { blog('Adapter init failed — aborting scan', 'error'); setScanBusy(false); return; }
    }
    for (const row of targets) {
      const r = await eng.uds(row.tx, row.rx, [0x22, 0xF1, 0x90]);
      if (r.ok && r.d && r.d[0] === 0x62) {
        const data = Array.from(r.d).slice(3);
        const ascii = data.filter(b => b >= 0x20 && b <= 0x7E).map(b => String.fromCharCode(b)).join('').trim();
        const vin = ascii.length >= 17 ? ascii.slice(-17) : ascii;
        setCurrentVins(p => ({ ...p, [row.tx]: vin || null }));
        blog(`  ${row.code}: ${vin || '(empty)'}`, 'rx');
      } else {
        setCurrentVins(p => ({ ...p, [row.tx]: null }));
        blog(`  ${row.code}: no response`, 'warn');
      }
    }
    blog('═══ SCAN DONE ═══', 'info');
    setScanBusy(false);
  }, [allWritable, selection, blog]);

  const runBatch = useCallback(async (opts = {}) => {
    if (!vinValid) { blog('Master VIN must be valid before running a batch', 'error'); return; }
    // Resume mode: caller passes priorResults so we can skip rows that
    // already verified ok and only retry fail/pending/skipped/running.
    // Resume callers also pass selectionOverride / perRowVinOverride so
    // we operate on the saved snapshot directly instead of reading
    // through stale closures captured by useCallback. Writing the wrong
    // VIN to the wrong module is unacceptable in this flow.
    const priorResults = opts.priorResults || null;
    const activeSelection = opts.selectionOverride || selection;
    const activePerRowVin = opts.perRowVinOverride || perRowVin;
    const allTargets = allWritable.filter(r => activeSelection[r.tx]);
    if (allTargets.length === 0) { blog('No modules selected', 'warn'); return; }
    let targets = allTargets;
    let preservedOk = 0;
    if (priorResults) {
      const okSet = new Set(Object.keys(priorResults).filter(tx => priorResults[tx]?.status === 'ok').map(Number));
      preservedOk = allTargets.filter(r => okSet.has(r.tx)).length;
      targets = allTargets.filter(r => !okSet.has(r.tx));
      if (targets.length === 0) { blog('Nothing to resume — every selected row is already OK', 'warn'); return; }
    }

    setBatchBusy(true);
    // Preserve already-verified rows on resume so the grid keeps its
    // green badges; otherwise wipe results for a clean run.
    setBatchResults(priorResults ? { ...priorResults } : {});
    setBatchLog([]);
    if (priorResults) {
      blog(`═══ RESUMING BATCH — ${targets.length} retry · ${preservedOk} already ok ═══`, 'info');
    } else {
      blog(`═══ UNIVERSAL VIN BATCH — ${targets.length} module${targets.length===1?'':'s'} ═══`, 'info');
    }
    blog(`Target VIN: ${masterVin}`, 'info');

    // Decide which uds engine to use. If any selected row needs SGW we
    // route the whole batch through the bridge; otherwise we use the
    // standard ELM/STN serial engine.
    const needsBridge = targets.some(r => r.sgwRequired);
    let activeEng = null;
    // Test hook: when window.__SRT_TEST_ENGINE__ is set (Playwright suite),
    // bypass the real serial / bridge engines and use the injected stub.
    if (typeof window !== 'undefined' && window.__SRT_TEST_ENGINE__) {
      blog('🧪 using stubbed test engine', 'info');
      activeEng = window.__SRT_TEST_ENGINE__;
    } else if (needsBridge) {
      // Hard gate: refuse to dispatch ANY write when the SGW hasn't been
      // unlocked for this VIN. The bridge being reachable is necessary
      // but not sufficient — without (b) the SGW silently rejects every
      // downstream WriteByID and the tech is left chasing ghost NRCs.
      if (!isSgwAuthenticated(masterVin)) {
        blog('🛑 SGW REQUIRED but not authenticated for this VIN', 'error');
        blog('Open the AUTEL SGW tab and click AUTHENTICATE SGW first.', 'error');
        setBatchBusy(false);
        return;
      }
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
      // Per-row VIN override: if the tech entered a 17-char VIN for this
      // specific row, use it; otherwise use the master VIN.
      const rowOverride = (activePerRowVin[row.tx] || '').trim();
      const vinForThisRow = rowOverride.length === 17 ? rowOverride : masterVin;
      const usingOverride = vinForThisRow !== masterVin;

      blog(`── ${row.code} (TX 0x${hx(row.tx,3)})${usingOverride?` · VIN OVERRIDE → ${vinForThisRow}`:''} ──`, 'info');
      setBatchResults(p => ({ ...p, [row.tx]: { status: 'running' } }));

      const rowLog = (m,t)=>blog(`  ${m}`, t);
      const r = await programVin({
        eng: activeEng,
        row,
        vin: vinForThisRow,
        addLog: rowLog,
        makeBackup: async ({uds,snapshotKind,preWriteKey}) =>
          backupModule(uds, row.tx, row.rx, row.code, rowLog, hx, snapshotKind, preWriteKey),
      });
      // Refresh currentVins from the verification read — keeps the per-row
      // display in sync after every batch.
      if (r.afterVin) setCurrentVins(p => ({ ...p, [row.tx]: r.afterVin }));

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
  }, [vinValid, masterVin, allWritable, selection, perRowVin, stopOnFail, blog, setModuleStatus]);

  // ── Resume an interrupted batch ──
  // Restores selection / per-row VIN overrides / prior results from the
  // sessionStorage snapshot, then kicks off runBatch in resume mode so
  // it skips already-verified rows and only retries the rest.
  const resumeSavedSession = useCallback(() => {
    if (!savedSession) return;
    const sel = savedSession.selection || {};
    const rowVin = savedSession.perRowVin || {};
    const prior = savedSession.batchResults || {};
    // Mirror the snapshot into React state so the grid renders the
    // restored selection / overrides / badges, then kick off runBatch
    // with the same values passed explicitly so we don't depend on a
    // re-render to flush the new state into runBatch's closure. This
    // matters because writing the wrong VIN to the wrong module is a
    // hard-to-undo mistake on a real bench.
    setSelection(sel);
    setPerRowVin(rowVin);
    setBatchResults(prior);
    setSavedSession(null);
    runBatch({ priorResults: prior, selectionOverride: sel, perRowVinOverride: rowVin });
  }, [savedSession, runBatch]);

  const discardSavedSession = useCallback(() => {
    try { sessionStorage.removeItem(RESUME_KEY); } catch { /* ignore */ }
    setSavedSession(null);
  }, []);

  // Banner numbers — count rows in the saved snapshot by status.
  const savedCounts = useMemo(() => {
    if (!savedSession?.batchResults) return null;
    const c = { ok: 0, fail: 0, pending: 0, skipped: 0, other: 0 };
    for (const tx of Object.keys(savedSession.batchResults)) {
      const st = savedSession.batchResults[tx]?.status;
      if (st in c) c[st]++; else c.other++;
    }
    return c;
  }, [savedSession]);
  const savedVinMismatch = !!(savedSession && vinValid && savedSession.vin && savedSession.vin !== masterVin);

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

    {/* ── Resume-previous-batch banner ── */}
    {savedSession && savedCounts && <Card data-testid="resume-banner" style={{
      marginBottom:14,
      background:'linear-gradient(135deg,#FFF8E1 0%,#FFE082 100%)',
      border:'2px solid '+C.wn,
    }}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
        <div style={{flex:1,minWidth:240}}>
          <div style={{fontWeight:900,fontSize:13,color:'#5D4037',letterSpacing:1}}>
            ⚠ INTERRUPTED BATCH FOUND
          </div>
          <div style={{fontSize:12,color:'#5D4037',marginTop:4,lineHeight:1.5}}>
            A previous run for VIN <b data-testid="resume-saved-vin" style={{fontFamily:"'JetBrains Mono'"}}>{savedSession.vin || '(unknown)'}</b> was
            cut short. <b data-testid="resume-ok-count">{savedCounts.ok}</b> ok ·{' '}
            <b data-testid="resume-retry-count">{savedCounts.fail + savedCounts.pending + savedCounts.skipped + savedCounts.other}</b> to retry.
          </div>
          {savedVinMismatch && <div style={{fontSize:11,color:C.er,marginTop:6,fontWeight:700}}>
            ⚠ Master VIN was changed since — set the Master VIN back to <b style={{fontFamily:"'JetBrains Mono'"}}>{savedSession.vin}</b> to resume, or discard.
          </div>}
        </div>
        <div style={{display:'flex',gap:8}}>
          <Btn data-testid="resume-btn"
            onClick={resumeSavedSession}
            disabled={batchBusy || savedVinMismatch || !vinValid}
            color={C.gn}>
            ▶ Resume previous batch
          </Btn>
          <Btn data-testid="resume-discard-btn"
            onClick={discardSavedSession}
            disabled={batchBusy}
            color={C.tm} outline>
            ✕ Discard
          </Btn>
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
          <Btn onClick={scanCurrentVins} disabled={batchBusy||scanBusy||selectedCount===0} color={C.a2} outline>
            {scanBusy?'⏳ scanning…':'📖 read current VINs'}
          </Btn>
          <Btn onClick={runBatch} disabled={batchBusy||!vinValid||selectedCount===0||sgwBatchBlocked} color={C.sr}>
            {batchBusy?'⏳ Running…':`▶ Program ${selectedCount} module${selectedCount===1?'':'s'}`}
          </Btn>
        </div>
      </div>

      {sgwBatchBlocked&&<div style={{padding:10,background:'#FFEBEE',border:'2px solid '+C.er,borderRadius:8,marginBottom:12,fontSize:12,color:'#B71C1C'}}>
        🛑 <b>SGW required</b> — this VIN ({masterVin.slice(0,4)}…) targets a 2018+ secure-gateway vehicle.
        {!bridgeConnected
          ?<> Open the <a href="#" onClick={e=>{e.preventDefault();setPg('autel');}} style={{color:C.sr,fontWeight:800}}>AUTEL SGW tab</a>, start <code>j2534_bridge.py</code>, then retry.</>
          :<> Bridge is connected, but SGW is <b>not authenticated</b> for this VIN. Open the <a href="#" onClick={e=>{e.preventDefault();setPg('autel');}} style={{color:C.sr,fontWeight:800}}>AUTEL SGW tab</a> and click <b>AUTHENTICATE SGW</b> to run the seed/key dance.</>}
        {' '}<b>{sgwBlockedRows.length}</b> module(s) currently require SGW authentication.
      </div>}

      <div data-testid="universal-grid" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(260px, 1fr))',gap:8}}>
        {allWritable.map(r => {
          const sel = !!selection[r.tx];
          const res = batchResults[r.tx] || { status: 'pending' };
          const stColor = STATUS_COLORS[res.status] || STATUS_COLORS.pending;
          const cur = currentVins[r.tx];
          const override = (perRowVin[r.tx] || '').trim();
          const overrideValid = override.length === 0 || override.length === 17;
          const expanded = !!expandedErrors[r.tx];
          return <div key={r.tx} data-testid={'urow-'+r.code} style={{
            display:'flex',gap:8,alignItems:'flex-start',padding:10,
            background:sel?'#F8FFF8':'#F5F5F5',
            border:'1.5px solid '+(sel?C.gn:C.bd),borderRadius:8,
            opacity:batchBusy?.85:1,
          }}>
            <input type="checkbox" checked={sel} disabled={batchBusy}
              onChange={()=>toggleSelection(r.tx)} style={{marginTop:2,cursor:batchBusy?'not-allowed':'pointer'}}/>
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
              {/* Per-row preflight VIN read (populated by "Read current VINs"
                  or by the verification pass after a successful write). */}
              <div data-testid={'ucur-'+r.code} style={{fontSize:9,color:cur?C.ts:C.tm,fontFamily:"'JetBrains Mono'",marginTop:4}}>
                current: <b>{cur || '(unread)'}</b>
              </div>
              {/* Per-row VIN override input — empty falls back to the master VIN. */}
              <input
                data-testid={'uvin-'+r.code}
                type="text"
                placeholder="override VIN (optional)"
                maxLength={17}
                value={override}
                disabled={batchBusy}
                onChange={e=>setRowVin(r.tx, e.target.value)}
                onClick={e=>e.stopPropagation()}
                style={{
                  marginTop:4,width:'100%',fontFamily:"'JetBrains Mono'",fontSize:10,
                  padding:'4px 6px',borderRadius:4,
                  border:'1px solid '+(overrideValid?C.bd:C.er),
                  background:override?'#FFF8E1':'#fff',
                }}
              />
              {res.status==='fail'&&<div style={{marginTop:4}}>
                <button onClick={()=>toggleErrors(r.tx)} style={{fontSize:9,color:C.er,background:'transparent',border:'none',padding:0,cursor:'pointer',textDecoration:'underline'}}>
                  {REASON_LABELS[res.reason]||res.reason} {res.errors&&res.errors.length>0?(expanded?'▼':'▶'):''}
                </button>
                {expanded&&res.errors&&res.errors.length>0&&<div data-testid={'uerr-'+r.code} style={{marginTop:3,padding:6,background:'#FFEBEE',border:'1px solid '+C.er,borderRadius:4,fontSize:9,color:'#B71C1C',fontFamily:"'JetBrains Mono'"}}>
                  {res.errors.map((e,i)=><div key={i}>• {e}</div>)}
                </div>}
              </div>}
              {res.status==='ok'&&res.unlockAlgo&&res.unlockAlgo!==true&&<div style={{fontSize:9,color:C.gn,marginTop:2}}>via {res.unlockAlgo}</div>}
            </div>
          </div>;
        })}
      </div>

      {batchLog.length>0&&<div style={{marginTop:14,background:'#0D0D15',color:'#E0E0E0',borderRadius:6,padding:10,maxHeight:240,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.5}}>
        {batchLog.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>}
    </Card>

    {/* ── Reference panels: unsupported / no-vin / pending-W7 ── */}
    {(partition.unsupported.length>0||partition.pendingW7.length>0||partition.noVin.length>0)&&<Card style={{marginBottom:14,background:'#FAFAFA'}}>
      <div style={{fontWeight:800,fontSize:11,color:C.ts,letterSpacing:2,marginBottom:10}}>📋 REFERENCE — NOT TARGETED FOR VIN WRITES</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:14}}>
        <div>
          <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6}}>Unsupported (gateway / proxy)</div>
          {partition.unsupported.map(r=><div key={r.tx} style={{fontSize:11,color:C.ts,fontFamily:"'JetBrains Mono'",marginBottom:2}}>
            <b style={{color:C.tx}}>{r.code}</b> · 0x{hx(r.tx,3)} — {r.notes||r.name}
          </div>)}
          {partition.unsupported.length===0&&<div style={{fontSize:11,color:C.tm,fontStyle:'italic'}}>none</div>}
        </div>
        <div>
          <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6}}>No VIN slot (passive sensors)</div>
          {partition.noVin.map(r=><div key={r.tx} data-testid={'unovin-'+r.code} style={{fontSize:11,color:C.ts,fontFamily:"'JetBrains Mono'",marginBottom:2}}>
            <b style={{color:C.tx}}>{r.code}</b> · 0x{hx(r.tx,3)} — {r.notes||r.name}
          </div>)}
          {partition.noVin.length===0&&<div style={{fontSize:11,color:C.tm,fontStyle:'italic'}}>none</div>}
        </div>
        <div>
          <div style={{fontSize:11,fontWeight:800,color:C.wn,marginBottom:6}}>Pending W7 cipher (task #145)</div>
          {partition.pendingW7.map(r=><div key={r.tx} style={{fontSize:11,color:C.ts,fontFamily:"'JetBrains Mono'",marginBottom:2}}>
            <b style={{color:C.tx}}>{r.code}</b> · 0x{hx(r.tx,3)} — attempted, will fail-soft
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

    {/* ── Module Sync shortcut card ── */}
    <div data-testid="modsync-shortcut">
    <Card style={{marginBottom:12,borderLeft:'5px solid '+C.a4,padding:0,overflow:'hidden'}}>
      <div style={{padding:'16px 20px',display:'grid',gridTemplateColumns:'auto 1fr auto',gap:16,alignItems:'center'}}>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <div style={{width:40,height:40,borderRadius:10,background:C.a4+'15',display:'flex',alignItems:'center',justifyContent:'center',fontSize:22}}>🔄</div>
          <div style={{fontSize:24,fontWeight:900,color:C.a4,fontFamily:"'Righteous'"}}>5</div>
        </div>
        <div>
          <div style={{fontWeight:800,fontSize:14,color:C.tx}}>Module Sync — BCM ↔ RFHUB</div>
          <div style={{fontSize:11,color:C.ts,marginTop:2}}>
            Offline file-based sync for 2016–2017 Continental BCM + Yazaki FCM. Patches VIN slots in both .bin dumps, optionally virginizes SEC16.
            {vinValid&&<span style={{marginLeft:6,fontFamily:"'JetBrains Mono'",fontWeight:800,color:C.a4}}>Master VIN will pre-fill as target.</span>}
          </div>
        </div>
        <Btn onClick={()=>setPg('modsync')} color={C.a4}>
          Open Sync →
        </Btn>
      </div>
    </Card>
    </div>

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
