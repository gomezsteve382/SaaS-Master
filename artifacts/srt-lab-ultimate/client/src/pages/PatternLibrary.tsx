import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  BookOpen,
  Plus,
  Trash2,
  Search,
  Tag,
  ChevronDown,
  ChevronRight,
  Cpu,
  Key,
  Radio,
  Shield,
  Hash,
  Map,
  FileText,
  Binary,
  Code,
  Network,
  Layers,
  ArrowLeft,
} from "lucide-react";


// ─── Types ────────────────────────────────────────────────────────────────────

type PatternCategory =
  | "crypto_algorithm"
  | "seed_key"
  | "can_id"
  | "uds_service"
  | "checksum"
  | "memory_map"
  | "string_pattern"
  | "byte_sequence"
  | "function_signature"
  | "protocol_sequence"
  | "other";

interface Pattern {
  id: string;
  category: PatternCategory;
  name: string;
  description: string | null;
  patternData: string;
  metadata: Record<string, unknown> | null;
  matchCount: number;
  tags: string[] | null;
  sourceAnalysisId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ─── Category metadata ────────────────────────────────────────────────────────

const CATEGORY_META: Record<PatternCategory, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  crypto_algorithm: { label: "Crypto Algorithm", icon: Cpu, color: "text-green-400 border-green-400/30 bg-green-400/5" },
  seed_key: { label: "Seed-Key", icon: Key, color: "text-yellow-400 border-yellow-400/30 bg-yellow-400/5" },
  can_id: { label: "CAN ID", icon: Radio, color: "text-blue-400 border-blue-400/30 bg-blue-400/5" },
  uds_service: { label: "UDS Service", icon: Shield, color: "text-purple-400 border-purple-400/30 bg-purple-400/5" },
  checksum: { label: "Checksum", icon: Hash, color: "text-orange-400 border-orange-400/30 bg-orange-400/5" },
  memory_map: { label: "Memory Map", icon: Map, color: "text-cyan-400 border-cyan-400/30 bg-cyan-400/5" },
  string_pattern: { label: "String Pattern", icon: FileText, color: "text-pink-400 border-pink-400/30 bg-pink-400/5" },
  byte_sequence: { label: "Byte Sequence", icon: Binary, color: "text-red-400 border-red-400/30 bg-red-400/5" },
  function_signature: { label: "Function Signature", icon: Code, color: "text-indigo-400 border-indigo-400/30 bg-indigo-400/5" },
  protocol_sequence: { label: "Protocol Sequence", icon: Network, color: "text-teal-400 border-teal-400/30 bg-teal-400/5" },
  other: { label: "Other", icon: Layers, color: "text-muted-foreground border-border/30 bg-muted/10" },
};

// ─── Pattern Card ─────────────────────────────────────────────────────────────

