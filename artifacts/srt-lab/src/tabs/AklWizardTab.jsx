/* AklWizardTab — All-Keys-Lost wizard.

   The highest-value locksmith job, fusing the offline PIN/SEC16 extractor and the
   live key-learn primitives that already exist in liveImmo.js, behind a planner
   (aklPlanner.js) that gates the dangerous steps:
     - a live bridge is REQUIRED to program (a dump alone only supplies the PIN);
     - a first-key learn needs ≥ 1 EMPTY slot — slots-full requires an explicit,
       irreversible erase-all;
     - exitKeyLearn runs on BOTH success and abort.

   PIN source: LIVE (readPin: 27 01/02 → SEC16 → PIN) or DUMP (paste the 16-byte
   SEC16 from your dump tool → pinFromSec16). Both branches then run the same live
   enterKeyLearn (routine 0x0203, sbecAlgo security) → confirmKeyLearned. */

import { useState, useCallback, useRef, useEffect } from "react";
import { createBridgeEngine } from "../lib/bridgeEngine.js";
import {
  connectImmoModule, readPin, readKeySlots, enterKeyLearn, confirmKeyLearned,
  exitKeyLearn, eraseAllKeys, pinFromSec16, immoNrcMsg, LIVE_KEY_SLOT_COUNT,
} from "../lib/liveImmo.js";
import { planAkl, pinSourceLabel } from "../lib/aklPlanner.js";

const S = {
  bg: "#0A0A0F", card: "#12121A", border: "#1E1E2E", text: "#E0E0E0", dim: "#6B7280",
  red: "#DC143C", green: "#00C853", blue: "#2196F3", yellow: "#FFB300", purple: "#BB86FC",
  font: '"Nunito", system-ui, sans-serif', mono: '"JetBrains Mono", monospace',
};
const hx3 = n => "0x" + n.toString(16).toUpperCase().padStart(3, "0");

const IMMO_ADDRS = [
  { label: "RFHUB — LD 2019+ (740/4C0)", tx: 0x740, rx: 0x4C0 },
  { label: "RFHUB — CUSW (75F/767)",     tx: 0x75F, rx: 0x767 },
  { label: "RFHUB — liveImmo (742/762)", tx: 0x742, rx: 0x762 },
  { label: "SKREEM / SKIM (75A/77A)",    tx: 0x75A, rx: 0x77A },
];

function Btn({ children, onClick, disabled, color = S.blue, small }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: small ? "5px 11px" : "9px 16px", background: disabled ? "#1c1c26" : color,
      color: disabled ? "#555" : "#fff", border: "none", borderRadius: 6,
      cursor: disabled ? "not-allowed" : "pointer", fontFamily: S.font, fontWeight: 800,
      fontSize: small ? 11 : 12.5, opacity: disabled ? 0.6 : 1, whiteSpace: "nowrap",
    }}>{children}</button>
  );
}

const hexToBytes = (s) => {
  const c = String(s).replace(/[^0-9a-fA-F]/g, "");
  const out = [];
  for (let i = 0; i + 1 < c.length; i += 2) out.push(parseInt(c.substr(i, 2), 16));
  return out;
};

