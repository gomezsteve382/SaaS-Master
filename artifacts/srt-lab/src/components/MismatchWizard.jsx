import React, {
  useState, useRef, useEffect, useCallback, useMemo,
} from "react";

/* ============================================================================
 * MismatchWizard — Guided resolution wizard + Claude AI chat panel
 *
 * Props:
 *   issues      : string[]  — error-level issues
 *   warnings    : string[]  — warning-level items
 *   modules     : string[]  — loaded module names
 *   hexSnippets : string[]  — hex label: value strings for AI + diff cards
 *   onClose     : () => void
 *   onAction    : (actionId: string, stepId: string) => void
 *   stepActions : { id, label, enabled, description }[]
 * ============================================================================ */

const W = {
  bg:   '#0E1620',
  surf: '#151F2E',
  s2:   '#1C2A3D',
  s3:   '#243347',
  bd:   '#2C3E56',
  sr:   '#D32F2F',
  a1:   '#FF6D00',
  a2:   '#00BFA5',
  a3:   '#2979FF',
  a4:   '#AA00FF',
  gn:   '#00C853',
  wn:   '#FFB300',
  er:   '#FF1744',
  tx:   '#E8EDF2',
  ts:   '#8FA8C4',
  tm:   '#4A6080',
  mono: "'JetBrains Mono', monospace",
  sans: "'Nunito', system-ui, sans-serif",
};

const API_BASE = (import.meta.env.BASE_URL?.replace(/\/$/, '') || '') + '/api';

/* ─── Deterministic ID from issue string (djb2) ─── */
function stableId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return 'step-' + (h >>> 0).toString(36);
}

/* ─── Step priority: lower = more urgent ─── */
const PRIORITY_MAP = [
  [/VIN MISMATCH/,         0],
  [/SEC16.*MISMATCH/,      1],
  [/VEHICLE SECRET/,       2],
  [/PCM SEC6|IMMO_DAMAGED/,3],
  [/GPEC2A/,               4],
  [/95640/,                5],
  [/BCM SEC16.*RFHUB/,     6],
];

function stepPriority(issue, severity) {
  const u = issue.toUpperCase();
  for (const [re, pri] of PRIORITY_MAP) {
    if (re.test(u)) return severity === 'error' ? pri : pri + 20;
  }
  return severity === 'error' ? 10 : 30;
}

