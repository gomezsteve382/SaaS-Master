/* TopologyTab — live module workbench.

   A bus-rail topology view (BCM gateway + CAN-C / CAN-IHS rails) wired to the
   real J2534 bridge for live reads AND live VIN programming.

   Transport  : createBridgeEngine() — opens the device, brings up the ISO15765
                channel, and returns engine.uds(tx,rx,bytes) → {ok,d,raw}.
   Read       : 0x22 F190 (current VIN) + module-specific original-VIN DID.
   Write      : programVin({eng,row,vin}) — preflight read → 10 03 → seed/key
                unlock chain → 2E write each VIN DID → 0x22 verify. Gated behind
                an explicit operator confirm.

   Addresses are the bench-proven FCA map (RX is a LOW id, not tx+8) lifted from
   the sincro ecu_addressing.json (2019 LD) and verified live on this bench. */

import { useState, useCallback, useRef, useEffect } from "react";
import { createBridgeEngine } from "../lib/bridgeEngine.js";
import { programVin } from "../lib/vinProgrammer.js";
import { vinFromReadResponse, encodeDid, vinWriteDids } from "../lib/algos.js";

/* ─── bench-proven FCA topology (RX = LOW id) ─────────────────────────────── */
const GW = { code: "BCM", name: "Body Control Module", tx: 0x620, rx: 0x504, gw: true };
const BUSES = [
  { n: "CAN-C", seg: "seg 1", sp: "500K", mods: [
    { code: "PCM",  name: "Powertrain Control",  tx: 0x7E0, rx: 0x7E8 },
    { code: "TCM",  name: "Transmission",        tx: 0x7E1, rx: 0x7E9 },
    { code: "ABS",  name: "Anti-lock Brakes",    tx: 0x747, rx: 0x4C7 },
    { code: "ORC",  name: "Occupant Restraint",  tx: 0x744, rx: 0x4C4 },
    { code: "RFHUB",name: "RF Hub / Keyless",    tx: 0x740, rx: 0x4C0 },
    { code: "ESM",  name: "Electronic Shift",    tx: 0x749, rx: 0x4C9 },
    { code: "ACC",  name: "Adaptive Cruise",     tx: 0x753, rx: 0x4D3 },
    { code: "ADCM", name: "Active Damping",      tx: 0x757, rx: 0x4D7 },
    { code: "DTCM", name: "Drivetrain Ctrl",     tx: 0x74B, rx: 0x4CB },
    { code: "TPM",  name: "Tire Pressure",       tx: 0x743, rx: 0x4C3 },
  ]},
  { n: "CAN-C", seg: "seg 2", sp: "500K", mods: [
    { code: "IPC",  name: "Instrument Cluster",  tx: 0x742, rx: 0x4C2 },
    { code: "EPS",  name: "Power Steering",      tx: 0x75A, rx: 0x4DA },
    { code: "SCCM", name: "Steering Column",     tx: 0x763, rx: 0x4E3 },
    { code: "PTS",  name: "Park Assist",         tx: 0x762, rx: 0x4E2 },
    { code: "VSIM", name: "Veh Sys Interface",   tx: 0x771, rx: 0x4F1 },
    { code: "HALF", name: "Fwd Facing Cam",      tx: 0x764, rx: 0x4E4 },
  ]},
  { n: "CAN-IHS", seg: "seg 1", sp: "125K", mods: [
    { code: "HVAC", name: "Climate Control",     tx: 0x783, rx: 0x503 },
    { code: "ICS",  name: "Center Stack",        tx: 0x7BC, rx: 0x53C },
    { code: "AMP",  name: "Audio Amplifier",     tx: 0x7BE, rx: 0x53E },
    { code: "DDM",  name: "Driver Door",         tx: 0x784, rx: 0x504 },
    { code: "PDM",  name: "Passenger Door",      tx: 0x785, rx: 0x505 },
    { code: "MSM",  name: "Memory Seat",         tx: 0x78A, rx: 0x50A },
    { code: "ITM",  name: "Intrusion",           tx: 0x78F, rx: 0x50F },
  ]},
  { n: "CAN-IHS", seg: "seg 2", sp: "125K", mods: [
    { code: "CMCM", name: "Radio / Media",       tx: 0x7BF, rx: 0x53F },
    { code: "DCSD", name: "Driver Seat",         tx: 0x7AC, rx: 0x52C },
    { code: "HSM",  name: "Heated Seat",         tx: 0x792, rx: 0x512 },
    { code: "LBSS", name: "L Blind Spot",        tx: 0x791, rx: 0x511 },
    { code: "RBSS", name: "R Blind Spot",        tx: 0x799, rx: 0x519 },
  ]},
];
const ALL = [GW, ...BUSES.flatMap(b => b.mods)];

