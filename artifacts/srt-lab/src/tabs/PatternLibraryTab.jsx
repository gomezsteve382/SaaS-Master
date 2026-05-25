/**
 * PatternLibraryTab — cross-binary pattern library (Task #695).
 *
 * Displays deduplicated byte-level signatures discovered across every dump
 * the bench has seen: VIN encodings, seed-key constants, SKIM layouts,
 * calibration IDs, CRC tables, XOR keys, module signatures, security bytes.
 *
 * Mirrors the BinaryIntelTab look for UI consistency.
 */

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { C } from "../lib/constants.js";
import { Card } from "../lib/ui.jsx";

const API = "/api";

const CATEGORIES = [
  { id: "all",               icon: "🗂️",  label: "All Patterns" },
  { id: "vin_encoding",      icon: "🔤",  label: "VIN Encoding" },
  { id: "seed_key_constant", icon: "🔐",  label: "Seed-Key Constants" },
  { id: "security_bytes",    icon: "🛡️",  label: "Security Bytes" },
  { id: "skim_layout",       icon: "🗝️",  label: "SKIM Layout" },
  { id: "calibration_id",    icon: "📐",  label: "Calibration IDs" },
  { id: "crc_table",         icon: "🔢",  label: "CRC Tables" },
  { id: "xor_key",           icon: "⊕",   label: "XOR Keys" },
  { id: "module_signature",  icon: "📦",  label: "Module Signatures" },
  { id: "unknown",           icon: "❓",  label: "Other" },
];

const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
const CAT_ICON  = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.icon]));

const CONF_COLOR = (c) => {
  if (c >= 0.9) return "#2E7D32";
  if (c >= 0.75) return "#E65100";
  return "#B71C1C";
};

function ConfidenceBadge({ value }) {
  const pct = Math.round((value ?? 0) * 100);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "2px 8px", borderRadius: 6,
      background: CONF_COLOR(value) + "18", color: CONF_COLOR(value),
      fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 800, fontSize: 10, letterSpacing: 0.8,
    }}>
      {pct}% conf
    </span>
  );
}

