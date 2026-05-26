/**
 * SRT Lab — Swarm Coordinator
 *
 * Runs all 5 specialist agents in parallel against the same binary,
 * then feeds their combined findings to VENOM for synthesis.
 *
 * Architecture:
 *   1. Write binary to temp file
 *   2. Launch GHOST, PHANTOM, SPECTER, WRAITH, SHADE in parallel
 *   3. Each agent runs its own QueryEngine-style tool-use loop
 *   4. Collect all findings
 *   5. Feed everything to VENOM for cross-referencing and synthesis
 *   6. Return unified result
 */

import * as fs from "fs/promises";
import * as path from "path";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SPECIALIST_AGENTS, VENOM_SYSTEM_PROMPT, type SwarmAgent } from "../swarm/agents.js";
import { tools, getToolByName, getToolSchemas } from "../tools/index.js";
import type { ToolCallTrace, QueryEngineResult } from "../queryEngine.js";

// ─── Forge API ──────────────────────────────────────────────────────────────

const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "";
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";

// ─── Types ──────────────────────────────────────────────────────────────────

interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface AgentResult {
  agentId: string;
  codename: string;
  specialty: string;
  findings: any;
  rawNotes: string;
  toolCallTrace: ToolCallTrace[];
  durationMs: number;
  iterations: number;
  error?: string;
}

export interface SwarmEvent {
  type: "agent_start" | "agent_tool_start" | "agent_tool_end" | "agent_complete" | "agent_error" | "venom_start" | "venom_complete" | "swarm_complete" | "swarm_weights" | "swarm_routing" | "swarm_deploy";
  agentId?: string;
  codename?: string;
  iteration?: number;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  totalToolCalls?: number;
  message?: string;
}

// ─── LLM Call ───────────────────────────────────────────────────────────────

