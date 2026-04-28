import React, {useState, useMemo, useCallback, useRef, useEffect} from "react";
import {Card, Btn, Tag, SLine} from '../lib/ui.jsx';
import {C, TC} from '../lib/constants.js';
import {analyzeCflash, runDiffInWorker} from '../lib/cflashAnalyzer.js';

// ECM C-Flash analyzer tab (Task #488).
//
// Lists every loaded C-Flash / firmware-class capture, reanalyzes each
// one through `analyzeCflash` for the headline badges (PowerPC reset,
// AES S-box, GPEC unlock byte, Cal ID, build date, tuner sigs), and
// offers an A/B byte-level diff that runs on a Web Worker so a 4 MB ×
// 4 MB compare doesn't freeze the UI. A "FLASH THIS" button hands the
// selected file to the ECM Flasher tab via the shared `onFlash` prop.

function Section({title, count, color, children}){
  const c = color || C.sr;
  return (
    <div style={{marginBottom: 22}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10}}>
        <span style={{fontFamily: 'JetBrains Mono', fontSize: 11, letterSpacing: 3, color: c, fontWeight: 800}}>{title}</span>
        {typeof count === 'number' && <Tag color={c}>{count}</Tag>}
        <span style={{flex: 1, height: 1, background: `linear-gradient(to right, ${c}55, transparent)`}}/>
      </div>
      {children}
    </div>
  );
}

