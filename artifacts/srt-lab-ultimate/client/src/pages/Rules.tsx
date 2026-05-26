import { useState, useRef, useCallback } from "react";
import { ShieldCheck, Upload, Trash2, FileText, AlertCircle, CheckCircle, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

interface YaraRule {
  id: string;
  name: string;
  filename: string;
  fileSize: number;
  ruleCount: number;
  storageKey: string;
  createdAt: number;
}

export default function Rules() {
  const [rules, setRules] = useState<YaraRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/yara-rules");
      if (!r.ok) throw new Error(await r.text());
      setRules(await r.json());
      setLoaded(true);
    } catch (e: any) {
      toast({ title: "Failed to load rules", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // Load on mount
  useState(() => { loadRules(); });

  const uploadFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.(yar|yara)$/i)) {
      toast({ title: "Invalid file", description: "Only .yar and .yara files are accepted", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (ruleName.trim()) fd.append("name", ruleName.trim());
      const r = await fetch("/api/yara-rules", { method: "POST", body: fd });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Upload failed");
      }
      const result = await r.json();
      toast({ title: "Rule uploaded", description: `${result.ruleCount} rule${result.ruleCount !== 1 ? "s" : ""} loaded from ${file.name}` });
      setRuleName("");
      loadRules();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [ruleName, toast, loadRules]);

  const deleteRule = useCallback(async (id: string, name: string) => {
    try {
      const r = await fetch(`/api/yara-rules/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
      setRules(prev => prev.filter(r => r.id !== id));
      toast({ title: "Rule deleted", description: `"${name}" removed` });
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    }
  }, [toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    files.forEach(f => uploadFile(f));
  }, [uploadFile]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatDate = (ts: number) => new Date(ts).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit"
  });

  return (
    <div className="min-h-screen bg-background text-foreground p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">YARA Rules</h1>
            <p className="text-sm text-muted-foreground">Upload and manage YARA rule files for binary scanning</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadRules} disabled={loading} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Upload Card */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="w-4 h-4 text-emerald-400" />
            Add YARA Rule File
          </CardTitle>
          <CardDescription>Upload a .yar or .yara file containing one or more YARA rules</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rule-name">Rule Set Name (optional)</Label>
            <Input
              id="rule-name"
              placeholder="e.g. FCA BCM Patterns"
              value={ruleName}
              onChange={e => setRuleName(e.target.value)}
              className="max-w-sm"
            />
          </div>

          {/* Drop Zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`
              relative border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all duration-200
              ${dragOver
                ? "border-emerald-400 bg-emerald-500/10 scale-[1.01]"
                : "border-border hover:border-emerald-500/50 hover:bg-emerald-500/5"
              }
            `}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".yar,.yara"
              multiple
              className="hidden"
              onChange={e => Array.from(e.target.files || []).forEach(f => uploadFile(f))}
            />
            {uploading ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
                <p className="text-sm text-muted-foreground">Uploading...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="w-8 h-8 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">Drop .yar / .yara files here</p>
                <p className="text-xs text-muted-foreground">or click to browse</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Rules List */}
      <Card className="border-border bg-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-400" />
              Loaded Rules
              {loaded && (
                <Badge variant="secondary" className="ml-1 text-xs">
                  {rules.length} file{rules.length !== 1 ? "s" : ""}
                </Badge>
              )}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !loaded ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : rules.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <AlertCircle className="w-8 h-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">No YARA rules uploaded yet</p>
              <p className="text-xs text-muted-foreground/70">Upload a .yar or .yara file above to get started</p>
            </div>
          ) : (
            <div className="space-y-2">
              {rules.map(rule => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between p-4 rounded-lg border border-border bg-background/50 hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-md bg-emerald-500/10 shrink-0">
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{rule.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{rule.filename} · {formatSize(rule.fileSize)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <Badge variant="outline" className="text-xs border-emerald-500/30 text-emerald-400">
                      {rule.ruleCount} rule{rule.ruleCount !== 1 ? "s" : ""}
                    </Badge>
                    <span className="text-xs text-muted-foreground hidden sm:block">{formatDate(rule.createdAt)}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
                      onClick={() => deleteRule(rule.id, rule.name)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Usage Info */}
      <Card className="border-border bg-card border-emerald-500/20">
        <CardContent className="pt-4">
          <div className="flex gap-3">
            <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">How YARA scanning works</p>
              <p className="text-sm text-muted-foreground">
                Open any analysis and click the orange <strong>YARA</strong> button in the header toolbar to run all your uploaded rules against that binary. Matches will show rule name, offset, and matched string context.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
