import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, ArrowLeft, Download, Loader2, Shield, CheckCircle, GitCompare, Layers } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface DiffRegion {
  offsetStart: number;
  offsetEnd: number;
  lengthBytes: number;
  sourceHex: string;
  candidateHex: string;
  label?: string;
}

function DiffRegionRow({ region }: { region: DiffRegion }) {
  return (
    <div className="flex flex-col gap-1 p-2 rounded bg-muted/50 text-xs font-mono">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-muted-foreground">
          0x{region.offsetStart.toString(16).toUpperCase().padStart(4, "0")}–0x{region.offsetEnd.toString(16).toUpperCase().padStart(4, "0")}
        </span>
        <span className="text-muted-foreground">({region.lengthBytes} bytes)</span>
        {region.label && <Badge variant="outline" className="text-xs ml-auto">{region.label}</Badge>}
      </div>
      <div className="pl-2 text-red-400 break-all">{region.sourceHex}</div>
      <div className="pl-2 text-green-400 break-all">{region.candidateHex}</div>
    </div>
  );
}

export default function DiffReport() {
  const [, navigate] = useLocation();

  // ─── Candidate Generation State ─────────────────────────────────────────
  const [targetVin, setTargetVin] = useState("");
  const [targetSec16, setTargetSec16] = useState("");
  const [sessionId, setSessionId] = useState<number>(1);
  const [rfhubUploadId, setRfhubUploadId] = useState<number | null>(null);
  const [candidateResult, setCandidateResult] = useState<any>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // ─── Byte Diff State ────────────────────────────────────────────────────
  const [diffSourceId, setDiffSourceId] = useState<number | null>(null);
  const [diffTargetId, setDiffTargetId] = useState<number | null>(null);
  const [diffResult, setDiffResult] = useState<any>(null);
  const [isDiffing, setIsDiffing] = useState(false);

  // ─── Three-Way State ────────────────────────────────────────────────────
  const [correctedId, setCorrectedId] = useState<number | null>(null);
  const [preBenchId, setPreBenchId] = useState<number | null>(null);
  const [postBenchId, setPostBenchId] = useState<number | null>(null);
  const [threeWayResult, setThreeWayResult] = useState<any>(null);
  const [isComparing, setIsComparing] = useState(false);

  const generateMutation = trpc.candidate.generate.useMutation();
  const exportMutation = trpc.candidate.confirmExport.useMutation();
  const diffMutation = trpc.diff.compute.useMutation();
  const threeWayMutation = trpc.diff.threeWay.useMutation();

  const handleGenerate = async () => {
    if (!rfhubUploadId) { toast.error("Please enter an RFHUB upload ID"); return; }
    if (targetVin.length !== 17) { toast.error("VIN must be exactly 17 characters"); return; }
    if (targetSec16.length !== 32) { toast.error("SEC16 must be exactly 32 hex characters"); return; }

    setIsGenerating(true);
    try {
      const result = await generateMutation.mutateAsync({
        sessionId, rfhubUploadId, targetVin, targetSec16Hex: targetSec16,
      });
      setCandidateResult(result);
      if (!result.success) {
        toast.error(`Generation blocked: ${(result as any).refusal?.reason}`);
      } else {
        toast.success("Candidate generated successfully");
      }
    } catch (err: any) {
      toast.error(`Generation failed: ${err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExport = async () => {
    if (!candidateResult?.candidateKey) return;
    setIsExporting(true);
    try {
      const result = await exportMutation.mutateAsync({
        sessionId, candidateKey: candidateResult.candidateKey, confirmed: true,
      });
      if (result.success && result.downloadUrl) {
        window.open(result.downloadUrl, "_blank");
        toast.success("Export confirmed — download started");
      }
    } catch (err: any) {
      toast.error(`Export failed: ${err.message}`);
    } finally {
      setIsExporting(false);
      setShowConfirmDialog(false);
    }
  };

  const handleDiff = async () => {
    if (!diffSourceId || !diffTargetId) { toast.error("Please enter both upload IDs"); return; }
    setIsDiffing(true);
    try {
      const result = await diffMutation.mutateAsync({
        sessionId, sourceUploadId: diffSourceId, targetUploadId: diffTargetId,
      });
      setDiffResult(result);
      toast.success(`Diff complete: ${result.changedBytes} bytes changed`);
    } catch (err: any) {
      toast.error(`Diff failed: ${err.message}`);
    } finally {
      setIsDiffing(false);
    }
  };

  const handleThreeWay = async () => {
    if (!correctedId || !preBenchId || !postBenchId) { toast.error("Please enter all three upload IDs"); return; }
    setIsComparing(true);
    try {
      const result = await threeWayMutation.mutateAsync({
        sessionId, correctedUploadId: correctedId, preBenchUploadId: preBenchId, postBenchUploadId: postBenchId,
      });
      setThreeWayResult(result);
      toast.success("Three-way comparison complete");
    } catch (err: any) {
      toast.error(`Comparison failed: ${err.message}`);
    } finally {
      setIsComparing(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Candidate Generation & Diff</h1>
          <p className="text-sm text-muted-foreground">Generate controlled candidates, compare binaries, detect runtime rewrites</p>
        </div>
      </div>

      {/* Session selector */}
      <div className="flex items-center gap-3">
        <Label htmlFor="sessionSelect" className="text-sm">Session ID:</Label>
        <Input id="sessionSelect" type="number" className="w-24 font-mono" value={sessionId} onChange={(e) => setSessionId(parseInt(e.target.value) || 1)} />
      </div>

      <Tabs defaultValue="generate">
        <TabsList>
          <TabsTrigger value="generate"><Shield className="w-3.5 h-3.5 mr-1.5" />Generate</TabsTrigger>
          <TabsTrigger value="diff"><GitCompare className="w-3.5 h-3.5 mr-1.5" />Byte Diff</TabsTrigger>
          <TabsTrigger value="threeway"><Layers className="w-3.5 h-3.5 mr-1.5" />Three-Way</TabsTrigger>
        </TabsList>

        {/* ─── Generate Tab ─────────────────────────────────────────────────── */}
        <TabsContent value="generate" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Parameters</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rfhubId">RFHUB Upload ID</Label>
                  <Input id="rfhubId" type="number" placeholder="e.g. 1" value={rfhubUploadId || ""} onChange={(e) => setRfhubUploadId(parseInt(e.target.value) || null)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vin">Target VIN (17 chars)</Label>
                  <Input id="vin" placeholder="2C3CDXL92KH674464" maxLength={17} value={targetVin} onChange={(e) => setTargetVin(e.target.value.toUpperCase())} className="font-mono" />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="sec16">Target SEC16 (32 hex chars)</Label>
                  <Input id="sec16" placeholder="F0B61BE3C75BC294B624783AF0AA5A55" maxLength={32} value={targetSec16} onChange={(e) => setTargetSec16(e.target.value.toUpperCase())} className="font-mono" />
                </div>
              </div>
              <Button onClick={handleGenerate} disabled={isGenerating}>
                {isGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Shield className="w-4 h-4 mr-2" />}
                Generate Controlled Candidate
              </Button>
            </CardContent>
          </Card>

          {candidateResult && (
            <Card className={candidateResult.success ? "border-green-500/50" : "border-red-500/50"}>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  {candidateResult.success ? (
                    <><CheckCircle className="w-4 h-4 text-green-500" /> Candidate Ready</>
                  ) : (
                    <><AlertTriangle className="w-4 h-4 text-red-500" /> Generation Blocked</>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {candidateResult.success ? (
                  <>
                    <div className="text-sm space-y-1">
                      <p><span className="text-muted-foreground">SHA-256:</span> <span className="font-mono text-xs">{candidateResult.sha256}</span></p>
                      <p><span className="text-muted-foreground">Changes:</span> {candidateResult.changes?.length} regions modified</p>
                    </div>
                    {candidateResult.changes && candidateResult.changes.length > 0 && (
                      <div className="space-y-1 max-h-60 overflow-y-auto">
                        {candidateResult.changes.map((change: DiffRegion, i: number) => (
                          <DiffRegionRow key={i} region={change} />
                        ))}
                      </div>
                    )}
                    {candidateResult.warnings && candidateResult.warnings.length > 0 && (
                      <div className="space-y-1">
                        {candidateResult.warnings.map((w: string, i: number) => (
                          <p key={i} className="text-xs text-yellow-500 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> {w}
                          </p>
                        ))}
                      </div>
                    )}
                    <Button onClick={() => setShowConfirmDialog(true)} className="mt-2">
                      <Download className="w-4 h-4 mr-2" /> Export Candidate Binary
                    </Button>
                  </>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-red-400">{candidateResult.refusal?.reason || "Unknown refusal"}</p>
                    {candidateResult.refusal?.code && (
                      <Badge variant="destructive" className="text-xs font-mono">{candidateResult.refusal.code}</Badge>
                    )}
                    {candidateResult.refusal?.details && (
                      <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">{JSON.stringify(candidateResult.refusal.details, null, 2)}</pre>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ─── Byte Diff Tab ────────────────────────────────────────────────── */}
        <TabsContent value="diff" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Two-File Byte Diff</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Source Upload ID</Label>
                  <Input type="number" placeholder="e.g. 1" value={diffSourceId || ""} onChange={(e) => setDiffSourceId(parseInt(e.target.value) || null)} />
                </div>
                <div className="space-y-2">
                  <Label>Target Upload ID</Label>
                  <Input type="number" placeholder="e.g. 2" value={diffTargetId || ""} onChange={(e) => setDiffTargetId(parseInt(e.target.value) || null)} />
                </div>
              </div>
              <Button onClick={handleDiff} disabled={isDiffing}>
                {isDiffing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <GitCompare className="w-4 h-4 mr-2" />}
                Compute Diff
              </Button>
            </CardContent>
          </Card>

          {diffResult && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  Diff Result
                  <Badge variant="outline">{diffResult.changedBytes} bytes changed</Badge>
                  <Badge variant="outline">{diffResult.changedPercent?.toFixed(2)}%</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {diffResult.regions && diffResult.regions.length > 0 ? (
                  <div className="space-y-1 max-h-96 overflow-y-auto">
                    {diffResult.regions.map((region: DiffRegion, i: number) => (
                      <DiffRegionRow key={i} region={region} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Files are identical.</p>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ─── Three-Way Tab ────────────────────────────────────────────────── */}
        <TabsContent value="threeway" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Three-Way Comparison (Pre-bench / Post-bench / Corrected)</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Corrected Upload ID</Label>
                  <Input type="number" placeholder="Corrected" value={correctedId || ""} onChange={(e) => setCorrectedId(parseInt(e.target.value) || null)} />
                </div>
                <div className="space-y-2">
                  <Label>Pre-Bench Upload ID</Label>
                  <Input type="number" placeholder="Pre-bench" value={preBenchId || ""} onChange={(e) => setPreBenchId(parseInt(e.target.value) || null)} />
                </div>
                <div className="space-y-2">
                  <Label>Post-Bench Upload ID</Label>
                  <Input type="number" placeholder="Post-bench" value={postBenchId || ""} onChange={(e) => setPostBenchId(parseInt(e.target.value) || null)} />
                </div>
              </div>
              <Button onClick={handleThreeWay} disabled={isComparing}>
                {isComparing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Layers className="w-4 h-4 mr-2" />}
                Run Three-Way Comparison
              </Button>
            </CardContent>
          </Card>

          {threeWayResult && (
            <div className="space-y-4">
              {/* Runtime Rewrites */}
              {threeWayResult.runtimeRewrites && threeWayResult.runtimeRewrites.length > 0 && (
                <Card className="border-yellow-500/50">
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-yellow-500" />
                      Runtime Rewrites Detected
                      <Badge variant="outline" className="ml-auto">{threeWayResult.runtimeRewrites.length} regions</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground mb-2">These regions changed between pre-bench and post-bench but were NOT part of the corrected candidate changes.</p>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {threeWayResult.runtimeRewrites.map((r: DiffRegion, i: number) => (
                        <DiffRegionRow key={i} region={r} />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Learned-State Regions */}
              {threeWayResult.learnedStateRegions && threeWayResult.learnedStateRegions.length > 0 && (
                <Card className="border-orange-500/50">
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-orange-500" />
                      Learned-State Region Changes
                      <Badge variant="outline" className="ml-auto">{threeWayResult.learnedStateRegions.length} regions</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground mb-2">Changes in key table / AA50 markers or fob learned-state areas (0x0880–0x09FF, 0x0200–0x023F).</p>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {threeWayResult.learnedStateRegions.map((r: DiffRegion, i: number) => (
                        <DiffRegionRow key={i} region={r} />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Summary Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card>
                  <CardHeader><CardTitle className="text-xs">Corrected vs Pre-Bench</CardTitle></CardHeader>
                  <CardContent className="text-sm">
                    <p>{threeWayResult.correctedVsPre?.changedBytes} bytes ({threeWayResult.correctedVsPre?.changedPercent?.toFixed(2)}%)</p>
                    <p className="text-xs text-muted-foreground">{threeWayResult.correctedVsPre?.regions?.length} regions</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-xs">Corrected vs Post-Bench</CardTitle></CardHeader>
                  <CardContent className="text-sm">
                    <p>{threeWayResult.correctedVsPost?.changedBytes} bytes ({threeWayResult.correctedVsPost?.changedPercent?.toFixed(2)}%)</p>
                    <p className="text-xs text-muted-foreground">{threeWayResult.correctedVsPost?.regions?.length} regions</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-xs">Pre-Bench vs Post-Bench</CardTitle></CardHeader>
                  <CardContent className="text-sm">
                    <p>{threeWayResult.preVsPost?.changedBytes} bytes ({threeWayResult.preVsPost?.changedPercent?.toFixed(2)}%)</p>
                    <p className="text-xs text-muted-foreground">{threeWayResult.preVsPost?.regions?.length} regions</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Confirmation Dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Candidate Export</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to download a modified RFHUB binary. This file has been generated with minimal changes
              (VIN and SEC16 only) using the Gen2 XOR-magic checksum path. Please verify the change report above
              before proceeding.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleExport} disabled={isExporting}>
              {isExporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Confirm & Download
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
