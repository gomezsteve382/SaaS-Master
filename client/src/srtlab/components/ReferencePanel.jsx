import React, {useEffect} from 'react';

const PALETTE = {
  bg: '#F4F1EC',
  ts: '#5A5A5A',
  tx: '#1A1A1A',
  bd: '#E8E4DE',
  c2: '#FAF9F7',
};

export function ReferencePanelTrigger({onOpen}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="reference-panel-trigger"
      title="Vehicle reference (generations, BCM families, pairing chain)"
      aria-label="Open vehicle reference panel"
      style={{
        position: 'fixed',
        right: 22,
        bottom: 22,
        zIndex: 8000,
        width: 46,
        height: 46,
        borderRadius: '50%',
        border: 'none',
        cursor: 'pointer',
        background: '#1A1A1A',
        color: '#F4F1EC',
        fontFamily: "'Righteous',sans-serif",
        fontSize: 20,
        boxShadow: '0 6px 22px rgba(0,0,0,0.35)',
      }}
    >
      ?
    </button>
  );
}

export default function ReferencePanel({open, onClose, vehicle, children}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid="reference-panel-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        data-testid="reference-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 100%)',
          height: '100%',
          background: PALETTE.bg,
          color: PALETTE.tx,
          boxShadow: '-8px 0 30px rgba(0,0,0,0.25)',
          overflowY: 'auto',
          padding: 22,
          fontFamily: "'Nunito',sans-serif",
          animation: 'srtlabRefSlide 0.18s ease-out',
        }}
      >
        <style>{`@keyframes srtlabRefSlide{from{transform:translateX(20px);opacity:0}to{transform:translateX(0);opacity:1}}`}</style>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14}}>
          <div>
            <div style={{fontFamily: "'Righteous',sans-serif", letterSpacing: 2, fontSize: 16}}>REFERENCE</div>
            {vehicle && (
              <div style={{fontSize: 11, color: PALETTE.ts, marginTop: 2}}>{vehicle.name}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="reference-panel-close"
            aria-label="Close reference panel"
            style={{
              background: 'transparent',
              border: `1px solid ${PALETTE.bd}`,
              borderRadius: 8,
              padding: '4px 10px',
              cursor: 'pointer',
              fontFamily: "'Nunito',sans-serif",
              fontSize: 11,
              fontWeight: 800,
              color: PALETTE.tx,
            }}
          >
            ✕
          </button>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );
}
