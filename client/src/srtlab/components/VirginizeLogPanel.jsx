/**
 * VirginizeLogPanel.jsx — Shared session log for virginize operations
 * Used by both Hitag2Tab and HitagAesTab.
 */

import React, { useState, useCallback } from 'react';
import { loadVirginizeLog, clearVirginizeLog, deleteVirginizeLogEntry } from '../lib/virginizeLog.js';

const RESULT_COLORS = {
  pass:   { bg: '#0a2a0a', border: '#22c55e', text: '#22c55e', label: '✅ VIRGIN' },
  fail:   { bg: '#2a0a0a', border: '#ef4444', text: '#ef4444', label: '❌ NOT VIRGIN' },
  manual: { bg: '#1a1a0a', border: '#F59E0B', text: '#F59E0B', label: '📝 MANUAL' },
};

const KEY_COLOR_LABELS = {
  red:    { emoji: '🔴', label: 'Red' },
  black:  { emoji: '⚫', label: 'Black' },
  unknown:{ emoji: '⬜', label: 'Unknown' },
};

function formatTs(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function VirginizeLogPanel({ refreshKey }) {
  const [show, setShow] = useState(false);
  const [entries, setEntries] = useState(() => loadVirginizeLog());

  // Refresh entries when refreshKey changes (parent signals a new entry was added)
  React.useEffect(() => {
    setEntries(loadVirginizeLog());
  }, [refreshKey]);

  const handleDelete = useCallback((id) => {
    deleteVirginizeLogEntry(id);
    setEntries(loadVirginizeLog());
  }, []);

  const handleClear = useCallback(() => {
    if (window.confirm('Clear all virginize log entries?')) {
      clearVirginizeLog();
      setEntries([]);
    }
  }, []);

  const passCount = entries.filter(e => e.result === 'pass').length;
  const failCount = entries.filter(e => e.result === 'fail').length;

  return (
    <div style={{ marginTop: 12, background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header toggle */}
      <div
        onClick={() => setShow(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', userSelect: 'none' }}
      >
        <div style={{ flex: 1, fontWeight: 700, color: '#A78BFA', fontSize: 12, letterSpacing: 1 }}>
          📋 VIRGINIZE SESSION LOG ({entries.length})
        </div>
        {entries.length > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ fontSize: 10, color: '#22c55e', background: '#0a2a0a', border: '1px solid #22c55e33', borderRadius: 10, padding: '1px 7px' }}>
              {passCount} PASS
            </span>
            <span style={{ fontSize: 10, color: '#ef4444', background: '#2a0a0a', border: '1px solid #ef444433', borderRadius: 10, padding: '1px 7px' }}>
              {failCount} FAIL
            </span>
          </div>
        )}
        <div style={{ fontSize: 12, color: '#555' }}>{show ? '▲' : '▼'}</div>
      </div>

      {show && (
        <div style={{ padding: '0 14px 14px' }}>
          {entries.length === 0 ? (
            <div style={{ fontSize: 11, color: '#555', padding: '8px 0' }}>
              No entries yet. Log a result using the "Log Result" button after verifying a key.
            </div>
          ) : (
            <>
              {/* Table header */}
              <div style={{ display: 'grid', gridTemplateColumns: '110px 90px 70px 80px 1fr 28px', gap: 6, fontSize: 10, fontWeight: 800, color: '#555', letterSpacing: 1, padding: '4px 0', borderBottom: '1px solid #2a2a2a', marginBottom: 4 }}>
                <div>TIMESTAMP</div>
                <div>CHIP ID</div>
                <div>FAMILY</div>
                <div>COLOR</div>
                <div>RESULT</div>
                <div></div>
              </div>
              {[...entries].reverse().map(e => {
                const rc = RESULT_COLORS[e.result] || RESULT_COLORS.manual;
                const kc = KEY_COLOR_LABELS[e.keyColor] || KEY_COLOR_LABELS.unknown;
                return (
                  <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '110px 90px 70px 80px 1fr 28px', gap: 6, fontSize: 11, padding: '5px 0', borderBottom: '1px solid #1a1a1a', alignItems: 'center' }}>
                    <div style={{ color: '#555', fontSize: 10 }}>{formatTs(e.timestamp)}</div>
                    <div style={{ fontFamily: 'monospace', color: '#aaa', fontSize: 11 }}>{e.chipId}</div>
                    <div style={{ color: '#666', fontSize: 10 }}>{e.chipFamily}</div>
                    <div style={{ fontSize: 11 }}>{kc.emoji} {kc.label}</div>
                    <div>
                      <span style={{ fontSize: 10, fontWeight: 800, color: rc.text, background: rc.bg, border: `1px solid ${rc.border}33`, borderRadius: 4, padding: '1px 6px' }}>
                        {rc.label}
                      </span>
                      {e.notes && <span style={{ fontSize: 10, color: '#555', marginLeft: 6 }}>{e.notes}</span>}
                    </div>
                    <button
                      onClick={() => handleDelete(e.id)}
                      style={{ fontSize: 11, color: '#444', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                      title="Delete entry"
                    >✕</button>
                  </div>
                );
              })}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                <button
                  onClick={handleClear}
                  style={{ fontSize: 10, color: '#ef4444', background: 'none', border: '1px solid #ef444433', borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}
                >
                  Clear All
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
