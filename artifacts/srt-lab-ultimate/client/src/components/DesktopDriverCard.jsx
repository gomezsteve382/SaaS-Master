import React, { useState, useEffect } from "react";
import { C } from "@/lib/srt/constants.js";
import { Card, Tag } from "@/lib/srt/ui.jsx";
import { QR_CMDS } from "@/lib/srt/quickRef.js";
import { buildQuickReferencePDF } from "@/lib/srt/buildQuickReferencePDF.js";
import { ASSET_IDS } from "@/lib/srt/downloadAssets.js";
import { useDownloadCount, DownloadCounter } from "@/lib/srt/useDownloadCount.jsx";

/* Desktop driver download card. Shown on the DUMPS tab; previously inlined
 * inside App.jsx, extracted as part of the SRT Lab deep-cleanup so the App
 * shell stays small. */
export default function DesktopDriverCard() {
  const cmds = QR_CMDS.map(c => c[0]);
  const [man, setMan] = useState(null);
  const [showCl, setShowCl] = useState(false);
  const [dlCount, trackDl] = useDownloadCount(ASSET_IDS.desktopDriver);
  const [, trackPdf] = useDownloadCount(ASSET_IDS.quickRefPdf);
  const [copied, setCopied] = useState(null);
  const [hover, setHover] = useState(null);
  const [focus, setFocus] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    const base = import.meta.env.BASE_URL || "/";
    fetch(base + "srt_lab.manifest.json", { cache: "no-cache" })
      .then(r => (r.ok ? r.json() : null))
      .then(setMan)
      .catch(() => {});
  }, []);

  const onDl = () => { trackDl(); };
  const onPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try { await buildQuickReferencePDF(); trackPdf(); }
    catch (e) { console.error(e); alert("PDF build failed: " + e.message); }
    finally { setPdfBusy(false); }
  };
  const sizeMB = man ? (man.sizeBytes / (1024 * 1024)).toFixed(2) : null;
  const copy = async (text, key) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else {
        const t = document.createElement("textarea");
        t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
        document.body.appendChild(t); t.select(); document.execCommand("copy");
        document.body.removeChild(t);
      }
      setCopied(key); setTimeout(() => setCopied(c => (c === key ? null : c)), 1500);
    } catch { setCopied("err"); setTimeout(() => setCopied(null), 1500); }
  };

  const btnStyle = { background: "transparent", border: "1px solid #444", color: "#A5D6A7", borderRadius: 5, padding: "1px 6px", fontSize: 9, fontFamily: "'JetBrains Mono'", cursor: "pointer", letterSpacing: .5 };

  return <Card style={{ padding: 18 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
      <span style={{ fontSize: 18 }}>🖥️</span>
      <span style={{ fontSize: 13, fontWeight: 900, letterSpacing: 1, color: C.bk }}>DESKTOP DRIVER</span>
      <Tag color={C.a3}>WINDOWS</Tag>
      {man && <Tag color={C.a1}>v{man.version}</Tag>}
    </div>
    {man && <div style={{ fontSize: 11, color: C.ts, marginBottom: 8, fontFamily: "'JetBrains Mono'", letterSpacing: .3 }}>
      v{man.version} · {sizeMB} MB · last updated {man.lastUpdated}
    </div>}
    <div style={{ fontSize: 12, color: C.ts, lineHeight: 1.5, marginBottom: 12 }}>Windows · J2534 · Autel IM608 — direct PassThru DLL driver. No WebSerial, no ELM327. Full UDS stack, 17 FCA security algorithms, BCM auto-discovery, one-shot VIN write.</div>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
      <a href={(import.meta.env.BASE_URL || "/") + "srt_lab.py"} download="srt_lab.py" onClick={onDl} style={{ textDecoration: "none" }}>
        <span style={{ display: "inline-block", padding: "10px 18px", borderRadius: 10, background: C.sr, color: "#fff", fontWeight: 800, fontSize: 12, letterSpacing: .5, fontFamily: "'Nunito'" }}>⬇ Download srt_lab.py</span>
      </a>
      <button onClick={onPdf} disabled={pdfBusy} style={{ cursor: pdfBusy ? "wait" : "pointer", border: "2px solid " + C.sr, padding: "8px 16px", borderRadius: 10, background: "#fff", color: C.sr, fontWeight: 800, fontSize: 12, letterSpacing: .5, fontFamily: "'Nunito'" }}>
        {pdfBusy ? "⏳ Building..." : "⬇ Download Quick Reference (PDF)"}
      </button>
    </div>
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 8 }}>
      {dlCount > 0 && <span style={{ fontSize: 10, color: C.tm, letterSpacing: .3, fontWeight: 600 }}>⬇ {dlCount.toLocaleString()} driver download{dlCount === 1 ? "" : "s"} globally</span>}
      <DownloadCounter assetId={ASSET_IDS.quickRefPdf}/>
    </div>
    {man && man.changelog && man.changelog.length > 0 && <div style={{ marginBottom: 10 }}>
      <button onClick={() => setShowCl(s => !s)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 10, fontWeight: 800, color: C.a3, letterSpacing: .5 }}>
        {showCl ? "▼" : "▶"} RECENT CHANGES
      </button>
      {showCl && <div style={{ marginTop: 8, borderLeft: "2px solid " + C.bd, paddingLeft: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {man.changelog.slice(0, 3).map((e, i) => <div key={i}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.bk, fontFamily: "'JetBrains Mono'" }}>v{e.version} <span style={{ color: C.tm, fontWeight: 600, marginLeft: 4 }}>{e.date}</span></div>
          <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.4, marginTop: 2 }}>{e.notes}</div>
        </div>)}
      </div>}
    </div>}
    <div style={{ fontSize: 10, color: C.tm, marginBottom: 8, letterSpacing: .5 }}>REQUIREMENTS: Windows 10/11 · Python 3.8+ · J2534 vendor drivers (no pip packages)</div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1 }}>QUICK START</div>
      <button type="button" onClick={() => copy(cmds.join("\n"), "all")} style={{ ...btnStyle, color: C.tm, borderColor: "#ddd", background: "#fff" }}>{copied === "all" ? "✓ Copied all" : "⧉ Copy all"}</button>
    </div>
    <div style={{ background: C.bk, borderRadius: 8, padding: 10, fontFamily: "'JetBrains Mono'", fontSize: 11, color: "#A5D6A7", lineHeight: 1.7 }}>
      {cmds.map((c, i) => {
        const isVisible = hover === i || focus === i || copied === i;
        const isCopied = copied === i;
        return <div key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(h => (h === i ? null : h))} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22 }}>
          <div style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <span style={{ color: "#666" }}>$ </span>{c}
          </div>
          <button type="button" onClick={() => copy(c, i)} onFocus={() => setFocus(i)} onBlur={() => setFocus(f => (f === i ? null : f))} aria-label={"Copy command: " + c} title="Copy command" style={{ ...btnStyle, opacity: isVisible ? 1 : 0.001, transition: "opacity 120ms" }}>{isCopied ? "✓ Copied!" : "⧉ Copy"}</button>
        </div>;
      })}
    </div>
  </Card>;
}