/* module-specific original-VIN DID (24-bit); everything else uses 7B88 */
const ORIG_DID = { BCM: 0x6E2025, RFHUB: 0x6E2027 };

/* ─── theme ───────────────────────────────────────────────────────────────── */
const S = {
  bg: "#0A0A0F", card: "#12121A", border: "#1E1E2E", text: "#E0E0E0", dim: "#6B7280",
  red: "#DC143C", green: "#00C853", blue: "#2196F3", yellow: "#FFB300", purple: "#BB86FC",
  font: '"Nunito", system-ui, sans-serif', mono: '"JetBrains Mono", monospace',
};
const hx3 = n => "0x" + n.toString(16).toUpperCase().padStart(3, "0");
// trailing printable-ASCII of a 0x62 positive read (skip the SID + DID header bytes)
const asciiTail = (d, skip) => {
  let s = "";
  for (let i = skip; i < d.length; i++) { const c = d[i]; if (c >= 0x20 && c < 0x7F) s += String.fromCharCode(c); }
  return s.trim();
};

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

const STATE_COLOR = { idle: S.dim, probing: S.yellow, live: S.green, busy: S.blue };

/* ─── component ───────────────────────────────────────────────────────────── */
export default function TopologyTab() {
  const [, force] = useState(0);
  const rerender = useCallback(() => force(n => n + 1), []);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(null);
  const [log, setLog] = useState([]);
  const [vinInput, setVinInput] = useState("");
  const [vins, setVins] = useState({});           // code → {current, original, reprogrammed}
  const [pendingWrite, setPendingWrite] = useState(null);

  const engineRef = useRef(null);
  const stateRef = useRef({});                     // code → 'idle'|'probing'|'live'|'busy'
  const logRef = useRef(null);

  const addLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLog(p => [...p.slice(-400), { ts, msg, type }]);
  }, []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const setMState = (code, st) => { stateRef.current[code] = st; rerender(); };

  /* ── connect: createBridgeEngine handles open + ISO15765 channel ───────── */
  const connect = useCallback(async () => {
    setBusy(true);
    addLog("Connecting to J2534 bridge…");
    try {
      const res = await createBridgeEngine({ addLog });
      if (!res || !res.ok) { addLog("Connect failed: " + (res?.error || "bridge unreachable — start j2534_bridge.py (port 8765)"), "error"); return; }
      engineRef.current = res.engine;
      setConnected(true);
      addLog(`✓ Bridge ready — ${res.engine.adapter || "J2534"}${res.engine.firmware ? " fw " + res.engine.firmware : ""}`, "success");
      const v = await res.engine.readVoltage?.();
      if (typeof v === "number") addLog(`Battery: ${v.toFixed(1)} V`, v < 11.5 ? "warn" : "info");
    } finally { setBusy(false); }
  }, [addLog]);

  /* ── scan all: 3E 00 probe, mark live, auto-select first responder ─────── */
  const scanAll = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng) { addLog("Connect first.", "error"); return; }
    setBusy(true);
    addLog("── Scanning bus (TesterPresent 3E 00) ──", "header");
    let firstLive = null, liveCount = 0;
    try {
      for (const m of ALL) {
        setMState(m.code, "probing");
        const r = await eng.uds(m.tx, m.rx, [0x3E, 0x00], 1000);
        const live = !!(r && r.ok && r.d && r.d.length > 0);
        setMState(m.code, live ? "live" : "idle");
        if (live) { liveCount++; if (!firstLive) firstLive = m; addLog(`${m.code} ${hx3(m.tx)}/${hx3(m.rx)} — LIVE`, "rx"); }
      }
      addLog(`Scan complete — ${liveCount}/${ALL.length} modules responding.`, liveCount ? "success" : "warn");
      if (firstLive && !sel) setSel(firstLive);
    } finally { setBusy(false); }
  }, [addLog, sel]);

  /* ── read current + original VIN for the selected module ───────────────── */
  const readVins = useCallback(async () => {
    const eng = engineRef.current, m = sel;
    if (!eng) { addLog("Connect first.", "error"); return; }
    if (!m) { addLog("Select a module first.", "error"); return; }
    setBusy(true); setMState(m.code, "busy");
    addLog(`── ${m.code}: reading VINs ──`, "header");
    try {
      const cur = await eng.uds(m.tx, m.rx, [0x22, 0xF1, 0x90]);
      let current = null;
      if (cur.ok && cur.d && cur.d[0] === 0x62) { current = vinFromReadResponse(cur.d, 0xF190); addLog(`Current VIN (F190): ${current}`, "rx"); }
      else { addLog(`F190 read failed: ${cur.raw || "no response"}`, "warn"); }

      const od = ORIG_DID[m.code] || 0x7B88;
      const orq = await eng.uds(m.tx, m.rx, [0x22, ...encodeDid(od)]);
      let original = null;
      if (orq.ok && orq.d && orq.d[0] === 0x62) { original = vinFromReadResponse(orq.d, od); addLog(`Original VIN (${od.toString(16).toUpperCase()}): ${original}`, "rx"); }
      else { addLog(`Original-VIN DID ${od.toString(16).toUpperCase()} not available`, "info"); }

      const reprogrammed = current && original && current !== original;
      if (reprogrammed) addLog(`⚠ current ≠ original — module was reprogrammed`, "warn");
      setVins(v => ({ ...v, [m.code]: { current, original, reprogrammed } }));
      setMState(m.code, current ? "live" : "idle");
      if (current && !vinInput) setVinInput(current);
    } finally { setBusy(false); }
  }, [addLog, sel, vinInput]);

  /* ── pre-write snapshot (anti-brick + resume breadcrumb) ───────────────── */
  const makeBackup = useCallback(async ({ uds, tx, rx, code, snapshotKind }) => {
    const snap = { code, tx, rx, kind: snapshotKind, dids: {} };
    let captured = 0;
    for (const did of vinWriteDids(code)) {
      const r = await uds(tx, rx, [0x22, ...encodeDid(did)]);
      const hex = (r.ok && r.d && r.d[0] === 0x62)
        ? Array.from(r.d).map(b => b.toString(16).padStart(2, "0")).join("") : null;
      snap.dids["0x" + did.toString(16).toUpperCase()] = hex;
      if (hex) captured++;
    }
    if (captured === 0) return { ok: false, key: null };   // refuse to proceed with an empty snapshot
    const key = `srtlab_snap_${code}_${Date.now()}`;
    try { localStorage.setItem(key, JSON.stringify(snap)); } catch {}
    addLog(`Snapshot saved (${snapshotKind}, ${captured} DIDs): ${key}`, "info");
    return { ok: true, key };
  }, [addLog]);

  /* ── write preflight: identity + voltage + master-rule GATES before confirm ─ */
  const preflightWrite = useCallback(async () => {
    const eng = engineRef.current, m = sel;
    if (!eng) { addLog("Connect first.", "error"); return; }
    if (!m) { addLog("Select a module first.", "error"); return; }
    const vin = vinInput.trim().toUpperCase();
    if (vin.length !== 17) { addLog("VIN must be exactly 17 characters.", "error"); return; }
    setBusy(true); setMState(m.code, "busy");
    addLog(`── ${m.code}: write preflight (identity · voltage · master-rule) ──`, "header");
    try {
      // 1. IDENTITY — confirm WHO we're talking to before any unlock. A wrong rx-id
      //    that answers with the wrong part number is caught by the operator here.
      let partNo = null, curVin = null;
      const pn = await eng.uds(m.tx, m.rx, [0x22, 0xF1, 0x8C], 2500);
      if (pn.ok && pn.d && pn.d[0] === 0x62) { partNo = asciiTail(pn.d, 3); addLog(`Part # (F18C): ${partNo}`, "rx"); }
      const cv = await eng.uds(m.tx, m.rx, [0x22, 0xF1, 0x90], 2500);
      if (cv.ok && cv.d && cv.d[0] === 0x62) { curVin = vinFromReadResponse(cv.d, 0xF190); addLog(`Current VIN (F190): ${curVin}`, "rx"); }
      if (!curVin && !partNo) {
        addLog(`✗ ${m.code} did not answer identity reads at ${hx3(m.tx)}/${hx3(m.rx)} — refusing write (wrong address or module asleep).`, "error");
        setMState(m.code, "idle"); return;
      }
      // 2. VOLTAGE — a brown-out mid-2E can brick the module.
      let voltage = null;
      try { voltage = await eng.readVoltage?.(); } catch {}
      if (typeof voltage === "number") {
        addLog(`Battery: ${voltage.toFixed(1)} V`, voltage < 12.0 ? "warn" : "info");
        if (voltage < 11.0) {
          addLog(`✗ Voltage ${voltage.toFixed(1)} V too low to program safely — put a charger/maintainer on it (need ≥ 12.0 V).`, "error");
          setMState(m.code, "live"); return;
        }
      }
      // 3. MASTER RULE — a virgin BCM (no SEC16) is NOT VIN master. Read BCM SEC16
      //    (DID 5320); if blank/refused, GATE the write and point to the RFHUB flow.
      if (m.code === "BCM") {
        const sec = await eng.uds(m.tx, m.rx, [0x22, 0x53, 0x20], 2500);
        const secOk = sec.ok && sec.d && sec.d[0] === 0x62 && Array.from(sec.d).slice(3).some(b => b !== 0x00 && b !== 0xFF);
        if (!secOk) {
          addLog(`✗ BCM has no SEC16 (virgin) — it is NOT VIN master. Make the RFHUB master: read RFHUB SEC16 and copy it to the BCM (BCM/RFHUB Immo tabs) BEFORE programming the BCM VIN.`, "error");
          setMState(m.code, "live"); return;
        }
        addLog(`BCM SEC16 present — BCM is VIN master.`, "info");
      }
      setPendingWrite({ code: m.code, vin, partNo, curVin, voltage });
    } finally { setBusy(false); }
  }, [sel, vinInput, addLog]);

  /* ── live VIN write (gated): programVin runs backup → unlock → 2E → verify ─ */
  const confirmWrite = useCallback(async () => {
    const pend = pendingWrite; setPendingWrite(null);
    const eng = engineRef.current, m = sel;
    if (!eng || !m || !pend) return;
    setBusy(true); setMState(m.code, "busy");
    addLog(`── ${m.code}: LIVE VIN WRITE → ${pend.vin} ──`, "header");
    try {
      const row = { tx: m.tx, rx: m.rx, code: m.code, vinDids: vinWriteDids(m.code) };
      const result = await programVin({ eng, row, vin: pend.vin, addLog, makeBackup });
      if (result.ok) {
        addLog(`✓ VIN WRITE VERIFIED — ${m.code} now ${result.afterVin}`, "success");
        setVins(v => ({ ...v, [m.code]: { current: result.afterVin, original: v[m.code]?.original || null, reprogrammed: true } }));
      } else {
        addLog(`✗ Write failed at '${result.reason}': ${result.errors.join("; ")}`, "error");
        if (result.reason === "unlock" && m.code === "BCM") {
          addLog("BCM would not unlock — if this BCM is virgin (no security), the RFHUB is VIN master. Read/write the RFHUB and copy its SEC16 in the BCM/RFHUB Immo tabs.", "hint");
        }
      }
      setMState(m.code, result.ok ? "live" : "idle");
    } catch (e) {
      addLog(`Write error: ${e?.message || e}`, "error");
      setMState(m.code, "idle");
    } finally { setBusy(false); }
  }, [pendingWrite, sel, addLog, makeBackup]);

  /* ── module box ────────────────────────────────────────────────────────── */
  const ModBox = ({ m, gw }) => {
    const st = stateRef.current[m.code] || "idle";
    const active = sel?.code === m.code;
    return (
      <button onClick={() => setSel(m)} style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
        padding: gw ? "10px 16px" : "7px 10px", borderRadius: 8, cursor: "pointer",
        minWidth: gw ? 150 : 92, textAlign: "left",
        border: `1px solid ${active ? S.purple : st === "live" ? "#0a4020" : S.border}`,
        background: active ? "#1a1230" : st === "live" ? "#06160c" : S.card,
        boxShadow: active ? `0 0 0 1px ${S.purple}` : "none", transition: "all .15s",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: STATE_COLOR[st], boxShadow: st === "live" ? `0 0 6px ${S.green}` : "none" }} />
          <span style={{ fontFamily: S.font, fontWeight: 900, fontSize: gw ? 16 : 12.5, letterSpacing: 0.5, color: active ? "#fff" : S.text }}>{m.code}</span>
          {gw && <span style={{ fontSize: 9, fontWeight: 800, color: S.purple, letterSpacing: 1.5, marginLeft: 4 }}>GATEWAY</span>}
        </div>
        <div style={{ fontFamily: S.mono, fontSize: 9.5, color: S.dim }}>{hx3(m.tx)} / {hx3(m.rx)}</div>
      </button>
    );
  };

  const logColor = { tx: "#4FC3F7", rx: "#69F0AE", error: "#FF5252", warn: S.yellow, success: "#69F0AE", info: "#9aa0aa", header: S.purple, hint: "#FF8F00" };
  const selVin = sel ? vins[sel.code] : null;

  return (
    <div style={{ background: S.bg, minHeight: "100%", padding: 16, fontFamily: S.font, color: S.text }}>
      {/* header / connection strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, padding: "12px 18px",
        borderRadius: 10, border: `1px solid ${S.border}`, background: "linear-gradient(135deg,#0D1B2A,#0A1628 60%,#1a0f2e)" }}>
        <div style={{ fontSize: 26 }}>🗺️</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Righteous',sans-serif", fontSize: 21, letterSpacing: 2 }}>LIVE TOPOLOGY</div>
          <div style={{ fontSize: 10, opacity: 0.6, letterSpacing: 3, fontWeight: 700 }}>FCA BUS MAP · LIVE READ · VIN PROGRAMMING</div>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 6,
          fontFamily: S.mono, fontSize: 12, fontWeight: 800,
          background: connected ? "#022" : "#1a1a1a", color: connected ? S.green : S.dim,
          border: `1px solid ${connected ? S.green : S.border}` }}>
          {connected ? "● CAN LIVE" : "○ OFFLINE"}
        </div>
        {!connected
          ? <Btn onClick={connect} disabled={busy} color={S.blue}>Connect</Btn>
          : <Btn onClick={scanAll} disabled={busy} color={S.green}>Scan All</Btn>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.55fr) minmax(320px,1fr)", gap: 14, alignItems: "start" }}>
        {/* ── LEFT: topology ─────────────────────────────────────────────── */}
        <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 6 }}>
            <ModBox m={GW} gw />
            <div style={{ width: 2, height: 18, background: `linear-gradient(${S.purple},${S.border})` }} />
          </div>
          {BUSES.map((b, i) => (
            <div key={i} style={{ marginBottom: 12, border: `1px solid ${S.border}`, borderRadius: 8, padding: "8px 10px", background: "#0d0d14" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontFamily: S.mono, fontSize: 10, fontWeight: 800, color: b.sp === "500K" ? S.blue : S.yellow, letterSpacing: 1 }}>{b.n}</span>
                <span style={{ fontSize: 9, color: S.dim }}>{b.seg} · {b.sp}</span>
                <div style={{ flex: 1, height: 1, background: S.border }} />
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {b.mods.map(m => <ModBox key={m.code} m={m} />)}
              </div>
            </div>
          ))}
        </div>

        {/* ── RIGHT: command + write ─────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* selected module */}
          <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: S.dim, letterSpacing: 1.5, marginBottom: 8 }}>SELECTED MODULE</div>
            {sel ? (
              <>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontFamily: S.font, fontWeight: 900, fontSize: 20 }}>{sel.code}</span>
                  <span style={{ fontFamily: S.mono, fontSize: 11, color: S.dim }}>{hx3(sel.tx)} / {hx3(sel.rx)}</span>
                </div>
                <div style={{ fontSize: 11, color: S.dim, marginBottom: 10 }}>{sel.name}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Btn onClick={readVins} disabled={!connected || busy} color={S.blue} small>Read VINs</Btn>
                </div>
                {selVin && (
                  <div style={{ marginTop: 10, fontFamily: S.mono, fontSize: 11, lineHeight: 1.7 }}>
                    <div>current : <span style={{ color: "#69F0AE" }}>{selVin.current || "—"}</span></div>
                    <div>original: <span style={{ color: "#9aa0aa" }}>{selVin.original || "—"}</span></div>
                    {selVin.reprogrammed && <div style={{ color: S.yellow }}>⚠ reprogrammed (current ≠ original)</div>}
                  </div>
                )}
              </>
            ) : <div style={{ fontSize: 12, color: S.dim }}>Click a module in the topology to select it.</div>}
          </div>

          {/* live VIN write */}
          <div style={{ background: S.card, border: `1px solid ${sel ? "#3a2a00" : S.border}`, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: S.yellow, letterSpacing: 1.5, marginBottom: 8 }}>LIVE VIN WRITE</div>
            {sel?.code === "BCM" && (
              <div style={{ fontSize: 10.5, color: "#FF8F00", background: "#1a0f00", border: "1px solid #3a2400", borderRadius: 6, padding: "7px 9px", marginBottom: 10 }}>
                Master rule: a <b>virgin BCM</b> (no SEC16) is <b>not</b> VIN master — the RFHUB is. If BCM unlock fails, write the RFHUB and copy its SEC16 first.
              </div>
            )}
            <input value={vinInput} onChange={e => setVinInput(e.target.value.toUpperCase())} placeholder="17-char VIN" maxLength={17}
              style={{ width: "100%", padding: "9px 11px", borderRadius: 6, border: `1px solid ${S.border}`, background: "#0A0A0F",
                color: "#fff", fontFamily: S.mono, fontSize: 14, fontWeight: 700, letterSpacing: 1, boxSizing: "border-box", marginBottom: 8 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: S.mono, fontSize: 10, color: vinInput.length === 17 ? S.green : S.dim }}>{vinInput.length}/17</span>
              <div style={{ flex: 1 }} />
              <Btn onClick={preflightWrite} disabled={!connected || busy || !sel || vinInput.trim().length !== 17} color={S.red}>Write VIN →</Btn>
            </div>
            <div style={{ fontSize: 9.5, color: S.dim, marginTop: 8 }}>
              Writes every VIN DID for {sel?.code || "the module"} ({(sel ? vinWriteDids(sel.code) : []).map(d => d.toString(16).toUpperCase()).join(", ") || "—"}); unlock → 2E → read-back verify.
            </div>
          </div>
        </div>
      </div>

      {/* ── log console ──────────────────────────────────────────────────── */}
      <div style={{ marginTop: 14, background: "#06060a", border: `1px solid ${S.border}`, borderRadius: 10, padding: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: S.dim, letterSpacing: 1.5, marginBottom: 6 }}>LOG</div>
        <div ref={logRef} style={{ maxHeight: 220, overflowY: "auto", fontFamily: S.mono, fontSize: 11.5, lineHeight: 1.65 }}>
          {log.length === 0 && <div style={{ color: S.dim }}>Connect, then Scan All to find live modules.</div>}
          {log.map((l, i) => (
            <div key={i} style={{ color: logColor[l.type] || "#9aa0aa" }}>
              <span style={{ color: "#454b54" }}>{l.ts} </span>{l.msg}
            </div>
          ))}
        </div>
      </div>

      {/* ── write confirm gate ───────────────────────────────────────────── */}
      {pendingWrite && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: S.card, border: `1px solid ${S.red}`, borderRadius: 12, padding: 24, maxWidth: 440, width: "90%" }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: S.red, marginBottom: 10 }}>⚠ Confirm live VIN write</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 8 }}>
              Write VIN to <b style={{ color: "#fff" }}>{pendingWrite.code}</b> ({hx3(sel?.tx)}/{hx3(sel?.rx)}) on the live bus:
            </div>
            {/* identity confirmation — the operator's last chance to catch a wrong target */}
            <div style={{ fontFamily: S.mono, fontSize: 11, lineHeight: 1.7, background: "#0A0A0F", border: `1px solid ${S.border}`, borderRadius: 6, padding: "8px 10px", marginBottom: 10 }}>
              <div>part #  : <span style={{ color: "#9aa0aa" }}>{pendingWrite.partNo || "—"}</span></div>
              <div>current : <span style={{ color: "#9aa0aa" }}>{pendingWrite.curVin || "—"}</span></div>
              <div>new VIN : <span style={{ color: "#69F0AE", fontWeight: 800 }}>{pendingWrite.vin}</span></div>
              <div>battery : <span style={{ color: typeof pendingWrite.voltage === "number" && pendingWrite.voltage < 12.0 ? S.yellow : "#9aa0aa" }}>{typeof pendingWrite.voltage === "number" ? pendingWrite.voltage.toFixed(1) + " V" : "n/a"}</span></div>
            </div>
            <div style={{ fontSize: 11, color: S.dim, marginBottom: 16 }}>
              Identity, voltage and master-rule gates passed. This snapshots the module, unlocks, issues 0x2E to every VIN DID and verifies each by read-back. It aborts on the first rejected write — nothing further is sent.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn onClick={() => setPendingWrite(null)} color="#333" small>Cancel</Btn>
              <Btn onClick={confirmWrite} color={S.red}>Write VIN now</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
