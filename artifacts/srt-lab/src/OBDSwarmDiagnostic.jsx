import { useState, useCallback, useRef, useEffect } from "react";
import { buildOnePagerPDF } from "./lib/buildOnePagerPDF.js";
import { SWARM_REF } from "./lib/tabReferences.js";

const ALL_KNOWN_ADDRS = [
  {tx:0x7E0,rx:0x7E8,src:'CDA6',name:'ECM/PCM'},
  {tx:0x7E1,rx:0x7E9,src:'CDA6',name:'TCM'},
  {tx:0x7E2,rx:0x7EA,src:'CDA6',name:'TCMP'},
  {tx:0x750,rx:0x758,src:'CDA6',name:'BCM'},
  {tx:0x75F,rx:0x767,src:'CDA6',name:'RFHUB/EPS'},
  {tx:0x760,rx:0x768,src:'CDA6',name:'ABS'},
  {tx:0x740,rx:0x748,src:'CDA6',name:'IPC'},
  {tx:0x758,rx:0x760,src:'CDA6',name:'ORC'},
  {tx:0x7A8,rx:0x7B0,src:'CDA6',name:'ADCM'},
  {tx:0x7A0,rx:0x7A8,src:'CDA6',name:'AMP'},
  {tx:0x770,rx:0x778,src:'CDA6',name:'BSM'},
  {tx:0x7E4,rx:0x7EC,src:'CDA6',name:'BPCM'},
  {tx:0x742,rx:0x762,src:'CLAUDE',name:'BCM/RFHUB'},
  {tx:0x745,rx:0x765,src:'CLAUDE',name:'IPC/SDM'},
  {tx:0x772,rx:0x77A,src:'CLAUDE',name:'RADIO'},
  {tx:0x761,rx:0x769,src:'CLAUDE',name:'EPS'},
  {tx:0x74C,rx:0x76C,src:'CLAUDE',name:'TIPM'},
  {tx:0x6B0,rx:0x6B8,src:'DVIN',name:'BCM'},
  {tx:0x743,rx:0x763,src:'DVIN',name:'CCM'},
  {tx:0x744,rx:0x764,src:'DVIN',name:'ADM'},
  {tx:0x746,rx:0x766,src:'DVIN',name:'IPCM'},
  {tx:0x747,rx:0x767,src:'DVIN',name:'ORC'},
  {tx:0x748,rx:0x768,src:'DVIN',name:'DDM'},
  {tx:0x749,rx:0x769,src:'DVIN',name:'PDM'},
  {tx:0x74A,rx:0x76A,src:'DVIN',name:'EPS'},
  {tx:0x74B,rx:0x76B,src:'DVIN',name:'SCCM'},
  {tx:0x74E,rx:0x76E,src:'DVIN',name:'TPMS'},
  {tx:0x74F,rx:0x76F,src:'XTEA',name:'SGW',unlock:'xtea_sgw'},
  {tx:0x751,rx:0x759,src:'DVIN',name:'HVAC'},
  {tx:0x752,rx:0x75A,src:'DVIN',name:'TPM'},
  {tx:0x753,rx:0x773,src:'DVIN',name:'RADIO'},
  {tx:0x754,rx:0x75C,src:'DVIN',name:'RADIO2'},
  {tx:0x7B0,rx:0x7B8,src:'SWARM',name:'BCM'},
  {tx:0x720,rx:0x728,src:'SWARM',name:'IPC'},
  {tx:0x762,rx:0x76A,src:'SWARM',name:'RFHUB'},
  {tx:0x7C0,rx:0x7C8,src:'SWARM',name:'GWAY'},
  {tx:0x7D0,rx:0x7D8,src:'SWARM',name:'RADIO'},
  {tx:0x730,rx:0x738,src:'SWARM',name:'ORC'},
  {tx:0x6C0,rx:0x6C8,src:'SWARM',name:'REAR_AXLE'},
  {tx:0x700,rx:0x708,src:'SWARM',name:'ACC'},
  {tx:0x620,rx:0x628,src:'PNET',name:'BCM'},
  {tx:0x741,rx:0x749,src:'PNET',name:'SKIM'},
  {tx:0x7C8,rx:0x7D0,src:'PNET',name:'RADIO'},
  {tx:0x688,rx:0x690,src:'PNET',name:'HVAC'},
];

