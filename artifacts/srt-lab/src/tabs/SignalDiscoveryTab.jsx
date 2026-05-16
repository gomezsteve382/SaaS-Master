/* ════════════════════════════════════════════════════════════════════════
 * SIGNAL DISCOVERY TAB — Task #625
 * ════════════════════════════════════════════════════════════════════════
 * Three-pane workbench that ports the TUMFTM "Holistic Approach for
 * Automated Reverse Engineering of UDS Data" methodology
 * (DOI 10.3390/wevj16070384, Apache-2.0):
 *
 *   1. SWEEP   — enumerate ECUs, fingerprint UDS services, and stream
 *                discovered DIDs to the API as they arrive (so a crash
 *                mid-sweep does not lose data and the operator can
 *                resume from the last cursor).
 *   2. RECORD  — drive the car, capture DID samples + ground-truth
 *                OBD-II PIDs into a time-series experiment with a live
 *                dual-line chart that overlays the raw DID byte stream
 *                on the ground-truth value.
 *   3. MATCH   — brute-force decoder candidates per DID, surface a
 *                top-N table with mini sparklines (decoded vs. truth),
 *                and export JSON or Markdown reports.
 * ════════════════════════════════════════════════════════════════════════ */

import React, { useState, useCallback, useRef, useEffect, useMemo, useContext } from "react";
import { Card, Btn } from "../lib/ui.jsx";
import { C } from "../lib/constants.js";
import { initAdapter } from "../lib/initAdapter.js";
import { decodeNRC } from "../lib/nrc.js";
import { getDidDescription } from "../lib/dids.js";
import { build } from "@workspace/uds";
import { MasterVinContext } from "../lib/masterVinContext.jsx";
import {
  sweepDidRange,
  probeEcu,
  discoverServices,
  planDidChunks,
  DISCOVERABLE_SERVICES,
} from "../lib/signalDiscovery/sweepEngine.js";
import {
  hexToBytes,
  bestCandidate,
  CANDIDATE_DECODERS,
  decodeBytes,
  pearson,
  linearRegression,
} from "../lib/signalDiscovery/decoder.js";

const ECU_PRESETS = [
  { label: "ECM",   tx: 0x7e0, rx: 0x7e8 },
  { label: "TCM",   tx: 0x7e1, rx: 0x7e9 },
  { label: "BCM",   tx: 0x750, rx: 0x758 },
  { label: "RFHUB", tx: 0x75f, rx: 0x767 },
  { label: "ABS",   tx: 0x760, rx: 0x768 },
  { label: "IPC",   tx: 0x740, rx: 0x748 },
  { label: "ADCM",  tx: 0x7a8, rx: 0x7b0 },
  { label: "EPS",   tx: 0x761, rx: 0x769 },
  { label: "RADIO", tx: 0x772, rx: 0x77a },
  { label: "HVAC",  tx: 0x751, rx: 0x759 },
  { label: "TIPM",  tx: 0x74c, rx: 0x76c },
  { label: "AMP",   tx: 0x7a0, rx: 0x7a8 },
  { label: "BSM",   tx: 0x770, rx: 0x778 },
];

const STANDARD_PIDS = [
  { pid: 0x05, label: "Coolant Temp",      units: "°C",   decode: (b) => b.length >= 1 ? b[0] - 40 : NaN },
  { pid: 0x0a, label: "Fuel Pressure",     units: "kPa",  decode: (b) => b.length >= 1 ? b[0] * 3 : NaN },
  { pid: 0x0b, label: "Intake MAP",        units: "kPa",  decode: (b) => b.length >= 1 ? b[0] : NaN },
  { pid: 0x0c, label: "Engine RPM",        units: "rpm",  decode: (b) => b.length >= 2 ? ((b[0] << 8) | b[1]) / 4 : NaN },
  { pid: 0x0d, label: "Vehicle Speed",     units: "km/h", decode: (b) => b.length >= 1 ? b[0] : NaN },
  { pid: 0x0e, label: "Timing Advance",    units: "°",    decode: (b) => b.length >= 1 ? b[0] / 2 - 64 : NaN },
  { pid: 0x0f, label: "Intake Air Temp",   units: "°C",   decode: (b) => b.length >= 1 ? b[0] - 40 : NaN },
  { pid: 0x10, label: "MAF Air Flow",      units: "g/s",  decode: (b) => b.length >= 2 ? ((b[0] << 8) | b[1]) / 100 : NaN },
  { pid: 0x11, label: "Throttle Position", units: "%",    decode: (b) => b.length >= 1 ? b[0] * 100 / 255 : NaN },
  { pid: 0x42, label: "Control Mod V",     units: "V",    decode: (b) => b.length >= 2 ? ((b[0] << 8) | b[1]) / 1000 : NaN },
  { pid: 0x46, label: "Ambient Air Temp",  units: "°C",   decode: (b) => b.length >= 1 ? b[0] - 40 : NaN },
];
const PID_BY_ID = Object.fromEntries(STANDARD_PIDS.map((p) => [p.pid, p]));
const DECODER_BY_NAME = Object.fromEntries(CANDIDATE_DECODERS.map((d) => [d.name, d]));

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");
const parseAddr = (s) => parseInt(String(s).replace(/^0x/i, ""), 16);
const fmtMs = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};

/* ─────────────────────────  shared visual bits  ───────────────────── */

function SubTab({ active, onClick, children, icon }) {
  return (
    <button onClick={onClick} style={{
      padding: "10px 18px", border: "none",
      background: active ? C.bk : "transparent",
      color: active ? C.sr : C.ts,
      cursor: "pointer", fontFamily: "'Nunito'", fontWeight: 800, fontSize: 11,
      letterSpacing: 1.4, borderRadius: "8px 8px 0 0",
    }}>
      <span style={{ marginRight: 6 }}>{icon}</span>{children}
    </button>
  );
}

function StatLine({ k, v, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontFamily: "'JetBrains Mono'", fontSize: 12 }}>
      <span style={{ color: C.ts }}>{k}</span>
      <span style={{ color: color || C.tx, fontWeight: 700 }}>{v}</span>
    </div>
  );
}

