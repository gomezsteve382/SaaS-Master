import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  Search,
  HexagonIcon,
  FileCode,
  Clock,
  ChevronRight,
} from "lucide-react";

interface VaultEntry {
  id: string;
  filename: string;
  fileSize: number;
  fileType: string;
  timestamp: number;
  status: string;
  summary: string;
}

export default function HexViewerLanding() {
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

  const filtered = entries.filter(
    (e) =>
      !filter ||
      e.filename?.toLowerCase().includes(filter.toLowerCase()) ||
      e.fileType?.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/")}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <HexagonIcon className="w-5 h-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Hex Viewer</h1>
        </div>
      </div>

      {/* Instructions */}
      <div className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Select an analysis from the vault below to open its binary in the hex viewer.
          You can browse raw bytes, jump to specific offsets, and search for patterns.
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          className="pl-9 bg-card border-border/50 text-sm"
          placeholder="Filter by filename or type..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-lg bg-card/40 animate-pulse border border-border/20"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <FileCode className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {filter
              ? "No files match your filter."
              : "No analyses yet. Upload a binary to get started."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => (
            <button
              key={entry.id}
              onClick={() => navigate(`/hex/${entry.id}`)}
              className="w-full text-left bg-card/60 border border-border/30 rounded-lg px-4 py-3 hover:border-primary/40 hover:bg-card/80 transition-all group"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <HexagonIcon className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                    <span className="font-mono text-sm font-semibold text-foreground truncate">
                      {entry.filename || "Unknown"}
                    </span>
                    <Badge
                      variant="outline"
                      className="text-[10px] shrink-0 border-primary/30 text-primary/70"
                    >
                      {entry.fileType || "Binary"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70 pl-5">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {entry.timestamp
                        ? new Date(entry.timestamp).toLocaleDateString()
                        : "—"}
                    </span>
                    <span>
                      {entry.fileSize
                        ? `${(entry.fileSize / 1024).toFixed(1)} KB`
                        : ""}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-primary/60 group-hover:text-primary transition-colors shrink-0">
                  <span className="font-mono hidden sm:inline">Open in Hex Viewer</span>
                  <ChevronRight className="w-4 h-4" />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
