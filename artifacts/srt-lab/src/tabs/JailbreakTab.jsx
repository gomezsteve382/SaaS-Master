import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn, Tag } from "../lib/ui.jsx";
import { cda6, u32, unlockKey, unlockKeyBytes } from "../lib/algos.js";
import { createObdEngine, decodeDTC, decodeDTCStatus } from "../lib/obdEngine.js";
import {
  JAILBREAK_FEATURES, FEATURE_CATEGORY, CATEGORY_ORDER,
  PROFILES, MODULE_TARGETS, ROUTINE_PRESETS,
} from "../lib/jailbreakFeatures.js";
import { backupModule, CRITICAL_DIDS } from "../lib/backups.js";
import { logSession } from "../lib/paperTrail.js";

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

function JailbreakTab() {
  const [conn, setConn] = useState(false);
  const [busy, setBusy] = useState("");
  const [log, setLog] = useState([]);
  const [targetId, setTargetId] = useState("bcm-cda6");
  const [customTx, setCustomTx] = useState("750");
  const [customRx, setCustomRx] = useState("758");
  const [useCustom, setUseCustom] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [values, setValues] = useState({});      // { did: number[] }
  const [pending, setPending] = useState({});    // { featId: { feat, value } }
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState({});
  const [dtcs, setDtcs] = useState([]);
  const [routineRid, setRoutineRid] = useState(0x0312);
  const [routineCustom, setRoutineCustom] = useState("");
  const eng = useRef(null);
  const logEndRef = useRef(null);

  const addLog = useCallback((m, t = "info") => {
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    setLog(p => [...p.slice(-300), { t: ts, m, type: t }]);
  }, []);

  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
  }, [log]);

  // Auto-disconnect when the tab unmounts so the serial port and
  // reader/writer locks are released (otherwise the user must refresh
  // the page before reconnecting from another tab).
  useEffect(() => {
    return () => {
      if (eng.current) {
        try { eng.current.disconnect(); } catch {}
        eng.current = null;
      }
    };
  }, []);

  // Compute the active TX/RX pair from selector or custom override.
  const target = useMemo(() => {
    if (useCustom) {
      const tx = parseInt(customTx, 16) || 0;
      const rx = parseInt(customRx, 16) || 0;
      return { id: "custom", label: "Custom", tx, rx, needsUnlock: true, unlock: "cda6" };
    }
    return MODULE_TARGETS.find(m => m.id === targetId) || MODULE_TARGETS[0];
  }, [useCustom, customTx, customRx, targetId]);

  // Whenever target changes, the unlock state and feature values are no
  // longer valid for the new module.
  useEffect(() => {
    setUnlocked(false); setValues({}); setPending({}); setDtcs([]);
  }, [target.tx, target.rx]);

  const groups = useMemo(() => {
    const g = {};
    for (const cat of CATEGORY_ORDER) g[cat] = [];
    for (const f of JAILBREAK_FEATURES) {
      const cat = FEATURE_CATEGORY[f.id] || "Valet & Misc";
      if (!g[cat]) g[cat] = [];
      g[cat].push(f);
    }
    return Object.entries(g).filter(([, v]) => v.length > 0);
  }, []);

  const filtered = useMemo(() => {
    if (!search) return groups;
    const s = search.toLowerCase();
    return groups
      .map(([cat, feats]) => [cat, feats.filter(f =>
        f.id.toLowerCase().includes(s) ||
        f.n.toLowerCase().includes(s) ||
        f.d.toLowerCase().includes(s))])
      .filter(([, v]) => v.length > 0);
  }, [groups, search]);

  const isBcmTarget = target.id.startsWith("bcm-") || (useCustom && [0x750, 0x742, 0x7E0, 0x6B0].includes(target.tx));

  const connect = useCallback(async () => {
    if (eng.current) return;
    eng.current = createObdEngine(addLog);
    try {
      await eng.current.connect();
      setConn(true);
    } catch (e) {
      addLog("Connect failed: " + e.message, "error");
      eng.current = null;
    }
  }, [addLog]);

  const disconnect = useCallback(async () => {
    if (!eng.current) return;
    try { await eng.current.disconnect(); } catch (e) { addLog("Disconnect: " + e.message, "warn"); }
    eng.current = null;
    setConn(false); setUnlocked(false);
  }, [addLog]);

  const findBCM = useCallback(async () => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    setBusy("Finding BCM...");
    const cands = MODULE_TARGETS.filter(m => m.id.startsWith("bcm-"));
    for (const c of cands) {
      addLog("Trying " + c.label + " @ TX 0x" + hx(c.tx, 3), "info");
      const r = await eng.current.uds(c.tx, c.rx, [0x22, 0xF1, 0x90]);
      if (r.ok) {
        setTargetId(c.id); setUseCustom(false);
        addLog("BCM found @ " + c.label + " (TX 0x" + hx(c.tx, 3) + " / RX 0x" + hx(c.rx, 3) + ")", "rx");
        setBusy("");
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    addLog("BCM not found on any known address", "error");
    setBusy("");
  }, [addLog]);

  const unlock = useCallback(async () => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    setBusy("Unlocking " + target.label + "...");
    addLog("Entering extended session (10 03)...", "info");
    let r = await eng.current.uds(target.tx, target.rx, [0x10, 0x03]);
    if (!r.ok) { addLog("Session failed", "error"); setBusy(""); return; }
    addLog("Requesting seed (27 01)...", "info");
    r = await eng.current.uds(target.tx, target.rx, [0x27, 0x01]);
    if (!r.ok || !r.d) {
      addLog("Seed request failed: " + (r.err || "no data"), "error"); setBusy(""); return;
    }
    // Positive response framed as: 67 01 [seed_bytes...]. Engine has already
    // verified the SID; require the subfunction byte and at least 4 seed bytes.
    if (r.d.length < 6 || r.d[1] !== 0x01) {
      addLog("Bad seed response: " + Array.from(r.d).slice(0, 8).map(b => hx(b)).join(" "), "error");
      setBusy(""); return;
    }
    const sb = Array.from(r.d).slice(2);
    addLog("Seed (" + sb.length + "B): " + sb.map(b => hx(b)).join(" "), "info");
    const algoId = target.unlock || "cda6";
    const kb = unlockKeyBytes(algoId, sb);
    if (kb === null) { addLog("Unknown unlock algorithm: " + algoId, "error"); setBusy(""); return; }
    addLog(algoId.toUpperCase() + " key (" + kb.length + "B): " + kb.map(b => hx(b)).join(" "), "info");
    r = await eng.current.uds(target.tx, target.rx, [0x27, 0x02, ...kb]);
    if (r.ok) { setUnlocked(true); addLog(target.label + " UNLOCKED", "rx"); }
    else addLog("Key rejected — try a different module/algorithm", "error");
    setBusy("");
  }, [target, addLog]);

  const ecuReset = useCallback(async () => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    setBusy("Sending ECU reset...");
    addLog("ECU reset (11 01) → " + target.label, "info");
    const r = await eng.current.uds(target.tx, target.rx, [0x11, 0x01]);
    addLog(r.ok ? "Reset acknowledged" : "Reset failed", r.ok ? "rx" : "error");
    setBusy("");
  }, [target, addLog]);

  const readDTCs = useCallback(async () => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    setBusy("Reading DTCs...");
    await eng.current.uds(target.tx, target.rx, [0x10, 0x03]);
    addLog("ReadDTCByStatusMask (19 02 08) → " + target.label, "info");
    const r = await eng.current.uds(target.tx, target.rx, [0x19, 0x02, 0x08]);
    if (!r.ok || !r.d || r.d.length < 3) {
      addLog("DTC read failed: " + (r.err || "no data"), "error"); setBusy(""); setDtcs([]); return;
    }
    // Response: 59 02 <availMask> [dtc[3] status[1]] ...
    const data = Array.from(r.d);
    if (data[0] !== 0x59) { addLog("Unexpected response: " + data.map(b => hx(b)).join(" "), "warn"); setBusy(""); return; }
    const out = [];
    for (let i = 3; i + 4 <= data.length; i += 4) {
      const code = decodeDTC(data[i], data[i + 1], data[i + 2]);
      const status = decodeDTCStatus(data[i + 3]);
      out.push({ code, status, raw: hx(data[i]) + hx(data[i + 1]) + hx(data[i + 2]), statusByte: data[i + 3] });
    }
    setDtcs(out);
    addLog(out.length + " DTC(s) decoded", "rx");
    setBusy("");
  }, [target, addLog]);

  const clearDTCs = useCallback(async () => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    setBusy("Clearing DTCs...");
    addLog("ClearDiagnosticInformation (14 FF FF FF) → " + target.label, "info");
    const r = await eng.current.uds(target.tx, target.rx, [0x14, 0xFF, 0xFF, 0xFF]);
    addLog(r.ok ? "DTCs cleared" : "Clear failed: " + (r.err || ""), r.ok ? "rx" : "error");
    if (r.ok) setDtcs([]);
    setBusy("");
  }, [target, addLog]);

  const runRoutine = useCallback(async (rid) => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    setBusy("Running routine 0x" + hx(rid, 4) + "...");
    await eng.current.uds(target.tx, target.rx, [0x10, 0x03]);
    addLog("RoutineControl start (31 01 " + hx((rid >> 8) & 0xFF) + " " + hx(rid & 0xFF) + ") → " + target.label, "info");
    const r = await eng.current.uds(target.tx, target.rx, [0x31, 0x01, (rid >> 8) & 0xFF, rid & 0xFF]);
    addLog(r.ok ? "Routine accepted: " + (r.d ? Array.from(r.d).map(b => hx(b)).join(" ") : "") : "Routine failed: " + (r.err || ""), r.ok ? "rx" : "error");
    setBusy("");
  }, [target, addLog]);

  const readAllFeatures = useCallback(async () => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    if (!unlocked) { addLog("Unlock the BCM first", "error"); return; }
    setBusy("Reading features...");
    const dids = [...new Set(JAILBREAK_FEATURES.map(f => f.did))];
    const newVals = {};
    for (const did of dids) {
      addLog("Reading DID 0x" + hx(did, 4) + "...", "info");
      const r = await eng.current.uds(target.tx, target.rx, [0x22, (did >> 8) & 0xFF, did & 0xFF]);
      if (r.ok && r.d) {
        // Positive response: 62 DID_HI DID_LO [data...]
        const d = Array.from(r.d);
        const start = (d[0] === 0x62 && d.length > 3) ? 3 : 0;
        newVals[did] = d.slice(start);
        addLog("DID 0x" + hx(did, 4) + ": " + newVals[did].length + " bytes", "rx");
      } else {
        addLog("DID 0x" + hx(did, 4) + ": no response", "warn");
      }
    }
    setValues(newVals); setPending({});
    addLog("Read complete", "info");
    setBusy("");
  }, [target, unlocked, addLog]);

  const stageFeature = useCallback((feat, newVal) => {
    setPending(p => ({ ...p, [feat.id]: { feat, value: newVal } }));
  }, []);

  const writePending = useCallback(async () => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    if (!unlocked) { addLog("Unlock the BCM first", "error"); return; }
    const keys = Object.keys(pending);
    if (!keys.length) { addLog("No pending changes", "info"); return; }
    setBusy("Writing " + keys.length + " features...");
    // Auto-snapshot the target module before any 0x2E (Task #89).
    // Most jailbreak targets are BCM variants → CRITICAL_DIDS.BCM applies.
    // Custom / unknown targets fall back to BCM profile if it looks like a BCM
    // (isBcmTarget) so users still get their feature bytes saved.
    const backupType = CRITICAL_DIDS[target.id?.split("-")[0]?.toUpperCase()]
      ? target.id.split("-")[0].toUpperCase()
      : (isBcmTarget ? "BCM" : null);
    let backupKey = null, oldVin = null;
    if (backupType) {
      addLog("Snapshotting " + backupType + " before feature write...", "info");
      const b = await backupModule(eng.current.uds, target.tx, target.rx, backupType, addLog, hx);
      backupKey = b?.key || null;
      const vinDid = b?.dids?.[0xF190]; if (vinDid?.ascii) oldVin = vinDid.ascii.slice(-17);
    } else {
      addLog("No backup profile for " + target.label + " — feature write proceeds without snapshot", "warn");
    }
    // Group pending changes by DID.
    const byDid = {};
    for (const k of keys) {
      const p = pending[k];
      const d = p.feat.did;
      if (!byDid[d]) byDid[d] = [];
      byDid[d].push(p);
    }
    let writes = 0;
    for (const didStr of Object.keys(byDid)) {
      const did = Number(didStr);
      const orig = values[did];
      // SAFETY: never write a DID we haven't successfully read first —
      // the BCM expects an exact-length payload and zero-filling unknown
      // bytes can blow out unrelated options.
      if (!orig || !orig.length) {
        addLog("REFUSED DID 0x" + hx(did, 4) + ": run READ ALL FEATURES first (would overwrite unknown bytes).", "error");
        continue;
      }
      const cur = [...orig];
      let outOfRange = false;
      for (const p of byDid[did]) {
        const f = p.feat;
        if (f.off >= cur.length) {
          addLog("REFUSED " + f.id + ": offset 0x" + hx(f.off) + " past read length (" + cur.length + ")", "error");
          outOfRange = true; continue;
        }
        if (f.mask !== undefined) cur[f.off] = (cur[f.off] & ~f.mask) | (p.value & f.mask);
        else cur[f.off] = p.value & 0xFF;
      }
      if (outOfRange && cur.every((b, i) => b === orig[i])) continue;
      addLog("Writing DID 0x" + hx(did, 4) + " (" + cur.length + " bytes)...", "info");
      const r = await eng.current.uds(target.tx, target.rx,
        [0x2E, (did >> 8) & 0xFF, did & 0xFF, ...cur]);
      if (r.ok) {
        addLog("DID 0x" + hx(did, 4) + " written", "rx");
        setValues(v => ({ ...v, [did]: cur }));
        writes++;
      } else {
        addLog("DID 0x" + hx(did, 4) + " failed: " + (r.err || ""), "error");
      }
    }
    if (writes === 0) {
      addLog("No DIDs were written.", "warn");
      logSession({
        module: backupType || target.label,
        operation: "Jailbreak Feature Write",
        oldVin, newVin: oldVin,
        moduleAddr: { tx: target.tx, rx: target.rx },
        adapter: "ELM327/STN",
        success: false,
        backupKey,
        notes: "No DIDs written — see log for refusals.",
      });
      setBusy(""); return;
    }
    addLog("Sending ECU reset (11 01)...", "info");
    await eng.current.uds(target.tx, target.rx, [0x11, 0x01]);
    const featureSummary = keys.map(k => pending[k].feat.id + "=0x" + hx(pending[k].value));
    logSession({
      module: backupType || target.label,
      operation: "Jailbreak Feature Write",
      oldVin, newVin: oldVin,
      moduleAddr: { tx: target.tx, rx: target.rx },
      adapter: "ELM327/STN",
      algorithm: "CDA6",
      success: writes > 0,
      backupKey,
      notes: writes + " DID(s) written: " + featureSummary.join(", "),
    });
    addLog("📄 Session logged to paper trail", "info");
    setPending({});
    addLog("Write complete + reset", "info");
    setBusy("");
  }, [target, unlocked, pending, values, addLog, isBcmTarget]);

  const applyProfile = useCallback((key) => {
    const prof = PROFILES[key];
    if (!prof) return;
    const next = {};
    for (const [fid, val] of Object.entries(prof.changes)) {
      const feat = JAILBREAK_FEATURES.find(f => f.id === fid);
      if (feat) next[fid] = { feat, value: val };
    }
    setPending(next);
    addLog("Profile \"" + prof.label + "\" staged — " + Object.keys(next).length + " changes. Click WRITE to apply.", "info");
  }, [addLog]);

  const getCurrentValue = (feat) => {
    const raw = values[feat.did];
    if (!raw || feat.off >= raw.length) return null;
    const b = raw[feat.off];
    if (feat.mask !== undefined) return b & feat.mask;
    return b;
  };

  const pendingCount = Object.keys(pending).length;

  return <div>
    {/* HEADER */}
    <Card style={{ background: "linear-gradient(135deg,#1A0A0A 0%,#3D1515 40%,#8B0000 100%)", color: "#fff", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 4 }}>
        <div style={{ fontSize: 32 }}>💀</div>
        <div>
          <div style={{ fontFamily: "'Righteous'", fontSize: 24, letterSpacing: 2 }}>JAILBREAK OPTIONS</div>
          <div style={{ fontSize: 10, opacity: .75, letterSpacing: 3, fontWeight: 700 }}>SRT · DEMON · HELLCAT · REDEYE</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <Tag color={conn ? "#4CAF50" : "#888"}>{conn ? "● CONNECTED" : "○ OFFLINE"}</Tag>
          {conn && <Tag color={unlocked ? "#4CAF50" : "#FFA726"}>{unlocked ? "🔓 UNLOCKED" : "🔒 LOCKED"}</Tag>}
        </div>
      </div>
      <div style={{ fontSize: 11, opacity: .7, marginTop: 6 }}>
        Module UDS workshop — BCM hidden options · ADCM · DTCs · Routines · ECU reset
      </div>
    </Card>

    {/* CONNECT + TARGET PICKER */}
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        {!conn
          ? <Btn onClick={connect} color="#1976D2">CONNECT OBDLink</Btn>
          : <Btn onClick={disconnect} color="#666" outline>DISCONNECT</Btn>}
        <Btn onClick={findBCM} disabled={!conn || busy} color="#7B1FA2">AUTO-FIND BCM</Btn>
        {target.needsUnlock && <Btn onClick={unlock} disabled={!conn || busy} color="#D32F2F">
          {unlocked ? "RE-UNLOCK" : "UNLOCK"}
        </Btn>}
        {busy && <span style={{ fontSize: 11, color: C.tm, marginLeft: 8 }}>⏳ {busy}</span>}
      </div>
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.tm }}>TARGET:</span>
        <select
          value={useCustom ? "__custom" : targetId}
          onChange={e => {
            if (e.target.value === "__custom") setUseCustom(true);
            else { setUseCustom(false); setTargetId(e.target.value); }
          }}
          style={{ padding: "6px 10px", fontSize: 12, borderRadius: 6, border: `1px solid ${C.bd}`, background: "#fff" }}
        >
          {MODULE_TARGETS.map(m => <option key={m.id} value={m.id}>
            {m.label} — TX 0x{hx(m.tx, 3)} / RX 0x{hx(m.rx, 3)}
          </option>)}
          <option value="__custom">Custom TX/RX...</option>
        </select>
        {useCustom && <>
          <span style={{ fontSize: 11 }}>TX:</span>
          <input value={customTx} onChange={e => setCustomTx(e.target.value)} style={{ width: 60, padding: "4px 6px", fontSize: 12, borderRadius: 4, border: `1px solid ${C.bd}`, fontFamily: "monospace" }} placeholder="750" />
          <span style={{ fontSize: 11 }}>RX:</span>
          <input value={customRx} onChange={e => setCustomRx(e.target.value)} style={{ width: 60, padding: "4px 6px", fontSize: 12, borderRadius: 4, border: `1px solid ${C.bd}`, fontFamily: "monospace" }} placeholder="758" />
        </>}
        <span style={{ fontSize: 10, color: C.tm }}>
          Active: TX 0x{hx(target.tx, 3)} · RX 0x{hx(target.rx, 3)}
        </span>
      </div>
    </Card>

    {/* DIAGNOSTIC SERVICES ROW */}
    <Card style={{ marginBottom: 16, background: "#FFF8E1" }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "#5D4037", marginBottom: 10 }}>
        ⚙ DIAGNOSTIC SERVICES — works on whichever module is selected
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Btn onClick={readDTCs} disabled={!conn || busy} color="#F57C00">READ DTCs (19 02 08)</Btn>
        <Btn onClick={clearDTCs} disabled={!conn || busy} color="#D32F2F" outline>CLEAR DTCs (14 FF FF FF)</Btn>
        <span style={{ width: 1, height: 24, background: C.bd }} />
        <select
          value={routineRid}
          onChange={e => setRoutineRid(parseInt(e.target.value, 10))}
          style={{ padding: "6px 10px", fontSize: 12, borderRadius: 6, border: `1px solid ${C.bd}`, background: "#fff" }}
        >
          {ROUTINE_PRESETS.map(p => <option key={p.rid} value={p.rid}>{p.label}</option>)}
        </select>
        <Btn onClick={() => runRoutine(routineRid)} disabled={!conn || busy} color="#7B1FA2">RUN PRESET</Btn>
        <span style={{ width: 1, height: 24, background: C.bd }} />
        <input
          value={routineCustom}
          onChange={e => setRoutineCustom(e.target.value)}
          placeholder="hex RID e.g. 0312"
          style={{ width: 110, padding: "6px 8px", fontSize: 12, borderRadius: 4, border: `1px solid ${C.bd}`, fontFamily: "monospace" }}
        />
        <Btn
          onClick={() => {
            const v = parseInt(routineCustom, 16);
            if (!isNaN(v) && v >= 0 && v <= 0xFFFF) runRoutine(v);
            else addLog("Invalid routine ID", "error");
          }}
          disabled={!conn || busy} color="#7B1FA2" outline
        >RUN CUSTOM</Btn>
        <span style={{ width: 1, height: 24, background: C.bd }} />
        <Btn onClick={ecuReset} disabled={!conn || busy} color="#455A64" outline>ECU RESET (11 01)</Btn>
      </div>
      {dtcs.length > 0 && <div style={{ marginTop: 12, padding: 10, background: "#fff", borderRadius: 6, border: `1px solid ${C.bd}` }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, marginBottom: 6 }}>
          DTCs ({dtcs.length})
        </div>
        {dtcs.map((d, i) => <div key={i} style={{ display: "flex", gap: 12, fontSize: 12, padding: "3px 0", fontFamily: "monospace" }}>
          <span style={{ fontWeight: 800, color: d.code.startsWith("P") ? "#D32F2F" : d.code.startsWith("B") ? "#F57C00" : d.code.startsWith("C") ? "#7B1FA2" : "#1976D2", minWidth: 70 }}>{d.code}</span>
          <span style={{ color: C.tm }}>{d.status}</span>
          <span style={{ marginLeft: "auto", fontSize: 10, opacity: .5 }}>raw: {d.raw} / {hx(d.statusByte)}</span>
        </div>)}
      </div>}
    </Card>

    {/* BCM-ONLY: FEATURE EDITOR */}
    {isBcmTarget && <>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
          <Btn onClick={readAllFeatures} disabled={!conn || !unlocked || busy} color="#1976D2">READ ALL FEATURES</Btn>
          <Btn onClick={writePending} disabled={!conn || !unlocked || busy || !pendingCount} color="#388E3C">
            WRITE {pendingCount > 0 ? "(" + pendingCount + ")" : ""}
          </Btn>
          <span style={{ width: 1, height: 24, background: C.bd }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: C.tm }}>QUICK PROFILES:</span>
          {Object.entries(PROFILES).map(([k, p]) => (
            <Btn key={k} onClick={() => applyProfile(k)} disabled={busy} color="#8B0000" outline>{p.label.toUpperCase()}</Btn>
          ))}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search features..."
          style={{ width: "100%", padding: "8px 12px", fontSize: 12, borderRadius: 6, border: `1px solid ${C.bd}`, fontFamily: "'Nunito'" }}
        />
      </Card>

      {filtered.map(([cat, feats]) => {
        const isCol = collapsed[cat];
        return <Card key={cat} style={{ marginBottom: 12, padding: 0, overflow: "hidden" }}>
          <div
            onClick={() => setCollapsed(c => ({ ...c, [cat]: !c[cat] }))}
            style={{ padding: "12px 18px", background: "linear-gradient(90deg,#0F0F1A 0%,#1A1A2E 100%)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}
          >
            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1 }}>{cat.toUpperCase()}</span>
            <span style={{ fontSize: 10, opacity: .6 }}>({feats.length})</span>
            <span style={{ marginLeft: "auto", fontSize: 14 }}>{isCol ? "▸" : "▾"}</span>
          </div>
          {!isCol && <div style={{ padding: 14 }}>
            {feats.map(f => {
              const cur = getCurrentValue(f);
              const pendingChange = pending[f.id];
              const displayVal = pendingChange ? pendingChange.value : cur;
              const isPending = pendingChange != null;
              return <div key={f.id} style={{
                display: "grid", gridTemplateColumns: "1fr 220px", gap: 12,
                alignItems: "center", padding: "8px 10px",
                borderRadius: 6, marginBottom: 4,
                background: isPending ? "#FFF3E0" : "transparent",
                borderLeft: isPending ? "3px solid #F57C00" : "3px solid transparent",
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.tx }}>
                    {isPending && "⚡ "}{f.n}
                    <span style={{ fontSize: 9, fontWeight: 600, color: C.tm, marginLeft: 8, fontFamily: "monospace" }}>
                      DID 0x{hx(f.did, 4)} +0x{hx(f.off)}{f.mask !== undefined && " &0x" + hx(f.mask)}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: C.tm, marginTop: 2 }}>{f.d}</div>
                  {f.notes && <div style={{ fontSize: 9, color: "#F57C00", marginTop: 2, fontStyle: "italic" }}>⚠ {f.notes}</div>}
                </div>
                <select
                  value={displayVal != null ? displayVal : ""}
                  onChange={e => stageFeature(f, parseInt(e.target.value, 10))}
                  disabled={busy}
                  style={{ padding: "6px 8px", fontSize: 11, borderRadius: 4, border: `1px solid ${isPending ? "#F57C00" : C.bd}`, background: "#fff", fontFamily: "'Nunito'" }}
                >
                  {cur == null && <option value="">— not read —</option>}
                  {f.opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </div>;
            })}
          </div>}
        </Card>;
      })}
    </>}

    {/* UDS LOG */}
    <Card style={{ background: "#0A0A12", color: "#A8E6CF", padding: 14, marginTop: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 2, color: "#FF6D00", marginBottom: 8 }}>
        ▌ UDS LIVE LOG
      </div>
      <div ref={logEndRef} style={{ height: 220, overflowY: "auto", fontFamily: "monospace", fontSize: 11, lineHeight: 1.5 }}>
        {log.length === 0 && <div style={{ color: "#555" }}>No traffic yet. Connect an OBDLink adapter to begin.</div>}
        {log.map((l, i) => {
          const col = l.type === "tx" ? "#64B5F6" : l.type === "rx" ? "#A8E6CF" : l.type === "error" ? "#FF5252" : l.type === "warn" ? "#FFC107" : "#999";
          return <div key={i} style={{ color: col }}>
            <span style={{ opacity: .5 }}>[{l.t}]</span> {l.m}
          </div>;
        })}
      </div>
    </Card>
  </div>;
}

export default JailbreakTab;
