import React, {useState, useRef, useEffect, useCallback} from 'react';
import {Bot, X, Send, Sparkles, Plus, History, Trash2, RotateCw, Paperclip, FileText, Pencil, Check} from 'lucide-react';

/* Global Claude Co-pilot — an always-available, general-purpose chat panel
 * surfaced from the app shell (CommandShell). Unlike the Mismatch Wizard
 * assistant, this talks to the general assistant with a non-restrictive
 * system prompt, so it answers any question.
 *
 * Conversations are persisted server-side via the shared conversations API
 * (scope="general"), so chats survive a page refresh / tab close:
 *   • on mount we hydrate the most recent general conversation (localStorage
 *     pointer first, falling back to the newest on the server);
 *   • the first user message lazily creates a server conversation tagged
 *     scope="general", then streams via POST /conversations/:id/messages;
 *   • users can start a fresh chat and browse / delete prior ones. */

const API_BASE = (import.meta.env.BASE_URL?.replace(/\/$/, '') || '') + '/api';
const SCOPE = 'general';
const LAST_CONV_KEY = 'srt-copilot-last-conv';

/* File-attachment limits. Files are read as text client-side and folded into
 * the outgoing message, so we cap per-file and total size to keep payloads
 * (10mb server limit) and token usage sane. Binary files are rejected — module
 * dumps belong in the dedicated module-loading flow, not the chat. */
const MAX_FILE_BYTES = 256 * 1024; // 256 KB per file
const MAX_TOTAL_BYTES = 512 * 1024; // 512 KB across all attachments
const MAX_FILES = 6;

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* Heuristic binary sniff: a NUL byte (or a high ratio of non-text control
 * chars) means this isn't something we can usefully fold into a prompt. */
function looksBinary(text) {
  if (text.indexOf('\u0000') !== -1) return true;
  const sample = text.slice(0, 4096);
  let ctrl = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return sample.length > 0 && ctrl / sample.length > 0.1;
}

/* Compose the message that is actually sent + stored: the typed text first,
 * then each attachment fenced with a clear header so the model can tell file
 * content apart from the user's prose. */
function buildOutgoing(text, attachments) {
  const parts = [];
  const typed = (text || '').trim();
  if (typed) parts.push(typed);
  for (const a of attachments) {
    parts.push(
      `--- Attached file: ${a.name} (${formatBytes(a.size)}) ---\n${a.content}\n--- end of ${a.name} ---`,
    );
  }
  return parts.join('\n\n');
}

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

/* Compact relative timestamp for the Past Chats list. */
function formatRelativeTime(input, now = Date.now()) {
  if (!input) return '';
  const t = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return new Date(t).toLocaleDateString();
}