function Stat({label, value, color}){
  return (
    <div style={{padding: '8px 10px', borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}`}}>
      <div style={{fontSize: 8, fontWeight: 800, color: C.ts, letterSpacing: 1.4}}>{label}</div>
      <div style={{fontSize: 14, fontWeight: 800, color: color || C.tx, marginTop: 4, fontFamily: 'JetBrains Mono'}}>{value}</div>
    </div>
  );
}

// Defensive: ensure each file has a freshly computed analysis. Files
// loaded by the workspace `loadF` already carry `security`, but a file
// that arrived through a path predating Task #488 will not.
function ensureAnalysis(f){
  if (f && f.security) return f.security;
  if (f && f.data) return analyzeCflash(f.data);
  return null;
}

export default function CFlashTab({files = [], onFlash, onLoad}){
  const [aIdx, setAIdx] = useState(null);
  const [bIdx, setBIdx] = useState(null);
  const [diff, setDiff] = useState(null);
  const [running, setRunning] = useState(false);
  const fileInput = useRef(null);

  useEffect(() => {
    if (aIdx !== null && aIdx >= files.length) setAIdx(null);
    if (bIdx !== null && bIdx >= files.length) setBIdx(null);
  }, [files.length, aIdx, bIdx]);

  const enriched = useMemo(() => files.map(f => ({...f, security: ensureAnalysis(f)})), [files]);

  const compare = useCallback(async () => {
    if (aIdx === null || bIdx === null) return;
    setRunning(true);
    setDiff(null);
    try {
      const a = enriched[aIdx];
      const b = enriched[bIdx];
      if (!a || !b || !a.data || !b.data) {
        setDiff({error: 'Selected files have no byte data'});
        return;
      }
      const r = await runDiffInWorker(a.data, b.data);
      setDiff(r);
    } finally {
      setRunning(false);
    }
  }, [aIdx, bIdx, enriched]);

  const onPick = (e) => {
    const list = e.target.files;
    if (list && list.length && onLoad) onLoad(list);
    if (e.target) e.target.value = '';
  };

  if (!files.length) {
    return (
      <Card>
        <div style={{textAlign: 'center', padding: 28}}>
          <div style={{fontFamily: "'Righteous'", fontSize: 22, color: C.tx, letterSpacing: 2}}>C-FLASH ANALYZER</div>
          <div style={{fontSize: 12, color: C.ts, marginTop: 8}}>
            Drop ECM C-flash bin files (1 / 2 / 4 MB) to inspect or compare. Files are routed automatically by size.
          </div>
          <input ref={fileInput} type="file" multiple accept=".bin,.BIN,.hex,.HEX" style={{display: 'none'}} onChange={onPick}/>
          <div style={{marginTop: 16}}>
            <Btn onClick={() => fileInput.current && fileInput.current.click()}>+ LOAD C-FLASH FILES</Btn>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div>
      <Section title="C-FLASH FILES" count={files.length} color={TC.CFLASH}>
        <input ref={fileInput} type="file" multiple accept=".bin,.BIN,.hex,.HEX" style={{display: 'none'}} onChange={onPick}/>
        <div style={{display: 'flex', justifyContent: 'flex-end', marginBottom: 8}}>
          <Btn outline onClick={() => fileInput.current && fileInput.current.click()}>+ ADD C-FLASH</Btn>
        </div>
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10}}>
          {enriched.map((f, i) => {
            const sec = f.security || {};
            return (
              <div key={i} data-testid={`cflash-card-${i}`} style={{padding: 14, borderRadius: 12, background: C.cd, border: `1.5px solid ${TC[f.type] || C.bd}33`}}>
                <div style={{fontSize: 12, fontWeight: 800, color: TC[f.type] || C.tx, marginBottom: 6, wordBreak: 'break-all'}}>{f.filename || f.name}</div>
                <div style={{display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8}}>
                  <Tag color={TC[f.type] || C.tx}>{((f.size || (f.data && f.data.length) || 0) / 1024 / 1024).toFixed(2)} MB</Tag>
                  {sec.isPPC && <Tag color={C.a4}>PPC</Tag>}
                  {sec.aesSbox != null && <Tag color={C.a1}>AES</Tag>}
                  {sec.unlocked === true && <Tag color={C.gn}>UNLOCKED</Tag>}
                  {sec.unlocked === false && <Tag color={C.wn}>LOCKED</Tag>}
                  {sec.tunerSigs && sec.tunerSigs.length > 0 && <Tag color={C.er}>TUNED</Tag>}
                </div>
                {sec.calId && <div style={{fontSize: 10, color: C.a1, fontWeight: 800, fontFamily: 'JetBrains Mono'}}>Cal ID: {sec.calId}</div>}
                {sec.buildDate && <div style={{fontSize: 10, color: C.a3, fontFamily: 'JetBrains Mono'}}>Built: {sec.buildDate.date}</div>}
                {sec.tunerSigs && sec.tunerSigs.length > 0 && (
                  <div style={{marginTop: 6, padding: '6px 8px', borderRadius: 6, background: '#FF174410', border: `1px solid ${C.er}33`}}>
                    {sec.tunerSigs.map((t, k) => (
                      <SLine key={k} type="warn" msg={`${t.label} sig @0x${t.offset.toString(16).toUpperCase()}`}/>
                    ))}
                  </div>
                )}
                <div style={{marginTop: 10, display: 'flex', gap: 6}}>
                  <button data-testid={`cflash-set-a-${i}`} onClick={() => setAIdx(i)} style={{flex: 1, padding: '6px 8px', borderRadius: 6, border: `1.5px solid ${aIdx === i ? C.gn : C.bd}`, background: aIdx === i ? '#00C85318' : C.cd, color: aIdx === i ? C.gn : C.ts, fontSize: 10, fontWeight: 800, cursor: 'pointer', fontFamily: "'Nunito'"}}>SET A</button>
                  <button data-testid={`cflash-set-b-${i}`} onClick={() => setBIdx(i)} style={{flex: 1, padding: '6px 8px', borderRadius: 6, border: `1.5px solid ${bIdx === i ? C.a1 : C.bd}`, background: bIdx === i ? '#FF6D0018' : C.cd, color: bIdx === i ? C.a1 : C.ts, fontSize: 10, fontWeight: 800, cursor: 'pointer', fontFamily: "'Nunito'"}}>SET B</button>
                </div>
                {onFlash && (
                  <div style={{marginTop: 6}}>
                    <Btn full color={C.sr} onClick={() => onFlash(f)}>⚡ FLASH THIS TO ECM</Btn>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {aIdx !== null && bIdx !== null && (
        <Section title="COMPARE A vs B" color={C.wn}>
          <Card>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12}}>
              <div>
                <Tag color={C.gn}>A</Tag>
                <div style={{fontSize: 11, fontWeight: 700, marginTop: 6}}>{enriched[aIdx]?.filename || enriched[aIdx]?.name}</div>
                <div style={{fontSize: 9, color: C.ts}}>Cal ID: {enriched[aIdx]?.security?.calId || '—'}</div>
              </div>
              <div>
                <Tag color={C.a1}>B</Tag>
                <div style={{fontSize: 11, fontWeight: 700, marginTop: 6}}>{enriched[bIdx]?.filename || enriched[bIdx]?.name}</div>
                <div style={{fontSize: 9, color: C.ts}}>Cal ID: {enriched[bIdx]?.security?.calId || '—'}</div>
              </div>
            </div>
            <Btn onClick={compare} disabled={running} data-testid="cflash-run-diff">
              {running ? 'DIFFING...' : 'RUN BYTE-LEVEL DIFF'}
            </Btn>
            {diff && diff.error && <SLine type="error" msg={diff.error}/>}
            {diff && !diff.error && (
              <div style={{marginTop: 14}} data-testid="cflash-diff-result">
                <div style={{display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8}}>
                  <Stat label="TOTAL DIFFS" value={diff.totalDiffs.toLocaleString()} color={diff.totalDiffs === 0 ? C.gn : C.er}/>
                  <Stat label="DIFF BLOCKS" value={diff.blocks.length} color={C.a1}/>
                  <Stat label="FIRST DIFF" value={diff.firstDiff >= 0 ? `0x${diff.firstDiff.toString(16).toUpperCase()}` : '—'} color={C.a3}/>
                  <Stat label="LAST DIFF" value={diff.lastDiff >= 0 ? `0x${diff.lastDiff.toString(16).toUpperCase()}` : '—'} color={C.a3}/>
                </div>
                {diff.totalDiffs === 0 && (
                  <div style={{marginTop: 10}}>
                    <SLine type="pass" msg="Files are byte-identical (perfect copy)"/>
                  </div>
                )}
                {diff.blocks.length > 0 && diff.blocks.length <= 30 && (
                  <div style={{marginTop: 10}}>
                    <div style={{fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1.4, marginBottom: 4}}>DIFFERING REGIONS</div>
                    <div style={{background: C.c2, borderRadius: 8, padding: 10, fontFamily: 'JetBrains Mono', fontSize: 10, color: C.tx}}>
                      {diff.blocks.slice(0, 30).map((b, i) => (
                        <div key={i}>
                          0x{b.start.toString(16).toUpperCase().padStart(6, '0')} - 0x{b.end.toString(16).toUpperCase().padStart(6, '0')}
                          {' '}<span style={{color: C.ts}}>({b.end - b.start} bytes)</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {diff.blocks.length > 30 && (
                  <div style={{marginTop: 8}}>
                    <SLine type="warn" msg={`${diff.blocks.length} differing blocks — showing only the first 30`}/>
                  </div>
                )}
              </div>
            )}
          </Card>
        </Section>
      )}
    </div>
  );
}
