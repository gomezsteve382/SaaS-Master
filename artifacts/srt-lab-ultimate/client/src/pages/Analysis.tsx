import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Binary,
  Copy,
  Check,
  RefreshCw,
  FileDown,
  MessageCircle,
  Send,
  Cpu,
  Loader2,
  AlertTriangle,
  Code2,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolCallTrace {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
}

interface AnalysisData {
  id: string;
  filename: string;
  fileSize: number;
  fileType: string;
  timestamp: number;
  status: string;
  analysisPass?: number;
  analysisMode?: string;
  dissectionReport?: string;
  toolCallTrace?: ToolCallTrace[];
  findings: {
    summary: string;
    algorithms: any[];
    seedKeys: any[];
    canAddresses: any[];
    checksums: any[];
    memoryMaps: any[];
    strings: any[];
    cryptoConstants: any[];
    securityBytes: any[];
    deepFindings?: any[];
  };
  rawHex: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Analysis() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<string | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  useEffect(() => {
    if (params.id) fetchAnalysis(params.id);
  }, [params.id]);

  useEffect(() => {
    if (!analysis || analysis.status !== "running") return;
    const interval = setInterval(() => {
      if (params.id) fetchAnalysis(params.id);
    }, 3000);
    return () => clearInterval(interval);
  }, [analysis?.status, params.id]);

  const fetchAnalysis = async (id: string) => {
    try {
      const res = await fetch(`/api/analysis/${id}`);
      if (res.status === 404) {
        setFetchError("This analysis no longer exists.");
        setLoading(false);
        setTimeout(() => navigate("/"), 3000);
        return;
      }
      if (!res.ok) {
        let msg = `Server error (${res.status})`;
        try { const body = await res.json(); msg = body.error || msg; } catch {}
        setFetchError(msg);
        setLoading(false);
        return;
      }
      setAnalysis(await res.json());
    } catch (e: any) {
      setFetchError(e.message || "Failed to load analysis");
    }
    setLoading(false);
  };