function useGeneralChat() {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const abortRef = useRef(null);
  const messagesRef = useRef([]);
  const convIdRef = useRef(null);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { convIdRef.current = conversationId; }, [conversationId]);

  /* ── Hydrate the most recent general conversation on mount ── */
  useEffect(() => {
    let cancelled = false;

    const hydrateFrom = async (id) => {
      const res = await fetch(`${API_BASE}/anthropic/conversations/${encodeURIComponent(id)}`);
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      /* Guard against a stale/corrupted pointer that resolves to a non-general
       * conversation (e.g. a module-assistant chat). Treat it as a miss so we
       * fall back to the newest general chat rather than loading the wrong
       * thread under the general-purpose prompt. */
      if (data.scope !== SCOPE) return false;
      if (cancelled) return true;
      setConversationId(data.id);
      convIdRef.current = data.id;
      setMessages((data.messages || []).map((m) => ({role: m.role, content: m.content})));
      try { localStorage.setItem(LAST_CONV_KEY, String(data.id)); } catch { /* ignore */ }
      return true;
    };

    (async () => {
      try {
        const pointer = (() => {
          try { return localStorage.getItem(LAST_CONV_KEY); } catch { return null; }
        })();

        if (pointer && (await hydrateFrom(pointer))) {
          if (!cancelled) setHydrated(true);
          return;
        }
        /* No (or stale) pointer — fall back to the newest general chat. */
        try { localStorage.removeItem(LAST_CONV_KEY); } catch { /* ignore */ }
        const listRes = await fetch(`${API_BASE}/anthropic/conversations?scope=${SCOPE}`);
        if (listRes.ok) {
          const list = await listRes.json();
          if (Array.isArray(list) && list.length > 0) {
            await hydrateFrom(list[0].id);
          }
        }
      } catch {
        /* Transient failure — leave the panel empty; a new chat will be
         * created on the next send. Don't surface a blocking error. */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const send = useCallback(async (text) => {
    const content = (text || '').trim();
    if (!content || streaming) return;

    setError(null);
    const userMsg = {role: 'user', content};
    setMessages([...messagesRef.current, userMsg, {role: 'assistant', content: ''}]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      /* Lazily create the server conversation on first send. */
      let convId = convIdRef.current;
      if (!convId) {
        const createRes = await fetch(`${API_BASE}/anthropic/conversations`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({title: 'New chat', scope: SCOPE}),
        });
        if (!createRes.ok) throw new Error(`Failed to create chat (HTTP ${createRes.status})`);
        const created = await createRes.json();
        convId = created.id;
        setConversationId(convId);
        convIdRef.current = convId;
        try { localStorage.setItem(LAST_CONV_KEY, String(convId)); } catch { /* ignore */ }
      }

      const resp = await fetch(`${API_BASE}/anthropic/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({content}),
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

  /* Start a brand-new chat. The current one stays saved on the server and
   * remains browsable under Past chats. */
  const startNew = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    try { localStorage.removeItem(LAST_CONV_KEY); } catch { /* ignore */ }
    setConversationId(null);
    convIdRef.current = null;
    setMessages([]);
    setError(null);
    setStreaming(false);
  }, []);

  const switchTo = useCallback(async (id) => {
    if (abortRef.current) abortRef.current.abort();
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/anthropic/conversations/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      /* Mirror the hydration guard: never load a non-general conversation into
       * the general-purpose Co-pilot, even if an out-of-scope id is passed. */
      if (data.scope !== SCOPE) throw new Error('Not a Co-pilot chat');
      setConversationId(data.id);
      convIdRef.current = data.id;
      setMessages((data.messages || []).map((m) => ({role: m.role, content: m.content})));
      try { localStorage.setItem(LAST_CONV_KEY, String(data.id)); } catch { /* ignore */ }
    } catch (e) {
      setError(`Could not load chat: ${e.message}`);
    }
  }, []);

  const listSessions = useCallback(async () => {
    const res = await fetch(`${API_BASE}/anthropic/conversations?scope=${SCOPE}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, []);

  const deleteSession = useCallback(async (id) => {
    const res = await fetch(`${API_BASE}/anthropic/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    if (convIdRef.current === id) startNew();
  }, [startNew]);

  const renameSession = useCallback(async (id, title) => {
    const next = (title || '').trim();
    if (!next) throw new Error('Title cannot be empty');
    const res = await fetch(`${API_BASE}/anthropic/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({title: next}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, []);

  const stop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  return {
    messages, streaming, error, conversationId, hydrated,
    send, startNew, switchTo, listSessions, deleteSession, renameSession, stop,
  };
}

const SUGGESTIONS = [
  'What does SRT Lab do?',
  'Explain a SEC16 mismatch in plain English',
  'Write a short bash one-liner to find large files',
];

export default function CopilotPanel({open, onClose}) {
  const {
    messages, streaming, error, conversationId, hydrated,
    send, startNew, switchTo, listSessions, deleteSession, renameSession, stop,
  } = useGeneralChat();
  const [input, setInput] = useState('');
  const [pastOpen, setPastOpen] = useState(false);
  const [pastSessions, setPastSessions] = useState(null); /* null = not loaded */
  const [pastError, setPastError] = useState(null);
  const [attachments, setAttachments] = useState([]); /* {id,name,size,content} */
  const [attachError, setAttachError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const attachIdRef = useRef(0);

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

  const refreshPastSessions = useCallback(async () => {
    setPastError(null);
    try {
      const list = await listSessions();
      setPastSessions(list);
    } catch (e) {
      setPastError(e.message);
      setPastSessions([]);
    }
  }, [listSessions]);

  const togglePast = () => {
    setPastOpen((o) => {
      const next = !o;
      if (next) refreshPastSessions();
      return next;
    });
  };

  const handleNewChat = () => {
    startNew();
    setPastOpen(false);
  };

  const handleSwitch = async (id) => {
    await switchTo(id);
    setPastOpen(false);
  };

  const handleDelete = async (id, ev) => {
    ev.stopPropagation();
    if (!window.confirm('Delete this chat permanently?')) return;
    try {
      await deleteSession(id);
      await refreshPastSessions();
    } catch (e) {
      setPastError(e.message);
    }
  };

  /* Read picked/dropped files as text and add the ones we can use. Rejections
   * (binary, too big, over the count/total cap) surface a single inline note
   * rather than silently dropping the file. */
  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setAttachError(null);
    const rejected = [];

    const current = attachments;
    let total = current.reduce((s, a) => s + a.size, 0);

    const accepted = [];
    for (const file of files) {
      if (current.length + accepted.length >= MAX_FILES) {
        rejected.push(`${file.name} (max ${MAX_FILES} files)`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name} (over ${formatBytes(MAX_FILE_BYTES)})`);
        continue;
      }
      if (total + file.size > MAX_TOTAL_BYTES) {
        rejected.push(`${file.name} (total over ${formatBytes(MAX_TOTAL_BYTES)})`);
        continue;
      }
      let text;
      try {
        text = await file.text();
      } catch {
        rejected.push(`${file.name} (unreadable)`);
        continue;
      }
      if (looksBinary(text)) {
        rejected.push(`${file.name} (binary not supported — load module dumps via Data Management)`);
        continue;
      }
      total += file.size;
      attachIdRef.current += 1;
      accepted.push({id: attachIdRef.current, name: file.name, size: file.size, content: text});
    }

    if (accepted.length) setAttachments((prev) => [...prev, ...accepted]);
    if (rejected.length) setAttachError(`Skipped: ${rejected.join('; ')}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments]);

  const removeAttachment = useCallback((id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setAttachError(null);
  }, []);

  const onPickFiles = (e) => {
    addFiles(e.target.files);
    e.target.value = ''; // allow re-picking the same file
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  };

  const startRename = (s, ev) => {
    ev.stopPropagation();
    setRenamingId(s.id);
    setRenameDraft(s.title || `Chat #${s.id}`);
    setPastError(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft('');
  };

  const commitRename = async (id) => {
    const next = renameDraft.trim();
    if (!next) { cancelRename(); return; }
    try {
      await renameSession(id, next);
      setPastSessions((list) =>
        Array.isArray(list) ? list.map((c) => (c.id === id ? {...c, title: next} : c)) : list,
      );
      cancelRename();
    } catch (e) {
      setPastError(e.message);
    }
  };

  const submit = (e) => {
    e?.preventDefault?.();
    if (streaming) return;
    if (!input.trim() && attachments.length === 0) return;
    send(buildOutgoing(input, attachments));
    setInput('');
    setAttachments([]);
    setAttachError(null);
  };

  if (!open) return null;

  const headerBtn = {
    background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)',
    color: '#fff', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'grid', placeItems: 'center',
  };

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
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
        onDrop={onDrop}
        style={{
          position: 'relative', width: 440, maxWidth: '94vw', height: '100%',
          background: C.base, borderLeft: `1px solid ${C.line}`,
          boxShadow: '-12px 0 40px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column',
          fontFamily: C.sans,
          outline: dragOver ? `2px dashed ${C.red}` : 'none', outlineOffset: -2,
        }}
      >
        {dragOver && (
          <div
            data-testid="copilot-dropzone"
            style={{
              position: 'absolute', inset: 0, zIndex: 5, background: 'rgba(244,241,236,0.92)',
              display: 'grid', placeItems: 'center', pointerEvents: 'none',
              color: C.red, fontFamily: "'Righteous',sans-serif", fontSize: 16,
            }}
          >
            <div style={{textAlign: 'center'}}>
              <Paperclip size={28} style={{marginBottom: 8}} />
              <div>Drop files to attach</div>
            </div>
          </div>
        )}
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px',
          background: C.ink, color: '#fff', borderBottom: `3px solid ${C.red}`,
        }}>
          <Bot size={18} style={{color: C.red}} />
          <div style={{flex: 1, minWidth: 0}}>
            <div style={{fontFamily: "'Righteous',sans-serif", fontSize: 15, letterSpacing: 0.5}}>AI CO-PILOT</div>
            <div style={{fontSize: 11, opacity: 0.65}}>
              Claude · ask anything{conversationId ? ` · #${conversationId}` : ''}
            </div>
          </div>
          {streaming && <span style={{fontSize: 10, color: C.red, fontWeight: 700}}>● streaming…</span>}
          <button
            onClick={togglePast}
            aria-label="Past chats"
            title="Browse past chats"
            data-testid="copilot-history"
            style={headerBtn}
          >
            <History size={15} />
          </button>
          <button
            onClick={handleNewChat}
            aria-label="New conversation"
            title="Start a new chat (the current one is saved)"
            data-testid="copilot-new"
            style={headerBtn}
          >
            <Plus size={16} />
          </button>
          <button
            onClick={onClose}
            aria-label="Close co-pilot"
            data-testid="copilot-close"
            style={headerBtn}
          >
            <X size={16} />
          </button>
        </div>

        {/* Past chats dropdown */}
        {pastOpen && (
          <div
            data-testid="copilot-past-panel"
            style={{
              background: C.panel, borderBottom: `1px solid ${C.line}`,
              padding: '10px 14px', maxHeight: 220, overflowY: 'auto',
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
              <div style={{fontSize: 10, fontWeight: 800, color: C.muted, letterSpacing: 1}}>PAST CHATS</div>
              <button
                onClick={refreshPastSessions}
                title="Refresh"
                style={{background: 'none', border: 'none', color: C.muted, fontSize: 11, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, padding: 0}}
              >
                <RotateCw size={11} /> refresh
              </button>
              <div style={{flex: 1}} />
              <button
                onClick={() => setPastOpen(false)}
                style={{background: 'none', border: 'none', color: C.muted, fontSize: 12, cursor: 'pointer'}}
              >
                ✕
              </button>
            </div>
            {pastError && <div style={{color: C.red, fontSize: 12}}>✗ {pastError}</div>}
            {pastSessions === null && !pastError && <div style={{color: C.muted, fontSize: 12}}>Loading…</div>}
            {pastSessions && pastSessions.length === 0 && !pastError && (
              <div style={{color: C.muted, fontSize: 12, fontStyle: 'italic'}}>No previous chats yet.</div>
            )}
            {pastSessions && pastSessions.map((s) => {
              const active = s.id === conversationId;
              return (
                <div
                  key={s.id}
                  data-testid={`copilot-past-${s.id}`}
                  onClick={() => handleSwitch(s.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 8px', marginBottom: 4, borderRadius: 8,
                    background: active ? C.red + '14' : 'transparent',
                    border: `1px solid ${active ? C.red + '55' : C.line}`,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{fontSize: 12, color: active ? C.red : C.muted}}>{active ? '●' : '○'}</span>
                  <div style={{flex: 1, minWidth: 0}}>
                    {renamingId === s.id ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onClick={(ev) => ev.stopPropagation()}
                        onChange={(ev) => setRenameDraft(ev.target.value)}
                        onKeyDown={(ev) => {
                          ev.stopPropagation();
                          if (ev.key === 'Enter') { ev.preventDefault(); commitRename(s.id); }
                          else if (ev.key === 'Escape') { ev.preventDefault(); cancelRename(); }
                        }}
                        onBlur={() => commitRename(s.id)}
                        data-testid={`copilot-past-rename-input-${s.id}`}
                        style={{
                          width: '100%', boxSizing: 'border-box', fontSize: 12.5, fontWeight: 700,
                          color: C.ink, fontFamily: C.sans, border: `1px solid ${C.red}`,
                          borderRadius: 6, padding: '3px 6px', outline: 'none', background: '#fff',
                        }}
                      />
                    ) : (
                      <div style={{fontSize: 12.5, color: C.ink, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                        {s.title || `Chat #${s.id}`}
                      </div>
                    )}
                    <div style={{fontSize: 10, color: C.muted, fontFamily: C.mono}} title={s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}>
                      #{s.id} · {s.createdAt ? formatRelativeTime(s.createdAt) : ''}
                    </div>
                  </div>
                  {renamingId === s.id ? (
                    <button
                      onClick={(ev) => { ev.stopPropagation(); commitRename(s.id); }}
                      onMouseDown={(ev) => ev.preventDefault()}
                      aria-label="Save chat name"
                      title="Save name"
                      data-testid={`copilot-past-rename-save-${s.id}`}
                      style={{background: 'none', border: 'none', color: C.red, cursor: 'pointer', padding: '2px 4px', display: 'grid', placeItems: 'center'}}
                    >
                      <Check size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={(ev) => startRename(s, ev)}
                      aria-label="Rename chat"
                      title="Rename this chat"
                      data-testid={`copilot-past-rename-${s.id}`}
                      style={{background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: '2px 4px', display: 'grid', placeItems: 'center'}}
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  <button
                    onClick={(ev) => handleDelete(s.id, ev)}
                    aria-label="Delete chat"
                    title="Delete this chat"
                    data-testid={`copilot-past-delete-${s.id}`}
                    style={{background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: '2px 4px', display: 'grid', placeItems: 'center'}}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Messages */}
        <div
          ref={scrollRef}
          data-testid="copilot-messages"
          style={{flex: 1, overflowY: 'auto', padding: '16px 16px 8px', display: 'flex', flexDirection: 'column', gap: 12}}
        >
          {hydrated && messages.length === 0 && (
            <div style={{margin: 'auto 0', textAlign: 'center', color: C.muted, padding: '20px 8px'}}>
              <Sparkles size={28} style={{color: C.red, marginBottom: 10}} />
              <div style={{fontFamily: "'Righteous',sans-serif", fontSize: 16, color: C.ink, marginBottom: 6}}>
                Ask me anything
              </div>
              <div style={{fontSize: 12.5, lineHeight: 1.5, marginBottom: 16}}>
                I&apos;m Claude, running live inside SRT Lab. I can help with module
                diagnostics, code, writing, or anything else. Your chats are saved and
                survive a refresh.
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
        <div style={{borderTop: `1px solid ${C.line}`, background: C.panel}}>
          {/* Attachment chips + rejection note */}
          {(attachments.length > 0 || attachError) && (
            <div style={{padding: '10px 14px 0', display: 'flex', flexDirection: 'column', gap: 6}}>
              {attachments.length > 0 && (
                <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
                  {attachments.map((a) => (
                    <div
                      key={a.id}
                      data-testid="copilot-attachment"
                      title={`${a.name} · ${formatBytes(a.size)}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                        background: C.base, border: `1px solid ${C.line}`, borderRadius: 8,
                        padding: '5px 8px', fontSize: 12, color: C.ink,
                      }}
                    >
                      <FileText size={13} style={{color: C.red, flexShrink: 0}} />
                      <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200}}>
                        {a.name}
                      </span>
                      <span style={{color: C.muted, fontFamily: C.mono, fontSize: 10}}>{formatBytes(a.size)}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        aria-label={`Remove ${a.name}`}
                        data-testid="copilot-attachment-remove"
                        style={{background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 0, display: 'grid', placeItems: 'center'}}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {attachError && (
                <div data-testid="copilot-attach-error" style={{fontSize: 11.5, color: C.red}}>
                  {attachError}
                </div>
              )}
            </div>
          )}

          <form
            onSubmit={submit}
            style={{display: 'flex', alignItems: 'flex-end', gap: 8, padding: '12px 14px'}}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={onPickFiles}
              data-testid="copilot-attach-input"
              style={{display: 'none'}}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              aria-label="Attach files"
              title="Attach text files (logs, code, JSON, CSV…)"
              data-testid="copilot-attach"
              style={{
                flexShrink: 0, width: 42, height: 42, borderRadius: 10,
                border: `1px solid ${C.line}`, background: C.base,
                color: streaming ? C.line : C.muted, cursor: streaming ? 'default' : 'pointer',
                display: 'grid', placeItems: 'center',
              }}
            >
              <Paperclip size={17} />
            </button>
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
            {(() => {
              const canSend = !streaming && (input.trim() || attachments.length > 0);
              return (
                <button
                  type="submit"
                  disabled={!canSend}
                  aria-label="Send message"
                  data-testid="copilot-send"
                  style={{
                    flexShrink: 0, width: 42, height: 42, borderRadius: 10, border: 'none',
                    background: canSend ? C.red : C.line,
                    color: '#fff', cursor: canSend ? 'pointer' : 'default',
                    display: 'grid', placeItems: 'center',
                  }}
                >
                  <Send size={17} />
                </button>
              );
            })()}
          </form>
        </div>
      </aside>
    </div>
  );
}
