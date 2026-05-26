import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Upload,
  ChevronLeft,
  Zap,
  CheckCircle2,
  AlertCircle,
  Download,
  FileCode,
  Copy,
  ClipboardCheck,
  Bot,
  Send,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { useRef, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";

interface AlignmentFile {
  filename: string;
  module: string;
  size: number;
}

interface SecurityByteStatus {
  regionName: string;
  offset: number;
  length: number;
  file1Value: string;
  file2Value: string;
  file3Value: string;
  masterValue: string;
  allMatch: boolean;
  needsPatching: boolean[];
  beforeAfter?: {
    fileIndex: number;
    before: string;
    after: string;
  }[];
}

interface PatchPlan {
  fileIndex: number;
  filename: string;
  module: string;
  patchCount: number;
  bytesToChange: number;
}

interface AlignmentResult {
  id: string;
  timestamp: number;
  files: AlignmentFile[];
  masterIndex: number;
  masterModule: string;
  totalRegionsScanned: number;
  matchingRegions: number;
  mismatchingRegions: number;
  securityByteStatus: SecurityByteStatus[];
  patchPlans: PatchPlan[];
  patchedFileIds: string[];
}

export default function Align() {
  const [, navigate] = useLocation();
  const [files, setFiles] = useState<File[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AlignmentResult | null>(null);
  const [error, setError] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"mismatches" | "all" | "plan">(
    "mismatches"
  );
  const [copied, setCopied] = useState(false);

  // LLM Chat state
  const [llmAnalysis, setLlmAnalysis] = useState<string>("");
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmError, setLlmError] = useState<string>("");
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, llmAnalysis]);

  const streamLLMAnalysis = async (alignmentResult: AlignmentResult) => {
    setLlmLoading(true);
    setLlmError("");
    setLlmAnalysis("");
    setChatMessages([]);
    try {
      const resp = await fetch("/api/align/analyze-llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alignment: alignmentResult }),
      });
      if (!resp.ok || !resp.body) throw new Error("LLM request failed");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.content) setLlmAnalysis(prev => prev + parsed.content);
          } catch (e: any) {
            if (e.message !== "Unexpected end of JSON input") throw e;
          }
        }
      }
    } catch (e: any) {
      setLlmError(e.message || "LLM analysis failed");
    } finally {
      setLlmLoading(false);
    }
  };

  const sendChatMessage = async () => {
    if (!chatInput.trim() || !result || chatLoading) return;
    const question = chatInput.trim();
    setChatInput("");
    const newMessages: { role: "user" | "assistant"; content: string }[] = [
      ...chatMessages,
      { role: "user", content: question },
    ];
    setChatMessages(newMessages);
    setChatLoading(true);
    let assistantMsg = "";
    try {
      const resp = await fetch("/api/align/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alignment: result, messages: chatMessages, question }),
      });
      if (!resp.ok || !resp.body) throw new Error("Chat request failed");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Add placeholder for streaming
      setChatMessages([...newMessages, { role: "assistant", content: "" }]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.content) {
              assistantMsg += parsed.content;
              setChatMessages([...newMessages, { role: "assistant", content: assistantMsg }]);
            }
          } catch (e: any) {
            if (e.message !== "Unexpected end of JSON input") throw e;
          }
        }
      }
    } catch (e: any) {
      setChatMessages([...newMessages, { role: "assistant", content: `Error: ${e.message}` }]);
    } finally {
      setChatLoading(false);
    }
  };

  const copySecurityBytes = () => {
    if (!result) return;
    const lines: string[] = [];
    lines.push(`SRT LAB — Security Byte Programmer Output`);
    lines.push(`Alignment ID: ${result.id}`);
    lines.push(`Master Module: ${result.masterModule} (File ${result.masterIndex + 1}: ${result.files[result.masterIndex]?.filename})`);
    lines.push(`Generated: ${new Date(result.timestamp).toLocaleString()}`);
    lines.push(``);
    lines.push(`${'='.repeat(60)}`);
    lines.push(`PATCHES TO WRITE`);
    lines.push(`${'='.repeat(60)}`);
    lines.push(``);

    const mismatches = result.securityByteStatus.filter(s => !s.allMatch);
    if (mismatches.length === 0) {
      lines.push(`All security bytes already match. No patches required.`);
    } else {
      mismatches.forEach(status => {
        lines.push(`REGION: ${status.regionName}`);
        lines.push(`Offset: 0x${status.offset.toString(16).toUpperCase().padStart(4, '0')} | Length: ${status.length} bytes`);
        lines.push(`Master Value: ${status.masterValue}`);
        lines.push(``);
        if (status.beforeAfter && status.beforeAfter.length > 0) {
          status.beforeAfter.forEach(patch => {
            const filename = result.files[patch.fileIndex]?.filename || `File ${patch.fileIndex + 1}`;
            const module = result.files[patch.fileIndex]?.module || 'UNKNOWN';
            lines.push(`  → ${module} (${filename})`);
            lines.push(`    Write at 0x${status.offset.toString(16).toUpperCase().padStart(4, '0')}: ${patch.after}`);
            lines.push(`    (was: ${patch.before})`);
          });
        } else {
          result.files.forEach((file, fIdx) => {
            if (status.needsPatching[fIdx]) {
              const currentVal = fIdx === 0 ? status.file1Value : fIdx === 1 ? status.file2Value : status.file3Value;
              lines.push(`  → ${file.module} (${file.filename})`);
              lines.push(`    Write at 0x${status.offset.toString(16).toUpperCase().padStart(4, '0')}: ${status.masterValue}`);
              lines.push(`    (was: ${currentVal})`);
            }
          });
        }
        lines.push(``);
      });
    }

    lines.push(`${'='.repeat(60)}`);
    lines.push(`SUMMARY`);
    lines.push(`${'='.repeat(60)}`);
    lines.push(`Total regions scanned: ${result.totalRegionsScanned}`);
    lines.push(`Matching: ${result.matchingRegions}`);
    lines.push(`Mismatches fixed: ${result.mismatchingRegions}`);
    result.patchPlans.forEach(plan => {
      lines.push(`${plan.module} (${plan.filename}): ${plan.patchCount} patches, ${plan.bytesToChange} bytes changed`);
    });

    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    }).catch(() => {
      // Fallback: create a textarea and copy
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    });
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      setFiles(prev => [...prev, ...droppedFiles].slice(-3));
      setError("");
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files);
      setFiles(prev => [...prev, ...selectedFiles].slice(-3));
      setError("");
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleAnalyze = async () => {
    if (files.length !== 3) {
      setError("Please upload exactly 3 files");
      return;
    }

    setAnalyzing(true);
    setError("");

    try {
      const formData = new FormData();
      files.forEach(f => formData.append("files", f));

      const response = await fetch("/api/align", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Alignment failed");
      }

      const data = await response.json();
      setResult(data);
      // Auto-trigger LLM analysis after alignment completes
      streamLLMAnalysis(data);
    } catch (err: any) {
      setError(err.message || "Alignment failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const downloadZip = async () => {
    if (!result) return;
    try {
      const response = await fetch(`/api/align/${result.id}/download-zip`);
      if (!response.ok) throw new Error("Download failed");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `srt-lab-aligned-${result.id}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      setError(err.message || "Download failed");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/")}
              className="text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
            <div>
              <h1 className="text-xl font-bold font-sans">SRT LAB</h1>
              <p className="text-xs text-muted-foreground">
                Ultimate Edition
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="container py-8 space-y-8">
        {/* Title */}
        <section className="text-center space-y-2">
          <h2 className="text-3xl md:text-4xl font-bold font-sans tracking-tight">
            Multi-File Alignment
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Upload 3 binary files (BCM, RFHUB, PCM, etc.). The system identifies
            the master module and patches the other 2 to align all security bytes
            for synchronized key programming.
          </p>
        </section>

        {!result ? (
          <>
            {/* Upload Zone */}
            <section className="space-y-4">
              <h3 className="text-lg font-semibold font-sans">Upload 3 Files</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[0, 1, 2].map(index => (
                  <div
                    key={index}
                    onDrop={handleDrop}
                    onDragOver={e => e.preventDefault()}
                    className="border-2 border-dashed border-red-500/50 rounded-lg p-6 text-center hover:border-red-500/80 transition cursor-pointer bg-red-950/10"
                  >
                    {files[index] ? (
                      <div className="space-y-2">
                        <CheckCircle2 className="w-8 h-8 text-red-500 mx-auto" />
                        <p className="text-sm font-mono break-all">
                          {files[index].name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {(files[index].size / 1024).toFixed(1)} KB
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeFile(index)}
                          className="text-xs"
                        >
                          Remove
                        </Button>
                      </div>
                    ) : (
                      <label className="cursor-pointer space-y-2">
                        <Upload className="w-6 h-6 text-muted-foreground mx-auto" />
                        <p className="text-sm font-medium">File {index + 1}</p>
                        <p className="text-xs text-muted-foreground">
                          Drop or click to select
                        </p>
                        <input
                          type="file"
                          onChange={handleFileSelect}
                          className="hidden"
                          accept=".bin,.hex,.eeprom"
                        />
                      </label>
                    )}
                  </div>
                ))}
              </div>

              {error && (
                <div className="bg-red-950/20 border border-red-500/50 rounded-lg p-4 flex gap-3">
                  <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}

              <Button
                onClick={handleAnalyze}
                disabled={files.length !== 3 || analyzing}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold"
                size="lg"
              >
                {analyzing ? (
                  <>
                    <Zap className="w-4 h-4 mr-2 animate-spin" />
                    Analyzing & Aligning...
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4 mr-2" />
                    Analyze & Align
                  </>
                )}
              </Button>
            </section>
          </>
        ) : (
          <>
            {/* Results */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold font-sans">Alignment Results</h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setResult(null);
                    setFiles([]);
                  }}
                >
                  New Alignment
                </Button>
              </div>

              {/* Master Module Info */}
              <Card className="bg-red-950/20 border-red-500/30">
                <CardHeader>
                  <CardTitle className="text-base">Master Module</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">File</p>
                      <p className="font-mono text-sm">
                        {result.files[result.masterIndex].filename}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Module Type</p>
                      <Badge variant="secondary">{result.masterModule}</Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Summary Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <p className="text-xs text-muted-foreground">Regions Scanned</p>
                    <p className="text-2xl font-bold">
                      {result.totalRegionsScanned}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <p className="text-xs text-muted-foreground">Matching</p>
                    <p className="text-2xl font-bold text-green-500">
                      {result.matchingRegions}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <p className="text-xs text-muted-foreground">Mismatches</p>
                    <p className="text-2xl font-bold text-red-500">
                      {result.mismatchingRegions}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <p className="text-xs text-muted-foreground">Files to Patch</p>
                    <p className="text-2xl font-bold">{result.patchPlans.length}</p>
                  </CardContent>
                </Card>
              </div>

              {/* Tabs */}
              <div className="flex gap-2 border-b border-border">
                {(
                  [
                    { id: "mismatches", label: "Mismatches" },
                    { id: "all", label: "All Regions" },
                    { id: "plan", label: "Patch Plan" },
                  ] as const
                ).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
                      activeTab === tab.id
                        ? "border-red-500 text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Mismatches Tab */}
              {activeTab === "mismatches" && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="space-y-3">
                      {result.securityByteStatus
                        .filter(s => !s.allMatch)
                        .map((status, idx) => (
                          <div
                            key={idx}
                            className="border border-red-500/30 rounded-lg p-4 bg-red-950/10"
                          >
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <p className="font-semibold text-sm">
                                  {status.regionName}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  @ 0x{status.offset.toString(16).toUpperCase()} ({status.length} bytes)
                                </p>
                              </div>
                              <Badge variant="destructive">Mismatch</Badge>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-xs font-mono mb-3">
                              {result.files.map((file, fIdx) => (
                                <div key={fIdx}>
                                  <p className="text-muted-foreground mb-1">
                                    {file.module}
                                  </p>
                                  <p className="bg-background/50 p-2 rounded break-all">
                                    {fIdx === 0
                                      ? status.file1Value
                                      : fIdx === 1
                                        ? status.file2Value
                                        : status.file3Value}
                                  </p>
                                </div>
                              ))}
                            </div>
                            {status.beforeAfter && status.beforeAfter.length > 0 && (
                              <div className="border-t border-red-500/20 pt-3 mt-3">
                                <p className="text-xs font-semibold text-red-400 mb-2">Patches to Apply:</p>
                                <div className="space-y-2">
                                  {status.beforeAfter.map((patch, pIdx) => (
                                    <div key={pIdx} className="bg-background/50 p-2 rounded text-xs">
                                      <p className="text-muted-foreground mb-1">
                                        {result.files[patch.fileIndex].filename}
                                      </p>
                                      <p className="text-red-400">Before: <span className="font-mono">{patch.before}</span></p>
                                      <p className="text-green-400">After: <span className="font-mono">{patch.after}</span></p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* All Regions Tab */}
              {activeTab === "all" && (
                <Card>
                  <CardContent className="pt-6 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 px-2">Region</th>
                          <th className="text-left py-2 px-2">Offset</th>
                          <th className="text-left py-2 px-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.securityByteStatus.map((status, idx) => (
                          <tr
                            key={idx}
                            className={`border-b border-border/50 ${
                              status.allMatch ? "" : "bg-red-950/10"
                            }`}
                          >
                            <td className="py-2 px-2">{status.regionName}</td>
                            <td className="py-2 px-2 font-mono">
                              0x{status.offset.toString(16).toUpperCase()}
                            </td>
                            <td className="py-2 px-2">
                              {status.allMatch ? (
                                <Badge variant="outline" className="bg-green-950/20">
                                  ✓ Match
                                </Badge>
                              ) : (
                                <Badge variant="destructive">Mismatch</Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}

              {/* Patch Plan Tab */}
              {activeTab === "plan" && (
                <Card>
                  <CardContent className="pt-6 space-y-4">
                    {result.patchPlans.map((plan, idx) => (
                      <div
                        key={idx}
                        className="border border-border rounded-lg p-4 space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-semibold text-sm">
                              {plan.module} — {plan.filename}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              File {plan.fileIndex + 1}
                            </p>
                          </div>
                          <Badge>{plan.patchCount} patches</Badge>
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">
                              Bytes to change
                            </span>
                            <span className="font-mono font-semibold">
                              {plan.bytesToChange}
                            </span>
                          </div>
                          <Progress
                            value={
                              (plan.bytesToChange /
                                (result.files[plan.fileIndex].size || 1)) *
                              100
                            }
                            className="h-2"
                          />
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3">
                <Button
                  onClick={copySecurityBytes}
                  variant="outline"
                  size="lg"
                  className={`flex-1 font-semibold transition-all ${
                    copied
                      ? "border-green-500 text-green-400 bg-green-950/20"
                      : "border-primary text-primary hover:bg-primary/10"
                  }`}
                >
                  {copied ? (
                    <><ClipboardCheck className="w-4 h-4 mr-2" />Copied to Clipboard!</>
                  ) : (
                    <><Copy className="w-4 h-4 mr-2" />Copy Security Bytes</>
                  )}
                </Button>
                <Button
                  onClick={downloadZip}
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold"
                  size="lg"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download Patched ZIPs
                </Button>
              </div>

              {/* ─── LLM Analysis Panel ─── */}
              <section className="space-y-4 mt-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold font-sans flex items-center gap-2">
                    <Bot className="w-5 h-5 text-red-400" />
                    AI Expert Analysis
                  </h3>
                  {!llmLoading && llmAnalysis && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => streamLLMAnalysis(result!)}
                      className="text-xs text-muted-foreground"
                    >
                      Re-analyze
                    </Button>
                  )}
                </div>

                {/* LLM Analysis Output */}
                <Card className="bg-zinc-950/80 border-red-500/20">
                  <CardContent className="pt-4">
                    {llmLoading && !llmAnalysis && (
                      <div className="flex items-center gap-3 text-muted-foreground py-4">
                        <Loader2 className="w-4 h-4 animate-spin text-red-400" />
                        <span className="text-sm">Analyzing alignment results...</span>
                      </div>
                    )}
                    {llmError && (
                      <div className="flex items-center gap-2 text-red-400 text-sm py-2">
                        <AlertCircle className="w-4 h-4" />
                        {llmError}
                      </div>
                    )}
                    {llmAnalysis && (
                      <div className="text-sm leading-relaxed whitespace-pre-wrap font-mono text-green-300/90">
                        {llmAnalysis}
                        {llmLoading && <span className="inline-block w-2 h-4 bg-red-400 animate-pulse ml-1 align-middle" />}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Chat Q&A */}
                {(llmAnalysis || !llmLoading) && (
                  <Card className="bg-zinc-950/80 border-red-500/20">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <MessageSquare className="w-4 h-4 text-red-400" />
                        Ask a Question
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {/* Chat history */}
                      {chatMessages.length > 0 && (
                        <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                          {chatMessages.map((msg, idx) => (
                            <div
                              key={idx}
                              className={`rounded-lg p-3 text-sm ${
                                msg.role === "user"
                                  ? "bg-red-950/30 border border-red-500/20 ml-8"
                                  : "bg-zinc-900/60 border border-zinc-700/40 mr-8"
                              }`}
                            >
                              <p className={`text-xs font-semibold mb-1 ${
                                msg.role === "user" ? "text-red-400" : "text-green-400"
                              }`}>
                                {msg.role === "user" ? "YOU" : "AI EXPERT"}
                              </p>
                              <p className="whitespace-pre-wrap font-mono leading-relaxed text-foreground/90">
                                {msg.content}
                                {chatLoading && idx === chatMessages.length - 1 && msg.role === "assistant" && msg.content === "" && (
                                  <span className="inline-block w-2 h-4 bg-green-400 animate-pulse ml-1 align-middle" />
                                )}
                              </p>
                            </div>
                          ))}
                          <div ref={chatEndRef} />
                        </div>
                      )}

                      {/* Input */}
                      <div className="flex gap-2">
                        <Textarea
                          value={chatInput}
                          onChange={e => setChatInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              sendChatMessage();
                            }
                          }}
                          placeholder="Ask about the mismatches, what to do next, risks, etc..."
                          className="flex-1 min-h-[60px] max-h-32 resize-none bg-zinc-900/60 border-zinc-700/40 text-sm font-mono"
                          disabled={chatLoading || llmLoading}
                        />
                        <Button
                          onClick={sendChatMessage}
                          disabled={!chatInput.trim() || chatLoading || llmLoading}
                          className="bg-red-600 hover:bg-red-700 text-white self-end"
                          size="sm"
                        >
                          {chatLoading ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Send className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">Press Enter to send · Shift+Enter for new line</p>
                    </CardContent>
                  </Card>
                )}
              </section>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