const UNIQUE_ADDRS = [];
const _seen = new Set();
for (const a of ALL_KNOWN_ADDRS) {
  const k = a.tx + ':' + a.rx;
  if (!_seen.has(k)) { _seen.add(k); UNIQUE_ADDRS.push(a); }
}

const AGENT_COLORS = {
  SCOUT:   '#00E5FF',
  HUNTER:  '#FF6D00',
  SWEEPER: '#76FF03',
  SHIFTER: '#E040FB',
  BRUTE:   '#FF1744',
  SYSTEM:  '#B0BEC5',
  FOUND:   '#FFD600',
};

const STATE_COLORS = {
  pending:   '#555',
  probing:   '#00E5FF',
  retrying:  '#FF6D00',
  confirmed: '#66BB6A',
  exhausted: '#FF1744',
};

const STRATEGIES = [
  { id: 'S0', name: 'EXT_VIN',       label: 'ExtSession→VIN' },
  { id: 'S1', name: 'DEF_VIN',       label: 'DefSession→VIN' },
  { id: 'S2', name: 'RAW_VIN',       label: 'RawVIN' },
  { id: 'S3', name: 'TESTER_PRESENT',label: 'TesterPresent' },
  { id: 'S4', name: 'SLOW_TIMING',   label: 'SlowTiming+VIN' },
  { id: 'S5', name: 'SP5_250K',      label: 'SP5(250k)+VIN' },
  { id: 'S6', name: 'SP7_33K',       label: 'SP7(33k)+VIN' },
  { id: 'S7', name: 'FUNC_BCAST',    label: 'FuncBcast' },
  { id: 'S8', name: 'SOFT_RESET',    label: 'AdapReset+VIN' },
];

function mkModules() {
  return UNIQUE_ADDRS.map(a => ({
    tx: a.tx, rx: a.rx, name: a.name, src: a.src,
    state: 'pending',
    strategyIdx: 0,
    attempts: 0,
    lastError: '',
    confirmedBy: '',
    vin: null,
  }));
}

function parseVin(d) {
  if (!d || d.length < 3) return null;
  const vc = Array.from(d).filter(b => b >= 0x20 && b <= 0x7E);
  const vs = String.fromCharCode(...vc).slice(-17);
  return vs.length >= 10 ? vs : null;
}

function hx3(n) { return n.toString(16).toUpperCase().padStart(3, '0'); }

