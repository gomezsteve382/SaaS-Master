import { CheckCircle2, XCircle } from "lucide-react";
import type { DoctorTool } from "@/lib/workbench-types";

export function DoctorToolRow({ tool }: { tool: DoctorTool }) {
  return (
    <div className="flex items-center justify-between py-3 px-4 hover:bg-muted/50 transition-colors border-b border-border last:border-0">
      <div className="flex items-center gap-3">
        {tool.available ? (
          <CheckCircle2 className="w-5 h-5 text-green-500" />
        ) : (
          <XCircle className="w-5 h-5 text-destructive" />
        )}
        <div>
          <div className="font-mono text-sm font-semibold">{tool.name}</div>
          {tool.error && <div className="text-xs text-destructive">{tool.error}</div>}
        </div>
      </div>
      <div className="text-right">
        {tool.version && <div className="font-mono text-xs text-primary">{tool.version}</div>}

      </div>
    </div>
  );
}
