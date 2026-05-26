import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  Upload,
  Shield,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Download,
  FileCode,
  ArrowRight,
  Wrench,
  Eye,
  Zap,
  Binary,
} from "lucide-react";

interface ByteMismatch {
  regionName: string;
  module: string;
  offset: number;
  length: number;
  description: string;
  pairingRule: string;
  critical: boolean;
  file1Bytes: string;
  file2Bytes: string;
  expectedBytes: string;
  status: "match" | "mismatch" | "fixable" | "out_of_range";
  fixAction?: string;
}

interface CompareResult {
  id: string;
  timestamp: number;
  file1Name: string;
  file1Size: number;
  file2Name: string;
  file2Size: number;
  file1Module: string;
  file2Module: string;
  totalRegionsScanned: number;
  matchCount: number;
  mismatchCount: number;
  fixableCount: number;
  outOfRangeCount: number;
  mismatches: ByteMismatch[];
  patchAvailable: boolean;
}

const MODULE_OPTIONS = [
  { value: "auto", label: "Auto-Detect" },
  { value: "BCM", label: "BCM (Body Control Module)" },
  { value: "RFHUB", label: "RFHUB (RF Hub)" },
  { value: "PCM", label: "PCM (Powertrain Control)" },
  { value: "TCM", label: "TCM (Transmission Control)" },
  { value: "SGW", label: "SGW (Security Gateway)" },
  { value: "GPEC", label: "GPEC (Powertrain)" },
  { value: "IPC", label: "IPC (Instrument Cluster)" },
  { value: "SKIM", label: "SKIM/WCM (Immobilizer)" },
  { value: "ADCM", label: "ADCM (Active Damping)" },
  { value: "EPS", label: "EPS (Power Steering)" },
];

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "match":
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "fixable":
      return <Wrench className="w-4 h-4 text-yellow-500" />;
    case "mismatch":
      return <XCircle className="w-4 h-4 text-primary" />;
    case "out_of_range":
      return <AlertTriangle className="w-4 h-4 text-muted-foreground" />;
    default:
      return null;
  }
}

function StatusBadge({ status, critical }: { status: string; critical: boolean }) {
  const variants: Record<string, string> = {
    match: "bg-green-500/10 text-green-500 border-green-500/30",
    fixable: "bg-yellow-500/10 text-yellow-500 border-yellow-500/30",
    mismatch: "bg-primary/10 text-primary border-primary/30",
    out_of_range: "bg-muted text-muted-foreground border-border",
  };

  return (
    <div className="flex items-center gap-1.5">
      <Badge className={`text-xs border ${variants[status] || ""}`}>
        {status === "fixable" ? "MISMATCH — FIXABLE" : status.toUpperCase()}
      </Badge>
      {critical && status !== "match" && (
        <Badge className="text-xs bg-primary/20 text-primary border border-primary/30">
          CRITICAL
        </Badge>
      )}
    </div>
  );
}

