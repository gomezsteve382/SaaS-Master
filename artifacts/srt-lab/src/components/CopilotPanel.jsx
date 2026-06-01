import React, {useState, useRef, useEffect, useCallback} from 'react';
import {Bot, X, Send, Sparkles, Trash2} from 'lucide-react';

/* Global Claude Co-pilot — an always-available, general-purpose chat panel
 * surfaced from the app shell (CommandShell). Unlike the Mismatch Wizard
 * assistant, this talks to the general-chat endpoint with a non-restrictive
 * system prompt, so it answers any question. Conversation lives in component
 * state for the session and survives open/close (the panel is always mounted;
 * only its visibility toggles). */

const API_BASE = (import.meta.env.BASE_URL?.replace(/\/$/, '') || '') + '/api';

const C = {
  base: '#F4F1EC',
  panel: '#FFFFFF',
  ink: '#1A1A1A',
  red: '#D32F2F',
  muted: '#6B6B6B',
  line: '#E2DDD3',
  userBubble: '#1A1A1A',
  aiBubble: '#F4F1EC',
  sans: "'Nunito', system-ui, sans-serif",
  mono: "'JetBrains Mono', monospace",
};

function useGeneralChat() {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const send = useCallback(async (text) => {
    const content = (text || '').trim();
    if (!content || streaming) return;

    setError(null);
    const userMsg = {role: 'user', content};
    const history = [...messagesRef.current, userMsg];
    setMessages([...history, {role: 'assistant', content: ''}]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch(`${API_BASE}/anthropic/general-chat`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({messages: history}),
        signal: controller.signal,
      });

      if (!resp.ok) {
        let msg = `Request failed (${resp.status})`;
        try {
          const j = await resp.json();
          if (j?.error) msg = j.error;
        } catch { /* ignore */ }
        if (resp.status === 503) {
          msg = 'The AI co-pilot is not configured on this server yet. Please add the Anthropic integration.';
        }
        setError(msg);
        setMessages((m) => m.slice(0, -1)); // drop the empty assistant bubble
        setStreaming(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let acc = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.error) {
            throw new Error(evt.error);
          }
          if (evt.content) {
            acc += evt.content;
            setMessages((m) => {
              const copy = m.slice();
              copy[copy.length - 1] = {role: 'assistant', content: acc};
              return copy;
            });
          }
          // evt.done → loop ends naturally when stream closes
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        setError(err?.message || 'Connection error');
        setMessages((m) => {
          // drop trailing empty assistant bubble if nothing streamed
          if (m.length && m[m.length - 1].role === 'assistant' && !m[m.length - 1].content) {
            return m.slice(0, -1);
          }
          return m;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [streaming]);

  const reset = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    setMessages([]);
    setError(null);
    setStreaming(false);
  }, []);

  const stop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  return {messages, streaming, error, send, reset, stop};
}

const SUGGESTIONS = [
  'What does SRT Lab do?',
  'Explain a SEC16 mismatch in plain English',
  'Write a short bash one-liner to find large files',
];

export default function CopilotPanel({open, onClose}) {
  const {messages, streaming, error, send, reset, stop} = useGeneralChat();
  const [input, setInput] = useState('');
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  /* Abort any in-flight stream when the panel is closed/unmounted so we
   * don't keep burning tokens on a hidden request. */
  useEffect(() => {
    if (!open) stop();
    return () => stop();
  }, [open, stop]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    if (inputRef.current) inputRef.current.focus();
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const submit = (e) => {
    e?.preventDefault?.();
    if (!input.trim() || streaming) return;
    send(input);
    setInput('');
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="AI Co-pilot"
      style={{position: 'fixed', inset: 0, zIndex: 4500, display: 'flex', justifyContent: 'flex-end'}}
    >
      <div
        onClick={onClose}
        style={{position: 'absolute', inset: 0, background: 'rgba(10,10,10,0.55)', backdropFilter: 'blur(2px)'}}
      />
      <aside
        data-testid="copilot-panel"
        style={{
          position: 'relative', width: 440, maxWidth: '94vw', height: '100%',
          background: C.base, borderLeft: `1px solid ${C.line}`,
          boxShadow: '-12px 0 40px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column',
          fontFamily: C.sans,
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px',
          background: C.ink, color: '#fff', borderBottom: `3px solid ${C.red}`,
        }}>
          <Bot size={18} style={{color: C.red}} />
          <div style={{flex: 1}}>
            <div style={{fontFamily: "'Righteous',sans-serif", fontSize: 15, letterSpacing: 0.5}}>AI CO-PILOT</div>
            <div style={{fontSize: 11, opacity: 0.65}}>Claude · ask anything</div>
          </div>
          {messages.length > 0 && (
            <button
              onClick={reset}
              aria-label="New conversation"
              title="Clear conversation"
              data-testid="copilot-reset"
              style={{background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', color: '#fff', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'grid', placeItems: 'center'}}
            >
              <Trash2 size={15} />
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close co-pilot"
            data-testid="copilot-close"
            style={{background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', color: '#fff', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'grid', placeItems: 'center'}}
          >
            <X size={16} />
          </button>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          data-testid="copilot-messages"
          style={{flex: 1, overflowY: 'auto', padding: '16px 16px 8px', display: 'flex', flexDirection: 'column', gap: 12}}
        >
          {messages.length === 0 && (
            <div style={{margin: 'auto 0', textAlign: 'center', color: C.muted, padding: '20px 8px'}}>
              <Sparkles size={28} style={{color: C.red, marginBottom: 10}} />
              <div style={{fontFamily: "'Righteous',sans-serif", fontSize: 16, color: C.ink, marginBottom: 6}}>
                Ask me anything
              </div>
              <div style={{fontSize: 12.5, lineHeight: 1.5, marginBottom: 16}}>
                I&apos;m Claude, running live inside SRT Lab. I can help with module
                diagnostics, code, writing, or anything else.
              </div>
              <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => { send(s); }}
                    data-testid="copilot-suggestion"
                    style={{
                      textAlign: 'left', background: C.panel, border: `1px solid ${C.line}`,
                      borderRadius: 10, padding: '9px 12px', cursor: 'pointer',
                      fontSize: 12.5, color: C.ink, fontFamily: C.sans,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.red; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.line; }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            const isUser = m.role === 'user';
            const isLast = i === messages.length - 1;
            return (
              <div
                key={i}
                data-testid={isUser ? 'copilot-msg-user' : 'copilot-msg-assistant'}
                style={{
                  alignSelf: isUser ? 'flex-end' : 'flex-start',
                  maxWidth: '88%',
                  background: isUser ? C.userBubble : C.panel,
                  color: isUser ? '#fff' : C.ink,
                  border: isUser ? 'none' : `1px solid ${C.line}`,
                  borderRadius: 12,
                  padding: '10px 13px',
                  fontSize: 13.5,
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {m.content || (isLast && streaming ? (
                  <span style={{color: C.muted, fontStyle: 'italic'}}>Thinking…</span>
                ) : '')}
              </div>
            );
          })}

          {error && (
            <div
              data-testid="copilot-error"
              style={{
                alignSelf: 'stretch', background: '#fdecec', border: `1px solid ${C.red}55`,
                color: C.red, borderRadius: 10, padding: '9px 12px', fontSize: 12.5,
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={submit}
          style={{
            display: 'flex', alignItems: 'flex-end', gap: 8, padding: '12px 14px',
            borderTop: `1px solid ${C.line}`, background: C.panel,
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); }
            }}
            rows={1}
            placeholder="Message the co-pilot…"
            data-testid="copilot-input"
            style={{
              flex: 1, resize: 'none', maxHeight: 140, minHeight: 40,
              border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 12px',
              fontSize: 13.5, fontFamily: C.sans, outline: 'none', color: C.ink,
              background: C.base,
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || streaming}
            aria-label="Send message"
            data-testid="copilot-send"
            style={{
              flexShrink: 0, width: 42, height: 42, borderRadius: 10, border: 'none',
              background: (!input.trim() || streaming) ? C.line : C.red,
              color: '#fff', cursor: (!input.trim() || streaming) ? 'default' : 'pointer',
              display: 'grid', placeItems: 'center',
            }}
          >
            <Send size={17} />
          </button>
        </form>
      </aside>
    </div>
  );
}
