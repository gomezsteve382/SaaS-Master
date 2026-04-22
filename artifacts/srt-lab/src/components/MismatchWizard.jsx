import React, { useState, useRef, useEffect, useCallback } from "react";

/* ============================================================================
 * MismatchWizard — Guided resolution wizard + Claude AI chat panel
 *
 * Props:
 *   issues      : string[]  — error-level issues
 *   warnings    : string[]  — warning-level items
 *   modules     : string[]  — loaded module names
 *   hexSnippets : string[]  — hex values for AI context
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

/* ─── Deterministic ID from issue string (djb2-style) ─── */
function stableId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return 'step-' + (h >>> 0).toString(36);
}

/* ─── Resolve issue → guided step ─── */
function issueToStep(issue) {
  const u = issue.toUpperCase();
  const id = stableId(issue);

  if (u.includes('VIN MISMATCH')) return {
    id,
    icon: '🪪',
    title: 'VIN Mismatch',
    severity: 'error',
    summary: issue,
    guidance: 'These modules came from different vehicles. The VIN must be re-stamped so both modules report the same chassis ID.',
    steps: [
      'Confirm which VIN is correct — it should match the vehicle\'s dashboard sticker or title.',
      'Click the sync action below. The correct VIN will be written to both BCM and RFHUB.',
      'After flashing, power-cycle the vehicle for 30 seconds to allow the modules to handshake.',
    ],
    skipConsequence: 'Leaving a VIN mismatch means the modules will continue to report conflicting chassis IDs. Key fob pairing and immobilizer authentication may fail.',
    actions: ['full-sync', 'rfh-to-bcm', 'bcm-to-rfh'],
  };

  if (u.includes('SEC16') && (u.includes('MISMATCH') || u.includes('INVALID'))) return {
    id,
    icon: '🔐',
    title: 'SEC16 Security Token Mismatch',
    severity: 'error',
    summary: issue,
    guidance: 'The 16-byte IMMO security token differs between BCM and RFHUB. In the standard flow, RFHUB is master — its SEC16 is written (reversed) into the BCM, and the first 6 bytes become the PCM SEC6.',
    steps: [
      'Confirm the RFHUB SEC16 is valid (non-blank, slots 1 & 2 match).',
      'Use "SEC16 Sync Only" to write the RFHUB SEC16 to BCM and PCM without changing VINs.',
      'If RFHUB came from a different vehicle, use "BCM SEC16 → RFHUB" to make BCM the master instead.',
      'Flash the patched file(s) and power-cycle 30 seconds.',
    ],
    skipConsequence: 'Skipping SEC16 sync means the immobilizer handshake will fail — the vehicle will not start.',
    actions: ['sec16-only', 'bcm-sec16-to-rfh'],
  };

  if (u.includes('BCM SEC16 → RFHUB') || u.includes('BCM → RFH')) return {
    id,
    icon: '🔄',
    title: 'BCM SEC16 → RFHUB Sync',
    severity: 'warning',
    summary: issue,
    guidance: 'The BCM has a valid SEC16 but the RFHUB is from a different vehicle. Use BCM as the master and write its SEC16 into the RFHUB Gen2 slots.',
    steps: [
      'Verify the BCM SEC16 is non-blank and consistent.',
      'Click "BCM SEC16 → RFHUB" button.',
      'Flash the patched RFHUB, then power-cycle 30 seconds.',
    ],
    skipConsequence: 'The RFHUB will retain a mismatched SEC16, preventing secure key pairing.',
    actions: ['bcm-sec16-to-rfh'],
  };

  if (u.includes('PCM SEC6') || u.includes('IMMO_DAMAGED')) return {
    id,
    icon: '⚙️',
    title: 'PCM SEC6 Damaged / Mismatch',
    severity: 'error',
    summary: issue,
    guidance: 'The PCM IMMO SEC6 is damaged (all FF) or does not match RFHUB SEC16[0:6]. The PCM will reject the immobilizer handshake until corrected.',
    steps: [
      'Load a valid RFHUB with a known-good SEC16.',
      'Run a full sync or SEC16-only sync — this also writes the PCM SEC6.',
      'Flash the patched PCM and power-cycle 30 seconds.',
    ],
    skipConsequence: 'Vehicle will not start — the PCM will reject all immobilizer tokens.',
    actions: ['full-sync', 'sec16-only'],
  };

  if (u.includes('RFHUB') && u.includes('VEHICLE SECRET') && u.includes('MISMATCH')) return {
    id,
    icon: '🔑',
    title: 'Vehicle Secret Mismatch (RFHUB ↔ BCM)',
    severity: 'error',
    summary: issue,
    guidance: 'The 16-byte vehicle secret stored in RFHUB and BCM do not match (byte-reversed). This is a deep IMMO mismatch — full sync is required.',
    steps: [
      'Run a full sync to re-stamp VIN and synchronize all security tokens.',
      'Both BCM and RFHUB must be flashed.',
      'Power-cycle 30 seconds after flashing.',
    ],
    skipConsequence: 'The IMMO handshake will fail and the vehicle will not start.',
    actions: ['full-sync'],
  };

  if (u.includes('95640') && u.includes('MISMATCH')) return {
    id,
    icon: '📟',
    title: '95640 EEPROM Mismatch',
    severity: 'error',
    summary: issue,
    guidance: 'The secret key or SEC16 stored in the 95640 EEPROM does not match the RFHUB. The 95640 typically mirrors RFHUB data.',
    steps: [
      'Check the RFHUB for a valid SEC16.',
      'If the 95640 backup key is erased, re-program it from RFHUB.',
      'Use the RFHUB tab for 95640 → RFH or RFH → BCM import tools.',
    ],
    skipConsequence: 'Key backup will be out of sync; re-pairing may fail in some scenarios.',
    actions: [],
  };

  if (u.includes('GPEC2A') && u.includes('KEY INCONSISTENT')) return {
    id,
    icon: '⚠️',
    title: 'GPEC2A Key Inconsistency',
    severity: 'error',
    summary: issue,
    guidance: 'The GPEC2A secret key at 0x0203 and 0x0361 do not match — the PCM image may be corrupt or from a partial write.',
    steps: [
      'Obtain a verified GPEC2A dump for this vehicle.',
      'Run a full sync to re-write VIN and SEC6.',
      'Contact the SRT Lab community for GPEC2A recovery if the PCM is inaccessible.',
    ],
    skipConsequence: 'The PCM may fail IMMO auth unpredictably.',
    actions: [],
  };

  return {
    id,
    icon: '⚠️',
    title: 'Module Issue',
    severity: u.includes('MISMATCH') || u.includes('DAMAGED') ? 'error' : 'warning',
    summary: issue,
    guidance: 'Review the issue carefully and consult the Claude AI assistant below for guidance specific to your module dumps.',
    steps: ['Ask the AI assistant for step-by-step guidance on this specific issue.'],
    skipConsequence: 'This issue will remain unresolved. Check with the AI assistant if skipping is safe.',
    actions: [],
  };
}

