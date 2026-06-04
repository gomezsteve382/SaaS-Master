import React, { useState, useCallback, useRef, useEffect } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn, Tag } from "../lib/ui.jsx";

const BASE_URL = import.meta.env.BASE_URL || "/";
const API = (p) => `${BASE_URL}api${p}`;

const mono = { fontFamily: "'JetBrains Mono', monospace", fontSize: 11 };
const hdr = (txt) => (
  <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 2, marginBottom: 6 }}>
    {txt}
  </div>
);

const ARCH_OPTS = ["arm", "thumb", "arm64", "x86", "ppc", "mips"];
const BITS_OPTS = [32, 64];

const DEFAULT_STATE = {
  arch: "arm",
  bits: 32,
  base: "0x00000000",
  offset: "0",
  size: "",
  start: "0x00000000",
  stop: "0x00000100",
  seedReg: "r0",
  keyReg: "r1",
  keylen: 4,
  endian: "little",
};

function hexInt(s) {
  const v = parseInt(s, s.startsWith("0x") || s.startsWith("0X") ? 16 : 10);
  return isNaN(v) ? 0 : v;
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.ts, marginBottom: 4, letterSpacing: 1 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, style = {} }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%",
        padding: "7px 10px",
        borderRadius: 8,
        border: `1.5px solid ${C.bd}`,
        background: C.c2,
        color: C.tx,
        fontSize: 12,
        fontFamily: "'JetBrains Mono', monospace",
        boxSizing: "border-box",
        ...style,
      }}
    />
  );
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "7px 10px",
        borderRadius: 8,
        border: `1.5px solid ${C.bd}`,
        background: C.c2,
        color: C.tx,
        fontSize: 12,
        cursor: "pointer",
        width: "100%",
      }}
    >
      {options.map((o) => (
        <option key={String(o)} value={String(o)}>
          {String(o)}
        </option>
      ))}
    </select>
  );
}

function StatusBadge({ status }) {
  if (status === "ok")
    return <Tag color={C.gn}>✓ Unicorn ready</Tag>;
  if (status === "error")
    return <Tag color={C.er}>✗ Unicorn missing</Tag>;
  if (status === "checking")
    return <Tag color={C.wn}>… checking</Tag>;
  return null;
}

