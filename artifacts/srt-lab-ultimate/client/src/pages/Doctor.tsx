import { useState, useCallback } from "react";
import { Stethoscope, CheckCircle, XCircle, AlertCircle, RefreshCw, Loader2, Terminal, Cpu, Shield, Zap, Satellite, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface ToolStatus {
  name: string;
  available: boolean;
  version: string | null;
  error: string | null;
}

interface DoctorResult {
  generatedAt: string;
  tools: ToolStatus[];
}

interface ProbeStep {
  step: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  durationMs: number;
}

interface ProbeResult {
  success: boolean;
  steps: ProbeStep[];
  gcpResponse?: any;
  totalDurationMs: number;
  summary?: string;
}

const TOOL_CATEGORIES: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  yara: { label: "YARA Scanner", icon: Shield, color: "text-emerald-400" },
  binwalk: { label: "Binwalk", icon: Cpu, color: "text-blue-400" },
  strings: { label: "Strings", icon: Terminal, color: "text-amber-400" },
  file: { label: "File", icon: Terminal, color: "text-amber-400" },
  xxd: { label: "xxd (Hex Dump)", icon: Terminal, color: "text-purple-400" },
  objdump: { label: "objdump", icon: Cpu, color: "text-blue-400" },
  readelf: { label: "readelf", icon: Cpu, color: "text-blue-400" },
  nm: { label: "nm (Symbol Table)", icon: Cpu, color: "text-blue-400" },
  python3: { label: "Python 3", icon: Zap, color: "text-yellow-400" },
  node: { label: "Node.js", icon: Zap, color: "text-green-400" },
};

const STEP_LABELS: Record<string, string> = {
  generate_test_binary: "Generate 1KB Test Binary",
  check_gcp_url: "Check GCP URL Configuration",
  send_to_gcp: "Send Bytes to GCP",
  verify_bytes_integrity: "Verify Byte Integrity",
  inner_hash_check: "Inner Hash Validation",
  probe_error: "Probe Error",
};

