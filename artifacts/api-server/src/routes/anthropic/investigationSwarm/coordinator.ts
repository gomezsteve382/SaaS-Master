/**
 * Swarm coordinator.
 *
 * Runs the five specialist agents in parallel (Promise.allSettled), then
 * passes all collected findings to the COORDINATOR synthesis model call.
 *
 * Emits SwarmEvents to a caller-supplied callback so the route handler can
 * serialise them to SSE without the coordinator knowing about HTTP.
 *
 * Cancellation: the caller passes an AbortSignal; the coordinator checks it
 * between steps and propagates it to each Anthropic API call.
 */

import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  type AgentId,
  type AgentFinding,
  type SynthesisReport,
  type SwarmEvent,
} from "./sse";
import {
  AGENT_DEFS,
  COORDINATOR_SYSTEM_PROMPT,
} from "./agents";
import {
  buildToolsForAgent,
  executeTool,
  ForbiddenToolError,
} from "./toolExecutor";

const MAX_AGENT_ITERATIONS = 8;
const MAX_TOKENS_PER_AGENT = 4096;
const MAX_TOKENS_SYNTHESIS = 4096;

/* ── Finding extraction ─────────────────────────────────────────────── */

/** Parse FINDINGS_JSON: [...] blocks emitted by agents in their text. */
function extractFindings(text: string, agent: AgentId): AgentFinding[] {
  const matches = text.match(/FINDINGS_JSON:\s*(\[[\s\S]*?\])/g);
  if (!matches) return [];
  const findings: AgentFinding[] = [];
  for (const m of matches) {
    const jsonStr = m.replace(/^FINDINGS_JSON:\s*/, "");
    try {
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item.description) continue;
        findings.push({
          agent,
          findingType: String(item.findingType || "general"),
          description: String(item.description),
          offsets: Array.isArray(item.offsets)
            ? item.offsets.map(Number).filter(isFinite)
            : undefined,
          confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0)),
          status: item.status === "VERIFIED" ? "VERIFIED" : "UNVERIFIED",
        });
      }
    } catch {
      // ignore malformed JSON
    }
  }
  return findings;
}

/* ── Single-agent runner ──────────────────────────────────────────────── */