async function runStrategy(stratIdx, mod, eng, addLog) {
  const { send, uds, isSTN } = eng;
  const { tx, rx } = mod;

  const tryVin = async (sess) => {
    if (sess) {
      const ds = await uds(tx, rx, sess);
      if (!ds.ok) return { ok: false, reason: 'session_fail:' + (ds.raw||'').slice(0,20) };
    }
    const r = await uds(tx, rx, [0x22, 0xF1, 0x90]);
    if (r.ok) return { ok: true, vin: parseVin(r.d) };
    return { ok: false, reason: 'vin_fail:' + (r.raw||'').slice(0,20) };
  };

  switch (stratIdx) {
    case 0: return tryVin([0x10, 0x03]);
    case 1: return tryVin([0x10, 0x01]);
    case 2: return tryVin(null);
    case 3: {
      const r = await uds(tx, rx, [0x3E, 0x00]);
      if (r.ok) return { ok: true, vin: null };
      return { ok: false, reason: 'tp_fail:' + (r.raw||'').slice(0,20) };
    }
    case 4: {
      let res;
      try {
        await send('ATST32');
        res = await tryVin([0x10, 0x03]);
      } finally {
        await send('ATST96');
      }
      return res;
    }
    case 5: {
      let res;
      try {
        await send('ATSP5');
        await new Promise(r => setTimeout(r, 300));
        await send('ATH1'); await send('ATCAF1'); await send('ATST96');
        res = await tryVin([0x10, 0x03]);
      } finally {
        await send('ATSP6');
        await new Promise(r => setTimeout(r, 200));
        await send('ATH1'); await send('ATCAF1'); await send('ATAT2'); await send('ATST96');
        if (isSTN) { await send('ATFCSH7E0'); await send('ATFCSD300000'); await send('ATFCSM1'); }
      }
      return res;
    }
    case 6: {
      let res;
      try {
        await send('ATSP7');
        await new Promise(r => setTimeout(r, 300));
        await send('ATH1'); await send('ATCAF1'); await send('ATST96');
        res = await tryVin([0x10, 0x03]);
      } finally {
        await send('ATSP6');
        await new Promise(r => setTimeout(r, 200));
        await send('ATH1'); await send('ATCAF1'); await send('ATAT2'); await send('ATST96');
        if (isSTN) { await send('ATFCSH7E0'); await send('ATFCSD300000'); await send('ATFCSM1'); }
      }
      return res;
    }
    case 7: {
      await send('ATCRA');
      await send('ATSH7DF');
      if (isSTN) await send('ATFCSH7DF');
      const bcast = await send('22 F1 90', 6000);
      if (bcast && !bcast.includes('NO DATA') && !bcast.includes('CAN ERROR')) {
        for (const line of bcast.split(/[\r\n]+/)) {
          const t = line.trim();
          if (/^[0-9A-Fa-f]{3}\s/.test(t)) {
            const rid = parseInt(t.slice(0,3), 16);
            if (rid === rx) return { ok: true, vin: null };
          }
        }
      }
      return { ok: false, reason: 'bcast_miss' };
    }
    case 8: {
      addLog('SYSTEM', `Soft reset for ${mod.name} (${hx3(tx)})...`, AGENT_COLORS.SYSTEM);
      await send('ATZ', 3000);
      await new Promise(r => setTimeout(r, 800));
      await send('ATE0'); await send('ATL0'); await send('ATS1'); await send('ATH1');
      await send('ATSP6'); await send('ATAT2'); await send('ATST96'); await send('ATCAF1');
      if (isSTN) {
        await send('ATPP2CSV81', 2000); await send('ATPP2CON', 2000);
        await send('ATPP2DSV01', 2000); await send('ATPP2DON', 2000);
        await send('ATZ', 3000); await new Promise(r => setTimeout(r, 800));
        await send('ATE0'); await send('ATL0'); await send('ATS1'); await send('ATH1');
        await send('ATSP6'); await send('ATAT2'); await send('ATST96'); await send('ATCAF1');
        await send('ATFCSH7E0'); await send('ATFCSD300000'); await send('ATFCSM1');
      }
      return tryVin([0x10, 0x03]);
    }
    default: return { ok: false, reason: 'no_more_strategies' };
  }
}

