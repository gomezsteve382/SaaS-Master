/**
 * IpcClusterReprogramTab.jsx — IPC Cluster Reprogram (Durango → Trackhawk)
 *
 * Guided workflow for reprogramming the Instrument Panel Cluster (IPC)
 * body code byte from Durango (WD, 0x0B) to Trackhawk (WK, 0x09).
 *
 * The swap is a SINGLE DID write (2E F1 0F 09) after programming-level
 * security unlock — NO full reflash is needed.
 *
 * Source of truth: RE analysis of SRT_Lab_UDS_Complete_Export.zip
 *   - IPC CAN IDs: TX 0x746 / RX 0x766
 *   - SGW CAN IDs: TX 0x74F / RX 0x76F
 *   - SBEC formula: key = ((seed * 4) + 0x9018) & 0xFFFF
 *   - Body code DID: F1 0F (read: 22 F1 0F, write: 2E F1 0F 09 for Trackhawk)
 *   - Session sequence: 10 03 → 27 01 (SGW) → 27 02 → 27 03 (IPC prog) → 27 04
 *     → 22 F1 0E (odometer) → 22 F1 90 (VIN) → 2E F1 0F 09 → 11 01 → restore
 */
import React, { useState, useCallback, useMemo } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn, Tag } from "../lib/ui.jsx";
import {
  sbecKey,
  formatHex,
  parseHexString,
  buildIpcBodyCodeSwap,
  VEHICLE_BODY_CODES,
  MODULE_REGISTRY,
  getModuleDids,
  decodeNrc,
  NRC_TABLE,
  TESTER_PRESENT_INTERVAL_MS,
  VOLTAGE_REQUIREMENTS,
  CAN_PARAMS,
} from "../lib/udsEngine.js";

// ─── Color palette for this tab ───────────────────────────────────────────────
const COL = {
  sgw:      '#FF6D00',  // orange — SGW bypass steps
  session:  '#2979FF',  // blue — session open steps
  security: '#AA00FF',  // purple — security access steps
  read:     '#00BFA5',  // teal — read operations
  write:    '#D32F2F',  // red — write operations (critical)
  reset:    '#FF8F00',  // amber — reset/post-reset steps
  post:     '#00897B',  // dark teal — post-reset restore steps
  pass:     '#00C853',
  fail:     '#FF1744',
  warn:     '#FFB300',
};

const PHASE_COLORS = {
  sgw:          COL.sgw,
  ipc_session:  COL.session,
  ipc_security: COL.security,
  read:         COL.read,
  write:        COL.write,
  reset:        COL.reset,
  post_reset:   COL.post,
};

const PHASE_LABELS = {
  sgw:          'SGW BYPASS',
  ipc_session:  'IPC SESSION',
  ipc_security: 'IPC SECURITY',
  read:         'READ',
  write:        'WRITE',
  reset:        'RESET',
  post_reset:   'POST-RESET',
};

// ─── Body code options ────────────────────────────────────────────────────────
const BODY_CODE_OPTIONS = [
  { key: 'WK',  code: 0x09, label: 'Trackhawk (WK)',  desc: 'Grand Cherokee Trackhawk — 707 HP supercharged',  color: COL.write },
  { key: 'WD',  code: 0x0B, label: 'Durango (WD)',    desc: 'Dodge Durango SRT / R/T',                         color: '#607D8B' },
  { key: 'LD',  code: 0x0D, label: 'Charger (LD)',    desc: 'Dodge Charger / Challenger',                      color: '#607D8B' },
  { key: 'WK2', code: 0x12, label: 'Grand Cherokee WK2', desc: 'Standard Grand Cherokee',                     color: '#607D8B' },
];

// ─── Section header component ─────────────────────────────────────────────────
function Section({ title, color, children, style = {} }) {
  const c = color || C.sr;
  return (
    <div style={{ marginBottom: 20, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontFamily: 'JetBrains Mono', fontSize: 11, letterSpacing: 3, color: c, fontWeight: 800 }}>
          {title}
        </span>
        <span style={{ flex: 1, height: 1, background: `linear-gradient(to right, ${c}55, transparent)` }} />
      </div>
      {children}
    </div>
  );
}

