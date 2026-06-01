import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages, conversationToolCalls, patternLibraryTable } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { eq, asc, desc, or, ilike } from "drizzle-orm";
import {
  SYSTEM_PROMPT,
  GENERAL_SYSTEM_PROMPT,
  buildContextBlock,
  buildAutoTitle,
  type ModuleContext,
} from "./_shared";

/* ── pattern_library_lookup tool definition ─────────────────────────── */
const PATTERN_LIBRARY_TOOL = {
  name: "pattern_library_lookup",
  description:
    "Search the Pattern Library for byte-level signatures the bench has actually observed across real module dumps. " +
    "Returns matching patterns with category, label, signature bytes, confidence, source analysis IDs, and notes. " +
    "Use this when the user asks about a specific VIN, calibration ID, security bytes, or algorithm seen in past dumps.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Search string — can be a VIN, hex bytes, calibration ID, algorithm name, or any label fragment.",
      },
    },
    required: ["query"],
  },
};

async function runPatternLookup(query: string): Promise<string> {
  try {
    const rows = await db
      .select()
      .from(patternLibraryTable)
      .where(
        or(
          ilike(patternLibraryTable.label, "%" + query + "%"),
          ilike(patternLibraryTable.notes, "%" + query + "%"),
          ilike(patternLibraryTable.signatureBytes, "%" + query + "%"),
        ),
      )
      .limit(10);

    if (rows.length === 0) {
      return `No patterns found in the library matching "${query}". This may be a novel signature not yet observed by the bench.`;
    }

    const summary = rows
      .map((r) => {
        const srcCount = Array.isArray(r.sourceAnalysisIds)
          ? (r.sourceAnalysisIds as unknown[]).length
          : 0;
        return (
          `• [${r.category}] ${r.label}\n` +
          `  Confidence: ${Math.round((r.confidence ?? 1) * 100)}%` +
          (r.signatureBytes ? `  Bytes: ${r.signatureBytes.slice(0, 48)}${r.signatureBytes.length > 48 ? "…" : ""}` : "") +
          (srcCount > 0 ? `  Seen in ${srcCount} analysis/analyses` : "") +
          (r.notes ? `  Notes: ${r.notes}` : "")
        );
      })
      .join("\n");

    return `Found ${rows.length} pattern(s) matching "${query}":\n${summary}`;
  } catch (err) {
    return `Pattern lookup failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const router = Router();

/* GET /anthropic/conversations?scope=... */
router.get("/conversations", async (req, res) => {
  const scope = typeof req.query.scope === "string" ? req.query.scope : undefined;
  const rows = scope
    ? await db
        .select()
        .from(conversations)
        .where(eq(conversations.scope, scope))
        .orderBy(desc(conversations.createdAt))
    : await db.select().from(conversations).orderBy(desc(conversations.createdAt));
  res.json(rows);
});

/* POST /anthropic/conversations  { title, scope? } */
router.post("/conversations", async (req, res) => {
  const { title, scope } = req.body as { title?: string; scope?: string | null };
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const [row] = await db
    .insert(conversations)
    .values({ title, scope: scope ?? null })
    .returning();
  res.status(201).json(row);
});

/* GET /anthropic/conversations/:id */
router.get("/conversations/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));

  /* Task #694 — join persisted tool traces grouped by messageId so a
   * resumed conversation shows the same per-message tool-call disclosure
   * that streamed live. Tool calls without a messageId (orphans from
   * mid-stream failures) are dropped. */
  const toolCalls = await db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.conversationId, id))
    .orderBy(asc(conversationToolCalls.createdAt));
  const tracesByMessageId = new Map<number, Array<Record<string, unknown>>>();
  for (const tc of toolCalls) {
    if (tc.messageId == null) continue;
    let bucket = tracesByMessageId.get(tc.messageId);
    if (!bucket) { bucket = []; tracesByMessageId.set(tc.messageId, bucket); }
    let parsedArgs: unknown = {};
    try { parsedArgs = JSON.parse(tc.toolArgs); } catch { parsedArgs = { raw: tc.toolArgs }; }
    bucket.push({
      toolName: tc.toolName,
      args: parsedArgs,
      resultPreview: tc.resultPreview,
      bytesReturned: tc.bytesReturned,
      durationMs: tc.durationMs,
    });
  }
  const msgsWithTraces = msgs.map((m) => {
    const trace = tracesByMessageId.get(m.id);
    return trace && trace.length > 0 ? { ...m, toolTrace: trace } : m;
  });
  res.json({ ...conv, messages: msgsWithTraces });
});

/* DELETE /anthropic/conversations/:id */
router.delete("/conversations/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const deleted = await db
    .delete(conversations)
    .where(eq(conversations.id, id))
    .returning();
  if (!deleted.length) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

/* GET /anthropic/conversations/:id/messages */
router.get("/conversations/:id/messages", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));
  res.json(msgs);
});

/* POST /anthropic/conversations/:id/messages — SSE stream
 * Optional moduleContext in body injects the SRT system prompt + context block.
 */
router.post("/conversations/:id/messages", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { content, moduleContext } = req.body as {
    content?: string;
    moduleContext?: ModuleContext;
  };
  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await db.insert(messages).values({ conversationId: id, role: "user", content });

  /* Auto-title from first user message if conversation still has the placeholder. */
  if (conv.title === "New chat" || conv.title.startsWith("[") && conv.title.endsWith("] New chat")) {
    const newTitle = buildAutoTitle(content, conv.scope);
    await db
      .update(conversations)
      .set({ title: newTitle })
      .where(eq(conversations.id, id));
  }

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));

  const chatMessages = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  /* Pick the base prompt by conversation scope: the global AI Co-pilot
   * (scope="general") gets the non-restrictive general assistant prompt so it
   * answers any question; everything else uses the IMMO module-assistant
   * prompt. A moduleContext always implies a module-assistant conversation, so
   * it overrides scope and appends the live context block. */
  const basePrompt =
    conv.scope === "general" ? GENERAL_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const systemPrompt = moduleContext
    ? `${SYSTEM_PROMPT}\n\n${buildContextBlock(moduleContext)}`
    : basePrompt;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  try {
    /* Tool-use agentic loop.
     * Up to 3 rounds: model may call pattern_library_lookup, we execute it,
     * feed the result back, then stream the final text response. */
    type AnthropicMessage = {
      role: "user" | "assistant";
      content: string | Array<Record<string, unknown>>;
    };
    const loopMessages: AnthropicMessage[] = chatMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const MAX_TOOL_ROUNDS = 3;
    let toolRound = 0;
    let finalTextStreamed = false;

    while (toolRound <= MAX_TOOL_ROUNDS) {
      /* Use streaming only on the last (or only) response so SSE stays live. */
      const isLastRound = toolRound === MAX_TOOL_ROUNDS;

      /* Non-streaming call for tool-resolution rounds; streaming for final text. */
      const resp = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: systemPrompt,
        tools: [PATTERN_LIBRARY_TOOL],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: loopMessages as any[],
        stream: false,
      });

      /* Collect any text blocks from this response. */
      const textParts: string[] = [];
      const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      for (const block of resp.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolUses.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
        }
      }

      /* If the model returned text (no pending tool calls), stream it and stop. */
      if (textParts.length > 0 && toolUses.length === 0) {
        const text = textParts.join("");
        fullResponse += text;
        if (!clientGone) {
          res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
        }
        finalTextStreamed = true;
        break;
      }

      /* Model wants to call tools — execute them and append results. */
      if (toolUses.length > 0 && !isLastRound) {
        loopMessages.push({ role: "assistant", content: resp.content as unknown as Array<Record<string, unknown>> });

        /* If there was also text before the tool call, accumulate it. */
        if (textParts.length > 0) {
          fullResponse += textParts.join("");
          if (!clientGone) {
            res.write(`data: ${JSON.stringify({ content: textParts.join("") })}\n\n`);
          }
        }

        const toolResults: Array<Record<string, unknown>> = [];
        for (const tu of toolUses) {
          let result = "";
          if (tu.name === "pattern_library_lookup") {
            const query = typeof tu.input.query === "string" ? tu.input.query : String(tu.input.query ?? "");
            result = await runPatternLookup(query);
          } else {
            result = `Unknown tool: ${tu.name}`;
          }
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
        }
        loopMessages.push({ role: "user", content: toolResults });
        toolRound++;
        continue;
      }

      /* If there was text mixed with tool use on the last round, grab it. */
      if (textParts.length > 0) {
        const text = textParts.join("");
        fullResponse += text;
        if (!clientGone) {
          res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
        }
        finalTextStreamed = true;
      }
      break;
    }

    /* Always persist the assistant reply, even if the client disconnected. */
    if (fullResponse.length > 0) {
      await db
        .insert(messages)
        .values({ conversationId: id, role: "assistant", content: fullResponse });
    }

    if (!clientGone) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (fullResponse.length > 0) {
      await db
        .insert(messages)
        .values({ conversationId: id, role: "assistant", content: fullResponse });
    }
    if (!clientGone) {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }
});

export default router;
