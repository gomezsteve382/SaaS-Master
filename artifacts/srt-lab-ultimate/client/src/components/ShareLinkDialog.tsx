import { useState, useEffect, useCallback } from "react";
import { Ban, Bell, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, Download, Send, ShieldAlert, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  reminderWindowDays?: number | null;
  lastReminderSentAt?: number | null;
}

interface AccessLogEntry {
  id: string;
  viewedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

interface ShareLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  analysisId: string;
  filename: string;
}

export function ShareLinkDialog({ open, onOpenChange, analysisId, filename }: ShareLinkDialogProps) {
  const { toast } = useToast();
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [label, setLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxViews, setMaxViews] = useState("");
  const [reminderWindowDays, setReminderWindowDays] = useState("3");
  const [isCreating, setIsCreating] = useState(false);
  const [selectedLink, setSelectedLink] = useState<ShareLink | null>(null);
  const [accessLog, setAccessLog] = useState<AccessLogEntry[]>([]);
  const [logPage, setLogPage] = useState(0);
  const PAGE_SIZE = 5;

  const loadLinks = useCallback(async () => {
    try {
      const r = await fetch(`/api/analysis/${analysisId}/share`);
      if (r.ok) {
        const data = await r.json() as ShareLink[];
        setLinks(Array.isArray(data) ? data : []);
      }
    } catch { /* ignore */ }
  }, [analysisId]);

  useEffect(() => {
    if (open) { loadLinks(); }
  }, [open, loadLinks]);

  const createLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreating(true);
    try {
      const body: Record<string, unknown> = {
        label: label || null,
        reminderWindowDays: parseInt(reminderWindowDays) || 3,
      };
      if (expiresAt) body.expiresAt = expiresAt;
      if (maxViews) body.maxViews = parseInt(maxViews);
      const r = await fetch(`/api/analysis/${analysisId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setLabel(""); setExpiresAt(""); setMaxViews(""); setReminderWindowDays("3");
        await loadLinks();
        toast({ title: "Share link created" });
      }
    } catch { /* ignore */ } finally { setIsCreating(false); }
  };

  const revokeLink = async (id: string) => {
    await fetch(`/api/share/${id}`, { method: "DELETE" });
    await loadLinks();
    if (selectedLink?.id === id) setSelectedLink(null);
  };

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/shared/${token}`;
    navigator.clipboard.writeText(url).then(() => toast({ title: "Link copied!" }));
  };

  const viewLog = async (link: ShareLink) => {
    setSelectedLink(link);
    setLogPage(0);
    try {
      const r = await fetch(`/api/share/${link.id}/views`);
      if (r.ok) setAccessLog(await r.json() as AccessLogEntry[]);
    } catch { setAccessLog([]); }
  };

  const exportCsv = (link: ShareLink) => {
    const a = document.createElement("a");
    a.href = `/api/share/${link.id}/views/csv`;
    a.download = `share-views-${link.id}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const pagedLog = accessLog.slice(logPage * PAGE_SIZE, (logPage + 1) * PAGE_SIZE);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg border-primary/20 bg-background/95 backdrop-blur max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-primary uppercase tracking-wider flex items-center gap-2">
            <Send className="w-4 h-4" /> Share Links
          </DialogTitle>
          <DialogDescription className="font-mono text-xs truncate">{filename}</DialogDescription>
        </DialogHeader>

        {/* Create form */}
        <form onSubmit={createLink} className="space-y-3 border border-border rounded-md p-4">
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Create new link</p>
          <div className="space-y-1">
            <Label className="font-mono text-xs">Label (optional)</Label>
            <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. For team review" className="font-mono text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="font-mono text-xs">Expires at (optional)</Label>
              <Input type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-xs">Max views (optional)</Label>
              <Input type="number" min="1" value={maxViews} onChange={e => setMaxViews(e.target.value)} placeholder="unlimited" className="font-mono text-xs" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs flex items-center gap-1">
              <Bell className="w-3 h-3" /> Expiry reminder window (days before expiry)
            </Label>
            <Input
              type="number"
              min="1"
              max="30"
              value={reminderWindowDays}
              onChange={e => setReminderWindowDays(e.target.value)}
              placeholder="3"
              className="font-mono text-xs"
            />
          </div>
          <Button type="submit" disabled={isCreating} size="sm" className="font-mono text-xs w-full">
            {isCreating ? "Creating…" : "Create Link"}
          </Button>
        </form>

        {/* Links list */}
        <div className="space-y-2">
          {links.length === 0 ? (
            <p className="text-xs font-mono text-muted-foreground text-center py-4">No share links yet.</p>
          ) : links.map(link => (
            <div key={link.id} className="border border-border rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {link.revokedAt ? (
                    <Badge variant="destructive" className="text-[10px] shrink-0"><Ban className="w-2.5 h-2.5 mr-1" />Revoked</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-green-400 border-green-500/30 shrink-0"><CheckCircle2 className="w-2.5 h-2.5 mr-1" />Active</Badge>
                  )}
                  <span className="font-mono text-xs text-muted-foreground truncate">{link.label ?? "Untitled"}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!link.revokedAt && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyLink(link.token)}>
                      <Copy className="w-3 h-3" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-primary" onClick={() => viewLog(link)}>
                    <ShieldAlert className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-primary" title="Export CSV" onClick={() => exportCsv(link)}>
                    <Download className="w-3 h-3" />
                  </Button>
                  {!link.revokedAt && (
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => revokeLink(link.id)}>
                      <X className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-muted-foreground">
                <span><Check className="w-2.5 h-2.5 inline mr-1" />{link.viewCount} views{link.maxViews ? ` / ${link.maxViews}` : ""}</span>
                {link.expiresAt && <span>Expires {new Date(link.expiresAt).toLocaleDateString()}</span>}
                {link.reminderWindowDays != null && (
                  <span className="flex items-center gap-1">
                    <Bell className="w-2.5 h-2.5" />{link.reminderWindowDays}d reminder
                  </span>
                )}
                {link.lastReminderSentAt != null && (
                  <span className="text-amber-400/70">
                    Last reminder: {new Date(link.lastReminderSentAt).toLocaleDateString()}
                  </span>
                )}
                <span>Created {new Date(link.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Access log */}
        {selectedLink && (
          <div className="border border-border rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                Access log — {selectedLink.label ?? "Untitled"}
              </p>
              {accessLog.length > 0 && (
                <Button variant="ghost" size="sm" className="h-6 font-mono text-[10px] gap-1" onClick={() => exportCsv(selectedLink)}>
                  <Download className="w-3 h-3" /> CSV
                </Button>
              )}
            </div>
            {accessLog.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground">No views yet.</p>
            ) : (
              <>
                <div className="space-y-1">
                  {pagedLog.map(entry => (
                    <div key={entry.id} className="font-mono text-[10px] text-muted-foreground border-b border-border/30 py-1">
                      <span>{new Date(entry.viewedAt).toLocaleString()}</span>
                      {entry.ipAddress && <span className="ml-2 text-foreground/60">{entry.ipAddress}</span>}
                    </div>
                  ))}
                </div>
                {accessLog.length > PAGE_SIZE && (
                  <div className="flex items-center justify-between">
                    <Button variant="ghost" size="sm" onClick={() => setLogPage(p => Math.max(0, p - 1))} disabled={logPage === 0}>
                      <ChevronLeft className="w-3 h-3" />
                    </Button>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {logPage + 1} / {Math.ceil(accessLog.length / PAGE_SIZE)}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => setLogPage(p => p + 1)} disabled={(logPage + 1) * PAGE_SIZE >= accessLog.length}>
                      <ChevronRight className="w-3 h-3" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="font-mono text-xs">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