export default function OBDSwarmDiagnostic() {
  const [logs, setLogs] = useState([]);
  const [moduleStates, setModuleStates] = useState(mkModules());
  const [status, setStatus] = useState('disconnected');
  const [running, setRunning] = useState(false);
  const [ppEnabled, setPpEnabled] = useState(false);
  const [totalAttempts, setTotalAttempts] = useState(0);
  const [pdfBusy, setPdfBusy] = useState(false);
  const onPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try { await buildOnePagerPDF(SWARM_REF); }
    catch (e) { console.error(e); alert('PDF build failed: ' + e.message); }
    finally { setPdfBusy(false); }
  };
  const eng = useRef(null);
  const logRef = useRef(null);
  const attemptsRef = useRef(0);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((agent, msg, color) => {
    const ts = new Date().toLocaleTimeString('en-US', {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    setLogs(p => [...p.slice(-600), { ts, agent, msg, color: color || AGENT_COLORS[agent] || '#fff' }]);
  }, []);

  const connect = useCallback(async () => {
    if (!navigator.serial) { addLog('SYSTEM', 'Web Serial not available — use Chrome/Edge', AGENT_COLORS.SYSTEM); return; }
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      const w = port.writable.getWriter();
      const rd = port.readable.getReader();
      const tdec = new TextDecoder();
      let rbuf = '';

      const send = async (cmd, to = 3000) => {
        rbuf = '';
        await w.write(new TextEncoder().encode(cmd + '\r'));
        const deadline = Date.now() + to;
        while (Date.now() < deadline) {
          try {
            const rp = rd.read();
            const tp = new Promise(r => setTimeout(() => r({value:undefined,done:true}), Math.min(500, deadline - Date.now())));
            const res = await Promise.race([rp, tp]);
            if (res.done || !res.value) { if (Date.now() >= deadline) break; continue; }
            rbuf += tdec.decode(res.value);
            const pi = rbuf.indexOf('>');
            if (pi !== -1) {
              const r = rbuf.substring(0, pi).replace(/\r/g,'\n').replace(/\n+/g,'\n').trim();
              rbuf = rbuf.substring(pi + 1);
              return r;
            }
          } catch(e) { break; }
        }
        return rbuf.replace(/\r/g,'\n').replace(/\n+/g,'\n').replace(/>/g,'').trim();
      };

      const uds = async (tx, rx, data) => {
        await send('ATCRA');
        await send('ATSH' + hx3(tx));
        if (eng.current?.isSTN) await send('ATFCSH' + hx3(tx));
        await send('ATCRA' + hx3(rx));
        const h = data.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
        const r = await send(h, 4000);
        if (!r || /NO DATA|CAN ERROR|UNABLE|BUS ERROR/.test(r)) return { ok:false, raw:r||'' };
        if (r.includes('?') || r.includes('ERROR')) return { ok:false, raw:r };
        const lines = r.split(/[\r\n]+/).map(l=>l.trim()).filter(l=>l.length>0);
        let all = [];
        for (const line of lines) {
          if (line.includes('SEARCHING') || line === 'OK') continue;
          const toks = line.split(/\s+/);
          if (toks.length < 2) continue;
          const first = toks[0].toUpperCase();
          if (/^[0-9A-F]{3}$/.test(first)) {
            for (let i=1;i<toks.length;i++) { if (/^[0-9A-Fa-f]{2}$/.test(toks[i])) all.push(parseInt(toks[i],16)); }
          } else {
            for (const t of toks) { if (/^[0-9A-Fa-f]{2}$/.test(t)) all.push(parseInt(t,16)); }
          }
        }
        if (!all.length) return { ok:false, raw:r };
        return { ok:true, d:new Uint8Array(all), raw:r };
      };

      addLog('SYSTEM', 'Initializing OBDLink...', AGENT_COLORS.SYSTEM);
      await send('ATZ', 3000); await new Promise(r => setTimeout(r, 500));
      await send('ATE0');
      const ati = await send('ATI');
      const stdi = await send('STDI');
      const isSTN = !stdi.includes('?') && !stdi.includes('ERROR') && stdi.length > 2;
      const rv = await send('ATRV');
      addLog('SYSTEM', `${isSTN ? 'OBDLink STN' : 'ELM327'} | ${ati} | ${rv}`, AGENT_COLORS.SYSTEM);

      if (isSTN) {
        addLog('SYSTEM', 'Enabling MFG extended mode (PP2C=81)...', AGENT_COLORS.SYSTEM);
        await send('ATPP2CSV81', 2000); await send('ATPP2CON', 2000);
        await send('ATPP2DSV01', 2000); await send('ATPP2DON', 2000);
        await send('ATZ', 3000); await new Promise(r => setTimeout(r, 1000));
        await send('ATE0'); await new Promise(r => setTimeout(r, 300));
        setPpEnabled(true);
        addLog('SYSTEM', 'MFG extended mode ACTIVE', AGENT_COLORS.FOUND);
      }

      await send('ATL0'); await send('ATS1'); await send('ATH1');
      await send('ATSP6'); await send('ATAT2'); await send('ATST96'); await send('ATCAF1');
      if (isSTN) { await send('ATFCSH7E0'); await send('ATFCSD300000'); await send('ATFCSM1'); }

      eng.current = { send, uds, isSTN };
      setStatus('connected');
      addLog('SYSTEM', 'Ready — launch SWARM to begin agentic scan', AGENT_COLORS.FOUND);
    } catch(e) {
      addLog('SYSTEM', 'Connect failed: ' + e.message, '#FF1744');
    }
  }, [addLog]);

  const launchSwarm = useCallback(async () => {
    if (!eng.current) return;
    attemptsRef.current = 0;
    setTotalAttempts(0);
    setRunning(true);

    const mods = mkModules();
    setModuleStates([...mods]);

    const { send, uds, isSTN } = eng.current;
    const engObj = { send, uds, isSTN };

    const updateMod = (mod) => {
      setModuleStates(prev => {
        const next = [...prev];
        const idx = next.findIndex(m => m.tx === mod.tx && m.rx === mod.rx);
        if (idx !== -1) next[idx] = { ...mod };
        return next;
      });
    };

    const markConfirmed = (mod, strategy, vin) => {
      mod.state = 'confirmed';
      mod.confirmedBy = strategy;
      mod.vin = vin || null;
      updateMod(mod);
      addLog('FOUND', `✓ ${mod.name} TX:${hx3(mod.tx)} via ${strategy}${vin ? ' VIN:'+vin : ''}`, AGENT_COLORS.FOUND);
    };

    addLog('SCOUT', '🔍 Passive CAN monitor (4s)...', AGENT_COLORS.SCOUT);
    await send('ATCRA');
    const ma = await send('ATMA', 4500);
    await send('\r');
    await new Promise(r => setTimeout(r, 300));
    const busIds = new Set();
    if (ma) {
      for (const line of ma.split(/[\r\n]+/)) {
        const t = line.trim();
        if (/^[0-9A-Fa-f]{3}\s/.test(t)) busIds.add(t.slice(0,3).toUpperCase());
      }
    }
    if (busIds.size > 0) {
      addLog('SCOUT', `Bus ALIVE: ${busIds.size} CAN IDs seen`, AGENT_COLORS.SCOUT);
      const diagIds = [...busIds].filter(id => parseInt(id,16) >= 0x600);
      if (diagIds.length) addLog('SCOUT', `Diag-range IDs: ${diagIds.join(', ')}`, AGENT_COLORS.FOUND);
      for (const mod of mods) {
        const rxHex = hx3(mod.rx);
        if (busIds.has(rxHex)) {
          markConfirmed(mod, 'BUS_PASSIVE', null);
        }
      }
    } else {
      addLog('SCOUT', 'WARNING: No CAN traffic seen!', '#FF1744');
    }

    await send('ATSP6'); await send('ATH1'); await send('ATS1'); await send('ATCAF1');
    await send('ATAT2'); await send('ATST96');
    if (isSTN) { await send('ATFCSH7E0'); await send('ATFCSD300000'); await send('ATFCSM1'); }

    addLog('HUNTER', '📡 Functional broadcast 7DF → VIN...', AGENT_COLORS.HUNTER);
    await send('ATCRA');
    await send('ATSH7DF');
    if (isSTN) await send('ATFCSH7DF');
    const bcast = await send('22 F1 90', 6000);
    if (bcast && !bcast.includes('NO DATA') && !bcast.includes('CAN ERROR')) {
      for (const bl of bcast.split(/[\r\n]+/)) {
        const bt = bl.trim();
        if (/^[0-9A-Fa-f]{3}\s/.test(bt)) {
          const rid = parseInt(bt.slice(0,3), 16);
          const mod = mods.find(m => m.rx === rid);
          if (mod && mod.state !== 'confirmed') markConfirmed(mod, 'BCAST_VIN', null);
        }
      }
    }

    addLog('HUNTER', '📡 TesterPresent broadcast...', AGENT_COLORS.HUNTER);
    await send('ATCRA');
    await send('ATSH7DF');
    const tpb = await send('3E 00', 4000);
    if (tpb && !tpb.includes('NO DATA') && !tpb.includes('CAN ERROR')) {
      for (const bl of tpb.split(/[\r\n]+/)) {
        const bt = bl.trim();
        if (/^[0-9A-Fa-f]{3}\s/.test(bt)) {
          const rid = parseInt(bt.slice(0,3), 16);
          const mod = mods.find(m => m.rx === rid);
          if (mod && mod.state !== 'confirmed') markConfirmed(mod, 'BCAST_TP', null);
        }
      }
    }

    addLog('SWEEPER', `🤖 Agentic loop starting — ${mods.filter(m=>m.state==='pending').length} modules to negotiate...`, AGENT_COLORS.SWEEPER);

    for (;;) {
      const active = mods.filter(m => m.state === 'pending' || m.state === 'retrying');
      if (active.length === 0) break;

      for (const mod of active) {

        mod.state = 'probing';
        updateMod(mod);

        const strat = STRATEGIES[mod.strategyIdx];
        addLog('SWEEPER', `→ ${mod.name}(${hx3(mod.tx)}) [${strat.label}] attempt #${mod.attempts+1}`, AGENT_COLORS.SWEEPER);

        let result;
        try {
          result = await runStrategy(mod.strategyIdx, mod, engObj, addLog);
        } catch(e) {
          result = { ok: false, reason: 'exception:'+e.message };
        }

        mod.attempts++;
        attemptsRef.current++;
        setTotalAttempts(attemptsRef.current);

        if (result.ok) {
          markConfirmed(mod, strat.name, result.vin);
        } else {
          mod.lastError = result.reason || '';
          mod.strategyIdx++;
          if (mod.strategyIdx >= STRATEGIES.length) {
            mod.state = 'exhausted';
            addLog('BRUTE', `✗ ${mod.name}(${hx3(mod.tx)}) exhausted all strategies`, AGENT_COLORS.BRUTE);
          } else {
            mod.state = 'retrying';
          }
          updateMod(mod);
        }

        await new Promise(r => setTimeout(r, 30));
      }
    }

    const confirmed = mods.filter(m => m.state === 'confirmed').length;
    const exhausted = mods.filter(m => m.state === 'exhausted').length;
    addLog('SYSTEM', `═══ SWARM COMPLETE: confirmed=${confirmed} exhausted=${exhausted} attempts=${attemptsRef.current} ═══`, AGENT_COLORS.FOUND);
    setRunning(false);
  }, [addLog]);

  const resetPP = useCallback(async () => {
    if (!eng.current) return;
    addLog('SYSTEM', 'Resetting PP to factory defaults...', AGENT_COLORS.SYSTEM);
    await eng.current.send('ATPP2COFF', 2000);
    await eng.current.send('ATPP2DOFF', 2000);
    await eng.current.send('ATPPSOFF', 2000);
    await eng.current.send('ATD', 2000);
    await eng.current.send('ATZ', 3000);
    await new Promise(r => setTimeout(r, 1000));
    setPpEnabled(false);
    addLog('SYSTEM', 'PP reset complete — adapter at factory defaults', AGENT_COLORS.FOUND);
  }, [addLog]);

  const confirmed = moduleStates.filter(m => m.state === 'confirmed').length;
  const retrying  = moduleStates.filter(m => m.state === 'retrying' || m.state === 'probing').length;
  const exhausted = moduleStates.filter(m => m.state === 'exhausted').length;
  const pending   = moduleStates.filter(m => m.state === 'pending').length;
  const total     = moduleStates.length;

  const S = {
    bg:     '#0A0A0F',
    card:   '#12121A',
    border: '#1E1E2E',
    text:   '#E0E0E0',
    dim:    '#666',
    red:    '#D32F2F',
    font:   "'JetBrains Mono','Fira Code',monospace",
  };

  return (
    <div style={{background:S.bg,minHeight:'100%',padding:16,fontFamily:S.font,color:S.text}}>
      <div style={{maxWidth:1100,margin:'0 auto'}}>

        {/* Header */}
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14,flexWrap:'wrap'}}>
          <span style={{fontSize:26,fontWeight:900,color:S.red}}>⚡ SWARM</span>
          <span style={{fontSize:12,color:S.dim}}>AGENTIC CAN NEGOTIATOR v2.0</span>
          <div style={{marginLeft:'auto',display:'flex',gap:8,flexWrap:'wrap'}}>
            {status==='disconnected' && (
              <button onClick={connect} style={{padding:'8px 16px',background:S.red,color:'#fff',border:'none',borderRadius:6,cursor:'pointer',fontFamily:S.font,fontWeight:700}}>
                🔌 CONNECT
              </button>
            )}
            {status==='connected' && !running && (
              <button onClick={launchSwarm} style={{padding:'8px 16px',background:'#00E5FF',color:'#000',border:'none',borderRadius:6,cursor:'pointer',fontFamily:S.font,fontWeight:700}}>
                🚀 LAUNCH SWARM
              </button>
            )}
            {running && (
              <div style={{padding:'8px 14px',background:'#1A2E1A',border:'1px solid #2E7D32',borderRadius:6,fontSize:11,color:'#66BB6A',fontWeight:700}}>
                ⚡ RUNNING…
              </div>
            )}
            {status==='connected' && (
              <button onClick={resetPP} style={{padding:'8px 16px',background:'#333',color:'#fff',border:'1px solid #555',borderRadius:6,cursor:'pointer',fontFamily:S.font,fontSize:11}}>
                🔄 Reset PP
              </button>
            )}
            <div style={{padding:'8px 12px',background:status==='connected'?'#1B5E20':'#333',borderRadius:6,fontSize:11}}>
              {status==='connected'?'● CONNECTED':'○ DISCONNECTED'}
              {ppEnabled&&<span style={{color:AGENT_COLORS.FOUND,marginLeft:8}}>PP:ON</span>}
            </div>
            <button onClick={onPdf} disabled={pdfBusy} style={{padding:'8px 14px',background:pdfBusy?'#333':'#fff',color:pdfBusy?'#666':S.red,border:'2px solid '+S.red,borderRadius:6,cursor:pdfBusy?'wait':'pointer',fontFamily:S.font,fontWeight:700,fontSize:11,letterSpacing:.5}}>
              {pdfBusy?'⏳ Building...':'🖨 Print Reference'}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {(running || confirmed > 0) && (
          <div style={{marginBottom:10}}>
            <div style={{height:6,background:'#1E1E2E',borderRadius:3,overflow:'hidden'}}>
              <div style={{
                height:'100%',
                width:`${(confirmed/total)*100}%`,
                background:'linear-gradient(90deg,#66BB6A,#00E5FF)',
                borderRadius:3,
                transition:'width 0.3s',
              }}/>
            </div>
          </div>
        )}

        {/* Stats bar */}
        <div style={{display:'flex',gap:16,marginBottom:12,fontSize:11,flexWrap:'wrap'}}>
          <span style={{color:STATE_COLORS.confirmed}}>✓ Confirmed: <strong>{confirmed}</strong></span>
          <span style={{color:STATE_COLORS.retrying}}>↻ Retrying: <strong>{retrying}</strong></span>
          <span style={{color:STATE_COLORS.exhausted}}>✗ Exhausted: <strong>{exhausted}</strong></span>
          <span style={{color:STATE_COLORS.pending}}>◌ Pending: <strong>{pending}</strong></span>
          <span style={{color:'#aaa',marginLeft:'auto'}}>Attempts: <strong>{totalAttempts}</strong></span>
        </div>

        {/* Module status board */}
        <div style={{background:S.card,border:`1px solid ${S.border}`,borderRadius:8,padding:10,marginBottom:12}}>
          <div style={{fontSize:10,color:S.dim,marginBottom:8,fontWeight:700,letterSpacing:1}}>MODULE STATUS BOARD</div>
          <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
            {moduleStates.map((m, i) => {
              const col = STATE_COLORS[m.state] || '#555';
              const isPulsing = m.state === 'probing';
              return (
                <div key={i} title={`${m.name} TX:${hx3(m.tx)} RX:${hx3(m.rx)}\nState:${m.state}\nStrategy:${m.strategyIdx < STRATEGIES.length ? STRATEGIES[m.strategyIdx].label : 'done'}\nAttempts:${m.attempts}\n${m.lastError ? 'Last err:'+m.lastError : ''}${m.vin ? '\nVIN:'+m.vin : ''}`}
                  style={{
                    border:`2px solid ${col}`,
                    borderRadius:5,
                    padding:'4px 7px',
                    fontSize:10,
                    minWidth:80,
                    position:'relative',
                    background: m.state==='confirmed' ? col+'18' : m.state==='exhausted' ? col+'15' : '#0D0D15',
                    animation: isPulsing ? 'swarm-pulse 0.8s ease-in-out infinite alternate' : 'none',
                    transition:'border-color 0.3s,background 0.3s',
                  }}>
                  <div style={{color:col,fontWeight:700,fontSize:9}}>{m.name}</div>
                  <div style={{color:'#444',fontSize:8}}>{hx3(m.tx)}</div>
                  {m.state==='confirmed' && (
                    <div style={{fontSize:8,color:STATE_COLORS.confirmed}}>via {m.confirmedBy}</div>
                  )}
                  {(m.state==='retrying'||m.state==='probing') && m.strategyIdx<STRATEGIES.length && (
                    <div style={{fontSize:8,color:col}}>{STRATEGIES[m.strategyIdx].label}</div>
                  )}
                  {m.state==='exhausted' && (
                    <div style={{fontSize:8,color:STATE_COLORS.exhausted}}>dead</div>
                  )}
                  {m.vin && (
                    <div style={{fontSize:7,color:'#fff',marginTop:1,overflow:'hidden',maxWidth:78}}>{m.vin}</div>
                  )}
                </div>
              );
            })}
          </div>
          {/* Legend */}
          <div style={{display:'flex',gap:12,marginTop:8,flexWrap:'wrap'}}>
            {Object.entries(STATE_COLORS).map(([s,c])=>(
              <span key={s} style={{fontSize:9,color:c}}>● {s.toUpperCase()}</span>
            ))}
          </div>
        </div>

        {/* Log panel */}
        <div ref={logRef} style={{background:S.card,border:`1px solid ${S.border}`,borderRadius:8,padding:8,height:360,overflowY:'auto',fontSize:11,lineHeight:1.6}}>
          {logs.length===0 && (
            <div style={{color:S.dim,textAlign:'center',marginTop:40}}>
              Connect adapter and launch SWARM to begin agentic scan
            </div>
          )}
          {logs.map((l,i)=>(
            <div key={i} style={{display:'flex',gap:8,borderBottom:'1px solid #111'}}>
              <span style={{color:S.dim,minWidth:60,flexShrink:0}}>{l.ts}</span>
              <span style={{color:l.color,minWidth:70,flexShrink:0,fontWeight:700}}>{l.agent}</span>
              <span style={{color:S.text,wordBreak:'break-all'}}>{l.msg}</span>
            </div>
          ))}
        </div>

        {/* Agent legend */}
        <div style={{display:'flex',gap:12,marginTop:8,flexWrap:'wrap'}}>
          {Object.entries(AGENT_COLORS).filter(([k])=>k!=='SYSTEM'&&k!=='FOUND').map(([name,color])=>(
            <span key={name} style={{fontSize:10,color}}>● {name}</span>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes swarm-pulse {
          from { box-shadow: 0 0 4px #00E5FF44; }
          to   { box-shadow: 0 0 12px #00E5FFBB, 0 0 20px #00E5FF44; }
        }
      `}</style>
    </div>
  );
}
