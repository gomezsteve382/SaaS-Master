import React, { useState, useCallback, useRef } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn } from "../lib/ui.jsx";

const API = "/api/tools";
const hx = (n, w = 2) => (n >>> 0).toString(16).toUpperCase().padStart(w, "0");

const ARCH_OPTS = ["x86", "arm", "arm64", "mips"];
const BITS_BY_ARCH = { x86: [16, 32, 64], arm: [32], arm64: [64], mips: [32] };
const ENDIAN_OPTS = ["little", "big"];

function StatusBadge({ available, version }) {
  if (available === undefined) return null;
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4,
      letterSpacing: 1,
      background: available ? "#e6f9ed" : "#FFE6E6",
      color: available ? "#1E6F3A" : "#C00",
      border: `1px solid ${available ? "#1E6F3A44" : "#C0000044"}`,
    }}>
      {available ? `UNICORN ${version ?? "OK"}` : "UNICORN UNAVAILABLE"}
    </span>
  );
}

function LogLine({ item }) {
  const col = item.type === "err" ? "#C00" : item.type === "ok" ? "#1E6F3A" : C.ts;
  return (
    <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono'", color: col, marginBottom: 2, lineHeight: 1.5 }}>
      <span style={{ opacity: 0.5, marginRight: 6 }}>{item.ts}</span>{item.m}
    </div>
  );
}

function RegRow({ reg, onChange, onRemove }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
      <input
        value={reg.name}
        placeholder="reg"
        onChange={e => onChange({ ...reg, name: e.target.value })}
        style={{ width: 70, ...inputSm }}
      />
      <span style={{ fontSize: 11, color: C.ts }}>=</span>
      <input
        value={reg.value}
        placeholder="0x..."
        onChange={e => onChange({ ...reg, value: e.target.value })}
        style={{ width: 120, ...inputSm }}
      />
      <button onClick={onRemove} style={{ fontSize: 10, color: "#C00", background: "none", border: "none", cursor: "pointer" }}>✕</button>
    </div>
  );
}

const inputSm = {
  fontSize: 12, fontFamily: "'JetBrains Mono'", padding: "4px 8px",
  border: "1px solid " + C.bd, borderRadius: 4, background: "#fff",
};

const label = (t) => (
  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: C.ts, marginBottom: 3 }}>{t}</div>
);

