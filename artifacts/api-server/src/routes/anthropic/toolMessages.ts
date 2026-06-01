/**
 * POST /api/anthropic/conversations/:id/tool-messages
 *
 * SSE endpoint that runs the full Anthropic tool-use loop against the loaded
 * binary bytes supplied by the caller. Streams tool_call / tool_result / text
 * events and persists the full tool trace to conversation_tool_calls.
 *
 * Request body:
 *   content        — user message text
 *   moduleContext? — existing module context (injected into system prompt)
 *   binaryBase64?  — primary binary, base64-encoded
 *   binaries?      — map of { [id: string]: base64 } for hex_diff
 *
 * SSE event shapes:
 *   { type: "text",        content: string }
 *   { type: "tool_call",   id, toolName, args }
 *   { type: "tool_result", id, toolName, result, durationMs, bytesReturned }
 *   { type: "done",        toolTrace: ToolTraceEntry[] }
 *   { type: "error",       error: string }
 */

import { Router } from "express";
import { db, conversations, messages, conversationToolCalls } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { eq, asc } from "drizzle-orm";
import {
  SYSTEM_PROMPT,
  GENERAL_SYSTEM_PROMPT,
  buildContextBlock,
  buildAutoTitle,
  type ModuleContext,
} from "./_shared";
import {
  TOOL_REGISTRY,
  ANTHROPIC_TOOLS,
  MAX_TOOL_RESULT_BYTES,
  MAX_CUMULATIVE_BYTES,
  MAX_ITERATIONS,
} from "./toolRegistry";

const router = Router();

export interface ToolTraceEntry {
  id: string;
  toolName: string;
  module: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  bytesReturned: number;
}

/* Resolve the module label a tool step inspected, matching the client's
 * deriveToolModule (CopilotPanel.jsx) so resumed chats render the same labels
 * they showed live. Most tools run against the primary loaded dump; hex_diff
 * also names a second module via `otherId`. The primary key is the first key of
 * the binaries map (insertion order is preserved through JSON, so it matches
 * the client's primaryKey). Falls back to a generic label when no module is
 * known. */
function deriveToolModule(
  toolName: string,
  args: Record<string, unknown>,
  primaryKey: string | null,
): string {
  if (toolName === "hex_diff") {
    const otherId = typeof args.otherId === "string" ? args.otherId : null;
    if (primaryKey && otherId) return `${primaryKey} ↔ ${otherId}`;
    if (otherId) return `↔ ${otherId}`;
    return primaryKey || "diff";
  }
  return primaryKey || "loaded dump";
}

