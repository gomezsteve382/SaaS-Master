import React, { useState, useRef, useEffect, useCallback } from "react";

/* ============================================================================
 * MismatchWizard — Guided resolution wizard + Claude AI chat panel
 *
 * Props:
 *   issues     : string[]  — error-level issues from crossValidate / ModuleSync
 *   warnings   : string[]  — warning-level items
 *   modules    : string[]  — loaded module names, e.g. ['BCM', 'RFHUB']
 *   hexSnippets: string[]  — optional hex values for AI context
 *   onClose    : () => void
 *   onAction   : (actionId: string) => void  — callback for wizard action buttons
 *   stepActions: { id, label, enabled, description }[]  — available action buttons from parent
 * ============================================================================ */

const W = {
  bg:   '#0E1620',
  surf: '#151F2E',
  s2:   '#1C2A3D',
  s3:   '#243347',
  bd:   '#2C3E56',
  sr:   '#D32F2F',
  sl:   '#FF5252',
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

/* Base URL for API calls */
const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') + '/api';

/* ─── Resolve issue → guided step ─── */
function issueToStep(issue) {
  const u = issue.toUpperCase();

  if (u.includes('VIN MISMATCH')) return {
    id: 'vin-mismatch',
    icon: '🪪',
    title: 'VIN Mismatch',
    severity: 'error',
    summary: issue,
    guidance: 'These modules came from different vehicles. The VIN must be re-stamped so both modules report the same chassis ID.',
    steps: [
      'Confirm which VIN is correct — it should match the vehicle\'s dashboard sticker or title.',
      'Use the SYNC button in Module Sync to write the correct VIN to both BCM and RFHUB.',
      'After flashing, power-cycle the vehicle for 30 seconds to allow the modules to handshake.',
    ],
    actions: ['full-sync'],
  };

  if (u.includes('SEC16') && (u.includes('MISMATCH') || u.includes('INVALID'))) return {
    id: 'sec16-mismatch',
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
    actions: ['sec16-only', 'bcm-sec16-to-rfh'],
  };

  if (u.includes('BCM SEC16 → RFHUB') || u.includes('BCM → RFH')) return {
    id: 'bcm-to-rfh',
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
    actions: ['bcm-sec16-to-rfh'],
  };

  if (u.includes('PCM SEC6') || u.includes('IMMO_DAMAGED')) return {
    id: 'pcm-sec6',
    icon: '⚙️',
    title: 'PCM SEC6 Damaged / Mismatch',
    severity: 'error',
    summary: issue,
    guidance: 'The PCM IMMO SEC6 is damaged (all FF) or does not match RFHUB SEC16[0:6]. The PCM will reject the immobilizer handshake until this is corrected.',
    steps: [
      'Load a valid RFHUB with a known-good SEC16.',
      'Run a full sync or SEC16-only sync — this also writes the PCM SEC6.',
      'Flash the patched PCM and power-cycle 30 seconds.',
    ],
    actions: ['full-sync', 'sec16-only'],
  };

  if (u.includes('RFHUB') && u.includes('VEHICLE SECRET') && u.includes('MISMATCH')) return {
    id: 'vehicle-secret',
    icon: '🔑',
    title: 'Vehicle Secret Mismatch (RFHUB ↔ BCM)',
    severity: 'error',
    summary: issue,
    guidance: 'The 16-byte vehicle secret stored in RFHUB and BCM do not match (byte-reversed). This is a deep IMMO mismatch — full sync including SEC16 is required.',
    steps: [
      'Run a full sync to re-stamp VIN and synchronize all security tokens.',
      'Both BCM and RFHUB must be flashed.',
      'Power-cycle 30 seconds after flashing.',
    ],
    actions: ['full-sync'],
  };

  if (u.includes('95640') && u.includes('MISMATCH')) return {
    id: 'eeprom-mismatch',
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
    actions: [],
  };

  if (u.includes('GPEC2A') && u.includes('KEY INCONSISTENT')) return {
    id: 'gpec-key',
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
    actions: [],
  };

  /* Generic fallback */
  return {
    id: 'generic-' + Math.random().toString(36).slice(2, 7),
    icon: '⚠️',
    title: 'Module Issue',
    severity: u.includes('MISMATCH') || u.includes('DAMAGED') ? 'error' : 'warning',
    summary: issue,
    guidance: 'Review the issue carefully and consult the Claude AI panel below for guidance specific to your module dumps.',
    steps: ['Ask the AI assistant for step-by-step guidance on this specific issue.'],
    actions: [],
  };
}

/* ─── Streaming Claude chat hook ─── */
function useChatStream(moduleContext) {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const sendMessage = useCallback(async (userText) => {
    if (streaming) return;

    const userMsg = { role: 'user', content: userText };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setStreaming(true);
    setError(null);

    const assistantMsg = { role: 'assistant', content: '' };
    setMessages([...newHistory, assistantMsg]);

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(`${API_BASE}/anthropic/module-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newHistory, moduleContext }),
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
function ChatPanel({ moduleContext, contextHint }) {
  const { messages, streaming, error, sendMessage, clearMessages } = useChatStream(moduleContext);
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const bottomRef = useRef(null);

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
    contextHint || 'Explain these issues and what I should do first',
    'Walk me through the full sync step by step',
    'What does SEC16 mean and why does it matter?',
    'Which module is the IMMO master?',
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
      minHeight: collapsed ? 0 : 280,
      maxHeight: collapsed ? 52 : 480,
      transition: 'all 0.25s ease',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        background: W.s2,
        borderBottom: `1px solid ${W.bd}`,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        cursor: 'pointer',
      }} onClick={() => setCollapsed(c => !c)}>
        <div style={{ fontSize: 16 }}>🤖</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 12, color: W.tx, letterSpacing: 1 }}>CLAUDE AI ASSISTANT</div>
          <div style={{ fontSize: 10, color: W.ts }}>Powered by Anthropic · context-aware</div>
        </div>
        {messages.length > 0 && !collapsed && (
          <button onClick={e => { e.stopPropagation(); clearMessages(); }}
            style={{ background: 'none', border: 'none', color: W.tm, fontSize: 11, cursor: 'pointer', padding: '2px 6px' }}>
            clear
          </button>
        )}
        <div style={{ color: W.tm, fontSize: 13, marginLeft: 4 }}>{collapsed ? '▲' : '▼'}</div>
      </div>

      {!collapsed && (
        <>
          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ color: W.ts, fontSize: 11, textAlign: 'center', padding: '14px 0' }}>
                <div style={{ fontSize: 24, marginBottom: 6 }}>💬</div>
                Module context is pre-loaded. Ask anything about these mismatches.
                <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                  {quickPrompts.map((q, i) => (
                    <button key={i} onClick={() => { setInput(''); sendMessage(q); }}
                      style={{
                        background: W.s3, border: `1px solid ${W.bd}`, borderRadius: 20,
                        padding: '4px 10px', fontSize: 10, color: W.ts, cursor: 'pointer',
                        fontFamily: W.sans,
                      }}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
                <div style={{
                  fontSize: 16, flexShrink: 0, width: 28, height: 28,
                  borderRadius: '50%', background: msg.role === 'user' ? W.a3 + '30' : W.a2 + '30',
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
                    ? <span style={{ opacity: 0.5 }}>▌</span>
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

          {/* Input */}
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
              opacity: (!input.trim() || streaming) ? 0.4 : 1,
              flexShrink: 0,
            }}>
              {streaming ? '…' : '→'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Step card ─── */
function WizardStepCard({ step, stepNum, total, stepActions, onAction, done, onMarkDone }) {
  const colors = { error: W.er, warning: W.wn, info: W.a3 };
  const clr = colors[step.severity] || W.a3;

  const availableActions = stepActions.filter(a => step.actions.includes(a.id));

  return (
    <div style={{
      background: W.surf,
      border: `1.5px solid ${clr}40`,
      borderRadius: 14,
      padding: 18,
      position: 'relative',
      opacity: done ? 0.65 : 1,
    }}>
      {/* Step badge */}
      <div style={{
        position: 'absolute', top: -10, left: 18,
        background: clr, color: '#fff',
        fontSize: 10, fontWeight: 800, padding: '2px 10px', borderRadius: 20,
        letterSpacing: 1,
      }}>
        STEP {stepNum} / {total}
      </div>

      {done && (
        <div style={{
          position: 'absolute', top: -10, right: 18,
          background: W.gn, color: '#fff',
          fontSize: 10, fontWeight: 800, padding: '2px 10px', borderRadius: 20,
        }}>✓ DONE</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, marginTop: 8 }}>
        <span style={{ fontSize: 22 }}>{step.icon}</span>
        <div>
          <div style={{ fontWeight: 900, fontSize: 14, color: W.tx }}>{step.title}</div>
          <div style={{ fontSize: 10, color: clr, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>
            {step.severity}
          </div>
        </div>
      </div>

      {/* Issue text */}
      <div style={{
        fontFamily: W.mono, fontSize: 10, padding: '6px 10px',
        background: clr + '12', borderRadius: 8, marginBottom: 12,
        color: clr, wordBreak: 'break-all', lineHeight: 1.5,
      }}>
        {step.summary}
      </div>

      {/* Guidance */}
      <div style={{ fontSize: 12, color: W.ts, marginBottom: 12, lineHeight: 1.6 }}>
        {step.guidance}
      </div>

      {/* Sub-steps */}
      {step.steps.length > 0 && (
        <ol style={{ margin: '0 0 14px 0', paddingLeft: 20, fontSize: 12, color: W.tx, lineHeight: 1.8 }}>
          {step.steps.map((s, i) => (
            <li key={i} style={{ marginBottom: 4 }}>{s}</li>
          ))}
        </ol>
      )}

      {/* Action buttons */}
      {availableActions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {availableActions.map(a => (
            <button key={a.id} disabled={!a.enabled || done} onClick={() => onAction(a.id)} style={{
              background: a.enabled ? W.a2 : W.s3,
              border: `1.5px solid ${a.enabled ? W.a2 : W.bd}`,
              borderRadius: 8, padding: '8px 16px', color: a.enabled ? '#fff' : W.tm,
              fontWeight: 800, fontSize: 12, cursor: a.enabled ? 'pointer' : 'not-allowed',
              fontFamily: W.sans, letterSpacing: 0.5,
              opacity: done ? 0.5 : 1,
            }}>
              {a.label}
            </button>
          ))}
        </div>
      )}

      {availableActions.length === 0 && (
        <div style={{ fontSize: 11, color: W.ts, fontStyle: 'italic', marginBottom: 10 }}>
          No automated fix available — follow the steps above manually or ask the AI assistant.
        </div>
      )}

      {/* Mark done */}
      <button onClick={onMarkDone} style={{
        background: done ? W.gn + '20' : W.s3,
        border: `1px solid ${done ? W.gn : W.bd}`,
        borderRadius: 8, padding: '5px 12px', color: done ? W.gn : W.tm,
        fontSize: 11, cursor: 'pointer', fontWeight: 700, fontFamily: W.sans,
      }}>
        {done ? '✓ Marked complete' : 'Mark as resolved'}
      </button>
    </div>
  );
}

/* ─── Summary screen ─── */
function SummaryScreen({ issues, warnings, modules, onStart }) {
  return (
    <div style={{ textAlign: 'center', padding: '20px 0' }}>
      <div style={{ fontSize: 44, marginBottom: 12 }}>🔧</div>
      <div style={{ fontWeight: 900, fontSize: 20, color: W.tx, marginBottom: 6, fontFamily: W.sans }}>
        Mismatch Resolution Wizard
      </div>
      <div style={{ fontSize: 13, color: W.ts, marginBottom: 20, lineHeight: 1.6 }}>
        {modules.length > 0 && (
          <>Modules loaded: <strong style={{ color: W.tx }}>{modules.join(', ')}</strong><br /></>
        )}
        Found <strong style={{ color: W.er }}>{issues.length} error{issues.length !== 1 ? 's' : ''}</strong>
        {warnings.length > 0 && <> and <strong style={{ color: W.wn }}>{warnings.length} warning{warnings.length !== 1 ? 's' : ''}</strong></>}
      </div>

      {issues.length > 0 && (
        <div style={{ textAlign: 'left', marginBottom: 16 }}>
          {issues.map((iss, i) => (
            <div key={i} style={{
              padding: '8px 12px', borderRadius: 8, marginBottom: 6,
              background: W.er + '12', border: `1px solid ${W.er}30`,
              fontSize: 12, color: W.tx, fontFamily: W.mono, wordBreak: 'break-all',
            }}>
              ❌ {iss}
            </div>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div style={{ textAlign: 'left', marginBottom: 16 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{
              padding: '8px 12px', borderRadius: 8, marginBottom: 6,
              background: W.wn + '12', border: `1px solid ${W.wn}30`,
              fontSize: 12, color: W.tx, fontFamily: W.mono, wordBreak: 'break-all',
            }}>
              ⚠️ {w}
            </div>
          ))}
        </div>
      )}

      <button onClick={onStart} style={{
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
function FinalScreen({ steps, doneSet, onClose }) {
  const allDone = steps.every(s => doneSet.has(s.id));
  const countDone = steps.filter(s => doneSet.has(s.id)).length;

  return (
    <div style={{ textAlign: 'center', padding: '20px 0' }}>
      <div style={{ fontSize: 44, marginBottom: 10 }}>{allDone ? '🎉' : '📋'}</div>
      <div style={{ fontWeight: 900, fontSize: 18, color: W.tx, marginBottom: 8 }}>
        {allDone ? 'All Issues Resolved!' : `${countDone} / ${steps.length} Steps Complete`}
      </div>
      <div style={{ fontSize: 12, color: W.ts, marginBottom: 20, lineHeight: 1.7 }}>
        {allDone
          ? 'Flash the patched .bin files to your modules and power-cycle the vehicle for 30 seconds.'
          : 'Mark remaining steps as resolved once you have flashed and verified each module.'}
      </div>

      {/* Checklist */}
      <div style={{ textAlign: 'left', marginBottom: 20 }}>
        {steps.map(s => {
          const done = doneSet.has(s.id);
          return (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              borderRadius: 8, marginBottom: 6,
              background: done ? W.gn + '12' : W.s3,
              border: `1px solid ${done ? W.gn + '40' : W.bd}`,
            }}>
              <span style={{ fontSize: 16 }}>{done ? '✅' : '⬜'}</span>
              <span style={{ fontSize: 12, color: done ? W.gn : W.ts, flex: 1 }}>{s.title}</span>
            </div>
          );
        })}
      </div>

      {/* Flash reminder */}
      <div style={{
        padding: '12px 16px', borderRadius: 10, marginBottom: 16,
        background: W.a1 + '14', border: `1px solid ${W.a1}30`,
        fontSize: 12, color: W.tx, textAlign: 'left', lineHeight: 1.7,
      }}>
        <div style={{ fontWeight: 900, color: W.a1, marginBottom: 4 }}>⚡ Post-Flash Checklist</div>
        <div>✓ Flash BCM .bin via OBD/Flashzilla/AlfaOBD</div>
        <div>✓ Flash RFHUB .bin via OBD</div>
        {steps.some(s => s.actions.includes('full-sync') || s.actions.includes('sec16-only')) && (
          <div>✓ Flash PCM .bin if SEC6 was updated</div>
        )}
        <div>✓ Power-cycle vehicle battery for 30 seconds</div>
        <div>✓ Verify with SKIM tab — all keys should pair</div>
      </div>

      <button onClick={onClose} style={{
        background: W.gn, border: 'none', borderRadius: 10, padding: '12px 32px',
        color: '#fff', fontWeight: 900, fontSize: 14, cursor: 'pointer',
        fontFamily: W.sans, letterSpacing: 1,
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
  const [phase, setPhase] = useState('summary'); /* summary | steps | final */
  const [currentStep, setCurrentStep] = useState(0);
  const [doneSteps, setDoneSteps] = useState(new Set());
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
    guidance: 'No mismatches were found. You may still use the AI assistant to ask questions.',
    steps: [],
    actions: [],
  }];

  const moduleContext = {
    modules,
    issues,
    warnings,
    hexSnippets,
  };

  const contextHint = issues.length > 0
    ? `Explain: ${issues[0].slice(0, 80)}`
    : warnings.length > 0
    ? `Explain: ${warnings[0].slice(0, 80)}`
    : 'Explain the current module status';

  const toggleDone = (stepId) => {
    setDoneSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
      return next;
    });
  };

  const handleAction = (actionId) => {
    onAction?.(actionId);
    setTimeout(() => {
      const step = steps[currentStep];
      if (step) toggleDone(step.id);
    }, 500);
  };

  /* Close on overlay click */
  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onClose?.();
  };

  return (
    <div ref={overlayRef} onClick={handleOverlayClick} style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '16px',
    }}>
      <div style={{
        background: W.bg,
        border: `1.5px solid ${W.bd}`,
        borderRadius: 20,
        width: '100%',
        maxWidth: 820,
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
      }}>

        {/* Modal header */}
        <div style={{
          padding: '16px 22px',
          background: `linear-gradient(135deg, ${W.s2} 0%, #1A2D45 100%)`,
          borderBottom: `1px solid ${W.bd}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 24 }}>🔧</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 16, color: W.tx, fontFamily: W.sans, letterSpacing: 1 }}>
              MISMATCH RESOLUTION WIZARD
            </div>
            <div style={{ fontSize: 10, color: W.ts, letterSpacing: 2 }}>
              {phase === 'summary' ? 'ISSUE SUMMARY' : phase === 'steps' ? `STEP ${currentStep + 1} OF ${steps.length}` : 'FINAL CHECKLIST'}
              {modules.length > 0 && ` · ${modules.join(' + ')}`}
            </div>
          </div>

          {/* Phase nav dots */}
          {phase === 'steps' && steps.length > 1 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {steps.map((s, i) => (
                <button key={i} onClick={() => setCurrentStep(i)} style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: i === currentStep ? W.a3 : doneSteps.has(s.id) ? W.gn : W.bd,
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

        {/* Body — scrollable left panel + chat */}
        <div style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}>
          {/* Main content */}
          <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '18px 22px 0 22px' }}>
            {phase === 'summary' && (
              <SummaryScreen
                issues={issues}
                warnings={warnings}
                modules={modules}
                onStart={() => { setPhase('steps'); setCurrentStep(0); }}
              />
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
                  onMarkDone={() => toggleDone(steps[currentStep].id)}
                />

                {/* Navigation */}
                <div style={{ display: 'flex', gap: 10, marginTop: 14, marginBottom: 6 }}>
                  <button onClick={() => currentStep > 0 ? setCurrentStep(i => i - 1) : setPhase('summary')}
                    style={{
                      background: W.s3, border: `1px solid ${W.bd}`, borderRadius: 8,
                      padding: '8px 16px', color: W.ts, cursor: 'pointer', fontSize: 12, fontFamily: W.sans,
                    }}>
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
                      border: 'none', borderRadius: 8,
                      padding: '8px 20px', color: '#fff', cursor: 'pointer',
                      fontSize: 12, fontWeight: 900, fontFamily: W.sans, letterSpacing: 0.5,
                    }}>
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
                onClose={onClose}
              />
            )}
          </div>

          {/* Claude chat panel — always visible */}
          <div style={{ flexShrink: 0, padding: '10px 22px 18px 22px' }}>
            <ChatPanel moduleContext={moduleContext} contextHint={contextHint} />
          </div>
        </div>
      </div>
    </div>
  );
}
