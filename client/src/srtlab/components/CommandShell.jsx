import React, {useState, useEffect, useContext, useMemo} from 'react';
import {
  Stethoscope, Terminal, Fingerprint, DownloadCloud, Bot,
  ChevronRight, Wrench, Car, ShieldCheck, Search, X, ListChecks, KeyRound, Lock, Replace, ScanEye, Zap,
} from 'lucide-react';
import {MasterVinContext} from '../lib/masterVinContext.jsx';

/* SRT command-center design tokens (graduated from the approved canvas mockup). */
const T = {
  base: '#F4F1EC',
  panel: '#FFFFFF',
  ink: '#1A1A1A',
  red: '#D32F2F',
  muted: '#6B6B6B',
  line: '#E2DDD3',
  good: '#2E7D32',
};

/* The five per-vehicle workflow panes. Each maps to an existing workspace
 * tab id so the battle-tested tab content components keep rendering. */
export const PRIMARY_NAV = [
  // WORKFLOW HUB — persistent mission control, always first
  {key: 'workflow',    label: 'Mission Control', sub: 'Module census · status overview', emoji: '🛠️'},
  // DIAGNOSE — first stop, drop files and get a verdict
  {key: 'dumps',       label: 'Diagnose',      sub: 'Drop → verdict → fix', emoji: '🔍'},
  // OBD & UDS — live connections and raw command console (promoted to top)
  {key: 'obd',         label: 'OBD Pull',      sub: 'Read bin dumps live',            emoji: '📡'},
  {key: 'uds-console', label: 'UDS Command',   sub: 'Raw ISO 14229 console',          emoji: '🔌'},
  // VIN & SECURITY — patch identifiers and pair modules
  {key: 'vinprog',     label: 'VIN & Checksum', sub: 'Read / write / verify',          emoji: '🪦'},
  {key: 'vinsync',     label: 'VIN → Sync',    sub: 'Checksums then security',        emoji: '🔄'},
  {key: 'secsync',     label: 'Security Sync', sub: 'BCM · RFHUB · PCM side-by-side', emoji: '🔐'},
  // KEYS — programming, transplant, and status
  {key: 'quickclone',  label: 'Quick Clone',   sub: 'VIN + Security + Keys · 3-step wizard', emoji: '⚡'},
  {key: 'keyxfer',     label: 'Transponder Clone', sub: 'Add / transfer key offline · no OBD', emoji: '🔑'},
  {key: 'keytransplant', label: 'Key Transplant', sub: 'Donor → Target RFHUB clone',    emoji: '🔀'},
  {key: 'hitagaes',    label: 'HITAG Key Reader', sub: 'PCF7945 · PCF7939FA · blank / prog / locked', emoji: '📶'},
  {key: 'hitag2',      label: 'HITAG 2 Bench',   sub: 'PCF7945/53 · SK derive · VVDI write helper', emoji: '📶'},
  // AI — guided investigation
  {key: 'investigation', label: 'AI Copilot',  sub: 'Guided investigation',           emoji: '🤖'},
];

const PRIMARY_KEYS = new Set(PRIMARY_NAV.map(n => n.key));

/* Two quick links pinned under the primary rail (still reachable in the
 * drawer too). */
export const FOOTER_NAV = [
  {key: 'canuniverse', label: 'CAN Universe · Intel', emoji: '🔭'},
];

const CATEGORY_META = {
  PROGRAM:  {label: 'PROGRAM',  blurb: 'Write to module',          accent: '#ef4444', bg: 'rgba(239,68,68,0.12)'},
  LIVE:     {label: 'LIVE',     blurb: 'Connected ECU',            accent: '#22c55e', bg: 'rgba(34,197,94,0.12)'},
  ANALYZE:  {label: 'ANALYZE',  blurb: 'Dumps & reports',          accent: '#3b82f6', bg: 'rgba(59,130,246,0.12)'},
  TOOLS:    {label: 'TOOLS',    blurb: 'Cross-cutting utilities',   accent: '#f59e0b', bg: 'rgba(245,158,11,0.12)'},
  RESEARCH: {label: 'RESEARCH', blurb: 'Experimental / catalogs',  accent: '#a855f7', bg: 'rgba(168,85,247,0.12)'},
};
const SECTION_ORDER = ['PROGRAM', 'LIVE', 'ANALYZE', 'TOOLS', 'RESEARCH'];

