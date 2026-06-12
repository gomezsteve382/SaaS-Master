import React, { useState } from 'react';

/* ─────────────────────────────────────────────────────────────────────────
 * Section — reusable collapsible content block for dense tab bodies.
 *
 * The back-end tabs tend to render a long single scroll of cards. Wrapping
 * secondary / reference regions in <Section> turns them into a one-line
 * header you expand on demand, so the primary action stays above the fold.
 *
 * Defaults to OPEN so existing content (and any testid/text queries against
 * it) still render — adoption is non-breaking. Pass defaultOpen={false} for
 * reference/detail blocks that should start collapsed. The `title` stays
 * visible while collapsed, so a safety headline never hides behind a fold.
 * ──────────────────────────────────────────────────────────────────────── */
export default function Section({
  title,
  subtitle,
  badge,
  accent = '#D32F2F',
  defaultOpen = true,
  children,
  testid,
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      data-testid={testid}
      style={{
        marginBottom: 12, border: '1px solid #E2DDD3', borderRadius: 12,
        background: '#FFFFFF', overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid={testid ? `${testid}-toggle` : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          textAlign: 'left', cursor: 'pointer', border: 'none',
          background: 'transparent', padding: '12px 14px',
          borderLeft: `3px solid ${accent}`, fontFamily: "'Nunito', sans-serif",
        }}
      >
        <span style={{
          transition: 'transform .15s ease', transform: open ? 'rotate(90deg)' : 'none',
          color: accent, fontSize: 12, fontWeight: 900, flexShrink: 0,
        }}>▶</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 900, fontSize: 13, letterSpacing: 0.4, color: '#1A1A1A' }}>{title}</span>
          {subtitle && <span style={{ display: 'block', fontSize: 11, color: '#6B6B6B', marginTop: 2 }}>{subtitle}</span>}
        </span>
        {badge != null && (
          <span style={{
            fontSize: 11, fontWeight: 800, color: '#6B6B6B', background: '#F4F1EC',
            border: '1px solid #E2DDD3', borderRadius: 20, padding: '1px 8px', flexShrink: 0,
          }}>{badge}</span>
        )}
      </button>
      {open && <div style={{ padding: '4px 14px 14px' }}>{children}</div>}
    </div>
  );
}
