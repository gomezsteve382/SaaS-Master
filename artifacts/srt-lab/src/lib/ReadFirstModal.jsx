import React, { useState } from "react";
import { C } from "./constants.js";
import { Btn } from "./ui.jsx";

// Shared "Read-First" confirmation modal. Blocks any destructive write
// (e.g. backup restore) until the technician confirms they have reviewed
// the current/incoming state and have a paper trail reference.
export default function ReadFirstModal({
  title = "Confirm write",
  subtitle,
  module,
  summary,
  details,
  destructiveLabel = "PROCEED",
  onConfirm,
  onCancel,
}) {
  const [reviewed, setReviewed] = useState(false);
  const [titleRef, setTitleRef] = useState("");
  const [titleNotes, setTitleNotes] = useState("");
  const [technician, setTechnician] = useState(() => {
    try { return localStorage.getItem("srtlab_tech") || ""; } catch { return ""; }
  });

  const handleConfirm = () => {
    if (!reviewed) {
      alert("Please check the box confirming you reviewed the current module state.");
      return;
    }
    try { if (technician) localStorage.setItem("srtlab_tech", technician); } catch {}
    onConfirm({
      reviewed,
      titleRef,
      titleNotes,
      technician,
      preWriteConfirmed: new Date().toISOString(),
    });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,15,15,0.7)",
      zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20,
    }}>
      <div style={{
        background: "#fff", borderRadius: 14, maxWidth: 640, width: "100%",
        maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
      }}>
        <div style={{
          padding: "16px 20px", background: "linear-gradient(90deg,#B71C1C,#E53935)",
          color: "#fff", borderRadius: "14px 14px 0 0",
        }}>
          <div style={{ fontSize: 10, opacity: 0.85, letterSpacing: 2, fontWeight: 700 }}>
            ⚠ READ-FIRST CONFIRMATION
          </div>
          <div style={{ fontFamily: "'Righteous'", fontSize: 18, letterSpacing: 1 }}>
            {title}
          </div>
          {subtitle && <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>{subtitle}</div>}
        </div>

        <div style={{ padding: 20 }}>
          {module && (
            <div style={{
              padding: "8px 12px", background: "#FFF8F0", border: "1px solid " + C.wn + "55",
              borderRadius: 6, fontSize: 12, marginBottom: 12,
            }}>
              <b>Target module:</b> {module}
            </div>
          )}

          {summary && (
            <div style={{ fontSize: 13, color: C.tx, marginBottom: 12, lineHeight: 1.5 }}>
              {summary}
            </div>
          )}

          {details && (
            <div style={{
              maxHeight: 220, overflow: "auto", border: "1px solid " + C.bd,
              borderRadius: 8, padding: 10, background: C.c2, marginBottom: 14,
              fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.ts,
            }}>
              {details}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: C.ts, marginBottom: 4, fontWeight: 700, letterSpacing: 1 }}>
                TITLE REFERENCE
              </div>
              <input
                value={titleRef}
                onChange={e => setTitleRef(e.target.value)}
                placeholder="Title # / RO #"
                style={{ width: "100%", padding: 8, border: "1px solid " + C.bd, borderRadius: 6, fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.ts, marginBottom: 4, fontWeight: 700, letterSpacing: 1 }}>
                TECHNICIAN
              </div>
              <input
                value={technician}
                onChange={e => setTechnician(e.target.value)}
                placeholder="Your name"
                style={{ width: "100%", padding: 8, border: "1px solid " + C.bd, borderRadius: 6, fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div style={{ gridColumn: "1 / 3" }}>
              <div style={{ fontSize: 10, color: C.ts, marginBottom: 4, fontWeight: 700, letterSpacing: 1 }}>
                NOTES (optional)
              </div>
              <input
                value={titleNotes}
                onChange={e => setTitleNotes(e.target.value)}
                placeholder="Reason / context for paper trail"
                style={{ width: "100%", padding: 8, border: "1px solid " + C.bd, borderRadius: 6, fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
          </div>

          <label style={{
            display: "flex", gap: 10, alignItems: "flex-start",
            padding: 10, background: "#FFFDE7", border: "1px solid " + C.wn,
            borderRadius: 8, marginBottom: 14, cursor: "pointer",
          }}>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={e => setReviewed(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <div style={{ fontSize: 12, color: C.tx, lineHeight: 1.5 }}>
              I have reviewed the data above and I understand this write is permanent.
              I take responsibility for this operation.
            </div>
          </label>

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn onClick={onCancel} color={C.tm} outline>Cancel</Btn>
            <Btn onClick={handleConfirm} color={C.er}>{destructiveLabel}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
