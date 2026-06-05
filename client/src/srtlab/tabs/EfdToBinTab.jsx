import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Card, Btn, Tag, SLine} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {extractEfdPayload} from '../lib/efdParser.js';

// EFD -> BIN converter (its own UI). Drop a Mopar PowerCal `.efd` / `.webm`
// container and extract the raw payload as a `.bin`. This reproduces exactly
// what the desktop `EFD_Reader.exe` writes: the encrypted payload bytes,
// unmodified. No decryption happens here (none happens in the desktop tool
// either) — the ECM bootloader decrypts the payload during the `0x36
// TransferData` half of the UDS flash. The payload is located by a proper
// EBML walk in `extractEfdPayload`, not a naive id scan.

function Stat({label, value, color}){
  return (
    <div style={{padding: '8px 10px', borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}`}}>
      <div style={{fontSize: 8, fontWeight: 800, color: C.ts, letterSpacing: 1.4}}>{label}</div>
      <div style={{fontSize: 14, fontWeight: 800, color: color || C.tx, marginTop: 4, fontFamily: 'JetBrains Mono', wordBreak: 'break-all'}}>{value}</div>
    </div>
  );
}

function baseName(name){
  const n = (name || 'efd-payload').replace(/\.(efd|webm)$/i, '');
  return n || 'efd-payload';
}

function fmtSize(n){
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function sha256Hex(bytes){
  if (!(globalThis.crypto && globalThis.crypto.subtle)) return null;
  const src = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', src);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function EfdToBinTab({efdFile, onFlash}){
  const fileInput = useRef(null);
  // loaded: { name, bytes:Uint8Array }
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const [sha, setSha] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sectionMapOpen, setSectionMapOpen] = useState(false);

  // Seed from the shared workspace EFD file (set when an .efd is dropped
  // anywhere — the loader diverts EBML containers to shared state).
  useEffect(() => {
    if (loaded) return;
    if (!efdFile) return;
    const raw = efdFile.raw || (efdFile.data instanceof Uint8Array ? efdFile.data.buffer : null);
    if (raw) setLoaded({name: efdFile.name || efdFile.filename || 'container.efd', bytes: new Uint8Array(raw)});
  }, [efdFile, loaded]);

  const result = useMemo(() => {
    if (!loaded) return null;
    return extractEfdPayload(loaded.bytes, loaded.name);
  }, [loaded]);

  // Reset the verification hash whenever the loaded file changes.
  useEffect(() => { setSha(null); setSectionMapOpen(false); }, [loaded]);

  const onPick = useCallback((e) => {
    const f = e.target.files && e.target.files[0];
    if (e.target) e.target.value = '';
    if (!f) return;
    setError(null);
    setSha(null);
    const rd = new FileReader();
    rd.onload = (ev) => setLoaded({name: f.name, bytes: new Uint8Array(ev.target.result)});
    rd.onerror = () => setError('Could not read the selected file');
    rd.readAsArrayBuffer(f);
  }, []);

  const convert = useCallback(async () => {
    if (!result || !result.ok) return;
    setBusy(true);
    try {
      const out = result.bytes;
      const blob = new Blob([out], {type: 'application/octet-stream'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = baseName(loaded.name) + '.bin';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      try { setSha(await sha256Hex(out)); } catch { setSha(null); }
    } finally {
      setBusy(false);
    }
  }, [result, loaded]);

  if (!loaded){
    return (
      <Card>
        <div style={{textAlign: 'center', padding: 28}}>
          <div style={{fontFamily: "'Righteous'", fontSize: 22, color: C.tx, letterSpacing: 2}}>EFD → BIN</div>
          <div style={{fontSize: 12, color: C.ts, marginTop: 8, lineHeight: 1.6, maxWidth: 540, marginLeft: 'auto', marginRight: 'auto'}}>
            Drop a Mopar PowerCal <code>.efd</code> / <code>.webm</code> container to extract its payload as a
            <code> .bin</code>. The output is byte-for-byte identical to what the desktop <strong>EFD_Reader.exe</strong> writes —
            the payload stays encrypted (the ECM bootloader decrypts it during the flash).
          </div>
          <input ref={fileInput} type="file" accept=".efd,.EFD,.webm,.WEBM" style={{display: 'none'}} onChange={onPick}/>
          <div style={{marginTop: 16}}>
            <Btn onClick={() => fileInput.current && fileInput.current.click()}>+ LOAD .efd / .webm</Btn>
          </div>
          {error && <div style={{marginTop: 12}}><SLine type="error" msg={error}/></div>}
        </div>
      </Card>
    );
  }

  const parsed = result && result.parsed;
  const meta = (parsed && parsed.metadata) || {};
  const ok = result && result.ok;
  const sections = (parsed && parsed.sections) || [];

  return (
    <div>
      <input ref={fileInput} type="file" accept=".efd,.EFD,.webm,.WEBM" style={{display: 'none'}} onChange={onPick}/>

      <Card>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap'}}>
          <Tag color={ok ? C.gn : C.er}>{ok ? '✓ PAYLOAD READY' : '✗ NO PAYLOAD'}</Tag>
          {parsed && <Tag color={C.wn}>{parsed.efdType === 'mopar_powercal' ? 'MOPAR POWERCAL' : 'EFD CONTAINER'}</Tag>}
          <span style={{fontSize: 12, color: C.tx, fontWeight: 700}}>{loaded.name}</span>
          <span style={{fontSize: 10, color: C.ts}}>{fmtSize(loaded.bytes.length)}</span>
          <span style={{flex: 1}}/>
          <Btn color={C.a3} onClick={() => fileInput.current && fileInput.current.click()}>LOAD ANOTHER</Btn>
        </div>

        {!ok && <SLine type="error" msg={(result && result.error) || 'Could not extract a payload from this file'}/>}
        {error && <SLine type="error" msg={error}/>}

        {ok && (
          <>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 4}}>
              <Stat label="PAYLOAD OFFSET" value={`0x${result.offset.toString(16).toUpperCase()}`} color={C.a3}/>
              <Stat label="PAYLOAD SIZE" value={fmtSize(result.size)} color={C.a1}/>
              <Stat label="ENTROPY" value={parsed.payload ? parsed.payload.entropy.toFixed(3) : '—'} color={parsed.payload && parsed.payload.entropy > 7.9 ? C.er : C.wn}/>
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
              <strong style={{color: C.er}}>Note:</strong> the extracted <code>.bin</code> is the raw, still-encrypted payload —
              identical to what EFD_Reader.exe produces. It is not human-readable as-is; the ECM bootloader decrypts it
              in-place during the <code>0x36 TransferData</code> half of the UDS programming session. Hand it to the ECM
              Flasher tab for the bench bridge, or flash via wiTECH / AlfaOBD.
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
