import React, {useMemo, useState} from "react";
import {Card, Tag, SLine} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {cda6} from '../lib/algos.js';
import {CDA_FLASH_CATALOG, getOfflineFlashSequence} from '../lib/cdaCatalog.js';

// CDA6 UDS programming-session walkthrough (Task #488 + Task #599). The
// step list is now driven by the per-module catalog mined out of the
// cracked CDA SWF (tools/cda-extractor) instead of being hand-coded, so
// the operator can pick a target module (ECM / BCM / RFHUB / SGW / …)
// and see the exact UDS phase ladder the offline-flash mode will walk.
// Seed-to-key calculator below the walkthrough still lets a tester paste
// a `67 01 [SEED]` response and read back the `27 02 [KEY]` request.

// Map catalog phase ids → display rows. The phase ids come straight out
// of cdaFlashSequences.generated.json so any future SWF extraction shows
// up here without further code changes.
const PHASE_PRETTY = {
  session_extended:   {name: 'Diagnostic Session Control',  desc: 'Extended diagnostic session'},
  etiquette_dtc_off:  {name: 'ControlDTCSetting (suppress)',desc: 'Stop DTC logging during flash'},
  etiquette_comm_off: {name: 'CommunicationControl (off)',  desc: 'Silence non-flash bus chatter'},
  session_program:    {name: 'Diagnostic Session Control',  desc: 'Programming session'},
  timing_p2:          {name: 'AccessTimingParameter',       desc: 'Negotiate extended P2 / P2*'},
  seed:               {name: 'SecurityAccess Seed Request', desc: 'Request seed (per module algo)'},
  key:                {name: 'SecurityAccess Send Key',     desc: 'Send computed key', highlight: true},
  erase:              {name: 'RoutineControl (Erase)',      desc: 'Routine 0xFF00 erase block'},
  request_download:   {name: 'Request Download',            desc: 'Setup block transfer'},
  transfer:           {name: 'Transfer Data',               desc: 'Stream payload blocks'},
  transfer_exit:      {name: 'Request Transfer Exit',       desc: 'End block transfer'},
  checksum:           {name: 'RoutineControl (Checksum)',   desc: 'Routine 0xFF01 verify image'},
  reset:              {name: 'ECU Reset',                   desc: 'Hard reset to apply'},
  etiquette_comm_on:  {name: 'CommunicationControl (on)',   desc: 'Restore bus comms'},
  etiquette_dtc_on:   {name: 'ControlDTCSetting (restore)', desc: 'Re-enable DTC logging'},
};

function catalogStepsFor(code){
  const seq = getOfflineFlashSequence(code) || [];
  return seq.map((s, i) => {
    const pp = PHASE_PRETTY[s.phase] || {name: s.swfClass || s.phase, desc: ''};
    return {
      step: i + 1,
      name: pp.name,
      desc: pp.desc || s.swfClass || '',
      service: '0x' + (s.sid || 0).toString(16).toUpperCase().padStart(2, '0'),
      subfn: s.sub != null ? '0x' + s.sub.toString(16).toUpperCase().padStart(2, '0') : '—',
      tx: s.tx,
      expected: s.expects,
      highlight: !!pp.highlight,
      swfClass: s.swfClass,
    };
  });
}

const TOOLS = [
  {name: 'Autel Elite J2534 + bridge', desc: 'Bench-only path. Connect via the local bridge daemon (this app). CDA6, GPEC2A, BCM, RFHUB all driven from here.', cost: '$$ (already owned)'},
  {name: 'wiTECH 2.0 + MicroPod',      desc: 'OEM Mopar tool. TechAuthority sub required. Best for Mopar `.webm` cals on a real vehicle.', cost: '$$$'},
  {name: 'AlfaOBD + CarDAQ-Plus',      desc: 'Independent shop favorite. CDA6 built in, handles GPEC2A flashing.', cost: '$$'},
  {name: 'AlfaOBD + MongoosePro JLR',  desc: 'Cheaper J2534 option. Verify Hellcat/Redeye support before trusting it.', cost: '$'},
];

function Section({title, color, children}){
  const c = color || C.a3;
  return (
    <div style={{marginBottom: 22}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10}}>
        <span style={{fontFamily: 'JetBrains Mono', fontSize: 11, letterSpacing: 3, color: c, fontWeight: 800}}>{title}</span>
        <span style={{flex: 1, height: 1, background: `linear-gradient(to right, ${c}55, transparent)`}}/>
      </div>
      {children}
    </div>
  );
}

