import React, {useCallback, useRef, useState, useMemo} from "react";
import {Card, Btn, Tag, SLine} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {parseEfdZipPackage, diffEfdBlocks, parseEfdFilename} from '../lib/efdParser.js';

// EFD Block Diff
// Load two PowerCal zip packages (A = stock/before, B = tune/after).
// Diffs each matching LB block byte-by-byte and shows:
//   - Changed byte count and % per block
//   - Hex diff viewer with before/after columns for each hunk

function fmtSize(n){
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtHex(n){ return '0x' + n.toString(16).toUpperCase().padStart(6, '0'); }

function toHexRow(bytes, offset, len = 16){
  const row = [];
  for (let i = 0; i < len; i++){
    const idx = offset + i;
    row.push(idx < bytes.length ? bytes[idx].toString(16).padStart(2, '0').toUpperCase() : '  ');
  }
  return row;
}

// Hex diff viewer for a single hunk
function HunkViewer({hunk, blockStartAddr}){
  const ROW = 16;
  const len = Math.max(hunk.a.length, hunk.b.length);
  const rows = Math.ceil(len / ROW);

  return (
    <div style={{
      fontFamily:'JetBrains Mono', fontSize:10,
      background:C.c2, border:`1px solid ${C.bd}`,
      borderRadius:8, padding:'10px 12px',
      overflowX:'auto', marginBottom:8,
    }}>
      <div style={{display:'grid', gridTemplateColumns:'90px 1fr 1fr', gap:8, marginBottom:6}}>
        <div style={{fontSize:9, fontWeight:800, color:C.ts, letterSpacing:1}}>OFFSET</div>
        <div style={{fontSize:9, fontWeight:800, color:C.a2, letterSpacing:1}}>A (BEFORE)</div>
        <div style={{fontSize:9, fontWeight:800, color:C.gn, letterSpacing:1}}>B (AFTER)</div>
      </div>
      {Array.from({length: rows}, (_, ri) => {
        const rowOff = ri * ROW;
        const absOff = hunk.offset + rowOff;
        const aRow = toHexRow(hunk.a, rowOff);
        const bRow = toHexRow(hunk.b, rowOff);
        const hasDiff = aRow.some((v, i) => v !== bRow[i] && v !== '  ' && bRow[i] !== '  ');
        return (
          <div key={ri} style={{
            display:'grid', gridTemplateColumns:'90px 1fr 1fr', gap:8,
            padding:'1px 0',
            background: hasDiff ? `${C.wn}10` : 'transparent',
          }}>
            <div style={{color:C.a3, whiteSpace:'nowrap'}}>
              {fmtHex(blockStartAddr + absOff)}
            </div>
            <div style={{display:'flex', gap:4, flexWrap:'wrap'}}>
              {aRow.map((b, i) => {
                const changed = b !== bRow[i] && b !== '  ' && bRow[i] !== '  ';
                return (
                  <span key={i} style={{
                    color: changed ? C.er : C.tx,
                    fontWeight: changed ? 800 : 400,
                    background: changed ? `${C.er}22` : 'transparent',
                    borderRadius:2, padding:'0 1px',
                    minWidth:18, textAlign:'center',
                  }}>{b}</span>
                );
              })}
            </div>
            <div style={{display:'flex', gap:4, flexWrap:'wrap'}}>
              {bRow.map((b, i) => {
                const changed = b !== aRow[i] && b !== '  ' && aRow[i] !== '  ';
                return (
                  <span key={i} style={{
                    color: changed ? C.gn : C.tx,
                    fontWeight: changed ? 800 : 400,
                    background: changed ? `${C.gn}22` : 'transparent',
                    borderRadius:2, padding:'0 1px',
                    minWidth:18, textAlign:'center',
                  }}>{b}</span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BlockDiffRow({diff, blockA}){
  const [open, setOpen] = useState(false);
  const [showHunks, setShowHunks] = useState(false);
  const startAddr = blockA ? blockA.startAddress : 0;

  const pct = diff.pctChanged;
  const barColor = diff.identical ? C.gn : pct < 1 ? C.a2 : pct < 10 ? C.wn : C.er;

  return (
    <Card style={{marginBottom:10}}>
      <div
        style={{display:'flex', alignItems:'center', gap:10, cursor:'pointer', userSelect:'none', flexWrap:'wrap'}}
        onClick={() => setOpen(o => !o)}
      >
        <Tag color={diff.identical ? C.gn : diff.onlyInA ? C.wn : diff.onlyInB ? C.a2 : C.er}>
          LB{diff.index}
        </Tag>
        {diff.identical && <Tag color={C.gn}>IDENTICAL</Tag>}
        {diff.onlyInA  && <Tag color={C.wn}>ONLY IN A</Tag>}
        {diff.onlyInB  && <Tag color={C.a2}>ONLY IN B</Tag>}
        {!diff.identical && !diff.onlyInA && !diff.onlyInB && (
          <Tag color={barColor}>{diff.changedBytes.toLocaleString()} BYTES CHANGED</Tag>
        )}
        <span style={{fontSize:12, fontWeight:700, color:C.tx, flex:1}}>{diff.label}</span>
        {!diff.identical && !diff.onlyInA && !diff.onlyInB && (
          <span style={{fontSize:11, fontFamily:'JetBrains Mono', color:barColor, fontWeight:800}}>
            {pct < 0.01 ? '<0.01' : pct.toFixed(2)}%
          </span>
        )}
        <span style={{fontSize:14, color:C.ts, fontWeight:700}}>{open ? '▲' : '▼'}</span>
      </div>

      {open && !diff.identical && !diff.onlyInA && !diff.onlyInB && (
        <div style={{marginTop:12}}>
          {/* Change bar */}
          <div style={{marginBottom:10}}>
            <div style={{height:6, borderRadius:3, background:C.c2, overflow:'hidden'}}>
              <div style={{
                height:'100%', borderRadius:3,
                width:`${Math.min(100, pct)}%`,
                background: barColor,
                transition:'width 0.3s',
              }}/>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', marginTop:4, fontSize:10, color:C.ts}}>
              <span>{diff.changedBytes.toLocaleString()} bytes changed</span>
              <span>{(diff.totalBytes - diff.changedBytes).toLocaleString()} bytes unchanged</span>
              <span>{fmtSize(diff.totalBytes)} total</span>
            </div>
          </div>

          {diff.hunks.length > 0 && (
            <>
              <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:8}}>
                <span style={{fontSize:11, color:C.ts}}>{diff.hunks.length} changed region{diff.hunks.length !== 1 ? 's' : ''}</span>
                <Btn color={C.a2} onClick={e => { e.stopPropagation(); setShowHunks(h => !h); }}>
                  {showHunks ? 'HIDE HEX DIFF' : 'SHOW HEX DIFF'}
                </Btn>
              </div>
              {showHunks && diff.hunks.map((hunk, i) => (
                <div key={i}>
                  <div style={{fontSize:10, fontWeight:800, color:C.ts, letterSpacing:1, marginBottom:4}}>
                    REGION {i + 1} · {fmtHex(startAddr + hunk.offset)}
                  </div>
                  <HunkViewer hunk={hunk} blockStartAddr={startAddr}/>
                </div>
              ))}
              {diff.hunks.length === 500 && (
                <SLine type="warn" msg="Diff truncated at 500 regions — too many changes to display all hunks."/>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function ZipDropZone({label, color, loaded, onLoad, busy}){
  const fileInput = useRef(null);
  const [dragging, setDragging] = useState(false);

  const processFile = useCallback(f => {
    if (!f) return;
    const rd = new FileReader();
    rd.onload = e => onLoad(new Uint8Array(e.target.result), f.name);
    rd.readAsArrayBuffer(f);
  }, [onLoad]);

  const onPick = useCallback(e => {
    processFile(e.target.files && e.target.files[0]);
    if (e.target) e.target.value = '';
  }, [processFile]);

  const onDrop = useCallback(e => {
    e.preventDefault();
    setDragging(false);
    processFile(e.dataTransfer.files && e.dataTransfer.files[0]);
  }, [processFile]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => !loaded && fileInput.current && fileInput.current.click()}
      style={{
        flex:1, padding:16, borderRadius:10,
        border: `2px dashed ${dragging ? color : loaded ? color + '88' : C.bd}`,
        background: dragging ? `${color}10` : loaded ? `${color}08` : C.c1,
        cursor: loaded ? 'default' : 'pointer',
        transition:'all 0.15s',
        minWidth:200,
      }}
    >
      <input ref={fileInput} type="file" accept=".zip,.ZIP" style={{display:'none'}} onChange={onPick}/>
      <div style={{fontSize:9, fontWeight:800, color, letterSpacing:1.4, marginBottom:6}}>{label}</div>
      {busy && <div style={{fontSize:12, color:C.ts}}>Parsing…</div>}
      {!busy && !loaded && (
        <div style={{fontSize:12, color:C.ts}}>Drop PowerCal <strong style={{color:C.tx}}>.zip</strong> here</div>
      )}
      {!busy && loaded && (
        <>
          <div style={{fontSize:12, fontWeight:700, color:C.tx, wordBreak:'break-all'}}>{loaded.name}</div>
          <div style={{fontSize:10, color:C.ts, marginTop:4}}>{loaded.blocks.length} blocks · {fmtSize(loaded.totalSize)}</div>
          <div style={{marginTop:8}}>
            <Btn color={C.ts} onClick={e => { e.stopPropagation(); fileInput.current && fileInput.current.click(); }}>
              CHANGE FILE
            </Btn>
          </div>
        </>
      )}
    </div>
  );
}

export default function EfdBlockDiffTab(){
  const [zipA, setZipA] = useState(null);
  const [zipB, setZipB] = useState(null);
  const [busyA, setBusyA] = useState(false);
  const [busyB, setBusyB] = useState(false);
  const [errA, setErrA] = useState(null);
  const [errB, setErrB] = useState(null);

  const loadZip = useCallback(async (bytes, name, setZip, setBusy, setErr) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await parseEfdZipPackage(bytes, name);
      if (!r.ok) setErr(r.error || 'Failed to parse zip');
      else setZip(r);
    } catch(e){
      setErr('Parse error: ' + (e.message || e));
    } finally {
      setBusy(false);
    }
  }, []);

  const diffs = useMemo(() => {
    if (!zipA || !zipB) return null;
    return diffEfdBlocks(zipA.blocks, zipB.blocks);
  }, [zipA, zipB]);

  const fnA = zipA ? parseEfdFilename(zipA.name) : null;
  const fnB = zipB ? parseEfdFilename(zipB.name) : null;

  const totalChanged = diffs ? diffs.reduce((s, d) => s + d.changedBytes, 0) : 0;
  const blocksChanged = diffs ? diffs.filter(d => !d.identical).length : 0;
  const blocksIdentical = diffs ? diffs.filter(d => d.identical).length : 0;

  // Build a map of blockA by index for address lookup in hex viewer
  const blockAByIdx = useMemo(() => {
    if (!zipA) return {};
    const m = {};
    for (const b of zipA.blocks) m[b.index] = b;
    return m;
  }, [zipA]);

  return (
    <div>
      <Card>
        <div style={{fontFamily:"'Righteous'", fontSize:18, color:C.tx, letterSpacing:2, marginBottom:8}}>EFD BLOCK DIFF</div>
        <div style={{fontSize:12, color:C.ts, marginBottom:16, lineHeight:1.7}}>
          Load two PowerCal <strong style={{color:C.tx}}>.zip</strong> packages to compare them block-by-block.
          Use <strong style={{color:C.a2}}>A</strong> for stock/original and <strong style={{color:C.gn}}>B</strong> for the tune/modified version.
        </div>

        <div style={{display:'flex', gap:12, flexWrap:'wrap'}}>
          <ZipDropZone
            label="A — STOCK / ORIGINAL"
            color={C.a2}
            loaded={zipA}
            onLoad={(bytes, name) => loadZip(bytes, name, setZipA, setBusyA, setErrA)}
            busy={busyA}
          />
          <ZipDropZone
            label="B — TUNE / MODIFIED"
            color={C.gn}
            loaded={zipB}
            onLoad={(bytes, name) => loadZip(bytes, name, setZipB, setBusyB, setErrB)}
            busy={busyB}
          />
        </div>

        {errA && <div style={{marginTop:10}}><SLine type="error" msg={`File A: ${errA}`}/></div>}
        {errB && <div style={{marginTop:10}}><SLine type="error" msg={`File B: ${errB}`}/></div>}
      </Card>

      {/* Summary */}
      {diffs && (
        <Card style={{marginTop:14}}>
          <div style={{fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:3, color:C.a2, fontWeight:800, marginBottom:12}}>
            DIFF SUMMARY
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, marginBottom:12}}>
            <div style={{padding:'8px 10px', borderRadius:8, background:C.c2, border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8, fontWeight:800, color:C.ts, letterSpacing:1.4}}>BLOCKS COMPARED</div>
              <div style={{fontSize:18, fontWeight:800, color:C.tx, marginTop:4}}>{diffs.length}</div>
            </div>
            <div style={{padding:'8px 10px', borderRadius:8, background:C.c2, border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8, fontWeight:800, color:C.ts, letterSpacing:1.4}}>BLOCKS CHANGED</div>
              <div style={{fontSize:18, fontWeight:800, color: blocksChanged > 0 ? C.er : C.gn, marginTop:4}}>{blocksChanged}</div>
            </div>
            <div style={{padding:'8px 10px', borderRadius:8, background:C.c2, border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8, fontWeight:800, color:C.ts, letterSpacing:1.4}}>BLOCKS IDENTICAL</div>
              <div style={{fontSize:18, fontWeight:800, color:C.gn, marginTop:4}}>{blocksIdentical}</div>
            </div>
            <div style={{padding:'8px 10px', borderRadius:8, background:C.c2, border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8, fontWeight:800, color:C.ts, letterSpacing:1.4}}>TOTAL BYTES CHANGED</div>
              <div style={{fontSize:14, fontWeight:800, color: totalChanged > 0 ? C.er : C.gn, marginTop:4, fontFamily:'JetBrains Mono'}}>
                {totalChanged.toLocaleString()}
              </div>
            </div>
          </div>

          {/* File labels */}
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
            <div style={{padding:'8px 10px', borderRadius:8, background:`${C.a2}10`, border:`1px solid ${C.a2}44`}}>
              <div style={{fontSize:8, fontWeight:800, color:C.a2, letterSpacing:1.4}}>A — STOCK / ORIGINAL</div>
              <div style={{fontSize:11, fontWeight:700, color:C.tx, marginTop:4, wordBreak:'break-all'}}>{zipA.name}</div>
              {fnA && <div style={{fontSize:10, color:C.ts, marginTop:2}}>{fnA.summary}</div>}
            </div>
            <div style={{padding:'8px 10px', borderRadius:8, background:`${C.gn}10`, border:`1px solid ${C.gn}44`}}>
              <div style={{fontSize:8, fontWeight:800, color:C.gn, letterSpacing:1.4}}>B — TUNE / MODIFIED</div>
              <div style={{fontSize:11, fontWeight:700, color:C.tx, marginTop:4, wordBreak:'break-all'}}>{zipB.name}</div>
              {fnB && <div style={{fontSize:10, color:C.ts, marginTop:2}}>{fnB.summary}</div>}
            </div>
          </div>
        </Card>
      )}

      {/* Per-block diffs */}
      {diffs && (
        <div style={{marginTop:14}}>
          <div style={{fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:3, color:C.a2, fontWeight:800, marginBottom:10}}>
            BLOCK-BY-BLOCK RESULTS
          </div>
          {diffs.map(d => (
            <BlockDiffRow key={d.index} diff={d} blockA={blockAByIdx[d.index]}/>
          ))}
        </div>
      )}
    </div>
  );
}