/* ─── Issue → step definition ─── */
function issueToStep(issue, fromIssue) {
  const u = issue.toUpperCase();
  const id = stableId(issue);
  const base = { id, severity: fromIssue ? 'error' : 'warning', summary: issue };

  if (u.includes('VIN MISMATCH')) return {
    ...base, severity: 'error',
    icon: '🪪', title: 'VIN Mismatch',
    hexFilter: ['VIN', 'RFHUB VIN', 'BCM VIN'],
    guidance: 'These modules came from different vehicles. The VIN must be re-stamped so both modules report the same chassis ID.',
    steps: [
      'Confirm which VIN is correct — it should match the dashboard sticker or title.',
      'Click the sync action below. The correct VIN will be written to both BCM and RFHUB.',
      'After flashing, power-cycle the vehicle for 30 seconds.',
    ],
    skipConsequence: 'Leaving a VIN mismatch means both modules will report conflicting chassis IDs. Key fob pairing and immobilizer authentication may fail.',
    actions: ['full-sync', 'rfh-to-bcm', 'bcm-to-rfh'],
  };

  if (u.includes('SEC16') && (u.includes('MISMATCH') || u.includes('INVALID'))) return {
    ...base, severity: 'error',
    icon: '🔐', title: 'SEC16 Security Token Mismatch',
    hexFilter: ['SEC16', 'RFHUB SEC16', 'BCM SEC16'],
    guidance: 'The 16-byte IMMO security token differs between BCM and RFHUB. RFHUB is master — its SEC16 is written (reversed) into BCM, and first 6 bytes become PCM SEC6.',
    steps: [
      'Confirm the RFHUB SEC16 is valid (non-blank, slots 1 & 2 match).',
      'Use "SEC16 Sync Only" to write RFHUB SEC16 to BCM and PCM without changing VINs.',
      'If RFHUB came from a different vehicle, use "BCM SEC16 → RFHUB" to make BCM master instead.',
      'Flash the patched file(s) and power-cycle 30 seconds.',
    ],
    skipConsequence: 'The immobilizer handshake will fail — the vehicle will not start.',
    actions: ['sec16-only', 'bcm-sec16-to-rfh'],
  };

  if (u.includes('BCM SEC16') && u.includes('RFHUB')) return {
    ...base,
    icon: '🔄', title: 'BCM SEC16 → RFHUB Sync Needed',
    hexFilter: ['SEC16', 'BCM SEC16'],
    guidance: 'The BCM has a valid SEC16 but the RFHUB is from a different vehicle. Use BCM as master and write its SEC16 into the RFHUB Gen2 slots.',
    steps: [
      'Verify the BCM SEC16 is non-blank and consistent.',
      'Click "BCM SEC16 → RFHUB" below.',
      'Flash the patched RFHUB, then power-cycle 30 seconds.',
    ],
    skipConsequence: 'RFHUB retains a mismatched SEC16, preventing secure key pairing.',
    actions: ['bcm-sec16-to-rfh'],
  };

  if (u.includes('PCM SEC6') || u.includes('IMMO_DAMAGED')) return {
    ...base, severity: 'error',
    icon: '⚙️', title: 'PCM SEC6 Damaged / Mismatch',
    hexFilter: ['SEC16', 'SEC6'],
    guidance: 'The PCM IMMO SEC6 is damaged (all FF) or does not match RFHUB SEC16[0:6]. The PCM will reject the immobilizer handshake until corrected.',
    steps: [
      'Load a valid RFHUB with a known-good SEC16.',
      'Run a full sync or SEC16-only sync — this also writes the PCM SEC6.',
      'Flash the patched PCM and power-cycle 30 seconds.',
    ],
    skipConsequence: 'Vehicle will not start — the PCM will reject all immobilizer tokens.',
    actions: ['full-sync', 'sec16-only'],
  };

  if (u.includes('RFHUB') && u.includes('VEHICLE SECRET')) return {
    ...base, severity: 'error',
    icon: '🔑', title: 'Vehicle Secret Mismatch (RFHUB ↔ BCM)',
    hexFilter: ['SECRET', 'SEC16'],
    guidance: 'The 16-byte vehicle secret stored in RFHUB and BCM do not match (byte-reversed). This is a deep IMMO mismatch — full sync required.',
    steps: [
      'Run a full sync to re-stamp VIN and synchronize all security tokens.',
      'Both BCM and RFHUB must be flashed.',
      'Power-cycle 30 seconds after flashing.',
    ],
    skipConsequence: 'The IMMO handshake will fail and the vehicle will not start.',
    actions: ['full-sync'],
  };

  if (u.includes('95640') && u.includes('MISMATCH')) return {
    ...base,
    icon: '📟', title: '95640 EEPROM Mismatch',
    hexFilter: ['95640', 'SECRET', 'KEY'],
    guidance: 'The secret key or SEC16 in the 95640 EEPROM does not match RFHUB. The 95640 typically mirrors RFHUB data.',
    steps: [
      'Check the RFHUB for a valid SEC16.',
      'If the 95640 backup key is erased, re-program it from RFHUB.',
      'Use the RFHUB tab for 95640 → RFH or RFH → BCM import tools.',
    ],
    skipConsequence: 'Key backup will be out of sync; re-pairing may fail in some scenarios.',
    actions: [],
  };

  if (u.includes('GPEC2A') && u.includes('KEY')) return {
    ...base, severity: 'error',
    icon: '⚠️', title: 'GPEC2A Key Inconsistency',
    hexFilter: ['GPEC2A', 'KEY'],
    guidance: 'The GPEC2A secret key at 0x0203 and 0x0361 do not match — the PCM image may be corrupt or from a partial write.',
    steps: [
      'Obtain a verified GPEC2A dump for this vehicle.',
      'Run a full sync to re-write VIN and SEC6.',
      'Contact the SRT Lab community for GPEC2A recovery if the PCM is inaccessible.',
    ],
    skipConsequence: 'The PCM may fail IMMO auth unpredictably.',
    actions: [],
  };

  if (u.includes('BCM PN MISMATCH')) return {
    ...base, severity: 'warning',
    icon: '🔢', title: 'BCM Part Number Mismatch',
    hexFilter: [],
    guidance: 'The BCM part number found in the dump does not match the expected part number for the selected vehicle family. This is an informational warning — the BCM may still function, but immobilizer and key-fob pairing behavior may differ.',
    steps: [
      'Confirm the vehicle family selection is correct.',
      'If the BCM PN is unexpected, verify the BCM came from a compatible vehicle model and year.',
      'If you proceed with a mismatched BCM, monitor for key-fob pairing errors after flashing.',
    ],
    skipConsequence: 'The BCM may have reduced compatibility with this vehicle\'s key-fob and immobilizer system.',
    actions: [],
  };

  return {
    ...base,
    icon: '⚠️', title: 'Module Issue',
    hexFilter: [],
    guidance: 'Review the issue carefully and consult the Claude AI assistant below for guidance specific to your module dumps.',
    steps: ['Ask the AI assistant for step-by-step guidance on this specific issue.'],
    skipConsequence: 'This issue will remain unresolved. Check with the AI assistant if skipping is safe.',
    actions: [],
  };
}

/* ─── Parse hex snippet string "Label: HEXHEX..." → { label, hex } ─── */
function parseSnippet(s) {
  const colon = s.indexOf(': ');
  if (colon === -1) return { label: 'Bytes', hex: s.trim() };
  return { label: s.slice(0, colon).trim(), hex: s.slice(colon + 2).trim() };
}