function PatternCard({ pattern, onDelete }: { pattern: Pattern; onDelete: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const meta = CATEGORY_META[pattern.category] || CATEGORY_META.other;
  const Icon = meta.icon;

  return (
    <Card className={`carbon-texture border ${meta.color} transition-all`}>
      <CardContent className="py-3">
        <button className="w-full flex items-start gap-3 text-left" onClick={() => setExpanded(e => !e)}>
          <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${meta.color.split(" ")[0]}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-semibold text-foreground">{pattern.name}</span>
              <Badge variant="outline" className={`text-[10px] ${meta.color}`}>{meta.label}</Badge>
              {pattern.matchCount > 1 && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {pattern.matchCount} matches
                </Badge>
              )}
            </div>
            {pattern.description && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{pattern.description}</p>
            )}
            {pattern.tags && pattern.tags.length > 0 && (
              <div className="flex gap-1 mt-1 flex-wrap">
                {pattern.tags.map((tag) => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground font-mono">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="text-muted-foreground hover:text-destructive transition-colors p-1"
              onClick={(e) => { e.stopPropagation(); onDelete(pattern.id); }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          </div>
        </button>

        {expanded && (
          <div className="mt-3 pt-3 border-t border-border/30 space-y-2">
            <div>
              <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-1">Pattern Data</p>
              <pre className="text-xs font-mono bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {pattern.patternData}
              </pre>
            </div>
            {pattern.metadata && Object.keys(pattern.metadata).length > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-1">Metadata</p>
                <pre className="text-xs font-mono bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(pattern.metadata, null, 2)}
                </pre>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">
              Created {new Date(pattern.createdAt).toLocaleString()}
              {pattern.sourceAnalysisId && ` · from analysis ${pattern.sourceAnalysisId.slice(0, 8)}…`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Create Pattern Dialog ────────────────────────────────────────────────────

function CreatePatternDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    category: "other" as PatternCategory,
    name: "",
    description: "",
    patternData: "",
    tags: "",
  });

  const handleSubmit = async () => {
    if (!form.name || !form.patternData) return;
    setLoading(true);
    try {
      const tags = form.tags.split(",").map(t => t.trim()).filter(Boolean);
      const res = await fetch("/api/patterns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, tags }),
      });
      if (res.ok) {
        setOpen(false);
        setForm({ category: "other", name: "", description: "", patternData: "", tags: "" });
        onCreated();
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <Plus className="w-4 h-4" />
          Add Pattern
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Pattern to Library</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={form.category} onValueChange={(v) => setForm(f => ({ ...f, category: v as PatternCategory }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CATEGORY_META) as PatternCategory[]).map((cat) => (
                  <SelectItem key={cat} value={cat}>{CATEGORY_META[cat].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input
              placeholder="e.g. AES-128 CBC Key Schedule"
              value={form.name}
              onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input
              placeholder="Brief description of what this pattern represents"
              value={form.description}
              onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Pattern Data *</Label>
            <Textarea
              placeholder="Hex bytes, regex, algorithm pseudocode, offset, etc."
              value={form.patternData}
              onChange={(e) => setForm(f => ({ ...f, patternData: e.target.value }))}
              rows={4}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Tags (comma-separated)</Label>
            <Input
              placeholder="chrysler, aes128, j2534"
              value={form.tags}
              onChange={(e) => setForm(f => ({ ...f, tags: e.target.value }))}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={loading || !form.name || !form.patternData}>
              {loading ? "Saving..." : "Save Pattern"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PatternLibrary() {
  const [user, setUser] = useState<{ name?: string } | null>({ name: "Public User" });
  const [authLoading, setAuthLoading] = useState(true);
  const [, navigate] = useLocation();
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  // No authentication required - public access
  useEffect(() => {
    setAuthLoading(false);
    setUser({ name: "Public User" });
  }, []);

  const fetchPatterns = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (search) params.set("search", search);
      const res = await fetch(`/api/patterns?${params}`);
      if (res.ok) {
        const data = await res.json();
        setPatterns(data.patterns || []);
      }
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, search]);

  useEffect(() => {
    if (user) fetchPatterns();
  }, [user, fetchPatterns]);

  const handleDelete = async (id: string) => {
    await fetch(`/api/patterns/${id}`, { method: "DELETE" });
    setPatterns(prev => prev.filter(p => p.id !== id));
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  // Group patterns by category
  const grouped = patterns.reduce<Record<string, Pattern[]>>((acc, p) => {
    const cat = p.category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(p);
    return acc;
  }, {});

  const categoryCounts = Object.entries(grouped).map(([cat, ps]) => ({ cat, count: ps.length }));

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/30 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
          <button onClick={() => navigate("/")} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <BookOpen className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-sm font-bold">Pattern Library</h1>
            <p className="text-[10px] text-muted-foreground">Cross-file intelligence — {patterns.length} patterns</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <CreatePatternDialog onCreated={fetchPatterns} />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Filters */}
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search patterns..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {(Object.keys(CATEGORY_META) as PatternCategory[]).map((cat) => (
                <SelectItem key={cat} value={cat}>{CATEGORY_META[cat].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Category summary chips */}
        {categoryCounts.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {categoryCounts.map(({ cat, count }) => {
              const meta = CATEGORY_META[cat as PatternCategory] || CATEGORY_META.other;
              const Icon = meta.icon;
              return (
                <button
                  key={cat}
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    categoryFilter === cat ? meta.color : "border-border/40 text-muted-foreground hover:border-border"
                  }`}
                  onClick={() => setCategoryFilter(categoryFilter === cat ? "all" : cat)}
                >
                  <Icon className="w-3 h-3" />
                  {meta.label}
                  <span className="font-bold">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Pattern list */}
        {loading ? (
          <div className="text-center py-16 text-muted-foreground">
            <div className="animate-pulse text-sm">Loading patterns...</div>
          </div>
        ) : patterns.length === 0 ? (
          <Card className="carbon-texture">
            <CardContent className="py-16 text-center space-y-3">
              <BookOpen className="w-10 h-10 mx-auto text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">No patterns yet.</p>
              <p className="text-xs text-muted-foreground opacity-70">
                Patterns are auto-extracted when you run analyses, or you can add them manually.
              </p>
              <p className="text-xs text-muted-foreground opacity-70">
                To extract patterns from a saved analysis, go to the Analysis page and click "Extract to Pattern Library".
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {categoryFilter === "all" ? (
              // Grouped by category
              Object.entries(grouped).map(([cat, ps]) => {
                const meta = CATEGORY_META[cat as PatternCategory] || CATEGORY_META.other;
                const Icon = meta.icon;
                return (
                  <div key={cat}>
                    <div className="flex items-center gap-2 mb-3">
                      <Icon className={`w-4 h-4 ${meta.color.split(" ")[0]}`} />
                      <h2 className="text-sm font-semibold">{meta.label}</h2>
                      <Badge variant="outline" className="text-xs">{ps.length}</Badge>
                    </div>
                    <div className="space-y-2">
                      {ps.map((p) => (
                        <PatternCard key={p.id} pattern={p} onDelete={handleDelete} />
                      ))}
                    </div>
                  </div>
                );
              })
            ) : (
              // Flat list for filtered view
              <div className="space-y-2">
                {patterns.map((p) => (
                  <PatternCard key={p.id} pattern={p} onDelete={handleDelete} />
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