// ─── Hex bytes display ────────────────────────────────────────────────────────
function HexBytes({ bytes, color, style = {} }) {
  const [copied, setCopied] = useState(false);
  const hex = formatHex(bytes);
  const copy = useCallback(() => {
    try { navigator.clipboard.writeText(hex).catch(() => {}); } catch (_) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [hex]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...style }}>
      <code style={{
        fontFamily: 'JetBrains Mono',
        fontSize: 12,
        background: '#0D1117',
        color: color || '#E6EDF3',
        padding: '6px 12px',
        borderRadius: 6,
        letterSpacing: 2,
        flex: 1,
        wordBreak: 'break-all',
      }}>
        {hex}
      </code>
      <button
        onClick={copy}
        title="Copy to clipboard"
        style={{
          padding: '6px 10px',
          borderRadius: 6,
          border: `1px solid ${C.bd}`,
          background: copied ? COL.pass + '22' : 'transparent',
          color: copied ? COL.pass : C.ts,
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 700,
          transition: 'all 0.2s',
          whiteSpace: 'nowrap',
        }}
      >
        {copied ? '✓ COPIED' : '📋 COPY'}
      </button>
    </div>
  );
}

// ─── UDS step card ────────────────────────────────────────────────────────────
function UdsStepCard({ step, expanded, onToggle }) {
  const phaseColor = PHASE_COLORS[step.phase] || C.ts;
  const phaseLabel = PHASE_LABELS[step.phase] || step.phase?.toUpperCase() || '';
  const isCritical = step.critical;

  return (
    <div
      onClick={onToggle}
      style={{
        borderRadius: 10,
        border: `1.5px solid ${isCritical ? COL.write + '88' : C.bd}`,
        background: expanded ? '#0D1117' : C.cd,
        marginBottom: 6,
        cursor: 'pointer',
        transition: 'all 0.2s',
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
      }}>
        {/* Step number */}
        <div style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: phaseColor + '22',
          border: `2px solid ${phaseColor}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 800,
          color: phaseColor,
          flexShrink: 0,
        }}>
          {step.step}
        </div>

        {/* Phase badge */}
        <span style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: 1.5,
          padding: '2px 7px',
          borderRadius: 5,
          background: phaseColor + '22',
          color: phaseColor,
          flexShrink: 0,
        }}>
          {phaseLabel}
        </span>

        {/* Step name */}
        <span style={{
          fontSize: 12,
          fontWeight: 700,
          color: expanded ? '#E6EDF3' : C.tx,
          flex: 1,
        }}>
          {step.name}
        </span>

        {/* Critical badge */}
        {isCritical && (
          <span style={{
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: 1,
            padding: '2px 7px',
            borderRadius: 5,
            background: COL.write + '22',
            color: COL.write,
            flexShrink: 0,
          }}>
            ★ KEY STEP
          </span>
        )}

        {/* CAN IDs */}
        <span style={{
          fontFamily: 'JetBrains Mono',
          fontSize: 10,
          color: C.ts,
          flexShrink: 0,
        }}>
          TX {step.canTx?.toString(16).toUpperCase().padStart(3,'0')} / RX {step.canRx?.toString(16).toUpperCase().padStart(3,'0')}
        </span>

        {/* Expand arrow */}
        <span style={{ color: C.ts, fontSize: 12, transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'none' }}>▼</span>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${phaseColor}33` }}>
          <div style={{ fontSize: 11, color: '#8B949E', marginBottom: 10, marginTop: 8 }}>
            {step.description}
          </div>
          <HexBytes bytes={step.bytes} color={phaseColor} />
          {step.note && (
            <div style={{
              marginTop: 8,
              fontSize: 11,
              color: COL.warn,
              padding: '6px 10px',
              borderRadius: 6,
              background: COL.warn + '11',
              border: `1px solid ${COL.warn}33`,
            }}>
              ⚠ {step.note}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SBEC Calculator ──────────────────────────────────────────────────────────
function SbecCalculator() {
  const [seedInput, setSeedInput] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const calculate = useCallback(() => {
    setError('');
    setResult(null);
    const raw = seedInput.trim().replace(/^0x/i, '');
    if (!raw) { setError('Enter a seed value'); return; }
    const seed = parseInt(raw, 16);
    if (isNaN(seed) || seed < 0 || seed > 0xFFFF) {
      setError('Seed must be a 16-bit hex value (0000–FFFF)');
      return;
    }
    const key = sbecKey(seed);
    const keyHi = (key >> 8) & 0xFF;
    const keyLo = key & 0xFF;
    setResult({
      seed,
      key,
      keyHi,
      keyLo,
      formula: `(0x${seed.toString(16).toUpperCase().padStart(4,'0')} × 4) + 0x9018`,
      keySend: [0x27, 0x04, keyHi, keyLo],
    });
  }, [seedInput]);

  const handleKey = useCallback((e) => {
    if (e.key === 'Enter') calculate();
  }, [calculate]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.ts, letterSpacing: 1, marginBottom: 4 }}>
            IPC SEED (from 67 03 SS SS response)
          </div>
          <input
            value={seedInput}
            onChange={e => setSeedInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="e.g. 2E2A"
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: 8,
              border: `1.5px solid ${C.bd}`,
              background: '#1E2230',
              color: '#E6EDF3',
              fontFamily: 'JetBrains Mono',
              fontSize: 14,
              letterSpacing: 2,
              boxSizing: 'border-box',
            }}
          />
        </div>
        <Btn onClick={calculate} color={COL.security}>COMPUTE KEY</Btn>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: COL.fail, marginBottom: 8 }}>{error}</div>
      )}

      {result && (
        <div style={{
          background: '#0D1117',
          borderRadius: 10,
          padding: 14,
          border: `1.5px solid ${COL.security}44`,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: C.ts, letterSpacing: 1, marginBottom: 3 }}>SEED</div>
              <code style={{ fontFamily: 'JetBrains Mono', fontSize: 16, color: COL.security, fontWeight: 700 }}>
                0x{result.seed.toString(16).toUpperCase().padStart(4,'0')}
              </code>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.ts, letterSpacing: 1, marginBottom: 3 }}>KEY</div>
              <code style={{ fontFamily: 'JetBrains Mono', fontSize: 16, color: COL.pass, fontWeight: 700 }}>
                0x{result.key.toString(16).toUpperCase().padStart(4,'0')}
              </code>
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#8B949E', marginBottom: 10 }}>
            Formula: {result.formula} = 0x{result.key.toString(16).toUpperCase().padStart(4,'0')}
          </div>
          <div style={{ fontSize: 10, color: C.ts, letterSpacing: 1, marginBottom: 4 }}>
            SEND TO IPC (27 04 KK KK)
          </div>
          <HexBytes bytes={result.keySend} color={COL.security} />
        </div>
      )}

      {/* Formula reference */}
      <div style={{
        marginTop: 12,
        padding: '10px 14px',
        borderRadius: 8,
        background: COL.security + '11',
        border: `1px solid ${COL.security}33`,
        fontSize: 11,
        color: C.ts,
      }}>
        <span style={{ fontWeight: 700, color: COL.security }}>SBEC Formula:</span>{' '}
        <code style={{ fontFamily: 'JetBrains Mono', color: '#E6EDF3' }}>
          key = ((seed × 4) + 0x9018) &amp; 0xFFFF
        </code>
        <br />
        <span style={{ fontSize: 10 }}>
          Used by: IPC (levels 0x01 and 0x03), SKIM — same formula for both diagnostic and programming levels
        </span>
      </div>
    </div>
  );
}

