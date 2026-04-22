import React, { useState, useCallback } from 'react';
import { C } from './constants.js';

const TECH_KEY = 'srtlab_recent_techs';
const MAX_TECHS = 20;

/* ── storage helpers ──────────────────────────────────────────────────── */

export function getRecentTechs() {
  try {
    return JSON.parse(localStorage.getItem(TECH_KEY) || '[]');
  } catch {
    return [];
  }
}

/** Record a tech selection. Pass addBackup=true when a backup was created
 *  during that session so the count increments correctly. */
export function recordTechUsed(name, { addBackup = false } = {}) {
  const normalized = name?.trim();
  if (!normalized) return;
  try {
    const techs = getRecentTechs();
    const existing = techs.find(t => t.name === normalized);
    if (existing) {
      existing.lastUsed = Date.now();
      if (addBackup) existing.backupCount = (existing.backupCount || 0) + 1;
    } else {
      techs.push({ name: normalized, lastUsed: Date.now(), backupCount: addBackup ? 1 : 0 });
    }
    const kept = techs
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
      .slice(0, MAX_TECHS);
    localStorage.setItem(TECH_KEY, JSON.stringify(kept));
  } catch { /* storage full — ignore */ }
}

/** Increment the backup count for a named tech without changing lastUsed. */
export function incrementTechBackupCount(name) {
  const normalized = name?.trim();
  if (!normalized) return;
  try {
    const techs = getRecentTechs();
    const entry = techs.find(t => t.name === normalized);
    if (entry) {
      entry.backupCount = (entry.backupCount || 0) + 1;
      localStorage.setItem(TECH_KEY, JSON.stringify(techs));
    }
  } catch {}
}

/**
 * Returns the RECENT list sorted by backup count descending.
 * Ties fall back to most-recently-used (lastUsed desc).
 *
 * This ordering — highest backup count first — lets shop leads instantly
 * spot the most active techs without scanning the full list.
 */
export function getSortedRecentTechs() {
  const techs = getRecentTechs();
  return [...techs].sort((a, b) => {
    const byCount = (b.backupCount || 0) - (a.backupCount || 0);
    if (byCount !== 0) return byCount;
    return (b.lastUsed || 0) - (a.lastUsed || 0);
  });
}

/* ── component ────────────────────────────────────────────────────────── */

/**
 * TechPicker
 *
 * Props
 *   value       {string}   – controlled value (current tech name)
 *   onChange    {fn}       – called with new string when selection changes
 *   placeholder {string}   – input placeholder text
 */
export default function TechPicker({ value = '', onChange, placeholder = 'Technician name' }) {
  const [draft, setDraft] = useState(value);

  const otherRecents = getSortedRecentTechs();

  const commit = useCallback((name) => {
    const trimmed = name.trim();
    setDraft(trimmed);
    onChange?.(trimmed);
  }, [onChange]);

  const handleInput = useCallback((e) => {
    setDraft(e.target.value);
    onChange?.(e.target.value);
  }, [onChange]);

  return (
    <div>
      <input
        value={draft}
        onChange={handleInput}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: '10px 12px',
          border: '1.5px solid ' + C.bd,
          borderRadius: 8,
          fontSize: 13,
          fontFamily: "'Nunito'",
          boxSizing: 'border-box',
          color: C.tx,
          background: C.bg || '#fff',
          outline: 'none',
        }}
        onFocus={e => (e.target.style.borderColor = C.a2)}
        onBlur={e => (e.target.style.borderColor = C.bd)}
      />

      {otherRecents.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{
            fontSize: 9,
            fontWeight: 800,
            color: C.tm,
            letterSpacing: 2,
            marginBottom: 4,
          }}>
            RECENT
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {otherRecents.map(tech => (
              <button
                key={tech.name}
                type="button"
                onClick={() => commit(tech.name)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 20,
                  border: '1px solid ' + (draft === tech.name ? C.a2 : C.bd),
                  background: draft === tech.name ? C.a2 + '18' : 'transparent',
                  color: draft === tech.name ? C.a2 : C.ts,
                  fontSize: 11,
                  fontWeight: draft === tech.name ? 800 : 400,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  whiteSpace: 'nowrap',
                }}
              >
                {tech.name}
                {tech.backupCount > 0 && (
                  <span style={{
                    fontSize: 9,
                    fontWeight: 800,
                    padding: '1px 5px',
                    borderRadius: 8,
                    background: C.a2 + '22',
                    color: C.a2,
                    letterSpacing: 0.5,
                  }}>
                    {tech.backupCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