export default function Doctor() {
  const [result, setResult] = useState<DoctorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const { toast } = useToast();

  const runDiagnostics = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/doctor");
      if (!r.ok) throw new Error(await r.text());
      setResult(await r.json());
    } catch (e: any) {
      toast({ title: "Diagnostics failed", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const runGcpProbe = useCallback(async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      const r = await fetch("/api/doctor/probe-gcp", { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setProbeResult(data);
      if (data.success) {
        toast({ title: "GCP Probe Passed", description: data.summary });
      } else {
        const failedStep = data.steps.find((s: ProbeStep) => s.status === "fail");
        toast({ title: "GCP Probe Failed", description: failedStep?.detail || "Unknown failure", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "GCP Probe Error", description: e.message, variant: "destructive" });
      setProbeResult({ success: false, steps: [{ step: "probe_error", status: "fail", detail: e.message, durationMs: 0 }], totalDurationMs: 0 });
    } finally {
      setProbing(false);
    }
  }, [toast]);

  // Auto-run on mount
  useState(() => { runDiagnostics(); });

  const available = result?.tools.filter(t => t.available) ?? [];
  const missing = result?.tools.filter(t => !t.available) ?? [];
  const allGood = result && missing.length === 0;

  return (
    <div className="min-h-screen bg-background text-foreground p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <Stethoscope className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">System Doctor</h1>
            <p className="text-sm text-muted-foreground">Diagnostic check of all analysis tools, dependencies, and GCP connectivity</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={runDiagnostics} disabled={loading} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Re-run Diagnostics
        </Button>
      </div>

      {/* Status Summary */}
      {result && (
        <Card className={`border ${allGood ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              {allGood ? (
                <CheckCircle className="w-6 h-6 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-6 h-6 text-amber-400 shrink-0" />
              )}
              <div>
                <p className="font-medium text-foreground">
                  {allGood
                    ? "All systems operational"
                    : `${available.length} of ${result.tools.length} tools available`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Last checked: {new Date(result.generatedAt).toLocaleString()}
                </p>
              </div>
              <div className="ml-auto flex gap-2">
                <Badge variant="outline" className="text-xs border-emerald-500/30 text-emerald-400">
                  {available.length} OK
                </Badge>
                {missing.length > 0 && (
                  <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">
                    {missing.length} Missing
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading State */}
      {loading && !result && (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
            <p className="text-sm text-muted-foreground">Running diagnostics...</p>
          </div>
        </div>
      )}

      {/* GCP Byte Verification Probe */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-orange-500/10 border border-orange-500/20">
                <Satellite className="w-5 h-5 text-orange-400" />
              </div>
              <div>
                <CardTitle className="text-base">GCP Byte Verification Probe</CardTitle>
                <CardDescription className="text-xs mt-0.5">
                  Generates a 1KB test binary, sends it to the GCP swarm backend, and verifies byte-perfect delivery
                </CardDescription>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={runGcpProbe}
              disabled={probing}
              className="gap-2 border-orange-500/30 text-orange-400 hover:bg-orange-500/10"
            >
              {probing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Satellite className="w-4 h-4" />
              )}
              {probing ? "Probing..." : "Run GCP Probe"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Probe Steps */}
          {probing && !probeResult && (
            <div className="flex items-center gap-3 py-4 justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-orange-400" />
              <p className="text-sm text-muted-foreground">Sending test binary to GCP and verifying integrity...</p>
            </div>
          )}

          {probeResult && (
            <div className="space-y-2">
              {/* Overall Result Banner */}
              <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                probeResult.success
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-red-500/30 bg-red-500/5"
              }`}>
                {probeResult.success ? (
                  <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                )}
                <div className="flex-1">
                  <p className={`text-sm font-medium ${probeResult.success ? "text-emerald-400" : "text-red-400"}`}>
                    {probeResult.success ? "GCP Byte Verification PASSED" : "GCP Byte Verification FAILED"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Round-trip: {probeResult.totalDurationMs}ms
                  </p>
                </div>
                <Badge variant="outline" className={`text-xs ${
                  probeResult.success ? "border-emerald-500/30 text-emerald-400" : "border-red-500/30 text-red-400"
                }`}>
                  {probeResult.steps.filter(s => s.status === "pass").length}/{probeResult.steps.length} steps
                </Badge>
              </div>

              {/* Step-by-step breakdown */}
              <div className="space-y-1.5">
                {probeResult.steps.map((step, i) => (
                  <div key={i} className="flex items-start gap-2.5 py-1.5 px-2 rounded-md hover:bg-accent/30 transition-colors">
                    <div className="mt-0.5 shrink-0">
                      {step.status === "pass" ? (
                        <CheckCircle className="w-4 h-4 text-emerald-400" />
                      ) : step.status === "fail" ? (
                        <XCircle className="w-4 h-4 text-red-400" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-amber-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-foreground">
                          {STEP_LABELS[step.step] || step.step}
                        </span>
                        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className={`text-xs truncate ${
                          step.status === "pass" ? "text-emerald-400/80" : step.status === "fail" ? "text-red-400/80" : "text-amber-400/80"
                        }`}>
                          {step.detail}
                        </span>
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0 font-mono">
                      {step.durationMs}ms
                    </span>
                  </div>
                ))}
              </div>

              {/* GCP Response Details (collapsed by default) */}
              {probeResult.gcpResponse && (
                <details className="mt-2">
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                    GCP Response Details
                  </summary>
                  <pre className="mt-2 p-3 rounded-md bg-accent/20 text-xs font-mono text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto">
                    {JSON.stringify(probeResult.gcpResponse, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}

          {/* Instructions when no probe has been run */}
          {!probing && !probeResult && (
            <div className="py-3 px-4 rounded-md bg-accent/10 border border-border">
              <p className="text-xs text-muted-foreground">
                This probe verifies the complete delegation pipeline: generates a 1KB binary with embedded SHA-256 checksums,
                sends it to the GCP swarm backend via the same base64 encoding path used for real analysis,
                and confirms the GCP server received byte-perfect data with no corruption or HTML substitution.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tools Grid */}
      {result && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {result.tools.map(tool => {
            const meta = TOOL_CATEGORIES[tool.name] || { label: tool.name, icon: Terminal, color: "text-muted-foreground" };
            const Icon = meta.icon;
            return (
              <Card
                key={tool.name}
                className={`border transition-colors ${
                  tool.available
                    ? "border-border bg-card hover:border-emerald-500/30"
                    : "border-red-500/20 bg-red-500/5"
                }`}
              >
                <CardContent className="pt-4">
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-md shrink-0 ${tool.available ? "bg-accent/30" : "bg-red-500/10"}`}>
                      <Icon className={`w-4 h-4 ${tool.available ? meta.color : "text-red-400"}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{meta.label}</p>
                        {tool.available ? (
                          <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        )}
                      </div>
                      {tool.available && tool.version && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate font-mono">{tool.version}</p>
                      )}
                      {!tool.available && tool.error && (
                        <p className="text-xs text-red-400/80 mt-0.5 truncate">{tool.error}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Info Card */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Terminal className="w-4 h-4 text-muted-foreground" />
            About These Tools
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p><strong className="text-foreground">YARA</strong> — Pattern matching engine used to scan binaries against your uploaded rule sets.</p>
          <p><strong className="text-foreground">Binwalk</strong> — Firmware extraction and analysis. Identifies embedded file systems, compression, and encryption.</p>
          <p><strong className="text-foreground">strings / xxd / file</strong> — Core Unix utilities for string extraction, hex dumps, and file type detection.</p>
          <p><strong className="text-foreground">objdump / readelf / nm</strong> — ELF/PE binary analysis tools for disassembly, symbol tables, and section headers.</p>
          <p><strong className="text-foreground">Python 3 / Node.js</strong> — Runtime environments used by analysis scripts and agent tools.</p>
          <p><strong className="text-foreground">GCP Byte Probe</strong> — Verifies the delegation pipeline delivers real binary bytes to the GCP swarm backend without corruption or HTML substitution.</p>
        </CardContent>
      </Card>
    </div>
  );
}
