import { Badge } from "@/components/ui/badge";

export function StatusBadge({ status }: { status: "pending" | "running" | "complete" | "failed" | string }) {
  switch (status) {
    case "pending":
      return <Badge variant="outline" className="text-yellow-500 border-yellow-500/30 bg-yellow-500/10 font-mono">PENDING</Badge>;
    case "running":
      return <Badge variant="outline" className="text-blue-400 border-blue-400/30 bg-blue-400/10 font-mono animate-pulse">RUNNING</Badge>;
    case "complete":
      return <Badge variant="outline" className="text-primary border-primary/30 bg-primary/10 font-mono">COMPLETE</Badge>;
    case "failed":
      return <Badge variant="destructive" className="font-mono">FAILED</Badge>;
    default:
      return <Badge variant="secondary" className="font-mono">{status.toUpperCase()}</Badge>;
  }
}
