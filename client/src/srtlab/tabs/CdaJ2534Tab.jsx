/**
 * CDA J2534 Diagnostic Tab
 * Ported from CDAJ2534 (Python/PySide6) to React/SRT Lab.
 *
 * Layout mirrors the original CDA desktop app:
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │  ADAPTER PANEL  (top bar — bridge URL, connect/disconnect)       │
 *  ├──────────────────────┬───────────────────────────────────────────┤
 *  │  ECU LIST (left)     │  WORKSPACE TABS (right)                   │
 *  │  22 FCA modules      │  Read Data · DTCs · Routines ·            │
 *  │  scan / identify     │  ECU Unlock · Calibration                 │
 *  ├──────────────────────┴───────────────────────────────────────────┤
 *  │  UDS LOG (bottom — live scrolling frame log)                     │
 *  └──────────────────────────────────────────────────────────────────┘
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  getStatus, open as openBridge, connect as bridgeConnect,
  disconnect as bridgeDisconnect, setFilter, sendMsg, readMsg,
  getAutelState, setAutelState,
} from '../lib/bridgeClient.js';
import { CDA_MODULES } from '../lib/cdaModuleMap.js';
import { getProfileForEcu } from '../lib/cdaProfiles.js';
import { trpc } from '../../lib/trpc';

/* ─── Design tokens (match App.jsx palette) ─────────────────────────── */
const C = {
  bg:  '#F4F1EC', cd: '#FFF',    c2: '#FAF9F7',
  bk:  '#1A1A1A', a1: '#FF6D00', a2: '#00BFA5',
  a3:  '#2979FF', a4: '#AA00FF', tx: '#1A1A1A',
  ts:  '#5A5A5A', tm: '#9E9E9E', bd: '#E8E4DE',
  gn:  '#00C853', wn: '#FFB300', er: '#FF1744',
  dk:  '#141414', dk2:'#1E1E1E', dk3:'#252525',
};

/* ─── UDS helpers ────────────────────────────────────────────────────── */
async function udsRequest(hexStr, tx, rx, url, timeoutMs = 2000) {
  await setFilter({ txId: tx, rxId: rx }, url);
  const sm = await sendMsg({ txId: tx, data: hexStr, flags: 0x40, timeoutMs: 1000 }, url);
  if (!sm?.ok) return { ok: false, raw: sm?.error || 'sendMsg failed' };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await readMsg({ timeoutMs: Math.min(300, deadline - Date.now()) }, url);
    if (!r?.ok) break;
    if (r.data) return { ok: true, raw: r.data };
  }
  return { ok: false, raw: 'timeout' };
}

function hexToAscii(hex) {
  try {
    return hex.replace(/\s/g, '').match(/.{2}/g)
      .map(b => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; })
      .join('');
  } catch { return ''; }
}

function parseNrc(hex) {
  const bytes = hex.replace(/\s/g, '').match(/.{2}/g) || [];
  if (bytes[0] === '7F' && bytes[2]) {
    const nrc = bytes[2].toUpperCase();
    const NRC_MAP = {
      '10': 'General Reject', '11': 'Service Not Supported',
      '12': 'Sub-function Not Supported', '13': 'Incorrect Message Length',
      '14': 'Response Too Long', '21': 'Busy Repeat Request',
      '22': 'Conditions Not Correct', '24': 'Request Sequence Error',
      '25': 'No Response From Sub-net Component', '26': 'Failure Prevents Execution',
      '31': 'Request Out Of Range', '33': 'Security Access Denied',
      '35': 'Invalid Key', '36': 'Exceeded Number Of Attempts',
      '37': 'Required Time Delay Not Expired', '70': 'Upload/Download Not Accepted',
      '71': 'Transfer Data Suspended', '72': 'General Programming Failure',
      '73': 'Wrong Block Sequence Counter', '78': 'Request Correctly Received - Response Pending',
      '7E': 'Sub-function Not Supported In Active Session',
      '7F': 'Service Not Supported In Active Session',
    };
    return `NRC 0x${nrc}: ${NRC_MAP[nrc] || 'Unknown'}`;
  }
  return null;
}

/* ─── Seed-key algorithms (mirrors CDAJ2534 security parser) ─────────── */
function computeKey(seed, algo) {
  const s = parseInt(seed, 16);
  if (isNaN(s)) return null;
  switch (algo) {
    case 'cda6': {
      // CDA6 BCM/ABS/IPC — XOR with constant
      const k = s ^ 0x8F4B2E1A;
      return k.toString(16).padStart(8, '0').toUpperCase();
    }
    case 'gpec2a': {
      const k = ((s ^ 0xE72E3799) >>> 0);
      return k.toString(16).padStart(8, '0').toUpperCase();
    }
    case 'gpec2': {
      const k = ((s ^ 0x966AEEB1) >>> 0);
      return k.toString(16).padStart(8, '0').toUpperCase();
    }
    case 't80': {
      // TIPM 0x80
      const k = ((s ^ 0x1A3C5E7F) >>> 0);
      return k.toString(16).padStart(8, '0').toUpperCase();
    }
    default:
      return null;
  }
}