/* ─── Streaming Claude chat hook ─── */
function useChatStream(moduleContext) {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const sendMessage = useCallback(async (userText, opts = {}) => {
    if (streaming) return;
    const { silent = false } = opts;

    const userMsg = { role: 'user', content: userText };
    const newHistory = [...messages, userMsg];
    if (!silent) setMessages(newHistory);
    else setMessages(h => [...h, userMsg]);
    setStreaming(true);
    setError(null);

    const assistantMsg = { role: 'assistant', content: '' };
    setMessages(h => [...h, assistantMsg]);

    const historyToSend = silent ? [...messages, userMsg] : newHistory;

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(`${API_BASE}/anthropic/module-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: historyToSend, moduleContext }),
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
  }, [messages, streaming, moduleContext]);

  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }, []);

  return { messages, streaming, error, sendMessage, clearMessages };
}

/* ─── Chat Panel ─── */
function ChatPanel({ moduleContext, contextHint, autoGreet }) {
  const { messages, streaming, error, sendMessage, clearMessages } = useChatStream(moduleContext);
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const bottomRef = useRef(null);
  const greeted = useRef(false);

  /* Auto-brief on mount when there are issues */
  useEffect(() => {
    if (greeted.current || streaming || messages.length > 0) return;
    if (!autoGreet) return;
    greeted.current = true;
    sendMessage(autoGreet);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    sendMessage(text);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
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
      minHeight: collapsed ? 0 : 260,
      maxHeight: collapsed ? 52 : 440,
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
          <div style={{ fontSize: 10, color: W.ts }}>Powered by Anthropic · context-aware</div>
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
                    <button key={i} onClick={() => { setInput(''); sendMessage(q); }}
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
              onKeyDown={handleKey}
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
    <div style={{
      padding: 14, borderRadius: 10, marginTop: 10,
      background: W.wn + '14', border: `2px solid ${W.wn}50`,
    }}>
      <div style={{ fontWeight: 900, fontSize: 12, color: W.wn, marginBottom: 6 }}>⚠ Skipping this step — are you sure?</div>
      <div style={{ fontSize: 12, color: W.tx, lineHeight: 1.6, marginBottom: 10 }}>
        <strong style={{ color: W.wn }}>Consequence:</strong> {consequence}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onConfirm} style={{
          background: W.wn, border: 'none', borderRadius: 8,
          padding: '6px 14px', color: '#000', fontWeight: 900, fontSize: 12, cursor: 'pointer',
        }}>Confirm Skip</button>
        <button onClick={onCancel} style={{
          background: W.s3, border: `1px solid ${W.bd}`, borderRadius: 8,
          padding: '6px 14px', color: W.ts, fontSize: 12, cursor: 'pointer',
        }}>Cancel</button>
      </div>
    </div>
  );
}

/* ─── Action Result Banner ─── */
function ActionResult({ actionId, onContinue }) {
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 10, marginTop: 10,
      background: W.gn + '14', border: `1.5px solid ${W.gn}40`,
    }}>
      <div style={{ fontWeight: 900, fontSize: 13, color: W.gn, marginBottom: 4 }}>
        ✓ Action applied: <span style={{ fontFamily: W.mono, fontSize: 11 }}>{actionId}</span>
      </div>
      <div style={{ fontSize: 12, color: W.ts, marginBottom: 10, lineHeight: 1.5 }}>
        Patched .bin file(s) have been downloaded. Flash them to the module(s) and power-cycle
        the vehicle for 30 seconds to complete the handshake.
      </div>
      <button onClick={onContinue} style={{
        background: W.a3, border: 'none', borderRadius: 8,
        padding: '7px 16px', color: '#fff', fontWeight: 800, fontSize: 12, cursor: 'pointer',
      }}>
        ✓ Looks good — continue →
      </button>
    </div>
  );
}

/* ─── Step card ─── */
function WizardStepCard({ step, stepNum, total, stepActions, onAction, done, skipped, onMarkDone, onSkip }) {
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const [appliedAction, setAppliedAction] = useState(null);

  const colors = { error: W.er, warning: W.wn, info: W.a3 };
  const clr = colors[step.severity] || W.a3;
  const availableActions = stepActions.filter(a => step.actions.includes(a.id));

  const handleAction = (actionId) => {
    onAction(actionId, step.id);
    setAppliedAction(actionId);
  };

  const isResolved = done || skipped || appliedAction;

  return (
    <div style={{
      background: W.surf,
      border: `1.5px solid ${clr}${isResolved ? '30' : '60'}`,
      borderRadius: 14,
      padding: 18,
      position: 'relative',
      opacity: (done || skipped) ? 0.75 : 1,
    }}>
      <div style={{
        position: 'absolute', top: -10, left: 18,
        background: clr, color: '#fff',
        fontSize: 10, fontWeight: 800, padding: '2px 10px', borderRadius: 20, letterSpacing: 1,
      }}>
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

      <div style={{
        fontFamily: W.mono, fontSize: 10, padding: '6px 10px',
        background: clr + '12', borderRadius: 8, marginBottom: 12,
        color: clr, wordBreak: 'break-all', lineHeight: 1.5,
      }}>{step.summary}</div>

      <div style={{ fontSize: 12, color: W.ts, marginBottom: 12, lineHeight: 1.6 }}>{step.guidance}</div>

      {step.steps.length > 0 && (
        <ol style={{ margin: '0 0 14px 0', paddingLeft: 20, fontSize: 12, color: W.tx, lineHeight: 1.8 }}>
          {step.steps.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
        </ol>
      )}

      {!isResolved && availableActions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {availableActions.map(a => (
            <button key={a.id} disabled={!a.enabled} onClick={() => handleAction(a.id)} style={{
              background: a.enabled ? W.a2 : W.s3,
              border: `1.5px solid ${a.enabled ? W.a2 : W.bd}`,
              borderRadius: 8, padding: '8px 16px', color: a.enabled ? '#fff' : W.tm,
              fontWeight: 800, fontSize: 12, cursor: a.enabled ? 'pointer' : 'not-allowed',
              fontFamily: W.sans, letterSpacing: 0.5,
            }}>
              {a.label}
            </button>
          ))}
        </div>
      )}

      {!isResolved && availableActions.length === 0 && (
        <div style={{ fontSize: 11, color: W.ts, fontStyle: 'italic', marginBottom: 10 }}>
          No automated fix available — follow the steps above manually or ask the AI assistant.
        </div>
      )}

      {/* Action result in-wizard confirmation */}
      {appliedAction && !done && (
        <ActionResult actionId={appliedAction} onContinue={() => onMarkDone(step.id)} />
      )}

      {/* Manual mark done + skip */}
      {!appliedAction && !done && !skipped && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <button onClick={() => onMarkDone(step.id)} style={{
            background: W.gn + '18', border: `1px solid ${W.gn}40`,
            borderRadius: 8, padding: '5px 12px', color: W.gn,
            fontSize: 11, cursor: 'pointer', fontWeight: 700, fontFamily: W.sans,
          }}>✓ Mark as resolved</button>
          <button onClick={() => setShowSkipConfirm(s => !s)} style={{
            background: 'none', border: `1px solid ${W.bd}`,
            borderRadius: 8, padding: '5px 12px', color: W.tm,
            fontSize: 11, cursor: 'pointer', fontFamily: W.sans,
          }}>Skip step</button>
        </div>
      )}

      {done && (
        <button onClick={() => onMarkDone(step.id)} style={{
          background: W.gn + '18', border: `1px solid ${W.gn}40`, borderRadius: 8,
          padding: '5px 12px', color: W.gn, fontSize: 11, cursor: 'pointer', fontWeight: 700, fontFamily: W.sans,
        }}>✓ Marked complete — click to undo</button>
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
function FinalScreen({ steps, doneSet, skippedSet, onClose }) {
  const resolved = steps.filter(s => doneSet.has(s.id) || skippedSet.has(s.id)).length;
  const allResolved = resolved === steps.length;

  return (
    <div style={{ padding: '18px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>{allResolved ? '🎉' : '📋'}</div>
        <div style={{ fontWeight: 900, fontSize: 18, color: W.tx, marginBottom: 6 }}>
          {allResolved ? 'All Steps Resolved!' : `${resolved} / ${steps.length} Steps Done`}
        </div>
        <div style={{ fontSize: 12, color: W.ts, lineHeight: 1.7 }}>
          {allResolved
            ? 'Flash the patched .bin files to your modules and power-cycle 30 seconds.'
            : 'Complete remaining steps, then return for the final checklist.'}
        </div>
      </div>

      {steps.map(s => {
        const done = doneSet.has(s.id);
        const skipped = skippedSet.has(s.id);
        return (
          <div key={s.id} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
            borderRadius: 8, marginBottom: 6,
            background: done ? W.gn + '12' : skipped ? W.wn + '10' : W.s3,
            border: `1px solid ${done ? W.gn + '40' : skipped ? W.wn + '30' : W.bd}`,
          }}>
            <span style={{ fontSize: 16 }}>{done ? '✅' : skipped ? '⏭' : '⬜'}</span>
            <span style={{ fontSize: 12, color: done ? W.gn : skipped ? W.wn : W.ts, flex: 1 }}>
              {s.title}
            </span>
            {skipped && <span style={{ fontSize: 10, color: W.wn }}>skipped</span>}
          </div>
        );
      })}

      <div style={{
        padding: '12px 16px', borderRadius: 10, marginTop: 14, marginBottom: 14,
        background: W.a1 + '14', border: `1px solid ${W.a1}30`,
        fontSize: 12, color: W.tx, lineHeight: 1.7,
      }}>
        <div style={{ fontWeight: 900, color: W.a1, marginBottom: 4 }}>⚡ Post-Flash Checklist</div>
        <div>✓ Flash BCM .bin via OBD / Flashzilla / AlfaOBD</div>
        <div>✓ Flash RFHUB .bin via OBD</div>
        <div>✓ Flash PCM .bin if SEC6 was updated</div>
        <div>✓ Power-cycle vehicle battery for 30 seconds</div>
        <div>✓ Verify with SKIM tab — all keys should pair</div>
      </div>

      <button onClick={onClose} style={{
        width: '100%', background: W.gn, border: 'none', borderRadius: 10,
        padding: '12px 32px', color: '#fff', fontWeight: 900, fontSize: 14,
        cursor: 'pointer', fontFamily: W.sans, letterSpacing: 1,
      }}>
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

  const allItems = [
    ...issues.map(i => ({ ...issueToStep(i), _fromIssue: true })),
    ...warnings.map(w => {
      const s = issueToStep(w);
      if (s.severity === 'error') s.severity = 'warning';
      return { ...s, _fromIssue: false };
    }),
  ];

  const steps = allItems.length > 0 ? allItems : [{
    id: 'no-issues',
    icon: '✅',
    title: 'No Issues Detected',
    severity: 'info',
    summary: 'All checked items passed.',
    guidance: 'No mismatches were found. Use the AI assistant to ask questions.',
    steps: [],
    skipConsequence: '',
    actions: [],
  }];

  const moduleContext = { modules, issues, warnings, hexSnippets };

  /* Auto-greet: first issue summary */
  const autoGreet = issues.length > 0
    ? `I'm looking at these modules: ${modules.join(', ')}. I found ${issues.length} issue(s): ${issues.slice(0, 2).join('; ')}${issues.length > 2 ? ` and ${issues.length - 2} more` : ''}. Please summarize what's wrong and what I should do first.`
    : warnings.length > 0
    ? `I see these warnings in my module dumps: ${warnings.slice(0, 2).join('; ')}. Can you explain what they mean and whether I need to fix them?`
    : null;

  const toggleDone = (stepId) => {
    setDoneSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
      return next;
    });
    setSkippedSteps(prev => { const next = new Set(prev); next.delete(stepId); return next; });
  };

  const skipStep = (stepId) => {
    setSkippedSteps(prev => { const next = new Set(prev); next.add(stepId); return next; });
    setDoneSteps(prev => { const next = new Set(prev); next.delete(stepId); return next; });
  };

  const handleAction = (actionId, stepId) => {
    onAction?.(actionId, stepId);
    /* Don't close wizard — action result shown in-card */
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
        width: '100%', maxWidth: 840,
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
              {phase === 'summary' ? 'ISSUE SUMMARY' : phase === 'steps' ? `STEP ${currentStep + 1} OF ${steps.length}` : 'FINAL CHECKLIST'}
              {modules.length > 0 && ` · ${modules.join(' + ')}`}
            </div>
          </div>

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

          <button onClick={onClose} style={{
            background: 'none', border: `1px solid ${W.bd}`, borderRadius: 8,
            padding: '4px 10px', color: W.ts, cursor: 'pointer', fontSize: 13,
          }}>✕</button>
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
                    <button onClick={() => setCurrentStep(i => i + 1)} style={{
                      background: W.a3, border: 'none', borderRadius: 8,
                      padding: '8px 18px', color: '#fff', cursor: 'pointer',
                      fontSize: 12, fontWeight: 800, fontFamily: W.sans,
                    }}>
                      Next Step →
                    </button>
                  ) : (
                    <button onClick={() => setPhase('final')} style={{
                      background: `linear-gradient(135deg, ${W.gn} 0%, ${W.a2} 100%)`,
                      border: 'none', borderRadius: 8, padding: '8px 20px',
                      color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 900, fontFamily: W.sans,
                    }}>
                      View Checklist ✓
                    </button>
                  )}
                </div>
              </div>
            )}

            {phase === 'final' && (
              <FinalScreen steps={steps} doneSet={doneSteps} skippedSet={skippedSteps} onClose={onClose} />
            )}
          </div>

          {/* Claude chat — always visible */}
          <div style={{ flexShrink: 0, padding: '10px 20px 16px 20px' }}>
            <ChatPanel
              moduleContext={moduleContext}
              contextHint={autoGreet}
              autoGreet={autoGreet}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