/** Inline SVG line chart. One or two series, auto-scaled. */
function MiniLineChart({ series, width = 600, height = 180, stroke = [C.a3, C.sr] }) {
  const all = useMemo(() => {
    const s = series.filter((ser) => ser.values && ser.values.length > 1);
    if (s.length === 0) return null;
    const xs = s.flatMap((ser) => ser.values.map((p) => p.x));
    const ys = s.flatMap((ser) => ser.values.map((p) => p.y));
    return {
      s, xMin: Math.min(...xs), xMax: Math.max(...xs),
      yMin: Math.min(...ys), yMax: Math.max(...ys),
    };
  }, [series]);
  if (!all || all.xMax === all.xMin || all.yMax === all.yMin) {
    return <div style={{ width, height, display: "grid", placeItems: "center", color: C.tm, fontSize: 11, border: `1px dashed ${C.bd}`, borderRadius: 6 }}>not enough data yet</div>;
  }
  const pad = 24;
  const xPx = (x) => pad + ((x - all.xMin) / (all.xMax - all.xMin)) * (width - pad * 2);
  const yPx = (y) => height - pad - ((y - all.yMin) / (all.yMax - all.yMin)) * (height - pad * 2);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <rect x={0} y={0} width={width} height={height} fill={C.c2} rx={6} />
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke={C.bd} />
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke={C.bd} />
      {all.s.map((ser, i) => (
        <polyline key={i} fill="none" stroke={ser.color || stroke[i % stroke.length]} strokeWidth={1.5}
          points={ser.values.map((p) => `${xPx(p.x)},${yPx(p.y)}`).join(" ")} />
      ))}
      {all.s.map((ser, i) => (
        <text key={`l${i}`} x={pad + 6} y={pad + 12 + i * 14}
          fill={ser.color || stroke[i % stroke.length]} fontFamily="'JetBrains Mono'" fontSize={10}>
          {ser.label}
        </text>
      ))}
    </svg>
  );
}

/** Tiny inline sparkline (2 overlaid series). */
function Sparkline({ a, b, width = 110, height = 28 }) {
  if (!a || a.length < 2) return <span style={{ color: C.tm, fontSize: 10 }}>—</span>;
  const norm = (arr) => {
    const min = Math.min(...arr), max = Math.max(...arr);
    if (max === min) return arr.map(() => height / 2);
    return arr.map((v) => height - 2 - ((v - min) / (max - min)) * (height - 4));
  };
  const ax = a.map((_, i) => (i / (a.length - 1)) * (width - 2) + 1);
  const ay = norm(a);
  const ap = ax.map((x, i) => `${x},${ay[i]}`).join(" ");
  let bp = null;
  if (b && b.length === a.length) {
    const by = norm(b);
    bp = ax.map((x, i) => `${x},${by[i]}`).join(" ");
  }
  return (
    <svg width={width} height={height}>
      <polyline points={ap} fill="none" stroke={C.a3} strokeWidth={1} />
      {bp && <polyline points={bp} fill="none" stroke={C.sr} strokeWidth={1} opacity={0.85} />}
    </svg>
  );
}

/* ────────────────────────────  SWEEP  ────────────────────────────── */

