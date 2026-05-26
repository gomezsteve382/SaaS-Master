import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
} from "recharts";
import type { Analysis } from "@/lib/workbench-types";
import { getEntropySeries, getFindingsCategories } from "@/lib/export-report";

function fmtHex(n: number): string {
  return `0x${n.toString(16).toUpperCase()}`;
}

interface EntropyTooltipProps {
  active?: boolean;
  payload?: { value: number; payload: { offset: number; entropy: number } }[];
}

function EntropyTooltip({ active, payload }: EntropyTooltipProps) {
  if (!active || !payload?.length) return null;
  const { offset, entropy } = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded px-3 py-2 font-mono text-xs shadow-lg">
      <div className="text-muted-foreground">Offset: <span className="text-primary">{fmtHex(offset)}</span></div>
      <div className="text-muted-foreground">Entropy: <span className="text-primary">{entropy.toFixed(3)}</span> bits/byte</div>
    </div>
  );
}

interface FindingsTooltipProps {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}

function FindingsTooltip({ active, payload, label }: FindingsTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded px-3 py-2 font-mono text-xs shadow-lg">
      <div className="text-muted-foreground">{label}: <span className="text-primary">{payload[0].value}</span></div>
    </div>
  );
}

interface PackedRegion {
  offset: number;
  size: number;
  entropy: number;
  label: string;
  packerName?: string;
}

interface AnalysisChartsProps {
  analysis: Analysis;
}

export function AnalysisCharts({ analysis }: AnalysisChartsProps) {
  const entropySeries = getEntropySeries(analysis);
  const findingsCategories = getFindingsCategories(analysis).filter((c) => c.count > 0);
  const hasEntropy = entropySeries.length > 0;
  const hasFindings = findingsCategories.length > 0;

  const rawFindings = (analysis.findings ?? {}) as { packedRegions?: PackedRegion[] };
  const packedRegions: PackedRegion[] = rawFindings.packedRegions ?? [];

  if (!hasEntropy && !hasFindings) return null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {hasEntropy && (
        <div className="bg-card border border-border rounded-md p-4">
          <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-3">
            Entropy (bits/byte) vs Offset
          </h3>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={entropySeries} margin={{ top: 4, right: 8, bottom: 20, left: 8 }}>
              <defs>
                <linearGradient id="entropyGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#1d4ed8" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#1d4ed8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.4} />
              <XAxis
                dataKey="offset"
                tickFormatter={fmtHex}
                tick={{ fontSize: 9, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={{ stroke: "hsl(var(--border))" }}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[0, 8]}
                ticks={[0, 2, 4, 6, 8]}
                tick={{ fontSize: 9, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
                width={20}
              />
              <Tooltip content={<EntropyTooltip />} />
              {packedRegions.map((region, i) => (
                <ReferenceArea
                  key={i}
                  x1={region.offset}
                  x2={region.offset + region.size}
                  fill={region.packerName ? "rgba(239,68,68,0.13)" : "rgba(251,146,60,0.13)"}
                  stroke={region.packerName ? "rgba(239,68,68,0.5)" : "rgba(251,146,60,0.5)"}
                  strokeWidth={1}
                  strokeDasharray="3 2"
                  ifOverflow="extendDomain"
                />
              ))}
              <Area
                type="monotone"
                dataKey="entropy"
                stroke="#1d4ed8"
                strokeWidth={1.5}
                fill="url(#entropyGradient)"
                dot={false}
                activeDot={{ r: 3, fill: "#1d4ed8", strokeWidth: 0 }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
          <div className="flex items-center justify-between mt-1">
            <div className="flex items-center gap-3">
              {packedRegions.length > 0 && (
                <>
                  <span className="flex items-center gap-1 text-[10px] font-mono text-orange-400">
                    <span className="inline-block w-3 h-2 rounded-sm" style={{ background: "rgba(251,146,60,0.35)", border: "1px dashed rgba(251,146,60,0.7)" }} />
                    encrypted/compressed
                  </span>
                  {packedRegions.some((r) => r.packerName) && (
                    <span className="flex items-center gap-1 text-[10px] font-mono text-red-400">
                      <span className="inline-block w-3 h-2 rounded-sm" style={{ background: "rgba(239,68,68,0.35)", border: "1px dashed rgba(239,68,68,0.7)" }} />
                      packed
                    </span>
                  )}
                </>
              )}
            </div>
            <p className="text-[10px] font-mono text-muted-foreground">
              {entropySeries.length} windows
            </p>
          </div>
        </div>
      )}

      {hasFindings && (
        <div className="bg-card border border-border rounded-md p-4">
          <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-3">
            Findings by Category
          </h3>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={findingsCategories} margin={{ top: 4, right: 8, bottom: 20, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 9, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={{ stroke: "hsl(var(--border))" }}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 9, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
                width={20}
              />
              <Tooltip content={<FindingsTooltip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} />
              <Bar dataKey="count" fill="#10b981" radius={[2, 2, 0, 0]} maxBarSize={48} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