/* ─── Tiny UI primitives ─────────────────────────────────────────────── */
const Btn = ({ onClick, color = C.a1, disabled, children, small, outline }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      background: outline ? 'transparent' : color,
      color: outline ? color : '#fff',
      border: `1.5px solid ${color}`,
      borderRadius: 6,
      padding: small ? '4px 10px' : '7px 16px',
      fontSize: small ? 11 : 12,
      fontWeight: 700,
      fontFamily: 'JetBrains Mono, monospace',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      letterSpacing: 0.5,
      transition: 'all 0.15s',
    }}
  >{children}</button>
);

const Badge = ({ color, children }) => (
  <span style={{
    background: color + '22',
    color,
    border: `1px solid ${color}55`,
    borderRadius: 4,
    padding: '2px 7px',
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'JetBrains Mono, monospace',
    letterSpacing: 0.5,
  }}>{children}</span>
);

const MonoField = ({ label, value, color = C.a2 }) => (
  <div style={{ marginBottom: 8 }}>
    {label && <div style={{ fontSize: 10, color: C.tm, fontWeight: 700, marginBottom: 2, letterSpacing: 0.5 }}>{label}</div>}
    <div style={{
      background: C.dk, color, fontFamily: 'JetBrains Mono, monospace',
      fontSize: 12, padding: '6px 10px', borderRadius: 5,
      wordBreak: 'break-all', minHeight: 28,
    }}>{value || <span style={{ color: C.tm }}>—</span>}</div>
  </div>
);

/* ─── Adapter Panel ──────────────────────────────────────────────────── */
function AdapterPanel({ bridgeUrl, setBridgeUrl, connected, onConnect, onDisconnect, status }) {
  return (
    <div style={{
      background: C.dk2, borderBottom: `1px solid #333`,
      padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    }}>
      <div style={{ fontWeight: 900, fontSize: 13, color: C.a1, letterSpacing: 1.5, fontFamily: 'JetBrains Mono, monospace' }}>
        CDA J2534
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 260 }}>
        <span style={{ fontSize: 10, color: C.tm, fontWeight: 700 }}>BRIDGE URL</span>
        <input
          value={bridgeUrl}
          onChange={e => setBridgeUrl(e.target.value)}
          style={{
            background: '#111', color: C.a2, border: `1px solid #333`,
            borderRadius: 5, padding: '5px 10px', fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace', width: 220,
          }}
          placeholder="http://localhost:8765"
        />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {connected
          ? <Btn color={C.er} onClick={onDisconnect} small>DISCONNECT</Btn>
          : <Btn color={C.gn} onClick={onConnect} small>CONNECT</Btn>
        }
        <Badge color={connected ? C.gn : C.tm}>{connected ? '● LIVE' : '○ OFFLINE'}</Badge>
      </div>
      {status && (
        <div style={{ fontSize: 10, color: C.tm, fontFamily: 'JetBrains Mono, monospace', marginLeft: 'auto' }}>
          {status}
        </div>
      )}
    </div>
  );
}

/* ─── ECU List ───────────────────────────────────────────────────────── */
const SCAN_STATES = { idle: '—', pending: '⏳', ok: '✅', no_resp: '❌', error: '⚠️' };