export default function Cda6SessionTab(){
  const [seedHex, setSeedHex] = useState('');
  const moduleCodes = useMemo(() => Object.keys(CDA_FLASH_CATALOG?.modules || {}).sort(), []);
  const [moduleCode, setModuleCode] = useState(moduleCodes.includes('ECM') ? 'ECM' : (moduleCodes[0] || 'ECM'));
  const STEPS = useMemo(() => catalogStepsFor(moduleCode), [moduleCode]);
  const modMeta = CDA_FLASH_CATALOG?.modules?.[moduleCode];

  const calc = useMemo(() => {
    const raw = seedHex.replace(/\s/g, '');
    const v = parseInt(raw, 16);
    if (!raw || isNaN(v)) return null;
    return {
      seed: (v >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      key: (cda6(v) >>> 0).toString(16).toUpperCase().padStart(8, '0'),
    };
  }, [seedHex]);

  return (
    <div style={{maxWidth: 980}}>
      <Card>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap'}}>
          <Tag color={C.a3}>UDS SECURITY ACCESS</Tag>
          <span style={{fontSize: 14, fontWeight: 800, color: C.tx, fontFamily: "'Righteous'"}}>CDA6 SESSION HELPER</span>
        </div>
        <div style={{fontSize: 12, color: C.ts, lineHeight: 1.6}}>
          Walk-through for the standard FCA ECM programming session. Use this to verify J2534 trace logs from
          wiTECH/AlfaOBD or to plan your bench flash sequence before pulling the trigger in the ECM Flasher tab.
        </div>
      </Card>

      <Section title="OFFLINE-FLASH MODULE" color={C.gn}>
        <Card>
          <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap'}}>
            <span style={{fontSize: 10, color: C.tm, letterSpacing: 1.4}}>MODULE</span>
            <select
              data-testid="cda-catalog-module"
              value={moduleCode}
              onChange={e => setModuleCode(e.target.value)}
              style={{padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 12}}
            >
              {moduleCodes.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {modMeta && (
              <>
                <Tag color={C.a1}>tx {modMeta.tx}</Tag>
                <Tag color={C.a3}>rx {modMeta.rx}</Tag>
                <Tag color={C.sr}>algo {modMeta.unlockAlgo}</Tag>
              </>
            )}
            <span style={{flex: 1}}/>
            <span style={{fontSize: 9, color: C.ts, fontFamily: 'JetBrains Mono'}}>catalog · CDA SWF sha256 {(CDA_FLASH_CATALOG?._meta?.sha256 || '').slice(0, 12)}…</span>
          </div>
        </Card>
      </Section>

      <Section title="SESSION SEQUENCE" color={C.a3}>
        <Card>
          {STEPS.map(s => (
            <div key={s.step} style={{
              padding: '10px 12px', marginBottom: 6, borderRadius: 10,
              background: s.highlight ? '#FF174410' : C.c2,
              border: `1px solid ${s.highlight ? C.er + '40' : C.bd}`,
              display: 'grid', gridTemplateColumns: '36px 1fr 130px 180px', alignItems: 'center', gap: 10,
            }}>
              <div style={{fontSize: 18, fontWeight: 900, color: s.highlight ? C.er : C.a3, textAlign: 'center', fontFamily: 'JetBrains Mono'}}>{s.step}</div>
              <div>
                <div style={{fontSize: 12, fontWeight: 800, color: C.tx}}>{s.name}</div>
                <div style={{fontSize: 10, color: C.ts, marginTop: 2}}>{s.desc}</div>
              </div>
              <div>
                <div style={{fontSize: 8, color: C.tm, letterSpacing: 1.2}}>SVC / SUB</div>
                <div style={{fontSize: 11, fontFamily: 'JetBrains Mono', color: C.a1, fontWeight: 700}}>{s.service} / {s.subfn}</div>
              </div>
              <div>
                <div style={{fontSize: 8, color: C.tm, letterSpacing: 1.2}}>TX → RX</div>
                <div style={{fontSize: 10, fontFamily: 'JetBrains Mono', color: C.gn}}>{s.tx}</div>
                <div style={{fontSize: 10, fontFamily: 'JetBrains Mono', color: C.a3}}>{s.expected}</div>
              </div>
            </div>
          ))}
        </Card>
      </Section>

      <Section title="STEP 3 · CDA6 KEY CALCULATOR" color={C.sr}>
        <Card>
          <div style={{fontSize: 11, color: C.ts, marginBottom: 8}}>Paste seed bytes from the ECM `67 01 [SEED]` response:</div>
          <input
            data-testid="cda6-seed-input"
            value={seedHex}
            onChange={e => setSeedHex(e.target.value.toUpperCase().replace(/[^A-F0-9\s]/g, ''))}
            placeholder="A1 B2 C3 D4"
            style={{width: '100%', padding: 12, borderRadius: 10, border: `2px solid ${C.bd}`, background: C.c2, color: C.tx, fontSize: 18, fontWeight: 700, letterSpacing: 4, textAlign: 'center', outline: 'none', fontFamily: 'JetBrains Mono'}}
          />
          {calc && (
            <div style={{marginTop: 12, padding: 12, borderRadius: 10, background: C.c2, border: `1px solid ${C.bd}`}}>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 30px 1fr', alignItems: 'center'}}>
                <div>
                  <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2}}>SEED (FROM ECM)</div>
                  <div style={{fontSize: 22, fontWeight: 800, color: C.a3, fontFamily: 'JetBrains Mono'}}>{calc.seed}</div>
                </div>
                <div style={{textAlign: 'center', color: C.tm, fontSize: 18}}>→</div>
                <div>
                  <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2}}>KEY (CDA6)</div>
                  <div data-testid="cda6-key-output" style={{fontSize: 22, fontWeight: 800, color: C.sr, fontFamily: 'JetBrains Mono'}}>{calc.key}</div>
                </div>
              </div>
              <div style={{marginTop: 10, padding: '8px 10px', borderRadius: 8, background: '#00C85312', fontSize: 11, color: C.gn, fontFamily: 'JetBrains Mono'}}>
                Send: 27 02 {calc.key.match(/.{2}/g).join(' ')}
              </div>
            </div>
          )}
          {!calc && <SLine type="warn" msg="Awaiting seed bytes"/>}
        </Card>
      </Section>

      <Section title="COMPATIBLE TOOLS" color={C.gn}>
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10}}>
          {TOOLS.map((t, i) => (
            <Card key={i}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8}}>
                <div style={{fontSize: 13, fontWeight: 800, color: C.tx}}>{t.name}</div>
                <Tag color={C.gn}>{t.cost}</Tag>
              </div>
              <div style={{fontSize: 11, color: C.ts, marginTop: 6, lineHeight: 1.5}}>{t.desc}</div>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}