/* ─── Hex Diff Card ─── */
function HexDiffCard({ step, hexSnippets }) {
  if (!hexSnippets || hexSnippets.length === 0) return null;

  const filters = step.hexFilter || [];
  const relevant = hexSnippets.filter(s => {
    if (filters.length === 0) return true;
    const su = s.toUpperCase();
    return filters.some(f => su.includes(f.toUpperCase()));
  });

  if (relevant.length === 0) return null;
  const parsed = relevant.map(parseSnippet);

  /* Try to find RFHUB + BCM pair for side-by-side diff */
  const rfh = parsed.find(p => p.label.toUpperCase().includes('RFHUB'));
  const bcm = parsed.find(p => p.label.toUpperCase().includes('BCM'));
  const hasDiff = rfh && bcm;

  const hexStr = (h) => (h || '').match(/.{1,2}/g)?.join(' ') || h;

  /* Byte-level differ */
  const diffBytes = (a, b) => {
    const ab = (a || '').match(/.{1,2}/g) || [];
    const bb = (b || '').match(/.{1,2}/g) || [];
    const len = Math.max(ab.length, bb.length);
    return Array.from({ length: len }, (_, i) => ({
      a: ab[i] || '??', b: bb[i] || '??',
      diff: ab[i] !== bb[i],
    }));
  };

  return (
    <div style={{
      borderRadius: 8, background: W.s3, border: `1px solid ${W.bd}`,
      padding: '10px 12px', marginBottom: 12, overflow: 'hidden',
    }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: W.ts, letterSpacing: 1.5, marginBottom: 8 }}>
        BYTE CONTEXT {hasDiff ? '· BEFORE SYNC (mismatch highlighted)' : ''}
      </div>

      {hasDiff ? (
        /* Side-by-side diff */
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[{ ...rfh, side: 'a' }, { ...bcm, side: 'b' }].map(({ label, hex, side }) => {
            const bytes = diffBytes(rfh.hex, bcm.hex);
            return (
              <div key={side}>
                <div style={{ fontSize: 10, color: side === 'a' ? W.a2 : W.a3, fontWeight: 800, marginBottom: 4 }}>
                  {label}
                </div>
                <div style={{
                  fontFamily: W.mono, fontSize: 9.5, lineHeight: 1.8,
                  wordBreak: 'break-all', letterSpacing: 1,
                }}>
                  {bytes.map((b, i) => {
                    const val = side === 'a' ? b.a : b.b;
                    return (
                      <span key={i} style={{
                        color: b.diff ? W.er : W.ts,
                        background: b.diff ? W.er + '1A' : 'transparent',
                        borderRadius: 2, padding: '0 1px',
                        fontWeight: b.diff ? 800 : 400,
                      }}>{val} </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        parsed.map((p, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 10, color: W.a2, fontWeight: 800, marginBottom: 3 }}>{p.label}</div>
            <div style={{
              fontFamily: W.mono, fontSize: 9.5, color: W.ts, lineHeight: 1.8,
              wordBreak: 'break-all', letterSpacing: 1,
            }}>{hexStr(p.hex)}</div>
          </div>
        ))
      )}

      {hasDiff && (
        <div style={{ fontSize: 10, color: W.er, marginTop: 6 }}>
          ● <span style={{ fontFamily: W.mono }}>red bytes</span> = mismatch between modules
        </div>
      )}
    </div>
  );
}

/* ─── Streaming Claude chat hook ─── */
function useChatStream() {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const contextRef = useRef(null);
  const messagesRef = useRef([]);

  /* Keep ref in sync */
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const updateContext = useCallback((ctx) => {
    contextRef.current = ctx;
  }, []);

  const sendMessage = useCallback(async (userText) => {
    if (streaming) return;
    const moduleContext = contextRef.current;

    const userMsg = { role: 'user', content: userText };
    const history = [...messagesRef.current, userMsg];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setStreaming(true);
    setError(null);

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(`${API_BASE}/anthropic/module-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          moduleContext,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Network error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          try {
            const parsed = JSON.parse(json);
            if (parsed.done) break;
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.content) {
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: updated[updated.length - 1].content + parsed.content,
                };
                return updated;
              });
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message);
        setMessages(prev => prev.slice(0, -1));
      }
    } finally {
      setStreaming(false);
    }
  }, [streaming]);

  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }, []);

  return { messages, streaming, error, sendMessage, clearMessages, updateContext };
}

/* ─── Chat Panel ─── */
function ChatPanel({ moduleContext, autoGreet }) {
  const { messages, streaming, error, sendMessage, clearMessages, updateContext } = useChatStream();
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const bottomRef = useRef(null);
  const greeted = useRef(false);

  /* Keep Claude context current as wizard state changes */
  useEffect(() => {
    updateContext(moduleContext);
  }, [moduleContext, updateContext]);

  /* Auto-brief on open */
  useEffect(() => {
    if (greeted.current || streaming || messages.length > 0) return;
    if (!autoGreet) return;
    greeted.current = true;
    sendMessage(autoGreet);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    sendMessage(text);
  };

  const quickPrompts = [
    'Walk me through the full sync step by step',
    'What does SEC16 mean and why does it matter?',
    'Which module is the IMMO master?',
    'Is it safe to flash BCM without flashing RFHUB?',
  ];

  return (
    <div style={{
      background: W.surf,
      border: `1px solid ${W.bd}`,
      borderRadius: 14,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      flex: collapsed ? '0 0 auto' : '1 1 auto',
      minHeight: collapsed ? 0 : 240,
      maxHeight: collapsed ? 52 : 420,
      transition: 'all 0.25s ease',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        background: W.s2,
        borderBottom: `1px solid ${W.bd}`,
        display: 'flex', alignItems: 'center', gap: 8,
        flexShrink: 0, cursor: 'pointer',
      }} onClick={() => setCollapsed(c => !c)}>
        <div style={{ fontSize: 16 }}>🤖</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 12, color: W.tx, letterSpacing: 1 }}>CLAUDE AI ASSISTANT</div>
          <div style={{ fontSize: 10, color: W.ts }}>
            {moduleContext?.wizard
              ? `Step ${(moduleContext.wizard.currentStepIndex ?? 0) + 1}/${moduleContext.wizard.totalSteps} · ${moduleContext.wizard.completedSteps?.length ?? 0} resolved`
              : 'Powered by Anthropic · context-aware'}
          </div>
        </div>
        {streaming && <div style={{ fontSize: 10, color: W.a2, fontWeight: 700 }}>● streaming…</div>}
        {messages.length > 0 && !collapsed && (
          <button onClick={e => { e.stopPropagation(); clearMessages(); greeted.current = false; }}
            style={{ background: 'none', border: 'none', color: W.tm, fontSize: 11, cursor: 'pointer', padding: '2px 6px' }}>
            clear
          </button>
        )}
        <div style={{ color: W.tm, fontSize: 13 }}>{collapsed ? '▲' : '▼'}</div>
      </div>

      {!collapsed && (
        <>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && !streaming && (
              <div style={{ color: W.ts, fontSize: 11, textAlign: 'center', padding: '10px 0' }}>
                <div style={{ fontSize: 22, marginBottom: 4 }}>💬</div>
                Module context is pre-loaded. Ask anything about these mismatches.
                <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                  {quickPrompts.map((q, i) => (
                    <button key={i} onClick={() => sendMessage(q)}
                      style={{ background: W.s3, border: `1px solid ${W.bd}`, borderRadius: 20, padding: '4px 10px', fontSize: 10, color: W.ts, cursor: 'pointer', fontFamily: W.sans }}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
                <div style={{
                  fontSize: 15, flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
                  background: msg.role === 'user' ? W.a3 + '30' : W.a2 + '30',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{msg.role === 'user' ? '👤' : '🤖'}</div>
                <div style={{
                  maxWidth: '80%', padding: '8px 12px', borderRadius: 10,
                  background: msg.role === 'user' ? W.a3 + '18' : W.s3,
                  border: `1px solid ${msg.role === 'user' ? W.a3 + '30' : W.bd}`,
                  fontSize: 12, color: W.tx, lineHeight: 1.6,
                  fontFamily: W.sans, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {msg.content || (streaming && i === messages.length - 1
                    ? <span style={{ opacity: 0.5, fontFamily: W.mono }}>▌</span>
                    : null)}
                </div>
              </div>
            ))}
            {error && (
              <div style={{ color: W.er, fontSize: 11, padding: '6px 10px', background: W.er + '14', borderRadius: 8 }}>
                ✗ {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div style={{ padding: '8px 12px', borderTop: `1px solid ${W.bd}`, display: 'flex', gap: 8, flexShrink: 0 }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
              disabled={streaming}
              placeholder="Ask about this mismatch… (Enter to send)"
              rows={2}
              style={{
                flex: 1, background: W.s3, border: `1px solid ${W.bd}`,
                borderRadius: 8, padding: '8px 10px', color: W.tx, fontSize: 12,
                fontFamily: W.sans, resize: 'none', outline: 'none',
                opacity: streaming ? 0.6 : 1,
              }}
            />
            <button onClick={submit} disabled={!input.trim() || streaming} style={{
              background: W.a3, border: 'none', borderRadius: 8, padding: '0 14px',
              color: '#fff', fontWeight: 800, fontSize: 13, cursor: 'pointer',
              opacity: (!input.trim() || streaming) ? 0.4 : 1, flexShrink: 0,
            }}>
              {streaming ? '…' : '→'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Skip confirmation ─── */
function SkipConfirm({ consequence, onConfirm, onCancel }) {
  return (
    <div style={{ padding: 14, borderRadius: 10, marginTop: 10, background: W.wn + '14', border: `2px solid ${W.wn}50` }}>
      <div style={{ fontWeight: 900, fontSize: 12, color: W.wn, marginBottom: 6 }}>⚠ Skipping this step — are you sure?</div>
      <div style={{ fontSize: 12, color: W.tx, lineHeight: 1.6, marginBottom: 10 }}>
        <strong style={{ color: W.wn }}>Consequence:</strong> {consequence}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onConfirm} style={{ background: W.wn, border: 'none', borderRadius: 8, padding: '6px 14px', color: '#000', fontWeight: 900, fontSize: 12, cursor: 'pointer' }}>
          Confirm Skip
        </button>
        <button onClick={onCancel} style={{ background: W.s3, border: `1px solid ${W.bd}`, borderRadius: 8, padding: '6px 14px', color: W.ts, fontSize: 12, cursor: 'pointer' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ─── Compute predicted before/after state for an action ─── */
function computeActionDiff(actionId, hexSnippets) {
  /* Handle both plain "LABEL: HEX" and annotated "LABEL @0xOFFSET: HEX" formats */
  const find = (prefix) => {
    const p = prefix.toUpperCase();
    const s = hexSnippets.find(x => {
      const label = x.split(':')[0].replace(/@0x[0-9A-Fa-f]+\s*$/i, '').trim().toUpperCase();
      return label === p || label.startsWith(p);
    });
    return s ? s.slice(s.indexOf(':') + 1).trim() : null;
  };
  const rfhSec16 = find('RFHUB SEC16');
  const bcmSec16 = find('BCM SEC16');
  const rfhVin   = find('RFHUB VIN');
  const bcmVin   = find('BCM VIN');

  const changes = [];

  const addHexChange = (field, before, after) => {
    if (before && after && before.replace(/\s/g,'') !== after.replace(/\s/g,'')) {
      const ab = (before.replace(/\s/g,'')).match(/.{1,2}/g) || [];
      const bb = (after.replace(/\s/g,'')).match(/.{1,2}/g) || [];
      const len = Math.max(ab.length, bb.length);
      const diff = Array.from({length: len}, (_, i) => ({
        before: ab[i] || '??', after: bb[i] || '??', changed: ab[i] !== bb[i],
      }));
      changes.push({ field, type: 'hex', diff });
    }
  };
  const addStrChange = (field, before, after) => {
    if (before && after && before !== after) changes.push({ field, type: 'str', before, after });
  };

  if (actionId === 'rfh-to-bcm') {
    addStrChange('BCM VIN', bcmVin, rfhVin);
  } else if (actionId === 'bcm-to-rfh') {
    addStrChange('RFHUB VIN', rfhVin, bcmVin);
  } else if (actionId === 'full-sync') {
    addStrChange('BCM VIN', bcmVin, rfhVin);
    addHexChange('BCM SEC16', bcmSec16, rfhSec16);
  } else if (actionId === 'sec16-only') {
    addHexChange('BCM SEC16', bcmSec16, rfhSec16);
  } else if (actionId === 'bcm-sec16-to-rfh') {
    addHexChange('RFHUB SEC16', rfhSec16, bcmSec16);
  }

  return changes;
}

/* ─── Format real patch rows from doSync into diff entries ─── */
function formatRealRows(rows) {
  if (!rows || !rows.length) return [];
  return rows.map(r => ({
    field: `${r.module} Slot ${r.slot} @${r.offset}`,
    type: 'str',
    before: `${r.oldVin || '—'}${r.checkLabel ? ` (${r.checkLabel}: ${r.oldCheck} ${r.oldPass ? '✓' : '✗'})` : ''}`,
    after:  `${r.newVin || '—'}${r.checkLabel ? ` (${r.checkLabel}: ${r.newCheck} ✓)` : ''}`,
  }));
}

/* ─── In-wizard action result banner with before/after diff ─── */
function ActionResult({ actionId, hexSnippets, patchRows, onContinue }) {
  /* Prefer real rows from doSync; fall back to computed prediction */
  const diffs = useMemo(() => {
    const real = formatRealRows(patchRows);
    return real.length > 0 ? real : computeActionDiff(actionId, hexSnippets || []);
  }, [actionId, hexSnippets, patchRows]);

  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, marginTop: 10, background: W.gn + '14', border: `1.5px solid ${W.gn}40` }}>
      <div style={{ fontWeight: 900, fontSize: 13, color: W.gn, marginBottom: 4 }}>
        ✓ Action applied: <span style={{ fontFamily: W.mono, fontSize: 11 }}>{actionId}</span>
      </div>

      {diffs.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: W.ts, letterSpacing: 1, marginBottom: 6 }}>
            BYTE DIFF — BEFORE → AFTER
          </div>
          {diffs.map(d => (
            <div key={d.field} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: W.a2, fontWeight: 800, marginBottom: 3 }}>{d.field}</div>
              {d.type === 'str' ? (
                <div style={{ fontFamily: W.mono, fontSize: 11 }}>
                  <div><span style={{ color: W.er }}>− </span><span style={{ color: W.er }}>{d.before}</span></div>
                  <div><span style={{ color: W.gn }}>+ </span><span style={{ color: W.gn }}>{d.after}</span></div>
                </div>
              ) : (
                <div>
                  {['before', 'after'].map(side => (
                    <div key={side} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontSize: 10, width: 40, color: side === 'before' ? W.er : W.gn, fontWeight: 800 }}>
                        {side === 'before' ? '−' : '+'} {side}
                      </span>
                      <div style={{ fontFamily: W.mono, fontSize: 9.5, lineHeight: 1.8, letterSpacing: 1 }}>
                        {d.diff.map((b, i) => (
                          <span key={i} style={{
                            color: b.changed ? (side === 'before' ? W.er : W.gn) : W.ts,
                            background: b.changed ? (side === 'before' ? W.er : W.gn) + '1A' : 'transparent',
                            borderRadius: 2, padding: '0 1px', fontWeight: b.changed ? 800 : 400,
                          }}>{side === 'before' ? b.before : b.after} </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 12, color: W.ts, marginBottom: 10, lineHeight: 1.5 }}>
        Patched .bin file(s) have been downloaded to your Downloads folder. Flash each module and
        power-cycle the vehicle for 30 seconds to complete the handshake.
      </div>
      <button onClick={onContinue} style={{ background: W.a3, border: 'none', borderRadius: 8, padding: '7px 16px', color: '#fff', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>
        ✓ Looks good — continue →
      </button>
    </div>
  );
}

/* ─── Step card ─── */
function WizardStepCard({ step, stepNum, total, stepActions, hexSnippets, onAction, done, skipped, onMarkDone, onSkip }) {
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const [appliedAction, setAppliedAction] = useState(null);
  const [patchRows, setPatchRows] = useState(null);
  const [actionError, setActionError] = useState(false);

  const clrMap = { error: W.er, warning: W.wn, info: W.a3 };
  const clr = clrMap[step.severity] || W.a3;
  const available = stepActions.filter(a => step.actions.includes(a.id));
  const isResolved = done || skipped || appliedAction;

  const handleAction = (actionId) => {
    setActionError(false);
    const rows = onAction(actionId, step.id);
    if (rows) {
      setAppliedAction(actionId);
      setPatchRows(rows);
    } else {
      /* Action returned no rows — surface failure so user knows to retry */
      setActionError(true);
    }
  };

  return (
    <div style={{
      background: W.surf,
      border: `1.5px solid ${clr}${isResolved ? '30' : '60'}`,
      borderRadius: 14, padding: 18, position: 'relative',
      opacity: (done || skipped) ? 0.78 : 1,
    }}>
      <div style={{ position: 'absolute', top: -10, left: 18, background: clr, color: '#fff', fontSize: 10, fontWeight: 800, padding: '2px 10px', borderRadius: 20, letterSpacing: 1 }}>
        STEP {stepNum} / {total}
      </div>
      {done && <div style={{ position: 'absolute', top: -10, right: 18, background: W.gn, color: '#fff', fontSize: 10, fontWeight: 800, padding: '2px 10px', borderRadius: 20 }}>✓ DONE</div>}
      {skipped && <div style={{ position: 'absolute', top: -10, right: 18, background: W.wn, color: '#000', fontSize: 10, fontWeight: 800, padding: '2px 10px', borderRadius: 20 }}>SKIPPED</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, marginTop: 8 }}>
        <span style={{ fontSize: 22 }}>{step.icon}</span>
        <div>
          <div style={{ fontWeight: 900, fontSize: 14, color: W.tx }}>{step.title}</div>
          <div style={{ fontSize: 10, color: clr, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>{step.severity}</div>
        </div>
      </div>

      <div style={{ fontFamily: W.mono, fontSize: 10, padding: '6px 10px', background: clr + '12', borderRadius: 8, marginBottom: 12, color: clr, wordBreak: 'break-all', lineHeight: 1.5 }}>
        {step.summary}
      </div>

      {/* Hex diff card — shows byte context before any action */}
      <HexDiffCard step={step} hexSnippets={hexSnippets} />

      <div style={{ fontSize: 12, color: W.ts, marginBottom: 12, lineHeight: 1.6 }}>{step.guidance}</div>

      {step.steps.length > 0 && (
        <ol style={{ margin: '0 0 14px 0', paddingLeft: 20, fontSize: 12, color: W.tx, lineHeight: 1.8 }}>
          {step.steps.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
        </ol>
      )}

      {!isResolved && available.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {available.map(a => (
            <button key={a.id} disabled={!a.enabled} onClick={() => handleAction(a.id)} style={{
              background: a.enabled ? W.a2 : W.s3,
              border: `1.5px solid ${a.enabled ? W.a2 : W.bd}`,
              borderRadius: 8, padding: '8px 16px', color: a.enabled ? '#fff' : W.tm,
              fontWeight: 800, fontSize: 12, cursor: a.enabled ? 'pointer' : 'not-allowed',
              fontFamily: W.sans,
            }}>
              {a.label}
            </button>
          ))}
        </div>
      )}

      {!isResolved && available.length === 0 && (
        <div style={{ fontSize: 11, color: W.ts, fontStyle: 'italic', marginBottom: 10 }}>
          No automated fix available — follow the steps above manually or ask the AI assistant.
        </div>
      )}

      {actionError && !appliedAction && (
        <div style={{ padding: '8px 12px', borderRadius: 8, marginTop: 8, background: W.er + '14', border: `1.5px solid ${W.er}40`, color: W.er, fontSize: 12, fontFamily: W.sans }}>
          Action did not complete — modules may not be loaded yet. Check that all required dump files are imported, then try again.
        </div>
      )}

      {appliedAction && !done && <ActionResult actionId={appliedAction} hexSnippets={hexSnippets} patchRows={patchRows} onContinue={() => onMarkDone(step.id)} />}

      {!appliedAction && !done && !skipped && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <button onClick={() => onMarkDone(step.id)} style={{ background: W.gn + '18', border: `1px solid ${W.gn}40`, borderRadius: 8, padding: '5px 12px', color: W.gn, fontSize: 11, cursor: 'pointer', fontWeight: 700, fontFamily: W.sans }}>
            ✓ Mark as resolved
          </button>
          <button onClick={() => setShowSkipConfirm(s => !s)} style={{ background: 'none', border: `1px solid ${W.bd}`, borderRadius: 8, padding: '5px 12px', color: W.tm, fontSize: 11, cursor: 'pointer', fontFamily: W.sans }}>
            Skip step
          </button>
        </div>
      )}

      {done && (
        <button onClick={() => onMarkDone(step.id)} style={{ background: W.gn + '18', border: `1px solid ${W.gn}40`, borderRadius: 8, padding: '5px 12px', color: W.gn, fontSize: 11, cursor: 'pointer', fontWeight: 700, fontFamily: W.sans }}>
          ✓ Marked complete — click to undo
        </button>
      )}

      {showSkipConfirm && (
        <SkipConfirm
          consequence={step.skipConsequence}
          onConfirm={() => { setShowSkipConfirm(false); onSkip(step.id); }}
          onCancel={() => setShowSkipConfirm(false)}
        />
      )}
    </div>
  );
}

/* ─── Summary screen ─── */
function SummaryScreen({ issues, warnings, modules, onStart }) {
  return (
    <div style={{ textAlign: 'center', padding: '18px 0' }}>
      <div style={{ fontSize: 40, marginBottom: 10 }}>🔧</div>
      <div style={{ fontWeight: 900, fontSize: 20, color: W.tx, marginBottom: 6, fontFamily: W.sans }}>Mismatch Resolution Wizard</div>
      <div style={{ fontSize: 13, color: W.ts, marginBottom: 18, lineHeight: 1.6 }}>
        {modules.length > 0 && <><strong style={{ color: W.tx }}>Loaded:</strong> {modules.join(', ')}<br /></>}
        Found <strong style={{ color: W.er }}>{issues.length} error{issues.length !== 1 ? 's' : ''}</strong>
        {warnings.length > 0 && <> and <strong style={{ color: W.wn }}>{warnings.length} warning{warnings.length !== 1 ? 's' : ''}</strong></>}
      </div>
      {issues.map((iss, i) => (
        <div key={i} style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 6, background: W.er + '12', border: `1px solid ${W.er}30`, fontSize: 12, color: W.tx, fontFamily: W.mono, wordBreak: 'break-all', textAlign: 'left' }}>
          ❌ {iss}
        </div>
      ))}
      {warnings.map((w, i) => (
        <div key={i} style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 6, background: W.wn + '12', border: `1px solid ${W.wn}30`, fontSize: 12, color: W.tx, fontFamily: W.mono, wordBreak: 'break-all', textAlign: 'left' }}>
          ⚠️ {w}
        </div>
      ))}
      <button onClick={onStart} style={{
        marginTop: 12,
        background: `linear-gradient(135deg, ${W.sr} 0%, ${W.a1} 100%)`,
        border: 'none', borderRadius: 10, padding: '12px 32px',
        color: '#fff', fontWeight: 900, fontSize: 14, cursor: 'pointer',
        fontFamily: W.sans, letterSpacing: 1,
        boxShadow: '0 4px 20px rgba(211,47,47,0.4)',
      }}>
        START WIZARD →
      </button>
    </div>
  );
}

/* ─── Final checklist screen ─── */
function FinalScreen({ steps, doneSet, skippedSet, onClose, onRerunSync }) {
  const resolved = steps.filter(s => doneSet.has(s.id) || skippedSet.has(s.id)).length;
  const allResolved = resolved === steps.length;
  const anyActionable = steps.some(s => s.actions.length > 0 && doneSet.has(s.id));

  return (
    <div style={{ padding: '18px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>{allResolved ? '🎉' : '📋'}</div>
        <div style={{ fontWeight: 900, fontSize: 18, color: W.tx, marginBottom: 6 }}>
          {allResolved ? 'All Steps Resolved!' : `${resolved} / ${steps.length} Steps Done`}
        </div>
        <div style={{ fontSize: 12, color: W.ts, lineHeight: 1.7 }}>
          {allResolved
            ? 'Patched .bin files were downloaded to your Downloads folder when you applied each action.'
            : 'Complete remaining steps, then return for the final checklist.'}
        </div>
      </div>

      {steps.map(s => {
        const done = doneSet.has(s.id);
        const skipped = skippedSet.has(s.id);
        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, marginBottom: 6, background: done ? W.gn + '12' : skipped ? W.wn + '10' : W.s3, border: `1px solid ${done ? W.gn + '40' : skipped ? W.wn + '30' : W.bd}` }}>
            <span style={{ fontSize: 16 }}>{done ? '✅' : skipped ? '⏭' : '⬜'}</span>
            <span style={{ fontSize: 12, color: done ? W.gn : skipped ? W.wn : W.ts, flex: 1 }}>{s.title}</span>
            {skipped && <span style={{ fontSize: 10, color: W.wn }}>skipped</span>}
          </div>
        );
      })}

      {/* Download shortcut */}
      <div style={{ padding: '12px 16px', borderRadius: 10, marginTop: 14, background: W.a2 + '14', border: `1px solid ${W.a2}30`, fontSize: 12, color: W.tx, lineHeight: 1.7 }}>
        <div style={{ fontWeight: 900, color: W.a2, marginBottom: 6 }}>📥 Patched Files</div>
        <div style={{ color: W.ts, marginBottom: anyActionable ? 10 : 0 }}>
          .bin files were automatically saved to your <strong style={{ color: W.tx }}>Downloads folder</strong> when you ran each sync action.
          Flash them with Flashzilla / AlfaOBD / OBD before power-cycling.
        </div>
        {onRerunSync && (
          <button onClick={onRerunSync} style={{ background: W.a2, border: 'none', borderRadius: 8, padding: '7px 16px', color: '#fff', fontWeight: 800, fontSize: 12, cursor: 'pointer', marginTop: 4 }}>
            ↻ Re-run Full Sync (re-download)
          </button>
        )}
      </div>

      <div style={{ padding: '12px 16px', borderRadius: 10, marginTop: 10, marginBottom: 14, background: W.a1 + '14', border: `1px solid ${W.a1}30`, fontSize: 12, color: W.tx, lineHeight: 1.7 }}>
        <div style={{ fontWeight: 900, color: W.a1, marginBottom: 4 }}>⚡ Post-Flash Checklist</div>
        <div>✓ Flash BCM .bin via OBD / Flashzilla / AlfaOBD</div>
        <div>✓ Flash RFHUB .bin via OBD</div>
        <div>✓ Flash PCM .bin if SEC6 was updated</div>
        <div>✓ Power-cycle vehicle battery for 30 seconds</div>
        <div>✓ Verify with SKIM tab — all keys should pair</div>
      </div>

      <button onClick={onClose} style={{ width: '100%', background: W.gn, border: 'none', borderRadius: 10, padding: '12px 32px', color: '#fff', fontWeight: 900, fontSize: 14, cursor: 'pointer', fontFamily: W.sans, letterSpacing: 1 }}>
        CLOSE WIZARD
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 * Main export
 * ═══════════════════════════════════════════════════════════════ */
export default function MismatchWizard({
  issues = [],
  warnings = [],
  modules = [],
  hexSnippets = [],
  onClose,
  onAction,
  stepActions = [],
}) {
  const [phase, setPhase] = useState('summary');
  const [currentStep, setCurrentStep] = useState(0);
  const [doneSteps, setDoneSteps] = useState(new Set());
  const [skippedSteps, setSkippedSteps] = useState(new Set());
  const overlayRef = useRef(null);

  /* Build and sort steps by priority (VIN → SEC16 → PCM → others → warnings) */
  const steps = useMemo(() => {
    const errorSteps = issues.map(i => issueToStep(i, true));
    const warnSteps  = warnings.map(w => { const s = issueToStep(w, false); if (s.severity === 'error') s.severity = 'warning'; return s; });
    const all = [...errorSteps, ...warnSteps];
    all.sort((a, b) => stepPriority(a.summary, a.severity) - stepPriority(b.summary, b.severity));
    return all.length > 0 ? all : [{
      id: 'no-issues',
      icon: '✅', title: 'No Issues Detected', severity: 'info',
      summary: 'All checked items passed.',
      hexFilter: [],
      guidance: 'No mismatches found. Use the AI assistant to ask questions.',
      steps: [], skipConsequence: '', actions: [],
    }];
  }, [issues, warnings]);

  /* Reactive Claude context includes wizard state */
  const moduleContext = useMemo(() => ({
    modules, issues, warnings, hexSnippets,
    wizard: {
      phase,
      currentStepIndex: currentStep,
      currentStepTitle: steps[currentStep]?.title ?? '',
      totalSteps: steps.length,
      completedSteps: steps.filter(s => doneSteps.has(s.id)).map(s => s.title),
      skippedSteps:   steps.filter(s => skippedSteps.has(s.id)).map(s => s.title),
      remainingSteps: steps.filter(s => !doneSteps.has(s.id) && !skippedSteps.has(s.id)).map(s => s.title),
    },
  }), [modules, issues, warnings, hexSnippets, phase, currentStep, steps, doneSteps, skippedSteps]);

  const autoGreet = issues.length > 0
    ? `I'm diagnosing modules: ${modules.join(', ')}. Found ${issues.length} issue(s): ${issues.slice(0, 2).join('; ')}${issues.length > 2 ? ` and ${issues.length - 2} more` : ''}. Please summarize what's wrong and what I should do first.`
    : warnings.length > 0
    ? `I see these warnings in my module dumps: ${warnings.slice(0, 2).join('; ')}. Can you explain what they mean and whether I need to fix them?`
    : null;

  const toggleDone = (stepId) => {
    setDoneSteps(prev => { const n = new Set(prev); if (n.has(stepId)) n.delete(stepId); else n.add(stepId); return n; });
    setSkippedSteps(prev => { const n = new Set(prev); n.delete(stepId); return n; });
  };

  const skipStep = (stepId) => {
    setSkippedSteps(prev => { const n = new Set(prev); n.add(stepId); return n; });
    setDoneSteps(prev => { const n = new Set(prev); n.delete(stepId); return n; });
  };

  const handleAction = (actionId, stepId) => {
    return onAction?.(actionId, stepId);
    /* Wizard stays open — ActionResult banner shown in-card */
  };

  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onClose?.();
  };

  return (
    <div ref={overlayRef} onClick={handleOverlayClick} style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: W.bg,
        border: `1.5px solid ${W.bd}`,
        borderRadius: 20,
        width: '100%', maxWidth: 860,
        maxHeight: '92vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
      }}>

        {/* Header */}
        <div style={{
          padding: '14px 20px',
          background: `linear-gradient(135deg, ${W.s2} 0%, #1A2D45 100%)`,
          borderBottom: `1px solid ${W.bd}`,
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <div style={{ fontSize: 22 }}>🔧</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 15, color: W.tx, fontFamily: W.sans, letterSpacing: 1 }}>
              MISMATCH RESOLUTION WIZARD
            </div>
            <div style={{ fontSize: 10, color: W.ts, letterSpacing: 2 }}>
              {phase === 'summary' ? 'ISSUE SUMMARY'
                : phase === 'steps' ? `STEP ${currentStep + 1} OF ${steps.length} · ${doneSteps.size} RESOLVED`
                : 'FINAL CHECKLIST'}
              {modules.length > 0 && ` · ${modules.join(' + ')}`}
            </div>
          </div>

          {/* Step dot nav */}
          {phase === 'steps' && steps.length > 1 && (
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              {steps.map((s, i) => (
                <button key={s.id} onClick={() => setCurrentStep(i)} style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: i === currentStep ? W.a3 : doneSteps.has(s.id) ? W.gn : skippedSteps.has(s.id) ? W.wn : W.bd,
                  border: 'none', cursor: 'pointer', padding: 0,
                }} title={s.title} />
              ))}
            </div>
          )}

          <button onClick={onClose} style={{ background: 'none', border: `1px solid ${W.bd}`, borderRadius: 8, padding: '4px 10px', color: W.ts, cursor: 'pointer', fontSize: 13 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '16px 20px 0 20px' }}>
            {phase === 'summary' && (
              <SummaryScreen issues={issues} warnings={warnings} modules={modules}
                onStart={() => { setPhase('steps'); setCurrentStep(0); }} />
            )}

            {phase === 'steps' && (
              <div>
                <WizardStepCard
                  step={steps[currentStep]}
                  stepNum={currentStep + 1}
                  total={steps.length}
                  stepActions={stepActions}
                  hexSnippets={hexSnippets}
                  onAction={handleAction}
                  done={doneSteps.has(steps[currentStep].id)}
                  skipped={skippedSteps.has(steps[currentStep].id)}
                  onMarkDone={toggleDone}
                  onSkip={skipStep}
                />

                <div style={{ display: 'flex', gap: 10, marginTop: 12, marginBottom: 4 }}>
                  <button
                    onClick={() => currentStep > 0 ? setCurrentStep(i => i - 1) : setPhase('summary')}
                    style={{ background: W.s3, border: `1px solid ${W.bd}`, borderRadius: 8, padding: '8px 16px', color: W.ts, cursor: 'pointer', fontSize: 12, fontFamily: W.sans }}>
                    ← {currentStep === 0 ? 'Back to Summary' : 'Previous'}
                  </button>
                  <div style={{ flex: 1 }} />
                  {currentStep < steps.length - 1 ? (
                    <button onClick={() => setCurrentStep(i => i + 1)} style={{ background: W.a3, border: 'none', borderRadius: 8, padding: '8px 18px', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 800, fontFamily: W.sans }}>
                      Next Step →
                    </button>
                  ) : (
                    <button onClick={() => setPhase('final')} style={{ background: `linear-gradient(135deg, ${W.gn} 0%, ${W.a2} 100%)`, border: 'none', borderRadius: 8, padding: '8px 20px', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 900, fontFamily: W.sans }}>
                      View Checklist ✓
                    </button>
                  )}
                </div>
              </div>
            )}

            {phase === 'final' && (
              <FinalScreen
                steps={steps}
                doneSet={doneSteps}
                skippedSet={skippedSteps}
                onClose={onClose}
                onRerunSync={stepActions.some(a => a.id === 'full-sync' && a.enabled)
                  ? () => handleAction('full-sync', 'final')
                  : undefined}
              />
            )}
          </div>

          {/* Claude chat — always visible */}
          <div style={{ flexShrink: 0, padding: '10px 20px 16px 20px' }}>
            <ChatPanel moduleContext={moduleContext} autoGreet={autoGreet} />
          </div>
        </div>
      </div>
    </div>
  );
}
