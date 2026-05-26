import { useState, useEffect, useCallback } from "react";
import { Ban, CheckCircle2, Copy, Eye, Link2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface ShareLink {
  id: string;
  token: string;
  label: string | null;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  createdAt: string;
  revokedAt: string | null;
}

interface ShareLinksListProps {
  analysisId: string;
}

export function ShareLinksList({ analysisId }: ShareLinksListProps) {
  const { toast } = useToast();
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active" | "revoked">("all");
  const [search, setSearch] = useState("");

  const loadLinks = useCallback(async () => {
    setIsLoading(true);
    try {
      const r = await fetch(`/api/analysis/${analysisId}/share`);
      if (r.ok) {
        const data = await r.json() as ShareLink[];
        setLinks(Array.isArray(data) ? data : []);
      }
    } catch { /* ignore */ } finally { setIsLoading(false); }
  }, [analysisId]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const revokeLink = async (id: string) => {
    await fetch(`/api/share/${id}`, { method: "DELETE" });
    await loadLinks();
    toast({ title: "Link revoked" });
  };

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/shared/${token}`;
    navigator.clipboard.writeText(url).then(() => toast({ title: "Link copied!" }));
  };

  const updateLabel = async (id: string, label: string) => {
    await fetch(`/api/share/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    await loadLinks();
  };

  const filtered = links.filter(l => {
    if (filter === "active" && l.revokedAt) return false;
    if (filter === "revoked" && !l.revokedAt) return false;
    if (search && !(l.label ?? "").toLowerCase().includes(search.toLowerCase()) && !l.token.includes(search)) return false;
    return true;
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search links…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="font-mono text-xs h-8"
        />
        <Select value={filter} onValueChange={v => setFilter(v as typeof filter)}>
          <SelectTrigger className="w-28 h-8 font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={loadLinks}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {isLoading ? (
        <p className="font-mono text-xs text-muted-foreground text-center py-4">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground text-center py-4">No links found.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map(link => (
            <div key={link.id} className="border border-border rounded-md p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {link.revokedAt ? (
                      <Badge variant="destructive" className="text-[10px]"><Ban className="w-2.5 h-2.5 mr-1" />Revoked</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-green-400 border-green-500/30"><CheckCircle2 className="w-2.5 h-2.5 mr-1" />Active</Badge>
                    )}
                    <span className="font-mono text-xs text-foreground truncate">{link.label ?? "Untitled"}</span>
                  </div>
                  <div className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><Eye className="w-2.5 h-2.5" />{link.viewCount}{link.maxViews ? ` / ${link.maxViews}` : ""}</span>
                    <span className="flex items-center gap-1"><Link2 className="w-2.5 h-2.5" />{link.token.slice(0, 8)}…</span>
                    {link.expiresAt && <span>Exp. {new Date(link.expiresAt).toLocaleDateString()}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!link.revokedAt && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyLink(link.token)} title="Copy link">
                      <Copy className="w-3 h-3" />
                    </Button>
                  )}
                  {!link.revokedAt && (
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => revokeLink(link.id)} title="Revoke">
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
