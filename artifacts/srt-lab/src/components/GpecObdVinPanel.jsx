import React, {useState, useCallback, useRef} from 'react';
import {Card, Btn} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {initAdapter} from '../lib/initAdapter.js';
import {createBridgeEngine} from '../lib/bridgeEngine.js';
import {isSgwAuthenticated} from '../lib/sgwAuth.js';
import {vinHasSGW} from '../lib/vin.js';
import {getRow} from '../lib/moduleRegistry.js';
import {programVin, readDid} from '../lib/vinProgrammer.js';
import {backupModule} from '../lib/backups.js';
import {useMasterVin} from '../lib/masterVinContext.jsx';
import {ReadFirstModal} from '../lib/readFirstModal.jsx';

/* GpecObdVinPanel — OBD VIN write panel embedded into the GPEC2 and
 * GPEC2A bench tabs (Task: change BOTH original + current VIN over OBD
 * without opening the PCM).
 *
 * The PCM (GPEC2 / GPEC2A) lives at TX 0x7E0 / RX 0x7E8 and stores three
 * VIN copies on the bus:
 *   - F190 = "current VIN" (the one wiTECH and ScanGauge read)
 *   - 7B90 = current-VIN mirror
 *   - 7B88 = "original VIN" copy (the factory-virginization slot)
 *
 * The universal programVin() engine already writes all three when given
 * the ECM registry row (which has the GPEC platform 10-algo unlock chain
 * baked in). This panel surfaces the three slots clearly and drives that
 * engine end-to-end so a tech can rewrite both originals and currents
 * without de-soldering the module.
 *
 * Routing:
 *   - For SGW-protected VINs (2018+ FCA) we route through the J2534
 *     bridge engine, exactly like EcmTab/BcmTab. The user must have run
 *     AUTEL SGW AUTHENTICATE first or have the bench-bypass switch on.
 *   - Everything else uses the local OBD adapter via initAdapter().
 */

const PCM_TX = 0x7E0;
const PCM_RX = 0x7E8;
const VIN_DIDS = [
  {did: 0xF190, label: 'Current VIN',          slot: 'F190', kind: 'current'},
  {did: 0x7B90, label: 'Current VIN (mirror)', slot: '7B90', kind: 'current'},
  {did: 0x7B88, label: 'Original VIN',         slot: '7B88', kind: 'original'},
];

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

