import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Card, Btn } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { parseTrace } from '../lib/udsSessionAnalyzer/parser.js';
import { analyzeSession } from '../lib/udsSessionAnalyzer/analyze.js';
import { resolveSession } from '../lib/udsSessionAnalyzer/resolver.js';
import { consumeUdsAnalyzerHandoff } from '../lib/canRecorder.js';
import {
  buildShareUrl,
  decodeShareFragment,
  findSensitiveInText,
  hasSensitiveFindings,
  scrubSensitiveFromText,
  SENSITIVE_CATEGORY_LABELS,
} from '../lib/udsSessionAnalyzer/shareLink.js';
import exampleLog from '../lib/udsSessionAnalyzer/fixtures/example_session.log?raw';

const ACCEPT = '.log,.txt,.asc,.trc';

const SEV_COLOR = { OK: C.gn, WARN: '#F59E0B', FAIL: C.er };

const FORMAT_LABELS = {
  candump: 'candump',
  txrx: 'TX/RX',
  reqresp: 'Req/Resp',
  bare: 'bare hex',
  canraw: 'canraw (CAN id-first)',
  unknown: 'unknown',
  none: 'none',
};
const SEV_BG    = { OK: '#E8F5E9', WARN: '#FFFBEB', FAIL: '#FFEBEE' };

function SeverityChip({ severity }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: 1,
      background: SEV_BG[severity] || '#F4F1EC',
      color: SEV_COLOR[severity] || C.ts,
      fontFamily: "'JetBrains Mono'",
      border: `1px solid ${SEV_COLOR[severity] || C.bd}33`,
    }}>
      {severity}
    </span>
  );
}

function DiagCard({ item }) {
  const col = SEV_COLOR[item.severity] || C.ts;
  const icon = item.severity === 'OK' ? '✓' : item.severity === 'WARN' ? '⚠' : '✗';
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 10,
      border: `1px solid ${col}30`,
      background: `${col}08`,
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
        <span style={{ color: col, fontWeight: 900, fontSize: 14, flexShrink: 0 }}>{icon}</span>
        <div style={{ flex: 1, fontSize: 12, fontWeight: 700, color: C.tx }}>{item.message}</div>
        <SeverityChip severity={item.severity} />
      </div>
      <div style={{
        fontSize: 11,
        color: C.ts,
        lineHeight: 1.6,
        borderLeft: `2px solid ${col}40`,
        marginLeft: 6,
        paddingLeft: 10,
      }}>
        {item.recommendation}
      </div>
    </div>
  );
}

const SOURCE_BADGE_STYLE = {
  iso14229: { bg: '#E3F2FD', fg: '#0D47A1', label: 'ISO 14229' },
  'alfaobd-intel-unverified': { bg: '#FFF3E0', fg: '#E65100', label: 'AlfaOBD · unverified' },
};

function SourceBadge({ source }) {
  const s = SOURCE_BADGE_STYLE[source];
  if (!s) return null;
  return (
    <span
      title={source}
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        marginLeft: 6,
        borderRadius: 6,
        fontSize: 8,
        fontWeight: 800,
        letterSpacing: 0.5,
        background: s.bg,
        color: s.fg,
        fontFamily: "'JetBrains Mono'",
        verticalAlign: 'middle',
      }}
    >
      {s.label}
    </span>
  );
}

function ResolvedCell({ resolved }) {
  if (!resolved || (!resolved.ecuName && !resolved.serviceLabel && !resolved.routineLabel)) {
    return <span style={{ color: C.tm, fontStyle: 'italic', fontSize: 10 }}>unresolved</span>;
  }
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      {resolved.ecuName && (
        <span style={{ fontWeight: 700, color: C.tx }}>
          {resolved.ecuName.value}
          <SourceBadge source={resolved.ecuName.source} />
        </span>
      )}
      {resolved.routineLabel && (
        <span style={{ color: C.a3 }}>
          {resolved.routineLabel.value}
          <SourceBadge source={resolved.routineLabel.source} />
        </span>
      )}
      {!resolved.ecuName && !resolved.routineLabel && resolved.serviceLabel && (
        <span style={{ color: C.ts }}>
          {resolved.serviceLabel.value}
          <SourceBadge source={resolved.serviceLabel.source} />
        </span>
      )}
    </span>
  );
}