export default function FirmwareEmulationTab() {
  const [unicornStatus, setUnicornStatus] = useState("idle");
  const [unicornVer, setUnicornVer] = useState(null);
  const [file, setFile] = useState(null);
  const [fileB64, setFileB64] = useState(null);
  const [fileName, setFileName] = useState("");
  const [cfg, setCfg] = useState(DEFAULT_STATE);
  const [busy, setBusy] = useState("");
  const [keyfnCode, setKeyfnCode] = useState("");
  const [verifyVector, setVerifyVector] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Emulate panel state
  const [emuRegs, setEmuRegs] = useState("{}");
  const [emuDump, setEmuDump] = useState("{}");
  const [emuResult, setEmuResult] = useState(null);

  // Verify panel state
  const [verifySeed, setVerifySeed] = useState("0x12345678");
  const [verifyResult, setVerifyResult] = useState(null);

  const fileRef = useRef(null);

  // ---------------------------------------------------------------------------
  // Status probe
  // ---------------------------------------------------------------------------
  const checkStatus = useCallback(async () => {
    setUnicornStatus("checking");
    try {
      const r = await fetch(API("/tools/re-bridge/status"));
      const d = await r.json();
      setUnicornStatus(d.ok ? "ok" : "error");
      if (d.version) setUnicornVer(d.version);
    } catch {
      setUnicornStatus("error");
    }
  }, []);

  useEffect(() => { checkStatus(); }, [checkStatus]);

  // ---------------------------------------------------------------------------
  // File upload
  // ---------------------------------------------------------------------------
  const handleFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setFile(f);
    setKeyfnCode("");
    setVerifyVector(null);
    setError("");
    const reader = new FileReader();
    reader.onload = (ev) => {
      const ab = ev.target.result;
      const bytes = new Uint8Array(ab);
      let b64 = "";
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      setFileB64(btoa(b64));
    };
    reader.readAsArrayBuffer(f);
  }, []);

  const set = (k) => (v) => setCfg((p) => ({ ...p, [k]: v }));

  // ---------------------------------------------------------------------------
  // Extract seed→key
  // ---------------------------------------------------------------------------
  const handleExtract = useCallback(async () => {
    if (!fileB64) { setError("Upload a firmware file first."); return; }
    setError(""); setBusy("extract"); setKeyfnCode(""); setVerifyVector(null);
    try {
      const payload = {
        fileB64,
        arch:    cfg.arch,
        bits:    Number(cfg.bits),
        base:    hexInt(cfg.base),
        offset:  hexInt(cfg.offset),
        size:    cfg.size ? hexInt(cfg.size) : null,
        start:   hexInt(cfg.start),
        stop:    hexInt(cfg.stop),
        seedReg: cfg.seedReg,
        keyReg:  cfg.keyReg,
        keylen:  Number(cfg.keylen),
        endian:  cfg.endian,
      };
      const r = await fetch(API("/tools/make-keyfn"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Unknown error"); return; }
      setKeyfnCode(d.keyfnCode || "");
      setVerifyVector(d.verifiedVector || null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }, [fileB64, cfg]);

  // ---------------------------------------------------------------------------
  // Verify (re-run with user-supplied seed)
  // ---------------------------------------------------------------------------
  const handleVerify = useCallback(async () => {
    if (!fileB64) { setError("Upload a firmware file first."); return; }
    setError(""); setBusy("verify"); setVerifyResult(null);
    try {
      const seedVal = hexInt(verifySeed);
      const payload = {
        fileB64,
        arch:    cfg.arch,
        bits:    Number(cfg.bits),
        base:    hexInt(cfg.base),
        offset:  hexInt(cfg.offset),
        size:    cfg.size ? hexInt(cfg.size) : null,
        start:   hexInt(cfg.start),
        stop:    hexInt(cfg.stop),
        seedReg: cfg.seedReg,
        keyReg:  cfg.keyReg,
        keylen:  Number(cfg.keylen),
        endian:  cfg.endian,
        regs:    { [cfg.seedReg]: seedVal },
        dump:    {},
      };
      const r = await fetch(API("/tools/emulate"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Emulation error"); return; }
      const keyVal = parseInt(d.regs?.[cfg.keyReg] || "0", 16);
      const keyMask = (BigInt(1) << BigInt(cfg.keylen * 8)) - BigInt(1);
      setVerifyResult({ seed: seedVal, key: Number(BigInt(keyVal) & keyMask) });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }, [fileB64, cfg, verifySeed]);

  // ---------------------------------------------------------------------------
  // Raw emulate panel
  // ---------------------------------------------------------------------------
  const handleEmulate = useCallback(async () => {
    if (!fileB64) { setError("Upload a firmware file first."); return; }
    setError(""); setBusy("emulate"); setEmuResult(null);
    try {
      let regs = {};
      let dump = {};
      try { regs = JSON.parse(emuRegs); } catch { setError("regs is not valid JSON"); return; }
      try { dump = JSON.parse(emuDump); } catch { setError("dump is not valid JSON"); return; }
      const payload = {
        fileB64,
        arch:   cfg.arch,
        bits:   Number(cfg.bits),
        base:   hexInt(cfg.base),
        offset: hexInt(cfg.offset),
        size:   cfg.size ? hexInt(cfg.size) : null,
        start:  hexInt(cfg.start),
        stop:   hexInt(cfg.stop),
        regs,
        dump,
      };
      const r = await fetch(API("/tools/emulate"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      setEmuResult(d);
      if (!d.ok) setError(d.error || "Emulation error");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }, [fileB64, cfg, emuRegs, emuDump]);

  // ---------------------------------------------------------------------------
  // Copy keyfn.py
  // ---------------------------------------------------------------------------
  const copyKeyfn = () => {
    try { navigator.clipboard.writeText(keyfnCode).catch(() => {}); } catch (_) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div style={{ maxWidth: 900 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
        <div>
          <div style={{ fontSize: 22, fontFamily: "'Righteous'", color: C.bk }}>
            🔬 Firmware Emulation
          </div>
          <div style={{ fontSize: 12, color: C.ts }}>
            Extract seed→key functions from real ECU firmware via CPU emulation
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge status={unicornStatus} />
          {unicornVer && (
            <span style={{ fontSize: 10, color: C.tm, ...mono }}>v{unicornVer}</span>
          )}
          <Btn onClick={checkStatus} outline style={{ padding: "5px 12px", fontSize: 10 }}>
            re-check
          </Btn>
        </div>
      </div>

      {unicornStatus === "error" && (
        <Card style={{ background: C.er + "10", borderColor: C.er + "40", marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: C.er, fontWeight: 700 }}>
            ⚠ Unicorn CPU emulator is not available on the server.
          </div>
          <div style={{ fontSize: 11, color: C.ts, marginTop: 4 }}>
            Run: <code style={mono}>pip install unicorn</code> or check{" "}
            <code style={mono}>tools/re-bridge/requirements.txt</code>.
          </div>
        </Card>
      )}

      {/* Step 1 — Upload */}
      <Card style={{ marginBottom: 16 }}>
        {hdr("STEP 1 — UPLOAD FIRMWARE SLICE")}
        <div
          onClick={() => fileRef.current?.click()}
          style={{
            border: `2px dashed ${C.bd}`,
            borderRadius: 10,
            padding: "18px 24px",
            textAlign: "center",
            cursor: "pointer",
            background: C.c2,
            marginBottom: 8,
          }}
        >
          <input ref={fileRef} type="file" style={{ display: "none" }} onChange={handleFile} />
          <div style={{ fontSize: 13, color: C.ts }}>
            {fileName
              ? `📄 ${fileName} (${file ? (file.size / 1024).toFixed(1) : "?"} KB)`
              : "Click to upload firmware .bin / .hex / slice"}
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.tm }}>
          Upload a full binary or a pre-extracted function slice. The file is loaded
          client-side and base64-encoded before being sent to the API.
        </div>
      </Card>

      {/* Step 2 — Configure */}
      <Card style={{ marginBottom: 16 }}>
        {hdr("STEP 2 — CONFIGURE EMULATION PARAMETERS")}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Architecture">
            <Select value={cfg.arch} onChange={set("arch")} options={ARCH_OPTS} />
          </Field>
          <Field label="Bits">
            <Select value={String(cfg.bits)} onChange={(v) => set("bits")(Number(v))} options={BITS_OPTS} />
          </Field>
          <Field label="Endian">
            <Select value={cfg.endian} onChange={set("endian")} options={["little", "big"]} />
          </Field>
          <Field label="Load Address (base VA)">
            <Input value={cfg.base} onChange={set("base")} placeholder="0x00000000" />
          </Field>
          <Field label="File Offset (bytes)">
            <Input value={cfg.offset} onChange={set("offset")} placeholder="0" />
          </Field>
          <Field label="Snippet Size (bytes, blank=all)">
            <Input value={cfg.size} onChange={set("size")} placeholder="blank = rest of file" />
          </Field>
          <Field label="Emulation Start (VA)">
            <Input value={cfg.start} onChange={set("start")} placeholder="0x00001000" />
          </Field>
          <Field label="Emulation Stop (VA)">
            <Input value={cfg.stop} onChange={set("stop")} placeholder="0x00001100" />
          </Field>
          <Field label="Key Length (bytes)">
            <Select value={String(cfg.keylen)} onChange={(v) => set("keylen")(Number(v))} options={[1, 2, 3, 4, 8]} />
          </Field>
          <Field label="Seed Register">
            <Input value={cfg.seedReg} onChange={set("seedReg")} placeholder="r0, eax, x0 …" />
          </Field>
          <Field label="Key Register">
            <Input value={cfg.keyReg} onChange={set("keyReg")} placeholder="r1, eax, x0 …" />
          </Field>
        </div>
        <div style={{ fontSize: 11, color: C.tm, marginTop: 4 }}>
          Tip: use Ghidra to locate the SecurityAccess handler; note the function entry and
          end address, the register that holds the seed on entry, and the register that
          contains the computed key on return.
        </div>
      </Card>

      {/* Step 3 — Extract */}
      <Card style={{ marginBottom: 16 }}>
        {hdr("STEP 3 — EXTRACT SEED→KEY FUNCTION")}
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <Btn
            onClick={handleExtract}
            disabled={!fileB64 || !!busy}
            color={C.sr}
          >
            {busy === "extract" ? "Emulating…" : "⚡ Extract seed→key"}
          </Btn>
        </div>

        {verifyVector && (
          <div style={{ fontSize: 12, color: C.gn, marginBottom: 10, ...mono }}>
            ✓ Verified: seed=0x{verifyVector.seed.toString(16).toUpperCase().padStart(8, "0")} →
            key=0x{verifyVector.key.toString(16).toUpperCase().padStart(8, "0")}
          </div>
        )}

        {keyfnCode && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.ts }}>Generated keyfn.py</div>
              <Btn onClick={copyKeyfn} outline style={{ padding: "4px 12px", fontSize: 10 }}>
                {copied ? "✓ Copied" : "📋 Copy"}
              </Btn>
            </div>
            <textarea
              readOnly
              value={keyfnCode}
              style={{
                width: "100%",
                height: 260,
                padding: 12,
                borderRadius: 8,
                border: `1.5px solid ${C.bd}`,
                background: "#1A1A2E",
                color: "#C8E6FF",
                resize: "vertical",
                boxSizing: "border-box",
                ...mono,
              }}
            />
            <div style={{ fontSize: 10, color: C.tm, marginTop: 4 }}>
              Drop <code>keyfn.py</code> alongside <code>algos.js</code> and add an entry
              using the <code>fn</code> exported from this file. Tested against the
              verified vector above.
            </div>
          </div>
        )}
      </Card>

      {/* Step 4 — Verify with custom seed */}
      <Card style={{ marginBottom: 16 }}>
        {hdr("STEP 4 — VERIFY WITH CUSTOM SEED")}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label="Seed value (hex)">
              <Input value={verifySeed} onChange={setVerifySeed} placeholder="0x12345678" />
            </Field>
          </div>
          <Btn
            onClick={handleVerify}
            disabled={!fileB64 || !!busy}
            outline
            color={C.a3}
          >
            {busy === "verify" ? "Running…" : "Run emulation"}
          </Btn>
        </div>
        {verifyResult && (
          <div style={{ fontSize: 13, color: C.gn, ...mono }}>
            seed 0x{verifyResult.seed.toString(16).toUpperCase().padStart(8, "0")}
            {" → "}
            key &nbsp;0x{verifyResult.key.toString(16).toUpperCase().padStart(8, "0")}
          </div>
        )}
      </Card>

      {/* Advanced — raw emulate */}
      <Card style={{ marginBottom: 16 }}>
        {hdr("ADVANCED — RAW EMULATION (FULL REGISTER + MEMORY DUMP)")}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
          <Field label={'Initial registers (JSON) — e.g. {"r2": 100}'}>

            <textarea
              value={emuRegs}
              onChange={(e) => setEmuRegs(e.target.value)}
              rows={4}
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 8,
                border: `1.5px solid ${C.bd}`,
                background: C.c2,
                color: C.tx,
                resize: "vertical",
                boxSizing: "border-box",
                ...mono,
              }}
            />
          </Field>
          <Field label={'Memory dump (JSON) — e.g. {"0x2000": 64}'}>

            <textarea
              value={emuDump}
              onChange={(e) => setEmuDump(e.target.value)}
              rows={4}
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 8,
                border: `1.5px solid ${C.bd}`,
                background: C.c2,
                color: C.tx,
                resize: "vertical",
                boxSizing: "border-box",
                ...mono,
              }}
            />
          </Field>
        </div>
        <Btn
          onClick={handleEmulate}
          disabled={!fileB64 || !!busy}
          outline
          color={C.a4}
        >
          {busy === "emulate" ? "Running…" : "▶ Run raw emulation"}
        </Btn>

        {emuResult && (
          <div style={{ marginTop: 14 }}>
            {emuResult.ok && (
              <div style={{ fontSize: 11, color: C.gn, marginBottom: 6 }}>
                ✓ {emuResult.steps} instructions executed
              </div>
            )}
            <div style={{ fontSize: 11, fontWeight: 700, color: C.ts, marginBottom: 4 }}>
              Registers
            </div>
            <div
              style={{
                maxHeight: 180,
                overflow: "auto",
                background: "#1A1A2E",
                borderRadius: 8,
                padding: 10,
                marginBottom: 10,
              }}
            >
              {emuResult.regs &&
                Object.entries(emuResult.regs).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", gap: 8, ...mono, fontSize: 11, color: "#C8E6FF" }}>
                    <span style={{ color: "#88CCFF", minWidth: 40 }}>{k}</span>
                    <span>{String(v)}</span>
                  </div>
                ))}
            </div>
            {Object.keys(emuResult.dumps || {}).length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.ts, marginBottom: 4 }}>
                  Memory dumps
                </div>
                {Object.entries(emuResult.dumps).map(([addr, hex]) => (
                  <div key={addr} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: C.ts, marginBottom: 2 }}>{addr}</div>
                    <div
                      style={{
                        background: "#1A1A2E",
                        borderRadius: 8,
                        padding: "8px 10px",
                        ...mono,
                        fontSize: 11,
                        color: "#C8E6FF",
                        wordBreak: "break-all",
                      }}
                    >
                      {String(hex)}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Card>

      {error && (
        <Card style={{ background: C.er + "10", borderColor: C.er + "40" }}>
          <div style={{ fontSize: 12, color: C.er, fontWeight: 700 }}>Error</div>
          <div style={{ fontSize: 11, color: C.ts, marginTop: 4, ...mono, whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        </Card>
      )}
    </div>
  );
}