async function runAgent(
  agentId: AgentId,
  runId: string,
  primaryBuf: Buffer,
  binaries: Record<string, Buffer>,
  signal: AbortSignal,
  emit: (event: SwarmEvent) => void,
): Promise<AgentFinding[]> {
  const def = AGENT_DEFS[agentId];
  emit({ type: "agent_started", runId, agent: agentId });

  const tools = buildToolsForAgent(def.allowedTools);
  const loopMessages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    {
      role: "user",
      content: `Analyse the loaded ECU dump (${primaryBuf.length} bytes). Use your allowed tools systematically, then emit your findings.`,
    },
  ];

  let iterations = 0;
  let fullText = "";
  const allFindings: AgentFinding[] = [];

  while (iterations < (def.maxIterations || MAX_AGENT_ITERATIONS)) {
    if (signal.aborted) {
      emit({ type: "agent_aborted", runId, agent: agentId, reason: "cancelled by client" });
      return allFindings;
    }

    iterations++;

    let response;
    try {
      response = await anthropic.messages.create(
        {
          model: "claude-haiku-4-5",
          max_tokens: MAX_TOKENS_PER_AGENT,
          system: def.systemPrompt,
          tools: tools as never,
          messages: loopMessages as never,
        },
        { signal },
      );
    } catch (err) {
      if (signal.aborted) {
        emit({ type: "agent_aborted", runId, agent: agentId, reason: "cancelled by client" });
        return allFindings;
      }
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: "agent_error", runId, agent: agentId, error: msg });
      return allFindings;
    }

    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
    let hasToolUse = false;

    for (const block of response.content) {
      if (block.type === "text") {
        fullText += block.text;
        const newFindings = extractFindings(block.text, agentId);
        for (const f of newFindings) {
          allFindings.push(f);
          emit({ type: "finding", runId, agent: agentId, finding: f });
        }
      } else if (block.type === "tool_use") {
        hasToolUse = true;
        const toolName = block.name;
        const args = (block.input ?? {}) as Record<string, unknown>;

        emit({
          type: "agent_tool_call",
          runId,
          agent: agentId,
          toolName,
          args: JSON.stringify(args).slice(0, 200),
        });

        let result: string;
        const t0 = Date.now();

        try {
          result = await executeTool(toolName, args, primaryBuf, binaries);
        } catch (err) {
          if (err instanceof ForbiddenToolError) {
            emit({
              type: "agent_error",
              runId,
              agent: agentId,
              error: err.message,
            });
            result = `FORBIDDEN: ${err.message}`;
          } else {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        emit({
          type: "agent_tool_result",
          runId,
          agent: agentId,
          toolName,
          preview: result.slice(0, 200),
          durationMs: Date.now() - t0,
        });

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }

    loopMessages.push({ role: "assistant", content: response.content as never });

    if (!hasToolUse || response.stop_reason === "end_turn") break;

    loopMessages.push({ role: "user", content: toolResults as never });
  }

  emit({ type: "agent_done", runId, agent: agentId, findingCount: allFindings.length });

  // Re-extract from full text in case some JSON appeared mid-stream
  const extra = extractFindings(fullText, agentId);
  const seen = new Set(allFindings.map((f) => f.description));
  for (const f of extra) {
    if (!seen.has(f.description)) {
      allFindings.push(f);
      seen.add(f.description);
    }
  }

  return allFindings;
}

/* ── Synthesis ──────────────────────────────────────────────────────── */

async function synthesise(
  runId: string,
  allFindings: AgentFinding[],
  signal: AbortSignal,
  emit: (event: SwarmEvent) => void,
): Promise<SynthesisReport | null> {
  if (signal.aborted) return null;
  emit({ type: "synthesis_started", runId });

  const findingsJson = JSON.stringify(allFindings, null, 2);
  const userMsg = `Here are all agent findings (${allFindings.length} total):\n\n${findingsJson}\n\nSynthesize into the required JSON schema.`;

  let response;
  try {
    response = await anthropic.messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: MAX_TOKENS_SYNTHESIS,
        system: COORDINATOR_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      },
      { signal },
    );
  } catch {
    return null;
  }

  const text = response.content.find((b: { type: string }) => b.type === "text")?.text ?? "";
  try {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const report = JSON.parse(cleaned) as SynthesisReport;
    emit({ type: "synthesis", runId, report });
    return report;
  } catch {
    const fallback: SynthesisReport = {
      summary: text.slice(0, 500) || "Synthesis failed to produce structured output.",
      rankedFindings: allFindings.map((f) => ({ ...f, sources: [f.agent] })),
      contradictions: [],
      gaps: [],
      recommendedNextSteps: [],
    };
    emit({ type: "synthesis", runId, report: fallback });
    return fallback;
  }
}

/* ── Public coordinator entry point ──────────────────────────────────── */

export async function runSwarm(
  runId: string,
  primaryBuf: Buffer,
  binaries: Record<string, Buffer>,
  signal: AbortSignal,
  emit: (event: SwarmEvent) => void,
): Promise<{ findings: AgentFinding[]; report: SynthesisReport | null }> {
  const agentIds: AgentId[] = ["CRYPTO", "PROTOCOL", "LAYOUT", "IMMOBILIZER", "CROSS_REF"];

  emit({ type: "run_started", runId, agents: agentIds });

  const results = await Promise.allSettled(
    agentIds.map((id) => runAgent(id, runId, primaryBuf, binaries, signal, emit)),
  );

  const allFindings: AgentFinding[] = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value : [],
  );

  const report = await synthesise(runId, allFindings, signal, emit);

  return { findings: allFindings, report };
}
