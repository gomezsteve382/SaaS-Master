import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Card, Btn, Tag, SLine} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {extractEfdPayload, parseEfdZipPackage, buildFullFlashImage} from '../lib/efdParser.js';

// EFD → BIN converter.
//
// Two modes:
//   1. .efd / .webm  — EBML container mode. Extracts the encrypted UP payload
//      byte-for-byte, identical to what EFD_Reader.exe writes. The payload
//      stays encrypted; the ECM bootloader decrypts it during 0x36 TransferData.
//      Use this for wiTECH / AlfaOBD / PowerCal UDS flash.
//
//   2. .zip          — PowerCal package mode. Unzips the outer package, finds
//      all MicroprocessorN_LogicalBlock.zip entries, extracts CodeData.bin +
//      address ranges, and presents per-block download buttons. Each CodeData.bin
//      is the DECRYPTED, ready-to-write flash region. Use LB18 for Multi-PROG
//      INT FLASH bench write (exact size match guaranteed).

function Stat({label, value, color}){
  return (
    <div style={{padding: '8px 10px', borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}`}}>
      <div style={{fontSize: 8, fontWeight: 800, color: C.ts, letterSpacing: 1.4}}>{label}</div>
      <div style={{fontSize: 14, fontWeight: 800, color: color || C.tx, marginTop: 4, fontFamily: 'JetBrains Mono', wordBreak: 'break-all'}}>{value}</div>
    </div>
  );
}

function fmtSize(n){
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtHex(n){ return '0x' + n.toString(16).toUpperCase().padStart(6, '0'); }

function baseName(name, suffix = ''){
  const n = (name || 'efd-payload').replace(/\.(efd|webm|zip)$/i, '');
  return (n || 'efd-payload') + suffix;
}

async function sha256Hex(bytes){
  if (!(globalThis.crypto && globalThis.crypto.subtle)) return null;
  const src = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', src);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function downloadBytes(bytes, filename){
  const blob = new Blob([bytes], {type: 'application/octet-stream'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── ZIP MODE ────────────────────────────────────────────────────────────────

function BlockRow({block, pkgName, idx}){
  const [sha, setSha] = useState(null);
  const [busy, setBusy] = useState(false);
  const isTarget = block.label && block.label.includes('Multi-PROG');

  const download = useCallback(async () => {
    setBusy(true);
    const suffix = `_LB${block.index}_${fmtHex(block.startAddress)}.bin`;
    downloadBytes(block.data, baseName(pkgName, suffix));
    try { setSha(await sha256Hex(block.data)); } catch { setSha(null); }
    setBusy(false);
  }, [block, pkgName]);

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 10,
      background: isTarget ? '#1B5E2018' : C.c2,
      border: `1px solid ${isTarget ? C.gn + '55' : C.bd}`,
      marginBottom: 10,
    }}>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6}}>
        <Tag color={isTarget ? C.gn : C.a1}>LB{block.index}</Tag>
        {isTarget && <Tag color={C.gn}>✓ MULTI-PROG INT FLASH</Tag>}
        <span style={{fontSize: 12, fontWeight: 700, color: C.tx, flex: 1}}>{block.label}</span>
      </div>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 8}}>
        <Stat label="START ADDR" value={fmtHex(block.startAddress)} color={C.a3}/>
        <Stat label="END ADDR"   value={fmtHex(block.endAddress)}   color={C.a3}/>
        <Stat label="DECLARED"   value={fmtSize(block.declaredSize)} color={C.a1}/>
        <Stat label="FILE SIZE"  value={fmtSize(block.dataSize)}
              color={block.sizeMatch ? C.gn : C.er}/>
      </div>
      {!block.sizeMatch && (
        <SLine type="warn" msg={`CodeData.bin is ${block.dataSize} bytes but declared range is ${block.declaredSize} bytes — file may be truncated`}/>
      )}
      {block.sourceFile && (
        <div style={{fontSize: 10, color: C.ts, marginBottom: 6}}>
          Source: <span style={{fontFamily: 'JetBrains Mono', color: C.tx}}>{block.sourceFile}</span>
        </div>
      )}
      <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
        <Btn color={isTarget ? C.gn : C.a1} onClick={download} disabled={busy}>
          {busy ? '…' : `⬇ DOWNLOAD LB${block.index} .bin`}
        </Btn>
        {isTarget && (
          <span style={{fontSize: 10, color: C.gn, fontWeight: 700}}>
            ← Use this file for Multi-PROG INT FLASH write
          </span>
        )}
      </div>
      {sha && (
        <div style={{marginTop: 8, fontSize: 10, fontFamily: 'JetBrains Mono', color: C.gn, wordBreak: 'break-all'}}>
          SHA-256: {sha}
        </div>
      )}
    </div>
  );
}

function ZipResult({zipResult, pkgName}){
  const [fullBusy, setFullBusy] = useState(false);
  const [fullSha, setFullSha] = useState(null);
  const [descOpen, setDescOpen] = useState(false);

  const downloadFull = useCallback(async () => {
    setFullBusy(true);
    const r = buildFullFlashImage(zipResult.blocks);
    if (!r){ setFullBusy(false); return; }
    downloadBytes(r.image, baseName(pkgName, '_FULL_FLASH.bin'));
    try { setFullSha(await sha256Hex(r.image)); } catch { setFullSha(null); }
    setFullBusy(false);
  }, [zipResult, pkgName]);

  const fullImg = useMemo(() => buildFullFlashImage(zipResult.blocks), [zipResult]);

  return (
    <div>
      {/* Header */}
      <Card>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap'}}>
          <Tag color={C.gn}>✓ POWERCAL PACKAGE</Tag>
          <Tag color={C.a2}>{zipResult.blocks.length} FLASH BLOCKS</Tag>
          <span style={{fontSize: 12, color: C.tx, fontWeight: 700}}>{pkgName}</span>
          <span style={{fontSize: 10, color: C.ts}}>{fmtSize(zipResult.totalSize)}</span>
        </div>

        {/* Descriptor summary */}
        {zipResult.descriptor.description && (
          <div style={{marginBottom: 10}}>
            <div
              style={{cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, userSelect: 'none'}}
              onClick={() => setDescOpen(o => !o)}
            >
              <span style={{fontSize: 10, fontWeight: 800, color: C.a2, letterSpacing: 1.2}}>CALIBRATION DESCRIPTOR</span>
              <span style={{fontSize: 12, color: C.ts}}>{descOpen ? '▲' : '▼'}</span>
            </div>
            {descOpen && (
              <pre style={{
                marginTop: 8, padding: '10px 12px', borderRadius: 8,
                background: C.c2, border: `1px solid ${C.bd}`,
                fontSize: 11, color: C.tx, fontFamily: 'JetBrains Mono',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {zipResult.descriptor.description}
              </pre>
            )}
          </div>
        )}

        {/* Full flash image download */}
        {fullImg && (
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            background: '#1A237E18', border: `1px solid ${C.a1}55`,
            marginBottom: 10,
          }}>
            <div style={{fontSize: 11, fontWeight: 800, color: C.a1, letterSpacing: 1, marginBottom: 6}}>
              FULL FLASH IMAGE (all blocks assembled)
            </div>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 8}}>
              <Stat label="START" value={fmtHex(fullImg.startAddress)} color={C.a3}/>
              <Stat label="END"   value={fmtHex(fullImg.endAddress)}   color={C.a3}/>
              <Stat label="SIZE"  value={fmtSize(fullImg.image.length)} color={C.a1}/>
            </div>
            <div style={{fontSize: 10, color: C.ts, marginBottom: 8, lineHeight: 1.5}}>
              All blocks assembled into one contiguous image. Gaps between blocks filled with 0xFF (erased flash).
              <br/>Useful for full-chip write tools that expect a single binary.
            </div>
            <Btn color={C.a1} onClick={downloadFull} disabled={fullBusy}>
              {fullBusy ? '… BUILDING' : '⬇ DOWNLOAD FULL FLASH IMAGE .bin'}
            </Btn>
            {fullSha && (
              <div style={{marginTop: 6, fontSize: 10, fontFamily: 'JetBrains Mono', color: C.a1, wordBreak: 'break-all'}}>
                SHA-256: {fullSha}
              </div>
            )}
          </div>
        )}

        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: '#FF174410', border: `1px solid ${C.er}33`,
          fontSize: 11, color: C.tx, lineHeight: 1.6,
        }}>
          <strong style={{color: C.gn}}>Multi-PROG users:</strong> download the{' '}
          <strong style={{color: C.gn}}>LB18 INT FLASH</strong> block (3,407,872 bytes).
          That is the exact size Multi-PROG expects for an <code>INT FLASH</code> write on the GPEC2A.
          The other blocks (LB19, LB20) are for tools that write the full P-Flash or data block separately.
          <br/><br/>
          <strong style={{color: C.er}}>Do not use the encrypted .efd payload</strong> (18SCAT_ECM_INTFLASH.bin style files)
          for Multi-PROG — those are UDS flash payloads, not raw flash binaries.
        </div>
      </Card>

      {/* Per-block rows */}
      <div style={{marginTop: 16}}>
        {zipResult.blocks.map((blk, i) => (
          <BlockRow key={blk.index} block={blk} pkgName={pkgName} idx={i}/>
        ))}
      </div>
    </div>
  );
}

// ─── EFD / WEBM MODE ─────────────────────────────────────────────────────────

function EfdResult({result, loaded, onFlash}){
  const [sha, setSha] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sectionMapOpen, setSectionMapOpen] = useState(false);

  const parsed = result.parsed;
  const meta   = (parsed && parsed.metadata) || {};
  const ok     = result.ok;
  const sections = (parsed && parsed.sections) || [];

  const convert = useCallback(async () => {
    if (!result || !result.ok) return;
    setBusy(true);
    try {
      const out = result.bytes;
      downloadBytes(out, baseName(loaded.name) + '.bin');
      try { setSha(await sha256Hex(out)); } catch { setSha(null); }
    } finally { setBusy(false); }
  }, [result, loaded]);

  return (
    <div>
      <Card>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap'}}>
          <Tag color={ok ? C.a2 : C.er}>{ok ? '✓ EFD PAYLOAD READY' : '✗ NO PAYLOAD'}</Tag>
          {parsed && <Tag color={C.wn}>{parsed.efdType === 'mopar_bcm' ? 'MOPAR BCM' : parsed.efdType === 'mopar_powercal' ? 'MOPAR POWERCAL' : 'EFD CONTAINER'}</Tag>}
          <span style={{fontSize: 12, color: C.tx, fontWeight: 700}}>{loaded.name}</span>
          <span style={{fontSize: 10, color: C.ts}}>{fmtSize(loaded.bytes.length)}</span>
        </div>

        {!ok && <SLine type="error" msg={(result && result.error) || 'Could not extract a payload from this file'}/>}

        {ok && (
          <>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 4}}>
              <Stat label="PAYLOAD OFFSET" value={fmtHex(result.offset)} color={C.a3}/>
              <Stat label="PAYLOAD SIZE"   value={fmtSize(result.size)}  color={C.a1}/>
              <Stat label="ENTROPY"        value={parsed.payload ? parsed.payload.entropy.toFixed(3) : '—'}
                    color={parsed.payload && parsed.payload.entropy > 7.9 ? C.er : C.wn}/>
            </div>

            <div style={{marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap'}}>
              <Btn color={C.sr} onClick={convert} disabled={busy}>
                {busy ? '… CONVERTING' : `⬇ CONVERT → ${baseName(loaded.name)}.bin`}
              </Btn>
              {onFlash && (
                <Btn color={C.a4} onClick={() => onFlash({
                  filename: baseName(loaded.name) + '.payload',
                  name: baseName(loaded.name) + '.payload',
                  size: result.bytes.length,
                  data: result.bytes,
                  type: 'EFD-PAYLOAD',
                  meta,
                })}>⚡ SEND PAYLOAD TO ECM FLASHER</Btn>
              )}
            </div>

            {sha && (
              <div style={{marginTop: 12, padding: 10, borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}`}}>
                <div style={{fontSize: 8, fontWeight: 800, color: C.ts, letterSpacing: 1.4}}>SHA-256 OF EXPORTED .BIN</div>
                <div style={{fontSize: 11, fontFamily: 'JetBrains Mono', color: C.gn, marginTop: 4, wordBreak: 'break-all'}}>{sha}</div>
                <div style={{fontSize: 10, color: C.ts, marginTop: 6, lineHeight: 1.5}}>
                  Compare against <code>sha256sum</code> of the desktop EFD_Reader.exe output — they should match exactly.
                </div>
              </div>
            )}

            {result.declaredSize !== result.size && (
              <div style={{marginTop: 10}}>
                <SLine type="warn" msg={`Container declares ${result.declaredSize} payload bytes but only ${result.size} are present (file truncated); exporting what exists.`}/>
              </div>
            )}

            <div style={{marginTop: 12, padding: 10, borderRadius: 8, background: '#FF174410', border: `1px solid ${C.er}33`, fontSize: 11, color: C.tx, lineHeight: 1.6}}>
              <strong style={{color: C.wn}}>EFD payload mode:</strong> the extracted <code>.bin</code> is the raw,
              still-encrypted payload — identical to what EFD_Reader.exe produces.
              Use it with wiTECH / AlfaOBD / PowerCal (UDS 0x36 TransferData).
              <br/><br/>
              <strong style={{color: C.gn}}>For Multi-PROG bench write</strong>, drop the <strong>PowerCal .zip package</strong> here instead —
              it contains the decrypted CodeData.bin blocks at the exact sizes Multi-PROG expects.
            </div>
          </>
        )}
      </Card>

      {Object.keys(meta).length > 0 && (
        <Card style={{marginTop: 16}}>
          <div style={{fontFamily: 'JetBrains Mono', fontSize: 11, letterSpacing: 3, color: C.a2, fontWeight: 800, marginBottom: 10}}>CAL METADATA</div>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8}}>
            {Object.entries(meta).map(([k, v]) => (
              <div key={k} style={{padding: '8px 10px', borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}`}}>
                <div style={{fontSize: 8, fontWeight: 800, color: C.ts, letterSpacing: 1.4}}>{k.toUpperCase()}</div>
                <div style={{fontSize: 12, fontWeight: 700, color: C.tx, marginTop: 4}}>{v}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {sections.length > 0 && (
        <Card style={{marginTop: 16}}>
          <div
            style={{display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none'}}
            onClick={() => setSectionMapOpen(o => !o)}
          >
            <div style={{fontFamily: 'JetBrains Mono', fontSize: 11, letterSpacing: 3, color: C.a2, fontWeight: 800, flex: 1}}>
              EBML SECTION MAP
            </div>
            <Tag color={C.a1}>{sections.length} ELEMENTS</Tag>
            <span style={{fontSize: 14, color: C.ts, fontWeight: 700}}>{sectionMapOpen ? '▲' : '▼'}</span>
          </div>

          {sectionMapOpen && (
            <>
              <div style={{overflowX: 'auto', marginTop: 12}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'JetBrains Mono'}}>
                  <thead>
                    <tr style={{borderBottom: `2px solid ${C.bd}`}}>
                      {['#', 'OFFSET', 'ELEMENT ID', 'TAG / LABEL', 'SIZE', 'KIND'].map(h => (
                        <th key={h} style={{padding: '4px 10px', textAlign: 'left', fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1.2, whiteSpace: 'nowrap'}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sections.map((s, i) => {
                      const isPayload = s.kind === 'payload';
                      const isHeader  = s.kind === 'header';
                      const isMeta    = s.kind === 'metadata';
                      const rowBg = isPayload ? '#2E7D3218' : isHeader ? '#1565C018' : 'transparent';
                      const kindColor = isPayload ? C.gn : isHeader ? C.a1 : isMeta ? C.a2 : C.ts;
                      return (
                        <tr key={i} style={{background: rowBg, borderBottom: `1px solid ${C.bd}33`}}>
                          <td style={{padding: '5px 10px', color: C.ts, fontSize: 10}}>{i + 1}</td>
                          <td style={{padding: '5px 10px', color: C.a3, whiteSpace: 'nowrap'}}>
                            0x{s.offset.toString(16).toUpperCase().padStart(6, '0')}
                          </td>
                          <td style={{padding: '5px 10px', color: C.a1, whiteSpace: 'nowrap'}}>
                            0x{s.id.toUpperCase()}
                          </td>
                          <td style={{padding: '5px 10px', color: isPayload ? C.gn : C.tx, fontWeight: isPayload ? 800 : 600}}>
                            {s.label
                              ? <>{s.label}{isPayload && <span style={{marginLeft: 6, fontSize: 9, color: C.gn, fontWeight: 800, letterSpacing: 1}}> ← PAYLOAD</span>}</>
                              : <span style={{color: C.ts, fontStyle: 'italic'}}>unknown</span>
                            }
                          </td>
                          <td style={{padding: '5px 10px', color: C.tx, whiteSpace: 'nowrap'}}>{fmtSize(s.size)}</td>
                          <td style={{padding: '5px 10px'}}>
                            {s.kind ? (
                              <span style={{
                                fontSize: 9, fontWeight: 800, letterSpacing: 1, color: kindColor,
                                padding: '2px 6px', borderRadius: 4,
                                background: `${kindColor}18`,
                                border: `1px solid ${kindColor}44`,
                              }}>
                                {s.kind.toUpperCase()}
                              </span>
                            ) : <span style={{color: C.ts, fontSize: 9}}>—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{marginTop: 8, fontSize: 10, color: C.ts, lineHeight: 1.6}}>
                <span style={{color: C.gn, fontWeight: 700}}>■</span> Green row = UP payload (id <code>0x205550</code>) — the encrypted flash image extracted to .bin.{' '}
                <span style={{color: C.a1, fontWeight: 700}}>■</span> Blue row = EBML header (id <code>0x1A45DFA3</code>).
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function EfdToBinTab({efdFile, onFlash}){
  const fileInput = useRef(null);
  const [loaded, setLoaded] = useState(null);   // { name, bytes, isZip }
  const [error, setError] = useState(null);
  const [zipResult, setZipResult] = useState(null);
  const [zipBusy, setZipBusy] = useState(false);

  // Seed from shared workspace EFD file
  useEffect(() => {
    if (loaded) return;
    if (!efdFile) return;
    const raw = efdFile.raw || (efdFile.data instanceof Uint8Array ? efdFile.data.buffer : null);
    if (raw){
      const bytes = new Uint8Array(raw);
      const name  = efdFile.name || efdFile.filename || 'container.efd';
      const isZip = name.toLowerCase().endsWith('.zip');
      setLoaded({name, bytes, isZip});
    }
  }, [efdFile, loaded]);

  // When a zip is loaded, parse it asynchronously
  useEffect(() => {
    if (!loaded || !loaded.isZip) return;
    setZipResult(null);
    setZipBusy(true);
    setError(null);
    parseEfdZipPackage(loaded.bytes, loaded.name)
      .then(r => {
        if (!r.ok) setError(r.error || 'Failed to parse zip package');
        setZipResult(r);
      })
      .catch(e => setError('Zip parse error: ' + (e.message || e)))
      .finally(() => setZipBusy(false));
  }, [loaded]);

  const efdResult = useMemo(() => {
    if (!loaded || loaded.isZip) return null;
    return extractEfdPayload(loaded.bytes, loaded.name);
  }, [loaded]);

  const onPick = useCallback((e) => {
    const f = e.target.files && e.target.files[0];
    if (e.target) e.target.value = '';
    if (!f) return;
    setError(null);
    setZipResult(null);
    const isZip = f.name.toLowerCase().endsWith('.zip');
    const rd = new FileReader();
    rd.onload = (ev) => setLoaded({name: f.name, bytes: new Uint8Array(ev.target.result), isZip});
    rd.onerror = () => setError('Could not read the selected file');
    rd.readAsArrayBuffer(f);
  }, []);

  const reset = useCallback(() => {
    setLoaded(null);
    setZipResult(null);
    setError(null);
  }, []);

  // ── Empty state ──────────────────────────────────────────────────────────
  if (!loaded){
    return (
      <Card>
        <div style={{textAlign: 'center', padding: 28}}>
          <div style={{fontFamily: "'Righteous'", fontSize: 22, color: C.tx, letterSpacing: 2}}>EFD → BIN</div>
          <div style={{fontSize: 12, color: C.ts, marginTop: 8, lineHeight: 1.7, maxWidth: 580, marginLeft: 'auto', marginRight: 'auto'}}>
            Drop a Mopar PowerCal file to extract flash binaries.
            <br/>
            <strong style={{color: C.gn}}>PowerCal .zip package</strong> → extracts decrypted CodeData.bin blocks by region
            (LB18 = INT FLASH, exact size for Multi-PROG bench write).
            <br/>
            <strong style={{color: C.a2}}>.efd / .webm container</strong> → extracts the encrypted UP payload
            (for wiTECH / AlfaOBD / PowerCal UDS flash, same as EFD_Reader.exe).
          </div>
          <input ref={fileInput} type="file" accept=".efd,.EFD,.webm,.WEBM,.zip,.ZIP" style={{display: 'none'}} onChange={onPick}/>
          <div style={{marginTop: 16}}>
            <Btn onClick={() => fileInput.current && fileInput.current.click()}>+ LOAD .zip / .efd / .webm</Btn>
          </div>
          {error && <div style={{marginTop: 12}}><SLine type="error" msg={error}/></div>}
        </div>
      </Card>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  return (
    <div>
      <input ref={fileInput} type="file" accept=".efd,.EFD,.webm,.WEBM,.zip,.ZIP" style={{display: 'none'}} onChange={onPick}/>

      {/* Top bar */}
      <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap'}}>
        <Tag color={loaded.isZip ? C.gn : C.a2}>{loaded.isZip ? 'ZIP PACKAGE' : 'EFD CONTAINER'}</Tag>
        <span style={{fontSize: 12, color: C.tx, fontWeight: 700, flex: 1}}>{loaded.name}</span>
        <Btn color={C.a3} onClick={() => fileInput.current && fileInput.current.click()}>LOAD ANOTHER</Btn>
        <Btn color={C.ts} onClick={reset}>CLEAR</Btn>
      </div>

      {error && <div style={{marginBottom: 12}}><SLine type="error" msg={error}/></div>}

      {/* ZIP mode */}
      {loaded.isZip && zipBusy && (
        <Card>
          <div style={{textAlign: 'center', padding: 24, color: C.ts, fontSize: 13}}>
            Parsing zip package…
          </div>
        </Card>
      )}
      {loaded.isZip && !zipBusy && zipResult && zipResult.ok && (
        <ZipResult zipResult={zipResult} pkgName={loaded.name}/>
      )}

      {/* EFD / WEBM mode */}
      {!loaded.isZip && efdResult && (
        <EfdResult result={efdResult} loaded={loaded} onFlash={onFlash}/>
      )}
    </div>
  );
}