function matchesQuery(tab, q) {
  if (!q) return true;
  return `${tab.l || ''} ${tab.s || ''} ${tab.id || ''}`.toLowerCase().includes(q);
}

/* ── Advanced / Reference slide-out drawer ── */
function AdvancedDrawer({open, onClose, tabs, categories, activeTab, onSelect}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  // Everything that isn't one of the five primary panes belongs here.
  const advancedTabs = useMemo(
    () => tabs.filter(t => !PRIMARY_KEYS.has(t.id)),
    [tabs],
  );

  const grouped = useMemo(() => {
    const g = {};
    for (const key of SECTION_ORDER) g[key] = [];
    for (const t of advancedTabs) {
      const cat = categories[t.id];
      if (!cat || !g[cat]) continue;
      if (!matchesQuery(t, q)) continue;
      g[cat].push(t);
    }
    return g;
  }, [advancedTabs, categories, q]);

  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Advanced and reference tools"
      style={{position: 'fixed', inset: 0, zIndex: 4000, display: 'flex', justifyContent: 'flex-end'}}
    >
      <div
        onClick={onClose}
        style={{position: 'absolute', inset: 0, background: 'rgba(10,10,10,0.55)', backdropFilter: 'blur(2px)'}}
      />
      <aside
        data-testid="advanced-drawer"
        style={{
          position: 'relative', width: 400, maxWidth: '92vw', height: '100%',
          background: T.base, borderLeft: `1px solid ${T.line}`,
          boxShadow: '-12px 0 40px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column',
          fontFamily: "'Nunito',sans-serif",
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px',
          background: T.ink, color: '#fff', borderBottom: `3px solid ${T.red}`,
        }}>
          <Wrench size={17} style={{color: T.red}} />
          <div style={{flex: 1}}>
            <div style={{fontFamily: "'Righteous',sans-serif", fontSize: 15, letterSpacing: 0.5}}>ADVANCED / REFERENCE</div>
            <div style={{fontSize: 11, opacity: 0.65}}>{advancedTabs.length} tools &amp; catalogs</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close drawer"
            style={{background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', color: '#fff', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'grid', placeItems: 'center'}}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{padding: '12px 16px', borderBottom: `1px solid ${T.line}`}}>
          <div style={{position: 'relative'}}>
            <Search size={14} style={{position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: T.muted}} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={'Search tools\u2026'}
              data-testid="advanced-drawer-search"
              aria-label="Search advanced tools"
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box', background: T.panel,
                border: `1px solid ${T.line}`, borderRadius: 8, color: T.ink,
                padding: '8px 10px 8px 30px', fontSize: 13, fontFamily: "'Nunito',sans-serif", outline: 'none',
              }}
            />
          </div>
        </div>

        <div style={{flex: 1, overflowY: 'auto', padding: '8px 12px 40px'}}>
          {SECTION_ORDER.map((key) => {
            const items = grouped[key] || [];
            if (items.length === 0) return null;
            const meta = CATEGORY_META[key];
            return (
              <div key={key} style={{marginBottom: 18}}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 8px 7px',
                }}>
                  <div style={{width: 3, height: 14, borderRadius: 2, background: meta.accent, flexShrink: 0}} />
                  <span style={{
                    fontFamily: "'Righteous',sans-serif", fontSize: 10, letterSpacing: 2.5,
                    color: meta.accent, textTransform: 'uppercase',
                  }} title={meta.blurb}>{meta.label}</span>
                  <span style={{fontSize: 10, color: T.muted, opacity: 0.7}}>— {meta.blurb}</span>
                </div>
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
                        background: active ? meta.accent : T.panel,
                        color: active ? '#fff' : T.ink,
                        border: `1px solid ${active ? meta.accent : T.line}`,
                        borderLeft: active ? `3px solid ${meta.accent}` : `3px solid ${meta.bg.replace('0.12','0.45')}`,
                        borderRadius: 10, padding: '9px 12px 9px 10px', marginBottom: 5, cursor: 'pointer',
                        textAlign: 'left', fontFamily: "'Nunito',sans-serif",
                        transition: 'background 120ms ease-out, border-color 120ms ease-out',
                      }}
                      onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = meta.bg; e.currentTarget.style.borderLeftColor = meta.accent; } }}
                      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = T.panel; e.currentTarget.style.borderLeftColor = meta.bg.replace('0.12','0.45'); } }}
                    >
                      <span style={{
                        width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, borderRadius: 8,
                        background: active ? 'rgba(255,255,255,0.18)' : meta.bg,
                        fontSize: 18, lineHeight: 1,
                      }}>
                        {t.i}
                      </span>
                      <span style={{display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1}}>
                        <span style={{fontWeight: 800, fontSize: 12.5, letterSpacing: 0.4, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{t.l}</span>
                        <span style={{fontSize: 11, opacity: active ? 0.88 : 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1}}>{t.s}</span>
                      </span>
                      {active && <span style={{fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'rgba(255,255,255,0.75)', flexShrink: 0}}>ACTIVE</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {SECTION_ORDER.every(k => (grouped[k] || []).length === 0) && (
            <div style={{color: T.muted, fontSize: 12, padding: '16px 8px'}}>No tools match "{query}".</div>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ── Command shell: slim top bar + 5-item workflow rail + drawer ── */
export default function CommandShell({
  vehicle, onBack, onOpenWizard, onOpenCopilot, tabs, categories, activeTab, onSelect, children,
}) {
  const {vin} = useContext(MasterVinContext);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const advancedCount = useMemo(
    () => tabs.filter(t => !PRIMARY_KEYS.has(t.id)).length,
    [tabs],
  );

  const primaryActive = PRIMARY_KEYS.has(activeTab);
  const footerKeys = new Set(FOOTER_NAV.map(f => f.key));
  const advancedActive = !primaryActive && !footerKeys.has(activeTab);

  return (
    <div style={{height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.base, color: T.ink, fontFamily: "'Nunito',sans-serif"}}>
      {/* Top bar */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 18, padding: '0 20px', height: 60,
        background: T.ink, color: '#fff', flexShrink: 0, borderBottom: `3px solid ${T.red}`,
      }}>
        <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
          <div style={{width: 30, height: 30, borderRadius: 6, background: T.red, display: 'grid', placeItems: 'center', fontWeight: 900, fontFamily: "'Righteous',sans-serif"}}>S</div>
          <span style={{fontFamily: "'Righteous',sans-serif", fontSize: 19, letterSpacing: '.04em'}}>SRT&nbsp;LAB</span>
        </div>

        {/* Active vehicle chip — click to change vehicle */}
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
          <Car size={16} style={{color: T.red, flexShrink: 0}} />
          <div style={{lineHeight: 1.15}}>
            <div style={{fontWeight: 800, fontSize: 13}}>{vehicle.name}</div>
            <div style={{fontFamily: "'JetBrains Mono',monospace", fontSize: 11, opacity: 0.7}}>
              {vin && vin.length ? vin : 'NO VIN SET'}
            </div>
          </div>
          <ChevronRight size={15} style={{opacity: 0.5, flexShrink: 0}} />
        </button>

        <div style={{flex: 1}} />

        {/* Bench status */}
        <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, letterSpacing: 1}}>
          <span style={{opacity: 0.85, fontWeight: 700}}>BENCH READY</span>
          <span style={{width: 7, height: 7, borderRadius: '50%', background: '#69d36e', boxShadow: '0 0 0 3px rgba(105,211,110,.25)'}} />
        </div>

        {/* Always-available general Claude co-pilot */}
        <button
          type="button"
          data-testid="topbar-copilot-btn"
          onClick={onOpenCopilot}
          title="Open the AI Co-pilot — ask Claude anything"
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
            title="Open the Mismatch Wizard + Claude AI assistant"
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

        {/* Advanced / Reference drawer entry */}
        <button
          type="button"
          data-testid="topbar-advanced-btn"
          onClick={() => setDrawerOpen(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            background: advancedActive ? 'rgba(211,47,47,0.22)' : 'transparent', color: '#fff',
            border: `1px solid ${advancedActive ? T.red : 'rgba(255,255,255,.22)'}`,
            borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
          }}
        >
          <Wrench size={15} /> Advanced / Reference
          <span style={{background: T.red, borderRadius: 20, padding: '1px 7px', fontSize: 10.5, fontWeight: 800}}>{advancedCount}</span>
        </button>
      </header>

      <div style={{display: 'flex', flex: 1, minHeight: 0}}>
        {/* Left rail */}
        <nav
          data-testid="command-rail"
          style={{
            width: 232, flexShrink: 0, background: T.panel, borderRight: `1px solid ${T.line}`,
            padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto',
          }}
        >
          <div style={{fontSize: 10.5, fontWeight: 800, letterSpacing: '.12em', color: T.muted, padding: '4px 10px 8px'}}>
            PER-VEHICLE WORKFLOW
          </div>

          {PRIMARY_NAV.map((item) => {
            const isActive = item.key === activeTab;
            return (
              <button
                key={item.key}
                type="button"
                data-testid={`rail-${item.key}`}
                onClick={() => onSelect(item.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
                  padding: '10px 11px', borderRadius: 10, cursor: 'pointer', border: 'none',
                  background: isActive ? T.red : 'transparent',
                  color: isActive ? '#fff' : T.ink,
                  boxShadow: isActive ? '0 6px 16px -6px rgba(211,47,47,.6)' : 'none',
                  fontFamily: "'Nunito',sans-serif",
                  transition: 'background 120ms ease-out',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = '#F4F1EC'; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{
                  width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 19, lineHeight: 1,
                  background: isActive ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.05)',
                }}>
                  {item.emoji}
                </span>
                <span style={{lineHeight: 1.2, minWidth: 0}}>
                  <span style={{display: 'block', fontWeight: 800, fontSize: 13.5}}>{item.label}</span>
                  <span style={{display: 'block', fontSize: 11, opacity: isActive ? 0.85 : 0.55}}>{item.sub}</span>
                </span>
              </button>
            );
          })}

          <div style={{flex: 1}} />

          <div style={{borderTop: `1px solid ${T.line}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 4}}>
            {FOOTER_NAV.map((x) => {
              const isActive = x.key === activeTab;
              return (
                <button
                  key={x.key}
                  type="button"
                  data-testid={`rail-footer-${x.key}`}
                  onClick={() => onSelect(x.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                    padding: '9px 11px', borderRadius: 9, cursor: 'pointer', border: 'none',
                    background: isActive ? T.red : 'transparent',
                    color: isActive ? '#fff' : T.muted,
                    fontSize: 12.5, fontWeight: 700, fontFamily: "'Nunito',sans-serif",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = '#F4F1EC'; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{fontSize: 16, lineHeight: 1}}>{x.emoji}</span> {x.label}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Content slot */}
        <main data-testid="command-content" style={{flex: 1, minWidth: 0, overflow: 'auto', background: T.base}}>
          <div style={{maxWidth: 1200, margin: '0 auto', padding: '22px 22px 60px'}}>
            {children}
          </div>
        </main>
      </div>

      <AdvancedDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        tabs={tabs}
        categories={categories}
        activeTab={activeTab}
        onSelect={onSelect}
      />
    </div>
  );
}
