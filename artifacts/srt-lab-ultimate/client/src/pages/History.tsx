import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import {
  ArrowLeft,
  Database,
  FileCode,
  Search,
  Shield,
  ChevronRight,
  Binary,
  Key,
  Radio,
  Trash2,
  GitCompare,
  CheckSquare,
  Square,
  Zap,
} from "lucide-react";

interface VaultEntry {
  id: string;
  filename: string;
  fileSize: number;
  fileType: string;
  timestamp: number;
  status: string;
  summary: string;
  algorithmCount: number;
  seedKeyCount: number;
  canAddressCount: number;
  checksumCount: number;
  stringCount: number;
}

export default function History() {
  const [, navigate] = useLocation();
  const [vault, setVault] = useState<VaultEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<VaultEntry | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Multi-select for diff
  const [compareMode, setCompareMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);

  useEffect(() => {
    fetchVault();
    // Auto-refresh for 2 minutes (24 polls × 5s) to catch analyses that complete after a timeout redirect
    let pollCount = 0;
    const maxPolls = 24; // 2 minutes
    setAutoRefreshing(true);
    const refreshInterval = setInterval(async () => {
      pollCount++;
      try {
        const res = await fetch("/api/vault");
        const data = await res.json();
        setVault(data);
      } catch {}
      if (pollCount >= maxPolls) {
        clearInterval(refreshInterval);
        setAutoRefreshing(false);
      }
    }, 5000);
    return () => {
      clearInterval(refreshInterval);
      setAutoRefreshing(false);
    };
  }, []);

  const fetchVault = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/vault");
      const data = await res.json();
      setVault(data);
    } catch (e) {
      console.error("Failed to fetch vault:", e);
    }
    setLoading(false);
  };

  const handleDelete = async (entry: VaultEntry) => {
    setDeleting(entry.id);
    try {
      const res = await fetch(`/api/analysis/${entry.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Delete failed");
      }
      setVault(prev => prev.filter(v => v.id !== entry.id));
      setSelected(prev => { const n = new Set(prev); n.delete(entry.id); return n; });
    } catch (e: any) {
      console.error("Delete failed:", e);
      alert(`Delete failed: ${e.message}`);
    }
    setDeleting(null);
    setDeleteTarget(null);
  };

  const handleRerun = async (entry: VaultEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    setRerunning(entry.id);
    setRerunError(null);
    try {
      const res = await fetch(`/api/analysis/${entry.id}/rerun`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setRerunError(data.error || "Re-run failed");
      } else {
        // Update the entry status to running in the local state
        setVault((prev) => prev.map((v) => v.id === entry.id ? { ...v, status: "running", summary: "Re-running swarm analysis..." } : v));
      }
    } catch (err: any) {
      setRerunError(err.message || "Re-run failed");
    }
    setRerunning(null);
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= 2) {
          // Replace oldest selection
          const [first] = Array.from(next);
          next.delete(first);
        }
        next.add(id);
      }
      return next;
    });
  };

  const handleCompare = () => {
    const ids = Array.from(selected);
    if (ids.length === 2) {
      navigate(`/diff?id1=${ids[0]}&id2=${ids[1]}`);
    }
  };

  const filteredVault = vault.filter((entry) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      entry.filename.toLowerCase().includes(q) ||
      entry.fileType.toLowerCase().includes(q) ||
      entry.summary.toLowerCase().includes(q)
    );
  });

  const totalAlgorithms = vault.reduce((sum, v) => sum + v.algorithmCount, 0);
  const totalSeedKeys = vault.reduce((sum, v) => sum + v.seedKeyCount, 0);
  const totalCanAddresses = vault.reduce((sum, v) => sum + v.canAddressCount, 0);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
            <div className="h-6 w-px bg-border" />
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              <span className="font-bold text-sm">SRT LAB</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {compareMode && selected.size === 2 && (
              <Button size="sm" onClick={handleCompare} className="bg-primary text-primary-foreground">
                <GitCompare className="w-4 h-4 mr-1" />
                Diff Selected
              </Button>
            )}
            {compareMode && (
              <span className="text-xs text-muted-foreground">
                {selected.size}/2 selected
              </span>
            )}
            <Button
              variant={compareMode ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setCompareMode(m => !m);
                setSelected(new Set());
              }}
            >
              <GitCompare className="w-4 h-4 mr-1" />
              {compareMode ? "Cancel" : "Compare"}
            </Button>
          </div>
        </div>
      </header>
      {rerunError && (
        <div className="bg-destructive/10 border-b border-destructive/30 px-4 py-2 text-xs text-destructive flex items-center gap-2">
          <span>Re-run failed: {rerunError}</span>
          <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setRerunError(null)}>✕</button>
        </div>
      )}

      <main className="container py-6 space-y-6">
        {/* Title */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Database className="w-6 h-6 text-primary" />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-bold">Intelligence Vault</h2>
                {autoRefreshing && (
                  <span className="flex items-center gap-1 text-[10px] font-mono text-primary/70 bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse inline-block" />
                    live
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {compareMode
                  ? "Select 2 analyses to compare their findings side-by-side"
                  : autoRefreshing
                  ? "Auto-refreshing — new analyses will appear automatically"
                  : "All extracted intelligence from analyzed binaries"}
              </p>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="carbon-texture">
            <CardContent className="py-3 text-center">
              <p className="text-2xl font-bold font-mono">{vault.length}</p>
              <p className="text-xs text-muted-foreground">Entries</p>
            </CardContent>
          </Card>
          <Card className="carbon-texture">
            <CardContent className="py-3 text-center">
              <p className="text-2xl font-bold font-mono text-primary">{totalAlgorithms}</p>
              <p className="text-xs text-muted-foreground">Algorithms</p>
            </CardContent>
          </Card>
          <Card className="carbon-texture">
            <CardContent className="py-3 text-center">
              <p className="text-2xl font-bold font-mono text-primary">{totalSeedKeys}</p>
              <p className="text-xs text-muted-foreground">Seed Keys</p>
            </CardContent>
          </Card>
          <Card className="carbon-texture">
            <CardContent className="py-3 text-center">
              <p className="text-2xl font-bold font-mono text-primary">{totalCanAddresses}</p>
              <p className="text-xs text-muted-foreground">CAN Addresses</p>
            </CardContent>
          </Card>
        </div>

        {/* Filter */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Filter by filename, type, or content..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-9 font-mono text-sm"
            />
          </div>
        </div>

        {/* Compare Mode Banner */}
        {compareMode && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3 text-sm">
            <GitCompare className="w-4 h-4 text-primary shrink-0" />
            <span className="text-muted-foreground">
              Click any two entries to select them for comparison.{" "}
              {selected.size === 2 ? (
                <span className="text-primary font-medium">Both selected — click "Diff Selected" to compare.</span>
              ) : (
                <span>{2 - selected.size} more to select.</span>
              )}
            </span>
          </div>
        )}

        {/* Vault List */}
        <div className="space-y-3">
          {loading ? (
            <Card className="carbon-texture">
              <CardContent className="py-8 text-center text-muted-foreground">
                <p className="animate-pulse">Loading vault...</p>
              </CardContent>
            </Card>
          ) : filteredVault.length === 0 ? (
            <Card className="carbon-texture">
              <CardContent className="py-8 text-center text-muted-foreground">
                <p>No entries found.</p>
              </CardContent>
            </Card>
          ) : (
            filteredVault.map((entry) => {
              const isSelected = selected.has(entry.id);
              return (
                <Card
                  key={entry.id}
                  className={`carbon-texture transition-all duration-150 ${
                    compareMode
                      ? isSelected
                        ? "border-primary/60 ring-1 ring-primary/30 cursor-pointer"
                        : "hover:border-primary/30 cursor-pointer"
                      : "hover:border-primary/30"
                  }`}
                  onClick={compareMode ? (e) => { e.stopPropagation(); toggleSelect(entry.id); } : undefined}
                >
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      {/* Left: checkbox (compare mode) or icon */}
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        {compareMode ? (
                          <div className="w-10 h-10 rounded flex items-center justify-center shrink-0 pointer-events-none">
                            {isSelected ? (
                              <CheckSquare className="w-5 h-5 text-primary" />
                            ) : (
                              <Square className="w-5 h-5 text-muted-foreground" />
                            )}
                          </div>
                        ) : (
                          <div
                            className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center shrink-0 cursor-pointer"
                            onClick={(e) => { e.stopPropagation(); navigate(`/analysis/${entry.id}`); }}
                          >
                            <FileCode className="w-5 h-5 text-primary" />
                          </div>
                        )}
                        <div
                          className={`min-w-0 flex-1 ${compareMode ? "" : "cursor-pointer"}`}
                          onClick={compareMode ? undefined : (e) => { e.stopPropagation(); navigate(`/analysis/${entry.id}`); }}
                        >
                          <p className="font-medium font-mono text-sm truncate">{entry.filename}</p>
                          <p className="text-xs text-muted-foreground">
                            {entry.fileType} •{" "}
                            {entry.fileSize > 0
                              ? `${(entry.fileSize / 1024).toFixed(1)} KB`
                              : "< 1 KB"}{" "}
                            • {new Date(entry.timestamp).toLocaleDateString()}
                          </p>
                        </div>
                      </div>

                      {/* Right: badges + actions */}
                      <div className="flex items-center gap-2 shrink-0 ml-3">
                        {entry.algorithmCount > 0 && (
                          <Badge variant="outline" className="text-xs gap-1 hidden sm:flex">
                            <Binary className="w-3 h-3" />
                            {entry.algorithmCount}
                          </Badge>
                        )}
                        {entry.seedKeyCount > 0 && (
                          <Badge variant="outline" className="text-xs gap-1 hidden sm:flex">
                            <Key className="w-3 h-3" />
                            {entry.seedKeyCount}
                          </Badge>
                        )}
                        {entry.canAddressCount > 0 && (
                          <Badge variant="outline" className="text-xs gap-1 hidden sm:flex">
                            <Radio className="w-3 h-3" />
                            {entry.canAddressCount}
                          </Badge>
                        )}
                        {!compareMode && (
                          <>
                            <ChevronRight
                              className="w-4 h-4 text-muted-foreground cursor-pointer"
                              onClick={(e) => { e.stopPropagation(); navigate(`/analysis/${entry.id}`); }}
                            />
                            {(!entry.summary || entry.status === "failed") && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="w-7 h-7 text-orange-400 hover:text-orange-300 hover:bg-orange-500/10 transition-colors"
                                disabled={rerunning === entry.id}
                                onClick={(e) => handleRerun(entry, e)}
                                title="Re-run full 5-agent swarm"
                              >
                                <Zap className={`w-3.5 h-3.5 ${rerunning === entry.id ? "animate-spin" : ""}`} />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="w-7 h-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                              disabled={deleting === entry.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(entry);
                              }}
                              title="Delete from vault"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    {entry.summary && (
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2 pl-13">
                        {entry.summary}
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </main>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">Delete from Vault?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              This will permanently remove{" "}
              <span className="font-mono text-foreground font-medium">
                {deleteTarget?.filename}
              </span>{" "}
              and all its extracted intelligence from the vault. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-transparent border-border text-foreground hover:bg-muted">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
              disabled={!!deleting}
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
