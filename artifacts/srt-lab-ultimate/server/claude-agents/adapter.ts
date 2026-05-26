/**
 * SRT Lab — Claude Code Agent Adapter
 *
 * Bridges Claude Code's multi-agent framework with SRT Lab's binary analysis pipeline.
 * Allows spawning specialized agents (GHOST, PHANTOM, SPECTER, etc.) that coordinate
 * via Claude Code's task management system.
 */

import type { SwarmAgent } from "../swarm/agents.js";
import type { QueryEngineResult, ToolCallTrace } from "../queryEngine.js";
import { tools, getToolByName } from "../tools/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClaudeAgentTask {
  id: string;
  agentId: string;
  codename: string;
  status: "pending" | "running" | "complete" | "failed";
  startTime: number;
  endTime?: number;
  findings: any;
  toolCallTrace: ToolCallTrace[];
  iterations: number;
  error?: string;
}

export interface AgentSpawnOptions {
  filePath: string;
  filename: string;
  fileSize: number;
  agent: SwarmAgent;
  patternContext?: string;
  onEvent?: (event: any) => void;
}

// ─── Agent Task Registry ────────────────────────────────────────────────────

const activeTasks = new Map<string, ClaudeAgentTask>();

export function registerAgentTask(task: ClaudeAgentTask): void {
  activeTasks.set(task.id, task);
}

export function getAgentTask(taskId: string): ClaudeAgentTask | undefined {
  return activeTasks.get(taskId);
}

export function getAllAgentTasks(): ClaudeAgentTask[] {
  return Array.from(activeTasks.values());
}

// ─── Spawn Agent (Claude Code Pattern) ──────────────────────────────────────

export async function spawnAgent(options: AgentSpawnOptions): Promise<ClaudeAgentTask> {
  const { filePath, filename, fileSize, agent, patternContext = "", onEvent } = options;
  
  const taskId = `agent-${agent.id}-${Date.now()}`;
  const task: ClaudeAgentTask = {
    id: taskId,
    agentId: agent.id,
    codename: agent.codename,
    status: "pending",
    startTime: Date.now(),
    findings: {},
    toolCallTrace: [],
    iterations: 0,
    error: undefined,
  };

  registerAgentTask(task);
  onEvent?.({ type: "agent_start", agentId: agent.id, codename: agent.codename });

  // Run the agent's tool-use loop
  try {
    task.status = "running";
    
    const userMessage = `Analyze this binary file: "${filename}" (${fileSize} bytes, ${(fileSize / 1024).toFixed(1)} KB)

The file has been written to: ${filePath}

Use your tools to investigate this binary from your area of expertise. Start immediately and dig deep. Do NOT stop after one or two tool calls — keep going until you have a complete picture from your domain.${patternContext}`;

    // Build LLM messages
    const messages: any[] = [
      { role: "system", content: agent.systemPrompt },
      { role: "user", content: userMessage },
    ];

    // Tool-use loop (same as QueryEngine)
    let iterations = 0;
    let finalText = "";

    while (iterations < agent.maxIterations) {
      iterations++;
      task.iterations = iterations;

      // Call LLM with tool choice
      const toolChoice = iterations === 1 ? "required" : "auto";
      const { message, finishReason } = await callLLM(messages, agent.toolNames, toolChoice);

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

          if (toolResult.length > 60000) {
            toolResult = toolResult.slice(0, 60000) +
              `\n... [truncated — ${toolResult.length - 60000} more chars]`;
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

          task.toolCallTrace.push({
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
    if (!finalText && task.toolCallTrace.length > 0) {
      messages.push({
        role: "user",
        content: `You have gathered extensive data. Now synthesize ALL your findings into the required JSON response. Return ONLY the JSON object.`,
      });
      const { message } = await callLLM(messages, [], "none");
      finalText = typeof message.content === "string" ? message.content : "";
    }

    // Parse findings
    let findings: any = {};
    try {
      const parsed = repairAndParseJSON(finalText);
      findings = parsed.findings || parsed;
    } catch {
      findings = {};
    }

    task.findings = findings;
    task.status = "complete";
    task.endTime = Date.now();

    onEvent?.({
      type: "agent_complete",
      agentId: agent.id,
      codename: agent.codename,
      totalToolCalls: task.toolCallTrace.length,
      durationMs: task.endTime - task.startTime,
      message: `${agent.codename} complete — ${task.toolCallTrace.length} tool calls`,
    });

    return task;
  } catch (error: any) {
    task.status = "failed";
    task.error = error.message;
    task.endTime = Date.now();

    onEvent?.({
      type: "agent_error",
      agentId: agent.id,
      codename: agent.codename,
      message: `${agent.codename} encountered error: ${error.message}`,
    });

    return task;
  }
}

// ─── LLM Call ───────────────────────────────────────────────────────────────

async function callLLM(
  messages: any[],
  toolNames: string[],
  toolChoice: "auto" | "required" | "none" = "auto",
  retries = 4
): Promise<{ message: any; finishReason: string }> {
  const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "";
  const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";
  const RETRYABLE = new Set([412, 429, 500, 502, 503, 504]);

  for (let attempt = 1; attempt <= retries; attempt++) {
    let response: Response;
    try {
      const body: any = {
        messages,
        max_tokens: 8192,
      };

      // Build tool schemas for allowed tools
      if (toolNames.length > 0 && toolChoice !== "none") {
        const allTools = tools;
        body.tools = allTools
          .filter(t => toolNames.includes(t.name))
          .map(t => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          }));
        body.tool_choice = toolChoice;
      }

      const abortCtrl = new AbortController();
      const abortTimer = setTimeout(() => abortCtrl.abort(), 40_000);
      try {
        response = await fetch(`${FORGE_API_URL}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${FORGE_API_KEY}`,
          },
          body: JSON.stringify(body),
          signal: abortCtrl.signal,
        });
      } finally {
        clearTimeout(abortTimer);
      }
    } catch (networkErr: any) {
      if (attempt === retries) throw new Error(`LLM network error: ${networkErr.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      if (RETRYABLE.has(response.status) && attempt < retries) {
        console.warn(`[Agent] LLM ${response.status} attempt ${attempt}, retrying...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`LLM API error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
      if (attempt < retries) {
        console.warn(`[Agent] Empty LLM response attempt ${attempt}, retrying...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error("Empty LLM response");
    }

    return {
      message: choice.message as any,
      finishReason: choice.finish_reason || "stop",
    };
  }

  throw new Error("LLM API failed after all retries");
}

// ─── JSON Repair ────────────────────────────────────────────────────────────

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