export default function Compare() {
  const [, navigate] = useLocation();

  // File state
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [sourceModule, setSourceModule] = useState("auto");
  const [targetModule, setTargetModule] = useState("auto");

  // Drag state
  const [sourceDragging, setSourceDragging] = useState(false);
  const [targetDragging, setTargetDragging] = useState(false);

  // Compare state
  const [isComparing, setIsComparing] = useState(false);
  const [compareProgress, setCompareProgress] = useState(0);
  const [compareStatus, setCompareStatus] = useState("");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState("");
  const [isDownloading, setIsDownloading] = useState(false);

  // Drag handlers for source
  const handleSourceDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setSourceDragging(true);
  }, []);
  const handleSourceDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setSourceDragging(false);
  }, []);
  const handleSourceDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setSourceDragging(false);
    if (e.dataTransfer.files.length > 0) setSourceFile(e.dataTransfer.files[0]);
  }, []);

  // Drag handlers for target
  const handleTargetDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setTargetDragging(true);
  }, []);
  const handleTargetDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setTargetDragging(false);
  }, []);
  const handleTargetDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setTargetDragging(false);
    if (e.dataTransfer.files.length > 0) setTargetFile(e.dataTransfer.files[0]);
  }, []);

  const runCompare = async () => {
    if (!sourceFile || !targetFile) return;

    setIsComparing(true);
    setCompareProgress(0);
    setCompareStatus("Reading source binary...");
    setError("");
    setResult(null);

    const formData = new FormData();
    formData.append("source", sourceFile);
    formData.append("target", targetFile);
    if (sourceModule !== "auto") formData.append("sourceModule", sourceModule);
    if (targetModule !== "auto") formData.append("targetModule", targetModule);

    // Progress simulation for UX
    const stages = [
      { progress: 20, status: "Mapping security byte regions..." },
      { progress: 40, status: "Scanning pairing offsets..." },
      { progress: 60, status: "Comparing SKIM / VIN / Secret Key fields..." },
      { progress: 80, status: "Calculating patches and CRCs..." },
    ];
    let stageIdx = 0;
    const interval = setInterval(() => {
      if (stageIdx < stages.length) {
        setCompareProgress(stages[stageIdx].progress);
        setCompareStatus(stages[stageIdx].status);
        stageIdx++;
      }
    }, 400);

    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        body: formData,
      });

      clearInterval(interval);

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Comparison failed");
      }

      const data = await res.json();
      setCompareProgress(100);
      setCompareStatus("Comparison complete!");
      setResult(data);
    } catch (err: any) {
      clearInterval(interval);
      setError(err.message);
    } finally {
      setTimeout(() => setIsComparing(false), 500);
    }
  };

  const downloadPatched = async () => {
    if (!result?.id || !result.patchAvailable) return;
    setIsDownloading(true);
    try {
      const res = await fetch(`/api/compare/${result.id}/download`);
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${targetFile?.name.replace(/\.[^.]+$/, "")}_patched${targetFile?.name.match(/\.[^.]+$/)?.[0] || ".bin"}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message);
    }
    setIsDownloading(false);
  };

  const resetAll = () => {
    setSourceFile(null);
    setTargetFile(null);
    setSourceModule("auto");
    setTargetModule("auto");
    setResult(null);
    setError("");
    setCompareProgress(0);
    setCompareStatus("");
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container flex items-center justify-between h-16">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/")}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <span className="font-bold text-sm tracking-tight">SRT LAB</span>
            </div>
          </div>
        </div>
      </header>

      <main className="container py-8 space-y-8">
        {/* Title */}
        <section className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center glow-red-sm">
              <Wrench className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h2 className="text-2xl font-bold font-sans">Compare & Patch</h2>
              <p className="text-sm text-muted-foreground">
                Security byte mismatch detection and auto-fix for module pairing
              </p>
            </div>
          </div>
        </section>

        {/* Dual Drop Zones */}
        {!result && (
          <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Source File */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Source Module (Reference)
                </h3>
                <Select value={sourceModule} onValueChange={setSourceModule}>
                  <SelectTrigger className="w-48 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODULE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Card
                className={`carbon-texture border-2 border-dashed transition-all duration-200 cursor-pointer ${
                  sourceDragging
                    ? "border-green-500 bg-green-500/5"
                    : sourceFile
                    ? "border-green-500/30 bg-green-500/5"
                    : "border-border hover:border-primary/50"
                }`}
                onDragOver={handleSourceDragOver}
                onDragLeave={handleSourceDragLeave}
                onDrop={handleSourceDrop}
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = ".exe,.dll,.bin,.eeprom,.hex,.srec,.fw,.rom,.flash,.img,.elf,.so,.sys";
                  input.onchange = (e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    if (f) setSourceFile(f);
                  };
                  input.click();
                }}
              >
                <CardContent className="py-10 flex flex-col items-center justify-center text-center">
                  {sourceFile ? (
                    <>
                      <FileCode className="w-10 h-10 text-green-500 mb-3" />
                      <p className="font-mono text-sm font-medium">{sourceFile.name}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {(sourceFile.size / 1024).toFixed(1)} KB
                      </p>
                    </>
                  ) : (
                    <>
                      <Upload className="w-10 h-10 text-muted-foreground mb-3" />
                      <p className="text-sm font-medium">Drop Source Dump</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        The "good" module — bytes will be read FROM this file
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Arrow */}
            <div className="hidden md:flex items-center justify-center absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none" style={{ display: "none" }}>
              <ArrowRight className="w-8 h-8 text-primary" />
            </div>

            {/* Target File */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Target Module (To Patch)
                </h3>
                <Select value={targetModule} onValueChange={setTargetModule}>
                  <SelectTrigger className="w-48 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODULE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Card
                className={`carbon-texture border-2 border-dashed transition-all duration-200 cursor-pointer ${
                  targetDragging
                    ? "border-primary bg-primary/5"
                    : targetFile
                    ? "border-primary/30 bg-primary/5"
                    : "border-border hover:border-primary/50"
                }`}
                onDragOver={handleTargetDragOver}
                onDragLeave={handleTargetDragLeave}
                onDrop={handleTargetDrop}
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = ".exe,.dll,.bin,.eeprom,.hex,.srec,.fw,.rom,.flash,.img,.elf,.so,.sys";
                  input.onchange = (e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    if (f) setTargetFile(f);
                  };
                  input.click();
                }}
              >
                <CardContent className="py-10 flex flex-col items-center justify-center text-center">
                  {targetFile ? (
                    <>
                      <FileCode className="w-10 h-10 text-primary mb-3" />
                      <p className="font-mono text-sm font-medium">{targetFile.name}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {(targetFile.size / 1024).toFixed(1)} KB
                      </p>
                    </>
                  ) : (
                    <>
                      <Upload className="w-10 h-10 text-muted-foreground mb-3" />
                      <p className="text-sm font-medium">Drop Target Dump</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        The module to FIX — mismatched bytes will be patched here
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </section>
        )}

        {/* Compare Button / Progress */}
        {!result && (
          <section className="flex flex-col items-center gap-4">
            {isComparing ? (
              <div className="w-full max-w-md space-y-3">
                <Progress value={compareProgress} className="h-2" />
                <p className="text-sm text-muted-foreground font-mono text-center">
                  {compareStatus}
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Button
                  size="lg"
                  onClick={runCompare}
                  disabled={!sourceFile || !targetFile}
                  className="px-8"
                >
                  <Zap className="w-5 h-5 mr-2" />
                  Compare & Detect Mismatches
                </Button>
                {(sourceFile || targetFile) && (
                  <Button variant="ghost" size="sm" onClick={resetAll}>
                    Clear
                  </Button>
                )}
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertTriangle className="w-4 h-4" />
                {error}
              </div>
            )}
          </section>
        )}

        {/* Results */}
        {result && (
          <section className="space-y-6">
            {/* Summary Header */}
            <Card className="carbon-texture border-primary/20">
              <CardContent className="py-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <h3 className="text-lg font-bold">Comparison Results</h3>
                      {result.patchAvailable ? (
                        <Badge className="bg-yellow-500/10 text-yellow-500 border border-yellow-500/30">
                          PATCH AVAILABLE
                        </Badge>
                      ) : result.mismatchCount === 0 ? (
                        <Badge className="bg-green-500/10 text-green-500 border border-green-500/30">
                          ALL MATCHED
                        </Badge>
                      ) : (
                        <Badge className="bg-primary/10 text-primary border border-primary/30">
                          MISMATCHES FOUND
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono">
                      <span>{result.file1Name}</span>
                      <span className="text-primary">({result.file1Module})</span>
                      <ArrowRight className="w-4 h-4" />
                      <span>{result.file2Name}</span>
                      <span className="text-primary">({result.file2Module})</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {result.patchAvailable && (
                      <Button onClick={downloadPatched} disabled={isDownloading}>
                        <Download className="w-4 h-4 mr-2" />
                        {isDownloading ? "Downloading..." : "Download Patched Binary"}
                      </Button>
                    )}
                    <Button variant="outline" onClick={resetAll}>
                      New Comparison
                    </Button>
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-6">
                  <div className="bg-secondary/50 rounded p-3 text-center">
                    <p className="text-2xl font-bold font-mono">{result.totalRegionsScanned}</p>
                    <p className="text-xs text-muted-foreground">Regions Scanned</p>
                  </div>
                  <div className="bg-green-500/5 border border-green-500/20 rounded p-3 text-center">
                    <p className="text-2xl font-bold font-mono text-green-500">{result.matchCount}</p>
                    <p className="text-xs text-muted-foreground">Matched</p>
                  </div>
                  <div className="bg-yellow-500/5 border border-yellow-500/20 rounded p-3 text-center">
                    <p className="text-2xl font-bold font-mono text-yellow-500">{result.fixableCount}</p>
                    <p className="text-xs text-muted-foreground">Fixable</p>
                  </div>
                  <div className="bg-primary/5 border border-primary/20 rounded p-3 text-center">
                    <p className="text-2xl font-bold font-mono text-primary">
                      {result.mismatchCount - result.fixableCount}
                    </p>
                    <p className="text-xs text-muted-foreground">Warnings</p>
                  </div>
                  <div className="bg-secondary/50 rounded p-3 text-center">
                    <p className="text-2xl font-bold font-mono text-muted-foreground">{result.outOfRangeCount}</p>
                    <p className="text-xs text-muted-foreground">Out of Range</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Detailed Results Tabs */}
            <Tabs defaultValue="mismatches">
              <TabsList className="flex flex-wrap gap-1">
                <TabsTrigger value="mismatches">
                  <AlertTriangle className="w-3.5 h-3.5 mr-1" />
                  Mismatches ({result.mismatches.filter((m) => m.status !== "match").length})
                </TabsTrigger>
                <TabsTrigger value="all">
                  <Eye className="w-3.5 h-3.5 mr-1" />
                  All Regions ({result.totalRegionsScanned})
                </TabsTrigger>
                <TabsTrigger value="patchplan">
                  <Wrench className="w-3.5 h-3.5 mr-1" />
                  Patch Plan ({result.fixableCount})
                </TabsTrigger>
                <TabsTrigger value="hexdiff">
                  <Binary className="w-3.5 h-3.5 mr-1" />
                  Hex Diff
                </TabsTrigger>
              </TabsList>

              {/* Mismatches Tab */}
              <TabsContent value="mismatches">
                <div className="space-y-3">
                  {result.mismatches
                    .filter((m) => m.status !== "match")
                    .map((m, idx) => (
                      <Card key={idx} className="carbon-texture">
                        <CardContent className="py-4 space-y-3">
                          <div className="flex items-start justify-between">
                            <div className="flex items-center gap-2">
                              <StatusIcon status={m.status} />
                              <div>
                                <p className="font-semibold text-sm">{m.regionName}</p>
                                <p className="text-xs text-muted-foreground">
                                  {m.module} @ 0x{m.offset.toString(16).toUpperCase()} — {m.length} bytes
                                </p>
                              </div>
                            </div>
                            <StatusBadge status={m.status} critical={m.critical} />
                          </div>
                          <p className="text-xs text-muted-foreground">{m.description}</p>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="bg-secondary/30 rounded p-3">
                              <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">
                                Source ({result.file1Module})
                              </p>
                              <p className="font-mono text-xs text-green-400 break-all">
                                {m.file1Bytes}
                              </p>
                            </div>
                            <div className="bg-secondary/30 rounded p-3">
                              <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">
                                Target ({result.file2Module}) — Current
                              </p>
                              <p className="font-mono text-xs text-primary break-all">
                                {m.file2Bytes}
                              </p>
                            </div>
                          </div>

                          {m.status === "fixable" && (
                            <div className="bg-yellow-500/5 border border-yellow-500/20 rounded p-3">
                              <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">
                                Fix → Expected Bytes
                              </p>
                              <p className="font-mono text-xs text-yellow-400 break-all">
                                {m.expectedBytes}
                              </p>
                              {m.fixAction && (
                                <p className="text-xs text-yellow-500/80 mt-2 flex items-center gap-1">
                                  <Wrench className="w-3 h-3" />
                                  {m.fixAction}
                                </p>
                              )}
                            </div>
                          )}

                          {m.status === "mismatch" && m.fixAction && (
                            <div className="bg-primary/5 border border-primary/20 rounded p-3">
                              <p className="text-xs text-primary/80 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                {m.fixAction}
                              </p>
                            </div>
                          )}

                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Badge variant="outline" className="text-xs">
                              Rule: {m.pairingRule}
                            </Badge>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  {result.mismatches.filter((m) => m.status !== "match").length === 0 && (
                    <Card className="carbon-texture">
                      <CardContent className="py-8 text-center">
                        <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
                        <p className="font-semibold text-green-500">No Mismatches Detected</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          All scanned security byte regions match their expected pairing values.
                        </p>
                      </CardContent>
                    </Card>
                  )}
                </div>
              </TabsContent>

              {/* All Regions Tab */}
              <TabsContent value="all">
                <Card className="carbon-texture overflow-hidden">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8"></TableHead>
                          <TableHead>Region</TableHead>
                          <TableHead>Module</TableHead>
                          <TableHead>Offset</TableHead>
                          <TableHead>Length</TableHead>
                          <TableHead>Rule</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.mismatches.map((m, idx) => (
                          <TableRow
                            key={idx}
                            className={
                              m.status === "fixable"
                                ? "bg-yellow-500/5"
                                : m.status === "mismatch"
                                ? "bg-primary/5"
                                : ""
                            }
                          >
                            <TableCell>
                              <StatusIcon status={m.status} />
                            </TableCell>
                            <TableCell>
                              <span className="font-mono text-xs">{m.regionName}</span>
                              {m.critical && (
                                <span className="ml-1 text-primary text-xs">*</span>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-xs">{m.module}</TableCell>
                            <TableCell className="font-mono text-xs text-primary">
                              0x{m.offset.toString(16).toUpperCase()}
                            </TableCell>
                            <TableCell className="font-mono text-xs">{m.length}B</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">
                                {m.pairingRule}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={m.status} critical={m.critical} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Card>
              </TabsContent>

              {/* Patch Plan Tab */}
              <TabsContent value="patchplan">
                <div className="space-y-4">
                  {result.patchAvailable ? (
                    <>
                      <Card className="carbon-texture border-yellow-500/20">
                        <CardHeader>
                          <CardTitle className="text-base flex items-center gap-2">
                            <Wrench className="w-5 h-5 text-yellow-500" />
                            Patch Plan — {result.fixableCount} Corrections
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <p className="text-sm text-muted-foreground">
                            The following byte corrections will be applied to{" "}
                            <span className="font-mono text-foreground">{result.file2Name}</span> to
                            align it with{" "}
                            <span className="font-mono text-foreground">{result.file1Name}</span>{" "}
                            based on known FCA/Stellantis module pairing rules.
                          </p>

                          {result.mismatches
                            .filter((m) => m.status === "fixable")
                            .map((m, idx) => (
                              <div
                                key={idx}
                                className="bg-secondary/30 rounded p-4 space-y-2 border border-border/50"
                              >
                                <div className="flex items-center justify-between">
                                  <p className="font-semibold text-sm flex items-center gap-2">
                                    <span className="text-yellow-500 font-mono text-xs bg-yellow-500/10 px-2 py-0.5 rounded">
                                      #{idx + 1}
                                    </span>
                                    {m.regionName}
                                  </p>
                                  <Badge variant="outline" className="text-xs">
                                    {m.pairingRule}
                                  </Badge>
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                                  <div>
                                    <p className="text-muted-foreground mb-0.5">CURRENT</p>
                                    <p className="text-primary break-all">{m.file2Bytes}</p>
                                  </div>
                                  <div className="flex items-center justify-center">
                                    <ArrowRight className="w-4 h-4 text-yellow-500" />
                                  </div>
                                  <div>
                                    <p className="text-muted-foreground mb-0.5">PATCHED</p>
                                    <p className="text-green-400 break-all">{m.expectedBytes}</p>
                                  </div>
                                </div>
                                {m.fixAction && (
                                  <p className="text-xs text-muted-foreground">{m.fixAction}</p>
                                )}
                              </div>
                            ))}

                          <div className="pt-4 flex justify-center">
                            <Button size="lg" onClick={downloadPatched} disabled={isDownloading}>
                              <Download className="w-5 h-5 mr-2" />
                              {isDownloading ? "Generating..." : "Download Patched Binary"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    </>
                  ) : (
                    <Card className="carbon-texture">
                      <CardContent className="py-8 text-center">
                        <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
                        <p className="font-semibold">No Patches Needed</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          All paired security byte regions already match.
                        </p>
                      </CardContent>
                    </Card>
                  )}
                </div>
              </TabsContent>

              {/* Hex Diff Tab */}
              <TabsContent value="hexdiff">
                <Card className="carbon-texture">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Binary className="w-5 h-5 text-primary" />
                      Security Byte Hex View
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4 max-h-[600px] overflow-y-auto">
                      {result.mismatches
                        .filter((m) => m.file1Bytes !== "N/A" && m.file2Bytes !== "N/A")
                        .map((m, idx) => (
                          <div key={idx} className="space-y-1">
                            <div className="flex items-center gap-2 text-xs">
                              <StatusIcon status={m.status} />
                              <span className="font-mono text-muted-foreground">
                                0x{m.offset.toString(16).toUpperCase().padStart(6, "0")}
                              </span>
                              <span className="text-foreground/70">{m.regionName}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="bg-secondary/30 rounded px-3 py-2">
                                <p className="text-[10px] text-muted-foreground mb-0.5 uppercase">
                                  {result.file1Module}
                                </p>
                                <p className="font-mono text-xs break-all leading-relaxed">
                                  {m.file1Bytes.split(" ").map((byte, i) => {
                                    const targetBytes = m.file2Bytes.split(" ");
                                    const isMatch = byte === targetBytes[i];
                                    return (
                                      <span
                                        key={i}
                                        className={
                                          isMatch
                                            ? "text-foreground/60"
                                            : "text-green-400 bg-green-500/10 px-0.5 rounded"
                                        }
                                      >
                                        {byte}{" "}
                                      </span>
                                    );
                                  })}
                                </p>
                              </div>
                              <div className="bg-secondary/30 rounded px-3 py-2">
                                <p className="text-[10px] text-muted-foreground mb-0.5 uppercase">
                                  {result.file2Module}
                                </p>
                                <p className="font-mono text-xs break-all leading-relaxed">
                                  {m.file2Bytes.split(" ").map((byte, i) => {
                                    const sourceBytes = m.file1Bytes.split(" ");
                                    const expectedBytes = m.expectedBytes.split(" ");
                                    const isCorrect =
                                      m.status === "match" || byte === expectedBytes[i];
                                    return (
                                      <span
                                        key={i}
                                        className={
                                          isCorrect
                                            ? "text-foreground/60"
                                            : "text-primary bg-primary/10 px-0.5 rounded"
                                        }
                                      >
                                        {byte}{" "}
                                      </span>
                                    );
                                  })}
                                </p>
                              </div>
                            </div>
                          </div>
                        ))}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/30 py-6 mt-12">
        <div className="container text-center text-xs text-muted-foreground">
          <p>SRT Lab: Ultimate Edition — Compare & Patch Module</p>
          <p className="mt-1">Security Byte Mismatch Detection & Auto-Fix</p>
        </div>
      </footer>
    </div>
  );
}
