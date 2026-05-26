import { useState, useEffect, useCallback } from "react";
import { Users, X, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface ShareEntry {
  id: string;
  userId?: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "analysis" | "binary";
  id: string;
  resourceLabel: string;
}

export function ShareDialog({ open, onOpenChange, id, resourceLabel }: ShareDialogProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const loadShares = useCallback(async () => {
    if (!id) return;
    setIsLoading(true);
    try {
      const r = await fetch(`/api/analysis/${id}/share`);
      if (r.ok) {
        const data = await r.json() as ShareEntry[];
        setShares(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (open) loadShares();
  }, [open, loadShares]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) { setError("Email is required"); return; }
    setIsPending(true);
    try {
      const r = await fetch(`/api/analysis/${id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!r.ok) {
        const d = await r.json() as { error?: string };
        setError(d.error ?? "Failed to share");
      } else {
        setEmail("");
        await loadShares();
      }
    } catch {
      setError("Network error");
    } finally {
      setIsPending(false);
    }
  };

  const revoke = async (shareId: string) => {
    setIsPending(true);
    try {
      await fetch(`/api/share/${shareId}`, { method: "DELETE" });
      await loadShares();
    } catch {
      // ignore
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-primary/20 bg-background/95 backdrop-blur">
        <DialogHeader>
          <DialogTitle className="font-mono text-primary uppercase tracking-wider flex items-center gap-2">
            <Users className="w-4 h-4" /> Share Analysis
          </DialogTitle>
          <DialogDescription className="font-mono text-xs truncate">{resourceLabel}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="mt-2 flex gap-2">
          <Input
            type="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isPending}
            className="font-mono text-sm"
          />
          <Button type="submit" disabled={isPending}>
            Share
          </Button>
        </form>
        {error && (
          <div className="flex items-center gap-2 text-destructive text-xs bg-destructive/10 p-2 rounded font-mono">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        <div className="mt-2 border-t border-border pt-3">
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">
            Shared with
          </div>
          {isLoading ? (
            <p className="text-xs text-muted-foreground font-mono">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="text-xs text-muted-foreground font-mono">
              No one yet. Read-only access by default.
            </p>
          ) : (
            <ul className="space-y-1 max-h-48 overflow-y-auto">
              {shares.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between text-xs font-mono px-2 py-1.5 rounded bg-muted/50"
                >
                  <div className="truncate">
                    <span className="text-foreground">{s.email ?? s.userId}</span>
                    {(s.firstName || s.lastName) && (
                      <span className="text-muted-foreground ml-2">
                        {[s.firstName, s.lastName].filter(Boolean).join(" ")}
                      </span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => revoke(s.id)}
                    disabled={isPending}
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
