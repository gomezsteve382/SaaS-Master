import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages, conversationToolCalls } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { eq, asc, desc } from "drizzle-orm";
import {
  SYSTEM_PROMPT,
  buildContextBlock,
  buildAutoTitle,
  type ModuleContext,
} from "./_shared";

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

  const systemPrompt = moduleContext
    ? `${SYSTEM_PROMPT}\n\n${buildContextBlock(moduleContext)}`
    : SYSTEM_PROMPT;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      messages: chatMessages,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullResponse += event.delta.text;
        if (!clientGone) {
          res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
        }
      }
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