async function callLLM(
  messages: LLMMessage[],
  toolSchemas?: any[],
  toolChoice: "auto" | "required" | "none" = "auto",
  retries = 3
): Promise<{ message: LLMMessage; finishReason: string }> {
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);

  for (let attempt = 1; attempt <= retries; attempt++) {
    let response: Response;
    try {
      const body: any = {
        messages,
        max_tokens: 8192,
      };
      if (toolSchemas && toolSchemas.length > 0) {
        body.tools = toolSchemas;
        body.tool_choice = toolChoice;
      }

      response = await fetch(`${FORGE_API_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${FORGE_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr: any) {
      if (attempt === retries) throw new Error(`LLM network error: ${networkErr.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      if (RETRYABLE.has(response.status) && attempt < retries) {
        console.warn(`[Swarm] LLM ${response.status} attempt ${attempt}, retrying...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`LLM API error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error("Empty LLM response");

    return {
      message: choice.message as LLMMessage,
      finishReason: choice.finish_reason || "stop",
    };
  }

  throw new Error("LLM API failed after all retries");
}

// ─── Build tool schemas for a specific agent ────────────────────────────────

function getAgentToolSchemas(agent: SwarmAgent) {
  const allSchemas = getToolSchemas();
  return allSchemas.filter((s: any) => agent.toolNames.includes(s.function.name));
}

// ─── Run a single specialist agent ──────────────────────────────────────────

const MAX_TOOL_RESULT_CHARS = 60000;

async function runSpecialistAgent(
  agent: SwarmAgent,
  filePath: string,
  filename: string,
  fileSize: number,
  onEvent?: (event: SwarmEvent) => void,
  patternContext: string = ""
): Promise<AgentResult> {
  const startTime = Date.now();
  const toolCallTrace: ToolCallTrace[] = [];
  const agentToolSchemas = getAgentToolSchemas(agent);

  console.log(`[Swarm/${agent.codename}] Starting with ${agentToolSchemas.length} tools, max ${agent.maxIterations} iterations`);
  onEvent?.({
    type: "agent_start",
    agentId: agent.id,
    codename: agent.codename,
    message: `${agent.codename} deploying — ${agent.specialty}`,
  });

  const userMessage = `Analyze this binary file: "${filename}" (${fileSize} bytes, ${(fileSize / 1024).toFixed(1)} KB)

The file has been written to: ${filePath}

Use your tools to investigate this binary from your area of expertise. Start immediately and dig deep. Do NOT stop after one or two tool calls — keep going until you have a complete picture from your domain.${patternContext}`;

  const messages: LLMMessage[] = [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: userMessage },
  ];

  let iterations = 0;
  let finalText = "";

  try {
    while (iterations < agent.maxIterations) {
      iterations++;

      const toolChoice = iterations === 1 ? "required" : "auto";
      const { message, finishReason } = await callLLM(
        messages,
        agentToolSchemas,
        toolChoice as "auto" | "required"
      );

      if (message.tool_calls && message.tool_calls.length > 0) {
        messages.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.tool_calls,
        });

        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function?.name;
          const toolArgs = (() => {
            try { return JSON.parse(toolCall.function?.arguments || "{}"); }
            catch { return {}; }
          })();

          const tool = getToolByName(toolName);
          const toolStart = Date.now();
          let toolResult = "";

          if (tool && agent.toolNames.includes(toolName)) {
            try {
              onEvent?.({
                type: "agent_tool_start",
                agentId: agent.id,
                codename: agent.codename,
                iteration: iterations,
                toolName,
                args: toolArgs,
              });
              toolResult = await tool.call(toolArgs, filePath);
            } catch (err) {
              toolResult = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            toolResult = `Tool ${toolName} not available for agent ${agent.codename}`;
          }

          const toolDuration = Date.now() - toolStart;

          if (toolResult.length > MAX_TOOL_RESULT_CHARS) {
            toolResult = toolResult.slice(0, MAX_TOOL_RESULT_CHARS) +
              `\n... [truncated — ${toolResult.length - MAX_TOOL_RESULT_CHARS} more chars]`;
          }

          onEvent?.({
            type: "agent_tool_end",
            agentId: agent.id,
            codename: agent.codename,
            iteration: iterations,
            toolName,
            args: toolArgs,
            result: toolResult.slice(0, 500),
            durationMs: toolDuration,
          });

          toolCallTrace.push({
            toolName,
            args: toolArgs,
            result: toolResult,
            durationMs: toolDuration,
          });

          messages.push({
            role: "tool",
            content: toolResult,
            tool_call_id: toolCall.id,
            name: toolName,
          });
        }
        continue;
      }

      // No tool calls — final response
      finalText = typeof message.content === "string" ? message.content : "";
      break;
    }

    // If we hit the iteration limit without a final response, ask for synthesis
    if (!finalText && toolCallTrace.length > 0) {
      messages.push({
        role: "user",
        content: `You have gathered extensive data. Now synthesize ALL your findings into the required JSON response. Return ONLY the JSON object.`,
      });
      const { message } = await callLLM(messages, undefined, "none");
      finalText = typeof message.content === "string" ? message.content : "";
    }

    // Parse the agent's findings
    let findings: any = {};
    let rawNotes = "";
    try {
      const parsed = repairAndParseJSON(finalText);
      findings = parsed.findings || parsed;
      rawNotes = parsed.rawNotes || "";
    } catch {
      findings = {};
      rawNotes = finalText.slice(0, 2000);
    }

    const durationMs = Date.now() - startTime;
    console.log(`[Swarm/${agent.codename}] Complete: ${iterations} iterations, ${toolCallTrace.length} tool calls, ${durationMs}ms`);

    onEvent?.({
      type: "agent_complete",
      agentId: agent.id,
      codename: agent.codename,
      totalToolCalls: toolCallTrace.length,
      durationMs,
      message: `${agent.codename} complete — ${toolCallTrace.length} tool calls in ${(durationMs / 1000).toFixed(1)}s`,
    });

    return {
      agentId: agent.id,
      codename: agent.codename,
      specialty: agent.specialty,
      findings,
      rawNotes,
      toolCallTrace,
      durationMs,
      iterations,
    };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    console.error(`[Swarm/${agent.codename}] Error:`, error.message);

    onEvent?.({
      type: "agent_error",
      agentId: agent.id,
      codename: agent.codename,
      message: `${agent.codename} encountered error: ${error.message}`,
    });

    return {
      agentId: agent.id,
      codename: agent.codename,
      specialty: agent.specialty,
      findings: {},
      rawNotes: `Agent error: ${error.message}`,
      toolCallTrace,
      durationMs,
      iterations,
      error: error.message,
    };
  }
}

// ─── VENOM Synthesis ────────────────────────────────────────────────────────

async function runVenomSynthesis(
  agentResults: AgentResult[],
  filename: string,
  fileSize: number,
  onEvent?: (event: SwarmEvent) => void
): Promise<string> {
  onEvent?.({
    type: "venom_start",
    agentId: "venom",
    codename: "VENOM",
    message: "VENOM synthesizing all agent findings...",
  });

  // Build the synthesis prompt with all agent findings
  let agentReports = "";
  for (const result of agentResults) {
    agentReports += `\n${"═".repeat(60)}\n`;
    agentReports += `AGENT: ${result.codename} (${result.iterations} iterations, ${result.toolCallTrace.length} tool calls, ${(result.durationMs / 1000).toFixed(1)}s)\n`;
    agentReports += `${"═".repeat(60)}\n`;
    if (result.error) {
      agentReports += `ERROR: ${result.error}\n`;
    }
    agentReports += `FINDINGS:\n${JSON.stringify(result.findings, null, 2)}\n`;
    if (result.rawNotes) {
      agentReports += `RAW NOTES: ${result.rawNotes}\n`;
    }
    // Include key tool results for context
    const keyResults = result.toolCallTrace
      .filter(t => t.result.length > 100)
      .slice(0, 5)
      .map(t => `  [${t.toolName}] ${t.result.slice(0, 1000)}`);
    if (keyResults.length > 0) {
      agentReports += `KEY TOOL OUTPUTS:\n${keyResults.join("\n")}\n`;
    }
  }

  const messages: LLMMessage[] = [
    { role: "system", content: VENOM_SYSTEM_PROMPT },
    {
      role: "user",
      content: `File: "${filename}" (${fileSize} bytes, ${(fileSize / 1024).toFixed(1)} KB)

Your 5 specialist agents have completed their independent analysis. Here are their full reports:

${agentReports}

Now synthesize ALL findings into a single comprehensive intelligence report. Cross-reference findings between agents. Identify what they found, what they missed, and what needs deeper investigation.

Return ONLY the JSON object in the format specified in your system prompt.`,
    },
  ];

  try {
    const { message } = await callLLM(messages, undefined, "none");
    const text = typeof message.content === "string" ? message.content : "";

    onEvent?.({
      type: "venom_complete",
      agentId: "venom",
      codename: "VENOM",
      message: "VENOM synthesis complete",
    });

    return text;
  } catch (error: any) {
    console.error("[Swarm/VENOM] Synthesis error:", error.message);
    onEvent?.({
      type: "venom_complete",
      agentId: "venom",
      codename: "VENOM",
      message: `VENOM synthesis error: ${error.message}`,
    });
    return "";
  }
}

// ─── JSON Repair (same as queryEngine.ts) ───────────────────────────────────

function repairAndParseJSON(raw: string): any {
  try { return JSON.parse(raw); } catch {}

  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(raw.substring(firstBrace, lastBrace + 1)); } catch {}
  }

  return { findings: {}, rawNotes: raw.slice(0, 2000) };
}

