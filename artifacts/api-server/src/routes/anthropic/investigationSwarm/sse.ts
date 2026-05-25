/**
 * SSE event types for the Investigation Swarm.
 *
 * Every event that crosses the wire is a SwarmEvent. The client keys agent
 * columns off `event.agent` and fills the synthesis pane from `event.type ===
 * "synthesis"`.
 *
 * Persistence schema (see lib/db/src/schema/investigationRuns.ts):
 *   investigation_runs            — one row per swarm run
 *   investigation_agent_findings  — one row per agent finding
 */

export const AGENT_IDS = [
  "CRYPTO",
  "PROTOCOL",
  "LAYOUT",
  "IMMOBILIZER",
  "CROSS_REF",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export type FindingStatus = "VERIFIED" | "UNVERIFIED";

export interface AgentFinding {
  agent: AgentId;
  findingType: string;
  description: string;
  offsets?: number[];
  confidence: number;
  status: FindingStatus;
}

export interface SynthesisReport {
  summary: string;
  rankedFindings: Array<AgentFinding & { sources: AgentId[] }>;
  contradictions: string[];
  gaps: string[];
  recommendedNextSteps: string[];
}

/* ── Discriminated union of all event shapes ─────────────────────────── */

export type SwarmEvent =
  | { type: "run_started"; runId: string; agents: AgentId[] }
  | { type: "agent_started"; runId: string; agent: AgentId }
  | { type: "agent_tool_call"; runId: string; agent: AgentId; toolName: string; args: string }
  | { type: "agent_tool_result"; runId: string; agent: AgentId; toolName: string; preview: string; durationMs: number }
  | { type: "finding"; runId: string; agent: AgentId; finding: AgentFinding }
  | { type: "agent_done"; runId: string; agent: AgentId; findingCount: number }
  | { type: "agent_aborted"; runId: string; agent: AgentId; reason: string }
  | { type: "agent_error"; runId: string; agent: AgentId; error: string }
  | { type: "budget_exceeded"; runId: string; agent: AgentId; used: number; cap: number }
  | { type: "synthesis_started"; runId: string }
  | { type: "synthesis"; runId: string; report: SynthesisReport }
  | { type: "done"; runId: string; status: "completed" | "cancelled" | "error" }
  | { type: "error"; runId: string; error: string };

/** Serialise a SwarmEvent to an SSE frame string. */
export function toSseFrame(event: SwarmEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Parse an SSE frame back to a SwarmEvent (client-side helper). */
export function fromSseFrame(line: string): SwarmEvent | null {
  // Strip trailing CR/LF before matching — JavaScript's `$` does not match
  // before a trailing `\n` without the `m` flag, so we normalise first.
  const m = line.replace(/[\r\n]+$/, "").match(/^data:\s*(.+)$/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as SwarmEvent;
  } catch {
    return null;
  }
}
