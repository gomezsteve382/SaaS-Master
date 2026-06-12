import React, { useState, useMemo, useContext, useEffect } from 'react';
import {
  Bot, ChevronRight, Wrench, Car, Search, X, Plug, PlugZap, AlertCircle,
  BookOpen, Zap, KeyRound, Radio, HardDrive, Wifi, Eye,
} from 'lucide-react';
import { MasterVinContext } from '../lib/masterVinContext.jsx';
import { useBridgeStatus, DEFAULT_BRIDGE_URL } from '../lib/bridgeClient.js';
import { JOBS, JOB_ORDER, JOB_BY_ID, jobOf, HOME } from '../lib/workspaceJobs.js';

/* ─── Design tokens ─────────────────────────────────────────────────────── */
const T = {
  base: '#F4F1EC',
  panel: '#FFFFFF',
  ink: '#1A1A1A',
  red: '#D32F2F',
  muted: '#6B6B6B',
  line: '#E2DDD3',
  good: '#2E7D32',
};

/* ─── Per-job accent colours ─────────────────────────────────────────────── */
const JOB_STYLE = {
  read:  { accent: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  icon: Eye },
  marry: { accent: '#8b5cf6', bg: 'rgba(139,92,246,0.12)',  icon: Zap },
  keys:  { accent: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: KeyRound },
  flash: { accent: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: HardDrive },
  live:  { accent: '#22c55e', bg: 'rgba(34,197,94,0.12)',   icon: Wifi },
  ref:   { accent: '#6b7280', bg: 'rgba(107,114,128,0.12)', icon: BookOpen },
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function matchesQuery(tab, q) {
  if (!q) return true;
  return `${tab.l || ''} ${tab.s || ''} ${tab.id || ''}`.toLowerCase().includes(q);
}

/* ─── Advanced / Reference slide-out drawer ─────────────────────────────── */
function AdvancedDrawer({ open, onClose, tabs, activeTab, onSelect }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  // Build per-job groups from the full tab list
  const grouped = useMemo(() => {
    const g = {};
    for (const j of JOBS) g[j.id] = [];
    for (const t of tabs) {
      if (!matchesQuery(t, q)) continue;
      const jid = jobOf(t.id);
      if (!g[jid]) g[jid] = [];
      g[jid].push(t);
    }
    return g;
  }, [tabs, q]);

  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  const totalCount = tabs.length;

  return (
    <div
      role="dialog"
      aria-label="All tools — 6-job navigation"
      style={{ position: 'fixed', inset: 0, zIndex: 4000, display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(10,10,10,0.55)', backdropFilter: 'blur(2px)' }}
      />
      <aside
        data-testid="advanced-drawer"
        style={{
          position: 'relative', width: 420, maxWidth: '92vw', height: '100%',
          background: T.base, borderLeft: `1px solid ${T.line}`,
          boxShadow: '-12px 0 40px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column',
          fontFamily: "'Nunito',sans-serif",
        }}
      >
        {/* Drawer header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px',
          background: T.ink, color: '#fff', borderBottom: `3px solid ${T.red}`,
        }}>
          <Wrench size={17} style={{ color: T.red }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous',sans-serif", fontSize: 15, letterSpacing: 0.5 }}>ALL TOOLS</div>
            <div style={{ fontSize: 11, opacity: 0.65 }}>{totalCount} tools across 6 job doors</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close drawer"
            style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', color: '#fff', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'grid', placeItems: 'center' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.line}` }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: T.muted }} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all tools…"
              data-testid="advanced-drawer-search"
              aria-label="Search tools"
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box', background: T.panel,
                border: `1px solid ${T.line}`, borderRadius: 8, color: T.ink,
                padding: '8px 10px 8px 30px', fontSize: 13, fontFamily: "'Nunito',sans-serif", outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Job sections */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 40px' }}>
          {JOB_ORDER.map((jid) => {
            const job = JOB_BY_ID[jid];
            const items = grouped[jid] || [];
            if (items.length === 0) return null;
            const style = JOB_STYLE[jid] || JOB_STYLE.ref;
            const Icon = style.icon;

            return (
              <div key={jid} style={{ marginBottom: 20 }}>
                {/* Section header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 8px 7px',
                }}>
                  <div style={{ width: 3, height: 14, borderRadius: 2, background: style.accent, flexShrink: 0 }} />
                  <Icon size={13} style={{ color: style.accent, flexShrink: 0 }} />
                  <span style={{
                    fontFamily: "'Righteous',sans-serif", fontSize: 10, letterSpacing: 2.5,
                    color: style.accent, textTransform: 'uppercase',
                  }}>{job.label}</span>
                  <span style={{ fontSize: 10, color: T.muted, opacity: 0.7 }}>— {job.sub}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: T.muted }}>{items.length}</span>
                </div>

                {/* Tab buttons */}
                {items.map((t) => {
                  const active = activeTab === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      data-testid={`drawer-tab-${t.id}`}
                      onClick={() => { onSelect(t.id); onClose(); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                        background: active ? style.accent : T.panel,
                        color: active ? '#fff' : T.ink,
                        border: `1px solid ${active ? style.accent : T.line}`,
                        borderLeft: active ? `3px solid ${style.accent}` : `3px solid ${style.bg.replace('0.12', '0.45')}`,
                        borderRadius: 10, padding: '9px 12px 9px 10px', marginBottom: 5, cursor: 'pointer',
                        textAlign: 'left', fontFamily: "'Nunito',sans-serif",
                        transition: 'background 120ms ease-out, border-color 120ms ease-out',
                      }}
                      onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = style.bg; e.currentTarget.style.borderLeftColor = style.accent; } }}
                      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = T.panel; e.currentTarget.style.borderLeftColor = style.bg.replace('0.12', '0.45'); } }}
                    >
                      <span style={{
                        width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, borderRadius: 8,
                        background: active ? 'rgba(255,255,255,0.18)' : style.bg,
                        fontSize: 18, lineHeight: 1,
                      }}>
                        {t.i}
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                        <span style={{ fontWeight: 800, fontSize: 12.5, letterSpacing: 0.4, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.l}</span>
                        <span style={{ fontSize: 11, opacity: active ? 0.88 : 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{t.s}</span>
                      </span>
                      {active && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'rgba(255,255,255,0.75)', flexShrink: 0 }}>ACTIVE</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}

          {JOB_ORDER.every(k => (grouped[k] || []).length === 0) && (
            <div style={{ color: T.muted, fontSize: 12, padding: '16px 8px' }}>No tools match "{query}".</div>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ─── Main CommandShell component ────────────────────────────────────────── */
export default function CommandShell({
  vehicle, onBack, onOpenWizard, onOpenCopilot, tabs, activeTab, onSelect, children,
}) {
  const { vin } = useContext(MasterVinContext);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [bridgeHelpOpen, setBridgeHelpOpen] = useState(false);
  const [selectedDll, setSelectedDll] = useState('topdon-artidiag');
  const [bridgeUrlInput, setBridgeUrlInput] = useState(DEFAULT_BRIDGE_URL);
  const bridge = useBridgeStatus(5000);

  // All registered J2534 DLLs confirmed on this machine + common extras
  const KNOWN_DLLS = [
    { id: 'topdon-artidiag', label: 'TOPDON R-Link / ArtiDiag VCI', path: 'C:\\Program Files (x86)\\TOPDON\\ArtiDiagVci\\PassThru432.dll', badge: 'RECOMMENDED', badgeColor: '#2E7D32', note: 'Confirmed on this machine. Best choice for FCA/Stellantis vehicles.' },
    { id: 'witech-legacy', label: 'Chrysler wiTECH Legacy VCI', path: 'C:\\Program Files (x86)\\DCC Tools\\wiTECH\\jserver\\app\\legacyVCI\\lvci32.dll', badge: 'FCA NATIVE', badgeColor: '#1565C0', note: 'OEM Chrysler/FCA J2534 driver.' },
    { id: 'autel-elite', label: 'Autel MaxiFlash Elite / Pro', path: 'C:\\Windows\\SysWOW64\\CFJW432.DLL', badge: '', badgeColor: '', note: 'Requires Autel VCI to be physically connected.' },
  ];
  const activeDll = KNOWN_DLLS.find(d => d.id === selectedDll) || KNOWN_DLLS[0];

  // Determine which job door is currently active (for rail highlighting)
  const activeJobId = activeTab === HOME.key ? null : jobOf(activeTab);

  // Build a lookup of tab objects by id for the drawer
  const tabById = useMemo(() => {
    const m = {};
    for (const t of tabs) m[t.id] = t;
    return m;
  }, [tabs]);

  // For each job, build the list of tab objects that actually exist in WORKSPACE_TABS
  const jobTabs = useMemo(() => {
    const result = {};
    for (const j of JOBS) {
      result[j.id] = j.members
        .map(id => tabById[id])
        .filter(Boolean);
    }
    return result;
  }, [tabById]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.base, color: T.ink, fontFamily: "'Nunito',sans-serif" }}>

      {/* ── Top bar ── */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 18, padding: '0 20px', height: 60,
        background: T.ink, color: '#fff', flexShrink: 0, borderBottom: `3px solid ${T.red}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 6, background: T.red, display: 'grid', placeItems: 'center', fontWeight: 900, fontFamily: "'Righteous',sans-serif" }}>S</div>
          <span style={{ fontFamily: "'Righteous',sans-serif", fontSize: 19, letterSpacing: '.04em' }}>SRT&nbsp;LAB</span>
        </div>

        {/* Active vehicle chip */}
        <button
          type="button"
          onClick={onBack}
          data-testid="topbar-vehicle-chip"
          title="Change vehicle"
          style={{
            display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
            background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.14)',
            borderRadius: 9, padding: '6px 12px', color: '#fff', textAlign: 'left',
          }}
        >
          <Car size={16} style={{ color: T.red, flexShrink: 0 }} />
          <div style={{ lineHeight: 1.15 }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>{vehicle.name}</div>
            <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, opacity: 0.7 }}>
              {vin && vin.length ? vin : 'NO VIN SET'}
            </div>
          </div>
          <ChevronRight size={15} style={{ opacity: 0.5, flexShrink: 0 }} />
        </button>

        <div style={{ flex: 1 }} />

        {/* J2534 Bridge status */}
        <button
          type="button"
          data-testid="topbar-bridge-btn"
          onClick={() => setBridgeHelpOpen(true)}
          title={bridge.connected ? `J2534 Bridge connected` : 'J2534 Bridge not connected — click to set up'}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            background: bridge.connected ? 'rgba(46,125,50,0.22)' : 'rgba(211,47,47,0.18)',
            border: `1px solid ${bridge.connected ? '#2E7D32' : '#D32F2F'}`,
            borderRadius: 9, padding: '6px 12px', color: '#fff', cursor: 'pointer',
            fontSize: 12, fontWeight: 700, letterSpacing: 0.5, transition: 'all 0.2s',
          }}
        >
          {bridge.connected
            ? <PlugZap size={14} style={{ color: '#69d36e', flexShrink: 0 }} />
            : <Plug size={14} style={{ color: '#FF6D00', flexShrink: 0 }} />}
          <span>{bridge.connected ? 'BRIDGE OK' : 'START BRIDGE'}</span>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: bridge.loading ? '#FFA726' : bridge.connected ? '#69d36e' : '#FF5252',
            boxShadow: bridge.connected
              ? '0 0 0 3px rgba(105,211,110,.28)'
              : bridge.loading ? '0 0 0 3px rgba(255,167,38,.28)'
              : '0 0 0 3px rgba(255,82,82,.28)',
          }} />
        </button>

        {/* AI Co-pilot */}
        <button
          type="button"
          data-testid="topbar-copilot-btn"
          onClick={onOpenCopilot}
          title="Open the AI Co-pilot"
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            background: 'transparent', color: '#fff',
            border: '1px solid rgba(255,255,255,.22)',
            borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
          }}
        >
          <Bot size={15} /> AI Co-pilot
        </button>

        {onOpenWizard && (
          <button
            type="button"
            data-testid="topbar-wizard-btn"
            onClick={onOpenWizard}
            title="Open the Mismatch Wizard"
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              background: 'linear-gradient(135deg,#D32F2F 0%,#FF6D00 100%)', color: '#fff',
              border: 'none', borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 800,
              cursor: 'pointer', boxShadow: '0 2px 12px rgba(211,47,47,0.35)',
            }}
          >
            <Wrench size={15} /> WIZARD
          </button>
        )}

        {/* All Tools drawer button */}
        <button
          type="button"
          data-testid="topbar-advanced-btn"
          onClick={() => setDrawerOpen(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            background: 'transparent', color: '#fff',
            border: '1px solid rgba(255,255,255,.22)',
            borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
          }}
        >
          <Wrench size={15} /> All Tools
          <span style={{ background: T.red, borderRadius: 20, padding: '1px 7px', fontSize: 10.5, fontWeight: 800 }}>{tabs.length}</span>
        </button>
      </header>

      {/* ── J2534 Bridge Setup Modal ── */}
      {bridgeHelpOpen && (
        <div
          role="dialog"
          aria-label="J2534 Bridge Setup"
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }}
          onClick={() => setBridgeHelpOpen(false)}
        >
          <div
            style={{ background: '#1C1C1C', border: `2px solid ${bridge.connected ? '#2E7D32' : '#D32F2F'}`, borderRadius: 18, padding: 32, maxWidth: 560, width: '92%', boxShadow: '0 32px 80px rgba(0,0,0,0.7)', fontFamily: "'Nunito',sans-serif" }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#D32F2F,#FF6D00)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <PlugZap size={22} color="#fff" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "'Righteous',sans-serif", fontSize: 22, color: '#fff', letterSpacing: 1 }}>J2534 BRIDGE SETUP</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>One-click launcher for TOPDON R-Link &amp; compatible adapters</div>
              </div>
              <button onClick={() => setBridgeHelpOpen(false)} style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '6px 10px' }}>&#x2715;</button>
            </div>
            <div style={{ background: bridge.connected ? 'rgba(46,125,50,0.18)' : 'rgba(211,47,47,0.14)', border: `1px solid ${bridge.connected ? '#2E7D32' : '#D32F2F'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 22, display: 'flex', alignItems: 'center', gap: 12 }}>
              {bridge.connected ? <PlugZap size={18} style={{ color: '#69d36e', flexShrink: 0 }} /> : <AlertCircle size={18} style={{ color: '#FF5252', flexShrink: 0 }} />}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: bridge.connected ? '#69d36e' : '#FF5252' }}>
                  {bridge.connected ? '✓ Bridge Connected' : '✗ Bridge Not Running'}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
                  {bridge.connected
                    ? `Adapter: ${bridge.status?.vci?.name || 'OK'} · Firmware: ${bridge.status?.vci?.firmware || '—'} · ${bridge.url}`
                    : `${bridge.url || DEFAULT_BRIDGE_URL} · ${bridge.error || 'unreachable'}`}
                </div>
              </div>
              <button onClick={() => bridge.refresh()} style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 8, color: '#fff', padding: '6px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>&#x21bb; Retry</button>
            </div>
            {[
              { n: '1', t: 'Plug in your TOPDON R-Link adapter', s: 'Connect via USB. Wait for the LED to turn solid green or blue.' },
              { n: '2', t: 'Download the bridge launcher below', s: 'Click the orange button — it downloads run_bridge_standalone.bat to your PC.' },
              { n: '3', t: 'Double-click run_bridge_standalone.bat', s: 'Auto-detects your R-Link DLL and starts the Python bridge on port 8765.' },
              { n: '4', t: 'Keep the window open', s: 'The bridge must stay running while using SRT Lab. This dot turns green automatically.' },
            ].map(step => (
              <div key={step.n} style={{ display: 'flex', gap: 12, marginBottom: 11, alignItems: 'flex-start' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#D32F2F', display: 'grid', placeItems: 'center', fontFamily: "'Righteous',sans-serif", fontSize: 13, color: '#fff', flexShrink: 0, marginTop: 1 }}>{step.n}</div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 13, color: '#fff' }}>{step.t}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{step.s}</div>
                </div>
              </div>
            ))}
            <a
              href="/tools/run_bridge_standalone.bat"
              download="run_bridge_standalone.bat"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
                background: 'linear-gradient(135deg,#D32F2F 0%,#FF6D00 100%)',
                color: '#fff', borderRadius: 12, padding: '15px 28px',
                fontFamily: "'Righteous',sans-serif", fontSize: 16, letterSpacing: 1.2,
                textDecoration: 'none', boxShadow: '0 6px 24px rgba(211,47,47,0.45)',
                marginBottom: 12, marginTop: 16,
              }}
            >
              <PlugZap size={20} /> DOWNLOAD BRIDGE LAUNCHER (.BAT)
            </a>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* ── Left rail — 6 job doors ── */}
        <nav
          data-testid="command-rail"
          style={{
            width: 220, flexShrink: 0, background: T.panel, borderRight: `1px solid ${T.line}`,
            padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto',
          }}
        >
          {/* HOME — Diagnose landing */}
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', color: T.muted, padding: '2px 10px 6px' }}>
            HOME
          </div>
          <button
            type="button"
            data-testid="rail-dumps"
            onClick={() => onSelect(HOME.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
              padding: '9px 10px', borderRadius: 10, cursor: 'pointer', border: 'none',
              background: activeTab === HOME.key ? T.red : 'transparent',
              color: activeTab === HOME.key ? '#fff' : T.ink,
              boxShadow: activeTab === HOME.key ? '0 4px 12px -4px rgba(211,47,47,.5)' : 'none',
              fontFamily: "'Nunito',sans-serif",
              transition: 'background 120ms ease-out',
            }}
            onMouseEnter={(e) => { if (activeTab !== HOME.key) e.currentTarget.style.background = '#F4F1EC'; }}
            onMouseLeave={(e) => { if (activeTab !== HOME.key) e.currentTarget.style.background = 'transparent'; }}
          >
            <span style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, background: activeTab === HOME.key ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.05)' }}>
              📂
            </span>
            <span style={{ lineHeight: 1.2, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 800, fontSize: 12.5 }}>DIAGNOSE</span>
              <span style={{ display: 'block', fontSize: 10.5, opacity: activeTab === HOME.key ? 0.85 : 0.55 }}>Drop → verdict → fix</span>
            </span>
          </button>

          {/* Divider */}
          <div style={{ borderTop: `1px solid ${T.line}`, margin: '8px 0 4px' }} />
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', color: T.muted, padding: '2px 10px 6px' }}>
            JOB DOORS
          </div>

          {/* 6 job door buttons */}
          {JOBS.map((job) => {
            const style = JOB_STYLE[job.id] || JOB_STYLE.ref;
            const Icon = style.icon;
            const isActive = activeJobId === job.id;
            const memberCount = jobTabs[job.id]?.length || 0;

            return (
              <button
                key={job.id}
                type="button"
                data-testid={`rail-job-${job.id}`}
                onClick={() => {
                  // Navigate to the primary tab for this job
                  const primary = job.primary;
                  if (tabById[primary]) {
                    onSelect(primary);
                  } else if (jobTabs[job.id]?.length > 0) {
                    onSelect(jobTabs[job.id][0].id);
                  }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                  padding: '9px 10px', borderRadius: 10, cursor: 'pointer',
                  border: isActive ? `1px solid ${style.accent}` : '1px solid transparent',
                  background: isActive ? style.bg : 'transparent',
                  color: isActive ? T.ink : T.ink,
                  fontFamily: "'Nunito',sans-serif",
                  transition: 'background 120ms ease-out, border-color 120ms ease-out',
                  borderLeft: isActive ? `3px solid ${style.accent}` : '3px solid transparent',
                }}
                onMouseEnter={(e) => { if (!isActive) { e.currentTarget.style.background = '#F4F1EC'; } }}
                onMouseLeave={(e) => { if (!isActive) { e.currentTarget.style.background = 'transparent'; } }}
              >
                <span style={{
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: isActive ? style.accent : style.bg,
                }}>
                  <Icon size={15} style={{ color: isActive ? '#fff' : style.accent }} />
                </span>
                <span style={{ lineHeight: 1.2, minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 800, fontSize: 12.5, color: isActive ? style.accent : T.ink }}>{job.label}</span>
                  <span style={{ display: 'block', fontSize: 10.5, opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.sub}</span>
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: isActive ? style.accent : T.muted,
                  background: isActive ? style.bg : 'rgba(0,0,0,0.06)',
                  borderRadius: 10, padding: '1px 6px', flexShrink: 0,
                }}>
                  {memberCount}
                </span>
              </button>
            );
          })}

          <div style={{ flex: 1 }} />

          {/* Footer — quick access to CAN Universe */}
          <div style={{ borderTop: `1px solid ${T.line}`, paddingTop: 10 }}>
            <button
              type="button"
              data-testid="rail-footer-canuniverse"
              onClick={() => onSelect('canuniverse')}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                padding: '8px 10px', borderRadius: 9, cursor: 'pointer', border: 'none',
                background: activeTab === 'canuniverse' ? T.red : 'transparent',
                color: activeTab === 'canuniverse' ? '#fff' : T.muted,
                fontSize: 12, fontWeight: 700, fontFamily: "'Nunito',sans-serif",
              }}
              onMouseEnter={(e) => { if (activeTab !== 'canuniverse') e.currentTarget.style.background = '#F4F1EC'; }}
              onMouseLeave={(e) => { if (activeTab !== 'canuniverse') e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontSize: 15, lineHeight: 1 }}>🌐</span> CAN Universe · Intel
            </button>
          </div>
        </nav>

        {/* ── Content slot ── */}
        <main data-testid="command-content" style={{ flex: 1, minWidth: 0, overflow: 'auto', background: T.base }}>
          <div style={{ maxWidth: 1200, margin: '0 auto', padding: '22px 22px 60px' }}>
            {children}
          </div>
        </main>
      </div>

      {/* ── All Tools Drawer ── */}
      <AdvancedDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        tabs={tabs}
        activeTab={activeTab}
        onSelect={onSelect}
      />
    </div>
  );
}
