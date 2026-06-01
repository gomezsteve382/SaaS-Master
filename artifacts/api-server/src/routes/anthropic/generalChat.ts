import { Router } from "express";
import { GENERAL_SYSTEM_PROMPT } from "./_shared";

const router = Router();

/* General-purpose Claude chat — the always-available co-pilot surfaced from
 * the app shell. Unlike module-assistant, it does NOT require module context
 * and uses a general-purpose system prompt so it can answer any question,
 * not just IMMO/security-mismatch topics. SSE shape matches module-assistant
 * (`data: {content}` deltas, terminal `data: {done:true}`) so the frontend
 * streaming reader is shared.
 *
 * This endpoint remains stateless. The persistent co-pilot (chats that survive
 * a page refresh) reuses the conversations API with scope="general", which
 * shares GENERAL_SYSTEM_PROMPT from _shared. */
router.post("/general-chat", async (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let anthropic: any;
  try {
    const mod = await import("@workspace/integrations-anthropic-ai");
    anthropic = mod.anthropic;
  } catch {
    res.status(503).json({ error: "AI service unavailable: Anthropic integration not configured" });
    return;
  }
  if (!anthropic) {
    res.status(503).json({ error: "AI service unavailable" });
    return;
  }

  try {
    const { messages } = req.body as {
      messages?: { role: string; content: string }[];
    };

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    const chatMessages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    if (chatMessages.length === 0 || chatMessages[0].role !== "user") {
      res.status(400).json({ error: "First message must be from user" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: GENERAL_SYSTEM_PROMPT,
      messages: chatMessages,
    });

    // Stop streaming (and abort the upstream model call) if the client
    // disconnects so we don't keep burning tokens or write to a dead socket.
    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
      stream.abort?.();
    });

    for await (const event of stream) {
      if (clientGone) break;
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    if (!clientGone) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Don't try to write to a socket the client already closed.
    if (res.writableEnded || !res.writable) {
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }
});

export default router;
