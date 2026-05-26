import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  Clock,
  Wrench,
  BarChart3,
  Zap,
  AlertTriangle,
  TrendingUp,
  Target,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AgentMetric {
  id: string;
  analysisId: string;
  agentId: string;
  codename: string;
  specialty: string;
  durationMs: number;
  toolCallCount: number;
  iterations: number;
  findingsCount: number;
  error: string | null;
  accuracyScore: number;
  createdAt: number;
}

interface AgentPerformanceSummary {
  agentId: string;
  codename: string;
  specialty: string;
  totalRuns: number;
  avgDurationMs: number;
  avgToolCalls: number;
  avgIterations: number;
  avgFindings: number;
  avgAccuracy: number;
  totalErrors: number;
}

// ─── Agent Color Map ────────────────────────────────────────────────────────

const AGENT_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  ghost: { bg: "bg-cyan-500/10", text: "text-cyan-400", border: "border-cyan-500/30" },
  phantom: { bg: "bg-purple-500/10", text: "text-purple-400", border: "border-purple-500/30" },
  specter: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/30" },
  wraith: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/30" },
  shade: { bg: "bg-green-500/10", text: "text-green-400", border: "border-green-500/30" },
  venom: { bg: "bg-fuchsia-500/10", text: "text-fuchsia-400", border: "border-fuchsia-500/30" },
};

function getAgentColor(agentId: string) {
  return AGENT_COLORS[agentId] || { bg: "bg-muted/20", text: "text-muted-foreground", border: "border-border" };
}

// ─── Per-Analysis Metrics Panel ─────────────────────────────────────────────

export function AnalysisMetricsPanel({ analysisId }: { analysisId: string }) {
  const [metrics, setMetrics] = useState<AgentMetric[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/metrics/${analysisId}`)
      .then(r => r.json())
      .then(data => {
        setMetrics(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [analysisId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs py-4">
        <Activity className="w-3.5 h-3.5 animate-pulse" />
        Loading agent metrics...
      </div>
    );
  }

  if (metrics.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-2">
        No agent metrics available for this analysis. Run a new analysis to generate metrics.
      </div>
    );
  }

  const totalDuration = Math.max(...metrics.map(m => m.durationMs));
  const totalToolCalls = metrics.reduce((sum, m) => sum + m.toolCallCount, 0);
  const totalIterations = metrics.reduce((sum, m) => sum + m.iterations, 0);
  const errorsCount = metrics.filter(m => m.error).length;

  return (
    <div className="space-y-4">
      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard icon={Clock} label="Duration" value={`${(totalDuration / 1000).toFixed(1)}s`} />
        <StatCard icon={Wrench} label="Tool Calls" value={String(totalToolCalls)} />
        <StatCard icon={Zap} label="Iterations" value={String(totalIterations)} />
        <StatCard icon={AlertTriangle} label="Errors" value={String(errorsCount)} variant={errorsCount > 0 ? "destructive" : "default"} />
      </div>

      {/* Per-Agent Breakdown */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Per-Agent Performance</h4>
        {metrics.map(m => {
          const color = getAgentColor(m.agentId);
          const durationPct = totalDuration > 0 ? (m.durationMs / totalDuration) * 100 : 0;

          return (
            <div key={m.id} className={`p-3 rounded-lg border ${color.border} ${color.bg}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`font-mono font-bold text-sm ${color.text}`}>{m.codename}</span>
                  {m.specialty && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[150px]">{m.specialty}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {m.error && (
                    <Badge variant="destructive" className="text-[9px]">ERROR</Badge>
                  )}
                  <Badge variant="outline" className="text-[10px] font-mono">
                    {(m.durationMs / 1000).toFixed(1)}s
                  </Badge>
                </div>
              </div>

              {/* Duration bar */}
              <div className="h-1.5 bg-black/20 rounded-full overflow-hidden mb-2">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${color.text.replace("text-", "bg-")}`}
                  style={{ width: `${durationPct}%` }}
                />
              </div>

              {/* Stats row */}
              <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Wrench className="w-3 h-3" /> {m.toolCallCount} tools
                </span>
                <span className="flex items-center gap-1">
                  <Zap className="w-3 h-3" /> {m.iterations} iters
                </span>
                <span className="flex items-center gap-1">
                  <Target className="w-3 h-3" /> {(m.accuracyScore * 100).toFixed(0)}% accuracy
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Global Agent Performance Summary ───────────────────────────────────────

export function AgentPerformanceSummary() {
  const [summary, setSummary] = useState<AgentPerformanceSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/metrics/summary/all")
      .then(r => r.json())
      .then(data => {
        setSummary(data.performance || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs py-4">
        <BarChart3 className="w-3.5 h-3.5 animate-pulse" />
        Loading performance summary...
      </div>
    );
  }

  if (summary.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-6 text-center">
          <TrendingUp className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No performance data yet. Run analyses to build agent metrics.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-primary" />
        All-Time Agent Performance
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {summary.map(agent => {
          const color = getAgentColor(agent.agentId);
          return (
            <Card key={agent.agentId} className={`${color.border} ${color.bg}`}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className={`font-mono font-bold text-sm ${color.text}`}>{agent.codename}</span>
                  <Badge variant="outline" className="text-[10px]">{agent.totalRuns} runs</Badge>
                </div>
                <div className="text-[10px] text-muted-foreground space-y-1">
                  <div className="flex justify-between">
                    <span>Avg Duration</span>
                    <span className="font-mono">{(agent.avgDurationMs / 1000).toFixed(1)}s</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Avg Tool Calls</span>
                    <span className="font-mono">{agent.avgToolCalls}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Avg Iterations</span>
                    <span className="font-mono">{agent.avgIterations}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Accuracy</span>
                    <span className="font-mono">{(agent.avgAccuracy * 100).toFixed(0)}%</span>
                  </div>
                  {agent.totalErrors > 0 && (
                    <div className="flex justify-between text-red-400">
                      <span>Errors</span>
                      <span className="font-mono">{agent.totalErrors}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ─── Stat Card Helper ───────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  variant = "default",
}: {
  icon: any;
  label: string;
  value: string;
  variant?: "default" | "destructive";
}) {
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
      variant === "destructive" ? "bg-red-500/10 border border-red-500/30" : "bg-muted/30 border border-border/30"
    }`}>
      <Icon className={`w-3.5 h-3.5 ${variant === "destructive" ? "text-red-400" : "text-primary"}`} />
      <div>
        <span className="font-mono font-bold text-sm">{value}</span>
        <span className="text-[10px] text-muted-foreground ml-1">{label}</span>
      </div>
    </div>
  );
}
