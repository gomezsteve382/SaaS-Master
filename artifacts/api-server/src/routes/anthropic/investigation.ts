/**
 * Multi-Agent Investigation Swarm
 *
 * POST /api/anthropic/investigation          — start a new swarm run (SSE)
 * GET  /api/anthropic/investigation          — list past runs
 * GET  /api/anthropic/investigation/:runId   — get run detail
 * POST /api/anthropic/investigation/:runId/cancel — cancel an in-progress run
 *
 * SSE event shapes (all wrapped in JSON after "data: "):
 *   { type: "run_created",     runId }
 *   { type: "agent_start",     agentName }
 *   { type: "agent_tool_call", agentName, id, toolName, args }
 *   { type: "agent_tool_result", agentName, id, toolName, result, durationMs }
 *   { type: "agent_text",      agentName, content }
 *   { type: "agent_done",      agentName, summary, findings, gaps, iterations }
 *   { type: "agent_error",     agentName, error }
 *   { type: "coordinator_start" }
 *   { type: "coordinator_text", content }
 *   { type: "run_done",        runId, report }
 *   { type: "run_cancelled",   runId }
 *   { type: "error",           error }
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  investigationRunsTable,
  investigationAgentRunsTable,
  investigationRunPublicColumns,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  AGENT_NAMES,
  AGENT_DEFINITIONS,
  COORDINATOR_SYSTEM_PROMPT,
  agentTools,
  extractAgentFullResult,
  MAX_AGENT_TOOL_RESULT_BYTES,
  type AgentName,
  type AgentFinding,
} from "./investigationAgents";
import { TOOL_REGISTRY } from "./toolRegistry";

const router = Router();

/* ── helpers ─────────────────────────────────────────────────────────────── */

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[truncated]`;
}

type SseSend = (obj: Record<string, unknown>) => void;

interface AgentRunResult {
  agentName: AgentName;
  summary: string;
  findings: AgentFinding[];
  gaps: string[];
  iterations: number;
  toolTrace: Array<{
    toolName: string;
    args: Record<string, unknown>;
    resultPreview: string;
    durationMs: number;
  }>;
  failed: boolean;
  errorMessage?: string;
}

/* ── per-agent tool-use loop ──────────────────────────────────────────────── */

async function runAgent(
  agentName: AgentName,
  primary: Buffer,
  binaryMap: Record<string, Buffer>,
  send: SseSend,
  abortSignal: AbortSignal,
  iterCap: number,
  anthropic: { messages: { create: (...args: unknown[]) => Promise<unknown> } },
  systemSuffix: string,
): Promise<AgentRunResult> {
  const def = AGENT_DEFINITIONS[agentName];
  const tools = agentTools(agentName);

  send({ type: "agent_start", agentName });

  const systemPrompt = def.systemPrompt + (systemSuffix ? `\n\n${systemSuffix}` : "");

  const loopMessages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    {
      role: "user",
      content: `Analyze this ECU binary dump (${primary.length} bytes). Use your available tools to investigate it from your specialist perspective, then emit your findings JSON.`,
    },
  ];

  let fullText = "";
  let iterations = 0;
  const toolTrace: AgentRunResult["toolTrace"] = [];
  let cumulativeBytes = 0;

  try {
    while (iterations < iterCap) {
      if (abortSignal.aborted) {
        throw new Error("cancelled");
      }

      iterations++;

      const response = (await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        tools: primary.length > 0 ? tools : [],
        messages: loopMessages,
      })) as {
        content: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        stop_reason: string;
      };

      let hasToolUse = false;
      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          fullText += block.text;
          send({ type: "agent_text", agentName, content: block.text });
        } else if (block.type === "tool_use" && block.id && block.name) {
          hasToolUse = true;
          const toolName = block.name;
          const args = (block.input ?? {}) as Record<string, unknown>;
          const toolId = block.id;

          send({
            type: "agent_tool_call",
            agentName,
            id: toolId,
            toolName,
            args: JSON.stringify(args).slice(0, 256),
          });

          const toolDef = TOOL_REGISTRY[toolName];
          let result: string;
          const t0 = Date.now();

          if (!toolDef) {
            result = `Error: unknown tool "${toolName}"`;
          } else if (primary.length === 0) {
            result = "Error: no binary loaded.";
          } else if (cumulativeBytes >= 65536) {
            result = "Error: cumulative tool output cap reached.";
          } else {
            try {
              result = await toolDef.handler(primary, binaryMap, args);
              result = result.slice(0, MAX_AGENT_TOOL_RESULT_BYTES);
            } catch (e) {
              result = `Error: ${e instanceof Error ? e.message : String(e)}`;
            }
          }

          const durationMs = Date.now() - t0;
          cumulativeBytes += Buffer.byteLength(result, "utf8");

          send({
            type: "agent_tool_result",
            agentName,
            id: toolId,
            toolName,
            result: result.slice(0, 512),
            durationMs,
          });

          toolTrace.push({
            toolName,
            args,
            resultPreview: result.slice(0, 512),
            durationMs,
          });

          toolResults.push({ type: "tool_result", tool_use_id: toolId, content: result });
        }
      }

      loopMessages.push({ role: "assistant", content: response.content });

      if (!hasToolUse || response.stop_reason === "end_turn") {
        break;
      }

      loopMessages.push({ role: "user", content: toolResults });
    }

    const parsed = extractAgentFullResult(agentName, fullText);
    const result: AgentRunResult = {
      agentName,
      summary: parsed.summary ?? truncate(fullText, 500),
      findings: parsed.findings ?? [],
      gaps: parsed.gaps ?? [],
      iterations,
      toolTrace,
      failed: false,
    };

    send({
      type: "agent_done",
      agentName,
      summary: result.summary,
      findings: result.findings,
      gaps: result.gaps,
      iterations,
    });

    return result;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    send({ type: "agent_error", agentName, error: errorMessage });
    return {
      agentName,
      summary: "",
      findings: [],
      gaps: [],
      iterations,
      toolTrace,
      failed: true,
      errorMessage,
    };
  }
}

/* ── coordinator synthesis ────────────────────────────────────────────────── */

async function runCoordinator(
  agentResults: AgentRunResult[],
  send: SseSend,
  abortSignal: AbortSignal,
  anthropic: { messages: { create: (...args: unknown[]) => Promise<unknown> } },
): Promise<unknown> {
  send({ type: "coordinator_start" });

  const agentSummaries = agentResults
    .map((r) => {
      const findingsJson = JSON.stringify(
        { summary: r.summary, findings: r.findings, gaps: r.gaps },
        null,
        2,
      );
      return `## ${r.agentName}${r.failed ? " (FAILED — " + (r.errorMessage ?? "unknown error") + ")" : ""}\n\`\`\`json\n${findingsJson}\n\`\`\``;
    })
    .join("\n\n");

  const userMessage = `Here are the findings from the five specialist agents. Synthesize them into a unified investigation report.\n\n${agentSummaries}`;

  if (abortSignal.aborted) {
    return null;
  }

  let fullText = "";

  try {
    const response = (await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: COORDINATOR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    })) as { content: Array<{ type: string; text?: string }> };

    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        fullText += block.text;
        send({ type: "coordinator_text", content: block.text });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send({ type: "coordinator_text", content: `[Coordinator error: ${msg}]` });
    return null;
  }

  const match = fullText.match(/```json\s*([\s\S]*?)```/);
  if (!match) return { raw: fullText };
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return { raw: fullText };
  }
}