  const handleRerun = async () => {
    if (!params.id) return;
    setRerunning(true);
    setRerunError(null);
    try {
      const res = await fetch(`/api/analysis/${params.id}/rerun`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setRerunError(data.error || "Re-run failed");
      else setTimeout(() => window.location.reload(), 800);
    } catch (err: any) {
      setRerunError(err.message || "Re-run failed");
    }
    setRerunning(false);
  };

  const handleReanalyze = async () => {
    if (!params.id) return;
    setReanalyzing(true);
    try {
      const res = await fetch(`/api/analysis/${params.id}/reanalyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) setAnalysis(data);
    } catch {}
    setReanalyzing(false);
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(id);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  // ─── Loading / Error States ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="text-center space-y-4">
          <Cpu className="w-8 h-8 text-primary animate-pulse mx-auto" />
          <p className="text-muted-foreground text-sm">Loading analysis...</p>
        </div>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="text-center space-y-4 max-w-md px-4">
          <AlertTriangle className="w-8 h-8 text-destructive mx-auto" />
          <p className="text-muted-foreground text-sm">{fetchError || "Analysis not found."}</p>
          <Button onClick={() => navigate("/")} size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        </div>
      </div>
    );
  }

  if (analysis.status === "running" || analysis.status === "failed") {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="text-center space-y-4 max-w-md px-4">
          {analysis.status === "running" ? (
            <>
              <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto" />
              <p className="text-foreground font-semibold">Analysis in progress...</p>
              <p className="text-muted-foreground text-sm">Agents are dissecting {analysis.filename}</p>
            </>
          ) : (
            <>
              <AlertTriangle className="w-10 h-10 text-destructive mx-auto" />
              <p className="text-foreground font-semibold">Analysis failed</p>
              <Button onClick={handleRerun} size="sm" className="mt-2">
                <RefreshCw className="w-4 h-4 mr-1" /> Retry
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ─── Data ───────────────────────────────────────────────────────────────────

  const findings = {
    algorithms: analysis.findings?.algorithms || [],
    seedKeys: analysis.findings?.seedKeys || [],
    canAddresses: analysis.findings?.canAddresses || [],
    checksums: analysis.findings?.checksums || [],
    memoryMaps: analysis.findings?.memoryMaps || [],
    strings: analysis.findings?.strings || [],
    cryptoConstants: analysis.findings?.cryptoConstants || [],
    securityBytes: analysis.findings?.securityBytes || [],
  };

  // ─── COMPREHENSIVE EXTRACTION VIEW ──────────────────────────────────────────

  return (
    <div className="space-y-6 -m-8 min-h-full">
      {/* ─── Sticky Header Bar ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-md border-b border-border/40 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-3 min-w-0">
              <Binary className="w-5 h-5 text-primary shrink-0" />
              <h1 className="font-mono font-bold text-lg truncate">{analysis.filename}</h1>
            </div>
            <Badge variant="outline" className="text-xs shrink-0">
              {analysis.fileType} · {(analysis.fileSize / 1024).toFixed(1)} KB
            </Badge>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => navigate(`/hex/${analysis.id}`)} className="gap-1.5 text-xs border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10">
              <Binary className="w-4 h-4" /> Hex
            </Button>
            <Button variant="outline" size="sm" onClick={() => {
              const a = document.createElement("a");
              a.href = `/api/analysis/${analysis.id}/export/pdf`;
              a.download = `srtlab-report-${(analysis.filename || analysis.id).replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.pdf`;
              a.click();
            }} className="gap-1.5 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10">
              <FileDown className="w-4 h-4" /> PDF
            </Button>
            <Button variant="outline" size="sm" onClick={() => {
              const a = document.createElement("a");
              a.href = `/api/analysis/${analysis.id}/export/json`;
              a.download = `srtlab-report.json`;
              a.click();
            }} className="gap-1.5 text-xs">
              <FileDown className="w-4 h-4" /> JSON
            </Button>
            <Button variant="outline" size="sm" onClick={handleReanalyze} disabled={reanalyzing} className="gap-1.5 text-xs border-primary/30 text-primary hover:bg-primary/10">
              <RefreshCw className={`w-4 h-4 ${reanalyzing ? "animate-spin" : ""}`} /> Re-analyze
            </Button>
            <Button variant="outline" size="sm" onClick={handleRerun} disabled={rerunning} className="gap-1.5 text-xs border-orange-500/30 text-orange-400 hover:bg-orange-500/10">
              <RefreshCw className={`w-4 h-4 ${rerunning ? "animate-spin" : ""}`} /> Re-run
            </Button>
          </div>
        </div>
        {rerunError && (
          <div className="mt-2 bg-destructive/10 border border-destructive/30 rounded px-4 py-2 text-xs text-destructive flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Re-run failed: {rerunError}</span>
            <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setRerunError(null)}>✕</button>
          </div>
        )}
      </header>

      {/* ─── MAIN CONTENT: RAW EXTRACTION DETAILS ──────────────────────────── */}
      <div className="px-6 space-y-8">

        {/* ─── Algorithms ─────────────────────────────────────────────────────── */}
        {findings.algorithms.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Cpu className="w-5 h-5 text-primary" />
              Algorithms ({findings.algorithms.length})
            </h2>
            <div className="space-y-3">
              {findings.algorithms.map((alg: any, i: number) => (
                <div key={i} className="bg-card/60 border border-border/30 rounded-lg p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[15px] font-bold text-primary">{alg.name || alg.type}</span>
                    <button
                      onClick={() => copyToClipboard(JSON.stringify(alg, null, 2), `alg-${i}`)}
                      className="p-1.5 rounded bg-zinc-800/80 hover:bg-zinc-700 transition-colors"
                    >
                      {copiedIdx === `alg-${i}` ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                    </button>
                  </div>
                  {alg.description && <p className="text-[14px] text-foreground/80 leading-relaxed">{alg.description}</p>}
                  {alg.pseudocode && (
                    <pre className="text-[13px] font-mono bg-black/40 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap text-green-400/90 border border-green-500/10">
                      {alg.pseudocode}
                    </pre>
                  )}
                  {alg.offset && <span className="text-xs text-zinc-500 font-mono">Offset: {alg.offset}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ─── Seed-Key Algorithms ────────────────────────────────────────────── */}
        {findings.seedKeys.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Code2 className="w-5 h-5 text-amber-400" />
              Seed-Key Algorithms ({findings.seedKeys.length})
            </h2>
            <div className="space-y-3">
              {findings.seedKeys.map((sk: any, i: number) => (
                <div key={i} className="bg-card/60 border border-amber-500/20 rounded-lg p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[15px] font-bold text-amber-400">{sk.module || sk.name}</span>
                    <button
                      onClick={() => copyToClipboard(JSON.stringify(sk, null, 2), `sk-${i}`)}
                      className="p-1.5 rounded bg-zinc-800/80 hover:bg-zinc-700 transition-colors"
                    >
                      {copiedIdx === `sk-${i}` ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                    </button>
                  </div>
                  {sk.algorithm && <p className="text-[14px] text-foreground/80 leading-relaxed">{sk.algorithm}</p>}
                  {sk.securityLevel && <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400">Level {sk.securityLevel}</Badge>}
                  {sk.pseudocode && (
                    <pre className="text-[13px] font-mono bg-black/40 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap text-amber-300/80 border border-amber-500/10">
                      {sk.pseudocode}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ─── CAN Addresses ──────────────────────────────────────────────────── */}
        {findings.canAddresses.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Binary className="w-5 h-5 text-cyan-400" />
              CAN Bus Addresses ({findings.canAddresses.length})
            </h2>
            <div className="bg-card/60 border border-border/30 rounded-lg overflow-hidden">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b border-border/30 bg-muted/20">
                    <th className="text-left px-5 py-3 font-semibold text-muted-foreground">Module</th>
                    <th className="text-left px-5 py-3 font-semibold text-muted-foreground">TX ID</th>
                    <th className="text-left px-5 py-3 font-semibold text-muted-foreground">RX ID</th>
                    <th className="text-left px-5 py-3 font-semibold text-muted-foreground">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.canAddresses.map((c: any, i: number) => (
                    <tr key={i} className="border-b border-border/10 hover:bg-muted/10 transition-colors">
                      <td className="px-5 py-3 font-mono font-bold text-cyan-400">{c.module}</td>
                      <td className="px-5 py-3 font-mono text-foreground/80">{c.txId}</td>
                      <td className="px-5 py-3 font-mono text-foreground/80">{c.rxId}</td>
                      <td className="px-5 py-3 text-muted-foreground">{c.description || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ─── Security Bytes ─────────────────────────────────────────────────── */}
        {findings.securityBytes.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Binary className="w-5 h-5 text-red-400" />
              Security Bytes ({findings.securityBytes.length})
            </h2>
            <div className="bg-card/60 border border-border/30 rounded-lg overflow-hidden">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b border-border/30 bg-muted/20">
                    <th className="text-left px-5 py-3 font-semibold text-muted-foreground">Module</th>
                    <th className="text-left px-5 py-3 font-semibold text-muted-foreground">Offset</th>
                    <th className="text-left px-5 py-3 font-semibold text-muted-foreground">Value</th>
                    <th className="text-left px-5 py-3 font-semibold text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.securityBytes.map((sb: any, i: number) => (
                    <tr key={i} className="border-b border-border/10 hover:bg-muted/10 transition-colors">
                      <td className="px-5 py-3 font-mono font-bold text-red-400">{sb.module}</td>
                      <td className="px-5 py-3 font-mono text-foreground/80">{sb.offset}</td>
                      <td className="px-5 py-3 font-mono text-foreground/80">{sb.value || "—"}</td>
                      <td className="px-5 py-3">
                        <Badge variant="outline" className="text-xs">{sb.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ─── Checksums ──────────────────────────────────────────────────────── */}
        {findings.checksums.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Binary className="w-5 h-5 text-emerald-400" />
              Checksums ({findings.checksums.length})
            </h2>
            <div className="space-y-3">
              {findings.checksums.map((cs: any, i: number) => (
                <div key={i} className="bg-card/60 border border-emerald-500/20 rounded-lg p-5 space-y-2">
                  <span className="font-mono text-[15px] font-bold text-emerald-400">{cs.type || cs.name || `Checksum ${i + 1}`}</span>
                  {cs.description && <p className="text-[14px] text-foreground/70">{cs.description}</p>}
                  {cs.offset && <span className="text-xs text-zinc-500 font-mono">@{cs.offset}</span>}
                  {cs.value && <span className="text-xs text-zinc-400 font-mono ml-2">= {cs.value}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ─── Crypto Constants ───────────────────────────────────────────────── */}
        {findings.cryptoConstants.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Code2 className="w-5 h-5 text-violet-400" />
              Crypto Constants ({findings.cryptoConstants.length})
            </h2>
            <div className="bg-card/60 border border-violet-500/20 rounded-lg p-5">
              <pre className="text-[13px] font-mono overflow-x-auto whitespace-pre-wrap text-violet-300/90">
                {findings.cryptoConstants.map((cc: any) => 
                  typeof cc === 'string' ? cc : JSON.stringify(cc, null, 2)
                ).join('\n')}
              </pre>
            </div>
          </section>
        )}

        {/* ─── Strings (All Categories) ──────────────────────────────────────── */}
        {findings.strings.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Code2 className="w-5 h-5 text-green-400" />
              Extracted Strings ({findings.strings.length})
            </h2>
            <div className="bg-card/60 border border-green-500/20 rounded-lg p-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {findings.strings.map((s: any, i: number) => (
                  <div key={i} className="font-mono text-[13px] bg-green-500/5 border border-green-500/15 rounded px-3 py-2 text-green-200/90 break-words">
                    {typeof s === 'string' ? s : JSON.stringify(s)}
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ─── ActionScript Classes (SWF only) ────────────────────────────────── */}
        {analysis.fileType === 'SWF' && <SwfClassesFull analysis={analysis} copyToClipboard={copyToClipboard} copiedIdx={copiedIdx} />}

        {/* ─── Tool Call Trace (Raw Output) ──────────────────────────────────── */}
        {(analysis.toolCallTrace || []).length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Code2 className="w-5 h-5 text-green-400" />
              Tool Call Trace ({(analysis.toolCallTrace || []).length})
            </h2>
            <div className="space-y-3">
              {(analysis.toolCallTrace || []).map((tc, i) => (
                <div key={i} className="bg-card/60 border border-green-500/10 rounded-lg overflow-hidden">
                  <div className="flex items-center gap-3 px-5 py-3 bg-green-500/5 border-b border-green-500/10">
                    <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                    <span className="font-mono text-[14px] font-bold text-green-400">{tc.toolName}</span>
                    <span className="text-xs text-muted-foreground">{tc.durationMs}ms</span>
                  </div>
                  {tc.result && (
                    <pre className="text-[13px] font-mono p-5 overflow-x-auto whitespace-pre-wrap text-foreground/80 max-h-[600px] overflow-y-auto">
                      {tc.result}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ─── Chat Section (Full Width) ──────────────────────────────────────── */}
        <section className="border-t border-border/30 pt-8">
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2 mb-4">
            <MessageCircle className="w-5 h-5 text-primary" />
            Ask VENOM
          </h2>
          <div className="bg-card/60 border border-border/30 rounded-lg overflow-hidden">
            <VenomChat analysisId={analysis.id} filename={analysis.filename} />
          </div>
        </section>

      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── SWF ActionScript Classes (Full Display) ─────────────────────────────────

function SwfClassesFull({ analysis, copyToClipboard, copiedIdx }: { analysis: AnalysisData; copyToClipboard: (text: string, id: string) => void; copiedIdx: string | null }) {
  const swfTrace = (analysis.toolCallTrace || []).find(t => t.toolName === 'swf_extract');
  if (!swfTrace?.result) return null;
  const raw = swfTrace.result;

  const classSection = raw.match(/=== (?:Package\/Class Names|Chrysler\/DCC Class Names) \((\d+).*?\) ===([\s\S]*?)(?===|$)/);
  const classLines = classSection ? classSection[2].split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
  const secSection = raw.match(/=== Security-Related Strings \((\d+)\) ===([\s\S]*?)(?===|$)/);
  const secLines = secSection ? secSection[2].split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
  const diagSection = raw.match(/=== Diagnostic \/ Automotive Strings \((\d+)\) ===([\s\S]*?)(?===|$)/);
  const diagLines = diagSection ? diagSection[2].split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
  const methodSection = raw.match(/=== Method \/ Variable Names \((\d+).*?\) ===([\s\S]*?)(?===|$)/);
  const methodLines = methodSection ? methodSection[2].split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];

  const pkgMap: Record<string, string[]> = {};
  for (const cls of classLines) {
    const parts = cls.split('.');
    const pkg = parts.slice(0, -1).join('.') || '(root)';
    const name = parts[parts.length - 1];
    if (!pkgMap[pkg]) pkgMap[pkg] = [];
    pkgMap[pkg].push(name);
  }
  const pkgEntries = Object.entries(pkgMap).sort((a, b) => a[0].localeCompare(b[0]));

  const headerMatch = raw.match(/SWF Header: (.+)/);
  const headerInfo = headerMatch ? headerMatch[1] : '';
  const decompMatch = raw.match(/Decompressed payload: (.+)/);
  const decompInfo = decompMatch ? decompMatch[1] : '';

  if (classLines.length === 0 && secLines.length === 0) return null;

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
        <Code2 className="w-5 h-5 text-blue-400" />
        ActionScript Classes ({classLines.length} classes · {pkgEntries.length} packages)
      </h2>

      {/* SWF Header Info */}
      {headerInfo && (
        <div className="font-mono text-[13px] text-zinc-300 bg-black/40 rounded-lg p-5 border border-border/20">
          <span className="text-primary font-semibold">Header:</span> {headerInfo}
          {decompInfo && <><br /><span className="text-primary font-semibold">Payload:</span> {decompInfo}</>}
        </div>
      )}

      {/* Package Tree — All Expanded */}
      {pkgEntries.length > 0 && (
        <div className="space-y-2">
          {pkgEntries.map(([pkg, classes]) => {
            const isHot = /security|crypto|aes|crypt|key|unlock|gateway|auth|seed/i.test(pkg);
            const isAuto = /chrysler|fca|witech|cda|diagnostic|can|uds|obd/i.test(pkg);
            return (
              <div key={pkg} className={`rounded-lg border p-4 ${isHot ? 'border-amber-500/30 bg-amber-500/5' : isAuto ? 'border-cyan-500/30 bg-cyan-500/5' : 'border-border/20 bg-card/40'}`}>
                <div className="flex items-center gap-3 mb-3">
                  <Code2 className={`w-4 h-4 shrink-0 ${isHot ? 'text-amber-400' : isAuto ? 'text-cyan-400' : 'text-primary/60'}`} />
                  <span className={`font-mono text-[13px] font-bold ${isHot ? 'text-amber-300' : isAuto ? 'text-cyan-300' : 'text-zinc-200'}`}>{pkg}</span>
                  <Badge variant="secondary" className="text-xs">{classes.length}</Badge>
                  <button
                    onClick={() => copyToClipboard(classes.join('\n'), `pkg-${pkg}`)}
                    className="ml-auto p-1.5 rounded bg-zinc-800/60 hover:bg-zinc-700 transition-colors"
                    title="Copy all classes"
                  >
                    {copiedIdx === `pkg-${pkg}` ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {classes.map((cls, i) => (
                    <span key={i} className={`font-mono text-[12px] rounded px-2 py-1 border ${
                      /security|crypto|aes|crypt|key|unlock|gateway|auth|seed/i.test(cls) ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' :
                      /command|service|manager|engine|controller|handler/i.test(cls) ? 'bg-violet-500/10 border-violet-500/30 text-violet-300' :
                      'bg-zinc-800/60 border-zinc-700/40 text-zinc-300'
                    }`}>{cls}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Security Strings — Full List */}
      {secLines.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Binary className="w-4 h-4 text-amber-400" />
            <h3 className="font-semibold text-[15px] text-amber-300">Security-Related Strings ({secLines.length})</h3>
            <button
              onClick={() => copyToClipboard(secLines.join('\n'), 'sec-strings')}
              className="ml-auto p-1.5 rounded bg-zinc-800/60 hover:bg-zinc-700 transition-colors"
              title="Copy all"
            >
              {copiedIdx === 'sec-strings' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
            </button>
          </div>
          <div className="bg-card/40 border border-amber-500/20 rounded-lg p-4 max-h-[500px] overflow-y-auto">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {secLines.map((s, i) => (
                <div key={i} className="font-mono text-[13px] bg-amber-500/5 border border-amber-500/15 rounded px-3 py-1.5 text-amber-200/90">{s}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Diagnostic Strings — Full List */}
      {diagLines.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Binary className="w-4 h-4 text-cyan-400" />
            <h3 className="font-semibold text-[15px] text-cyan-300">Diagnostic / Automotive Strings ({diagLines.length})</h3>
            <button
              onClick={() => copyToClipboard(diagLines.join('\n'), 'diag-strings')}
              className="ml-auto p-1.5 rounded bg-zinc-800/60 hover:bg-zinc-700 transition-colors"
              title="Copy all"
            >
              {copiedIdx === 'diag-strings' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
            </button>
          </div>
          <div className="bg-card/40 border border-cyan-500/20 rounded-lg p-4 max-h-[500px] overflow-y-auto">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {diagLines.map((s, i) => (
                <div key={i} className="font-mono text-[13px] bg-cyan-500/5 border border-cyan-500/15 rounded px-3 py-1.5 text-cyan-200/90">{s}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Method Names — Full List */}
      {methodLines.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Code2 className="w-4 h-4 text-violet-400" />
            <h3 className="font-semibold text-[15px] text-violet-300">Methods / Variables ({methodLines.length})</h3>
            <button
              onClick={() => copyToClipboard(methodLines.join('\n'), 'method-names')}
              className="ml-auto p-1.5 rounded bg-zinc-800/60 hover:bg-zinc-700 transition-colors"
              title="Copy all"
            >
              {copiedIdx === 'method-names' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
            </button>
          </div>
          <div className="bg-card/40 border border-violet-500/20 rounded-lg p-4 max-h-[500px] overflow-y-auto">
            <div className="flex flex-wrap gap-1.5">
              {methodLines.map((m, i) => (
                <span key={i} className="font-mono text-[13px] bg-violet-500/10 border border-violet-500/20 rounded px-2 py-1 text-violet-300/90">{m}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── VENOM Chat (Full Width) ─────────────────────────────────────────────────

function VenomChat({ analysisId, filename }: { analysisId: string; filename: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (historyLoaded) return;
    fetch(`/api/analysis/${analysisId}/chat/history`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data) => {
        if (data.messages && data.messages.length > 0) {
          setMessages(data.messages.map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content })));
        }
        setHistoryLoaded(true);
      })
      .catch(() => setHistoryLoaded(true));
  }, [analysisId, historyLoaded]);

  const scrollToBottom = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };

  useEffect(() => { scrollToBottom(); }, [messages]);

  const adjustTextarea = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  };

  const sendMessage = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setLoading(true);

    const userMsg: ChatMessage = { role: "user", content: msg };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);

    const history = newMessages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
    const assistantMsg: ChatMessage = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    try {
      const response = await fetch(`/api/analysis/${analysisId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, history: history.slice(0, -1) }),
      });

      if (!response.ok || !response.body) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { ...assistantMsg, content: "Request failed. Try again." };
          return updated;
        });
        setLoading(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            lastEvent = line.replace("event: ", "").trim();
          } else if (line.startsWith("data: ")) {
            const dataStr = line.replace("data: ", "").trim();
            if (!dataStr) continue;
            try {
              const data = JSON.parse(dataStr);
              if (lastEvent === "message") {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last.role === "assistant") {
                    updated[updated.length - 1] = { ...last, content: data.text || "" };
                  }
                  return updated;
                });
              }
            } catch {}
          }
        }
      }
    } catch (err: any) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { ...assistantMsg, content: `Error: ${err.message}` };
        return updated;
      });
    }

    setLoading(false);
  };

  return (
    <div className="flex flex-col" style={{ minHeight: "500px", maxHeight: "800px" }}>
      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-6 py-6" ref={scrollRef}>
        <div className="space-y-5">
          {/* Empty State */}
          {messages.length === 0 && (
            <div className="text-center py-12 space-y-5">
              <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center border border-primary/20">
                <MessageCircle className="w-8 h-8 text-primary" />
              </div>
              <div className="space-y-2">
                <h2 className="text-lg font-bold">Ask about <span className="text-primary font-mono">{filename}</span></h2>
                <p className="text-muted-foreground text-sm max-w-lg mx-auto">
                  VENOM has full context. Ask anything — it can run tools in real-time to dig deeper.
                </p>
              </div>
            </div>
          )}

          {/* Chat Messages */}
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-6 py-4 text-[14px] leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/30 border border-border/40 text-foreground"
              }`}>
                <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Input Bar */}
      <div className="border-t border-border/30 bg-muted/10 px-6 py-4 shrink-0">
        <div className="flex gap-3 items-end">
          <textarea
            ref={textareaRef}
            className="flex-1 bg-background border border-border/40 rounded-lg px-5 py-3 text-[14px] outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground resize-none min-h-[48px] max-h-[200px]"
            placeholder="Ask VENOM anything..."
            value={input}
            onChange={(e) => { setInput(e.target.value); adjustTextarea(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            disabled={loading}
            rows={1}
          />
          <Button
            size="lg"
            onClick={() => sendMessage()}
            disabled={loading || !input.trim()}
            className="shrink-0 rounded-lg px-5 h-12"
          >
            {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
