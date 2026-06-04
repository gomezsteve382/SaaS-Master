import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, FileText, Upload, Download, Shield, GitCompare } from "lucide-react";
import { useLocation } from "wouter";

const ACTION_ICONS: Record<string, React.ReactNode> = {
  file_uploaded: <Upload className="w-3.5 h-3.5 text-blue-400" />,
  candidate_generated: <Shield className="w-3.5 h-3.5 text-green-400" />,
  candidate_exported: <Download className="w-3.5 h-3.5 text-purple-400" />,
  candidate_blocked: <Shield className="w-3.5 h-3.5 text-red-400" />,
  diff_computed: <GitCompare className="w-3.5 h-3.5 text-orange-400" />,
  three_way_compared: <GitCompare className="w-3.5 h-3.5 text-teal-400" />,
  sec16_synced: <FileText className="w-3.5 h-3.5 text-yellow-400" />,
  session_created: <FileText className="w-3.5 h-3.5 text-muted-foreground" />,
};

export default function AuditLog() {
  const [, navigate] = useLocation();
  const { data: logs, isLoading } = trpc.audit.list.useQuery({ limit: 100 });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-sm text-muted-foreground">Timestamped record of every operation</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent Operations ({logs?.length || 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {!logs || logs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No operations recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {logs.map((log: any) => (
                <div key={log.id} className="flex items-start gap-3 p-3 rounded bg-muted/30 hover:bg-muted/50 transition-colors">
                  <div className="mt-0.5">
                    {ACTION_ICONS[log.action] || <FileText className="w-3.5 h-3.5 text-muted-foreground" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{log.action}</Badge>
                      {log.sessionId && (
                        <span className="text-xs text-muted-foreground">Session #{log.sessionId}</span>
                      )}
                    </div>
                    <p className="text-sm mt-1 text-foreground/90">{log.description}</p>
                    {log.metadata && (
                      <details className="mt-1">
                        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                          Details
                        </summary>
                        <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto max-h-32">
                          {JSON.stringify(log.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