/* ── GET /api/anthropic/investigation ─────────────────────────────────────── */

router.get("/investigation", async (_req, res) => {
  try {
    const rows = await db
      .select(investigationRunPublicColumns)
      .from(investigationRunsTable)
      .orderBy(desc(investigationRunsTable.startedAt))
      .limit(50);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/* ── GET /api/anthropic/investigation/:runId ──────────────────────────────── */

router.get("/investigation/:runId", async (req, res) => {
  try {
    const [run] = await db
      .select(investigationRunPublicColumns)
      .from(investigationRunsTable)
      .where(eq(investigationRunsTable.id, req.params.runId));

    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const agentRuns = await db
      .select()
      .from(investigationAgentRunsTable)
      .where(eq(investigationAgentRunsTable.runId, run.id));

    res.json({ ...run, agentRuns });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/* ── POST /api/anthropic/investigation/:runId/cancel ─────────────────────── */

const activeAbortControllers = new Map<string, AbortController>();

router.post("/investigation/:runId/cancel", async (req, res) => {
  const controller = activeAbortControllers.get(req.params.runId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(req.params.runId);
  }

  try {
    await db
      .update(investigationRunsTable)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(investigationRunsTable.id, req.params.runId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/* ── POST /api/anthropic/investigation ─────────────────────────────────────── */

router.post("/investigation", async (req, res) => {
  let anthropic: {
    messages: { create: (...args: unknown[]) => Promise<unknown> };
  };
  try {
    const mod = await import("@workspace/integrations-anthropic-ai");
    anthropic = mod.anthropic as typeof anthropic;
  } catch {
    res.status(503).json({ error: "AI service unavailable" });
    return;
  }
  if (!anthropic) {
    res.status(503).json({ error: "AI service unavailable" });
    return;
  }

  const {
    title,
    binaryBase64,
    binaries: binariesBase64,
    agentIterCap = 8,
    tokenBudget = 200000,
    binaryMeta = {},
  } = req.body as {
    title?: string;
    binaryBase64?: string;
    binaries?: Record<string, string>;
    agentIterCap?: number;
    tokenBudget?: number;
    binaryMeta?: Record<string, unknown>;
  };

  const primary: Buffer = binaryBase64 ? Buffer.from(binaryBase64, "base64") : Buffer.alloc(0);
  const binaryMap: Record<string, Buffer> = {};
  if (binariesBase64) {
    for (const [id, b64] of Object.entries(binariesBase64)) {
      binaryMap[id] = Buffer.from(b64, "base64");
    }
  }

  const derivedMeta: Record<string, unknown> = {
    ...binaryMeta,
    primaryBytes: primary.length,
    secondaryIds: Object.keys(binaryMap),
  };

  let run: { id: string };
  try {
    const [created] = await db
      .insert(investigationRunsTable)
      .values({
        title: title ?? `Investigation ${new Date().toISOString().slice(0, 16)}`,
        status: "running",
        binaryMeta: derivedMeta,
        agentIterCap: Math.min(agentIterCap, 12),
        tokenBudget,
      })
      .returning();
    run = created;
  } catch (err) {
    res.status(500).json({ error: `DB error: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  const send: SseSend = (obj) => {
    if (!clientGone && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };

  send({ type: "run_created", runId: run.id });

  const abortController = new AbortController();
  activeAbortControllers.set(run.id, abortController);

  res.on("close", () => {
    abortController.abort();
    activeAbortControllers.delete(run.id);
  });

  const systemSuffix =
    primary.length > 0
      ? `**Binary loaded:** ${primary.length} bytes available for tool inspection.`
      : "No binary loaded — tools will return empty results.";

  try {
    const iterCap = Math.min(agentIterCap, 12);

    const agentPromises = AGENT_NAMES.map((agentName) =>
      runAgent(agentName, primary, binaryMap, send, abortController.signal, iterCap, anthropic, systemSuffix),
    );

    const agentResults = await Promise.all(agentPromises);

    if (abortController.signal.aborted) {
      send({ type: "run_cancelled", runId: run.id });
      await db
        .update(investigationRunsTable)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(investigationRunsTable.id, run.id));
      if (!clientGone) res.end();
      return;
    }

    const report = await runCoordinator(agentResults, send, abortController.signal, anthropic);

    const totalTokens = agentResults.reduce((acc, r) => acc + r.iterations * 1000, 0);

    await db
      .update(investigationRunsTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        report,
        totalTokensUsed: totalTokens,
      })
      .where(eq(investigationRunsTable.id, run.id));

    for (const r of agentResults) {
      await db.insert(investigationAgentRunsTable).values({
        runId: run.id,
        agentName: r.agentName,
        status: r.failed ? "failed" : "completed",
        findings: r.findings,
        toolTrace: r.toolTrace,
        iterations: r.iterations,
      });
    }

    send({ type: "run_done", runId: run.id, report });
    if (!clientGone) res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    try {
      await db
        .update(investigationRunsTable)
        .set({ status: "failed" })
        .where(eq(investigationRunsTable.id, run.id));
    } catch {}

    activeAbortControllers.delete(run.id);
    send({ type: "error", error: message });
    if (!clientGone) res.end();
  }

  activeAbortControllers.delete(run.id);
});

export default router;
