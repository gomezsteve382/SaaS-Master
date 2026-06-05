import React, {useCallback, useRef, useState} from "react";
import {Card, Btn, Tag, SLine} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {benchWriteValidate, parseEfdFilename, BENCH_WRITE_REGIONS} from '../lib/efdParser.js';

// Bench Write Validator
// Drop any .bin file → instant size check against every known Multi-PROG flash
// region. Shows PASS (exact match) or FAIL with closest alternatives.

function fmtSize(n){
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(3)} MB (${n.toLocaleString()} bytes)`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB (${n.toLocaleString()} bytes)`;
  return `${n} bytes`;
}

function fmtSizeShort(n){
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtHex(n){ return '0x' + n.toString(16).toUpperCase().padStart(6, '0'); }

function MatchRow({r, highlight}){
  return (
    <tr style={{
      background: highlight ? '#1B5E2018' : 'transparent',
      borderBottom: `1px solid ${C.bd}33`,
    }}>
      <td style={{padding:'6px 10px', fontFamily:'JetBrains Mono', fontSize:11, color: highlight ? C.gn : C.a1, fontWeight: highlight ? 800 : 600}}>
        {r.ecu}
      </td>
      <td style={{padding:'6px 10px', fontSize:11, color: highlight ? C.gn : C.tx, fontWeight: highlight ? 700 : 400}}>
        {r.region}
        {highlight && <span style={{marginLeft:8, fontSize:9, color:C.gn, fontWeight:800, letterSpacing:1}}>← EXACT MATCH</span>}
      </td>
      <td style={{padding:'6px 10px', fontFamily:'JetBrains Mono', fontSize:11, color:C.a3, whiteSpace:'nowrap'}}>
        {fmtHex(r.startAddress)} – {fmtHex(r.endAddress)}
      </td>
      <td style={{padding:'6px 10px', fontFamily:'JetBrains Mono', fontSize:11, color: highlight ? C.gn : C.tx, whiteSpace:'nowrap'}}>
        {fmtSizeShort(r.size)}
      </td>
      <td style={{padding:'6px 10px', fontSize:10, color:C.ts}}>
        {r.programmer}
      </td>
      <td style={{padding:'6px 10px', fontSize:10, color:C.ts, maxWidth:220}}>
        {r.notes}
      </td>
    </tr>
  );
}

function CloseRow({r}){
  const over = r.delta > 0;
  return (
    <tr style={{borderBottom:`1px solid ${C.bd}33`}}>
      <td style={{padding:'6px 10px', fontFamily:'JetBrains Mono', fontSize:11, color:C.wn}}>{r.ecu}</td>
      <td style={{padding:'6px 10px', fontSize:11, color:C.tx}}>{r.region}</td>
      <td style={{padding:'6px 10px', fontFamily:'JetBrains Mono', fontSize:11, color:C.a3, whiteSpace:'nowrap'}}>
        {fmtHex(r.startAddress)} – {fmtHex(r.endAddress)}
      </td>
      <td style={{padding:'6px 10px', fontFamily:'JetBrains Mono', fontSize:11, color:C.wn, whiteSpace:'nowrap'}}>
        {fmtSizeShort(r.size)}
      </td>
      <td style={{padding:'6px 10px', fontSize:11, color: over ? C.er : C.a2, fontWeight:700, whiteSpace:'nowrap'}}>
        {over ? '+' : ''}{r.delta.toLocaleString()} bytes
      </td>
      <td style={{padding:'6px 10px', fontSize:10, color:C.ts}}>{r.programmer}</td>
    </tr>
  );
}

function ReferenceTable(){
  const [open, setOpen] = useState(false);
  return (
    <Card style={{marginTop:16}}>
      <div
        style={{display:'flex', alignItems:'center', gap:10, cursor:'pointer', userSelect:'none'}}
        onClick={() => setOpen(o => !o)}
      >
        <div style={{fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:3, color:C.a2, fontWeight:800, flex:1}}>
          MULTI-PROG REGION REFERENCE TABLE
        </div>
        <Tag color={C.a1}>{BENCH_WRITE_REGIONS.length} REGIONS</Tag>
        <span style={{fontSize:14, color:C.ts, fontWeight:700}}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{overflowX:'auto', marginTop:12}}>
          <table style={{width:'100%', borderCollapse:'collapse', fontSize:11}}>
            <thead>
              <tr style={{borderBottom:`2px solid ${C.bd}`}}>
                {['ECU / CHIP','REGION','ADDRESS RANGE','SIZE','PROGRAMMER','NOTES'].map(h => (
                  <th key={h} style={{padding:'4px 10px', textAlign:'left', fontSize:9, fontWeight:800, color:C.ts, letterSpacing:1.2, whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {BENCH_WRITE_REGIONS.map((r,i) => (
                <tr key={i} style={{borderBottom:`1px solid ${C.bd}22`}}>
                  <td style={{padding:'5px 10px', fontFamily:'JetBrains Mono', fontSize:10, color:C.a1}}>{r.ecu}</td>
                  <td style={{padding:'5px 10px', fontSize:10, color:C.tx}}>{r.region}</td>
                  <td style={{padding:'5px 10px', fontFamily:'JetBrains Mono', fontSize:10, color:C.a3, whiteSpace:'nowrap'}}>
                    {fmtHex(r.startAddress)} – {fmtHex(r.endAddress)}
                  </td>
                  <td style={{padding:'5px 10px', fontFamily:'JetBrains Mono', fontSize:10, color:C.tx, whiteSpace:'nowrap'}}>
                    {fmtSizeShort(r.size)}
                  </td>
                  <td style={{padding:'5px 10px', fontSize:10, color:C.ts}}>{r.programmer}</td>
                  <td style={{padding:'5px 10px', fontSize:10, color:C.ts}}>{r.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function BenchWriteValidatorTab(){
  const fileInput = useRef(null);
  const [files, setFiles] = useState([]);   // array of { name, size, result, fnInfo }
  const [dragging, setDragging] = useState(false);

  const processFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList);
    const readers = incoming.map(f => new Promise(resolve => {
      const rd = new FileReader();
      rd.onload = () => {
        const bytes = new Uint8Array(rd.result);
        const result = benchWriteValidate(bytes.length, f.name);
        const fnInfo = parseEfdFilename(f.name);
        resolve({ name: f.name, size: bytes.length, result, fnInfo });
      };
      rd.onerror = () => resolve({ name: f.name, size: 0, result: benchWriteValidate(0, f.name), fnInfo: parseEfdFilename(f.name) });
      rd.readAsArrayBuffer(f);
    }));
    Promise.all(readers).then(results => {
      setFiles(prev => {
        const names = new Set(prev.map(x => x.name));
        const fresh = results.filter(r => !names.has(r.name));
        return [...prev, ...fresh];
      });
    });
  }, []);

  const onPick = useCallback(e => {
    if (e.target.files) processFiles(e.target.files);
    if (e.target) e.target.value = '';
  }, [processFiles]);

  const onDrop = useCallback(e => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files) processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const removeFile = useCallback(name => {
    setFiles(prev => prev.filter(f => f.name !== name));
  }, []);

  const passCount = files.filter(f => f.result.pass).length;
  const failCount = files.filter(f => !f.result.pass).length;

  return (
    <div>
      <input ref={fileInput} type="file" accept=".bin,.BIN" multiple style={{display:'none'}} onChange={onPick}/>

      {/* Drop zone */}
      <Card
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${dragging ? C.gn : C.bd}`,
          background: dragging ? `${C.gn}08` : C.c1,
          transition: 'all 0.15s',
          textAlign: 'center',
          padding: 24,
          cursor: 'pointer',
        }}
        onClick={() => fileInput.current && fileInput.current.click()}
      >
        <div style={{fontFamily:"'Righteous'", fontSize:18, color:C.tx, letterSpacing:2}}>BENCH WRITE VALIDATOR</div>
        <div style={{fontSize:12, color:C.ts, marginTop:8, lineHeight:1.7}}>
          Drop one or more <strong style={{color:C.tx}}>.bin</strong> files here to check if they will pass Multi-PROG's size check.
          <br/>Bulk drop supported — all files validated instantly.
        </div>
        <div style={{marginTop:12}}>
          <Btn color={C.a1}>+ ADD .bin FILES</Btn>
        </div>
      </Card>

      {/* Summary bar */}
      {files.length > 0 && (
        <div style={{display:'flex', gap:10, alignItems:'center', margin:'14px 0 10px', flexWrap:'wrap'}}>
          <Tag color={C.a2}>{files.length} FILE{files.length !== 1 ? 'S' : ''}</Tag>
          {passCount > 0 && <Tag color={C.gn}>✓ {passCount} PASS</Tag>}
          {failCount > 0 && <Tag color={C.er}>✗ {failCount} FAIL</Tag>}
          <div style={{flex:1}}/>
          <Btn color={C.ts} onClick={() => setFiles([])}>CLEAR ALL</Btn>
        </div>
      )}

      {/* Per-file results */}
      {files.map(f => {
        const {result, fnInfo} = f;
        return (
          <Card key={f.name} style={{marginBottom:12}}>
            {/* Header */}
            <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:10, flexWrap:'wrap'}}>
              <Tag color={result.pass ? C.gn : C.er} style={{fontSize:13, padding:'3px 10px'}}>
                {result.pass ? '✓ PASS' : '✗ FAIL'}
              </Tag>
              {fnInfo.module  && <Tag color={C.a2}>{fnInfo.module}</Tag>}
              {fnInfo.program && <Tag color={C.a3}>{fnInfo.program}</Tag>}
              {fnInfo.year    && <Tag color={C.ts}>{fnInfo.year}</Tag>}
              <span style={{fontSize:12, fontWeight:700, color:C.tx, flex:1, wordBreak:'break-all'}}>{f.name}</span>
              <Btn color={C.ts} onClick={() => removeFile(f.name)}>✕</Btn>
            </div>

            {/* File info */}
            <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, marginBottom:10}}>
              <div style={{padding:'8px 10px', borderRadius:8, background:C.c2, border:`1px solid ${C.bd}`}}>
                <div style={{fontSize:8, fontWeight:800, color:C.ts, letterSpacing:1.4}}>FILE SIZE</div>
                <div style={{fontSize:13, fontWeight:800, color: result.pass ? C.gn : C.er, marginTop:4, fontFamily:'JetBrains Mono'}}>
                  {fmtSizeShort(f.size)}
                </div>
                <div style={{fontSize:9, color:C.ts, marginTop:2}}>{f.size.toLocaleString()} bytes</div>
              </div>
              <div style={{padding:'8px 10px', borderRadius:8, background:C.c2, border:`1px solid ${C.bd}`}}>
                <div style={{fontSize:8, fontWeight:800, color:C.ts, letterSpacing:1.4}}>VERDICT</div>
                <div style={{fontSize:13, fontWeight:800, color: result.pass ? C.gn : C.er, marginTop:4}}>
                  {result.pass
                    ? `${result.matches.length} REGION MATCH${result.matches.length !== 1 ? 'ES' : ''}`
                    : result.close.length > 0
                      ? `${result.close.length} CLOSE (±10%)`
                      : 'NO MATCH FOUND'
                  }
                </div>
              </div>
              <div style={{padding:'8px 10px', borderRadius:8, background:C.c2, border:`1px solid ${C.bd}`}}>
                <div style={{fontSize:8, fontWeight:800, color:C.ts, letterSpacing:1.4}}>CALIBRATION</div>
                <div style={{fontSize:11, fontWeight:700, color:C.tx, marginTop:4, lineHeight:1.4}}>
                  {fnInfo.summary}
                </div>
              </div>
            </div>

            {/* PASS: exact match table */}
            {result.pass && (
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%', borderCollapse:'collapse', fontSize:11}}>
                  <thead>
                    <tr style={{borderBottom:`2px solid ${C.bd}`}}>
                      {['ECU / CHIP','REGION','ADDRESS RANGE','SIZE','PROGRAMMER','NOTES'].map(h => (
                        <th key={h} style={{padding:'4px 10px', textAlign:'left', fontSize:9, fontWeight:800, color:C.ts, letterSpacing:1.2, whiteSpace:'nowrap'}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.matches.map((r,i) => <MatchRow key={i} r={r} highlight={true}/>)}
                  </tbody>
                </table>
              </div>
            )}

            {/* PASS: Multi-PROG write checklist */}
            {result.pass && (() => {
              // Build a checklist specific to the first matched region
              const m = result.matches[0];
              const isGpec2a = m.ecu.includes('GPEC2A') || m.ecu.includes('GPEC2B');
              const isGpec3  = m.ecu.includes('GPEC3');
              const isBcm    = m.ecu.includes('BCM') && !m.ecu.includes('EEPROM');
              const isTcm    = m.ecu.includes('TCM');
              const isRfhub  = m.ecu.includes('RFHUB') || m.ecu.includes('XC2268');
              const isBcmEep = m.ecu.includes('BCM EEPROM');

              let steps = [];
              if (isGpec2a) {
                steps = [
                  { icon: '🔌', text: 'Interface: DB44 (GPEC2A/GPEC2B bench connector)' },
                  { icon: '⚡', text: 'Power: DC_PWR 12 V / 0.5 A · HVIO 5 V · VCCIO 3.3 V' },
                  { icon: '🖥️', text: `ECU path: ECU → Dodge → Charger → FCA_CONTINENTAL_GPEC2A` },
                  { icon: '📂', text: `Region: ${m.region} (${fmtSizeShort(m.size)} — exact match ✓)` },
                  { icon: '📝', text: 'Action: Open file → select this .bin → Write → confirm size check passes' },
                  { icon: '✅', text: 'Verify: Read back after write and compare to confirm no CRC errors' },
                ];
              } else if (isGpec3) {
                steps = [
                  { icon: '🔌', text: 'Interface: GPEC3 bench adapter (SPC5777 — Hellcat/Demon/Redeye)' },
                  { icon: '⚡', text: 'Power: DC_PWR 12 V / 0.5 A · HVIO 5 V · VCCIO 3.3 V' },
                  { icon: '🖥️', text: 'ECU path: ECU → Dodge → Charger → FCA_CONTINENTAL_GPEC3' },
                  { icon: '📂', text: `Region: ${m.region} (${fmtSizeShort(m.size)} — exact match ✓)` },
                  { icon: '📝', text: 'Action: Open file → select this .bin → Write' },
                  { icon: '✅', text: 'Verify: Read back and compare' },
                ];
              } else if (isBcm) {
                steps = [
                  { icon: '🔌', text: 'Interface: MPC5606B BCM bench adapter' },
                  { icon: '⚡', text: 'Power: DC_PWR 12 V / 0.5 A' },
                  { icon: '🖥️', text: 'ECU path: ECU → Dodge → Charger → BCM (MPC5606B)' },
                  { icon: '📂', text: `Region: ${m.region} (${fmtSizeShort(m.size)} — exact match ✓)` },
                  { icon: '📝', text: 'Action: Open file → select this .bin → Write' },
                  { icon: '✅', text: 'Verify: Read back and compare' },
                ];
              } else if (isTcm) {
                steps = [
                  { icon: '🔌', text: 'Interface: MPC5607B TCM bench adapter (ZF 8HP)' },
                  { icon: '⚡', text: 'Power: DC_PWR 12 V / 0.5 A' },
                  { icon: '🖥️', text: 'ECU path: ECU → ZF → 8HP → MPC5607B' },
                  { icon: '📂', text: `Region: ${m.region} (${fmtSizeShort(m.size)} — exact match ✓)` },
                  { icon: '📝', text: 'Action: Open file → select this .bin → Write' },
                  { icon: '✅', text: 'Verify: Read back and compare' },
                ];
              } else if (isRfhub) {
                steps = [
                  { icon: '🔌', text: 'Interface: SOIC8 clip or SOIC8 adapter on programmer' },
                  { icon: '⚡', text: 'Power: VCC 3.3 V (24C32) or 5 V (XC2268) — check chip datasheet' },
                  { icon: '🖥️', text: 'Chip: ' + m.ecu + ' — select matching chip in programmer software' },
                  { icon: '📂', text: `Region: ${m.region} (${fmtSizeShort(m.size)} — exact match ✓)` },
                  { icon: '📝', text: 'Action: Open file → select this .bin → Write' },
                  { icon: '✅', text: 'Verify: Read back and compare — check SEC16 slots after write' },
                ];
              } else if (isBcmEep) {
                steps = [
                  { icon: '🔌', text: 'Interface: SOIC8 clip on BCM EEPROM chip' },
                  { icon: '⚡', text: 'Power: VCC 3.3 V or 5 V — check chip label' },
                  { icon: '📂', text: `Region: ${m.region} (${fmtSizeShort(m.size)} — exact match ✓)` },
                  { icon: '📝', text: 'Action: Open file → select this .bin → Write' },
                  { icon: '✅', text: 'Verify: Read back and compare' },
                ];
              } else {
                steps = [
                  { icon: '📂', text: `Region: ${m.region} — ${m.ecu} (${fmtSizeShort(m.size)} — exact match ✓)` },
                  { icon: '📝', text: 'Action: Open file in ' + m.programmer + ' → select this .bin → Write' },
                  { icon: '✅', text: 'Verify: Read back and compare' },
                ];
              }

              return (
                <div data-testid="bench-write-checklist" style={{marginTop:12, padding:'12px 14px', borderRadius:8, background:'#0D2B1A', border:`1px solid ${C.gn}44`}}>
                  <div style={{fontSize:9, fontWeight:800, color:C.gn, letterSpacing:1.4, marginBottom:10}}>📋 MULTI-PROG WRITE CHECKLIST · {m.ecu} {m.region}</div>
                  {steps.map((s, i) => (
                    <div key={i} style={{display:'flex', alignItems:'flex-start', gap:8, marginBottom:6}}>
                      <span style={{fontSize:14, lineHeight:'18px', flexShrink:0}}>{s.icon}</span>
                      <span style={{fontSize:11, color:C.tx, lineHeight:1.5}}>{s.text}</span>
                    </div>
                  ))}
                  <div style={{marginTop:8, fontSize:10, color:C.tm, fontStyle:'italic'}}>
                    Tip: Multi-PROG performs an exact byte-count check before writing — this file passed. If the programmer still rejects it, verify the DB44 interface is seated and the ECU is powered.
                  </div>
                </div>
              );
            })()}

            {/* FAIL: close matches */}
            {!result.pass && result.close.length > 0 && (
              <>
                <SLine type="warn" msg={`No exact region match. Closest regions within ±10% of ${fmtSizeShort(f.size)}:`}/>
                <div style={{overflowX:'auto', marginTop:8}}>
                  <table style={{width:'100%', borderCollapse:'collapse', fontSize:11}}>
                    <thead>
                      <tr style={{borderBottom:`2px solid ${C.bd}`}}>
                        {['ECU / CHIP','REGION','ADDRESS RANGE','EXPECTED SIZE','DELTA','PROGRAMMER'].map(h => (
                          <th key={h} style={{padding:'4px 10px', textAlign:'left', fontSize:9, fontWeight:800, color:C.ts, letterSpacing:1.2, whiteSpace:'nowrap'}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.close.map((r,i) => <CloseRow key={i} r={r}/>)}
                    </tbody>
                  </table>
                </div>
                <div style={{marginTop:10, padding:'10px 12px', borderRadius:8, background:'#FF174410', border:`1px solid ${C.er}33`, fontSize:11, color:C.tx, lineHeight:1.6}}>
                  <strong style={{color:C.er}}>Multi-PROG will reject this file.</strong> The programmer performs an exact byte-count check before writing.
                  If this is a PowerCal EFD package, use the <strong style={{color:C.gn}}>EFD → BIN</strong> tab to extract the correct-sized CodeData.bin block instead.
                </div>
              </>
            )}

            {/* FAIL: no close matches */}
            {!result.pass && result.close.length === 0 && (
              <SLine type="error" msg={`${fmtSizeShort(f.size)} does not match any known Multi-PROG flash region. This file may be an encrypted EFD payload, a partial dump, or a non-standard image.`}/>
            )}
          </Card>
        );
      })}

      {/* Reference table */}
      <ReferenceTable/>
    </div>
  );
}
