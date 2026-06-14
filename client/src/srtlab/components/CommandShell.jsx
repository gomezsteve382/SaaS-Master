import React, {useState, useContext, useMemo} from 'react';
import {
  Wrench, Car, Search, X, ChevronLeft,
  Plug, PlugZap, Zap, Shield, Copy, Key, Cpu, Activity,
  LayoutDashboard, Grid3X3, FileDigit, Lock,
} from 'lucide-react';
import {MasterVinContext} from '../lib/masterVinContext.jsx';
import {useBridgeStatus, DEFAULT_BRIDGE_URL} from '../lib/bridgeClient.js';

/* ── Design tokens — dark Pixar palette ── */
const T = {
  bg:        '#141414',
  sidebar:   '#1a1a1a',
  card:      '#1f1f1f',
  border:    '#2a2a2a',
  borderHov: '#3a3a3a',
  ink:       '#f0f0f0',
  muted:     '#6b6b6b',
  dim:       '#3a3a3a',
  accent:    '#e53935',
  accentSoft:'rgba(229,57,53,0.12)',
  accentGlow:'rgba(229,57,53,0.25)',
  green:     '#43a047',
  greenSoft: 'rgba(67,160,71,0.15)',
};

/* ── 6 core workflow items shown in the sidebar ── */
export const PRIMARY_NAV = [
  {key: 'workflow',   label: 'Mission Control', icon: LayoutDashboard},
  {key: 'vinprog',    label: 'VIN + Checksum',  icon: FileDigit},
  {key: 'secsync',    label: 'Security Sync',   icon: Lock},
  {key: 'dumps',      label: 'Diagnose',        icon: Activity},
  {key: 'obd',        label: 'Live OBD',        icon: Zap},
  {key: 'quickclone', label: 'Quick Clone',     icon: Copy},
];

const PRIMARY_KEYS = new Set(PRIMARY_NAV.map(n => n.key));

const CATEGORY_META = {
  PROGRAM:  {label: 'Program',  color: '#ef4444'},
  LIVE:     {label: 'Live',     color: '#22c55e'},
  ANALYZE:  {label: 'Analyze',  color: '#3b82f6'},
  TOOLS:    {label: 'Tools',    color: '#f59e0b'},
  RESEARCH: {label: 'Research', color: '#a855f7'},
};
const SECTION_ORDER = ['PROGRAM', 'LIVE', 'ANALYZE', 'TOOLS', 'RESEARCH'];

function matchesQuery(tab, q) {
  if (!q) return true;
  return `${tab.l || ''} ${tab.s || ''} ${tab.id || ''}`.toLowerCase().includes(q);
}