export default function AklWizardTab() {
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addrIdx, setAddrIdx] = useState(0);
  const [mode, setMode] = useState("live");       // 'live' | 'dump'
  const [sec16Hex, setSec16Hex] = useState("");
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);     // {ok, slotIdx, pin}
  const [pendingErase, setPendingErase] = useState(false);

  const engineRef = useRef(null);
  const logRef = useRef(null);

  const addLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLog(p => [...p.slice(-400), { ts, msg, type }]);
  }, []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const addr = IMMO_ADDRS[addrIdx];
  const dumpSec16 = mode === "dump" ? hexToBytes(sec16Hex) : null;
  const plan = planAkl({ hasBridge: connected, hasDump: mode === "dump", dumpSec16 });

  const connect = useCallback(async () => {
    setBusy(true); addLog("Connecting to J2534 bridge…");
    try {
      const res = await createBridgeEngine({ addLog });
      if (!res || !res.ok) { addLog("Connect failed: " + (res?.error || "bridge unreachable"), "error"); return; }
      engineRef.current = res.engine;
      setConnected(true);
      addLog(`✓ Bridge ready — ${res.engine.adapter || "J2534"}`, "success");
    } finally { setBusy(false); }
  }, [addLog]);

  const runAkl = useCallback(async (eraseConfirmed = false) => {
    const eng = engineRef.current;
    if (!eng) { addLog("Connect first.", "error"); return; }
    setBusy(true); setResult(null); setPendingErase(false);
    addLog(`── All-Keys-Lost: ${addr.label} · PIN from ${pinSourceLabel(mode === "dump" ? "dump" : "live")} ──`, "header");
    try {
      // 1. connect/identify
      const c = await connectImmoModule(eng, addr);
      if (!c.ok) { addLog(`✗ Module did not answer at ${hx3(addr.tx)}/${hx3(addr.rx)}: ${immoNrcMsg(c.nrc) || c.error || "no response"}`, "error"); return; }
      addLog("✓ Immobilizer module identified", "rx");

      // 2. PIN source
      let pin = null;
      if (mode === "dump") {
        if (!dumpSec16 || dumpSec16.length < 16) { addLog("✗ Paste a 16-byte SEC16 hex for the dump branch.", "error"); return; }
        pin = pinFromSec16(dumpSec16);
        if (!pin) { addLog("✗ Dump SEC16 produced no PIN (blank / invalid).", "error"); return; }
        addLog(`PIN (offline, from dump SEC16): ${pin}`, "rx");
      } else {
        const pr = await readPin(eng, addr);
        if (!pr.ok) { addLog(`✗ readPin failed: ${immoNrcMsg(pr.nrc) || pr.error}`, "error"); return; }
        pin = pr.pinDec;
        addLog(`PIN (live): ${pin}`, "rx");
      }

      // 3. slots — need ≥1 empty
      const sl = await readKeySlots(eng, addr);
      if (!sl.ok) { addLog(`✗ readKeySlots failed: ${sl.error || "no response"}`, "error"); return; }
      addLog(`Key slots: ${sl.occupiedCount}/${LIVE_KEY_SLOT_COUNT} occupied`, "info");
      if (sl.occupiedCount >= LIVE_KEY_SLOT_COUNT) {
        if (!eraseConfirmed) { setPendingErase(true); addLog("Slots full — erase-all required before a first-key learn (IRREVERSIBLE). Confirm to proceed.", "warn"); return; }
        addLog("Erasing all keys (irreversible)…", "warn");
        const er = await eraseAllKeys(eng, addr);
        if (!er.ok) { addLog(`✗ eraseAllKeys failed: ${immoNrcMsg(er.nrc) || er.error}`, "error"); return; }
        addLog("✓ All keys erased", "rx");
      }

      // 4. enter key-learn
      const el = await enterKeyLearn(eng, addr);
      if (!el.ok) {
        addLog(`✗ enterKeyLearn failed: ${immoNrcMsg(el.nrc) || el.error}`, "error");
        await exitKeyLearn(eng, addr).catch(() => {});
        return;
      }
      addLog("✓ Key-learn active — INSERT the new key and cycle ignition NOW (30 s window)…", "header");

      // 5. confirm (operator inserts key + cycles ignition during this poll)
      const cf = await confirmKeyLearned(eng, addr, { timeoutMs: 30000 });
      await exitKeyLearn(eng, addr).catch(() => {});   // ALWAYS exit
      if (!cf.ok) { addLog(`✗ Key not learned: ${cf.error || "timeout / no transponder"}`, "error"); return; }
      addLog(`✓ KEY LEARNED into slot ${cf.slotIdx}`, "success");
      setResult({ ok: true, slotIdx: cf.slotIdx, pin });
    } catch (e) {
      addLog(`AKL error: ${e?.message || e}`, "error");
      try { await exitKeyLearn(engineRef.current, addr).catch(() => {}); } catch {}
    } finally { setBusy(false); }
  }, [addLog, addr, mode, dumpSec16]);

  const logColor = { rx: "#69F0AE", error: "#FF5252", warn: S.yellow, success: "#69F0AE", info: "#9aa0aa", header: S.purple };

  return (
    <div style={{ background: S.bg, minHeight: "100%", padding: 16, fontFamily: S.font, color: S.text }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, padding: "12px 18px",
          borderRadius: 10, border: `1px solid ${S.border}`, background: "linear-gradient(135deg,#1a0f2e,#0A1628)" }}>
          <div style={{ fontSize: 26 }}>🔐</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous',sans-serif", fontSize: 21, letterSpacing: 2 }}>ALL-KEYS-LOST</div>
            <div style={{ fontSize: 10, opacity: 0.6, letterSpacing: 3, fontWeight: 700 }}>PIN EXTRACT · FIRST-KEY PROGRAM · GATED</div>
          </div>
          <div style={{ padding: "6px 14px", borderRadius: 6, fontFamily: S.mono, fontSize: 12, fontWeight: 800,
            background: connected ? "#022" : "#1a1a1a", color: connected ? S.green : S.dim, border: `1px solid ${connected ? S.green : S.border}` }}>
            {connected ? "● CAN LIVE" : "○ OFFLINE"}
          </div>
          {!connected && <Btn onClick={connect} disabled={busy}>Connect</Btn>}
        </div>

        {/* config */}
        <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: 14, marginBottom: 12, display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: S.dim, letterSpacing: 1.5, marginBottom: 6 }}>IMMOBILIZER MODULE</div>
            <select value={addrIdx} onChange={e => setAddrIdx(Number(e.target.value))}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${S.border}`, background: "#0A0A0F", color: S.text, fontFamily: S.mono, fontSize: 12 }}>
              {IMMO_ADDRS.map((a, i) => <option key={i} value={i}>{a.label}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: S.dim, letterSpacing: 1.5, marginBottom: 6 }}>PIN SOURCE</div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setMode("live")} color={mode === "live" ? S.blue : "#23232e"} small>Live read</Btn>
              <Btn onClick={() => setMode("dump")} color={mode === "dump" ? S.blue : "#23232e"} small>From dump SEC16</Btn>
            </div>
            {mode === "dump" && (
              <input value={sec16Hex} onChange={e => setSec16Hex(e.target.value)} placeholder="paste 16-byte SEC16 hex"
                style={{ width: "100%", marginTop: 8, padding: "8px 10px", borderRadius: 6, border: `1px solid ${S.border}`, background: "#0A0A0F", color: "#fff", fontFamily: S.mono, fontSize: 12, boxSizing: "border-box" }} />
            )}
          </div>
        </div>

        {/* plan + run */}
        <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: S.purple, letterSpacing: 1.5, marginBottom: 8 }}>PLAN — {plan.branch.toUpperCase()} BRANCH</div>
          <ol style={{ margin: "0 0 10px", paddingLeft: 20, fontSize: 12, lineHeight: 1.7, color: S.text }}>
            {plan.steps.map(s => (
              <li key={s.id} style={{ color: s.kind === "confirm" ? S.red : s.kind === "operator" ? S.yellow : S.text }}>
                {s.label}{s.kind === "confirm" ? "  ⚠ irreversible" : s.kind === "operator" ? "  ✋ you" : ""}
              </li>
            ))}
          </ol>
          {plan.blocks.map((b, i) => <div key={i} style={{ fontSize: 11, color: "#FF8F00", marginBottom: 6 }}>⚠ {b}</div>)}
          <Btn onClick={() => runAkl(false)} disabled={!connected || busy} color={S.green}>Run AKL job</Btn>
          {result?.ok && (
            <div style={{ marginTop: 10, fontFamily: S.mono, fontSize: 12, color: S.green }}>
              ✓ Key learned into slot {result.slotIdx} · PIN {result.pin}
            </div>
          )}
        </div>

        {/* log */}
        <div style={{ background: "#06060a", border: `1px solid ${S.border}`, borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: S.dim, letterSpacing: 1.5, marginBottom: 6 }}>LOG</div>
          <div ref={logRef} style={{ maxHeight: 240, overflowY: "auto", fontFamily: S.mono, fontSize: 11.5, lineHeight: 1.65 }}>
            {log.length === 0 && <div style={{ color: S.dim }}>Connect, choose the module + PIN source, then Run AKL.</div>}
            {log.map((l, i) => <div key={i} style={{ color: logColor[l.type] || "#9aa0aa" }}><span style={{ color: "#454b54" }}>{l.ts} </span>{l.msg}</div>)}
          </div>
        </div>
      </div>

      {/* erase confirm gate */}
      {pendingErase && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: S.card, border: `1px solid ${S.red}`, borderRadius: 12, padding: 24, maxWidth: 420, width: "90%" }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: S.red, marginBottom: 10 }}>⚠ Erase all keys?</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
              All 8 key slots are occupied. A first-key learn needs an empty slot, so every existing key must be erased first.
              <b style={{ color: "#fff" }}> This is irreversible</b> — all current keys stop working until re-learned.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn onClick={() => setPendingErase(false)} color="#333" small>Cancel</Btn>
              <Btn onClick={() => runAkl(true)} color={S.red}>Erase + learn</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
