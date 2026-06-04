import React, {
  useState, useRef, useEffect, useCallback, useMemo,
} from "react";
import {
  Tip, translateIssue, pickRecommendedFix, detectCommonScenario,
  loadAdvanced, saveAdvanced,
} from "../lib/plainEnglish.jsx";
import { fmtOff } from "../tabs/ModuleSync.jsx";
import { formatBcmSec16SourceLabel } from "../lib/sec16SourceLabel.js";
import { MODULE_CONNECTION_GUIDES, PROGRAMMERS } from "../lib/programmerData.js";

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
    guidance: `The GPEC2A secret key at ${fmtOff(0x0203)} and ${fmtOff(0x0361)} do not match — the PCM image may be corrupt or from a partial write.`,
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

/* ─── BCM SEC16 provenance label (Task #383) ───────────────────────────────
 * Mirrors the chip rendered by KeyProgTab so operators see the same source
 * (split / mirror1 / mirror2 / flat / blank) wherever the wizard displays
 * BCM SEC16 bytes. The label itself is built by the shared helper
 * `formatBcmSec16SourceLabel` (lib/sec16SourceLabel.js) — Task #471
 * promoted that formatter into one place so MismatchWizard, KeyProgTab,
 * and ModuleFieldsPanel can never drift again. The free-form prose around
 * the wizard still uses fmtOff for non-canonical offsets. */

/* Inline chip badge that surfaces SEC16 provenance next to BCM SEC16 hex
 * rows inside the Mismatch Wizard. Yellow-toned when the BCM looks virgin
 * (every candidate blank), green-toned for live records, neutral when
 * nothing was resolved. Kept compact so it sits in line with field labels. */
function BcmSec16SourceBadge({ status, testid }) {
  const label = formatBcmSec16SourceLabel(status);
  if (!label) return null;
  const isBlank = !!status?.blank;
  const color = isBlank ? W.wn : W.gn;
  return (
    <span
      data-testid={testid || 'wizard-bcm-sec16-source-badge'}
      data-sec16-source={status?.source || 'none'}
      data-sec16-blank={isBlank ? '1' : '0'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontFamily: W.sans, fontSize: 9, fontWeight: 800,
        letterSpacing: 0.5, textTransform: 'uppercase',
        color, background: color + '1A',
        border: `1px solid ${color}55`,
        borderRadius: 6, padding: '1px 6px',
      }}>
      SEC16 · {label}
      {isBlank && (
        <span style={{
          background: W.wn, color: '#000', fontSize: 8, fontWeight: 800,
          padding: '0 4px', borderRadius: 3, marginLeft: 2, letterSpacing: 0.5,
        }}>BLANK</span>
      )}
    </span>
  );
}

/* Plain-English explainer shown when the BCM is virgin / blank — mirrors
 * the Key Prog wizard copy so operators understand that a "copy RFH SEC16
 * → BCM SEC16" suggestion is writing into a virgin cluster. */
function BcmSec16VirginExplainer({ testid }) {
  return (
    <div
      data-testid={testid || 'wizard-bcm-sec16-virgin-explainer'}
      style={{
        marginTop: 8, padding: '8px 10px', borderRadius: 6,
        border: `1px solid ${W.wn}55`, background: W.wn + '14',
        fontSize: 11, color: W.tx, lineHeight: 1.5,
      }}>
      <strong style={{ color: W.wn }}>Virgin BCM:</strong> every SEC16 candidate
      (split records @{fmtOff(0x81A0)} / {fmtOff(0x81C0)} / {fmtOff(0x81E0)},
      mirror1 0xEB, mirror2 0xCA, and the legacy flat slice @{fmtOff(0x40C9)})
      is all 0xFF / 0x00. The wizard is about to write the RFHUB secret into a
      blank cluster — that's expected for a bench-fresh BCM, but verify the
      donor RFHUB is correct before flashing.
    </div>
  );
}

/* WizardConnectionGuides (Task #468) — wizard-themed compact variant of the
 * Module Sync workspace's ConnectionGuides row (added in #464). Renders the
 * same per-module link group (BCM (MPC560xB) → MULTIPROG · UPA, PCM (GPEC2A)
 * → GODIAG, RFH (9S12X) → MULTIPROG · UPA · OBDSTAR) so techs opening the
 * Sync Wizard see which programmer to wire to which chip BEFORE they pick
 * a tool. Sources data from MODULE_CONNECTION_GUIDES + PROGRAMMERS — the
 * same registry the workspace uses, so any future registry change shows up
 * in both surfaces with no duplication. Links keep target="_blank" +
 * rel="noopener noreferrer" so the bench-tool vendor pages can't reach back
 * into the workspace via window.opener (the same hardening #465 locks in
 * for the workspace row). */