router.post("/conversations/:id/tool-messages", async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  if (isNaN(convId)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }

  const { content, moduleContext, binaryBase64, binaries: binariesBase64 } = req.body as {
    content?: string;
    moduleContext?: ModuleContext;
    binaryBase64?: string;
    binaries?: Record<string, string>;
  };

  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  // Decode binaries
  const primaryBuf: Buffer = binaryBase64
    ? Buffer.from(binaryBase64, "base64")
    : Buffer.alloc(0);

  const binaryMap: Record<string, Buffer> = {};
  if (binariesBase64) {
    for (const [id, b64] of Object.entries(binariesBase64)) {
      binaryMap[id] = Buffer.from(b64, "base64");
    }
  }

  /* The primary module key is the first entry of the binaries map (its
   * insertion order survives JSON serialization, so it matches the client's
   * resolved primaryKey). Used to label each tool step's inspected module. */
  const primaryKey: string | null = binariesBase64
    ? Object.keys(binariesBase64)[0] ?? null
    : null;

  // Persist user message
  const [userMsg] = await db
    .insert(messages)
    .values({ conversationId: convId, role: "user", content })
    .returning();

  // Auto-title
  if (conv.title === "New chat" || (conv.title.startsWith("[") && conv.title.endsWith("] New chat"))) {
    const newTitle = buildAutoTitle(content, conv.scope);
    await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, convId));
  }

  // Load full history for the context window
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(asc(messages.createdAt));

  const chatMessages: Array<{ role: "user" | "assistant"; content: string }> = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  /* Base prompt by scope: the global Co-pilot (scope="general") keeps its
   * non-restrictive general assistant prompt even when inspecting bytes, so it
   * can answer any question while still being able to call the binary tools.
   * Everything else (the Mismatch Wizard) keeps the IMMO module-assistant
   * prompt. The context + binary note append to whichever base applies. */
  const basePrompt =
    conv.scope === "general" ? GENERAL_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const systemPrompt = moduleContext
    ? `${basePrompt}\n\n${buildContextBlock(moduleContext)}\n\n${
        primaryBuf.length > 0
          ? `**Loaded binary:** ${primaryBuf.length} bytes available for tool inspection.`
          : "No binary loaded — tool calls returning data will be skipped."
      }`
    : basePrompt;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (obj: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  let clientGone = false;
  res.on("close", () => { clientGone = true; });

  let fullResponse = "";
  let iterationCount = 0;
  let cumulativeBytes = 0;
  const toolTrace: ToolTraceEntry[] = [];
  let assistantMessageId: number | undefined;

  try {
    // Tool-use loop
    const loopMessages = [...chatMessages];

    while (iterationCount < MAX_ITERATIONS) {
      iterationCount++;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: systemPrompt,
        tools: primaryBuf.length > 0 ? ANTHROPIC_TOOLS : [],
        messages: loopMessages,
      });

      // Collect text and tool_use blocks
      let hasToolUse = false;
      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

      for (const block of response.content) {
        if (block.type === "text") {
          fullResponse += block.text;
          if (!clientGone) send({ type: "text", content: block.text });
        } else if (block.type === "tool_use") {
          hasToolUse = true;

          const toolName = block.name;
          const args = (block.input ?? {}) as Record<string, unknown>;
          const toolId = block.id;

          if (!clientGone) {
            send({
              type: "tool_call",
              id: toolId,
              toolName,
              args: JSON.stringify(args).slice(0, 256),
            });
          }

          // Invoke the tool handler
          const def = TOOL_REGISTRY[toolName];
          let result: string;
          const t0 = Date.now();

          if (!def) {
            result = `Error: unknown tool "${toolName}"`;
          } else if (primaryBuf.length === 0) {
            result = "Error: no binary loaded — upload a module file to enable tool inspection.";
          } else if (cumulativeBytes >= MAX_CUMULATIVE_BYTES) {
            result = `Error: cumulative tool output cap (${MAX_CUMULATIVE_BYTES} bytes) reached — stopping tool calls.`;
          } else {
            try {
              result = await def.handler(primaryBuf, binaryMap, args);
              result = result.slice(0, MAX_TOOL_RESULT_BYTES);
            } catch (e) {
              result = `Error: tool execution failed — ${e instanceof Error ? e.message : String(e)}`;
            }
          }

          const durationMs = Date.now() - t0;
          const bytesReturned = Buffer.byteLength(result, "utf8");
          cumulativeBytes += bytesReturned;

          const module = deriveToolModule(toolName, args, primaryKey);
          const traceEntry: ToolTraceEntry = { id: toolId, toolName, module, args, result, durationMs, bytesReturned };
          toolTrace.push(traceEntry);

          if (!clientGone) {
            send({
              type: "tool_result",
              id: toolId,
              toolName,
              result: result.slice(0, 512),
              durationMs,
              bytesReturned,
            });
          }

          toolResults.push({ type: "tool_result", tool_use_id: toolId, content: result });
        }
      }

      // Add assistant turn to loop messages
      loopMessages.push({ role: "assistant", content: response.content as never });

      if (!hasToolUse || response.stop_reason === "end_turn") {
        // Done — no more tool calls
        break;
      }

      // Add tool results and continue
      loopMessages.push({ role: "user", content: toolResults as never });
    }

    // Persist assistant reply
    if (fullResponse.length > 0) {
      const [aMsg] = await db
        .insert(messages)
        .values({ conversationId: convId, role: "assistant", content: fullResponse })
        .returning();
      assistantMessageId = aMsg.id;
    }

    // Persist tool traces
    if (toolTrace.length > 0 && assistantMessageId != null) {
      for (const entry of toolTrace) {
        await db.insert(conversationToolCalls).values({
          conversationId: convId,
          messageId: assistantMessageId,
          toolName: entry.toolName,
          module: entry.module,
          toolArgs: JSON.stringify(entry.args).slice(0, 512),
          resultPreview: entry.result.slice(0, 512),
          bytesReturned: entry.bytesReturned,
          durationMs: entry.durationMs,
        });
      }
    }

    if (!clientGone) {
      send({ type: "done", toolTrace });
      res.end();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Try to persist partial assistant response
    if (fullResponse.length > 0 && !assistantMessageId) {
      try {
        await db.insert(messages).values({ conversationId: convId, role: "assistant", content: fullResponse });
      } catch {}
    }

    if (!clientGone) {
      send({ type: "error", error: message });
      res.end();
    }
  }

  void userMsg; // suppress unused warning — we use it indirectly via history reload
});

export default router;
