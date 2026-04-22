import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { eq, asc } from "drizzle-orm";

const router = Router();

/* GET /anthropic/conversations */
router.get("/conversations", async (_req, res) => {
  const rows = await db
    .select()
    .from(conversations)
    .orderBy(asc(conversations.createdAt));
  res.json(rows);
});

/* POST /anthropic/conversations */
router.post("/conversations", async (req, res) => {
  const { title } = req.body as { title?: string };
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const [row] = await db.insert(conversations).values({ title }).returning();
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
  res.json({ ...conv, messages: msgs });
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

/* POST /anthropic/conversations/:id/messages — SSE stream */
router.post("/conversations/:id/messages", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { content } = req.body as { content?: string };
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

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));

  const chatMessages = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: chatMessages,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullResponse += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    await db
      .insert(messages)
      .values({ conversationId: id, role: "assistant", content: fullResponse });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  }
});

export default router;