function WizardConnectionGuides() {
  return (
    <div data-testid="wizard-connection-guides" style={{
      display: 'flex', flexWrap: 'wrap', gap: 12,
      padding: '8px 12px', marginBottom: 14,
      background: W.s3, border: `1px solid ${W.bd}`, borderRadius: 10,
      fontSize: 11,
    }}>
      <div style={{ fontWeight: 800, color: W.ts, letterSpacing: 0.6, textTransform: 'uppercase', alignSelf: 'center', whiteSpace: 'nowrap' }}>
        🛠 Connection Guides
      </div>
      {MODULE_CONNECTION_GUIDES.map(group => (
        <div key={group.module}
             data-testid={`wizard-guides-${group.module.toLowerCase()}`}
             style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, color: W.tx }}>{group.label}</span>
          <span style={{ color: W.tm }}>→</span>
          {group.guides.map((g, idx) => {
            const prog = PROGRAMMERS[g.programmer];
            const label = prog?.label || g.programmer;
            return (
              <React.Fragment key={g.programmer}>
                {idx > 0 && <span style={{ color: W.tm, fontSize: 10 }}>·</span>}
                <a href={g.url} target="_blank" rel="noopener noreferrer"
                   data-testid={`wizard-guide-link-${group.module.toLowerCase()}-${g.programmer.toLowerCase()}`}
                   title={`${group.label} — ${label} (${prog?.vendor || ''}) connection guide`}
                   style={{
                     color: W.a3, textDecoration: 'none', fontWeight: 700,
                     padding: '2px 6px', borderRadius: 4,
                     border: `1px solid ${W.a3}55`, background: W.s2,
                   }}>
                  {label}
                </a>
              </React.Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ─── Hex Diff Card ─── */
function HexDiffCard({ step, hexSnippets, bcmSec16Status }) {
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
            const isBcmRow = label.toUpperCase().includes('BCM SEC16');
            return (
              <div key={side}>
                <div style={{ fontSize: 10, color: side === 'a' ? W.a2 : W.a3, fontWeight: 800, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span>{label}</span>
                  {isBcmRow && bcmSec16Status && (
                    <BcmSec16SourceBadge status={bcmSec16Status} testid="wizard-hexdiff-bcm-sec16-source-badge" />
                  )}
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
        parsed.map((p, i) => {
          const isBcmRow = p.label.toUpperCase().includes('BCM SEC16');
          return (
            <div key={i} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: W.a2, fontWeight: 800, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span>{p.label}</span>
                {isBcmRow && bcmSec16Status && (
                  <BcmSec16SourceBadge status={bcmSec16Status} testid="wizard-hexdiff-bcm-sec16-source-badge" />
                )}
              </div>
              <div style={{
                fontFamily: W.mono, fontSize: 9.5, color: W.ts, lineHeight: 1.8,
                wordBreak: 'break-all', letterSpacing: 1,
              }}>{hexStr(p.hex)}</div>
            </div>
          );
        })
      )}

      {hasDiff && (
        <div style={{ fontSize: 10, color: W.er, marginTop: 6 }}>
          ● <span style={{ fontFamily: W.mono }}>red bytes</span> = mismatch between modules
        </div>
      )}

      {/* Task #383 — surface BCM virgin explainer when the wizard is about to
       * write into a blank cluster. Only shows when the relevant rows
       * actually include BCM SEC16 so we don't leak BCM context into
       * unrelated VIN-only steps. */}
      {bcmSec16Status?.blank && parsed.some(p => p.label.toUpperCase().includes('BCM SEC16')) && (
        <BcmSec16VirginExplainer testid="wizard-hexdiff-bcm-virgin-explainer" />
      )}
    </div>
  );
}

/* ─── Persistent Claude chat hook (DB-backed conversations API) ───
 *
 * Per `sessionKey` (e.g. "workspace:dodge-charger"), the hook:
 *   • on mount, looks up localStorage["srt-wizard-last-conv:<sessionKey>"]
 *     and hydrates the matching conversation from the server (GET /:id);
 *   • on first send, POSTs /anthropic/conversations to create a new
 *     conversation tagged with `scope=<sessionKey>`, then streams via
 *     POST /anthropic/conversations/:id/messages (SSE);
 *   • exposes startNewSession() / switchToSession(id) / listSessions().
 *
 * The server is the source of truth — the hook re-hydrates from the DB
 * after every modal open, so chats survive close/reopen, page reloads,
 * and even client disconnect mid-stream.
 */
const LAST_CONV_KEY = (sessionKey) => `srt-wizard-last-conv:${sessionKey || 'default'}`;

/* Render a compact relative timestamp ("5m ago", "2h ago", "3d ago"…)
 * for the Past Sessions list. Falls back to a locale string for very
 * old entries so the user still gets a real date. Exported for tests. */
export function formatRelativeTime(input, now = Date.now()) {
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

function useChatStream(sessionKey) {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [hydrateError, setHydrateError] = useState(null);
  const [hydrateNonce, setHydrateNonce] = useState(0);
  const [conversationId, setConversationId] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [resumed, setResumed] = useState(false); /* true ⇢ we loaded a prior chat */
  const abortRef = useRef(null);
  const contextRef = useRef(null);
  const binaryRef = useRef(null);  /* { binaryBase64?, binaries? } — Task #694 */
  const messagesRef = useRef([]);
  const convIdRef = useRef(null);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { convIdRef.current = conversationId; }, [conversationId]);

  const updateContext = useCallback((ctx) => {
    contextRef.current = ctx;
  }, []);

  /* Task #694 — optional: callers can hand in the actual loaded binary
   * bytes (base64) so the assistant can call read_hex / extract_strings /
   * etc. against the real file. When `binaryBase64` is present, sendMessage
   * targets the tool-use SSE endpoint instead of the plain text endpoint. */
  const updateBinaryData = useCallback((data) => {
    binaryRef.current = data || null;
  }, []);

  /* Manually re-run the hydrate effect against the same saved pointer.
   * Used by the header "Retry" button after a transient hydrate failure
   * so the user can recover without remounting the wizard. */
  const retryHydrate = useCallback(() => {
    setHydrateNonce(n => n + 1);
  }, []);

  /* ── Hydrate prior session on mount / sessionKey change ── */
  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setResumed(false);
    setMessages([]);
    setConversationId(null);
    setError(null);
    setHydrateError(null);

    const lastId = (() => {
      try { return localStorage.getItem(LAST_CONV_KEY(sessionKey)); }
      catch { return null; }
    })();

    if (!lastId) {
      setHydrated(true);
      return () => { cancelled = true; };
    }

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/anthropic/conversations/${encodeURIComponent(lastId)}`);
        if (cancelled) return;
        if (res.status === 404) {
          /* Stale pointer — clear it */
          try { localStorage.removeItem(LAST_CONV_KEY(sessionKey)); } catch {}
          setHydrated(true);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setConversationId(data.id);
        /* Task #694 — also rehydrate persisted tool traces so a resumed
         * session shows the same "🔧 N tool calls" disclosure that was
         * rendered live during the original conversation. The server
         * returns each persisted entry as { toolName, args, resultPreview,
         * bytesReturned, durationMs }; the disclosure expects the live
         * shape { toolName, args, status, result, bytesReturned,
         * durationMs }, so we normalize here. */
        setMessages((data.messages || []).map(m => ({
          role: m.role,
          content: m.content,
          ...(Array.isArray(m.toolTrace) && m.toolTrace.length > 0
            ? {
                toolTrace: m.toolTrace.map((t, i) => ({
                  id: `hydrated-${m.id}-${i}`,
                  toolName: t.toolName,
                  args: t.args,
                  status: 'done',
                  result: t.result ?? t.resultPreview ?? '',
                  bytesReturned: t.bytesReturned ?? 0,
                  durationMs: t.durationMs ?? 0,
                })),
              }
            : {}),
        })));
        /* Hydrated successfully from a saved pointer ⇢ this is a resumed chat,
         * even if the prior session had no messages yet. */
        setResumed(true);
        setHydrated(true);
      } catch (e) {
        /* Transient failure (network down, server restart). Don't clear the
         * pointer or mark hydrated — leaving hydrated=false suppresses the
         * auto-greet effect, so we won't accidentally fork a brand-new
         * conversation and overwrite the saved one on the next user send.
         * Surface a dedicated hydrateError so the header can show a Retry
         * button alongside the message. */
        if (!cancelled) setHydrateError(e.message || 'Could not load previous chat.');
      }
    })();

    return () => { cancelled = true; };
  }, [sessionKey, hydrateNonce]);

  const sendMessage = useCallback(async (userText) => {
    if (streaming) return;

    /* Optimistic UI — assistant placeholder gets a toolTrace array attached
     * so we can append tool_call/tool_result events as they stream in. */
    const userMsg = { role: 'user', content: userText };
    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '', toolTrace: [] }]);
    setStreaming(true);
    setError(null);

    /* Task #694 — when caller has supplied loaded binary bytes, target the
     * tool-use SSE endpoint so the assistant can actually inspect the file. */
    const binaryData = binaryRef.current;
    const useTools = !!(binaryData && binaryData.binaryBase64);

    try {
      /* Lazily create the server conversation on first send. */
      let convId = convIdRef.current;
      if (!convId) {
        const createRes = await fetch(`${API_BASE}/anthropic/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'New chat', scope: sessionKey || null }),
        });
        if (!createRes.ok) throw new Error(`Failed to create chat (HTTP ${createRes.status})`);
        const created = await createRes.json();
        convId = created.id;
        setConversationId(convId);
        convIdRef.current = convId;
        try { localStorage.setItem(LAST_CONV_KEY(sessionKey), String(convId)); } catch {}
      }

      const controller = new AbortController();
      abortRef.current = controller;

      const endpoint = useTools
        ? `${API_BASE}/anthropic/conversations/${convId}/tool-messages`
        : `${API_BASE}/anthropic/conversations/${convId}/messages`;

      const body = useTools
        ? {
            content: userText,
            moduleContext: contextRef.current || undefined,
            binaryBase64: binaryData.binaryBase64,
            binaries: binaryData.binaries || undefined,
          }
        : {
            content: userText,
            moduleContext: contextRef.current || undefined,
          };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Network error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // eslint-disable-next-line no-constant-condition
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
          let parsed;
          try { parsed = JSON.parse(json); }
          catch { continue; /* malformed frame — skip, don't kill stream */ }
          if (parsed.done) break;
          /* Server-emitted error frame — propagate to outer catch so the
           * empty assistant placeholder is rolled back and the user sees
           * the failure instead of a silent dead reply. */
          if (parsed.error) throw new Error(parsed.error);
          /* Tool-use endpoint frames (Task #694):
           *   type=text          → streaming text delta (same as plain content)
           *   type=tool_call     → assistant is calling a tool
           *   type=tool_result   → result returned for a tool call
           *   type=done          → final marker (may carry full toolTrace)
           * Plain-text endpoint frames just use `content`. Both flow through here. */
          const isText = parsed.content || parsed.type === 'text';
          const textDelta = parsed.type === 'text' ? parsed.content : parsed.content;
          if (isText && textDelta) {
            setMessages(prev => {
              const updated = [...prev];
              updated[updated.length - 1] = {
                ...updated[updated.length - 1],
                content: updated[updated.length - 1].content + textDelta,
              };
              return updated;
            });
          } else if (parsed.type === 'tool_call') {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              const trace = [...(last.toolTrace || []), {
                id: parsed.id,
                toolName: parsed.toolName,
                args: parsed.args,
                status: 'running',
              }];
              updated[updated.length - 1] = { ...last, toolTrace: trace };
              return updated;
            });
          } else if (parsed.type === 'tool_result') {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              const trace = (last.toolTrace || []).map(t =>
                t.id === parsed.id
                  ? { ...t, status: 'done', result: parsed.result, durationMs: parsed.durationMs, bytesReturned: parsed.bytesReturned }
                  : t
              );
              updated[updated.length - 1] = { ...last, toolTrace: trace };
              return updated;
            });
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message);
        /* Roll back the empty assistant placeholder; keep the user msg
         * because the server already persisted it (or didn't, but the
         * user can see what they typed and retry). */
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.content === '') return prev.slice(0, -1);
          return prev;
        });
      }
    } finally {
      setStreaming(false);
    }
  }, [streaming, sessionKey]);

  const startNewSession = useCallback(() => {
    abortRef.current?.abort();
    try { localStorage.removeItem(LAST_CONV_KEY(sessionKey)); } catch {}
    setConversationId(null);
    convIdRef.current = null;
    setMessages([]);
    setResumed(false);
    setError(null);
  }, [sessionKey]);

  const switchToSession = useCallback(async (id) => {
    abortRef.current?.abort();
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/anthropic/conversations/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConversationId(data.id);
      convIdRef.current = data.id;
      /* Task #694 — also rehydrate persisted tool traces so a resumed
       * session shows the same "🔧 N tool calls" disclosure that was
       * rendered live during the original conversation. */
      setMessages((data.messages || []).map(m => ({
        role: m.role,
        content: m.content,
        ...(Array.isArray(m.toolTrace) && m.toolTrace.length > 0 ? { toolTrace: m.toolTrace } : {}),
      })));
      setResumed(true);
      try { localStorage.setItem(LAST_CONV_KEY(sessionKey), String(data.id)); } catch {}
    } catch (e) {
      setError(`Could not load session: ${e.message}`);
    }
  }, [sessionKey]);

  const listSessions = useCallback(async () => {
    const url = sessionKey
      ? `${API_BASE}/anthropic/conversations?scope=${encodeURIComponent(sessionKey)}`
      : `${API_BASE}/anthropic/conversations`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, [sessionKey]);

  const deleteSession = useCallback(async (id) => {
    const res = await fetch(`${API_BASE}/anthropic/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    if (convIdRef.current === id) startNewSession();
  }, [startNewSession]);

  return {
    messages, streaming, error, hydrateError, conversationId, hydrated, resumed,
    sendMessage, updateContext, updateBinaryData, retryHydrate,
    startNewSession, switchToSession, listSessions, deleteSession,
  };
}

/* ─── Chat Panel ─── */
function ChatPanel({ moduleContext, autoGreet, sessionKey, binaryData }) {
  const {
    messages, streaming, error, hydrateError, conversationId, hydrated, resumed,
    sendMessage, updateContext, updateBinaryData, retryHydrate,
    startNewSession, switchToSession, listSessions, deleteSession,
  } = useChatStream(sessionKey);
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);
  const [pastSessions, setPastSessions] = useState(null); /* null = not loaded yet */
  const [pastError, setPastError] = useState(null);
  const bottomRef = useRef(null);
  const greeted = useRef(false);

  /* Transient "↻ RESUMED" pill — shows for ~5s right after the chat
   * is hydrated from a saved pointer, then auto-fades so it doesn't
   * sit there for the entire session. */
  const [pillVisible, setPillVisible] = useState(false);
  useEffect(() => {
    if (!resumed) { setPillVisible(false); return; }
    setPillVisible(true);
    const t = setTimeout(() => setPillVisible(false), 5000);
    return () => clearTimeout(t);
  }, [resumed, conversationId]);

  /* Keep Claude context current as wizard state changes */
  useEffect(() => {
    updateContext(moduleContext);
  }, [moduleContext, updateContext]);

  /* Task #694 — feed loaded binary bytes into the chat hook so the assistant
   * can call read_hex / extract_strings / etc. against the actual file. */
  useEffect(() => {
    updateBinaryData(binaryData);
  }, [binaryData, updateBinaryData]);

  /* Auto-brief on first open of a brand-new session (only if hydration
   * found nothing). Don't re-greet a resumed conversation. */
  useEffect(() => {
    if (!hydrated) return;
    if (greeted.current || streaming) return;
    if (messages.length > 0 || conversationId) return;
    if (!autoGreet) return;
    greeted.current = true;
    sendMessage(autoGreet);
  }, [hydrated, conversationId, messages.length, autoGreet, streaming, sendMessage]);

  /* Reset the greeted flag whenever we start fresh so a brand-new chat
   * still gets briefed automatically. */
  useEffect(() => {
    if (!conversationId && messages.length === 0) greeted.current = false;
  }, [conversationId, messages.length]);

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
    setPastOpen(o => {
      const next = !o;
      if (next && pastSessions === null) refreshPastSessions();
      return next;
    });
  };

  const handleNewChat = () => {
    if (messages.length > 0 && !window.confirm('Start a brand-new chat? The current chat is saved and remains in Past Sessions.')) {
      return;
    }
    startNewSession();
    /* Re-arm auto-greet for the fresh session */
    greeted.current = false;
  };

  const handleSwitchSession = async (id) => {
    await switchToSession(id);
    setPastOpen(false);
    /* Loaded a real prior session — never auto-greet over it */
    greeted.current = true;
  };

  const handleDeleteSession = async (id, ev) => {
    ev.stopPropagation();
    if (!window.confirm('Delete this chat permanently?')) return;
    try {
      await deleteSession(id);
      await refreshPastSessions();
    } catch (e) {
      setPastError(e.message);
    }
  };

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
          <div style={{ fontWeight: 800, fontSize: 12, color: W.tx, letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            CLAUDE AI ASSISTANT
            {pillVisible && (
              <span
                data-testid="wizard-chat-resumed-pill"
                title="This chat was loaded from your previous session and persists across modal close/reopen."
                style={{ background: W.a2 + '22', border: `1px solid ${W.a2}55`, color: W.a2, fontSize: 9, fontWeight: 800, padding: '1px 7px', borderRadius: 10, letterSpacing: 0.5 }}>
                ↻ RESUMED
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: W.ts }}>
            {moduleContext?.wizard
              ? `Step ${(moduleContext.wizard.currentStepIndex ?? 0) + 1}/${moduleContext.wizard.totalSteps} · ${moduleContext.wizard.completedSteps?.length ?? 0} resolved`
              : 'Powered by Anthropic · context-aware'}
            {conversationId ? ` · #${conversationId}` : ''}
          </div>
        </div>
        {streaming && <div style={{ fontSize: 10, color: W.a2, fontWeight: 700 }}>● streaming…</div>}
        {!collapsed && (
          <>
            <button
              data-testid="wizard-chat-past-sessions-btn"
              onClick={e => { e.stopPropagation(); togglePast(); }}
              title="Browse and switch between past chats for this launcher"
              style={{ background: W.s3, border: `1px solid ${W.bd}`, color: W.ts, fontSize: 10, cursor: 'pointer', padding: '3px 8px', borderRadius: 6, fontWeight: 700, letterSpacing: 0.5 }}>
              Past sessions ▾
            </button>
            <button
              data-testid="wizard-chat-new-btn"
              onClick={e => { e.stopPropagation(); handleNewChat(); }}
              title="Start a new chat (the current one is saved)"
              style={{ background: W.a3 + '22', border: `1px solid ${W.a3}55`, color: W.a3, fontSize: 10, cursor: 'pointer', padding: '3px 8px', borderRadius: 6, fontWeight: 800, letterSpacing: 0.5 }}>
              + New chat
            </button>
          </>
        )}
        <div style={{ color: W.tm, fontSize: 13 }}>{collapsed ? '▲' : '▼'}</div>
      </div>

      {/* Hydrate failure banner with manual retry — appears when the saved
          conversation pointer couldn't be loaded due to a transient (non-404)
          error. Lets the user recover without remounting the wizard. */}
      {!collapsed && hydrateError && !hydrated && (
        <div
          data-testid="wizard-chat-hydrate-error"
          style={{
            padding: '8px 14px', background: W.er + '14', borderBottom: `1px solid ${W.er}55`,
            display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          }}>
          <div style={{ flex: 1, color: W.er, fontSize: 11, lineHeight: 1.5 }}>
            ✗ Couldn't load your previous chat ({hydrateError}). Your saved chat is still safe.
          </div>
          <button
            data-testid="wizard-chat-hydrate-retry-btn"
            onClick={(e) => { e.stopPropagation(); retryHydrate(); }}
            title="Try loading the saved chat again"
            style={{
              background: W.er, border: 'none', borderRadius: 6, padding: '4px 12px',
              color: '#fff', fontSize: 11, fontWeight: 800, letterSpacing: 0.5,
              cursor: 'pointer', flexShrink: 0,
            }}>
            ↻ Retry
          </button>
        </div>
      )}

      {/* Past sessions dropdown */}
      {!collapsed && pastOpen && (
        <div
          data-testid="wizard-chat-past-sessions-panel"
          style={{ background: W.bg, borderBottom: `1px solid ${W.bd}`, padding: '8px 14px', maxHeight: 180, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: W.ts, letterSpacing: 1 }}>
              PAST CHATS {sessionKey ? `· ${sessionKey}` : ''}
            </div>
            <button onClick={refreshPastSessions} style={{ background: 'none', border: 'none', color: W.tm, fontSize: 10, cursor: 'pointer', padding: 0 }}>↻ refresh</button>
            <div style={{ flex: 1 }} />
            <button onClick={() => setPastOpen(false)} style={{ background: 'none', border: 'none', color: W.tm, fontSize: 11, cursor: 'pointer' }}>✕</button>
          </div>
          {pastError && <div style={{ color: W.er, fontSize: 11 }}>✗ {pastError}</div>}
          {pastSessions === null && !pastError && <div style={{ color: W.tm, fontSize: 11 }}>Loading…</div>}
          {pastSessions && pastSessions.length === 0 && !pastError && (
            <div style={{ color: W.tm, fontSize: 11, fontStyle: 'italic' }}>No previous chats for this launcher yet.</div>
          )}
          {pastSessions && pastSessions.map(s => {
            const active = s.id === conversationId;
            return (
              <div
                key={s.id}
                data-testid={`wizard-chat-past-session-${s.id}`}
                onClick={() => handleSwitchSession(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px', marginBottom: 3, borderRadius: 6,
                  background: active ? W.a3 + '18' : 'transparent',
                  border: `1px solid ${active ? W.a3 + '55' : 'transparent'}`,
                  cursor: 'pointer',
                }}>
                <span style={{ fontSize: 13 }}>{active ? '●' : '○'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: W.tx, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.title || `Chat #${s.id}`}
                  </div>
                  <div
                    style={{ fontSize: 9, color: W.tm, fontFamily: W.mono }}
                    title={s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}>
                    #{s.id} · {s.createdAt ? formatRelativeTime(s.createdAt) : ''}
                  </div>
                </div>
                <button onClick={(ev) => handleDeleteSession(s.id, ev)} title="Delete this chat" style={{ background: 'none', border: 'none', color: W.tm, fontSize: 12, cursor: 'pointer', padding: '2px 4px' }}>🗑</button>
              </div>
            );
          })}
        </div>
      )}

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
                <div style={{ maxWidth: '80%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{
                    padding: '8px 12px', borderRadius: 10,
                    background: msg.role === 'user' ? W.a3 + '18' : W.s3,
                    border: `1px solid ${msg.role === 'user' ? W.a3 + '30' : W.bd}`,
                    fontSize: 12, color: W.tx, lineHeight: 1.6,
                    fontFamily: W.sans, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {msg.content || (streaming && i === messages.length - 1
                      ? <span style={{ opacity: 0.5, fontFamily: W.mono }}>▌</span>
                      : null)}
                  </div>
                  {msg.role === 'assistant' && msg.toolTrace && msg.toolTrace.length > 0 && (
                    <ToolTraceDisclosure trace={msg.toolTrace} />
                  )}
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

/* ─── Tool-use trace disclosure (Task #694) ────────────────────────────── *
 * Surfaces every read_hex / extract_strings / parse_module / hex_diff call
 * the assistant made while drafting this reply, with their args, byte size,
 * latency, and a short result preview. Collapsed by default — operators who
 * trust the assistant don't see it; operators who want to audit it can. */
function ToolTraceDisclosure({ trace }) {
  const [open, setOpen] = useState(false);
  const runningCount = trace.filter(t => t.status === 'running').length;
  const doneCount = trace.filter(t => t.status === 'done').length;
  const totalBytes = trace.reduce((sum, t) => sum + (t.bytesReturned || 0), 0);

  return (
    <div style={{
      fontFamily: W.mono, fontSize: 10, color: W.ts,
      background: W.s2, border: `1px solid ${W.bd}`, borderRadius: 8,
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
          padding: '6px 10px', color: W.ts, cursor: 'pointer', fontFamily: W.mono,
          fontSize: 10, display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span>{open ? '▼' : '▶'}</span>
        <span style={{ color: W.a2, fontWeight: 700 }}>🔧 {trace.length} tool call{trace.length === 1 ? '' : 's'}</span>
        <span style={{ opacity: 0.6 }}>
          {runningCount > 0 ? `(${runningCount} running, ${doneCount} done)` : `(${totalBytes.toLocaleString()} bytes)`}
        </span>
      </button>
      {open && (
        <div style={{ padding: '6px 10px 8px 10px', borderTop: `1px solid ${W.bd}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {trace.map((t, idx) => (
            <div key={t.id || idx} style={{ borderLeft: `2px solid ${t.status === 'done' ? W.a2 : W.wn}`, paddingLeft: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <span style={{ color: W.tx, fontWeight: 700 }}>{t.toolName}</span>
                <span style={{ opacity: 0.6 }}>
                  {t.status === 'done'
                    ? `${t.durationMs}ms · ${(t.bytesReturned || 0).toLocaleString()}B`
                    : '…'}
                </span>
              </div>
              {t.args && (
                <div style={{ opacity: 0.7, marginTop: 2, wordBreak: 'break-all' }}>
                  args: {typeof t.args === 'string' ? t.args : JSON.stringify(t.args)}
                </div>
              )}
              {t.result && (
                <pre style={{
                  margin: '4px 0 0 0', padding: '4px 6px', background: W.s3,
                  borderRadius: 4, fontSize: 9, color: W.tx, whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all', maxHeight: 140, overflow: 'auto',
                }}>{t.result}</pre>
              )}
            </div>
          ))}
        </div>
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
function ActionResult({ actionId, hexSnippets, patchRows, onContinue, bcmSec16Status }) {
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
          {diffs.map(d => {
            const isBcmRow = (d.field || '').toUpperCase().includes('BCM SEC16');
            return (
            <div key={d.field} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: W.a2, fontWeight: 800, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span>{d.field}</span>
                {isBcmRow && bcmSec16Status && (
                  <BcmSec16SourceBadge status={bcmSec16Status} testid="wizard-actionresult-bcm-sec16-source-badge" />
                )}
              </div>
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
            );
          })}
          {bcmSec16Status?.blank && diffs.some(d => (d.field || '').toUpperCase().includes('BCM SEC16')) && (
            <BcmSec16VirginExplainer testid="wizard-actionresult-bcm-virgin-explainer" />
          )}
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
function WizardStepCard({ step, stepNum, total, stepActions, hexSnippets, onAction, done, skipped, onMarkDone, onSkip, bcmSec16Status }) {
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
      <HexDiffCard step={step} hexSnippets={hexSnippets} bcmSec16Status={bcmSec16Status} />

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

      {appliedAction && !done && <ActionResult actionId={appliedAction} hexSnippets={hexSnippets} patchRows={patchRows} onContinue={() => onMarkDone(step.id)} bcmSec16Status={bcmSec16Status} />}

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
 * Simple "what do you have → what do you want → done" flow.
 * Default view when Advanced is off.
 * ═══════════════════════════════════════════════════════════════ */
function SimpleFlow({ issues, warnings, modules, hexSnippets, stepActions, onAction, onClose }) {
  /* A "scenario" is a recognized common pairing (e.g. BCM+RFHUB). When one
   * matches, we show a streamlined "Confirm & Download" card instead of the
   * full Recommended/Plan breakdown. Falls back to pickRecommendedFix() for
   * less common combinations. */
  const scenario = useMemo(
    () => detectCommonScenario({ issues, warnings, stepActions, modules, hexSnippets }),
    [issues, warnings, stepActions, modules, hexSnippets]
  );
  const recommended = useMemo(
    () => pickRecommendedFix({ issues, warnings, stepActions, modules, hexSnippets }),
    [issues, warnings, stepActions, modules, hexSnippets]
  );

  const [phase, setPhase] = useState('plan');     /* 'plan' | 'busy' | 'done' | 'failed' */
  const [errMsg, setErrMsg] = useState(null);

  /* Inline master-VIN editor state. The auto-picked default lives in
   * scenario.targetVin; if the user clicks the badge to edit it, we keep
   * the typed value here and pass it to onAction as { vinOverride }. */
  const SCENARIO_VIN_RE = /^[12345][A-HJ-NPR-Z0-9]{16}$/;
  const [vinEditing, setVinEditing] = useState(false);
  const [vinDraft, setVinDraft] = useState('');
  const [vinOverride, setVinOverride] = useState(null);
  const effectiveVin = vinOverride || scenario?.targetVin || null;
  const isCustomVin = !!vinOverride && vinOverride !== scenario?.targetVin;
  const vinDraftClean = vinDraft.replace(/[^A-HJ-NPR-Z0-9]/gi, '').toUpperCase().slice(0, 17);
  const vinDraftValid = SCENARIO_VIN_RE.test(vinDraftClean);

  const beginVinEdit = () => {
    setVinDraft(effectiveVin || '');
    setVinEditing(true);
  };
  const cancelVinEdit = () => { setVinEditing(false); setVinDraft(''); };
  const saveVinEdit = () => {
    if (!vinDraftValid) return;
    setVinOverride(vinDraftClean === scenario?.targetVin ? null : vinDraftClean);
    setVinEditing(false);
    setVinDraft('');
  };
  const resetVinOverride = () => { setVinOverride(null); cancelVinEdit(); };

  const applyAction = async (actionId) => {
    if (!actionId) return;
    setPhase('busy');
    setErrMsg(null);
    try {
      const result = onAction?.(actionId, 'simple', vinOverride ? { vinOverride } : undefined);
      const rows = result && typeof result.then === 'function' ? await result : result;
      if (rows && (Array.isArray(rows) ? rows.length > 0 : true)) setPhase('done');
      else { setErrMsg('No changes were applied. Make sure all required dump files are loaded.'); setPhase('failed'); }
    } catch (e) {
      setErrMsg(e?.message || 'Could not apply the fix.');
      setPhase('failed');
    }
  };

  const apply = () => applyAction(recommended?.actionId);

  /* Empty state — no issues + no warnings */
  if (issues.length === 0 && warnings.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <div style={{ fontSize: 48, marginBottom: 10 }}>✅</div>
        <div style={{ fontWeight: 900, fontSize: 18, color: W.gn, marginBottom: 8, fontFamily: W.sans }}>
          Modules paired — ready to flash
        </div>
        <div style={{ fontSize: 13, color: W.ts, marginBottom: 18, lineHeight: 1.6, maxWidth: 480, margin: '0 auto 18px' }}>
          {modules.length > 0
            ? <>Your <strong>{modules.join(' + ')}</strong> dumps look correct. Flash them and power-cycle the vehicle for 30 seconds.</>
            : 'Drop BCM, key receiver and engine computer dumps to begin.'}
        </div>
        <button onClick={onClose} style={{ background: W.gn, border: 'none', borderRadius: 10, padding: '12px 32px', color: '#fff', fontWeight: 900, fontSize: 14, cursor: 'pointer', fontFamily: W.sans, letterSpacing: 1 }}>
          DONE
        </button>
      </div>
    );
  }

  /* Success */
  if (phase === 'done') {
    return (
      <div style={{ textAlign: 'center', padding: '20px 0' }}>
        <div style={{ fontSize: 48, marginBottom: 10 }}>🎉</div>
        <div style={{ fontWeight: 900, fontSize: 20, color: W.gn, marginBottom: 8, fontFamily: W.sans }}>
          Done — patched files saved
        </div>
        <div style={{ fontSize: 13, color: W.ts, marginBottom: 14, lineHeight: 1.7, maxWidth: 520, margin: '0 auto 14px' }}>
          New <strong>.bin</strong> files were saved to your <strong>Downloads folder</strong>.
          Flash each file to the matching module (Flashzilla / AlfaOBD / OBD), then power-cycle the vehicle battery for 30 seconds.
        </div>
        <div style={{ padding: '12px 16px', borderRadius: 10, marginTop: 8, marginBottom: 16, background: W.a1 + '14', border: `1px solid ${W.a1}30`, fontSize: 12, color: W.tx, lineHeight: 1.7, textAlign: 'left', maxWidth: 520, margin: '0 auto 16px' }}>
          <div style={{ fontWeight: 900, color: W.a1, marginBottom: 4 }}>⚡ After flashing</div>
          <div>✓ Flash each .bin via OBD / Flashzilla / AlfaOBD</div>
          <div>✓ Disconnect battery for 30 seconds</div>
          <div>✓ Re-import the dumps to verify the fix</div>
        </div>
        <button onClick={onClose} style={{ background: W.gn, border: 'none', borderRadius: 10, padding: '12px 32px', color: '#fff', fontWeight: 900, fontSize: 14, cursor: 'pointer', fontFamily: W.sans, letterSpacing: 1 }}>
          CLOSE
        </button>
      </div>
    );
  }

  /* ── Streamlined "named scenario" view for common pairings ──────────────
   * Replaces the multi-section "what you have / what's wrong / what I'll do
   * / FIX IT" breakdown with a single-confirmation card. Less common cases
   * fall through to the recommended/advanced flow below. */
  if (scenario && phase !== 'failed') {
    return (
      <div style={{ padding: '8px 0' }} data-testid="scenario-card">
        <div style={{ fontSize: 10, fontWeight: 800, color: W.ts, letterSpacing: 1.5, marginBottom: 6 }}>
          ONE-CLICK SCENARIO
        </div>
        <div style={{
          padding: '18px 18px',
          borderRadius: 14,
          background: `linear-gradient(135deg, ${W.gn}14, ${W.a2}14)`,
          border: `1.5px solid ${W.gn}55`,
          marginBottom: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 26 }}>🔧</div>
            <div style={{ fontWeight: 900, fontSize: 18, color: W.tx, fontFamily: W.sans, lineHeight: 1.2 }}>
              {scenario.name}
            </div>
          </div>
          <div style={{ fontSize: 13, color: W.tx, lineHeight: 1.6, marginBottom: 6 }}>
            {scenario.summary}
          </div>
          {recommended?.title && (
            <div style={{ fontSize: 12, color: W.gn, fontWeight: 700, marginBottom: 10, fontStyle: 'italic' }}>
              {recommended.title}
            </div>
          )}
          {(issues.length > 0 || warnings.length > 0) && (
            <div style={{ marginBottom: 10 }}>
              {issues.map((iss, i) => {
                const t = translateIssue(iss);
                return (
                  <div key={`i${i}`} style={{ fontSize: 12, color: W.tx, lineHeight: 1.5, marginBottom: 3 }}>
                    <span style={{ marginRight: 6 }}>❌</span>
                    {t.term ? <Tip word={t.term}>{t.plain}</Tip> : t.plain}
                  </div>
                );
              })}
              {warnings.map((wn, i) => {
                const t = translateIssue(wn);
                return (
                  <div key={`w${i}`} style={{ fontSize: 12, color: W.tx, lineHeight: 1.5, marginBottom: 3 }}>
                    <span style={{ marginRight: 6 }}>⚠️</span>
                    {t.term ? <Tip word={t.term}>{t.plain}</Tip> : t.plain}
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: W.ts, flexWrap: 'wrap', alignItems: 'center' }}>
            {modules.length > 0 && (
              <span>Loaded: <strong style={{ color: W.tx }}>{modules.join(' + ')}</strong></span>
            )}
            {scenario.modulesAffected.length > 0 && (
              <span>· Will write: <strong style={{ color: W.gn }}>{scenario.modulesAffected.join(' + ')}</strong></span>
            )}
            {effectiveVin && !vinEditing && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                · Master <Tip word="VIN" />:{' '}
                <button
                  data-testid="scenario-vin-edit-btn"
                  onClick={beginVinEdit}
                  title="Click to override the master VIN"
                  style={{
                    background: isCustomVin ? W.a1 + '22' : W.s3,
                    border: `1px solid ${isCustomVin ? W.a1 + '80' : W.bd}`,
                    borderRadius: 6, padding: '2px 8px',
                    fontFamily: W.mono, color: W.tx, fontWeight: 700,
                    letterSpacing: 1.5, fontSize: 11, cursor: 'pointer',
                  }}>
                  {effectiveVin} <span style={{ color: W.ts, fontWeight: 400, marginLeft: 4 }}>✎</span>
                </button>
                {isCustomVin && (
                  <span data-testid="scenario-vin-custom-badge" style={{
                    background: W.a1, color: '#fff', fontSize: 9, fontWeight: 800,
                    padding: '2px 6px', borderRadius: 4, letterSpacing: 1,
                    fontFamily: W.sans, textTransform: 'uppercase',
                  }}>custom VIN</span>
                )}
                {isCustomVin && (
                  <button
                    data-testid="scenario-vin-reset-btn"
                    onClick={resetVinOverride}
                    title={`Reset to auto-picked VIN (${scenario.targetVin})`}
                    style={{ background: 'none', border: 'none', color: W.ts, cursor: 'pointer', fontSize: 11, padding: 0, textDecoration: 'underline' }}>
                    reset
                  </button>
                )}
              </span>
            )}
            {vinEditing && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                · Master <Tip word="VIN" />:{' '}
                <input
                  data-testid="scenario-vin-input"
                  autoFocus
                  value={vinDraft}
                  onChange={e => setVinDraft(e.target.value.toUpperCase())}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && vinDraftValid) saveVinEdit();
                    else if (e.key === 'Escape') cancelVinEdit();
                  }}
                  maxLength={20}
                  spellCheck={false}
                  placeholder="17-char VIN"
                  style={{
                    background: W.bg,
                    border: `1.5px solid ${vinDraftClean.length === 0 ? W.bd : vinDraftValid ? W.gn : W.er}`,
                    borderRadius: 6, padding: '3px 8px',
                    fontFamily: W.mono, color: W.tx, fontWeight: 700,
                    letterSpacing: 1.5, fontSize: 11, width: 200, outline: 'none',
                    textTransform: 'uppercase',
                  }}
                />
                <span style={{ fontFamily: W.mono, fontSize: 10, color: vinDraftValid ? W.gn : W.tm, fontWeight: 700 }}>
                  {vinDraftClean.length}/17
                </span>
                <button
                  data-testid="scenario-vin-save-btn"
                  onClick={saveVinEdit}
                  disabled={!vinDraftValid}
                  style={{
                    background: vinDraftValid ? W.gn : W.bd, border: 'none', borderRadius: 6,
                    padding: '3px 10px', color: '#fff', fontWeight: 800, fontSize: 11,
                    cursor: vinDraftValid ? 'pointer' : 'not-allowed', fontFamily: W.sans,
                  }}>
                  Save
                </button>
                <button
                  onClick={cancelVinEdit}
                  style={{ background: 'none', border: `1px solid ${W.bd}`, borderRadius: 6, padding: '3px 10px', color: W.ts, cursor: 'pointer', fontSize: 11, fontFamily: W.sans }}>
                  Cancel
                </button>
              </span>
            )}
          </div>
          {vinEditing && vinDraftClean.length > 0 && !vinDraftValid && (
            <div style={{ marginTop: 6, fontSize: 11, color: W.er }}>
              Not a valid 17-char VIN (must start with 1-5; no I, O, or Q).
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
          <button
            data-testid="simple-fix-btn"
            onClick={() => applyAction(scenario.actionId)}
            disabled={phase === 'busy'}
            style={{
              background: phase === 'busy' ? W.bd : `linear-gradient(135deg, ${W.gn} 0%, ${W.a2} 100%)`,
              border: 'none', borderRadius: 10, padding: '14px 28px',
              color: '#fff', fontWeight: 900, fontSize: 14,
              cursor: phase === 'busy' ? 'wait' : 'pointer',
              fontFamily: W.sans, letterSpacing: 1,
              boxShadow: '0 4px 16px rgba(0,200,83,0.25)',
              flex: 1, minWidth: 240,
            }}>
            {phase === 'busy' ? 'Working…' : '✓ FIX IT — Download patched .bin'}
          </button>
          <button onClick={onClose} style={{ background: 'none', border: `1px solid ${W.bd}`, borderRadius: 10, padding: '12px 18px', color: W.ts, cursor: 'pointer', fontFamily: W.sans, fontSize: 12 }}>
            Cancel
          </button>
        </div>
        <div style={{ fontSize: 11, color: W.tm, marginTop: 8, lineHeight: 1.6 }}>
          One click writes the patched .bin file{scenario.modulesAffected.length === 1 ? '' : 's'} to your Downloads folder. Flash{scenario.modulesAffected.length === 1 ? ' it' : ' them'} and power-cycle the vehicle for 30 seconds.
        </div>
      </div>
    );
  }

  /* Plan / busy / failed */
  return (
    <div style={{ padding: '8px 0' }}>
      {/* What do you have */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: W.ts, letterSpacing: 1.5, marginBottom: 6 }}>WHAT YOU HAVE</div>
        <div style={{ padding: '12px 14px', borderRadius: 10, background: W.s3, border: `1px solid ${W.bd}`, fontSize: 13, color: W.tx, lineHeight: 1.6 }}>
          {modules.length > 0
            ? <>Loaded modules: <strong>{modules.join(' + ')}</strong></>
            : <span style={{ color: W.ts }}>No module dumps loaded yet.</span>}
          {recommended?.targetVin && (
            <div style={{ marginTop: 6, fontSize: 12, color: W.ts }}>
              Master <Tip word="VIN" />: <span style={{ fontFamily: W.mono, color: W.tx, fontWeight: 700, letterSpacing: 1.5 }}>{recommended.targetVin}</span>
            </div>
          )}
        </div>
      </div>

      {/* Issues in plain English */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: W.ts, letterSpacing: 1.5, marginBottom: 6 }}>WHAT'S WRONG</div>
        {issues.map((iss, i) => {
          const t = translateIssue(iss);
          return (
            <div key={i} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 6, background: W.er + '12', border: `1px solid ${W.er}30`, fontSize: 13, color: W.tx, lineHeight: 1.55 }}>
              <span style={{ marginRight: 6 }}>❌</span>
              {t.term ? <Tip word={t.term}>{t.plain}</Tip> : t.plain}
            </div>
          );
        })}
        {warnings.map((wn, i) => {
          const t = translateIssue(wn);
          return (
            <div key={i} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 6, background: W.wn + '10', border: `1px solid ${W.wn}30`, fontSize: 13, color: W.tx, lineHeight: 1.55 }}>
              <span style={{ marginRight: 6 }}>⚠️</span>
              {t.term ? <Tip word={t.term}>{t.plain}</Tip> : t.plain}
            </div>
          );
        })}
      </div>

      {/* What you'll do — recommended action */}
      {recommended && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: W.ts, letterSpacing: 1.5, marginBottom: 6 }}>WHAT I'LL DO</div>
          <div style={{ padding: '14px 16px', borderRadius: 12, background: `linear-gradient(135deg, ${W.gn}10, ${W.a2}10)`, border: `1.5px solid ${W.gn}40` }}>
            <div style={{ fontWeight: 900, fontSize: 14, color: W.gn, marginBottom: 8 }}>
              {recommended.title}
            </div>
            <ul style={{ margin: 0, paddingLeft: 22, fontSize: 13, color: W.tx, lineHeight: 1.7 }}>
              {recommended.plan.map((step, i) => <li key={i} style={{ marginBottom: 2 }}>{step}</li>)}
            </ul>
            {recommended.why && (
              <div style={{ fontSize: 11, color: W.ts, marginTop: 10, fontStyle: 'italic' }}>
                Why this matters: {recommended.why}
              </div>
            )}
          </div>
        </div>
      )}

      {!recommended && (
        <div style={{ padding: '12px 14px', borderRadius: 10, marginBottom: 14, background: W.wn + '14', border: `1px solid ${W.wn}40`, fontSize: 12, color: W.tx, lineHeight: 1.6 }}>
          No automatic fix is available for this combination. Switch on <strong>Advanced</strong> in the header to see the full step-by-step wizard, or ask the assistant below.
        </div>
      )}

      {phase === 'failed' && errMsg && (
        <div style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 14, background: W.er + '14', border: `1px solid ${W.er}40`, fontSize: 12, color: W.er, fontFamily: W.sans }}>
          {errMsg}
        </div>
      )}

      {/* Action row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
        {recommended && (
          <button
            data-testid="simple-fix-btn"
            onClick={apply}
            disabled={phase === 'busy'}
            style={{
              background: phase === 'busy' ? W.bd : `linear-gradient(135deg, ${W.gn} 0%, ${W.a2} 100%)`,
              border: 'none', borderRadius: 10, padding: '12px 28px',
              color: '#fff', fontWeight: 900, fontSize: 14,
              cursor: phase === 'busy' ? 'wait' : 'pointer',
              fontFamily: W.sans, letterSpacing: 1,
              boxShadow: '0 4px 16px rgba(0,200,83,0.25)',
              flex: 1, minWidth: 220,
            }}>
            {phase === 'busy' ? 'Working…' : `✓ FIX IT — ${recommended.modulesAffected.length || 'all'} module${recommended.modulesAffected.length === 1 ? '' : 's'}`}
          </button>
        )}
        <button onClick={onClose} style={{ background: 'none', border: `1px solid ${W.bd}`, borderRadius: 10, padding: '12px 18px', color: W.ts, cursor: 'pointer', fontFamily: W.sans, fontSize: 12 }}>
          Cancel
        </button>
      </div>
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
  sessionKey,
  /* Task #383 — resolved BCM SEC16 provenance (info.bcmSec16 from
   * parseModule). Used to render the same source chip / virgin explainer
   * shown in KeyProgTab next to BCM SEC16 hex rows in the wizard. */
  bcmSec16Status = null,
  /* Task #694 — raw bytes per module ({ BCM: Uint8Array, RFH: Uint8Array, ... }).
   * When supplied, the AI chat panel will base64-encode them and call the
   * tool-use endpoint instead of the plain-text one. */
  moduleBytes = null,
}) {
  const [phase, setPhase] = useState('summary');
  const [currentStep, setCurrentStep] = useState(0);
  const [doneSteps, setDoneSteps] = useState(new Set());
  const [skippedSteps, setSkippedSteps] = useState(new Set());
  const [advanced, setAdvancedState] = useState(() => loadAdvanced(`wizard:${sessionKey || 'global'}`));
  const setAdvanced = (v) => {
    setAdvancedState(v);
    saveAdvanced(`wizard:${sessionKey || 'global'}`, v);
  };
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

  /* Task #694 — build the {binaryBase64, binaries} payload for the chat
   * panel from the raw module bytes the caller passed in. Pick the first
   * available module as "primary" (the implicit binary for tools that
   * don't specify binaryName) and expose every loaded module by name. */
  const chatBinaryData = useMemo(() => {
    if (!moduleBytes) return null;
    const entries = Object.entries(moduleBytes).filter(([, b]) => b && b.length > 0);
    if (entries.length === 0) return null;
    const toB64 = (bytes) => {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
    };
    const binaries = {};
    for (const [name, bytes] of entries) binaries[name] = toB64(bytes);
    return { binaryBase64: binaries[entries[0][0]], binaries };
  }, [moduleBytes]);

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

  const handleAction = (actionId, stepId, opts) => {
    return onAction?.(actionId, stepId, opts);
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
              {!advanced ? 'GUIDED FIX'
                : phase === 'summary' ? 'ISSUE SUMMARY'
                : phase === 'steps' ? `STEP ${currentStep + 1} OF ${steps.length} · ${doneSteps.size} RESOLVED`
                : 'FINAL CHECKLIST'}
              {modules.length > 0 && ` · ${modules.join(' + ')}`}
            </div>
          </div>

          {/* Advanced toggle */}
          <label
            data-testid="wizard-advanced-toggle"
            title="Show byte-level diffs, offset tables, sync strategy picker, and AI chat"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: advanced ? W.a3 : W.ts, fontFamily: W.sans, cursor: 'pointer', userSelect: 'none', padding: '4px 10px', borderRadius: 8, border: `1px solid ${advanced ? W.a3 + '60' : W.bd}`, background: advanced ? W.a3 + '14' : 'none' }}>
            <input type="checkbox" checked={advanced} onChange={e => setAdvanced(e.target.checked)} style={{ accentColor: W.a3, cursor: 'pointer' }} />
            Advanced
          </label>

          {/* Step dot nav */}
          {advanced && phase === 'steps' && steps.length > 1 && (
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
            {/* Task #468 — surface the same per-module Connection Guides
             * row that lives at the top of the Module Sync workspace
             * (#464) so techs see which programmer to wire to which chip
             * BEFORE picking a tool inside the wizard. Visible in the
             * Simple flow (single-screen "what you have / what's wrong /
             * what I'll do") and in the Advanced flow's pre-action
             * phases (summary + per-issue step cards). Hidden on the
             * post-action Final Checklist where the tech has already
             * flashed and no longer needs to pick a programmer. */}
            {(!advanced || phase === 'summary' || phase === 'steps') && (
              <WizardConnectionGuides />
            )}

            {!advanced && (
              <SimpleFlow
                issues={issues}
                warnings={warnings}
                modules={modules}
                hexSnippets={hexSnippets}
                stepActions={stepActions}
                onAction={handleAction}
                onClose={onClose}
              />
            )}

            {advanced && phase === 'summary' && (
              <SummaryScreen issues={issues} warnings={warnings} modules={modules}
                onStart={() => { setPhase('steps'); setCurrentStep(0); }} />
            )}

            {advanced && phase === 'steps' && (
              <div>
                <WizardStepCard
                  step={steps[currentStep]}
                  stepNum={currentStep + 1}
                  total={steps.length}
                  stepActions={stepActions}
                  hexSnippets={hexSnippets}
                  bcmSec16Status={bcmSec16Status}
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

            {advanced && phase === 'final' && (
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

          {/* Claude chat — Advanced mode only */}
          {advanced && (
            <div style={{ flexShrink: 0, padding: '10px 20px 16px 20px' }}>
              <ChatPanel moduleContext={moduleContext} autoGreet={autoGreet} sessionKey={sessionKey} binaryData={chatBinaryData} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
