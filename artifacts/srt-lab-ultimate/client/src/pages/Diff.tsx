import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  GitCompare,
  ArrowLeft,
  FileCode2,
  Key,
  Radio,
  Hash,
  Shield,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
  PlusCircle,
} from "lucide-react";

interface DiffMeta {
  id: string;
  filename: string;
  fileSize: number;
  analyzedAt: number;
  fileType: string;
}

interface DiffSection<T> {
  onlyInA: T[];
  onlyInB: T[];
  inBoth: T[];
}

interface AnalysisDiff {
  meta: { a: DiffMeta; b: DiffMeta };
  summaries: { a: string; b: string };
  algorithms: DiffSection<any>;
  seedKeys: DiffSection<any>;
  canAddresses: DiffSection<any>;
  checksums: DiffSection<any>;
  securityBytes: DiffSection<any>;
  deepFindings: DiffSection<any>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function DiffBadge({ type }: { type: "only-a" | "only-b" | "both" }) {
  if (type === "only-a")
    return (
      <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs">
        <MinusCircle className="w-3 h-3 mr-1" />
        Only in A
      </Badge>
    );
  if (type === "only-b")
    return (
      <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
        <PlusCircle className="w-3 h-3 mr-1" />
        Only in B
      </Badge>
    );
  return (
    <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-xs">
      <CheckCircle2 className="w-3 h-3 mr-1" />
      Both
    </Badge>
  );
}

function SectionDiff<T extends Record<string, any>>({
  section,
  renderItem,
  emptyLabel,
}: {
  section: DiffSection<T>;
  renderItem: (item: T, type: "only-a" | "only-b" | "both") => React.ReactNode;
  emptyLabel: string;
}) {
  const total = section.onlyInA.length + section.onlyInB.length + section.inBoth.length;
  if (total === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {section.onlyInA.map((item, i) => (
        <div key={`a-${i}`}>{renderItem(item, "only-a")}</div>
      ))}
      {section.onlyInB.map((item, i) => (
        <div key={`b-${i}`}>{renderItem(item, "only-b")}</div>
      ))}
      {section.inBoth.map((item, i) => (
        <div key={`both-${i}`}>{renderItem(item, "both")}</div>
      ))}
    </div>
  );
}

export default function Diff() {
  const [, navigate] = useLocation();
  const [diff, setDiff] = useState<AnalysisDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Parse IDs from URL query string
  const params = new URLSearchParams(window.location.search);
  const id1 = params.get("id1") || "";
  const id2 = params.get("id2") || "";

  useEffect(() => {
    if (!id1 || !id2) {
      setError("Two analysis IDs are required. Select two analyses from the History page.");
      setLoading(false);
      return;
    }

    fetch(`/api/diff?id1=${encodeURIComponent(id1)}&id2=${encodeURIComponent(id2)}`)
      .then((r) => {
        if (!r.ok) return r.json().then((e) => Promise.reject(e.error || "Diff failed"));
        return r.json();
      })
      .then((data) => {
        setDiff(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [id1, id2]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <GitCompare className="w-12 h-12 text-primary mx-auto animate-pulse" />
          <p className="text-muted-foreground">Loading diff...</p>
        </div>
      </div>
    );
  }

  if (error || !diff) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4 max-w-md">
          <AlertTriangle className="w-12 h-12 text-destructive mx-auto" />
          <p className="text-destructive">{error || "Unknown error"}</p>
          <Button variant="outline" onClick={() => navigate("/history")}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to History
          </Button>
        </div>
      </div>
    );
  }

  const { meta, summaries, algorithms, seedKeys, canAddresses, checksums, securityBytes, deepFindings } = diff;

  const totalOnlyA = algorithms.onlyInA.length + seedKeys.onlyInA.length + canAddresses.onlyInA.length + checksums.onlyInA.length + securityBytes.onlyInA.length + deepFindings.onlyInA.length;
  const totalOnlyB = algorithms.onlyInB.length + seedKeys.onlyInB.length + canAddresses.onlyInB.length + checksums.onlyInB.length + securityBytes.onlyInB.length + deepFindings.onlyInB.length;
  const totalBoth = algorithms.inBoth.length + seedKeys.inBoth.length + canAddresses.inBoth.length + checksums.inBoth.length + securityBytes.inBoth.length + deepFindings.inBoth.length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <div className="border-b border-border/40 bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate("/history")}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            History
          </Button>
          <div className="flex items-center gap-2">
            <GitCompare className="w-5 h-5 text-primary" />
            <span className="font-bold text-lg">Analysis Diff</span>
          </div>
          <div className="flex items-center gap-2 ml-auto text-sm text-muted-foreground">
            <Badge variant="outline" className="text-amber-400 border-amber-500/30">
              {totalOnlyA} only in A
            </Badge>
            <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
              {totalOnlyB} only in B
            </Badge>
            <Badge variant="outline" className="text-blue-400 border-blue-500/30">
              {totalBoth} shared
            </Badge>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* File Meta Comparison */}
        <div className="grid grid-cols-2 gap-4">
          {[meta.a, meta.b].map((m, i) => (
            <Card key={i} className={`border ${i === 0 ? "border-amber-500/30" : "border-emerald-500/30"}`}>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Badge className={i === 0 ? "bg-amber-500/20 text-amber-400" : "bg-emerald-500/20 text-emerald-400"}>
                    {i === 0 ? "A" : "B"}
                  </Badge>
                  <CardTitle className="text-sm font-mono truncate">{m.filename}</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1">
                <div className="flex justify-between">
                  <span>Size</span>
                  <span className="font-mono">{formatBytes(m.fileSize)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Type</span>
                  <span className="font-mono">{m.fileType || "Unknown"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Analyzed</span>
                  <span className="font-mono">{formatDate(m.analyzedAt)}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full mt-2 text-xs h-7"
                  onClick={() => navigate(`/analysis/${m.id}`)}
                >
                  View Full Analysis →
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Summary Diff */}
        <div className="grid grid-cols-2 gap-4">
          {[
            { label: "A", summary: summaries.a, color: "amber" },
            { label: "B", summary: summaries.b, color: "emerald" },
          ].map((s, i) => (
            <Card key={i} className={`border border-${s.color}-500/20`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Badge className={`bg-${s.color}-500/20 text-${s.color}-400`}>{s.label}</Badge>
                  Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {s.summary || "No summary available."}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Findings Diff Tabs */}
        <Tabs defaultValue="algorithms">
          <TabsList className="grid grid-cols-6 w-full">
            <TabsTrigger value="algorithms" className="text-xs">
              <Cpu className="w-3 h-3 mr-1" />
              Algos ({algorithms.onlyInA.length + algorithms.onlyInB.length + algorithms.inBoth.length})
            </TabsTrigger>
            <TabsTrigger value="seedkeys" className="text-xs">
              <Key className="w-3 h-3 mr-1" />
              Seeds ({seedKeys.onlyInA.length + seedKeys.onlyInB.length + seedKeys.inBoth.length})
            </TabsTrigger>
            <TabsTrigger value="can" className="text-xs">
              <Radio className="w-3 h-3 mr-1" />
              CAN ({canAddresses.onlyInA.length + canAddresses.onlyInB.length + canAddresses.inBoth.length})
            </TabsTrigger>
            <TabsTrigger value="checksums" className="text-xs">
              <Hash className="w-3 h-3 mr-1" />
              CRC ({checksums.onlyInA.length + checksums.onlyInB.length + checksums.inBoth.length})
            </TabsTrigger>
            <TabsTrigger value="security" className="text-xs">
              <Shield className="w-3 h-3 mr-1" />
              Sec ({securityBytes.onlyInA.length + securityBytes.onlyInB.length + securityBytes.inBoth.length})
            </TabsTrigger>
            <TabsTrigger value="deep" className="text-xs">
              <FileCode2 className="w-3 h-3 mr-1" />
              Deep ({deepFindings.onlyInA.length + deepFindings.onlyInB.length + deepFindings.inBoth.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="algorithms" className="mt-4">
            <SectionDiff
              section={algorithms}
              emptyLabel="No algorithms found in either analysis."
              renderItem={(item, type) => (
                <Card className="border border-border/40">
                  <CardContent className="py-3 px-4 flex items-start gap-3">
                    <DiffBadge type={type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{item.name || "Unknown"}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{item.description || ""}</p>
                      {item.constants?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {item.constants.slice(0, 4).map((c: string, ci: number) => (
                            <Badge key={ci} variant="outline" className="text-xs font-mono">{c}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <Badge variant="outline" className="text-xs shrink-0">{item.confidence || ""}</Badge>
                  </CardContent>
                </Card>
              )}
            />
          </TabsContent>

          <TabsContent value="seedkeys" className="mt-4">
            <SectionDiff
              section={seedKeys}
              emptyLabel="No seed-key algorithms found in either analysis."
              renderItem={(item, type) => (
                <Card className="border border-border/40">
                  <CardContent className="py-3 px-4 flex items-start gap-3">
                    <DiffBadge type={type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{item.module || "Unknown Module"}</p>
                      <p className="text-xs text-muted-foreground">{item.algorithm || ""}</p>
                      {item.seedOffset && (
                        <p className="text-xs font-mono text-cyan-400 mt-0.5">Seed @ {item.seedOffset}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            />
          </TabsContent>

          <TabsContent value="can" className="mt-4">
            <SectionDiff
              section={canAddresses}
              emptyLabel="No CAN addresses found in either analysis."
              renderItem={(item, type) => (
                <Card className="border border-border/40">
                  <CardContent className="py-3 px-4 flex items-start gap-3">
                    <DiffBadge type={type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{item.module || "Unknown"}</p>
                      <div className="flex gap-3 mt-0.5 text-xs font-mono">
                        {item.txId && <span className="text-green-400">TX: {item.txId}</span>}
                        {item.rxId && <span className="text-blue-400">RX: {item.rxId}</span>}
                      </div>
                      {item.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            />
          </TabsContent>

          <TabsContent value="checksums" className="mt-4">
            <SectionDiff
              section={checksums}
              emptyLabel="No checksums found in either analysis."
              renderItem={(item, type) => (
                <Card className="border border-border/40">
                  <CardContent className="py-3 px-4 flex items-start gap-3">
                    <DiffBadge type={type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{item.type || "Unknown CRC"}</p>
                      {item.polynomial && (
                        <p className="text-xs font-mono text-purple-400">Poly: {item.polynomial}</p>
                      )}
                      {item.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            />
          </TabsContent>

          <TabsContent value="security" className="mt-4">
            <SectionDiff
              section={securityBytes}
              emptyLabel="No security bytes found in either analysis."
              renderItem={(item, type) => (
                <Card className="border border-border/40">
                  <CardContent className="py-3 px-4 flex items-start gap-3">
                    <DiffBadge type={type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{item.module || "Unknown"}</p>
                      {item.offset && (
                        <p className="text-xs font-mono text-red-400">@ {item.offset}</p>
                      )}
                      {item.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            />
          </TabsContent>

          <TabsContent value="deep" className="mt-4">
            <SectionDiff
              section={deepFindings}
              emptyLabel="No deep findings in either analysis."
              renderItem={(item, type) => (
                <Card className="border border-border/40">
                  <CardContent className="py-3 px-4 flex items-start gap-3">
                    <DiffBadge type={type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{item.title || "Finding"}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3">{item.detail || item.description || ""}</p>
                    </div>
                    {item.severity && (
                      <Badge
                        variant="outline"
                        className={`text-xs shrink-0 ${
                          item.severity === "critical"
                            ? "text-red-400 border-red-500/30"
                            : item.severity === "high"
                            ? "text-orange-400 border-orange-500/30"
                            : "text-yellow-400 border-yellow-500/30"
                        }`}
                      >
                        {item.severity}
                      </Badge>
                    )}
                  </CardContent>
                </Card>
              )}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