export default function FirmwareEmulationTab() {
  const [status, setStatus] = useState(null);
  const [statusBusy, setStatusBusy] = useState(false);

  const [file, setFile] = useState(null);
  const [fileB64, setFileB64] = useState("");

  // Shared emulation fields
  const [arch, setArch] = useState("x86");
  const [bits, setBits] = useState(64);
  const [base, setBase] = useState("0x400000");
  const [offset, setOffset] = useState("0");
  const [size, setSize] = useState("0x200");

  // Emulate-only fields
  const [emuStart, setEmuStart] = useState("");
  const [emuStop, setEmuStop] = useState("");
  const [emuSteps, setEmuSteps] = useState("200000");
  const [regs, setRegs] = useState([{ name: "", value: "" }]);
  const [dump, setDump] = useState("");
  const [trace, setTrace] = useState(false);
  const [emuResult, setEmuResult] = useState(null);
  const [emuBusy, setEmuBusy] = useState(false);

  // Keyfn-specific fields
  const [kfnStart, setKfnStart] = useState("");
  const [kfnStop, setKfnStop] = useState("");
  const [seedReg, setSeedReg] = useState("edi");
  const [keyReg, setKeyReg] = useState("eax");
  const [keylen, setKeylen] = useState("4");
  const [endian, setEndian] = useState("little");
  const [kfnSteps, setKfnSteps] = useState("200000");
  const [kfnResult, setKfnResult] = useState(null);
  const [kfnBusy, setKfnBusy] = useState(false);

  const [log, setLog] = useState([]);
  const logEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const kfnInputRef = useRef(null);

  const addLog = useCallback((m, type = "info") => {
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    setLog(p => [...p.slice(-200), { ts, m, type }]);
    setTimeout(() => { if (logEndRef.current) logEndRef.current.scrollTop = logEndRef.current.scrollHeight; }, 50);
  }, []);

  const checkStatus = useCallback(async () => {
    setStatusBusy(true);
    try {
      const r = await fetch(`${API}/re-bridge/status`);
      const j = await r.json();
      setStatus(j);
      addLog(j.available ? `Unicorn ${j.version} ready` : `Unicorn unavailable — install: pip install unicorn`, j.available ? "ok" : "err");
    } catch (e) {
      addLog("Status check failed: " + e.message, "err");
    }
    setStatusBusy(false);
  }, [addLog]);

  const loadFile = useCallback((f) => {
    if (!f) return;
    setFile(f);
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = new Uint8Array(e.target.result);
      let b64 = "";
      const CHUNK = 8192;
      for (let i = 0; i < buf.length; i += CHUNK) {
        b64 += String.fromCharCode(...buf.slice(i, i + CHUNK));
      }
      setFileB64(btoa(b64));
      addLog(`Loaded ${f.name} — ${buf.length.toLocaleString()} bytes`);
    };
    reader.readAsArrayBuffer(f);
  }, [addLog]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  }, [loadFile]);

  const handleEmulate = useCallback(async () => {
    if (!fileB64) { addLog("No file loaded", "err"); return; }
    setEmuBusy(true);
    setEmuResult(null);
    addLog("Running emulation…");
    try {
      const body = {
        fileB64, arch, bits: Number(bits), base, offset, size,
        start: emuStart || undefined, stop: emuStop || undefined,
        steps: Number(emuSteps),
        regs: regs.filter(r => r.name),
        dump: dump || undefined,
        trace,
      };
      const r = await fetch(`${API}/emulate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      setEmuResult(j);
      if (j.ok === false || j.error) {
        addLog("Emulation error: " + (j.error ?? "unknown"), "err");
      } else {
        addLog("Emulation complete — registers captured", "ok");
        if (j.note) addLog("Note: " + j.note);
      }
    } catch (e) {
      addLog("Request failed: " + e.message, "err");
    }
    setEmuBusy(false);
  }, [fileB64, arch, bits, base, offset, size, emuStart, emuStop, emuSteps, regs, dump, trace, addLog]);

  const handleMakeKeyfn = useCallback(async () => {
    if (!fileB64) { addLog("No file loaded", "err"); return; }
    if (!kfnStart || !kfnStop) { addLog("start and stop addresses required", "err"); return; }
    setKfnBusy(true);
    setKfnResult(null);
    addLog("Generating keyfn.py via Unicorn…");
    try {
      const body = {
        fileB64, arch, bits: Number(bits), base, offset, size: size,
        start: kfnStart, stop: kfnStop,
        seedReg, keyReg, keylen: Number(keylen), endian, steps: Number(kfnSteps),
      };
      const r = await fetch(`${API}/make-keyfn`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      setKfnResult(j);
      if (j.ok) {
        addLog(`keyfn.py generated — sample seed ${j.sample_seed} → key ${j.sample_key}`, "ok");
        if (j.verify_error) addLog("Verify error (check params): " + j.verify_error, "err");
      } else {
        addLog("keyfn error: " + (j.error ?? "unknown"), "err");
      }
    } catch (e) {
      addLog("Request failed: " + e.message, "err");
    }
    setKfnBusy(false);
  }, [fileB64, arch, bits, base, offset, size, kfnStart, kfnStop, seedReg, keyReg, keylen, endian, kfnSteps, addLog]);

  const downloadKeyfn = useCallback(() => {
    if (!kfnResult?.keyfnSrc) return;
    const blob = new Blob([kfnResult.keyfnSrc], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "keyfn.py";
    a.click();
  }, [kfnResult]);

  const bitsOpts = BITS_BY_ARCH[arch] ?? [64];

  const sharedFields = (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))", gap: 10, marginBottom: 16 }}>
      <div>
        {label("ARCH")}
        <select value={arch} onChange={e => { setArch(e.target.value); setBits(BITS_BY_ARCH[e.target.value][0]); }} style={{ ...inputSm, width: "100%" }}>
          {ARCH_OPTS.map(a => <option key={a}>{a}</option>)}
        </select>
      </div>
      <div>
        {label("BITS")}
        <select value={bits} onChange={e => setBits(Number(e.target.value))} style={{ ...inputSm, width: "100%" }}>
          {bitsOpts.map(b => <option key={b}>{b}</option>)}
        </select>
      </div>
      <div>
        {label("BASE ADDRESS")}
        <input value={base} onChange={e => setBase(e.target.value)} style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
      </div>
      <div>
        {label("FILE OFFSET")}
        <input value={offset} onChange={e => setOffset(e.target.value)} style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
      </div>
      <div>
        {label("CODE SIZE")}
        <input value={size} onChange={e => setSize(e.target.value)} style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
      </div>
    </div>
  );

  return (
    <div style={{ padding: "16px 20px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={{ fontFamily: "'Righteous'", fontSize: 22, letterSpacing: 2, color: C.a1 }}>FIRMWARE EMULATION</div>
        <StatusBadge available={status?.available} version={status?.version} />
        <Btn onClick={checkStatus} disabled={statusBusy} color={C.ts} outline style={{ fontSize: 10 }}>
          {statusBusy ? "…" : "Check Status"}
        </Btn>
      </div>
      <div style={{ fontSize: 11, color: C.ts, marginBottom: 20, lineHeight: 1.6, maxWidth: 700 }}>
        Run a firmware routine under Unicorn CPU emulation — either as a raw register trace (<b>EMULATE</b>)
        or packaged as a standalone seed→key harness (<b>MAKE KEYFN</b>).
        Find routine addresses via Ghidra decompile. Supported: x86-16/32/64, ARM-32, ARM64, MIPS-32.
      </div>

      {/* File drop zone */}
      <Card style={{ marginBottom: 18 }}>
        <div style={{ fontFamily: "'Righteous'", fontSize: 13, letterSpacing: 1, marginBottom: 10, color: C.a1 }}>
          FIRMWARE FILE
        </div>
        <div
          onDrop={handleDrop} onDragOver={e => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${fileB64 ? C.a2 : C.bd}`, borderRadius: 8,
            padding: "22px 16px", textAlign: "center", cursor: "pointer",
            background: fileB64 ? "#e6f9ed22" : "#FAFAF8",
            transition: "border-color 0.15s",
          }}
        >
          {file ? (
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: C.a2 }}>{file.name}</div>
              <div style={{ fontSize: 11, color: C.ts, marginTop: 4 }}>
                {(file.size / 1024).toFixed(1)} KB — drop another to replace
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: C.ts }}>
              Drop firmware .bin here or <b style={{ color: C.a1 }}>click to browse</b>
            </div>
          )}
        </div>
        <input ref={fileInputRef} type="file" accept=".bin,.hex,.srec,.elf,.rom" style={{ display: "none" }}
          onChange={e => loadFile(e.target.files?.[0])} />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 18 }}>
        {/* Emulate panel */}
        <Card>
          <div style={{ fontFamily: "'Righteous'", fontSize: 13, letterSpacing: 1, marginBottom: 12, color: C.a1 }}>
            EMULATE
          </div>
          <div style={{ fontSize: 11, color: C.ts, marginBottom: 14, lineHeight: 1.5 }}>
            Load a binary slice, set registers, run to stop address, dump final state.
          </div>
          {sharedFields}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div>
              {label("START (opt)")}
              <input value={emuStart} onChange={e => setEmuStart(e.target.value)} placeholder="0x..." style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
            <div>
              {label("STOP")}
              <input value={emuStop} onChange={e => setEmuStop(e.target.value)} placeholder="0x..." style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
            <div>
              {label("MAX STEPS")}
              <input value={emuSteps} onChange={e => setEmuSteps(e.target.value)} style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
          </div>
          {label("INITIAL REGISTERS")}
          {regs.map((r, i) => (
            <RegRow key={i} reg={r}
              onChange={v => setRegs(p => p.map((x, j) => j === i ? v : x))}
              onRemove={() => setRegs(p => p.filter((_, j) => j !== i))} />
          ))}
          <button onClick={() => setRegs(p => [...p, { name: "", value: "" }])}
            style={{ fontSize: 10, color: C.a1, background: "none", border: "none", cursor: "pointer", marginBottom: 12 }}>
            + Add register
          </button>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div>
              {label("MEM DUMP (opt)")}
              <input value={dump} onChange={e => setDump(e.target.value)} placeholder="addr:len" style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
            <div style={{ paddingTop: 17 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer" }}>
                <input type="checkbox" checked={trace} onChange={e => setTrace(e.target.checked)} />
                Trace (first 256 addrs)
              </label>
            </div>
          </div>
          <Btn onClick={handleEmulate} disabled={emuBusy || !fileB64} color={C.a1}>
            {emuBusy ? "⏳ Emulating…" : "Run Emulation"}
          </Btn>
          {emuResult && (
            <div style={{ marginTop: 14, background: "#F8F6F2", borderRadius: 6, padding: 10 }}>
              {emuResult.ok === false || emuResult.error ? (
                <div style={{ color: "#C00", fontSize: 11, fontFamily: "'JetBrains Mono'" }}>
                  Error: {emuResult.error}
                </div>
              ) : (
                <>
                  {emuResult.note && (
                    <div style={{ fontSize: 10, color: C.ts, marginBottom: 8, lineHeight: 1.5 }}>{emuResult.note}</div>
                  )}
                  <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, lineHeight: 1.8 }}>
                    {Object.entries(emuResult.registers ?? {}).map(([r, v]) => (
                      <div key={r}>
                        <span style={{ color: C.ts, display: "inline-block", width: 50 }}>{r}</span>
                        <span style={{ color: C.a1, fontWeight: 700 }}>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                  {emuResult.memory_dump && (
                    <div style={{ marginTop: 8, fontSize: 10, fontFamily: "'JetBrains Mono'", wordBreak: "break-all" }}>
                      <span style={{ color: C.ts }}>mem@{emuResult.memory_dump.addr}: </span>
                      <span style={{ color: C.a2 }}>{emuResult.memory_dump.hex}</span>
                    </div>
                  )}
                  {emuResult.trace && (
                    <div style={{ marginTop: 8, fontSize: 10, fontFamily: "'JetBrains Mono'", color: C.ts, wordBreak: "break-all" }}>
                      Trace: {emuResult.trace.join(" → ")}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </Card>

        {/* Make Keyfn panel */}
        <Card>
          <div style={{ fontFamily: "'Righteous'", fontSize: 13, letterSpacing: 1, marginBottom: 12, color: C.a1 }}>
            MAKE KEYFN
          </div>
          <div style={{ fontSize: 11, color: C.ts, marginBottom: 14, lineHeight: 1.5 }}>
            Package the real SA key routine as a standalone <code style={{ fontFamily: "'JetBrains Mono'" }}>keyfn.py</code>{" "}
            exposing <code style={{ fontFamily: "'JetBrains Mono'" }}>def key(seed) → bytes</code>.
            Find routine location in Ghidra → enter start/stop → download.
          </div>
          {sharedFields}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              {label("ROUTINE START")}
              <input value={kfnStart} onChange={e => setKfnStart(e.target.value)} placeholder="0x..." style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
            <div>
              {label("ROUTINE STOP")}
              <input value={kfnStop} onChange={e => setKfnStop(e.target.value)} placeholder="0x..." style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              {label("SEED REG")}
              <input value={seedReg} onChange={e => setSeedReg(e.target.value)} style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
            <div>
              {label("KEY REG")}
              <input value={keyReg} onChange={e => setKeyReg(e.target.value)} style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
            <div>
              {label("KEY LEN")}
              <input value={keylen} onChange={e => setKeylen(e.target.value)} style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div>
              {label("ENDIAN")}
              <select value={endian} onChange={e => setEndian(e.target.value)} style={{ ...inputSm, width: "100%" }}>
                {ENDIAN_OPTS.map(e => <option key={e}>{e}</option>)}
              </select>
            </div>
            <div>
              {label("MAX STEPS")}
              <input value={kfnSteps} onChange={e => setKfnSteps(e.target.value)} style={{ ...inputSm, width: "100%", boxSizing: "border-box" }} />
            </div>
          </div>
          <Btn onClick={handleMakeKeyfn} disabled={kfnBusy || !fileB64} color={C.a1}>
            {kfnBusy ? "⏳ Generating…" : "Generate keyfn.py"}
          </Btn>
          {kfnResult && (
            <div style={{ marginTop: 14, background: "#F8F6F2", borderRadius: 6, padding: 10 }}>
              {!kfnResult.ok ? (
                <div style={{ color: "#C00", fontSize: 11, fontFamily: "'JetBrains Mono'" }}>
                  Error: {kfnResult.error}
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#1E6F3A" }}>keyfn.py generated</span>
                    {kfnResult.keyfnSrc && (
                      <button onClick={downloadKeyfn} style={{
                        fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4,
                        border: "1px solid " + C.a2, background: "#e6f9ed", color: C.a2, cursor: "pointer",
                      }}>
                        Download
                      </button>
                    )}
                  </div>
                  <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, lineHeight: 1.8 }}>
                    <div><span style={{ color: C.ts }}>arch: </span><span style={{ color: C.a1 }}>{kfnResult.arch ?? arch}/{bits}</span></div>
                    <div><span style={{ color: C.ts }}>code bytes: </span><span style={{ color: C.a1 }}>{kfnResult.code_bytes}</span></div>
                    {kfnResult.sample_seed && (
                      <div><span style={{ color: C.ts }}>sample seed→key: </span>
                        <span style={{ color: C.a1 }}>{kfnResult.sample_seed} → {kfnResult.sample_key}</span>
                      </div>
                    )}
                    {kfnResult.verify_error && (
                      <div style={{ color: "#C00" }}>verify: {kfnResult.verify_error}</div>
                    )}
                  </div>
                  {kfnResult.note && (
                    <div style={{ fontSize: 10, color: C.ts, marginTop: 8, lineHeight: 1.5 }}>{kfnResult.note}</div>
                  )}
                  {kfnResult.keyfnSrc && (
                    <details style={{ marginTop: 10 }}>
                      <summary style={{ fontSize: 10, cursor: "pointer", color: C.ts, userSelect: "none" }}>
                        Show keyfn.py source
                      </summary>
                      <pre style={{
                        fontSize: 9, fontFamily: "'JetBrains Mono'", marginTop: 6,
                        background: "#1A1A1A", color: "#90EE90", padding: 10, borderRadius: 4,
                        maxHeight: 220, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
                      }}>{kfnResult.keyfnSrc}</pre>
                    </details>
                  )}
                </>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Log */}
      {log.length > 0 && (
        <Card style={{ marginTop: 4 }}>
          <div style={{ fontFamily: "'Righteous'", fontSize: 11, letterSpacing: 1, color: C.ts, marginBottom: 8 }}>
            LOG
          </div>
          <div ref={logEndRef} style={{ maxHeight: 140, overflowY: "auto" }}>
            {log.map((item, i) => <LogLine key={i} item={item} />)}
          </div>
        </Card>
      )}
    </div>
  );
}