/* ── Advanced drawer ── */
function AdvancedDrawer({open, onClose, tabs, categories, activeTab, onSelect}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const advancedTabs = useMemo(() => tabs.filter(t => !PRIMARY_KEYS.has(t.id)), [tabs]);

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

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Advanced tools"
      style={{position:'fixed',inset:0,zIndex:4000,display:'flex',justifyContent:'flex-end'}}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div onClick={onClose} style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.6)'}} />
      <aside style={{
        position:'relative', width:320, maxWidth:'90vw', height:'100%',
        background:T.sidebar, borderLeft:`1px solid ${T.border}`,
        boxShadow:'-16px 0 48px rgba(0,0,0,0.5)',
        display:'flex', flexDirection:'column',
        fontFamily:"'Inter',system-ui,sans-serif",
      }}>
        {/* Header */}
        <div style={{display:'flex',alignItems:'center',gap:10,padding:'16px 16px 12px',borderBottom:`1px solid ${T.border}`}}>
          <Grid3X3 size={14} style={{color:T.accent,flexShrink:0}}/>
          <span style={{flex:1,fontSize:13,fontWeight:700,color:T.ink}}>All Tools</span>
          <span style={{fontSize:11,color:T.muted,marginRight:6}}>{advancedTabs.length}</span>
          <button onClick={onClose} aria-label="Close" style={{background:'transparent',border:`1px solid ${T.border}`,color:T.muted,borderRadius:6,width:28,height:28,cursor:'pointer',display:'grid',placeItems:'center'}}>
            <X size={13}/>
          </button>
        </div>

        {/* Search */}
        <div style={{padding:'10px 12px',borderBottom:`1px solid ${T.border}`}}>
          <div style={{position:'relative'}}>
            <Search size={12} style={{position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',color:T.muted,pointerEvents:'none'}}/>
            <input
              autoFocus
              type="text"
              value={query}
              onChange={e=>setQuery(e.target.value)}
              placeholder="Search tools…"
              style={{
                width:'100%',boxSizing:'border-box',
                background:T.card,border:`1px solid ${T.border}`,borderRadius:8,
                color:T.ink,padding:'8px 10px 8px 30px',fontSize:12,
                fontFamily:'inherit',outline:'none',
              }}
            />
          </div>
        </div>

        {/* List */}
        <div style={{flex:1,overflowY:'auto',padding:'8px 8px 32px'}}>
          {SECTION_ORDER.map(key => {
            const items = grouped[key] || [];
            if (!items.length) return null;
            const meta = CATEGORY_META[key];
            return (
              <div key={key} style={{marginBottom:20}}>
                <div style={{display:'flex',alignItems:'center',gap:6,padding:'6px 8px 4px'}}>
                  <div style={{width:3,height:10,borderRadius:2,background:meta.color,flexShrink:0}}/>
                  <span style={{fontSize:10,fontWeight:700,letterSpacing:'0.1em',color:meta.color,textTransform:'uppercase'}}>{meta.label}</span>
                </div>
                {items.map(t => {
                  const active = activeTab === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={()=>{onSelect(t.id);onClose();}}
                      style={{
                        display:'flex',alignItems:'center',gap:10,width:'100%',
                        background:active ? T.accentSoft : 'transparent',
                        color:active ? T.ink : '#bbb',
                        border:'none',
                        borderLeft:`2px solid ${active ? T.accent : 'transparent'}`,
                        borderRadius:6,padding:'8px 10px 8px 8px',marginBottom:1,
                        cursor:'pointer',textAlign:'left',fontFamily:'inherit',
                      }}
                      onMouseEnter={e=>{if(!active)e.currentTarget.style.background='rgba(255,255,255,0.04)';}}
                      onMouseLeave={e=>{if(!active)e.currentTarget.style.background='transparent';}}
                    >
                      <span style={{fontSize:15,lineHeight:1,flexShrink:0,width:20,textAlign:'center'}}>{t.i}</span>
                      <span style={{display:'flex',flexDirection:'column',minWidth:0,flex:1}}>
                        <span style={{fontWeight:600,fontSize:12,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{t.l}</span>
                        <span style={{fontSize:10.5,color:T.muted,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',marginTop:1}}>{t.s}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {SECTION_ORDER.every(k=>(grouped[k]||[]).length===0) && (
            <p style={{color:T.muted,fontSize:12,padding:'16px 8px',margin:0}}>No results for "{query}"</p>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ── CommandShell ── */
export default function CommandShell({
  vehicle, onBack, onOpenWizard, onOpenCopilot, tabs, categories, activeTab, onSelect, children,
}) {
  const {vin} = useContext(MasterVinContext);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [bridgeHelpOpen, setBridgeHelpOpen] = useState(false);
  const bridge = useBridgeStatus(5000);

  return (
    <div style={{
      display:'flex', flexDirection:'column', height:'100vh',
      background:T.bg, color:T.ink,
      fontFamily:"'Inter',system-ui,sans-serif",
    }}>

      {/* ── Top bar ── */}
      <header style={{
        display:'flex', alignItems:'center', gap:10,
        padding:'0 20px', height:52, flexShrink:0,
        background:T.sidebar, borderBottom:`1px solid ${T.border}`,
      }}>
        {/* Logo mark */}
        <div style={{display:'flex',alignItems:'center',gap:9,marginRight:6}}>
          <div style={{
            width:30,height:30,borderRadius:8,
            background:'linear-gradient(135deg,#e53935,#b71c1c)',
            display:'grid',placeItems:'center',
            fontSize:14,fontWeight:900,color:'#fff',
            boxShadow:'0 2px 8px rgba(229,57,53,0.4)',
          }}>S</div>
          <span style={{fontSize:14,fontWeight:700,letterSpacing:'0.05em',color:T.ink}}>SRT LAB</span>
        </div>

        <div style={{width:1,height:22,background:T.border,flexShrink:0}}/>

        {/* Vehicle chip */}
        <button
          type="button"
          onClick={onBack}
          title="Change vehicle"
          style={{
            display:'flex',alignItems:'center',gap:8,cursor:'pointer',
            background:'transparent',border:`1px solid ${T.border}`,
            borderRadius:8,padding:'6px 12px',color:T.ink,
            transition:'border-color 150ms',
          }}
          onMouseEnter={e=>e.currentTarget.style.borderColor=T.borderHov}
          onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}
        >
          <Car size={13} style={{color:T.accent,flexShrink:0}}/>
          <span style={{fontSize:13,fontWeight:600}}>{vehicle.name}</span>
          {vin && vin.length > 0 && (
            <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:T.muted}}>
              {vin}
            </span>
          )}
          <ChevronLeft size={12} style={{opacity:0.35,flexShrink:0}}/>
        </button>

        <div style={{flex:1}}/>

        {/* Bridge status — minimal dot + label */}
        <button
          type="button"
          onClick={()=>setBridgeHelpOpen(true)}
          title={bridge.connected ? 'J2534 Bridge connected' : 'J2534 Bridge not connected'}
          style={{
            display:'flex',alignItems:'center',gap:6,
            background:'transparent',border:'none',
            padding:'6px 10px',color:bridge.connected ? T.green : T.muted,
            cursor:'pointer',fontSize:12,fontWeight:600,borderRadius:8,
            transition:'background 150ms',
          }}
          onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.05)'}
          onMouseLeave={e=>e.currentTarget.style.background='transparent'}
        >
          <span style={{
            width:7,height:7,borderRadius:'50%',flexShrink:0,
            background:bridge.loading ? '#f59e0b' : bridge.connected ? T.green : T.dim,
            boxShadow:bridge.connected ? `0 0 6px ${T.green}` : 'none',
          }}/>
          <span>{bridge.connected ? 'Bridge' : 'No Bridge'}</span>
        </button>

        {/* All Tools */}
        <button
          type="button"
          onClick={()=>setDrawerOpen(true)}
          style={{
            display:'flex',alignItems:'center',gap:7,
            background:'transparent',border:`1px solid ${T.border}`,
            borderRadius:8,padding:'6px 14px',color:T.muted,
            cursor:'pointer',fontSize:12,fontWeight:600,
            transition:'border-color 150ms,color 150ms',
          }}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=T.borderHov;e.currentTarget.style.color=T.ink;}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.color=T.muted;}}
        >
          <Grid3X3 size={13}/>
          All Tools
        </button>

        {/* AI */}
        <button
          type="button"
          onClick={onOpenCopilot}
          style={{
            display:'flex',alignItems:'center',gap:7,
            background:'linear-gradient(135deg,#e53935,#b71c1c)',
            border:'none',borderRadius:8,padding:'6px 16px',
            color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700,
            boxShadow:'0 2px 8px rgba(229,57,53,0.3)',
            transition:'opacity 150ms',
          }}
          onMouseEnter={e=>e.currentTarget.style.opacity='0.85'}
          onMouseLeave={e=>e.currentTarget.style.opacity='1'}
        >
          AI Copilot
        </button>
      </header>

      <div style={{display:'flex',flex:1,minHeight:0}}>

        {/* ── Sidebar — 6 items only ── */}
        <nav style={{
          width:192,flexShrink:0,
          background:T.sidebar,borderRight:`1px solid ${T.border}`,
          padding:'16px 10px 16px',
          display:'flex',flexDirection:'column',gap:3,
          overflowY:'auto',
        }}>
          <div style={{
            fontSize:9.5,fontWeight:700,letterSpacing:'0.14em',
            color:T.muted,padding:'2px 8px 10px',textTransform:'uppercase',
          }}>Workflow</div>

          {PRIMARY_NAV.map(item => {
            const isActive = item.key === activeTab;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                onClick={()=>onSelect(item.key)}
                style={{
                  display:'flex',alignItems:'center',gap:10,
                  width:'100%',textAlign:'left',
                  padding:'9px 10px',borderRadius:8,cursor:'pointer',
                  border:'none',
                  background:isActive ? T.accentSoft : 'transparent',
                  color:isActive ? T.ink : T.muted,
                  fontFamily:'inherit',fontSize:13,fontWeight:isActive ? 600 : 400,
                  transition:'background 120ms,color 120ms',
                  position:'relative',
                }}
                onMouseEnter={e=>{if(!isActive){e.currentTarget.style.background='rgba(255,255,255,0.05)';e.currentTarget.style.color=T.ink;}}}
                onMouseLeave={e=>{if(!isActive){e.currentTarget.style.background='transparent';e.currentTarget.style.color=T.muted;}}}
              >
                {isActive && (
                  <div style={{
                    position:'absolute',left:0,top:'20%',bottom:'20%',
                    width:3,borderRadius:'0 2px 2px 0',background:T.accent,
                  }}/>
                )}
                <Icon size={15} style={{flexShrink:0,opacity:isActive?1:0.6}}/>
                {item.label}
              </button>
            );
          })}

          <div style={{flex:1}}/>

          {/* All Tools shortcut at bottom */}
          <button
            type="button"
            onClick={()=>setDrawerOpen(true)}
            style={{
              display:'flex',alignItems:'center',gap:10,
              width:'100%',textAlign:'left',
              padding:'9px 10px',borderRadius:8,cursor:'pointer',
              border:`1px dashed ${T.border}`,
              background:'transparent',color:T.muted,
              fontFamily:'inherit',fontSize:12,fontWeight:400,
              transition:'border-color 120ms,color 120ms',
              marginTop:4,
            }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=T.borderHov;e.currentTarget.style.color=T.ink;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.color=T.muted;}}
          >
            <Grid3X3 size={14} style={{flexShrink:0,opacity:0.5}}/>
            All Tools
          </button>
        </nav>

        {/* ── Content ── */}
        <main style={{
          flex:1,minWidth:0,overflowY:'auto',
          background:T.bg,
        }}>
          <div style={{maxWidth:1100,margin:'0 auto',padding:'28px 28px 80px'}}>
            {children}
          </div>
        </main>
      </div>

      {/* Bridge modal */}
      {bridgeHelpOpen && (
        <div
          onClick={()=>setBridgeHelpOpen(false)}
          style={{position:'fixed',inset:0,zIndex:5000,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center'}}
        >
          <div
            onClick={e=>e.stopPropagation()}
            style={{
              background:T.sidebar,border:`1px solid ${T.border}`,
              borderRadius:14,padding:28,maxWidth:460,width:'90vw',color:T.ink,
            }}
          >
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
              <span style={{fontSize:15,fontWeight:700}}>J2534 Bridge</span>
              <button onClick={()=>setBridgeHelpOpen(false)} style={{background:'none',border:'none',color:T.muted,cursor:'pointer',fontSize:20,lineHeight:1}}>×</button>
            </div>
            <p style={{fontSize:12,color:T.muted,lineHeight:1.7,margin:'0 0 20px'}}>
              The J2534 Bridge connects this browser to a local Windows J2534 adapter for live OBD/UDS sessions.
              Status: <strong style={{color:bridge.connected ? T.green : '#ef4444'}}>{bridge.connected ? 'CONNECTED' : 'DISCONNECTED'}</strong>
            </p>
            <a
              href="/api/bridge/launcher"
              download="srtlab-bridge.bat"
              style={{
                display:'inline-flex',alignItems:'center',gap:8,
                background:'linear-gradient(135deg,#e53935,#b71c1c)',
                color:'#fff',borderRadius:9,padding:'10px 20px',
                fontSize:12,fontWeight:700,textDecoration:'none',
              }}
            >
              <PlugZap size={14}/> Download Bridge Launcher
            </a>
          </div>
        </div>
      )}

      <AdvancedDrawer
        open={drawerOpen}
        onClose={()=>setDrawerOpen(false)}
        tabs={tabs}
        categories={categories}
        activeTab={activeTab}
        onSelect={onSelect}
      />
    </div>
  );
}