function ExchangeRow({ ex, idx }) {
  const [open, setOpen] = useState(false);
  const col = SEV_COLOR[ex.severity] || C.ts;

  return (
    <div
      data-testid="uds-analyzer-exchange-row"
      style={{
        borderBottom: `1px solid ${C.bd}`,
        background: open ? `${col}05` : 'transparent',
      }}
    >
      <div
        onClick={() => setOpen(p => !p)}
        style={{
          display: 'grid',
          gridTemplateColumns: '28px 60px 160px 90px 1.2fr 1fr',
          gap: 8,
          padding: '7px 12px',
          cursor: 'pointer',
          alignItems: 'center',
          fontSize: 11,
        }}
      >
        <div style={{ color: C.tm, fontFamily: "'JetBrains Mono'", fontSize: 9 }}>
          {ex.request?.ts != null ? ex.request.ts.toFixed(3) : idx + 1}
        </div>
        <SeverityChip severity={ex.severity} />
        <div style={{ fontWeight: 700, color: C.tx, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ex.service}
          {ex.subFunction != null && (
            <span style={{ color: C.tm, fontWeight: 400 }}> / 0x{ex.subFunction.toString(16).toUpperCase().padStart(2, '0')}</span>
          )}
        </div>
        <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.ts, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ex.requestBytes || '—'}
        </div>
        <div data-testid="uds-analyzer-resolved-cell" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}>
          <ResolvedCell resolved={ex.resolved} />
        </div>
        <div style={{ fontSize: 11, color: col, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ex.verdict}
        </div>
      </div>
      {open && (
        <div style={{ padding: '0 12px 10px 28px', fontSize: 11 }}>
          {ex.resolved && (ex.resolved.ecuName || ex.resolved.routineLabel) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {ex.resolved.ecuName && (
                <span
                  data-testid="uds-analyzer-resolved-ecu"
                  style={{
                    display: 'inline-block',
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 10,
                    fontWeight: 700,
                    background: `${C.a4}15`,
                    color: C.a4,
                    border: `1px solid ${C.a4}40`,
                    fontFamily: "'JetBrains Mono'",
                  }}
                >
                  ECU: {Array.isArray(ex.resolved.ecuName) ? ex.resolved.ecuName.join(' / ') : ex.resolved.ecuName}
                </span>
              )}
              {ex.resolved.routineLabel && (
                <span
                  data-testid="uds-analyzer-resolved-routine"
                  style={{
                    display: 'inline-block',
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 10,
                    fontWeight: 700,
                    background: `${C.gn}15`,
                    color: C.gn,
                    border: `1px solid ${C.gn}40`,
                    fontFamily: "'JetBrains Mono'",
                  }}
                >
                  Routine: {ex.resolved.routineLabel}
                </span>
              )}
            </div>
          )}
          {ex.requestBytes && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: C.tm, fontWeight: 700, marginRight: 6 }}>REQ:</span>
              <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.a4 }}>{ex.requestBytes}</code>
            </div>
          )}
          {ex.responseBytes && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: C.tm, fontWeight: 700, marginRight: 6 }}>RESP:</span>
              <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: ex.nrcCode ? C.er : C.gn }}>{ex.responseBytes}</code>
            </div>
          )}
          {ex.dids && ex.dids.length >= 2 ? (
            <div style={{ marginTop: 6, marginBottom: 4 }}>
              <div style={{ fontSize: 9, color: C.tm, fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>
                {ex.dids.length} DIDs IN THIS EXCHANGE
              </div>
              {ex.dids.map((row, i) => (
                <div key={i} style={{
                  padding: '6px 8px',
                  background: `${C.a4}10`,
                  borderLeft: `2px solid ${C.a4}`,
                  borderRadius: 4,
                  marginBottom: 4,
                }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.a4, fontWeight: 700 }}>{row.label}</code>
                    <span style={{ color: C.tx, fontWeight: 600 }}>
                      {row.name || 'Unknown DID (no catalog entry)'}
                    </span>
                  </div>
                  {row.decoded != null && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ color: C.tm, fontWeight: 700, fontSize: 10 }}>DECODED:</span>
                      <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.gn, wordBreak: 'break-all' }}>{row.decoded}</code>
                    </div>
                  )}
                  {row.bytes && (
                    <div style={{ marginTop: 2, display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ color: C.tm, fontWeight: 700, fontSize: 10 }}>BYTES:</span>
                      <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.ts, wordBreak: 'break-all' }}>{row.bytes}</code>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : ex.did && (
            <div style={{ marginTop: 6, marginBottom: 4, padding: '6px 8px', background: `${C.a4}10`, borderLeft: `2px solid ${C.a4}`, borderRadius: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: C.tm, fontWeight: 700 }}>DID:</span>
                <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.a4, fontWeight: 700 }}>{ex.did.label}</code>
                <span style={{ color: C.tx, fontWeight: 600 }}>
                  {ex.did.name || 'Unknown DID (no catalog entry)'}
                </span>
              </div>
              {ex.did.decoded != null && (
                <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ color: C.tm, fontWeight: 700 }}>DECODED:</span>
                  <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.gn, wordBreak: 'break-all' }}>{ex.did.decoded}</code>
                </div>
              )}
            </div>
          )}
          <div style={{ color: C.ts, lineHeight: 1.6, marginTop: 4 }}>{ex.verdict}</div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ summary, ecuCoverage }) {
  const saColor = summary.securityAccessUnlocked ? C.gn
    : summary.lockoutActive ? C.er
    : summary.securityAccessSeen ? '#F59E0B'
    : C.tm;

  const saLabel = summary.securityAccessUnlocked ? '✓ UNLOCKED'
    : summary.lockoutActive ? '✗ LOCKED OUT'
    : summary.securityAccessSeen ? '⚡ SEEN / NOT UNLOCKED'
    : '— NOT SEEN';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
      {[
        { label: 'MESSAGES PARSED', value: summary.messageCount, color: C.a4 },
        { label: 'EXCHANGES', value: summary.exchangeCount, color: C.a4 },
        {
          label: 'SECURITY ACCESS',
          value: saLabel,
          color: saColor,
          mono: true,
        },
        {
          label: 'FIRST FAILURE',
          value: summary.firstFailure
            ? `${summary.firstFailure}${summary.firstFailureNrc != null ? ` (NRC 0x${summary.firstFailureNrc.toString(16).toUpperCase().padStart(2,'0')})` : ''}`
            : '—',
          color: summary.firstFailure ? C.er : C.gn,
        },
        ...(ecuCoverage ? [{
          label: 'ECU COVERAGE',
          value: `${ecuCoverage.resolved} of ${ecuCoverage.total} exchanges resolved`,
          color: ecuCoverage.resolved > 0 ? C.a4 : C.tm,
          testId: 'uds-analyzer-ecu-coverage',
        }] : []),
      ].map(item => (
        <div key={item.label} data-testid={item.testId} style={{
          padding: '10px 14px',
          background: C.c2,
          borderRadius: 10,
          border: `1px solid ${C.bd}`,
        }}>
          <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: 2, color: C.tm, marginBottom: 4 }}>
            {item.label}
          </div>
          <div style={{
            fontSize: item.mono ? 10 : 18,
            fontWeight: 900,
            color: item.color,
            fontFamily: item.mono ? "'JetBrains Mono'" : undefined,
          }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function UdsAnalyzerTab() {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState(null);
  const [filterSev, setFilterSev] = useState('ALL');
  const [filterText, setFilterText] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const [sharePrompt, setSharePrompt] = useState(null); // { findings } | null
  const fileRef = useRef(null);
  const shareTimerRef = useRef(null);

  const [parseWarning, setParseWarning] = useState(false);

  const analyze = useCallback((src) => {
    if (!src.trim()) { setResult(null); setParseWarning(false); return; }
    const parsed = parseTrace(src);
    if (parsed.messageCount === 0) {
      setResult(null);
      setParseWarning(true);
      return;
    }
    setParseWarning(false);
    const session = resolveSession(analyzeSession(parsed.lines));
    setResult({ parsed, session });
  }, []);

  // Task #724 — pull a live-capture handoff from the recorder hook on
  // mount so the "Analyze UDS" buttons on the Live OBD / J2534 / CDA6
  // recorder cards drop the user straight into a populated, already-
  // analyzed session.
  //
  // Task #736 — also check the URL fragment for a shared trace
  // (`#uds=<gzip+base64url>`). When present, rehydrate the textarea and
  // auto-run analyze so the recipient lands on the same populated view.
  // Live-capture handoff takes precedence; the fragment is consumed
  // (cleared from the URL bar) after a successful decode so refreshes
  // don't re-trigger.
  useEffect(() => {
    const h = consumeUdsAnalyzerHandoff();
    if (h) {
      setText(h.text);
      setFileName(h.name);
      analyze(h.text);
      return;
    }
    let cancelled = false;
    (async () => {
      const decoded = await decodeShareFragment(window.location.hash);
      if (cancelled || !decoded) return;
      setText(decoded);
      setFileName('shared trace');
      analyze(decoded);
      try {
        const url = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        window.history.replaceState(null, '', url);
      } catch {
        // Non-fatal — fragment cleanup is a nice-to-have.
      }
    })();
    return () => { cancelled = true; };
  }, [analyze]);

  useEffect(() => () => {
    if (shareTimerRef.current) clearTimeout(shareTimerRef.current);
  }, []);

  const doShare = useCallback(async (src) => {
    setShareStatus('Preparing…');
    try {
      const url = await buildShareUrl(src);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setShareStatus('Copied!');
      } else {
        window.prompt('Copy share link:', url);
        setShareStatus('Ready');
      }
    } catch {
      setShareStatus('Failed');
    }
    if (shareTimerRef.current) clearTimeout(shareTimerRef.current);
    shareTimerRef.current = setTimeout(() => setShareStatus(''), 2000);
  }, []);

  const handleCopyShareLink = useCallback(async () => {
    if (!text.trim()) return;
    // Task #748 / Task #756 — pre-share sensitive-data scan. If the
    // trace contains a real VIN, SecurityAccess seed/key payload,
    // F1 8C ECU serial, F1 95 calibration ID, or PIN-shaped digit run
    // inside a known DID response, surface a confirm dialog grouped
    // by category so the user can scrub before the trace leaves their
    // machine.
    const findings = findSensitiveInText(text);
    if (hasSensitiveFindings(findings)) {
      setSharePrompt({ findings });
      return;
    }
    await doShare(text);
  }, [text, doShare]);

  const handleShareWithSensitive = useCallback(async () => {
    const src = text;
    setSharePrompt(null);
    await doShare(src);
  }, [text, doShare]);

  const handleShareScrubbed = useCallback(async () => {
    const scrubbed = scrubSensitiveFromText(text);
    setSharePrompt(null);
    setText(scrubbed);
    setFileName((prev) => (prev ? `${prev} (scrubbed)` : 'scrubbed trace'));
    analyze(scrubbed);
    await doShare(scrubbed);
  }, [text, doShare, analyze]);

  const handleShareCancel = useCallback(() => {
    setSharePrompt(null);
  }, []);

  const handleFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const t = String(ev.target.result || '');
      setText(t);
      analyze(t);
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [analyze]);

  const handleChange = useCallback((e) => {
    const t = e.target.value;
    setText(t);
    if (!t.trim()) setParseWarning(false);
  }, []);

  const handlePaste = useCallback((e) => {
    const pasted = e.clipboardData?.getData('text') ?? '';
    if (!pasted) return;
    const el = e.target;
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + pasted + text.slice(end);
    e.preventDefault();
    setText(next);
    setFileName('pasted trace');
    analyze(next);
  }, [text, analyze]);

  const handleAnalyze = useCallback(() => analyze(text), [analyze, text]);
  const handleClear = useCallback(() => { setText(''); setFileName(''); setResult(null); setFilterSev('ALL'); setFilterText(''); setParseWarning(false); }, []);
  const handleExample = useCallback(() => {
    const t = exampleLog;
    setText(t);
    setFileName('example_session.log');
    analyze(t);
  }, [analyze]);

  const filteredExchanges = useMemo(() => {
    if (!result) return [];
    let exs = result.session.exchanges;
    if (filterSev !== 'ALL') exs = exs.filter(e => e.severity === filterSev);
    if (filterText) {
      const f = filterText.toLowerCase();
      exs = exs.filter(e =>
        e.service?.toLowerCase().includes(f) ||
        e.verdict?.toLowerCase().includes(f) ||
        e.requestBytes?.toLowerCase().includes(f) ||
        e.responseBytes?.toLowerCase().includes(f) ||
        e.resolvedText?.toLowerCase().includes(f)
      );
    }
    return exs;
  }, [result, filterSev, filterText]);

  const sevCounts = useMemo(() => {
    if (!result) return { OK: 0, WARN: 0, FAIL: 0 };
    return result.session.exchanges.reduce((acc, e) => {
      acc[e.severity] = (acc[e.severity] || 0) + 1;
      return acc;
    }, { OK: 0, WARN: 0, FAIL: 0 });
  }, [result]);

  // Task #826 — ECU COVERAGE metric: how many exchanges had their request
  // CAN ID reverse-resolved to a friendly ECU name via the alfaobd-il map.
  const ecuCoverage = useMemo(() => {
    if (!result) return null;
    const total = result.session.exchanges.length;
    const resolved = result.session.exchanges.filter(e => e.resolved?.ecuName).length;
    return { total, resolved };
  }, [result]);

  return (
    <div data-testid="uds-analyzer-tab">
      {sharePrompt && (
        <div
          data-testid="uds-analyzer-vin-warn"
          style={{
            position: 'fixed', inset: 0, background: '#0008', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
          onClick={handleShareCancel}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 12, padding: 20, maxWidth: 540,
              border: `2px solid ${C.sr}`, boxShadow: '0 10px 40px #0006',
            }}
          >
            <div style={{ fontFamily: "'Righteous'", fontSize: 18, color: C.sr, letterSpacing: 1, marginBottom: 8 }}>
              ⚠ SENSITIVE DATA DETECTED
            </div>
            <div style={{ fontSize: 12, color: C.tx, marginBottom: 10, lineHeight: 1.5 }}>
              This trace contains identifying data that will be embedded in the share link. Anyone with the link can read it.
            </div>
            <div
              data-testid="uds-analyzer-vin-categories"
              style={{
                background: C.c2, border: `1px solid ${C.bd}`, borderRadius: 6,
                padding: '6px 10px', marginBottom: 12, maxHeight: 220, overflowY: 'auto',
              }}
            >
              {Object.entries(SENSITIVE_CATEGORY_LABELS).map(([key, label]) => {
                const items = sharePrompt.findings?.[key] || [];
                if (items.length === 0) return null;
                return (
                  <div key={key} data-testid={`uds-analyzer-vin-category-${key}`} style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: C.sr, marginBottom: 2 }}>
                      {label} · {items.length}
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.ts, paddingLeft: 8 }}>
                      {items.slice(0, 6).map((item, i) => {
                        let preview;
                        if (key === 'vins') preview = item;
                        else if (key === 'pins') preview = `${item.didLabel} → ${item.digits}`;
                        else if (key === 'seeds' || key === 'keys') preview = `SF 0x${item.subFunction.toString(16).toUpperCase().padStart(2, '0')} · ${item.bytesHex}`;
                        else preview = item.bytesHex;
                        return <div key={i} style={{ wordBreak: 'break-all' }}>{preview}</div>;
                      })}
                      {items.length > 6 && (
                        <div style={{ color: C.tm, fontStyle: 'italic' }}>… +{items.length - 6} more</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Btn onClick={handleShareCancel} color={C.tm} outline data-testid="uds-analyzer-vin-cancel">
                Cancel
              </Btn>
              <Btn onClick={handleShareWithSensitive} color={C.sr} outline data-testid="uds-analyzer-vin-share-real">
                Share as-is
              </Btn>
              <Btn onClick={handleShareScrubbed} color={C.gn} data-testid="uds-analyzer-vin-scrub">
                Scrub first
              </Btn>
            </div>
          </div>
        </div>
      )}
      <Card style={{ background: 'linear-gradient(135deg,#1A0A0A 0%,#3D0A0A 40%,#D32F2F 100%)', color: '#fff', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 32 }}>🔍</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 24, letterSpacing: 2 }}>UDS ANALYZER</div>
            <div style={{ fontSize: 10, opacity: 0.7, letterSpacing: 3, fontWeight: 700 }}>POST-MORTEM TRACE · NRC DECODE · SESSION DIAGNOSIS</div>
          </div>
          {result && (
            <div style={{
              fontSize: 11, padding: '6px 12px',
              background: result.session.diagnosis.some(d => d.severity === 'FAIL') ? '#FF174433' : '#00C85333',
              borderRadius: 8,
              border: `1px solid ${result.session.diagnosis.some(d => d.severity === 'FAIL') ? '#FF1744' : '#00C853'}`,
            }}>
              {result.session.diagnosis.some(d => d.severity === 'FAIL') ? '✗ ISSUES FOUND' : '✓ CLEAN'}
            </div>
          )}
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2 }}>📂 LOAD TRACE</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            onChange={handleFile}
            style={{ display: 'none' }}
          />
          <Btn onClick={() => fileRef.current?.click()} color={C.a4} outline>
            📁 Open file
          </Btn>
          <Btn onClick={handleExample} color={C.a3} outline>
            💡 Load example
          </Btn>
          <Btn onClick={handleAnalyze} color={C.sr} disabled={!text.trim()}>
            ▶ Analyze
          </Btn>
          <Btn onClick={handleClear} color={C.tm} outline disabled={!text && !result}>
            ✕ Clear
          </Btn>
          <Btn
            onClick={handleCopyShareLink}
            color={C.a4}
            outline
            disabled={!text.trim()}
            data-testid="uds-analyzer-copy-share"
          >
            🔗 Copy share link
          </Btn>
          {shareStatus && (
            <span style={{ fontSize: 11, color: C.gn, fontWeight: 700 }}>{shareStatus}</span>
          )}
          {fileName && (
            <span style={{ fontSize: 11, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{fileName}</span>
          )}
          {result && (
            <span style={{ fontSize: 10, color: C.tm, marginLeft: 'auto' }}>
              {result.parsed.messageCount} lines · format: <strong>{FORMAT_LABELS[result.parsed.formatDetected] || result.parsed.formatDetected}</strong>
            </span>
          )}
        </div>
        <textarea
          data-testid="uds-analyzer-paste"
          value={text}
          onChange={handleChange}
          onPaste={handlePaste}
          placeholder={`Paste a UDS trace here (auto-analyzes on paste) or open a file — supports:
  • candump: (0.000) can0 7E0#0322F190CC
  • TX/RX:   [0.050] TX 7E0 22 F1 90
  • Req/Resp: [Req] 10 03  /  [Resp] 50 03 00 19 01 F4
  • Bare hex: 10 03  /  50 03 00 19 01 F4
  • canraw:   18DA40F1 03 22 F1 90  (raw CAN id-first; also [0.050] 7E0 03 22 F1 90 — J2534 / PEAK / Vector logs)`}
          style={{
            width: '100%',
            height: 120,
            fontFamily: "'JetBrains Mono'",
            fontSize: 11,
            padding: '8px 10px',
            border: `1px solid ${C.bd}`,
            borderRadius: 8,
            resize: 'vertical',
            background: '#FAFAF8',
            color: C.tx,
          }}
        />
        {parseWarning && (
          <div
            data-testid="uds-analyzer-parse-warning"
            style={{
              marginTop: 8,
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${C.er}`,
              background: '#FFEBEE',
              color: C.er,
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1.5,
            }}
          >
            ⚠ 0 messages parsed — unrecognized format. Expected candump, TX/RX, Req/Resp, bare hex, or canraw.
          </div>
        )}
      </Card>

      {result && (
        <>
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 12, letterSpacing: 2 }}>📊 SESSION SUMMARY</div>
            <SummaryCard summary={result.session.summary} ecuCoverage={ecuCoverage} />
          </Card>

          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 12, letterSpacing: 2 }}>
              🩺 DIAGNOSIS &amp; RECOMMENDATIONS
            </div>
            {result.session.diagnosis.map((item, i) => (
              <DiagCard key={i} item={item} />
            ))}
          </Card>

          <Card style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 11, color: C.sr, letterSpacing: 2 }}>
                🔁 EXCHANGES ({filteredExchanges.length})
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {['ALL', 'OK', 'WARN', 'FAIL'].map(sev => (
                  <button
                    key={sev}
                    onClick={() => setFilterSev(sev)}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 8,
                      border: `1px solid ${sev === 'ALL' ? C.bd : SEV_COLOR[sev] || C.bd}`,
                      background: filterSev === sev ? (SEV_COLOR[sev] || C.a4) + '20' : 'transparent',
                      color: sev === 'ALL' ? C.tx : SEV_COLOR[sev],
                      cursor: 'pointer',
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: 1,
                    }}
                  >
                    {sev}{sev !== 'ALL' ? ` (${sevCounts[sev] || 0})` : ''}
                  </button>
                ))}
                <input
                  value={filterText}
                  onChange={e => setFilterText(e.target.value)}
                  placeholder="filter…"
                  style={{
                    padding: '4px 8px',
                    border: `1px solid ${C.bd}`,
                    borderRadius: 6,
                    fontSize: 11,
                    width: 130,
                  }}
                />
              </div>
            </div>

            <div style={{ fontSize: 10, color: C.tm, marginBottom: 6, padding: '0 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 700, letterSpacing: 1 }}>SOURCES:</span>
              <SourceBadge source="iso14229" />
              <span style={{ fontSize: 10 }}>= canonical ISO 14229</span>
              <SourceBadge source="alfaobd-intel-unverified" />
              <span style={{ fontSize: 10 }}>= AlfaOBD .exe intel (unverified, treat as hint)</span>
            </div>
            <div style={{ fontSize: 9, color: C.tm, marginBottom: 6, display: 'grid', gridTemplateColumns: '28px 60px 160px 90px 1.2fr 1fr', gap: 8, padding: '0 12px', fontWeight: 700, letterSpacing: 1 }}>
              <div>TIME</div><div>SEV</div><div>SERVICE / SUB</div><div>REQ BYTES</div><div>RESOLVED</div><div>VERDICT</div>
            </div>
            <div style={{ border: `1px solid ${C.bd}`, borderRadius: 8, maxHeight: 440, overflowY: 'auto' }}>
              {filteredExchanges.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: C.tm, fontSize: 12 }}>
                  No exchanges match the current filter.
                </div>
              ) : (
                filteredExchanges.map((ex, i) => (
                  <ExchangeRow key={i} ex={ex} idx={i} />
                ))
              )}
            </div>
          </Card>
        </>
      )}

      {!result && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: C.tm, fontSize: 12 }}>
          <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.4 }}>🔍</div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Load or paste a UDS trace to begin</div>
          <div style={{ fontSize: 11 }}>
            Hit <strong>Load example</strong> to see a demo session with a wrong-key attempt,
            time-delay enforcement, and a RoutineControl failure.
          </div>
        </div>
      )}
    </div>
  );
}
