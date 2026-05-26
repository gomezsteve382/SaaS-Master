/* ChipBurnAuditCard — surfaces the KeyWriter chip-burn audit trail on the
 * Workflow tab (Task #865).
 *
 * Reads the shared `srt-lab.keymgr.audit.v1` ring buffer that KeyWriterTab
 * (and KeyManagerTab) writes to and renders only the rows tagged
 * `source: 'keywriter'`. Subscribes to the `srtlab:audit` event so newly
 * persisted burns appear without a tab switch.
 *
 * Survives page reloads because the underlying storage is localStorage.
 */
import React, { useEffect, useState, useCallback } from "react";
import { C } from "../lib/constants.js";
import { Card, Tag } from "../lib/ui.jsx";

const AUDIT_KEY = "srt-lab.keymgr.audit.v1";
const MAX_ROWS = 25;

function readBurns() {
  try {
    const raw = globalThis.localStorage?.getItem(AUDIT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && e.source === "keywriter")
      .slice(-MAX_ROWS)
      .reverse();
  } catch {
    return [];
  }
}

function fmtTs(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

export default function ChipBurnAuditCard() {
  const [rows, setRows] = useState(() => readBurns());

  const refresh = useCallback(() => setRows(readBurns()), []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    window.addEventListener("srtlab:audit", refresh);
    /* storage events fire only across tabs; refresh covers same-tab reloads
     * (the initial render already populated rows). */
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("srtlab:audit", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  return (
    <Card style={{ marginBottom: 16 }} data-testid="chip-burn-audit-card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 1 }}>
          CHIP BURN AUDIT TRAIL
        </div>
        <Tag color={C.tm}>{rows.length}</Tag>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.ts }}>
          KEY WRITER tab · persists across reloads
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: C.tm }}>
          No chip burns recorded yet. Every burn (success or refusal) from the
          KEY WRITER tab will appear here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((r, i) => (
            <div
              key={`${r.ts}-${i}`}
              data-testid="chip-burn-audit-row"
              style={{
                padding: "8px 10px",
                border: `1px solid ${C.bd}`,
                borderRadius: 8,
                background: r.ok ? C.gn + "08" : C.er + "08",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Tag color={r.ok ? C.gn : C.er}>
                  {r.outcome || (r.ok ? "KEYMOD WRITTEN" : "KEYMOD REFUSED")}
                </Tag>
                <span style={{ fontFamily: "JetBrains Mono", color: C.tx }}>
                  VIN {r.vin || "NOVIN"}
                </span>
                <span style={{ color: C.ts }}>slot {Number.isInteger(r.slotIdx) ? r.slotIdx + 1 : "?"}</span>
                <span style={{ color: C.ts }}>chip {r.chipId || "?"}</span>
                <span style={{ color: C.ts }}>writer {r.writer || "?"}</span>
                {r.transport && <Tag color={C.tm}>{r.transport}</Tag>}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: C.ts }}>{fmtTs(r.ts)}</span>
              </div>
              {!r.ok && (r.failedAt || r.error) && (
                <div style={{ marginTop: 4, fontSize: 11, color: C.er }}>
                  failed at <strong>{r.failedAt || "transport"}</strong>
                  {r.error ? ` — ${r.error}` : ""}
                </div>
              )}
              {Array.isArray(r.steps) && r.steps.length > 0 && (
                <div
                  style={{
                    marginTop: 6,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 4,
                    fontFamily: "JetBrains Mono",
                    fontSize: 10,
                  }}
                >
                  {r.steps.map((s, j) => (
                    <span
                      key={j}
                      title={s.error || s.detail || ""}
                      style={{
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: s.ok ? C.gn + "22" : C.er + "22",
                        color: s.ok ? C.gn : C.er,
                      }}
                    >
                      {s.label}{s.ok ? " ✓" : " ✗"}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