function EcuList({ selected, onSelect, scanStates, onScan, onScanAll, connected }) {
  return (
    <div style={{
      width: 220, minWidth: 180, background: C.dk2, borderRight: `1px solid #2a2a2a`,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 12px', borderBottom: `1px solid #2a2a2a`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, fontWeight: 900, color: C.a3, letterSpacing: 1 }}>ECU LIST</span>
        <Btn small color={C.a3} disabled={!connected} onClick={onScanAll}>SCAN ALL</Btn>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {CDA_MODULES.map(mod => {
          const state = scanStates[mod.name] || 'idle';
          const isSelected = selected?.name === mod.name;
          return (
            <div
              key={mod.name}
              onClick={() => onSelect(mod)}
              style={{
                padding: '8px 12px', cursor: 'pointer',
                background: isSelected ? C.a3 + '22' : 'transparent',
                borderLeft: `3px solid ${isSelected ? C.a3 : 'transparent'}`,
                borderBottom: `1px solid #1a1a1a`,
                display: 'flex', alignItems: 'center', gap: 8,
                transition: 'background 0.1s',
              }}
            >
              <span style={{ fontSize: 14 }}>{mod.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: isSelected ? C.a3 : '#ddd', letterSpacing: 0.3 }}>
                  {mod.name}
                </div>
                <div style={{ fontSize: 9, color: C.tm, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {`0x${mod.tx.toString(16).toUpperCase()}`}
                </div>
              </div>
              <span style={{ fontSize: 12 }}>{SCAN_STATES[state]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Read Data Tab ──────────────────────────────────────────────────── */
function ReadDataTab({ module, profile, connected, bridgeUrl, onLog }) {
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(false);
  const [runningDid, setRunningDid] = useState(null);

  const readDid = useCallback(async (svc) => {
    if (!connected || !module) return;
    setRunningDid(svc.name);
    const tx = `0x${module.tx.toString(16)}`;
    const rx = `0x${module.rx.toString(16)}`;
    const r = await udsRequest(svc.request, tx, rx, bridgeUrl);
    onLog({ dir: 'TX', hex: svc.request, label: svc.name });
    onLog({ dir: r.ok ? 'RX' : 'ERR', hex: r.raw, label: svc.name });
    setResults(prev => ({
      ...prev,
      [svc.name]: {
        ok: r.ok,
        raw: r.raw,
        ascii: r.ok ? hexToAscii(r.raw) : '',
        nrc: r.ok ? null : parseNrc(r.raw),
      },
    }));
    setRunningDid(null);
  }, [connected, module, bridgeUrl, onLog]);

  const readAll = useCallback(async () => {
    if (!profile || !connected) return;
    setRunning(true);
    const readServices = profile.services.filter(s => s.type === 'read_did');
    for (const svc of readServices) {
      await readDid(svc);
    }
    setRunning(false);
  }, [profile, connected, readDid]);

  if (!module) return (
    <div style={{ padding: 32, color: C.tm, textAlign: 'center', fontSize: 12 }}>
      Select a module from the ECU list to begin.
    </div>
  );

  const readServices = profile?.services?.filter(s => s.type === 'read_did') || [];

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 16 }}>{module.icon}</span>
        <span style={{ fontWeight: 900, fontSize: 13, color: '#eee' }}>{module.display}</span>
        <Badge color={C.a3}>{`TX 0x${module.tx.toString(16).toUpperCase()}`}</Badge>
        <Badge color={C.a2}>{`RX 0x${module.rx.toString(16).toUpperCase()}`}</Badge>
        <div style={{ marginLeft: 'auto' }}>
          <Btn color={C.a2} disabled={!connected || running} onClick={readAll} small>
            {running ? 'READING...' : 'READ ALL'}
          </Btn>
        </div>
      </div>

      {readServices.length === 0 && (
        <div style={{ color: C.tm, fontSize: 11 }}>No read_did services in profile for {module.name}.</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {readServices.map(svc => {
          const res = results[svc.name];
          return (
            <div key={svc.name} style={{
              background: C.dk3, borderRadius: 7, padding: '10px 12px',
              border: `1px solid ${res?.ok === false ? C.er + '44' : res?.ok ? C.gn + '33' : '#2a2a2a'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: C.tm, letterSpacing: 0.5 }}>
                  {svc.did || '—'}
                </span>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#ddd', flex: 1 }}>{svc.name}</span>
                <Btn small outline color={C.a3} disabled={!connected || runningDid === svc.name} onClick={() => readDid(svc)}>
                  {runningDid === svc.name ? '...' : 'READ'}
                </Btn>
              </div>
              {res ? (
                res.ok ? (
                  <>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: C.a2, wordBreak: 'break-all' }}>
                      {res.raw}
                    </div>
                    {res.ascii && (
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: C.wn, marginTop: 2 }}>
                        {res.ascii}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 10, color: C.er }}>{res.nrc || res.raw}</div>
                )
              ) : (
                <div style={{ fontSize: 10, color: C.tm }}>—</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── DTCs Tab ───────────────────────────────────────────────────────── */
function DtcsTab({ module, connected, bridgeUrl, onLog }) {
  const [dtcs, setDtcs] = useState(null);
  const [reading, setReading] = useState(false);
  const [clearing, setClearing] = useState(false);

  const readDtcs = useCallback(async () => {
    if (!connected || !module) return;
    setReading(true);
    const tx = `0x${module.tx.toString(16)}`;
    const rx = `0x${module.rx.toString(16)}`;
    onLog({ dir: 'TX', hex: '19 02 08', label: 'Read DTCs' });
    const r = await udsRequest('19 02 08', tx, rx, bridgeUrl, 3000);
    onLog({ dir: r.ok ? 'RX' : 'ERR', hex: r.raw, label: 'Read DTCs' });
    if (r.ok) {
      // Parse DTC list from response bytes
      const bytes = r.raw.replace(/\s/g, '').match(/.{2}/g) || [];
      // Response: 59 02 FF [DTC1_B1 DTC1_B2 DTC1_B3 STATUS] ...
      const parsed = [];
      if (bytes[0] === '59' && bytes[1] === '02') {
        for (let i = 3; i + 3 < bytes.length; i += 4) {
          const code = `${bytes[i]}${bytes[i+1]}${bytes[i+2]}`.toUpperCase();
          const status = parseInt(bytes[i+3], 16);
          parsed.push({ code, status: `0x${bytes[i+3].toUpperCase()}`, active: !!(status & 0x01) });
        }
      }
      setDtcs(parsed);
    } else {
      setDtcs([]);
    }
    setReading(false);
  }, [connected, module, bridgeUrl, onLog]);

  const clearDtcs = useCallback(async () => {
    if (!connected || !module) return;
    setClearing(true);
    const tx = `0x${module.tx.toString(16)}`;
    const rx = `0x${module.rx.toString(16)}`;
    onLog({ dir: 'TX', hex: '14 FF FF FF', label: 'Clear DTCs' });
    const r = await udsRequest('14 FF FF FF', tx, rx, bridgeUrl);
    onLog({ dir: r.ok ? 'RX' : 'ERR', hex: r.raw, label: 'Clear DTCs' });
    if (r.ok) setDtcs([]);
    setClearing(false);
  }, [connected, module, bridgeUrl, onLog]);

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <Btn color={C.a2} disabled={!connected || reading} onClick={readDtcs} small>
          {reading ? 'READING...' : 'READ DTCs'}
        </Btn>
        <Btn color={C.er} disabled={!connected || clearing || !dtcs?.length} onClick={clearDtcs} small>
          {clearing ? 'CLEARING...' : 'CLEAR DTCs'}
        </Btn>
        {dtcs !== null && (
          <Badge color={dtcs.length ? C.er : C.gn}>
            {dtcs.length ? `${dtcs.length} DTC${dtcs.length > 1 ? 's' : ''}` : 'NO DTCs'}
          </Badge>
        )}
      </div>

      {dtcs === null && (
        <div style={{ color: C.tm, fontSize: 11 }}>Press READ DTCs to query the module.</div>
      )}

      {dtcs !== null && dtcs.length === 0 && (
        <div style={{ color: C.gn, fontSize: 12, fontWeight: 700 }}>✅ No DTCs stored.</div>
      )}

      {dtcs?.map((d, i) => (
        <div key={i} style={{
          background: C.dk3, borderRadius: 6, padding: '8px 12px', marginBottom: 6,
          border: `1px solid ${d.active ? C.er + '55' : '#2a2a2a'}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Badge color={d.active ? C.er : C.wn}>{d.active ? 'ACTIVE' : 'STORED'}</Badge>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#eee', fontWeight: 700 }}>
            {d.code}
          </span>
          <span style={{ fontSize: 10, color: C.tm }}>Status: {d.status}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Routines Tab ───────────────────────────────────────────────────── */
function RoutinesTab({ module, profile, connected, bridgeUrl, onLog }) {
  const [customHex, setCustomHex] = useState('31 01 ');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);

  const routineServices = profile?.services?.filter(s => s.type === 'routine') || [];

  const runRoutine = useCallback(async (hexStr, label) => {
    if (!connected || !module) return;
    setRunning(true);
    const tx = `0x${module.tx.toString(16)}`;
    const rx = `0x${module.rx.toString(16)}`;
    onLog({ dir: 'TX', hex: hexStr, label });
    const r = await udsRequest(hexStr, tx, rx, bridgeUrl, 5000);
    onLog({ dir: r.ok ? 'RX' : 'ERR', hex: r.raw, label });
    setResult({ label, ok: r.ok, raw: r.raw, nrc: r.ok ? null : parseNrc(r.raw) });
    setRunning(false);
  }, [connected, module, bridgeUrl, onLog]);

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.tm, marginBottom: 6, letterSpacing: 0.5 }}>
          PROFILE ROUTINES
        </div>
        {routineServices.length === 0 && (
          <div style={{ fontSize: 11, color: C.tm }}>No routines in profile for {module?.name || '—'}.</div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {routineServices.map(svc => (
            <Btn key={svc.name} small color={C.a4} disabled={!connected || running}
              onClick={() => runRoutine(svc.request, svc.name)}>
              {svc.name}
            </Btn>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.tm, marginBottom: 6, letterSpacing: 0.5 }}>
          CUSTOM ROUTINE
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={customHex}
            onChange={e => setCustomHex(e.target.value)}
            style={{
              background: '#111', color: C.a2, border: `1px solid #333`,
              borderRadius: 5, padding: '6px 10px', fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace', flex: 1,
            }}
            placeholder="31 01 XX XX"
          />
          <Btn color={C.a4} disabled={!connected || running} onClick={() => runRoutine(customHex.trim(), 'Custom')}>
            {running ? '...' : 'RUN'}
          </Btn>
        </div>
      </div>

      {result && (
        <div style={{
          background: C.dk3, borderRadius: 7, padding: '10px 12px',
          border: `1px solid ${result.ok ? C.gn + '44' : C.er + '44'}`,
        }}>
          <div style={{ fontSize: 10, color: C.tm, marginBottom: 4 }}>{result.label}</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: result.ok ? C.gn : C.er }}>
            {result.ok ? result.raw : (result.nrc || result.raw)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── ECU Unlock Tab ─────────────────────────────────────────────────── */
function EcuUnlockTab({ module, connected, bridgeUrl, onLog }) {
  const [level, setLevel] = useState('01');
  const [seed, setSeed] = useState('');
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [sending, setSending] = useState(false);

  const LEVELS = ['01', '03', '05', '07', '09', '11'];

  const requestSeed = useCallback(async () => {
    if (!connected || !module) return;
    setRequesting(true);
    setSeed(''); setKey(''); setStatus('');
    const tx = `0x${module.tx.toString(16)}`;
    const rx = `0x${module.rx.toString(16)}`;
    const reqHex = `27 ${level}`;
    onLog({ dir: 'TX', hex: reqHex, label: `Seed Lvl ${level}` });
    const r = await udsRequest(reqHex, tx, rx, bridgeUrl);
    onLog({ dir: r.ok ? 'RX' : 'ERR', hex: r.raw, label: `Seed Lvl ${level}` });
    if (r.ok) {
      const bytes = r.raw.replace(/\s/g, '').match(/.{2}/g) || [];
      // 67 XX [seed bytes]
      if (bytes[0] === '67') {
        const seedHex = bytes.slice(2).join('').toUpperCase();
        setSeed(seedHex);
        // Auto-compute key if algo is known
        const computed = computeKey(seedHex, module.algo);
        if (computed) {
          setKey(computed);
          setStatus(`Auto-computed key for algo: ${module.algo}`);
        } else {
          setStatus(`Algo "${module.algo}" — enter key manually`);
        }
      } else {
        setStatus('Unexpected response: ' + r.raw);
      }
    } else {
      setStatus('Error: ' + (parseNrc(r.raw) || r.raw));
    }
    setRequesting(false);
  }, [connected, module, bridgeUrl, onLog, level]);

  const sendKey = useCallback(async () => {
    if (!connected || !module || !key) return;
    setSending(true);
    const tx = `0x${module.tx.toString(16)}`;
    const rx = `0x${module.rx.toString(16)}`;
    const keyLevel = (parseInt(level, 16) + 1).toString(16).padStart(2, '0').toUpperCase();
    const keyBytes = key.replace(/\s/g, '').match(/.{2}/g)?.join(' ') || key;
    const reqHex = `27 ${keyLevel} ${keyBytes}`;
    onLog({ dir: 'TX', hex: reqHex, label: `Send Key Lvl ${keyLevel}` });
    const r = await udsRequest(reqHex, tx, rx, bridgeUrl);
    onLog({ dir: r.ok ? 'RX' : 'ERR', hex: r.raw, label: `Send Key Lvl ${keyLevel}` });
    if (r.ok) {
      const bytes = r.raw.replace(/\s/g, '').match(/.{2}/g) || [];
      if (bytes[0] === '67') {
        setStatus('✅ UNLOCKED — Security access granted');
      } else {
        setStatus('Response: ' + r.raw);
      }
    } else {
      setStatus('❌ ' + (parseNrc(r.raw) || r.raw));
    }
    setSending(false);
  }, [connected, module, bridgeUrl, onLog, level, key]);

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.tm, marginBottom: 6, letterSpacing: 0.5 }}>
          SECURITY LEVEL
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {LEVELS.map(l => (
            <button key={l}
              onClick={() => setLevel(l)}
              style={{
                background: level === l ? C.a4 : 'transparent',
                color: level === l ? '#fff' : C.tm,
                border: `1.5px solid ${level === l ? C.a4 : '#333'}`,
                borderRadius: 5, padding: '4px 12px', fontSize: 11,
                fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer', fontWeight: 700,
              }}
            >Lvl {l}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Btn color={C.a4} disabled={!connected || requesting} onClick={requestSeed} small>
          {requesting ? 'REQUESTING...' : 'REQUEST SEED'}
        </Btn>
        <Btn color={C.gn} disabled={!connected || sending || !key} onClick={sendKey} small>
          {sending ? 'SENDING...' : 'SEND KEY'}
        </Btn>
      </div>

      <MonoField label="SEED" value={seed} color={C.wn} />

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: C.tm, fontWeight: 700, marginBottom: 2, letterSpacing: 0.5 }}>KEY</div>
        <input
          value={key}
          onChange={e => setKey(e.target.value.toUpperCase())}
          style={{
            background: C.dk, color: C.gn, fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12, padding: '6px 10px', borderRadius: 5, width: '100%',
            border: `1px solid ${key ? C.gn + '55' : '#333'}`, boxSizing: 'border-box',
          }}
          placeholder="Enter or auto-computed key"
        />
      </div>

      {status && (
        <div style={{
          marginTop: 10, padding: '8px 12px', borderRadius: 6,
          background: status.includes('✅') ? C.gn + '22' : status.includes('❌') ? C.er + '22' : C.dk3,
          border: `1px solid ${status.includes('✅') ? C.gn + '55' : status.includes('❌') ? C.er + '55' : '#333'}`,
          fontSize: 11, color: status.includes('✅') ? C.gn : status.includes('❌') ? C.er : C.tm,
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {status}
        </div>
      )}

      {module?.algo && (
        <div style={{ marginTop: 12, fontSize: 10, color: C.tm }}>
          Module algo: <span style={{ color: C.a4, fontWeight: 700 }}>{module.algo}</span>
          {computeKey('00000000', module.algo) !== null
            ? ' — auto-compute supported'
            : ' — manual key entry required'}
        </div>
      )}
    </div>
  );
}

/* ─── Calibration Tab ────────────────────────────────────────────────── */
function CalibrationTab({ module, profile, connected, bridgeUrl, onLog }) {
  const [writeField, setWriteField] = useState('');
  const [writeData, setWriteData] = useState('');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);

  const writeServices = profile?.services?.filter(s => s.type === 'write_did') || [];

  const writeVin = useCallback(async (svc) => {
    if (!connected || !module || !writeData) return;
    setRunning(true);
    const tx = `0x${module.tx.toString(16)}`;
    const rx = `0x${module.rx.toString(16)}`;
    // First: extended session
    onLog({ dir: 'TX', hex: '10 03', label: 'Extended Session' });
    await udsRequest('10 03', tx, rx, bridgeUrl);
    // Then: write DID
    const dataBytes = writeData.replace(/\s/g, '').match(/.{2}/g)?.join(' ') || writeData;
    const reqHex = `${svc.request} ${dataBytes}`;
    onLog({ dir: 'TX', hex: reqHex, label: svc.name });
    const r = await udsRequest(reqHex, tx, rx, bridgeUrl, 5000);
    onLog({ dir: r.ok ? 'RX' : 'ERR', hex: r.raw, label: svc.name });
    setResult({ label: svc.name, ok: r.ok, raw: r.raw, nrc: r.ok ? null : parseNrc(r.raw) });
    setRunning(false);
  }, [connected, module, bridgeUrl, onLog, writeData]);

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.tm, marginBottom: 6, letterSpacing: 0.5 }}>
          WRITE DATA
        </div>
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: C.tm, marginBottom: 2 }}>DATA (hex bytes)</div>
          <input
            value={writeData}
            onChange={e => setWriteData(e.target.value.toUpperCase())}
            style={{
              background: '#111', color: C.a2, border: `1px solid #333`,
              borderRadius: 5, padding: '6px 10px', fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace', width: '100%', boxSizing: 'border-box',
            }}
            placeholder="e.g. 31 43 48 52 59 53 4C 45 52 ..."
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {writeServices.map(svc => (
            <Btn key={svc.name} small color={C.wn} disabled={!connected || running || !writeData}
              onClick={() => writeVin(svc)}>
              {svc.name}
            </Btn>
          ))}
        </div>
        {writeServices.length === 0 && (
          <div style={{ fontSize: 11, color: C.tm }}>No write_did services in profile for {module?.name || '—'}.</div>
        )}
      </div>

      {result && (
        <div style={{
          background: C.dk3, borderRadius: 7, padding: '10px 12px',
          border: `1px solid ${result.ok ? C.gn + '44' : C.er + '44'}`,
        }}>
          <div style={{ fontSize: 10, color: C.tm, marginBottom: 4 }}>{result.label}</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: result.ok ? C.gn : C.er }}>
            {result.ok ? '✅ ' + result.raw : '❌ ' + (result.nrc || result.raw)}
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, padding: '10px 12px', background: C.dk3, borderRadius: 7, border: `1px solid #2a2a2a` }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: C.wn, marginBottom: 4 }}>⚠️ CALIBRATION WARNING</div>
        <div style={{ fontSize: 10, color: C.tm, lineHeight: 1.6 }}>
          Write operations require extended session (10 03) and security access. Incorrect writes can brick the module.
          Always verify data before writing. Security level requirements are shown in the profile.
        </div>
      </div>
    </div>
  );
}

/* ─── UDS Log ────────────────────────────────────────────────────────── */
function UdsLog({ entries, onClear }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries]);

  return (
    <div style={{
      height: 160, background: C.dk, borderTop: `1px solid #2a2a2a`,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '5px 12px', borderBottom: `1px solid #1a1a1a`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 10, fontWeight: 900, color: C.tm, letterSpacing: 1 }}>UDS LOG</span>
        <Btn small outline color={C.tm} onClick={onClear}>CLEAR</Btn>
      </div>
      <div ref={ref} style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>
        {entries.length === 0 && (
          <div style={{ fontSize: 10, color: C.tm, paddingTop: 6 }}>No frames yet.</div>
        )}
        {entries.map((e, i) => (
          <div key={i} style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
            color: e.dir === 'TX' ? C.a3 : e.dir === 'RX' ? C.gn : C.er,
            marginBottom: 1,
          }}>
            <span style={{ color: C.tm, marginRight: 6 }}>{e.t}</span>
            <span style={{ marginRight: 8 }}>[{e.dir}]</span>
            <span style={{ color: '#ddd', marginRight: 8 }}>{e.hex}</span>
            {e.label && <span style={{ color: C.tm }}>// {e.label}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Session History Panel ──────────────────────────────────────────── */
function SessionHistoryPanel({ onClose }) {
  const { data: sessions, isLoading } = trpc.cdaj2534.listSessions.useQuery();

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 340,
      background: C.dk2, borderLeft: `1px solid #2a2a2a`, zIndex: 10,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid #2a2a2a`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, fontWeight: 900, color: C.a3, letterSpacing: 1 }}>SESSION HISTORY</span>
        <Btn small outline color={C.tm} onClick={onClose}>✕</Btn>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {isLoading && <div style={{ color: C.tm, fontSize: 11 }}>Loading...</div>}
        {sessions?.length === 0 && <div style={{ color: C.tm, fontSize: 11 }}>No sessions saved yet.</div>}
        {sessions?.map(s => (
          <div key={s.id} style={{
            background: C.dk3, borderRadius: 6, padding: '8px 10px', marginBottom: 6,
            border: `1px solid ${s.outcome === 'ok' ? C.gn + '33' : s.outcome === 'error' ? C.er + '33' : '#2a2a2a'}`,
          }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <Badge color={s.outcome === 'ok' ? C.gn : s.outcome === 'error' ? C.er : C.wn}>
                {s.outcome.toUpperCase()}
              </Badge>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#ddd' }}>{s.moduleName}</span>
            </div>
            <div style={{ fontSize: 9, color: C.tm, fontFamily: 'JetBrains Mono, monospace' }}>
              TX {s.txId} · RX {s.rxId}
            </div>
            <div style={{ fontSize: 9, color: C.tm }}>
              {new Date(s.createdAt).toLocaleString()}
            </div>
            {s.adapterName && (
              <div style={{ fontSize: 9, color: C.tm }}>Adapter: {s.adapterName}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Main Tab ───────────────────────────────────────────────────────── */
const WORKSPACE_TABS_CDA = [
  { id: 'readdata',   label: 'READ DATA',   icon: '📊' },
  { id: 'dtcs',       label: 'DTCs',        icon: '⚠️' },
  { id: 'routines',   label: 'ROUTINES',    icon: '⚙️' },
  { id: 'unlock',     label: 'ECU UNLOCK',  icon: '🔓' },
  { id: 'calibration',label: 'CALIBRATION', icon: '✏️' },
];

export default function CdaJ2534Tab() {
  const [bridgeUrl, setBridgeUrl] = useState(() => getAutelState().url || 'http://localhost:8765');
  const [connected, setConnected] = useState(false);
  const [adapterStatus, setAdapterStatus] = useState('');
  const [selectedModule, setSelectedModule] = useState(null);
  const [scanStates, setScanStates] = useState({});
  const [activeTab, setActiveTab] = useState('readdata');
  const [logEntries, setLogEntries] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  const saveSession = trpc.cdaj2534.saveSession.useMutation();

  const addLog = useCallback((entry) => {
    setLogEntries(prev => [...prev.slice(-499), {
      ...entry,
      t: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }]);
  }, []);

  const profile = selectedModule ? getProfileForEcu(selectedModule.name) : null;

  /* Connect / disconnect */
  const handleConnect = useCallback(async () => {
    setAdapterStatus('Opening bridge...');
    const openRes = await openBridge(bridgeUrl);
    if (!openRes?.ok) { setAdapterStatus('Bridge open failed: ' + (openRes?.error || 'no response')); return; }
    const connRes = await bridgeConnect({ protocol: 'ISO15765', baudrate: 500000 }, bridgeUrl);
    if (!connRes?.ok) { setAdapterStatus('Connect failed: ' + (connRes?.error || 'no response')); return; }
    setConnected(true);
    setAdapterStatus('Connected · ' + bridgeUrl);
    setAutelState({ url: bridgeUrl });
    addLog({ dir: 'TX', hex: '—', label: `Connected to ${bridgeUrl}` });
  }, [bridgeUrl, addLog]);

  const handleDisconnect = useCallback(async () => {
    await bridgeDisconnect(bridgeUrl);
    setConnected(false);
    setAdapterStatus('Disconnected');
    addLog({ dir: 'ERR', hex: '—', label: 'Disconnected' });
  }, [bridgeUrl, addLog]);

  /* Scan single module */
  const scanModule = useCallback(async (mod) => {
    if (!connected) return;
    setScanStates(prev => ({ ...prev, [mod.name]: 'pending' }));
    const tx = `0x${mod.tx.toString(16)}`;
    const rx = `0x${mod.rx.toString(16)}`;
    addLog({ dir: 'TX', hex: '10 01', label: `Scan ${mod.name}` });
    const r = await udsRequest('10 01', tx, rx, bridgeUrl, 1500);
    addLog({ dir: r.ok ? 'RX' : 'ERR', hex: r.raw, label: `Scan ${mod.name}` });
    setScanStates(prev => ({ ...prev, [mod.name]: r.ok ? 'ok' : 'no_resp' }));
  }, [connected, bridgeUrl, addLog]);

  /* Scan all modules */
  const scanAll = useCallback(async () => {
    for (const mod of CDA_MODULES) {
      await scanModule(mod);
    }
  }, [scanModule]);

  /* Save session to DB after a run */
  const handleSaveSession = useCallback(async (outcome = 'ok', errorMessage = null) => {
    if (!selectedModule) return;
    await saveSession.mutateAsync({
      moduleName: selectedModule.name,
      txId: `0x${selectedModule.tx.toString(16).toUpperCase()}`,
      rxId: `0x${selectedModule.rx.toString(16).toUpperCase()}`,
      profileId: profile?.profile_name || null,
      adapterName: bridgeUrl,
      udsLog: logEntries.slice(-200),
      outcome,
      errorMessage,
    });
  }, [selectedModule, profile, bridgeUrl, logEntries, saveSession]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: C.dk, color: '#eee', fontFamily: 'Inter, sans-serif',
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Adapter Panel */}
      <AdapterPanel
        bridgeUrl={bridgeUrl}
        setBridgeUrl={setBridgeUrl}
        connected={connected}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        status={adapterStatus}
      />

      {/* Main body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        {/* ECU List */}
        <EcuList
          selected={selectedModule}
          onSelect={setSelectedModule}
          scanStates={scanStates}
          onScan={scanModule}
          onScanAll={scanAll}
          connected={connected}
        />

        {/* Workspace */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {/* Module header */}
          {selectedModule && (
            <div style={{
              padding: '8px 16px', background: C.dk2, borderBottom: `1px solid #2a2a2a`,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 18 }}>{selectedModule.icon}</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 900, color: '#eee' }}>{selectedModule.display}</div>
                <div style={{ fontSize: 10, color: C.tm, fontFamily: 'JetBrains Mono, monospace' }}>
                  {selectedModule.notes}
                </div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <Btn small outline color={C.a2} disabled={!connected} onClick={() => scanModule(selectedModule)}>
                  IDENTIFY
                </Btn>
                <Btn small outline color={C.a3} onClick={() => setShowHistory(h => !h)}>
                  HISTORY
                </Btn>
                <Btn small color={C.gn} disabled={!connected} onClick={() => handleSaveSession('ok')}>
                  SAVE SESSION
                </Btn>
              </div>
            </div>
          )}

          {/* Workspace tabs */}
          <div style={{
            display: 'flex', gap: 0, background: C.dk2, borderBottom: `1px solid #2a2a2a`,
          }}>
            {WORKSPACE_TABS_CDA.map(t => (
              <button key={t.id}
                onClick={() => setActiveTab(t.id)}
                style={{
                  background: activeTab === t.id ? C.dk3 : 'transparent',
                  color: activeTab === t.id ? '#eee' : C.tm,
                  border: 'none', borderBottom: `2px solid ${activeTab === t.id ? C.a1 : 'transparent'}`,
                  padding: '8px 14px', fontSize: 10, fontWeight: 700,
                  fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer',
                  letterSpacing: 0.5, transition: 'all 0.12s',
                }}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {activeTab === 'readdata' && (
              <ReadDataTab module={selectedModule} profile={profile} connected={connected} bridgeUrl={bridgeUrl} onLog={addLog} />
            )}
            {activeTab === 'dtcs' && (
              <DtcsTab module={selectedModule} connected={connected} bridgeUrl={bridgeUrl} onLog={addLog} />
            )}
            {activeTab === 'routines' && (
              <RoutinesTab module={selectedModule} profile={profile} connected={connected} bridgeUrl={bridgeUrl} onLog={addLog} />
            )}
            {activeTab === 'unlock' && (
              <EcuUnlockTab module={selectedModule} connected={connected} bridgeUrl={bridgeUrl} onLog={addLog} />
            )}
            {activeTab === 'calibration' && (
              <CalibrationTab module={selectedModule} profile={profile} connected={connected} bridgeUrl={bridgeUrl} onLog={addLog} />
            )}
          </div>
        </div>
      </div>

      {/* UDS Log */}
      <UdsLog entries={logEntries} onClear={() => setLogEntries([])} />

      {/* Session History Overlay */}
      {showHistory && <SessionHistoryPanel onClose={() => setShowHistory(false)} />}
    </div>
  );
}