function CategorySidebar({ counts, selected, onSelect }) {
  return (
    <div style={{
      width: 190, flexShrink: 0,
      borderRight: `1px solid ${C.bd}`,
      paddingRight: 8,
    }}>
      {CATEGORIES.map((cat) => {
        const count = cat.id === "all"
          ? Object.values(counts).reduce((a, b) => a + b, 0)
          : (counts[cat.id] ?? 0);
        const active = selected === cat.id;
        return (
          <button
            key={cat.id}
            onClick={() => onSelect(cat.id)}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              width: "100%", padding: "8px 12px", borderRadius: 8,
              border: "none", cursor: "pointer", textAlign: "left",
              background: active ? C.sr + "18" : "transparent",
              color: active ? C.sr : C.ts,
              fontFamily: "'Nunito'", fontWeight: active ? 800 : 600,
              fontSize: 12, marginBottom: 2,
            }}
          >
            <span style={{ fontSize: 14 }}>{cat.icon}</span>
            <span style={{ flex: 1, lineHeight: 1.2 }}>{cat.label}</span>
            <span style={{
              fontFamily: "'JetBrains Mono'", fontSize: 10,
              background: active ? C.sr + "22" : C.bd,
              color: active ? C.sr : C.ts,
              borderRadius: 99, padding: "1px 7px",
            }}>
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PatternRow({ pattern, onDelete, onEdit }) {
  const [expanded, setExpanded] = useState(false);
  const srcIds = Array.isArray(pattern.sourceAnalysisIds)
    ? pattern.sourceAnalysisIds
    : [];

  return (
    <div style={{
      borderBottom: `1px solid ${C.bd}`,
      padding: "10px 0",
    }}>
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap",
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
            marginBottom: 4,
          }}>
            <span style={{ fontSize: 14 }}>
              {CAT_ICON[pattern.category] ?? "❓"}
            </span>
            <span style={{
              fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, color: C.tx,
            }}>
              {pattern.label}
            </span>
            <span style={{
              fontSize: 9, fontWeight: 800, color: C.ts,
              background: C.bd, borderRadius: 6, padding: "1px 7px",
              letterSpacing: 0.8, textTransform: "uppercase",
            }}>
              {CAT_LABEL[pattern.category] ?? pattern.category}
            </span>
            {srcIds.length > 0 && (
              <span style={{
                fontSize: 9, fontWeight: 800, color: "#1565C0",
                background: "#E3F2FD", borderRadius: 6, padding: "1px 7px",
                letterSpacing: 0.5, cursor: "pointer",
              }} onClick={() => setExpanded((x) => !x)}>
                {srcIds.length} {srcIds.length === 1 ? "analysis" : "analyses"} {expanded ? "▲" : "▼"}
              </span>
            )}
          </div>
          {pattern.signatureBytes && (
            <code style={{
              display: "block", fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10, background: "#F5F5F5", padding: "4px 8px",
              borderRadius: 4, color: C.bk, marginBottom: 4,
              overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
              maxWidth: "60ch",
            }}>
              {pattern.signatureBytes}
            </code>
          )}
          {pattern.notes && (
            <div style={{ fontSize: 10, color: C.ts, lineHeight: 1.5 }}>
              {pattern.notes}
            </div>
          )}
          {expanded && srcIds.length > 0 && (
            <div style={{
              marginTop: 6, padding: "6px 10px",
              background: "#F0F4FF", borderRadius: 6,
              fontSize: 10, fontFamily: "'JetBrains Mono'", color: "#1565C0",
              lineHeight: 1.8,
            }}>
              <strong>Source analyses:</strong>
              {srcIds.map((id) => (
                <div key={id}>{id}</div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ConfidenceBadge value={pattern.confidence} />
          <button
            onClick={() => onEdit(pattern)}
            title="Edit pattern"
            style={{
              background: "none", border: `1px solid ${C.bd}`,
              borderRadius: 6, cursor: "pointer", padding: "3px 8px",
              color: "#7B1FA2", fontSize: 11, fontFamily: "'Nunito'",
              fontWeight: 700,
            }}
          >
            Edit
          </button>
          <button
            onClick={() => onDelete(pattern.id)}
            title="Delete pattern"
            style={{
              background: "none", border: `1px solid ${C.bd}`,
              borderRadius: 6, cursor: "pointer", padding: "3px 8px",
              color: C.ts, fontSize: 11, fontFamily: "'Nunito'",
              fontWeight: 700,
            }}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function EditPatternModal({ pattern, onClose, onSaved }) {
  const [label, setLabel] = useState(pattern.label ?? "");
  const [notes, setNotes] = useState(pattern.notes ?? "");
  const [confidence, setConfidence] = useState(pattern.confidence ?? 1.0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    if (!label.trim()) { setErr("Label is required."); return; }
    setSaving(true);
    try {
      const r = await fetch(`${API}/patterns/${pattern.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), notes: notes.trim() || null, confidence: Number(confidence) }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
      onClose();
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: C.cd, borderRadius: 14, padding: 24, width: 440, maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
        <div style={{ fontFamily: "'Righteous'", fontSize: 16, color: "#7B1FA2", marginBottom: 16 }}>Edit Pattern</div>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 800, color: C.ts, display: "flex", flexDirection: "column", gap: 4 }}>
            LABEL *
            <input value={label} onChange={(e) => setLabel(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.bd}`, fontFamily: "'Nunito'", fontSize: 12 }} />
          </label>
          <label style={{ fontSize: 11, fontWeight: 800, color: C.ts, display: "flex", flexDirection: "column", gap: 4 }}>
            CONFIDENCE (0–1)
            <input type="number" min={0} max={1} step={0.01} value={confidence} onChange={(e) => setConfidence(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.bd}`, fontFamily: "'JetBrains Mono'", fontSize: 12 }} />
          </label>
          <label style={{ fontSize: 11, fontWeight: 800, color: C.ts, display: "flex", flexDirection: "column", gap: 4 }}>
            NOTES
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.bd}`, fontFamily: "'Nunito'", fontSize: 12, resize: "vertical" }} />
          </label>
          {err && <div style={{ color: C.er, fontSize: 11, fontWeight: 700 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose}
              style={{ padding: "8px 18px", borderRadius: 8, border: `1px solid ${C.bd}`, background: "none", cursor: "pointer", fontFamily: "'Nunito'", fontWeight: 700, fontSize: 12 }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: "#7B1FA2", color: "#fff", cursor: saving ? "not-allowed" : "pointer", fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12 }}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AddPatternModal({ onClose, onAdded }) {
  const [category, setCategory] = useState("module_signature");
  const [label, setLabel] = useState("");
  const [signatureBytes, setSignatureBytes] = useState("");
  const [signatureHash, setSignatureHash] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    if (!label.trim() || !signatureHash.trim()) {
      setErr("Label and signature hash are required.");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`${API}/patterns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          label: label.trim(),
          signatureBytes: signatureBytes.trim() || null,
          signatureHash: signatureHash.trim(),
          notes: notes.trim() || null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onAdded();
      onClose();
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: C.cd, borderRadius: 14, padding: 24, width: 460,
        maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
      }}>
        <div style={{ fontFamily: "'Righteous'", fontSize: 16, color: C.sr, marginBottom: 16 }}>
          Add Pattern
        </div>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 800, color: C.ts, display: "flex", flexDirection: "column", gap: 4 }}>
            CATEGORY
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.bd}`, fontFamily: "'Nunito'", fontSize: 12 }}>
              {CATEGORIES.filter((c) => c.id !== "all").map((c) => (
                <option key={c.id} value={c.id}>{c.icon} {c.label}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11, fontWeight: 800, color: C.ts, display: "flex", flexDirection: "column", gap: 4 }}>
            LABEL *
            <input value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. SEC16 bytes for 2019 SRT Hellcat"
              style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.bd}`, fontFamily: "'Nunito'", fontSize: 12 }} />
          </label>
          <label style={{ fontSize: 11, fontWeight: 800, color: C.ts, display: "flex", flexDirection: "column", gap: 4 }}>
            SIGNATURE BYTES (hex, optional)
            <input value={signatureBytes} onChange={(e) => setSignatureBytes(e.target.value)}
              placeholder="AB CD EF …"
              style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.bd}`, fontFamily: "'JetBrains Mono'", fontSize: 11 }} />
          </label>
          <label style={{ fontSize: 11, fontWeight: 800, color: C.ts, display: "flex", flexDirection: "column", gap: 4 }}>
            SIGNATURE HASH (dedup key) *
            <input value={signatureHash} onChange={(e) => setSignatureHash(e.target.value)}
              placeholder="SHA-256 prefix or custom key"
              style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.bd}`, fontFamily: "'JetBrains Mono'", fontSize: 11 }} />
          </label>
          <label style={{ fontSize: 11, fontWeight: 800, color: C.ts, display: "flex", flexDirection: "column", gap: 4 }}>
            NOTES
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.bd}`, fontFamily: "'Nunito'", fontSize: 12, resize: "vertical" }} />
          </label>
          {err && <div style={{ color: C.er, fontSize: 11, fontWeight: 700 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose}
              style={{ padding: "8px 18px", borderRadius: 8, border: `1px solid ${C.bd}`, background: "none", cursor: "pointer", fontFamily: "'Nunito'", fontWeight: 700, fontSize: 12 }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: C.sr, color: "#fff", cursor: saving ? "not-allowed" : "pointer", fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12 }}>
              {saving ? "Saving…" : "Add Pattern"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const LS_KEY = "srtlab.patternLib.lastSeenCount.v1";

export default function PatternLibraryTab() {
  const [patterns, setPatterns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [selectedCat, setSelectedCat] = useState("all");
  const [q, setQ] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editPattern, setEditPattern] = useState(null);
  const [newBanner, setNewBanner] = useState(null); // { count: N }

  const fetchPatterns = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const params = new URLSearchParams();
      if (selectedCat !== "all") params.set("category", selectedCat);
      if (q.trim()) params.set("q", q.trim());
      const r = await fetch(`${API}/patterns?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const rows = data.patterns ?? [];
      setPatterns(rows);

      // Show "new patterns" banner when viewing all (not filtered), by comparing
      // against the last total count stored in localStorage.
      if (selectedCat === "all" && !q.trim()) {
        const prev = parseInt(localStorage.getItem(LS_KEY) ?? "0", 10);
        if (rows.length > prev) {
          setNewBanner({ count: rows.length - prev });
        }
        localStorage.setItem(LS_KEY, String(rows.length));
      }
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setLoading(false);
    }
  }, [selectedCat, q]);

  useEffect(() => {
    fetchPatterns();
  }, [fetchPatterns]);

  const counts = useMemo(() => {
    const c = {};
    for (const p of patterns) {
      c[p.category] = (c[p.category] ?? 0) + 1;
    }
    return c;
  }, [patterns]);

  const visible = useMemo(() => {
    if (selectedCat === "all" && !q.trim()) return patterns;
    return patterns.filter((p) => {
      const catOk = selectedCat === "all" || p.category === selectedCat;
      const qOk = !q.trim() ||
        p.label.toLowerCase().includes(q.toLowerCase()) ||
        (p.notes ?? "").toLowerCase().includes(q.toLowerCase()) ||
        (p.signatureBytes ?? "").toLowerCase().includes(q.toLowerCase());
      return catOk && qOk;
    });
  }, [patterns, selectedCat, q]);

  async function handleDelete(id) {
    if (!confirm("Delete this pattern?")) return;
    await fetch(`${API}/patterns/${id}`, { method: "DELETE" });
    fetchPatterns();
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <Card style={{ marginBottom: 14, background: "#F3E5F5", borderColor: "#7B1FA2" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24 }}>🧬</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 13, color: "#4A148C", letterSpacing: 0.5 }}>
              PATTERN LIBRARY — CROSS-BINARY SIGNATURE DB
            </div>
            <div style={{ fontSize: 11, color: "#6A1B9A", marginTop: 4, lineHeight: 1.6 }}>
              Deduplicated byte-level signatures discovered across every dump the bench
              has analyzed. VIN encodings, seed-key constants, SKIM layouts, calibration IDs,
              CRC tables, XOR keys — all with provenance back to the source analysis.
              Patterns are populated automatically after each backup save.
            </div>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            style={{
              padding: "9px 16px", borderRadius: 9, border: "none",
              background: "#7B1FA2", color: "#fff",
              fontFamily: "'Nunito'", fontWeight: 800, fontSize: 11,
              cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
            }}
          >
            + Add Pattern
          </button>
        </div>
      </Card>

      {newBanner && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          background: "#E8F5E9", borderRadius: 9, padding: "10px 14px",
          marginBottom: 12, border: "1.5px solid #2E7D32",
        }}>
          <span style={{ fontSize: 16 }}>✨</span>
          <div style={{ flex: 1, fontFamily: "'Nunito'", fontSize: 12, color: "#1B5E20", fontWeight: 700 }}>
            {newBanner.count} new pattern{newBanner.count !== 1 ? "s" : ""} discovered since your last visit — auto-extracted from recent backups.
          </div>
          <button
            onClick={() => setNewBanner(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#2E7D32", fontSize: 14, fontWeight: 900, padding: "0 4px" }}
          >
            ✕
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 14 }}>
        <CategorySidebar counts={counts} selected={selectedCat} onSelect={setSelectedCat} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ marginBottom: 12 }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search patterns by label, bytes, notes…"
              style={{
                width: "100%", padding: "9px 14px", borderRadius: 9,
                border: `1.5px solid ${C.bd}`, fontFamily: "'Nunito'",
                fontSize: 12, outline: "none", boxSizing: "border-box",
                background: C.cd,
              }}
              onFocus={(e) => (e.target.style.borderColor = "#7B1FA2")}
              onBlur={(e) => (e.target.style.borderColor = C.bd)}
            />
          </div>

          {loading && (
            <div style={{ color: C.ts, fontSize: 12, fontStyle: "italic", padding: 20 }}>
              Loading patterns…
            </div>
          )}
          {err && (
            <div style={{ color: C.er, fontSize: 12, padding: 12, background: "#FFEBEE", borderRadius: 8 }}>
              {err}
            </div>
          )}

          {!loading && !err && visible.length === 0 && (
            <div style={{
              padding: 32, textAlign: "center", color: C.ts,
              fontSize: 12, fontStyle: "italic",
            }}>
              No patterns found.
              {selectedCat === "all" && !q
                ? " Load and analyze a module dump to auto-populate the library."
                : " Try a different category or search term."}
            </div>
          )}

          {!loading && visible.length > 0 && (
            <div>
              <div style={{
                fontSize: 10, fontWeight: 800, color: C.ts,
                letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8,
              }}>
                {visible.length} pattern{visible.length !== 1 ? "s" : ""}
                {selectedCat !== "all" ? ` · ${CAT_LABEL[selectedCat]}` : ""}
              </div>
              {visible.map((p) => (
                <PatternRow key={p.id} pattern={p} onDelete={handleDelete} onEdit={setEditPattern} />
              ))}
            </div>
          )}
        </div>
      </div>

      {showAdd && (
        <AddPatternModal onClose={() => setShowAdd(false)} onAdded={fetchPatterns} />
      )}
      {editPattern && (
        <EditPatternModal
          pattern={editPattern}
          onClose={() => setEditPattern(null)}
          onSaved={fetchPatterns}
        />
      )}
    </div>
  );
}