export default function GpecObdVinPanel({platform}) {
  // platform is 'GPEC2' or 'GPEC2A' — purely cosmetic; the bus address
  // and unlock chain are identical (the chain in the ECM registry row
  // sweeps both gpec2 and gpec2a algorithms).
  const {vin: masterVin, vinValid: masterVinValid, updateStatus} = useMasterVin();
  const eng = useRef(null);
  const [conn, setConn] = useState(false);
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState([]);
  const [reads, setReads] = useState({}); // did -> {value, ok, raw}
  const [writeResult, setWriteResult] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const addLog = useCallback((m, t = 'info') => {
    const ts = new Date().toLocaleTimeString();
    setLog(p => [...p.slice(-300), {t: ts, m, type: t}]);
  }, []);

  const connect = useCallback(async () => {
    setBusy('Connecting adapter...');
    const e = await initAdapter(addLog, hx);
    if (e) {
      eng.current = e;
      setConn(true);
      addLog(`Connected — ready for ${platform} OBD VIN ops`, 'info');
    }
    setBusy('');
  }, [addLog, platform]);

  const disconnect = useCallback(() => {
    setConn(false);
    eng.current = null;
    setReads({});
    addLog('Disconnected', 'info');
  }, [addLog]);

  // Read all three VIN slots and surface them side-by-side so the tech
  // can SEE both the original and current VINs the PCM is currently
  // holding. We open an extended session first because some GPEC
  // variants gate 7B88 behind 0x10 0x03.
  const readAllVins = useCallback(async () => {
    if (!eng.current) { addLog('Connect first', 'error'); return; }
    setBusy('Reading PCM VIN slots...');
    addLog('═══ READ ALL VIN SLOTS (PCM @ 0x7E0) ═══', 'info');
    await eng.current.uds(PCM_TX, PCM_RX, [0x10, 0x03]);
    const next = {};
    for (const slot of VIN_DIDS) {
      const r = await readDid(eng.current.uds, PCM_TX, PCM_RX, slot.did);
      next[slot.did] = {value: r.value || '', ok: r.ok, raw: r.raw || ''};
      if (r.ok) addLog(`${slot.label} (0x${hx(slot.did, 4)}): ${r.value || '(empty)'}`, 'rx');
      else      addLog(`${slot.label} (0x${hx(slot.did, 4)}): no response`, 'warn');
    }
    setReads(next);
    setBusy('');
  }, [addLog]);

  const writeBoth = useCallback(() => {
    if (!eng.current)            { addLog('Connect first', 'error'); return; }
    if (!masterVinValid)         { addLog('Master VIN must be 17 chars', 'error'); return; }
    setShowConfirm(true);
  }, [masterVinValid, addLog]);

  const executeWrite = useCallback(async (confirmData) => {
    setShowConfirm(false);
    setBusy('Writing PCM VIN (original + current)...');
    setWriteResult(null);
    updateStatus(platform, 'writing');
    addLog(`═══ ${platform} OBD VIN WRITE — original + current ═══`, 'info');
    if (confirmData?.technician) addLog('Technician: ' + confirmData.technician, 'info');
    if (confirmData?.titleRef)   addLog('Title reference: ' + confirmData.titleRef, 'info');

    // SGW gating mirrors EcmTab — if the new VIN is on a 2018+ FCA
    // platform the write must go through the J2534/Autel bridge.
    let activeEng = eng.current;
    if (vinHasSGW(masterVin)) {
      if (!isSgwAuthenticated(masterVin)) {
        addLog('🛑 SGW REQUIRED but not authenticated for this VIN', 'error');
        addLog('Open the AUTEL SGW tab and click AUTHENTICATE SGW first.', 'error');
        updateStatus(platform, 'fail');
        setBusy('');
        return;
      }
      const br = await createBridgeEngine({addLog});
      if (!br.ok) {
        addLog('🛑 SGW REQUIRED but bridge offline: ' + br.error, 'error');
        addLog('Open the AUTEL SGW tab, start j2534_bridge.py, verify the Autel cable, then retry.', 'error');
        updateStatus(platform, 'fail');
        setBusy('');
        return;
      }
      activeEng = br.engine;
    }

    // The ECM registry row carries the 10-algorithm GPEC platform sweep
    // and the [F190, 7B90, 7B88] DID list — programVin will write both
    // the current and original VIN slots in one pass and verify each.
    const row = getRow('ECM');
    const r = await programVin({
      eng: activeEng, row, vin: masterVin,
      addLog: (m, t) => addLog(m, t),
      makeBackup: async ({uds, snapshotKind, preWriteKey}) =>
        backupModule(uds, PCM_TX, PCM_RX, platform, addLog, hx, snapshotKind, preWriteKey),
    });
    setWriteResult(r);
    updateStatus(platform, r.ok ? 'ok' : 'fail');

    // Refresh the on-screen slot table so the user sees the new
    // post-write values without having to click Read All again.
    const next = {};
    for (const slot of VIN_DIDS) {
      const found = r.didResults.find(d => d.did === slot.did);
      if (found) next[slot.did] = {value: found.readback || '', ok: found.match, raw: ''};
    }
    setReads(prev => ({...prev, ...next}));
    setBusy('');
  }, [masterVin, addLog, updateStatus, platform]);

  return (
    <Card data-testid={`gpec-obd-vin-panel-${platform.toLowerCase()}`} style={{marginBottom: 14, padding: 16}}>
      {showConfirm && <ReadFirstModal
        module={platform}
        currentState={[
          {label: 'Module', value: `${platform} PCM @ TX 0x7E0 / RX 0x7E8`},
          {label: 'Current VIN (DID 0xF190)', value: reads[0xF190]?.value || '(not read)'},
          {label: 'Current VIN mirror (DID 0x7B90)', value: reads[0x7B90]?.value || '(not read)'},
          {label: 'Original VIN (DID 0x7B88)', value: reads[0x7B88]?.value || '(not read)'},
          {label: 'Unlock chain', value: '10-algo GPEC sweep (gpec2/2f/2e/3/2a/15/1, ngc, sbec, jtec)'},
        ]}
        newVin={masterVin}
        onConfirm={executeWrite}
        onCancel={() => { setShowConfirm(false); addLog('Write cancelled at confirmation step', 'warn'); }}
      />}

      <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12}}>
        <span style={{fontSize: 18}}>📡</span>
        <div style={{flex: 1}}>
          <div style={{fontWeight: 900, fontSize: 13, letterSpacing: 1.2}}>OBD VIN PROGRAMMER — original + current</div>
          <div style={{fontSize: 10, color: C.tm, marginTop: 2}}>
            No de-soldering. Reads & writes F190 (current), 7B90 (mirror) and 7B88 (original VIN) over the OBD-II port.
          </div>
        </div>
        <span style={{
          fontSize: 10, padding: '4px 10px', borderRadius: 6, fontWeight: 800,
          background: conn ? '#00C85322' : '#FF174422',
          color: conn ? C.gn : C.er,
          border: '1px solid ' + (conn ? C.gn : C.er) + '55',
        }}>{conn ? '● CONNECTED' : '○ DISCONNECTED'}</span>
      </div>

      <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12}}>
        {!conn && <Btn onClick={connect} color={C.a4} disabled={!!busy}>🔌 Connect Adapter</Btn>}
        {conn  && <Btn onClick={disconnect} outline color={C.ts}>Disconnect</Btn>}
        {conn  && <Btn onClick={readAllVins} disabled={!!busy} color={C.a3}>📖 Read All VIN Slots</Btn>}
        {conn  && <Btn onClick={writeBoth} disabled={!!busy || !masterVinValid} color={C.sr}>💾 Write Master VIN (orig + current)</Btn>}
      </div>

      <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10}}>
        {VIN_DIDS.map(slot => {
          const r = reads[slot.did];
          const matchesMaster = r?.value && masterVinValid && r.value === masterVin;
          const isOriginal = slot.kind === 'original';
          return (
            <div
              key={slot.did}
              data-testid={`gpec-vin-slot-${slot.slot}`}
              style={{
                padding: 12,
                borderRadius: 10,
                background: isOriginal ? '#1A0F2A' : C.c2,
                border: '1px solid ' + (isOriginal ? '#7C4DFF55' : C.bd),
                color: isOriginal ? '#fff' : undefined,
              }}>
              <div style={{
                fontSize: 9, fontWeight: 800, letterSpacing: 1.5,
                color: isOriginal ? '#B388FF' : C.tm, marginBottom: 4,
              }}>
                {slot.label} · DID 0x{hx(slot.did, 4)}
              </div>
              <div style={{
                fontFamily: "'JetBrains Mono'", fontSize: 13, fontWeight: 800,
                wordBreak: 'break-all', lineHeight: 1.3,
                color: r?.value ? (matchesMaster ? C.gn : (isOriginal ? '#fff' : C.tx)) : (isOriginal ? '#888' : C.tm),
              }}>
                {r?.value || '(not read)'}
              </div>
              {r?.value && masterVinValid && (
                <div style={{fontSize: 9, marginTop: 4, fontWeight: 700, color: matchesMaster ? C.gn : C.wn}}>
                  {matchesMaster ? '✓ matches Master VIN' : '⚠ differs from Master VIN'}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {writeResult && (
        <div data-testid="gpec-obd-write-result" style={{
          marginTop: 12, padding: 12, borderRadius: 10,
          background: writeResult.ok ? C.gn + '15' : C.er + '15',
          border: '1px solid ' + (writeResult.ok ? C.gn : C.er) + '55',
        }}>
          <div style={{fontWeight: 800, fontSize: 12, color: writeResult.ok ? C.gn : C.er, marginBottom: 6}}>
            {writeResult.ok ? '✓ WRITE COMPLETE — both original and current VIN updated' :
             `✗ WRITE FAILED at step '${writeResult.reason || 'unknown'}'`}
          </div>
          <div style={{fontSize: 10, color: C.ts, fontFamily: "'JetBrains Mono'"}}>
            unlock: {String(writeResult.unlockAlgo)} · before: {writeResult.beforeVin || '(empty)'} · after: {writeResult.afterVin || '(empty)'}
          </div>
          {writeResult.errors?.length > 0 && (
            <div style={{marginTop: 6, fontSize: 10, color: C.er, fontFamily: "'JetBrains Mono'"}}>
              {writeResult.errors.map((e, i) => <div key={i}>• {e}</div>)}
            </div>
          )}
        </div>
      )}

      <div style={{
        marginTop: 12, padding: 10, borderRadius: 8,
        background: '#0D0D15', color: '#E0E0E0',
      }}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
          <span style={{fontSize: 10, fontWeight: 800, color: '#FFB300', letterSpacing: 1.5}}>📋 OBD LOG</span>
          <button onClick={() => setLog([])} style={{fontSize: 9, color: '#666', background: 'transparent', border: '1px solid #333', padding: '2px 8px', borderRadius: 4, cursor: 'pointer'}}>CLEAR</button>
        </div>
        <div style={{maxHeight: 220, overflowY: 'auto', fontFamily: "'JetBrains Mono'", fontSize: 10, lineHeight: 1.5}}>
          {log.length === 0 && <div style={{color: '#666', textAlign: 'center', padding: 12}}>Connect adapter to begin</div>}
          {log.map((l, i) => (
            <div key={i} style={{
              color: l.type === 'error' ? '#FF5252' : l.type === 'rx' ? '#00E676' :
                     l.type === 'tx'    ? '#40C4FF' : l.type === 'warn' ? '#FFB300' : '#AAA',
            }}>
              <span style={{color: '#555'}}>{l.t}</span> {l.m}
            </div>
          ))}
        </div>
      </div>

      {busy && <div style={{marginTop: 8, fontSize: 10, color: C.wn, fontWeight: 700}}>⏳ {busy}</div>}
    </Card>
  );
}
