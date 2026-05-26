import React, {useEffect, useState} from 'react';

const SIDEBAR_BG = '#1A1A1A';
const SIDEBAR_BG_DEEP = '#0F0F0F';
const TEXT = '#F4F1EC';
const TEXT_DIM = 'rgba(244,241,236,0.55)';
const TEXT_FAINT = 'rgba(244,241,236,0.35)';
const ACCENT = '#D32F2F';
const DIVIDER = 'rgba(255,255,255,0.08)';

const CATEGORY_META = {
  PROGRAM:  {label: 'PROGRAM',  blurb: 'Write to module'},
  LIVE:     {label: 'LIVE',     blurb: 'Connected ECU'},
  ANALYZE:  {label: 'ANALYZE',  blurb: 'Dumps & reports'},
  TOOLS:    {label: 'TOOLS',    blurb: 'Cross-cutting utilities'},
  RESEARCH: {label: 'RESEARCH', blurb: 'Experimental / catalogs'},
};

const SECTION_ORDER = ['PROGRAM', 'LIVE', 'ANALYZE', 'TOOLS', 'RESEARCH'];

function useIsNarrow(breakpoint = 900) {
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < breakpoint;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const h = (e) => setNarrow(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', h);
    else if (mq.addListener) mq.addListener(h);
    setNarrow(mq.matches);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', h);
      else if (mq.removeListener) mq.removeListener(h);
    };
  }, [breakpoint]);
  return narrow;
}

function matchesQuery(tab, q) {
  if (!q) return true;
  const hay = `${tab.l || ''} ${tab.s || ''} ${tab.id || ''}`.toLowerCase();
  return hay.includes(q);
}

export default function WorkspaceSidebar({tabs, categories, activeTab, onSelect, accent = ACCENT}) {
  const narrow = useIsNarrow(900);
  // Group tabs by category in their original registry order.
  const grouped = {};
  for (const key of SECTION_ORDER) grouped[key] = [];
  for (const t of tabs) {
    const cat = categories[t.id];
    if (!cat || !grouped[cat]) continue;
    grouped[cat].push(t);
  }

  // RESEARCH starts collapsed by default; others open.
  const [openSections, setOpenSections] = useState(() => {
    const o = {};
    for (const k of SECTION_ORDER) o[k] = k !== 'RESEARCH';
    return o;
  });

  // If the active tab lives in a collapsed section, auto-open it so the
  // highlight is visible (e.g. deep-link to a RESEARCH tab).
  useEffect(() => {
    const cat = categories[activeTab];
    if (cat && !openSections[cat]) {
      setOpenSections(s => ({...s, [cat]: true}));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const toggle = (key) => setOpenSections(s => ({...s, [key]: !s[key]}));

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  // Filtered groups + ordered list of matches for Enter handling.
  // Re-derived every render — the cost is trivial (a few dozen string
  // includes) and avoids stale-closure bugs from memo-dep mismatches.
  const filteredGroups = {};
  let firstMatchId = null;
  for (const key of SECTION_ORDER) {
    const items = grouped[key] || [];
    const matched = searching ? items.filter(t => matchesQuery(t, q)) : items;
    filteredGroups[key] = matched;
    if (!firstMatchId && matched.length > 0 && searching) firstMatchId = matched[0].id;
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      if (firstMatchId) {
        onSelect(firstMatchId);
        e.preventDefault();
      }
    } else if (e.key === 'Escape') {
      setQuery('');
      e.preventDefault();
    }
  };

  const width = narrow ? 64 : 232;

  return (
    <aside
      data-testid="workspace-sidebar"
      style={{
        width,
        flexShrink: 0,
        background: SIDEBAR_BG,
        color: TEXT,
        borderRight: `1px solid ${DIVIDER}`,
        minHeight: 'calc(100vh - 140px)',
        padding: '14px 0 40px',
        fontFamily: "'Nunito',sans-serif",
        position: 'sticky',
        top: 0,
        alignSelf: 'flex-start',
        maxHeight: '100vh',
        overflowY: 'auto',
      }}
    >
      {!narrow && (
        <div style={{padding: '0 12px 10px'}}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search tabs…"
            data-testid="sidebar-search"
            aria-label="Search tabs"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: SIDEBAR_BG_DEEP,
              border: `1px solid ${DIVIDER}`,
              borderRadius: 4,
              color: TEXT,
              padding: '6px 8px',
              fontSize: 12,
              fontFamily: "'Nunito',sans-serif",
              outline: 'none',
            }}
          />
          {searching && !firstMatchId && (
            <div style={{color: TEXT_FAINT, fontSize: 10, marginTop: 6, padding: '0 2px'}}>
              No tabs match "{query}"
            </div>
          )}
        </div>
      )}
      {SECTION_ROUTE_RENDER({
        SECTION_ORDER, grouped, filteredGroups, searching,
        narrow, openSections, toggle, activeTab, onSelect, accent, q,
      })}
    </aside>
  );
}

