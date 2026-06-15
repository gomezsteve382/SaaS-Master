/* JobLauncher — the job-first landing. Replaces the empty 50-tab grid with a
   "what are you working on?" card menu. Each card pre-stages the VIN and routes
   into the right workbench via startJob (wired by the shell). */

import { useState } from "react";
import { JOB_KINDS } from "../lib/jobLauncher.js";
import { T } from "../lib/theme.js";

// per-job accent (groups the cards by the workbench they open)
const ACCENT = {
  'add-key': T.purple, 'akl': T.purple, 'bcm-swap': T.orange, 'vin-sync': T.orange, 'read-live': T.blue,
};

export default function JobLauncher({ vin = "", onVin, onStart, onBack }) {
  const [v, setV] = useState(vin || "");
  const [err, setErr] = useState(null);
  const setVin = (x) => { const u = x.toUpperCase(); setV(u); onVin && onVin(u); };

  const start = (kind) => {
    setErr(null);
    const k = JOB_KINDS.find(j => j.key === kind);
    if (k?.needsVin && v.trim().length !== 17) { setErr(`"${k.label}" needs a 17-character VIN.`); return; }
    onStart && onStart(kind, { vin: v.trim() });
  };

  return (
    <div style={{ minHeight: "100%", background: T.bg, color: T.text, fontFamily: T.font, padding: "48px 24px" }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        {onBack && (
          <button onClick={onBack} style={{ background: "none", border: `1px solid ${T.border}`, color: T.dim, borderRadius: 8, padding: "5px 11px", cursor: "pointer", fontFamily: T.font, fontWeight: 700, fontSize: 12, marginBottom: 18 }}>← Change vehicle</button>
        )}
        <div style={{ fontFamily: "'Righteous',sans-serif", fontSize: 34, letterSpacing: 1, marginBottom: 4 }}>What are you working on?</div>
        <div style={{ color: T.dim, fontSize: 14, marginBottom: 28 }}>Pick a job — it opens the right workbench with your VIN staged.</div>

        {/* VIN */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, maxWidth: 520 }}>
          <input value={v} onChange={e => setVin(e.target.value)} maxLength={17} placeholder="VIN (optional for some jobs)"
            style={{ flex: 1, padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.panel,
              color: "#fff", fontFamily: T.mono, fontSize: 15, fontWeight: 700, letterSpacing: 1, boxSizing: "border-box" }} />
          <span style={{ fontFamily: T.mono, fontSize: 12, color: v.length === 17 ? T.green : T.faint }}>{v.length}/17</span>
        </div>
        {err && <div style={{ color: T.yellow, fontSize: 12, marginBottom: 8 }}>⚠ {err}</div>}

        {/* job cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 14, marginTop: 20 }}>
          {JOB_KINDS.map(k => {
            const a = ACCENT[k.key] || T.blue;
            return (
              <button key={k.key} onClick={() => start(k.key)} style={{
                textAlign: "left", padding: "20px 18px", borderRadius: 14, cursor: "pointer",
                background: T.card, border: `1px solid ${T.border}`, color: T.text, transition: "all .15s",
                display: "flex", flexDirection: "column", gap: 8, position: "relative", overflow: "hidden",
              }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = a; e.currentTarget.style.transform = "translateY(-2px)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.transform = "none"; }}>
                <div style={{ position: "absolute", top: -30, right: -30, width: 90, height: 90, borderRadius: "50%", background: `radial-gradient(circle, ${a}22, transparent 70%)` }} />
                <div style={{ fontSize: 30 }}>{k.icon}</div>
                <div style={{ fontFamily: "'Righteous',sans-serif", fontSize: 17, letterSpacing: 0.5 }}>{k.label}</div>
                <div style={{ fontSize: 12, color: T.dim }}>{k.sub}</div>
                {k.needsVin && <div style={{ fontSize: 10, color: T.faint, fontFamily: T.mono, marginTop: 2 }}>needs VIN</div>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