// ─── Main Swarm Runner ──────────────────────────────────────────────────────

export async function runSwarm(
  buffer: Buffer,
  filename: string,
  passNumber: number = 1,
  priorFindings?: string,
  onEvent?: (event: SwarmEvent) => void
): Promise<QueryEngineResult> {
  const swarmStart = Date.now();

  // Write buffer to temp file
  const tmpDir = await mkdtemp(join(tmpdir(), "srtlab-swarm-"));
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = join(tmpDir, safeFilename);
  await writeFile(filePath, buffer);

  // Load matching patterns from library for context injection
  let patternContext = "";
  try {
    const { getPatterns } = await import("../db-patterns.js");
    const allPatterns = await getPatterns("system");
    if (allPatterns.length > 0) {
      const patternSummary = allPatterns.slice(0, 50).map((p: any) =>
        `[${p.category}] ${p.name}: ${p.description}${p.hexSignature ? ` (sig: ${p.hexSignature})` : ""}`
      ).join("\n");
      patternContext = `\n\n=== KNOWN FCA PATTERN LIBRARY (${allPatterns.length} patterns) ===\n${patternSummary}\n\nMatch these known patterns against what you find in the binary.`;
    }
  } catch {}

  try {
    // ── Phase 1: Launch all 5 specialists in parallel ───────────────────────
    console.log(`[Swarm] Deploying 5 specialist agents against ${filename} (${buffer.length} bytes)`);

    const agentResults = await Promise.all(
      SPECIALIST_AGENTS.map(agent =>
        runSpecialistAgent(agent, filePath, filename, buffer.length, onEvent, patternContext)
      )
    );

    // ── Phase 2: VENOM synthesis ────────────────────────────────────────
    console.log("[Swarm] All specialists complete. Running VENOM synthesis...");
    const venomText = await runVenomSynthesis(agentResults, filename, buffer.length, onEvent);

    // ── Phase 3: Parse and merge results ────────────────────────────────
    const allToolCalls: ToolCallTrace[] = [];
    for (const result of agentResults) {
      for (const trace of result.toolCallTrace) {
        allToolCalls.push({
          ...trace,
          toolName: `[${result.codename}] ${trace.toolName}`,
        });
      }
    }

    // Parse VENOM's synthesis
    let parsed: any = {};
    try {
      parsed = repairAndParseJSON(venomText);
    } catch {}

    // Build the dissection report
    const agentSummaries = agentResults.map(r =>
      `${r.codename}: ${r.toolCallTrace.length} tools, ${r.iterations} iterations, ${(r.durationMs / 1000).toFixed(1)}s${r.error ? ` (ERROR: ${r.error})` : ""}`
    ).join("\n");

    const dissectionReport = `═══ SWARM ANALYSIS REPORT ═══
Agents deployed: ${SPECIALIST_AGENTS.length}
Total tool calls: ${allToolCalls.length}
Total duration: ${((Date.now() - swarmStart) / 1000).toFixed(1)}s

${agentSummaries}

VENOM synthesis: ${venomText ? "Complete" : "Failed"}`;

    // Merge agent notes into deep findings
    const deepFindings: any[] = Array.isArray(parsed.deepFindings) ? parsed.deepFindings : [];

    // Add per-agent raw notes as deep findings
    for (const result of agentResults) {
      if (result.rawNotes && result.rawNotes.length > 10) {
        deepFindings.push({
          category: result.agentId,
          title: `${result.codename} Intelligence Notes`,
          offset: "",
          details: result.rawNotes.slice(0, 2000),
          programmingRelevance: `From ${result.codename} (${result.specialty})`,
        });
      }
    }

    // Add gaps as deep findings
    if (Array.isArray(parsed.gaps)) {
      for (const gap of parsed.gaps) {
        deepFindings.push({
          category: "gap",
          title: "Investigation Gap",
          offset: "",
          details: typeof gap === "string" ? gap : JSON.stringify(gap),
          programmingRelevance: "Needs further investigation",
        });
      }
    }

    const swarmDuration = Date.now() - swarmStart;
    console.log(`[Swarm] Complete: ${allToolCalls.length} total tool calls in ${(swarmDuration / 1000).toFixed(1)}s`);

    onEvent?.({
      type: "swarm_complete",
      totalToolCalls: allToolCalls.length,
      durationMs: swarmDuration,
      message: `Swarm analysis complete — ${allToolCalls.length} tool calls across ${SPECIALIST_AGENTS.length} agents`,
    });

    // Return unified result compatible with QueryEngineResult
    return {
      summary: parsed.summary || `Swarm analysis of ${filename} — ${SPECIALIST_AGENTS.length} agents deployed, ${allToolCalls.length} tool calls executed.`,
      algorithms: Array.isArray(parsed.algorithms) ? parsed.algorithms : [],
      seedKeys: Array.isArray(parsed.seedKeys) ? parsed.seedKeys : [],
      canIds: (Array.isArray(parsed.canAddresses) ? parsed.canAddresses : []).map((c: any) => ({
        id: c.txId || c.id || "",
        description: c.description || "",
      })),
      canAddresses: Array.isArray(parsed.canAddresses) ? parsed.canAddresses : [],
      securityBytes: Array.isArray(parsed.securityBytes) ? parsed.securityBytes : [],
      checksums: Array.isArray(parsed.checksums) ? parsed.checksums : [],
      memoryMaps: Array.isArray(parsed.memoryMaps) ? parsed.memoryMaps : [],
      deepFindings,
      strings: Array.isArray(parsed.strings) ? parsed.strings : [],
      cryptoConstants: Array.isArray(parsed.cryptoConstants) ? parsed.cryptoConstants : [],
      toolCallTrace: allToolCalls,
      passNumber,
      analysisMode: "deep_agent",
      dissectionReport,
      agentResults: agentResults.map(r => ({
        agentId: r.agentId,
        codename: r.codename,
        specialty: r.specialty,
        rawNotes: r.rawNotes,
        toolCallCount: r.toolCallTrace.length,
        iterations: r.iterations,
        durationMs: r.durationMs,
        error: r.error,
      })),
    };
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// Alias for backward compatibility with server/index.ts and batch-queue.ts
export { runSwarm as runClaudeCodeSwarm };
