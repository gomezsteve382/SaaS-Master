import React, {useMemo, useRef} from "react";
import {Card, Btn, Tag, SLine} from '../lib/ui.jsx';
import {C, TC} from '../lib/constants.js';
import {parseEFD} from '../lib/efdParser.js';
import {decodeChargerVin} from '../lib/vin.js';

// EFD / Mopar PowerCal `.webm` inspector tab (Task #488). The container
// metadata, EBML structure, and encrypted payload offset are surfaced
// here. The payload itself is left encrypted — the ECM bootloader
// decrypts it during the `0x36 TransferData` half of the UDS flash.
//
// BCM EFDs have no DS block — only FS + UP + AL. When no DS metadata is
// present, the "BCM MODULE INFO" section is shown instead, displaying
// the builder metadata from the AL section (creation date, tool, version)
// plus file stats derived from the EBML structure.

function Section({title, count, color, children}){
  const c = color || C.a3;
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

function MetaCell({label, value, color}){
  return (
    <div style={{padding: '8px 10px', borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}`}}>
      <div style={{fontSize: 8, fontWeight: 800, color: C.ts, letterSpacing: 1.4}}>{label}</div>
      <div style={{fontSize: 12, fontWeight: 700, color: color || C.tx, marginTop: 4}}>{value}</div>
    </div>
  );
}

function CompatRow({label, expected, actual}){
  const ok = expected && actual && (
    String(expected) === String(actual) ||
    String(expected).includes(String(actual)) ||
    String(actual).includes(String(expected))
  );
  return (
    <div style={{padding: '8px 10px', borderRadius: 8, background: C.c2, border: `1px solid ${ok ? C.gn + '50' : C.bd}`}}>
      <div style={{fontSize: 8, fontWeight: 800, color: C.ts, letterSpacing: 1.4}}>{label}</div>
      <div style={{fontSize: 11, color: C.tx, marginTop: 4}}>EFD: <span style={{color: C.a3, fontWeight: 700}}>{expected || '?'}</span></div>
      <div style={{fontSize: 11, color: C.tx}}>VIN: <span style={{color: C.a1, fontWeight: 700}}>{actual || '?'}</span></div>
      {ok && <Tag color={C.gn}>✓ MATCH</Tag>}
    </div>
  );
}

// Determine a human-readable module type label from the parsed EFD.
function getModuleTypeLabel(efd){
  if (efd.efdType === 'mopar_powercal') return 'ECM / PCM';
  if (efd.efdType === 'mopar_bcm') return 'BCM';
  // Try to infer from filename
  const n = (efd.name || '').toUpperCase();
  if (n.includes('BCM')) return 'BCM';
  if (n.includes('ECM') || n.includes('PCM') || n.includes('ENG')) return 'ECM / PCM';
  if (n.includes('RFHUB') || n.includes('RFH')) return 'RFHUB';
  if (n.includes('TCM') || n.includes('TRANS')) return 'TCM';
  return 'UNKNOWN';
}

export default function EfdInspectorTab({efdFile, files = [], onFlash, onLoad}){
  const fileInput = useRef(null);

  // efdFile may either be a pre-parsed `{data, raw, ...}` object (the
  // shape the workspace `loadF` produces) or a raw `{name, data}` pair.
  const efd = useMemo(() => {
    if (!efdFile) return null;
    if (efdFile.data && efdFile.data.sections) return efdFile.data;
    if (efdFile.raw) return parseEFD(efdFile.raw, efdFile.name || efdFile.filename);
    if (efdFile.data) return parseEFD(efdFile.data, efdFile.name || efdFile.filename);
    return null;
  }, [efdFile]);

  const vinFromBin = useMemo(() => {
    for (const f of files){
      if (f && f.vins && f.vins.length){
        const v = f.vins.find(v => v && v.vin && v.vin !== '00000000000000000');
        if (v) return v.vin;
      }
    }
    return null;
  }, [files]);

  const decoded = vinFromBin ? decodeChargerVin(vinFromBin) : null;

  const onPick = (e) => {
    const list = e.target.files;
    if (list && list.length && onLoad) onLoad(list);
    if (e.target) e.target.value = '';
  };

  if (!efd){
    return (
      <Card>
        <div style={{textAlign: 'center', padding: 28}}>
          <div style={{fontFamily: "'Righteous'", fontSize: 22, color: C.tx, letterSpacing: 2}}>EFD INSPECTOR</div>
          <div style={{fontSize: 12, color: C.ts, marginTop: 8, lineHeight: 1.6}}>
            Drop a Mopar PowerCal `.webm` or `.efd` calibration file to inspect metadata,
            verify VIN/cal compatibility, and prep for flashing via the bench bridge or wiTECH/AlfaOBD.
          </div>
          <input ref={fileInput} type="file" accept=".webm,.WEBM,.efd,.EFD" style={{display: 'none'}} onChange={onPick}/>
          <div style={{marginTop: 16}}>
            <Btn onClick={() => fileInput.current && fileInput.current.click()}>+ LOAD .webm / .efd</Btn>
          </div>
        </div>
      </Card>
    );
  }

  const meta = efd.metadata || {};
  const builderMeta = efd.builderMeta || {};
  const sections = efd.sections || [];
  const hasDs = Object.keys(meta).length > 0;
  const hasBcmInfo = !hasDs && (builderMeta.CRT || builderMeta.FGN || efd.payload);
  const moduleTypeLabel = getModuleTypeLabel(efd);

  // Determine EFD type badge text
  let efdTypeBadge = 'UNKNOWN EFD';
  if (efd.efdType === 'mopar_powercal') efdTypeBadge = 'MOPAR POWERCAL';
  else if (efd.efdType === 'mopar_bcm') efdTypeBadge = 'MOPAR BCM';
  else if (efd.efdType === 'mopar_powercal_noDS') efdTypeBadge = 'MOPAR POWERCAL (NO DS)';

  return (
    <div>
      <Card>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap'}}>
          <Tag color={efd.valid ? C.gn : C.er}>{efd.valid ? '✓ VALID EFD' : '✗ INVALID'}</Tag>
          <Tag color={C.wn}>{efdTypeBadge}</Tag>
          <Tag color={C.a4}>{moduleTypeLabel}</Tag>
          <span style={{fontSize: 12, color: C.tx, fontWeight: 700}}>{efd.name}</span>
          <span style={{fontSize: 10, color: C.ts}}>{(efd.size / 1024 / 1024).toFixed(2)} MB</span>
        </div>
        {efd.error && <SLine type="error" msg={efd.error}/>}
        {onFlash && efd.payload && efdFile && (efdFile.raw || efdFile.data) && (
          <div style={{marginTop: 10}}>
            <Btn color={C.sr} onClick={() => {
              const buf = efdFile.raw || (efdFile.data instanceof Uint8Array ? efdFile.data.buffer : null);
              if (!buf) return;
              const u8 = new Uint8Array(buf);
              const slice = u8.subarray(efd.payload.offset, efd.payload.offset + efd.payload.size);
              onFlash({
                filename: (efd.name || 'efd-payload') + '.payload',
                name: (efd.name || 'efd-payload') + '.payload',
                size: slice.length,
                data: slice,
                type: 'EFD-PAYLOAD',
                meta,
              });
            }}>⚡ FLASH PAYLOAD TO ECM</Btn>
          </div>
        )}
      </Card>

      {/* ECM/PCM: DS block with Key=Value metadata */}
      {hasDs && (
        <Section title="CAL METADATA" count={Object.keys(meta).length} color={C.a2}>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8}}>
            {Object.entries(meta).map(([k, v]) => (
              <MetaCell key={k} label={k.toUpperCase()} value={v}/>
            ))}
          </div>
        </Section>
      )}

      {/* BCM / no-DS: show builder metadata + file stats instead */}
      {hasBcmInfo && (
        <Section title="BCM MODULE INFO" color={C.a3}>
          <div style={{marginBottom: 10, padding: '8px 12px', borderRadius: 8,
            background: '#FF8C0012', border: `1px solid ${C.wn}44`,
            fontSize: 11, color: C.ts, lineHeight: 1.6}}>
            <strong style={{color: C.wn}}>No DS metadata block.</strong>{' '}
            BCM EFDs do not carry plaintext calibration fields (Engine, Transmission, etc.).
            The information below is extracted from the AL builder section and EBML container structure.
          </div>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8}}>
            {builderMeta.CRT && (
              <MetaCell label="FILE CREATED" value={builderMeta.CRT} color={C.a1}/>
            )}
            {builderMeta.FGN && (
              <MetaCell label="BUILDER TOOL" value={builderMeta.FGN} color={C.a3}/>
            )}
            {builderMeta.FGV && (
              <MetaCell label="BUILDER VERSION" value={builderMeta.FGV} color={C.a3}/>
            )}
            {builderMeta.CAD && (
              <MetaCell label="PURPOSE" value={builderMeta.CAD} color={C.ts}/>
            )}
            {efd.payload && (
              <MetaCell
                label="FLASH PAYLOAD SIZE"
                value={`${(efd.payload.size / 1024 / 1024).toFixed(3)} MB`}
                color={C.a1}
              />
            )}
            <MetaCell
              label="CONTAINER SIZE"
              value={`${(efd.size / 1024 / 1024).toFixed(3)} MB`}
              color={C.tx}
            />
          </div>
        </Section>
      )}

      {/* No DS and no BCM info at all */}
      {!hasDs && !hasBcmInfo && (
        <Section title="CAL METADATA" count={0} color={C.a2}>
          <SLine type="warn" msg="No DS plaintext metadata recovered"/>
        </Section>
      )}

      {decoded && (
        <Section title="VIN ↔ CAL COMPATIBILITY" color={C.gn}>
          <Card>
            <div style={{fontSize: 11, color: C.ts, marginBottom: 8}}>
              Loaded BCM/PCM VIN: <span style={{color: C.a1, fontWeight: 800, fontFamily: 'JetBrains Mono'}}>{vinFromBin}</span>
            </div>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <CompatRow label="Year" expected={meta.ModelYear || meta.Year} actual={decoded.year ? String(decoded.year) : '?'}/>
              <CompatRow label="Body" expected={meta.Body || meta.Platform} actual={decoded.family || 'Charger LD'}/>
              <CompatRow label="Engine" expected={meta.Engine} actual={decoded.engine === 'L' ? '6.2L SC HEMI' : decoded.engine}/>
              <CompatRow label="Trim" expected={meta.Program || meta.Calibration} actual={decoded.trim || '?'}/>
            </div>
            {decoded.hp && (
              <div style={{marginTop: 12, padding: 10, borderRadius: 8, background: '#00C85312', border: `1px solid ${C.gn}33`}}>
                <span style={{fontSize: 9, color: C.gn, fontWeight: 800, letterSpacing: 1.4}}>VIN-DERIVED HP RATING:</span>
                <span style={{fontSize: 14, fontWeight: 800, color: C.gn, marginLeft: 8}}>{decoded.hp}</span>
              </div>
            )}
          </Card>
        </Section>
      )}

      <Section title="EBML CONTAINER STRUCTURE" count={sections.length} color={C.a4}>
        <Card>
          <div style={{fontFamily: 'JetBrains Mono', fontSize: 10, color: C.tx}}>
            {sections.slice(0, 24).map((s, i) => (
              <div key={i} style={{padding: '4px 0', borderBottom: i < Math.min(sections.length, 24) - 1 ? `1px dashed ${C.bd}` : 'none', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
                <span style={{color: C.ts}}>@0x{s.offset.toString(16).toUpperCase().padStart(6, '0')}</span>
                <span style={{color: C.a4}}>ID=0x{s.id}</span>
                <span style={{color: C.a3}}>size={s.size}</span>
                {s.label === 'DS' && <Tag color={C.gn}>DS · plaintext</Tag>}
                {s.label === 'FS' && <Tag color={C.wn}>FS · encrypted</Tag>}
                {s.label === 'CO' && <Tag color={C.a3}>CO · checksum</Tag>}
                {s.label === 'UP' && <Tag color={C.er}>UP · payload</Tag>}
                {s.label === 'AL' && <Tag color={C.a4}>AL · builder</Tag>}
              </div>
            ))}
            {sections.length > 24 && <SLine type="warn" msg={`${sections.length - 24} additional sections hidden`}/>}
          </div>
        </Card>
      </Section>

      {efd.payload && (
        <Section title="ENCRYPTED PAYLOAD" color={C.er}>
          <Card>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10}}>
              <Stat label="OFFSET" value={`0x${efd.payload.offset.toString(16).toUpperCase()}`} color={C.a3}/>
              <Stat label="SIZE" value={`${(efd.payload.size / 1024 / 1024).toFixed(2)} MB`} color={C.a1}/>
              <Stat label="ENTROPY" value={efd.payload.entropy.toFixed(3)} color={efd.payload.entropy > 7.9 ? C.er : C.wn}/>
            </div>
            <div style={{marginTop: 12, padding: 10, borderRadius: 8, background: '#FF174410', border: `1px solid ${C.er}33`, fontSize: 11, color: C.tx, lineHeight: 1.6}}>
              <strong style={{color: C.er}}>Note:</strong> Entropy {efd.payload.entropy.toFixed(2)} indicates AES-grade encryption.
              The payload is decrypted by the module bootloader during the `0x36 TransferData` half of the UDS programming
              session. For ECM/PCM: hand it to the ECM Flasher tab for the bench Autel bridge, or use wiTECH 2.0 / AlfaOBD
              with a CarDAQ-Plus or MongoosePro for the full Mopar tool path.
            </div>
          </Card>
        </Section>
      )}
    </div>
  );
}
