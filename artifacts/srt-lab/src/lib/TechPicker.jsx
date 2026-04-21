import React, { useState, useEffect, useCallback } from "react";
import { C } from "./constants.js";
import {
  getCurrentTech, getRecentTechs, setCurrentTech,
  forgetRecentTech, subscribeTechIdentity,
} from "./techIdentity.js";
import {
  listDiffReports, reassignUnknownDiffReports, subscribeDiffReports,
} from "./diffReports.js";

/* Bench-side technician picker. Lets any tech claim diff reports in this
 * browser without first having to walk through the Read-First write modal,
 * switch identities mid-shift, and (optionally) re-attribute previously
 * "unknown" reports to themselves. Listens to the techIdentity event bus so
 * a switch made elsewhere (e.g. confirming a write modal) is reflected here
 * immediately. */
export default function TechPicker() {
  const [current, setCurrent] = useState(() => getCurrentTech());
  const [recents, setRecents] = useState(() => getRecentTechs());
  const [draft, setDraft] = useState(() => getCurrentTech() || "");
  const [unknownCount, setUnknownCount] = useState(
    () => listDiffReports().filter((r) => !r.author).length,
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const sync = () => {
      const cur = getCurrentTech();
      setCurrent(cur);
      setRecents(getRecentTechs());
      setDraft((d) => (d ? d : cur || ""));
    };
    return subscribeTechIdentity(sync);
  }, []);

  useEffect(() => {
    const refresh = () => setUnknownCount(listDiffReports().filter((r) => !r.author).length);
    refresh();
    return subscribeDiffReports(refresh);
  }, []);

  const handleSet = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setStatus({ kind: "error", text: "Type a name first." });
      return;
    }
    const resolved = setCurrentTech(trimmed);
    setStatus({ kind: "ok", text: resolved === current ? "Already signed in." : `Signed in as ${resolved}.` });
  }, [draft, current]);

  const handleSwitch = useCallback((name) => {
    setDraft(name);
    setCurrentTech(name);
    setStatus({ kind: "ok", text: `Switched to ${name}.` });
  }, []);

  const handleClear = useCallback(() => {
    setCurrentTech("");
    setDraft("");
    setStatus({ kind: "ok", text: "Signed out." });
  }, []);

  const handleForget = useCallback((name) => {
    forgetRecentTech(name);
    setStatus({ kind: "ok", text: `Removed “${name}” from suggestions.` });
  }, []);

  const handleClaimUnknowns = useCallback(async () => {
    if (!current) {
      setStatus({ kind: "error", text: "Set a tech name first to claim unknown reports." });
      return;
    }
    if (!unknownCount) return;
    if (!window.confirm(`Re-attribute ${unknownCount} unknown diff report${unknownCount === 1 ? "" : "s"} to ${current}?`)) return;
    setBusy(true);
    try {
      const r = await reassignUnknownDiffReports(current);
      setUnknownCount(listDiffReports().filter((rep) => !rep.author).length);
      if (r.failed.length) {
        setStatus({ kind: "warn", text: `Re-attributed ${r.updatedCount}; ${r.failed.length} could not be updated.` });
      } else {
        setStatus({ kind: "ok", text: `Re-attributed ${r.updatedCount} report${r.updatedCount === 1 ? "" : "s"} to ${current}.` });
      }
    } catch (e) {
      setStatus({ kind: "error", text: "Re-attribution failed: " + (e?.message || String(e)) });
    } finally {
      setBusy(false);
    }
  }, [current, unknownCount]);

  const otherRecents = recents.filter((n) => !current || n.toLowerCase() !== current.toLowerCase());
  const statusColor = status?.kind === "error" ? C.er : status?.kind === "warn" ? C.wn : C.gn;

  return (
    <div data-testid="tech-picker" style={{
      display: "flex", flexDirection: "column", gap: 10,
      padding: 14, background: C.cd, border: "1.5px solid " + C.bd, borderRadius: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 2 }}>👤 ACTIVE TECH</div>
        <div data-testid="tech-picker-current" style={{
          padding: "4px 10px", borderRadius: 6,
          background: current ? C.gn + "18" : C.bd,
          color: current ? C.gn : C.tm,
          border: "1px solid " + (current ? C.gn + "55" : C.bd),
          fontFamily: "'JetBrains Mono'", fontSize: 12, fontWeight: 800, letterSpacing: 0.5,
        }}>
          {current || "(not set)"}
        </div>
        <div style={{ flex: 1, minWidth: 180, display: "flex", gap: 6 }}>
          <input
            list="srtlab-tech-picker-recents"
            data-testid="tech-picker-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSet(); }}
            placeholder="Type or pick a name…"
            style={{
              flex: 1, minWidth: 160, padding: "7px 10px",
              border: "1.5px solid " + C.bd, borderRadius: 6,
              background: C.c2, color: C.tx, fontSize: 13,
              fontFamily: "'JetBrains Mono'", outline: "none",
            }}
          />
          {recents.length > 0 && (
            <datalist id="srtlab-tech-picker-recents">
              {recents.map((n) => <option key={n} value={n} />)}
            </datalist>
          )}
          <button
            data-testid="tech-picker-set"
            onClick={handleSet}
            style={pickerBtn(C.a2, false, false)}
          >
            {current ? "Switch" : "Set"}
          </button>
          {current && (
            <button
              data-testid="tech-picker-clear"
              onClick={handleClear}
              style={pickerBtn(C.tm, true, false)}
            >
              Sign out
            </button>
          )}
        </div>
      </div>

      {otherRecents.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1.5 }}>RECENT:</div>
          {otherRecents.map((n) => (
            <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <button
                data-testid={"tech-picker-recent-" + n}
                onClick={() => handleSwitch(n)}
                title={"Switch to " + n}
                style={{
                  padding: "3px 9px", borderRadius: 12,
                  background: C.c2, border: "1px solid " + C.bd,
                  color: C.ts, fontSize: 11, fontWeight: 700,
                  cursor: "pointer", fontFamily: "'JetBrains Mono'",
                }}
              >
                {n}
              </button>
              <button
                onClick={() => handleForget(n)}
                title={"Remove " + n + " from suggestions"}
                style={{
                  border: "none", background: "transparent", cursor: "pointer",
                  color: C.tm, fontSize: 12, padding: "0 2px", lineHeight: 1,
                }}
              >×</button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, color: C.tm, lineHeight: 1.4, flex: 1, minWidth: 200 }}>
          New diff reports saved from this browser will be tagged with the active tech.
          {unknownCount > 0 && <> {" "}
            <b data-testid="tech-picker-unknown-count">{unknownCount}</b> existing
            report{unknownCount === 1 ? " is" : "s are"} tagged <i>unknown</i>.
          </>}
        </div>
        {unknownCount > 0 && (
          <button
            data-testid="tech-picker-claim-unknowns"
            onClick={handleClaimUnknowns}
            disabled={busy || !current}
            style={pickerBtn(C.a3, true, busy || !current)}
          >
            {busy ? "…claiming" : "Claim unknown (" + unknownCount + ")"}
          </button>
        )}
      </div>

      {status && (
        <div data-testid="tech-picker-status" style={{
          fontSize: 11, color: statusColor, fontWeight: 700,
        }}>
          {status.text}
        </div>
      )}
    </div>
  );
}

function pickerBtn(color, outline, disabled) {
  return {
    padding: "7px 14px", borderRadius: 8,
    fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, letterSpacing: 0.5,
    border: outline ? "1.5px solid " + color + "55" : "none",
    background: disabled ? "#E8E4DE" : outline ? "transparent" : color,
    color: disabled ? C.tm : outline ? color : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "all 0.2s",
  };
}
