import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Activity,
  ArrowLeft,
  Search,
  Binary,
  Key,
  Radio,
  ChevronRight,
  Clock,
  FileCode,
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
}

export default function AnalysisList() {
  const [, navigate] = useLocation();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/vault")
      .then((r) => r.json())
      .then((data) => {
        setEntries(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = entries.filter((e) =>
    !filter ||
    e.filename?.toLowerCase().includes(filter.toLowerCase()) ||
    e.summary?.toLowerCase().includes(filter.toLowerCase()) ||
    e.fileType?.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/")}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Analyses</h1>
          {!loading && (
            <Badge variant="secondary" className="text-xs">
              {filtered.length}
            </Badge>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          className="pl-9 bg-card border-border/50 text-sm"
          placeholder="Filter by filename, type, or content..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-card/40 animate-pulse border border-border/20" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <FileCode className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {filter ? "No analyses match your filter." : "No analyses yet. Upload a binary to get started."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => (
            <button
              key={entry.id}
              onClick={() => navigate(`/analysis/${entry.id}`)}
              className="w-full text-left bg-card/60 border border-border/30 rounded-lg px-4 py-3 hover:border-primary/40 hover:bg-card/80 transition-all group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-sm font-semibold text-foreground truncate">
                      {entry.filename || "Unknown"}
                    </span>
                    <Badge
                      variant="outline"
                      className="text-[10px] shrink-0 border-primary/30 text-primary/70"
                    >
                      {entry.fileType || "Binary"}
                    </Badge>
                    {entry.status === "complete" && (
                      <Badge className="text-[10px] shrink-0 bg-green-500/10 text-green-400 border-green-500/30">
                        complete
                      </Badge>
                    )}
                  </div>
                  {entry.summary && (
                    <p className="text-xs text-muted-foreground line-clamp-1 mb-2">
                      {entry.summary}
                    </p>
                  )}
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
                    <span className="flex items-center gap-1">
                      <Binary className="w-3 h-3" />
                      {entry.algorithmCount || 0} alg
                    </span>
                    <span className="flex items-center gap-1">
                      <Key className="w-3 h-3" />
                      {entry.seedKeyCount || 0} keys
                    </span>
                    <span className="flex items-center gap-1">
                      <Radio className="w-3 h-3" />
                      {entry.canAddressCount || 0} CAN
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {entry.timestamp
                        ? new Date(entry.timestamp).toLocaleDateString()
                        : "—"}
                    </span>
                    <span className="text-zinc-600">
                      {entry.fileSize
                        ? `${(entry.fileSize / 1024).toFixed(1)} KB`
                        : ""}
                    </span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary/60 transition-colors shrink-0 mt-1" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