// Extracted as a plain helper to keep the JSX above tidy.
function SECTION_ROUTE_RENDER({
  SECTION_ORDER, grouped, filteredGroups, searching,
  narrow, openSections, toggle, activeTab, onSelect, accent, q,
}) {
  return SECTION_ORDER.map((key) => {
    const baseItems = grouped[key] || [];
    if (baseItems.length === 0) return null;
    const items = filteredGroups[key] || [];
    // While searching, hide sections that have zero matches.
    if (searching && items.length === 0) return null;
    const meta = CATEGORY_META[key];
    // While searching, force-open any section with matches. Otherwise honor user toggle.
    const open = searching ? true : openSections[key];
    return (
      <div key={key} style={{marginBottom: 10}}>
        {!narrow && (
          <button
            type="button"
            onClick={() => toggle(key)}
            data-testid={`sidebar-section-${key.toLowerCase()}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              background: 'transparent',
              border: 'none',
              color: TEXT_DIM,
              padding: '8px 16px 6px',
              cursor: 'pointer',
              fontFamily: "'Righteous',sans-serif",
              fontSize: 11,
              letterSpacing: 2.5,
            }}
            title={meta.blurb}
          >
            <span>{meta.label}</span>
            <span style={{fontSize: 9, opacity: 0.6}}>{open ? '▾' : '▸'}</span>
          </button>
        )}
        {narrow && (
          <div
            style={{
              textAlign: 'center',
              color: TEXT_FAINT,
              fontFamily: "'Righteous',sans-serif",
              fontSize: 8,
              letterSpacing: 1.5,
              padding: '6px 0 4px',
              borderTop: `1px solid ${DIVIDER}`,
            }}
            title={meta.label}
          >
            {meta.label.slice(0, 3)}
          </div>
        )}
        {(open || narrow) && (
          <div>
            {items.map((t) => {
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onSelect(t.id)}
                  data-testid={`sidebar-tab-${t.id}`}
                  title={narrow ? `${t.l} — ${t.s}` : t.s}
                  style={{
                    display: 'flex',
                    alignItems: narrow ? 'center' : 'flex-start',
                    justifyContent: narrow ? 'center' : 'flex-start',
                    gap: narrow ? 0 : 10,
                    width: '100%',
                    background: active ? SIDEBAR_BG_DEEP : 'transparent',
                    border: 'none',
                    borderLeft: `3px solid ${active ? accent : 'transparent'}`,
                    color: active ? TEXT : TEXT_DIM,
                    padding: narrow ? '10px 0' : '8px 16px 8px 13px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: "'Nunito',sans-serif",
                    fontWeight: active ? 800 : 600,
                    fontSize: 11,
                    letterSpacing: 0.8,
                    transition: 'background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{fontSize: 15, lineHeight: 1, filter: active ? 'none' : 'grayscale(0.4)'}}>{t.i}</span>
                  {!narrow && (
                    <span style={{display: 'flex', flexDirection: 'column', minWidth: 0}}>
                      <span style={{fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                        {t.l}
                      </span>
                      <span style={{fontSize: 9, color: active ? 'rgba(244,241,236,0.65)' : TEXT_FAINT, marginTop: 2, fontWeight: 500, letterSpacing: 0.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                        {t.s}
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  });
}
