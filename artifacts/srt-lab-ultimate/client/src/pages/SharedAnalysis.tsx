import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Shield,
  Binary,
  Key,
  Radio,
  HardDrive,
  Lock,
  FileDown,
  AlertTriangle,
  Clock,
  ExternalLink,
} from "lucide-react";

interface SharedData {
  link: {
    id: string;
    label: string | null;
    expiresAt: number | null;
    createdAt: number;
    reminderWindowDays: number;
  };
  analysis: {
    id: string;
    filename: string;
    fileSize: number;
    fileType: string | null;
    status: string;
    timestamp: number;
    analysisData: any;
    summary: string | null;
    algorithmCount: number;
    seedKeyCount: number;
    canAddressCount: number;
    checksumCount: number;
    securityByteCount: number;
    stringCount: number;
  };
}

export default function SharedAnalysis() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<SharedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params.token) return;
    fetch(`/api/share/${params.token}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || `Error ${res.status}`);
          return;
        }
        setData(await res.json());
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-muted-foreground text-sm">Loading shared analysis...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4 max-w-md px-4">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto" />
          <h1 className="text-xl font-bold text-foreground">Link Unavailable</h1>
          <p className="text-muted-foreground text-sm">{error}</p>
          <p className="text-xs text-muted-foreground">
            This link may have been revoked or expired. Contact the person who shared it.
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { link, analysis } = data;
  const findings = analysis.analysisData || {};

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/30 bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="container flex items-center justify-between py-3">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-primary" />
            <div>
              <h1 className="font-bold text-sm text-foreground">SRT Lab — Shared Analysis</h1>
              {link.label && <p className="text-xs text-muted-foreground">{link.label}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {link.expiresAt && (
              <Badge variant="outline" className="text-xs gap-1">
                <Clock className="w-3 h-3" />
                Expires {new Date(link.expiresAt).toLocaleDateString()}
              </Badge>
            )}
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs"
              onClick={() => {
                const a = document.createElement("a");
                a.href = `/api/analysis/${analysis.id}/export/pdf`;
                a.download = `srtlab-shared-${analysis.filename?.replace(/[^a-z0-9]/gi, "_").slice(0, 40) || analysis.id}.pdf`;
                a.click();
              }}
            >
              <FileDown className="w-3.5 h-3.5" />
              Export PDF
            </Button>
          </div>
        </div>
      </header>

      <div className="container py-6 space-y-6">
        {/* File Info */}
        <div className="p-4 rounded-xl border border-border/30 bg-card/60">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-bold text-lg text-foreground truncate">{analysis.filename}</h2>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <Badge variant="outline" className="text-xs">{analysis.fileType || "Binary"}</Badge>
                <span className="text-xs text-muted-foreground">
                  {(analysis.fileSize / 1024).toFixed(1)} KB
                </span>
                <span className="text-xs text-muted-foreground">
                  Analyzed {new Date(analysis.timestamp).toLocaleString()}
                </span>
              </div>
            </div>
            <Badge className="shrink-0 bg-green-500/20 text-green-400 border-green-500/30">
              {analysis.status}
            </Badge>
          </div>
          {findings.summary && (
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed border-t border-border/20 pt-3">
              <span className="text-primary font-semibold">Summary: </span>
              {findings.summary}
            </p>
          )}
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          {[
            { label: "Algorithms", count: analysis.algorithmCount, icon: Binary, color: "text-cyan-400" },
            { label: "Seed Keys", count: analysis.seedKeyCount, icon: Key, color: "text-amber-400" },
            { label: "CAN Addrs", count: analysis.canAddressCount, icon: Radio, color: "text-green-400" },
            { label: "Checksums", count: analysis.checksumCount, icon: HardDrive, color: "text-blue-400" },
            { label: "Security", count: analysis.securityByteCount, icon: Lock, color: "text-red-400" },
            { label: "Strings", count: analysis.stringCount, icon: ExternalLink, color: "text-violet-400" },
          ].map((s) => (
            <div key={s.label} className="p-3 rounded-lg border border-border/30 bg-card/40 text-center">
              <s.icon className={`w-4 h-4 mx-auto mb-1 ${s.color}`} />
              <div className="font-bold text-lg font-mono">{s.count}</div>
              <div className="text-[10px] text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Algorithms */}
        {findings.algorithms?.length > 0 && (
          <div className="p-4 rounded-xl border border-border/30 bg-card/60 space-y-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Binary className="w-4 h-4 text-cyan-400" />
              Detected Algorithms
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {findings.algorithms.map((a: any, i: number) => (
                <div key={i} className="p-2 rounded-lg border border-border/20 bg-muted/20">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-foreground">{a.name}</span>
                    {a.confidence && (
                      <Badge variant="outline" className="text-[9px]">{a.confidence}</Badge>
                    )}
                  </div>
                  {a.offset && (
                    <span className="font-mono text-[10px] text-muted-foreground">@0x{a.offset?.toString(16).toUpperCase().padStart(8, "0")}</span>
                  )}
                  {a.description && <p className="text-[11px] text-muted-foreground mt-1">{a.description}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Seed Keys */}
        {findings.seedKeys?.length > 0 && (
          <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-950/10 space-y-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Key className="w-4 h-4 text-amber-400" />
              Seed Keys & Key Material
            </h3>
            <div className="space-y-2">
              {findings.seedKeys.map((k: any, i: number) => (
                <div key={i} className="p-2 rounded-lg border border-amber-500/20 bg-amber-950/20">
                  <code className="font-mono text-xs text-amber-300 break-all">
                    {typeof k === "string" ? k : k.value || k.hex || JSON.stringify(k)}
                  </code>
                  {k.description && <p className="text-[11px] text-muted-foreground mt-1">{k.description}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center py-4 border-t border-border/20">
          <p className="text-xs text-muted-foreground">
            Shared via <span className="text-primary font-semibold">SRT Lab</span> · Shared {new Date(link.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>
    </div>
  );
}