function SweepPane({ vin, addLog }) {
  const [conn, setConn] = useState(false);
  const eng = useRef(null);
  const abortRef = useRef(null);
  const pauseRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ecus, setEcus] = useState([]);
  const [didsByEcu, setDidsByEcu] = useState({});
  const [servicesByEcu, setServicesByEcu] = useState({});
  const [progress, setProgress] = useState({ done: 0, total: 0, etaMs: null });
  const [didStart, setDidStart] = useState("F100");
  const [didEnd, setDidEnd] = useState("F1FF");
  const [chunkSize, setChunkSize] = useState(0x100);
  const [fullRange, setFullRange] = useState(false);
  const [delayMs, setDelayMs] = useState(25);
  const [sweepId, setSweepId] = useState(null);
  const [scanRange, setScanRange] = useState({ start: 0x700, end: 0x7ff });
  const cursorByEcu = useRef({}); // resume cursor per `${tx}:${rx}`
  const [resumable, setResumable] = useState(null); // {sweep, ecus, dids} loaded from persistence

  /**
   * On mount (and whenever VIN changes) ask the API for the most
   * recent unfinished sweep for this VIN and pre-load its state. This
   * is what makes resume actually crash-safe end-to-end: even if the
   * browser was closed mid-sweep, the cursor is recovered from the
   * server, not just from in-memory React refs.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = `/api/signal-discovery/sweeps${vin ? `?vin=${encodeURIComponent(vin)}` : ""}`;
        const r = await fetch(url);
        const j = await r.json();
        const open = (j?.sweeps || []).find((s) => s.status === "running" || s.status === "pending");
        if (!open || cancelled) return;
        const detail = await fetch(`/api/signal-discovery/sweeps/${open.id}`).then((r) => r.json());
        if (cancelled || !detail?.sweep) return;
        // Hydrate UI state from persisted detail.
        const ecuRows = (detail.ecus || []).map((e) => ({ tx: e.tx, rx: e.rx, label: e.label }));
        const didMap = {};
        for (const d of detail.dids || []) {
          const k = `${d.tx}:${d.rx}`;
          (didMap[k] = didMap[k] || []).push(d);
        }
        // Cursor is stored as { tx, did } on the sweep row.
        const cursor = detail.sweep.cursor || {};
        if (cursor && cursor.tx != null && cursor.did != null) {
          // The next DID to attempt is one past the last persisted one.
          const next = Math.min(0xffff, cursor.did + 1);
          cursorByEcu.current[`${cursor.tx}:${cursor.tx + 8}`] = next;
        }
        setSweepId(open.id);
        setEcus(ecuRows);
        setDidsByEcu(didMap);
        setResumable({
          sweep: detail.sweep,
          ecuCount: ecuRows.length,
          didCount: Object.values(didMap).reduce((s, a) => s + a.length, 0),
          cursor,
        });
        addLog(`Resumed sweep ${open.id.slice(0, 8)} (${ecuRows.length} ECUs, ${Object.values(didMap).reduce((s, a) => s + a.length, 0)} DIDs)`, "info");
      } catch (err) { /* non-fatal — start a new sweep */ }
    })();
    return () => { cancelled = true; };
  }, [vin, addLog]);

  const connect = useCallback(async () => {
    const e = await initAdapter(addLog, hx);
    if (e) { eng.current = e; setConn(true); addLog("Adapter ready", "info"); }
  }, [addLog]);

  const ensureSweep = useCallback(async (label) => {
    if (sweepId) return sweepId;
    try {
      const r = await fetch("/api/signal-discovery/sweeps", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vin: vin || null, label }),
      });
      const j = await r.json();
      if (j?.id) { setSweepId(j.id); addLog(`Sweep ${j.id.slice(0, 8)} opened`, "info"); return j.id; }
    } catch (err) { addLog("Sweep create failed: " + err.message, "error"); }
    return null;
  }, [vin, sweepId, addLog]);

  const persistEcu = useCallback(async (id, ecuRow) => {
    try {
      await fetch(`/api/signal-discovery/sweeps/${id}/ecus`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ecus: [ecuRow] }),
      });
    } catch (err) { addLog("Persist ECU failed: " + err.message, "warn"); }
  }, [addLog]);

  const persistDid = useCallback(async (id, didRow) => {
    try {
      await fetch(`/api/signal-discovery/sweeps/${id}/dids`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dids: [didRow] }),
      });
    } catch (err) { /* swallow per-DID; the next checkpoint covers it */ }
  }, []);

  const updateCursor = useCallback(async (id, tx, cursor) => {
    try {
      await fetch(`/api/signal-discovery/sweeps/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "running", cursor: { tx, did: cursor } }),
      });
    } catch { /* non-fatal */ }
  }, []);

  const probeBus = useCallback(async () => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    setBusy(true); setEcus([]); setDidsByEcu({}); setServicesByEcu({});
    cursorByEcu.current = {};
    const id = await ensureSweep("Probe " + new Date().toLocaleTimeString());
    const found = [];
    abortRef.current = new AbortController();
    const t0 = Date.now();
    for (let tx = scanRange.start; tx <= scanRange.end; tx++) {
      if (abortRef.current.signal.aborted) break;
      const rx = tx + 8;
      const alive = await probeEcu(eng.current, tx, rx, { timeoutMs: 60 });
      if (alive) {
        const row = { tx, rx, label: ECU_PRESETS.find((e) => e.tx === tx)?.label || null };
        found.push(row);
        addLog(`ECU @ TX 0x${hx(tx, 3)} RX 0x${hx(rx, 3)}`, "rx");
        setEcus([...found]);
        if (id) await persistEcu(id, row); // stream as we discover
      }
      if ((tx & 0x0f) === 0) {
        const done = tx - scanRange.start;
        const total = scanRange.end - scanRange.start;
        const elapsed = Date.now() - t0;
        const rate = done / Math.max(1, elapsed);
        const etaMs = rate > 0 ? Math.round((total - done) / rate) : null;
        setProgress({ done, total, etaMs });
      }
    }
    setProgress({ done: 0, total: 0, etaMs: null });
    setBusy(false);
    abortRef.current = null;
    addLog(`Probe done — ${found.length} live ECUs`, "info");
  }, [addLog, ensureSweep, scanRange, persistEcu]);

  const probeServices = useCallback(async (tx, rx) => {
    if (!eng.current) return;
    addLog(`Service discovery on 0x${hx(tx, 3)}`, "info");
    const out = [];
    for await (const svc of discoverServices(eng.current, tx, rx)) {
      out.push(svc);
      setServicesByEcu((prev) => ({ ...prev, [`${tx}:${rx}`]: [...out] }));
    }
    if (sweepId) {
      try {
        const supported = out
          .filter((s) => s.status === "positive" || s.status === "supported-nrc")
          .map((s) => `0x${hx(s.sid)}=${s.name}`);
        await fetch(`/api/signal-discovery/sweeps/${sweepId}/ecus`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ecus: [{ tx, rx, sessions: { services: supported } }] }),
        });
      } catch (err) { addLog("Persist services failed: " + err.message, "warn"); }
    }
  }, [addLog, sweepId]);

  const sweepEcuDids = useCallback(async (tx, rx) => {
    if (!eng.current) return;
    setBusy(true);
    abortRef.current = new AbortController();
    pauseRef.current = false; setPaused(false);
    const id = await ensureSweep(`DID sweep ${hx(tx, 3)}`);
    // Build the chunk plan once, honoring the user's range / full-range toggle.
    const chunks = planDidChunks({
      includeStandardBlock: true,
      fullRange,
      start: parseInt(didStart, 16) || 0xf100,
      end: parseInt(didEnd, 16) || 0xf1ff,
      chunkSize,
    });
    const cursorKey = `${tx}:${rx}`;
    const persistedCursor = cursorByEcu.current[cursorKey] || null;
    const found = didsByEcu[cursorKey] ? [...didsByEcu[cursorKey]] : [];
    addLog(`Plan: ${chunks.length} chunk(s)${persistedCursor ? ` · resume @0x${hx(persistedCursor, 4)}` : ""}`, "info");
    let lastCheckpointAt = 0;
    try {
      for (let ci = 0; ci < chunks.length; ci++) {
        if (abortRef.current.signal.aborted) break;
        const ch = chunks[ci];
        // If a persisted cursor falls inside this chunk, resume from it
        // and clear once consumed; otherwise start at the chunk's start.
        let cursorStart = null;
        if (persistedCursor != null && persistedCursor >= ch.start && persistedCursor <= ch.end) {
          cursorStart = persistedCursor;
        } else if (persistedCursor != null && persistedCursor > ch.end) {
          continue; // chunk already covered before the crash
        }
        addLog(`Chunk ${ci + 1}/${chunks.length}: ${ch.label}${cursorStart ? ` (resume @0x${hx(cursorStart, 4)})` : ""}`, "info");
        for await (const ev of sweepDidRange(eng.current, tx, rx, {
          start: ch.start, end: ch.end, delayMs,
          signal: abortRef.current.signal,
          pauseRef,
          cursorStart,
        })) {
          if (ev.kind === "did") {
            const row = { ...ev, tx, rx, session: 0x01 };
            delete row.kind; delete row.cursor;
            found.push(row);
            setDidsByEcu((prev) => ({ ...prev, [cursorKey]: [...found] }));
            if (ev.nrc) addLog(`DID 0x${hx(ev.did, 4)} NRC ${decodeNRC(ev.nrc)}`, "warn");
            else addLog(`DID 0x${hx(ev.did, 4)} → ${ev.length}B  ${ev.sample}`, "rx");
            if (id) await persistDid(id, row);
            cursorByEcu.current[cursorKey] = ev.cursor;
          } else if (ev.kind === "progress") {
            setProgress({ done: ev.done, total: ev.total, etaMs: ev.etaMs });
            cursorByEcu.current[cursorKey] = ev.cursor;
            const now = Date.now();
            if (id && now - lastCheckpointAt > 2000) {
              lastCheckpointAt = now;
              updateCursor(id, tx, ev.cursor);
            }
          }
        }
      }
      // Plan finished — clear resume cursor.
      delete cursorByEcu.current[cursorKey];
      if (id) updateCursor(id, tx, chunks[chunks.length - 1]?.end ?? 0xffff);
    } finally {
      setBusy(false);
      setProgress({ done: 0, total: 0, etaMs: null });
      abortRef.current = null;
      setPaused(false); pauseRef.current = false;
    }
  }, [addLog, ensureSweep, didStart, didEnd, delayMs, didsByEcu, persistDid, updateCursor, fullRange, chunkSize]);

  const cancel = () => { if (abortRef.current) abortRef.current.abort(); };
  const togglePause = () => { pauseRef.current = !pauseRef.current; setPaused(pauseRef.current); };

  const totalDids = Object.values(didsByEcu).reduce((s, a) => s + a.length, 0);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <Card>
        <div style={{ fontFamily: "'Righteous'", fontSize: 18, color: C.sr, marginBottom: 12 }}>BUS PROBE</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <Btn onClick={connect} disabled={conn} color={C.a3}>{conn ? "✓ CONNECTED" : "CONNECT"}</Btn>
          <Btn onClick={probeBus} disabled={!conn || busy}>SCAN 0x{hx(scanRange.start, 3)}–0x{hx(scanRange.end, 3)}</Btn>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12, fontSize: 11 }}>
          <span style={{ color: C.ts }}>Range:</span>
          <input value={"0x" + hx(scanRange.start, 3)} onChange={(e) => setScanRange({ ...scanRange, start: parseAddr(e.target.value) || 0x700 })}
            style={{ width: 70, padding: "4px 6px", fontFamily: "'JetBrains Mono'", fontSize: 11, border: `1px solid ${C.bd}`, borderRadius: 4 }} />
          <span>→</span>
          <input value={"0x" + hx(scanRange.end, 3)} onChange={(e) => setScanRange({ ...scanRange, end: parseAddr(e.target.value) || 0x7ff })}
            style={{ width: 70, padding: "4px 6px", fontFamily: "'JetBrains Mono'", fontSize: 11, border: `1px solid ${C.bd}`, borderRadius: 4 }} />
        </div>
        {progress.total > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.ts, marginBottom: 4 }}>
              <span>{progress.done}/{progress.total}</span>
              <span>ETA {fmtMs(progress.etaMs)}</span>
            </div>
            <div style={{ height: 4, background: C.bd, borderRadius: 2 }}>
              <div style={{ height: "100%", width: `${(progress.done / progress.total) * 100}%`, background: C.sr, borderRadius: 2 }} />
            </div>
          </div>
        )}
        <StatLine k="Live ECUs" v={ecus.length} color={C.gn} />
        <StatLine k="Total DIDs" v={totalDids} color={C.a3} />
        {sweepId && <StatLine k="Sweep ID" v={sweepId.slice(0, 8)} />}
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontFamily: "'Righteous'", fontSize: 18, color: C.sr }}>DID SWEEP</div>
          <div style={{ display: "flex", gap: 6 }}>
            {busy && <Btn onClick={togglePause} color={C.wn} outline>{paused ? "▶ RESUME" : "❚❚ PAUSE"}</Btn>}
            {busy && <Btn onClick={cancel} color={C.er} outline>■ CANCEL</Btn>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8, fontSize: 11 }}>
          <span style={{ color: C.ts }}>Range:</span>
          <input value={didStart} onChange={(e) => setDidStart(e.target.value)} placeholder="F100" disabled={fullRange}
            style={{ width: 64, padding: "4px 6px", fontFamily: "'JetBrains Mono'", fontSize: 11, border: `1px solid ${C.bd}`, borderRadius: 4, opacity: fullRange ? 0.5 : 1 }} />
          <span>→</span>
          <input value={didEnd} onChange={(e) => setDidEnd(e.target.value)} placeholder="F1FF" disabled={fullRange}
            style={{ width: 64, padding: "4px 6px", fontFamily: "'JetBrains Mono'", fontSize: 11, border: `1px solid ${C.bd}`, borderRadius: 4, opacity: fullRange ? 0.5 : 1 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer", color: fullRange ? C.sr : C.ts, fontWeight: fullRange ? 700 : 400 }}>
            <input type="checkbox" checked={fullRange} onChange={(e) => setFullRange(e.target.checked)} />
            Full 0x0100–0xFFFF
          </label>
          <span style={{ color: C.ts }}>chunk:</span>
          <input type="number" value={chunkSize} onChange={(e) => setChunkSize(Math.max(0x10, Math.min(0x1000, +e.target.value || 0x100)))} disabled={!fullRange}
            style={{ width: 60, padding: "4px 6px", fontSize: 11, border: `1px solid ${C.bd}`, borderRadius: 4, opacity: fullRange ? 1 : 0.5 }} />
          <span style={{ color: C.ts, marginLeft: 8 }}>delay:</span>
          <input type="number" value={delayMs} onChange={(e) => setDelayMs(+e.target.value)}
            style={{ width: 50, padding: "4px 6px", fontSize: 11, border: `1px solid ${C.bd}`, borderRadius: 4 }} />
          <span style={{ color: C.tm, fontSize: 10 }}>ms</span>
        </div>
        {resumable && (
          <div style={{ marginBottom: 8, padding: 6, background: C.wn + "15", border: `1px solid ${C.wn}`, borderRadius: 4, fontSize: 10, color: C.ts, fontFamily: "'JetBrains Mono'" }}>
            ↻ Resumed sweep {resumable.sweep.id.slice(0, 8)} · {resumable.ecuCount} ECUs · {resumable.didCount} DIDs
            {resumable.cursor?.tx != null && ` · cursor TX 0x${hx(resumable.cursor.tx, 3)} DID 0x${hx(resumable.cursor.did, 4)}`}
          </div>
        )}
        <div style={{ maxHeight: 360, overflowY: "auto", border: `1px solid ${C.bd}`, borderRadius: 8, padding: 8 }}>
          {ecus.length === 0 && <div style={{ color: C.tm, fontSize: 11, textAlign: "center", padding: 20 }}>Run a bus probe first</div>}
          {ecus.map((e) => {
            const key = `${e.tx}:${e.rx}`;
            const found = didsByEcu[key] || [];
            const svcs = servicesByEcu[key];
            const cursor = cursorByEcu.current[key];
            return (
              <div key={key} style={{ marginBottom: 8, padding: 8, background: C.c2, borderRadius: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                  <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 12, fontWeight: 700 }}>
                    {e.label || "?"} · 0x{hx(e.tx, 3)} → 0x{hx(e.rx, 3)}
                    {cursor && <span style={{ color: C.wn, marginLeft: 8 }}>↻ 0x{hx(cursor, 4)}</span>}
                  </span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <Btn onClick={() => probeServices(e.tx, e.rx)} disabled={busy} color={C.a4} outline>SVCS</Btn>
                    <Btn onClick={() => sweepEcuDids(e.tx, e.rx)} disabled={busy} color={C.a3} outline>
                      {cursor ? "RESUME" : "SWEEP"} {found.length > 0 ? `(${found.length})` : ""}
                    </Btn>
                  </div>
                </div>
                {svcs && (
                  <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {svcs.map((s) => {
                      const col = s.status === "positive" ? C.gn
                        : s.status === "supported-nrc" ? C.a3
                        : s.status === "unsupported" ? C.tm : C.wn;
                      return (
                        <span key={s.sid} title={`${s.name}: ${s.status}${s.nrc != null ? ` (NRC 0x${hx(s.nrc)})` : ""}`}
                          style={{ padding: "2px 5px", fontSize: 9, fontFamily: "'JetBrains Mono'",
                            border: `1px solid ${col}`, color: col, borderRadius: 3 }}>
                          0x{hx(s.sid)}
                        </span>
                      );
                    })}
                  </div>
                )}
                {found.length > 0 && (
                  <div style={{ marginTop: 6, fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.ts, maxHeight: 80, overflowY: "auto" }}>
                    {found.slice(0, 8).map((d, i) => (
                      <div key={`${d.did}-${i}`}>0x{hx(d.did, 4)} {d.nrc ? `NRC ${decodeNRC(d.nrc)}` : `${d.length}B ${d.sample?.slice(0, 30)}`}</div>
                    ))}
                    {found.length > 8 && <div style={{ color: C.tm }}>… +{found.length - 8} more</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

/* ────────────────────────────  RECORD  ───────────────────────────── */

function RecordPane({ vin, addLog }) {
  const [conn, setConn] = useState(false);
  const eng = useRef(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const runRef = useRef(false);
  const [tx, setTx] = useState("0x7E0");
  const [rx, setRx] = useState("0x7E8");
  const [didListStr, setDidListStr] = useState("F40C, F40D, F411");
  const [pids, setPids] = useState([0x05, 0x0c, 0x0d]);
  const [pollMs, setPollMs] = useState(250);
  const [name, setName] = useState("");
  const [experimentId, setExperimentId] = useState(null);
  const [samples, setSamples] = useState([]);
  const [chartDid, setChartDid] = useState(null);
  const [chartPid, setChartPid] = useState(null);
  const startRef = useRef(0);

  const didList = useMemo(
    () => didListStr.split(/[,\s]+/).map((s) => parseInt(s.replace(/^0x/i, ""), 16)).filter((n) => Number.isFinite(n)),
    [didListStr],
  );

  useEffect(() => {
    if (!chartDid && didList.length > 0) setChartDid(didList[0]);
    if (!chartPid && pids.length > 0) setChartPid(pids[0]);
  }, [didList, pids, chartDid, chartPid]);

  const connect = useCallback(async () => {
    const e = await initAdapter(addLog, hx);
    if (e) { eng.current = e; setConn(true); }
  }, [addLog]);

  const startExperiment = useCallback(async () => {
    if (!eng.current) { addLog("Connect first", "error"); return; }
    if (didList.length === 0) { addLog("Add at least one DID", "error"); return; }
    if (pids.length === 0) { addLog("Pick at least one PID", "error"); return; }
    setBusy(true);
    let id = experimentId;
    if (!id) {
      try {
        const r = await fetch("/api/signal-discovery/experiments", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vin: vin || null,
            name: name || `Run ${new Date().toLocaleTimeString()}`,
            targetTx: parseAddr(tx), targetRx: parseAddr(rx),
            didList, pidList: pids, pollIntervalMs: pollMs,
          }),
        });
        const j = await r.json();
        if (!j?.id) throw new Error(j?.error || "create failed");
        id = j.id; setExperimentId(id);
        await fetch(`/api/signal-discovery/experiments/${id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "running", startedAt: new Date().toISOString() }),
        });
      } catch (err) { addLog("Experiment create failed: " + err.message, "error"); setBusy(false); return; }
    }
    addLog(`Recording experiment ${id.slice(0, 8)}`, "info");
    runRef.current = true; setRunning(true);
    startRef.current = Date.now();
    setSamples([]); setBusy(false);

    const txN = parseAddr(tx), rxN = parseAddr(rx);
    const buffer = [];
    const flush = async () => {
      if (buffer.length === 0) return;
      const batch = buffer.splice(0);
      try {
        await fetch(`/api/signal-discovery/experiments/${id}/samples`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ samples: batch }),
        });
      } catch (err) { addLog("Sample flush failed: " + err.message, "warn"); }
    };

    while (runRef.current) {
      const t = Date.now() - startRef.current;
      const didValues = {};
      for (const did of didList) {
        const r = await eng.current.uds(txN, rxN, build.readDataByIdentifier({ dids: [did] }));
        if (r?.ok && r.d?.[0] === 0x62) {
          didValues[`0x${hx(did, 4)}`] = Array.from(r.d.slice(3)).map((b) => hx(b)).join("");
        }
      }
      const pidValues = {};
      for (const pid of pids) {
        const r = await eng.current.uds(0x7df, 0x7e8, [0x01, pid], { timeoutMs: 200 });
        if (r?.ok && r.d?.[0] === 0x41 && r.d[1] === pid) {
          const decoder = PID_BY_ID[pid];
          const bytes = Array.from(r.d.slice(2));
          const v = decoder ? decoder.decode(bytes) : bytes[0];
          if (Number.isFinite(v)) pidValues[`0x${hx(pid, 2)}`] = v;
        }
      }
      const sample = { tMs: t, didValues, pidValues };
      buffer.push(sample);
      setSamples((prev) => [...prev.slice(-500), sample]);
      if (buffer.length >= 10) await flush();
      await new Promise((r) => setTimeout(r, pollMs));
    }
    await flush();
    if (id) {
      try {
        await fetch(`/api/signal-discovery/experiments/${id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "complete", finishedAt: new Date().toISOString() }),
        });
      } catch { /* non-fatal */ }
    }
    setRunning(false);
  }, [addLog, vin, name, didList, pids, tx, rx, pollMs, experimentId]);

  const stop = () => { runRef.current = false; };

  // Build chart series from in-memory samples for the selected DID/PID.
  const chartSeries = useMemo(() => {
    if (!chartDid || !chartPid || samples.length < 2) return [];
    const didKey = `0x${hx(chartDid, 4)}`;
    const pidKey = `0x${hx(chartPid)}`;
    const didPoints = [];
    const pidPoints = [];
    for (const s of samples) {
      const b = hexToBytes(s.didValues?.[didKey] || "");
      if (b.length > 0) didPoints.push({ x: s.tMs, y: b[0] });
      const v = s.pidValues?.[pidKey];
      if (Number.isFinite(v)) pidPoints.push({ x: s.tMs, y: v });
    }
    return [
      { label: `DID ${didKey} byte[0]`, values: didPoints, color: C.a3 },
      { label: `PID ${pidKey} ${PID_BY_ID[chartPid]?.label || ""} (${PID_BY_ID[chartPid]?.units || ""})`, values: pidPoints, color: C.sr },
    ];
  }, [samples, chartDid, chartPid]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 16 }}>
      <Card>
        <div style={{ fontFamily: "'Righteous'", fontSize: 18, color: C.sr, marginBottom: 12 }}>EXPERIMENT</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Btn onClick={connect} disabled={conn} color={C.a3}>{conn ? "✓ CONNECTED" : "CONNECT"}</Btn>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Run name (optional)"
            style={{ padding: "8px 10px", border: `1px solid ${C.bd}`, borderRadius: 6, fontSize: 12 }} />
          <div style={{ display: "flex", gap: 6 }}>
            <input value={tx} onChange={(e) => setTx(e.target.value)} placeholder="0x7E0"
              style={{ flex: 1, padding: "8px 10px", fontFamily: "'JetBrains Mono'", fontSize: 12, border: `1px solid ${C.bd}`, borderRadius: 6 }} />
            <input value={rx} onChange={(e) => setRx(e.target.value)} placeholder="0x7E8"
              style={{ flex: 1, padding: "8px 10px", fontFamily: "'JetBrains Mono'", fontSize: 12, border: `1px solid ${C.bd}`, borderRadius: 6 }} />
          </div>
          <textarea value={didListStr} onChange={(e) => setDidListStr(e.target.value)} placeholder="F40C, F40D, …"
            style={{ padding: "8px 10px", fontFamily: "'JetBrains Mono'", fontSize: 12, border: `1px solid ${C.bd}`, borderRadius: 6, minHeight: 60 }} />
          <div style={{ fontSize: 11, color: C.ts, fontWeight: 700 }}>Ground-truth PIDs:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 120, overflowY: "auto" }}>
            {STANDARD_PIDS.map((p) => {
              const on = pids.includes(p.pid);
              return (
                <button key={p.pid} onClick={() => setPids((prev) => on ? prev.filter((x) => x !== p.pid) : [...prev, p.pid])}
                  style={{ padding: "4px 8px", fontSize: 10, fontFamily: "'JetBrains Mono'",
                    border: `1px solid ${on ? C.sr : C.bd}`,
                    background: on ? C.sr + "15" : "transparent", color: on ? C.sr : C.ts,
                    borderRadius: 4, cursor: "pointer" }}>
                  0x{hx(p.pid)} {p.label}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
            <span style={{ color: C.ts }}>Poll:</span>
            <input type="number" value={pollMs} onChange={(e) => setPollMs(+e.target.value)}
              style={{ width: 60, padding: "4px 6px", border: `1px solid ${C.bd}`, borderRadius: 4 }} />
            <span style={{ color: C.tm }}>ms</span>
          </div>
          {!running ? (
            <Btn onClick={startExperiment} disabled={!conn || busy} color={C.gn}>▶ RECORD</Btn>
          ) : (
            <Btn onClick={stop} color={C.wn}>■ STOP</Btn>
          )}
          <StatLine k="Samples" v={samples.length} color={C.a3} />
          {experimentId && <StatLine k="Experiment" v={experimentId.slice(0, 8)} />}
        </div>
      </Card>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontFamily: "'Righteous'", fontSize: 18, color: C.sr }}>LIVE TRACE</div>
          <div style={{ display: "flex", gap: 6, fontSize: 11 }}>
            <select value={chartDid || ""} onChange={(e) => setChartDid(parseInt(e.target.value, 16))}
              style={{ padding: "4px 6px", fontSize: 11, fontFamily: "'JetBrains Mono'", border: `1px solid ${C.bd}`, borderRadius: 4 }}>
              {didList.map((d) => <option key={d} value={d.toString(16)}>DID 0x{hx(d, 4)}</option>)}
            </select>
            <select value={chartPid || ""} onChange={(e) => setChartPid(parseInt(e.target.value))}
              style={{ padding: "4px 6px", fontSize: 11, fontFamily: "'JetBrains Mono'", border: `1px solid ${C.bd}`, borderRadius: 4 }}>
              {pids.map((p) => <option key={p} value={p}>{PID_BY_ID[p]?.label || `0x${hx(p)}`}</option>)}
            </select>
          </div>
        </div>
        <MiniLineChart series={chartSeries} width={760} height={200} />
        <div style={{ marginTop: 12, maxHeight: 220, overflowY: "auto", border: `1px solid ${C.bd}`, borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'JetBrains Mono'", fontSize: 11 }}>
            <thead style={{ background: C.c2, position: "sticky", top: 0 }}>
              <tr>
                <th style={{ padding: 6, textAlign: "left", color: C.ts }}>t (ms)</th>
                {didList.map((d) => <th key={d} style={{ padding: 6, textAlign: "left", color: C.a3 }}>DID 0x{hx(d, 4)}</th>)}
                {pids.map((p) => <th key={p} style={{ padding: 6, textAlign: "right", color: C.sr }}>{PID_BY_ID[p]?.label || `0x${hx(p)}`}</th>)}
              </tr>
            </thead>
            <tbody>
              {samples.slice(-50).reverse().map((s, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${C.bd}` }}>
                  <td style={{ padding: 4, color: C.tm }}>{s.tMs}</td>
                  {didList.map((d) => <td key={d} style={{ padding: 4 }}>{s.didValues[`0x${hx(d, 4)}`] || "—"}</td>)}
                  {pids.map((p) => (
                    <td key={p} style={{ padding: 4, textAlign: "right", color: C.tx }}>
                      {s.pidValues[`0x${hx(p)}`] != null ? s.pidValues[`0x${hx(p)}`].toFixed(2) : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ────────────────────────────  MATCH  ────────────────────────────── */

function MatchPane({ vin, addLog }) {
  const [experiments, setExperiments] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [topN, setTopN] = useState(3); // top-N candidates per (DID, PID) pair

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/signal-discovery/experiments${vin ? `?vin=${encodeURIComponent(vin)}` : ""}`);
      const j = await r.json();
      setExperiments(j?.experiments || []);
    } catch (err) { addLog("List experiments failed: " + err.message, "warn"); }
  }, [vin, addLog]);

  useEffect(() => { refresh(); }, [refresh]);

  const load = useCallback(async (id) => {
    setSelectedId(id); setDetail(null); setResults([]); setBusy(true);
    try {
      const r = await fetch(`/api/signal-discovery/experiments/${id}`);
      const j = await r.json();
      setDetail(j);
    } catch (err) { addLog("Load failed: " + err.message, "error"); }
    setBusy(false);
  }, [addLog]);

  /**
   * For each (DID, PID) pair compute top-N decoder candidates by r²
   * and capture the decoded series so the UI can sparkline it.
   */
  const analyze = useCallback(() => {
    if (!detail?.experiment || !detail?.samples?.length) return;
    setBusy(true);
    const out = [];
    const samples = detail.samples;
    for (const did of detail.experiment.didList) {
      const didKey = `0x${hx(did, 4)}`;
      for (const pid of detail.experiment.pidList) {
        const pidKey = `0x${hx(pid, 2)}`;
        const alignedBytes = [];
        const alignedTruth = [];
        for (const s of samples) {
          const t = s.pidValues?.[pidKey];
          const b = hexToBytes(s.didValues?.[didKey] || "");
          if (Number.isFinite(t) && b.length > 0) {
            alignedBytes.push(b);
            alignedTruth.push(t);
          }
        }
        if (alignedTruth.length < 5) continue;
        // Iterate every (decoder, offset) just like bestCandidate but
        // keep the top-N rather than the single argmax.
        let sampleLen = Infinity;
        for (const b of alignedBytes) sampleLen = Math.min(sampleLen, b.length);
        if (!Number.isFinite(sampleLen) || sampleLen === 0) continue;
        const cands = [];
        for (const dec of CANDIDATE_DECODERS) {
          for (let off = 0; off + dec.width <= sampleLen; off++) {
            const xs = new Array(alignedBytes.length);
            let ok = true;
            for (let i = 0; i < alignedBytes.length; i++) {
              const v = decodeBytes(alignedBytes[i], dec, off);
              if (!Number.isFinite(v)) { ok = false; break; }
              xs[i] = v;
            }
            if (!ok) continue;
            const r = pearson(xs, alignedTruth);
            if (!Number.isFinite(r)) continue;
            const reg = linearRegression(xs, alignedTruth);
            cands.push({
              did, pid,
              decoder: dec.name, byteOffset: off,
              r, rSquared: r * r,
              slope: reg ? reg.slope : null,
              intercept: reg ? reg.intercept : null,
              decoded: xs, truth: alignedTruth,
            });
          }
        }
        cands.sort((a, b) => b.rSquared - a.rSquared);
        for (const c of cands.slice(0, topN)) {
          if (c.rSquared >= 0.5) out.push(c);
        }
      }
    }
    out.sort((a, b) => b.rSquared - a.rSquared);
    setResults(out);
    setBusy(false);
    addLog(`Matched ${out.length} candidates (r² ≥ 0.5, top ${topN}/pair)`, "info");
  }, [detail, topN, addLog]);

  const adopt = useCallback(async (row) => {
    const pid = PID_BY_ID[row.pid];
    const label = `${pid?.label || "PID 0x" + hx(row.pid)} (auto)`;
    try {
      await fetch("/api/signal-discovery/catalog", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vin: vin || null, tx: detail.experiment.targetTx, did: row.did,
          label, decoder: row.decoder, byteOffset: row.byteOffset,
          scale: row.slope, offset: row.intercept, units: pid?.units || null,
          sourceExperimentId: detail.experiment.id, sourcePid: `0x${hx(row.pid)}`,
          rSquared: row.rSquared, confirmed: false,
        }),
      });
      addLog(`Catalog: 0x${hx(row.did, 4)} ↔ ${label} (r²=${row.rSquared.toFixed(3)})`, "info");
    } catch (err) { addLog("Catalog upsert failed: " + err.message, "error"); }
  }, [detail, vin, addLog]);

  const downloadBlob = (filename, mime, content) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  /**
   * Export the *accepted* per-VIN DID catalog (entries previously
   * promoted via the "+" button → POST /catalog), not the transient
   * analysis candidates. Pulls from GET /catalog?vin so the report
   * reflects the operator's curated ground truth.
   */
  const exportCatalog = useCallback(async (format) => {
    try {
      const r = await fetch(`/api/signal-discovery/catalog${vin ? `?vin=${encodeURIComponent(vin)}` : ""}`);
      const j = await r.json();
      const entries = j?.entries || [];
      if (entries.length === 0) {
        addLog("Catalog is empty — adopt candidates first", "warn");
        return;
      }
      if (format === "json") {
        const payload = {
          generatedAt: new Date().toISOString(),
          vin: vin || null,
          methodology: "TUMFTM Holistic Approach for Automated Reverse Engineering of UDS Data (DOI 10.3390/wevj16070384)",
          entries,
        };
        downloadBlob(`signal-discovery-catalog${vin ? `-${vin}` : ""}.json`, "application/json", JSON.stringify(payload, null, 2));
      } else {
        const lines = [];
        lines.push(`# Signal Discovery — Accepted DID Catalog`);
        lines.push("");
        lines.push(`- Generated: ${new Date().toISOString()}`);
        lines.push(`- VIN: ${vin || "—"}`);
        lines.push(`- Entries: ${entries.length}`);
        lines.push(`- Methodology: TUMFTM Holistic Approach for Automated Reverse Engineering of UDS Data (DOI 10.3390/wevj16070384)`);
        lines.push("");
        lines.push(`| TX | DID | Label | Decoder | Off | Scale | Offset | Units | r² | Confirmed |`);
        lines.push(`|---|---|---|---|---:|---:|---:|---|---:|:---:|`);
        for (const e of entries) {
          lines.push(`| 0x${hx(e.tx, 3)} | 0x${hx(e.did, 4)} | ${e.label} | ${e.decoder || "—"} | ${e.byteOffset ?? "—"} | ${e.scale?.toFixed(4) ?? "—"} | ${e.offset?.toFixed(2) ?? "—"} | ${e.units || "—"} | ${e.rSquared?.toFixed(3) ?? "—"} | ${e.confirmed ? "✓" : ""} |`);
        }
        downloadBlob(`signal-discovery-catalog${vin ? `-${vin}` : ""}.md`, "text/markdown", lines.join("\n"));
      }
      addLog(`Exported ${entries.length} catalog entries (${format.toUpperCase()})`, "info");
    } catch (err) { addLog("Catalog export failed: " + err.message, "error"); }
  }, [vin, addLog]);

  const exportJson = useCallback(() => {
    if (!detail || results.length === 0) return;
    const payload = {
      generatedAt: new Date().toISOString(),
      vin: vin || null,
      experiment: {
        id: detail.experiment.id, name: detail.experiment.name,
        targetTx: detail.experiment.targetTx, targetRx: detail.experiment.targetRx,
        sampleCount: detail.samples.length,
      },
      methodology: "TUMFTM Holistic Approach for Automated Reverse Engineering of UDS Data (DOI 10.3390/wevj16070384)",
      candidates: results.map((r) => ({
        did: `0x${hx(r.did, 4)}`,
        pid: `0x${hx(r.pid)}`,
        pidLabel: PID_BY_ID[r.pid]?.label || null,
        decoder: r.decoder, byteOffset: r.byteOffset,
        rSquared: r.rSquared, slope: r.slope, intercept: r.intercept,
        units: PID_BY_ID[r.pid]?.units || null,
      })),
    };
    downloadBlob(`signal-discovery-${detail.experiment.id.slice(0, 8)}.json`, "application/json", JSON.stringify(payload, null, 2));
  }, [detail, results, vin]);

  const exportMarkdown = useCallback(() => {
    if (!detail || results.length === 0) return;
    const lines = [];
    lines.push(`# Signal Discovery Report — ${detail.experiment.name}`);
    lines.push("");
    lines.push(`- Generated: ${new Date().toISOString()}`);
    lines.push(`- VIN: ${vin || "—"}`);
    lines.push(`- Target ECU: TX 0x${hx(detail.experiment.targetTx, 3)} / RX 0x${hx(detail.experiment.targetRx, 3)}`);
    lines.push(`- Samples: ${detail.samples.length}`);
    lines.push(`- Methodology: TUMFTM Holistic Approach for Automated Reverse Engineering of UDS Data (DOI 10.3390/wevj16070384)`);
    lines.push("");
    lines.push(`| DID | PID | Decoder | Off | r² | Slope | Intercept | Units |`);
    lines.push(`|---|---|---|---:|---:|---:|---:|---|`);
    for (const r of results) {
      const p = PID_BY_ID[r.pid];
      lines.push(`| 0x${hx(r.did, 4)} | 0x${hx(r.pid)} ${p?.label || ""} | ${r.decoder} | ${r.byteOffset} | ${r.rSquared.toFixed(3)} | ${r.slope?.toFixed(4) ?? "—"} | ${r.intercept?.toFixed(2) ?? "—"} | ${p?.units || "—"} |`);
    }
    downloadBlob(`signal-discovery-${detail.experiment.id.slice(0, 8)}.md`, "text/markdown", lines.join("\n"));
  }, [detail, results, vin]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16 }}>
      <Card>
        <div style={{ fontFamily: "'Righteous'", fontSize: 16, color: C.sr, marginBottom: 8 }}>EXPERIMENTS</div>
        <Btn onClick={refresh} color={C.a3} outline>↻ REFRESH</Btn>
        <div style={{ marginTop: 10, maxHeight: 480, overflowY: "auto" }}>
          {experiments.length === 0 && <div style={{ color: C.tm, fontSize: 11, textAlign: "center", padding: 16 }}>No experiments yet</div>}
          {experiments.map((e) => (
            <div key={e.id} onClick={() => load(e.id)}
              style={{ padding: 8, marginBottom: 6, border: `1px solid ${selectedId === e.id ? C.sr : C.bd}`,
                borderRadius: 6, cursor: "pointer", background: selectedId === e.id ? C.sr + "10" : "transparent" }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{e.name}</div>
              <div style={{ fontSize: 10, color: C.ts, fontFamily: "'JetBrains Mono'" }}>
                {e.didList?.length || 0} DIDs · {e.pidList?.length || 0} PIDs · {e.sampleCount} samples · {e.status}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
          <div style={{ fontFamily: "'Righteous'", fontSize: 18, color: C.sr }}>CORRELATION</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
            <span style={{ color: C.ts }}>Top:</span>
            <input type="number" min={1} max={10} value={topN} onChange={(e) => setTopN(Math.max(1, Math.min(10, +e.target.value || 1)))}
              style={{ width: 50, padding: "4px 6px", border: `1px solid ${C.bd}`, borderRadius: 4 }} />
            <Btn onClick={analyze} disabled={!detail || busy} color={C.gn}>▶ ANALYZE</Btn>
            <span style={{ color: C.tm, fontSize: 10, marginLeft: 4 }}>candidates:</span>
            <Btn onClick={exportJson} disabled={results.length === 0} color={C.a3} outline>JSON</Btn>
            <Btn onClick={exportMarkdown} disabled={results.length === 0} color={C.a3} outline>MD</Btn>
            <span style={{ color: C.tm, fontSize: 10, marginLeft: 4 }}>catalog:</span>
            <Btn onClick={() => exportCatalog("json")} color={C.sr} outline>JSON</Btn>
            <Btn onClick={() => exportCatalog("md")} color={C.sr} outline>MD</Btn>
          </div>
        </div>
        {!detail && <div style={{ color: C.tm, fontSize: 11, padding: 16, textAlign: "center" }}>Select an experiment to run correlation analysis</div>}
        {detail && (
          <div>
            <div style={{ fontSize: 11, color: C.ts, marginBottom: 8, fontFamily: "'JetBrains Mono'" }}>
              {detail.experiment.name} · {detail.samples.length} samples · TX 0x{hx(detail.experiment.targetTx, 3)}
            </div>
            <div style={{ maxHeight: 460, overflowY: "auto", border: `1px solid ${C.bd}`, borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'JetBrains Mono'", fontSize: 11 }}>
                <thead style={{ background: C.c2, position: "sticky", top: 0 }}>
                  <tr>
                    <th style={{ padding: 6, textAlign: "left" }}>DID</th>
                    <th style={{ padding: 6, textAlign: "left" }}>PID</th>
                    <th style={{ padding: 6, textAlign: "left" }}>Decoder</th>
                    <th style={{ padding: 6, textAlign: "right" }}>Off</th>
                    <th style={{ padding: 6, textAlign: "right" }}>r²</th>
                    <th style={{ padding: 6, textAlign: "right" }}>Slope</th>
                    <th style={{ padding: 6, textAlign: "right" }}>Off</th>
                    <th style={{ padding: 6 }}>Trend</th>
                    <th style={{ padding: 6 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((row, i) => {
                    const pid = PID_BY_ID[row.pid];
                    const didDesc = getDidDescription(row.did);
                    return (
                      <tr key={i} style={{ borderTop: `1px solid ${C.bd}` }}>
                        <td style={{ padding: 4 }} title={didDesc || ""}>0x{hx(row.did, 4)}</td>
                        <td style={{ padding: 4 }}>{pid?.label || `0x${hx(row.pid)}`}</td>
                        <td style={{ padding: 4, color: C.a3 }}>{row.decoder}</td>
                        <td style={{ padding: 4, textAlign: "right" }}>{row.byteOffset}</td>
                        <td style={{ padding: 4, textAlign: "right", color: row.rSquared >= 0.9 ? C.gn : C.wn, fontWeight: 700 }}>{row.rSquared.toFixed(3)}</td>
                        <td style={{ padding: 4, textAlign: "right" }}>{row.slope?.toFixed(4) || "—"}</td>
                        <td style={{ padding: 4, textAlign: "right" }}>{row.intercept?.toFixed(2) || "—"}</td>
                        <td style={{ padding: 4 }}><Sparkline a={row.decoded} b={row.truth} /></td>
                        <td style={{ padding: 4 }}><Btn onClick={() => adopt(row)} color={C.sr} outline>+</Btn></td>
                      </tr>
                    );
                  })}
                  {results.length === 0 && detail && (
                    <tr><td colSpan={9} style={{ padding: 16, textAlign: "center", color: C.tm }}>Click ▶ ANALYZE to compute correlations</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ──────────────────────────  TAB ROOT  ───────────────────────────── */

export default function SignalDiscoveryTab() {
  const ctx = useContext(MasterVinContext);
  const vin = ctx?.masterVin || "";
  const [pane, setPane] = useState("sweep");
  const [log, setLog] = useState([]);
  const addLog = useCallback((m, t = "info") => {
    const ts = new Date().toLocaleTimeString();
    setLog((p) => [...p.slice(-300), { t: ts, m, type: t }]);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontFamily: "'Righteous'", fontSize: 22, color: C.bk }}>SIGNAL DISCOVERY</div>
            <div style={{ fontSize: 11, color: C.ts, marginTop: 4 }}>
              TUMFTM Holistic Approach · DOI 10.3390/wevj16070384 · Apache-2.0
              {vin && <span style={{ marginLeft: 12, color: C.sr, fontFamily: "'JetBrains Mono'" }}>VIN {vin}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 0, borderBottom: `2px solid ${C.bk}` }}>
            <SubTab active={pane === "sweep"} onClick={() => setPane("sweep")} icon="🛰">SWEEP</SubTab>
            <SubTab active={pane === "record"} onClick={() => setPane("record")} icon="📈">RECORD</SubTab>
            <SubTab active={pane === "match"} onClick={() => setPane("match")} icon="🎯">MATCH</SubTab>
          </div>
        </div>
      </Card>
      {pane === "sweep" && <SweepPane vin={vin} addLog={addLog} />}
      {pane === "record" && <RecordPane vin={vin} addLog={addLog} />}
      {pane === "match" && <MatchPane vin={vin} addLog={addLog} />}
      {log.length > 0 && (
        <Card>
          <div style={{ fontFamily: "'Righteous'", fontSize: 14, color: C.sr, marginBottom: 8 }}>LOG</div>
          <div style={{ maxHeight: 180, overflowY: "auto", fontFamily: "'JetBrains Mono'", fontSize: 11 }}>
            {log.slice().reverse().map((e, i) => (
              <div key={i} style={{ color: e.type === "error" ? C.er : e.type === "warn" ? C.wn : e.type === "rx" ? C.gn : C.ts }}>
                [{e.t}] {e.m}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