// ─── DID Catalog panel ────────────────────────────────────────────────────────
function IpcDidCatalog() {
  const dids = useMemo(() => getModuleDids('IPC'), []);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    if (!filter) return dids;
    const f = filter.toLowerCase();
    return dids.filter(d =>
      d.name.toLowerCase().includes(f) ||
      d.did.toString(16).padStart(4,'0').includes(f)
    );
  }, [dids, filter]);

  return (
    <div>
      <input
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter DIDs…"
        style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: 8,
          border: `1.5px solid ${C.bd}`,
          background: '#1E2230',
          color: '#E6EDF3',
          fontFamily: 'JetBrains Mono',
          fontSize: 12,
          marginBottom: 10,
          boxSizing: 'border-box',
        }}
      />
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        {filtered.map(d => {
          const didHex = d.did.toString(16).toUpperCase().padStart(4,'0');
          const secColor = d.secLevel === 0x03 ? COL.security
            : d.secLevel === 0x01 ? COL.session
            : C.ts;
          return (
            <div key={d.did} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 10px',
              borderRadius: 7,
              background: C.c2,
              marginBottom: 4,
            }}>
              <code style={{ fontFamily: 'JetBrains Mono', fontSize: 11, color: COL.read, minWidth: 45 }}>
                {didHex.slice(0,2)} {didHex.slice(2,4)}
              </code>
              <span style={{ flex: 1, fontSize: 11, color: C.tx }}>{d.name}</span>
              <span style={{
                fontSize: 9,
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: 4,
                background: d.rw === 'RW' ? COL.write + '22' : COL.read + '22',
                color: d.rw === 'RW' ? COL.write : COL.read,
              }}>
                {d.rw}
              </span>
              {d.secLevel != null && (
                <span style={{
                  fontSize: 9,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: secColor + '22',
                  color: secColor,
                }}>
                  27 {d.secLevel.toString(16).toUpperCase().padStart(2,'0')}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── NRC Reference panel ──────────────────────────────────────────────────────
function NrcReference() {
  const entries = useMemo(() => Object.entries(NRC_TABLE).map(([k, v]) => ({
    nrc: parseInt(k),
    ...v,
  })), []);

  return (
    <div style={{ maxHeight: 220, overflowY: 'auto' }}>
      {entries.map(e => (
        <div key={e.nrc} style={{
          display: 'flex',
          gap: 10,
          padding: '5px 8px',
          borderRadius: 6,
          marginBottom: 3,
          background: C.c2,
        }}>
          <code style={{ fontFamily: 'JetBrains Mono', fontSize: 11, color: COL.fail, minWidth: 30 }}>
            {e.nrc.toString(16).toUpperCase().padStart(2,'0')}
          </code>
          <span style={{ fontSize: 10, color: C.ts, flex: 1 }}>{e.desc}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main tab component ───────────────────────────────────────────────────────
export default function IpcClusterReprogramTab() {
  const ipc = MODULE_REGISTRY.IPC;
  const sgw = MODULE_REGISTRY.SGW;

  // Target body code selection
  const [targetKey, setTargetKey] = useState('WK');
  const targetOption = BODY_CODE_OPTIONS.find(o => o.key === targetKey) || BODY_CODE_OPTIONS[0];

  // UDS sequence steps
  const steps = useMemo(() => buildIpcBodyCodeSwap(targetOption.code), [targetOption.code]);

  // Expanded step tracking
  const [expandedSteps, setExpandedSteps] = useState(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  const toggleStep = useCallback((stepNum) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepNum)) next.delete(stepNum);
      else next.add(stepNum);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpandedSteps(new Set(steps.map(s => s.step)));
  }, [steps]);

  const collapseAll = useCallback(() => {
    setExpandedSteps(new Set());
  }, []);

  // Copy all steps as hex
  const copyAllHex = useCallback(() => {
    const text = steps.map(s => `; Step ${s.step}: ${s.name}\n${formatHex(s.bytes)}`).join('\n\n');
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch (_) {}
  }, [steps]);

  // Active panel
  const [panel, setPanel] = useState('sequence');

  const panels = [
    { id: 'sequence', label: '📋 UDS SEQUENCE' },
    { id: 'sbec',     label: '🔑 SBEC CALC' },
    { id: 'dids',     label: '📖 DID CATALOG' },
    { id: 'nrc',      label: '⚠ NRC CODES' },
    { id: 'info',     label: 'ℹ MODULE INFO' },
  ];

  return (
    <div style={{ padding: '0 0 40px', maxWidth: 900 }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <div style={{
            fontSize: 32,
            lineHeight: 1,
            background: COL.write + '22',
            borderRadius: 12,
            padding: '8px 12px',
          }}>🏁</div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.tx, letterSpacing: -0.5 }}>
              IPC Cluster Reprogram
            </div>
            <div style={{ fontSize: 12, color: C.ts, marginTop: 2 }}>
              Durango → Trackhawk body code swap · DID 2E F1 0F 09 · No reflash required
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: 1.5,
              padding: '4px 10px', borderRadius: 6,
              background: COL.session + '22', color: COL.session,
            }}>
              IPC · TX 0x{ipc.tx.toString(16).toUpperCase()} / RX 0x{ipc.rx.toString(16).toUpperCase()}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: 1.5,
              padding: '4px 10px', borderRadius: 6,
              background: COL.sgw + '22', color: COL.sgw,
            }}>
              SGW · TX 0x{sgw.tx.toString(16).toUpperCase()} / RX 0x{sgw.rx.toString(16).toUpperCase()}
            </span>
          </div>
        </div>

        {/* Warning banner */}
        <div style={{
          padding: '10px 16px',
          borderRadius: 10,
          background: COL.warn + '11',
          border: `1.5px solid ${COL.warn}44`,
          fontSize: 12,
          color: COL.warn,
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚠</span>
          <div>
            <strong>Reference / simulation tool only.</strong> These UDS sequences are for
            educational reference and bench programming workflows. No live OBD hardware is
            connected. Battery must be 11.5–14.5V. Engine must be off. SGW bypass required
            on 2018+ vehicles. Incorrect writes may require dealer recovery.
          </div>
        </div>
      </div>

      {/* ── Target body code selector ── */}
      <Card style={{ marginBottom: 20 }}>
        <Section title="TARGET BODY CODE" color={COL.write}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {BODY_CODE_OPTIONS.map(opt => (
              <div
                key={opt.key}
                onClick={() => setTargetKey(opt.key)}
                style={{
                  flex: '1 1 180px',
                  padding: '12px 16px',
                  borderRadius: 10,
                  border: `2px solid ${targetKey === opt.key ? opt.color : C.bd}`,
                  background: targetKey === opt.key ? opt.color + '11' : C.c2,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <code style={{
                    fontFamily: 'JetBrains Mono',
                    fontSize: 18,
                    fontWeight: 800,
                    color: targetKey === opt.key ? opt.color : C.ts,
                  }}>
                    0x{opt.code.toString(16).toUpperCase().padStart(2,'0')}
                  </code>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.tx }}>{opt.label}</span>
                  {targetKey === opt.key && (
                    <span style={{
                      marginLeft: 'auto',
                      fontSize: 9, fontWeight: 800, letterSpacing: 1,
                      padding: '2px 6px', borderRadius: 4,
                      background: opt.color + '22', color: opt.color,
                    }}>SELECTED</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: C.ts }}>{opt.desc}</div>
              </div>
            ))}
          </div>

          {/* Write command preview */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 10, color: C.ts, letterSpacing: 1, marginBottom: 6 }}>
              WRITE COMMAND (2E F1 0F {targetOption.code.toString(16).toUpperCase().padStart(2,'0')})
            </div>
            <HexBytes
              bytes={[0x2E, 0xF1, 0x0F, targetOption.code & 0xFF]}
              color={COL.write}
            />
          </div>
        </Section>
      </Card>

      {/* ── Panel tabs ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {panels.map(p => (
          <button
            key={p.id}
            onClick={() => setPanel(p.id)}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: `1.5px solid ${panel === p.id ? C.sr : C.bd}`,
              background: panel === p.id ? C.sr + '11' : 'transparent',
              color: panel === p.id ? C.sr : C.ts,
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: 0.5,
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* ── UDS Sequence panel ── */}
      {panel === 'sequence' && (
        <Card>
          <Section title="FULL UDS SEQUENCE" color={COL.session}>
            {/* Controls */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <Btn onClick={expandAll} color={COL.session} outline>▼ EXPAND ALL</Btn>
              <Btn onClick={collapseAll} color={COL.session} outline>▲ COLLAPSE ALL</Btn>
              <Btn onClick={copyAllHex} color={COL.read} outline>📋 COPY ALL HEX</Btn>
            </div>

            {/* Phase legend */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {Object.entries(PHASE_LABELS).map(([phase, label]) => (
                <span key={phase} style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: 1,
                  padding: '3px 8px', borderRadius: 5,
                  background: (PHASE_COLORS[phase] || C.ts) + '22',
                  color: PHASE_COLORS[phase] || C.ts,
                }}>
                  {label}
                </span>
              ))}
            </div>

            {/* Steps */}
            {steps.map(step => (
              <UdsStepCard
                key={step.step}
                step={step}
                expanded={expandedSteps.has(step.step)}
                onToggle={() => toggleStep(step.step)}
              />
            ))}

            {/* Tester Present reminder */}
            <div style={{
              marginTop: 14,
              padding: '10px 14px',
              borderRadius: 8,
              background: COL.session + '11',
              border: `1px solid ${COL.session}33`,
              fontSize: 11,
              color: C.ts,
            }}>
              <span style={{ fontWeight: 700, color: COL.session }}>⏱ Tester Present:</span>{' '}
              Send <code style={{ fontFamily: 'JetBrains Mono', color: '#E6EDF3' }}>3E 00</code> every{' '}
              <strong>{TESTER_PRESENT_INTERVAL_MS}ms</strong> to keep session alive during long operations.
              Response: <code style={{ fontFamily: 'JetBrains Mono', color: '#E6EDF3' }}>7E 00</code>
            </div>
          </Section>
        </Card>
      )}

      {/* ── SBEC Calculator panel ── */}
      {panel === 'sbec' && (
        <Card>
          <Section title="SBEC SEED-KEY CALCULATOR" color={COL.security}>
            <div style={{ fontSize: 12, color: C.ts, marginBottom: 14 }}>
              IPC uses the SBEC algorithm for both diagnostic (level 0x01) and programming (level 0x03)
              security access. Enter the seed from the <code style={{ fontFamily: 'JetBrains Mono', color: '#E6EDF3' }}>67 03 SS SS</code> response
              to compute the key to send in <code style={{ fontFamily: 'JetBrains Mono', color: '#E6EDF3' }}>27 04 KK KK</code>.
            </div>
            <SbecCalculator />
          </Section>
        </Card>
      )}

      {/* ── DID Catalog panel ── */}
      {panel === 'dids' && (
        <Card>
          <Section title="IPC DID CATALOG" color={COL.read}>
            <div style={{ fontSize: 12, color: C.ts, marginBottom: 12 }}>
              All readable/writable DIDs for the IPC module. DIDs marked RW require security access
              at the indicated level. Source: 07_did_catalog.txt + lib__udsDidCatalog.generated.js
            </div>
            <IpcDidCatalog />
          </Section>
        </Card>
      )}

      {/* ── NRC Reference panel ── */}
      {panel === 'nrc' && (
        <Card>
          <Section title="NEGATIVE RESPONSE CODES" color={COL.fail}>
            <div style={{ fontSize: 12, color: C.ts, marginBottom: 12 }}>
              ISO 14229 NRC codes returned in <code style={{ fontFamily: 'JetBrains Mono', color: '#E6EDF3' }}>7F SID NRC</code> frames.
              NRC 0x78 (responsePending) is normal — just wait for the final response.
            </div>
            <NrcReference />
          </Section>
        </Card>
      )}

      {/* ── Module Info panel ── */}
      {panel === 'info' && (
        <Card>
          <Section title="IPC MODULE REFERENCE" color={COL.session}>
            {/* Module specs table */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              {[
                { label: 'Module', value: ipc.name },
                { label: 'CAN TX (tester→IPC)', value: `0x${ipc.tx.toString(16).toUpperCase()}` },
                { label: 'CAN RX (IPC→tester)', value: `0x${ipc.rx.toString(16).toUpperCase()}` },
                { label: 'SGW Required', value: ipc.sgwRequired ? 'YES (2018+)' : 'NO' },
                { label: 'Security Algorithm', value: 'SBEC — key = (seed×4) + 0x9018' },
                { label: 'Diagnostic Level', value: `0x${ipc.security.diagnostic.toString(16).toUpperCase().padStart(2,'0')} (27 01/02)` },
                { label: 'Programming Level', value: `0x${ipc.security.programming.toString(16).toUpperCase().padStart(2,'0')} (27 03/04)` },
                { label: 'Body Code DID', value: 'F1 0F (RW, requires 27 03)' },
                { label: 'Flash Block Size', value: `0x${ipc.flash.blockSize.toString(16).toUpperCase()} (${ipc.flash.blockSize} bytes = 16 KB)` },
                { label: 'Flash Block Count', value: `${ipc.flash.blockCount} blocks` },
                { label: 'Flash Checksum', value: ipc.flash.checksumAlgo },
                { label: 'VIN Flash Offset', value: `0x${ipc.flash.vinOffset.toString(16).toUpperCase()}` },
                { label: 'Odometer Flash Offset', value: `0x${ipc.flash.odometerOffset.toString(16).toUpperCase()}` },
                { label: 'Body Code Flash Offset', value: `0x${ipc.flash.bodyCodeOffset.toString(16).toUpperCase()}` },
              ].map(row => (
                <div key={row.label} style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: C.c2,
                }}>
                  <div style={{ fontSize: 10, color: C.ts, letterSpacing: 0.5, marginBottom: 2 }}>{row.label}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.tx, fontFamily: row.value.startsWith('0x') ? 'JetBrains Mono' : undefined }}>
                    {row.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Body code reference */}
            <Section title="BODY CODE VALUES" color={COL.write}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {BODY_CODE_OPTIONS.map(opt => (
                  <div key={opt.key} style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: C.c2,
                    border: `1px solid ${C.bd}`,
                    flex: '1 1 160px',
                  }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                      <code style={{ fontFamily: 'JetBrains Mono', fontSize: 16, fontWeight: 800, color: opt.color }}>
                        0x{opt.code.toString(16).toUpperCase().padStart(2,'0')}
                      </code>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.tx }}>{opt.label}</span>
                    </div>
                    <div style={{ fontSize: 11, color: C.ts }}>{opt.desc}</div>
                    <div style={{ marginTop: 6 }}>
                      <code style={{
                        fontFamily: 'JetBrains Mono',
                        fontSize: 10,
                        background: '#0D1117',
                        color: opt.color,
                        padding: '3px 8px',
                        borderRadius: 4,
                      }}>
                        2E F1 0F {opt.code.toString(16).toUpperCase().padStart(2,'0')}
                      </code>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            {/* Known issues */}
            <Section title="KNOWN ISSUES" color={COL.warn}>
              <div>
                {ipc.notes.map((note, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    gap: 8,
                    padding: '6px 0',
                    borderBottom: i < ipc.notes.length - 1 ? `1px solid ${C.bd}` : 'none',
                    fontSize: 12,
                    color: C.ts,
                  }}>
                    <span style={{ color: COL.warn, flexShrink: 0 }}>•</span>
                    <span>{note}</span>
                  </div>
                ))}
              </div>
            </Section>

            {/* SGW info */}
            <Section title="SGW BYPASS REFERENCE" color={COL.sgw}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'SGW TX (tester→SGW)', value: `0x${sgw.tx.toString(16).toUpperCase()}` },
                  { label: 'SGW RX (SGW→tester)', value: `0x${sgw.rx.toString(16).toUpperCase()}` },
                  { label: 'SGW Algorithm', value: 'XTEA (32 rounds, standard delta)' },
                  { label: 'XTEA Key', value: 'BC474048 A33B483A 63687279 73313372' },
                ].map(row => (
                  <div key={row.label} style={{ padding: '8px 12px', borderRadius: 8, background: C.c2 }}>
                    <div style={{ fontSize: 10, color: C.ts, marginBottom: 2 }}>{row.label}</div>
                    <code style={{ fontFamily: 'JetBrains Mono', fontSize: 11, color: COL.sgw }}>{row.value}</code>
                  </div>
                ))}
              </div>
              <div style={{
                marginTop: 10,
                padding: '8px 12px',
                borderRadius: 8,
                background: COL.sgw + '11',
                border: `1px solid ${COL.sgw}33`,
                fontSize: 11,
                color: C.ts,
              }}>
                SGW bypass uses <code style={{ fontFamily: 'JetBrains Mono', color: '#E6EDF3' }}>xtea_sgw(seed)</code> from{' '}
                <code style={{ fontFamily: 'JetBrains Mono', color: '#E6EDF3' }}>algos.js</code>.
                The 4-byte key is the high word of the XTEA-encrypted block.
                Full implementation: <code style={{ fontFamily: 'JetBrains Mono', color: '#E6EDF3' }}>sgwUnlock.js</code>
              </div>
            </Section>

            {/* Voltage / CAN requirements */}
            <Section title="HARDWARE REQUIREMENTS" color={C.ts}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'Battery Voltage', value: `${VOLTAGE_REQUIREMENTS.min}–${VOLTAGE_REQUIREMENTS.max} ${VOLTAGE_REQUIREMENTS.unit}` },
                  { label: 'Engine State', value: 'OFF (key-on, engine-off)' },
                  { label: 'CAN Speed', value: `${CAN_PARAMS.speed} ${CAN_PARAMS.speedUnit}` },
                  { label: 'CAN Addressing', value: 'Normal 11-bit, physical ISO-TP' },
                ].map(row => (
                  <div key={row.label} style={{ padding: '8px 12px', borderRadius: 8, background: C.c2 }}>
                    <div style={{ fontSize: 10, color: C.ts, marginBottom: 2 }}>{row.label}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.tx }}>{row.value}</div>
                  </div>
                ))}
              </div>
            </Section>
          </Section>
        </Card>
      )}
    </div>
  );
}
