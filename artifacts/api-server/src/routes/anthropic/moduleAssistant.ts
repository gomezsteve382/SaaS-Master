import { Router } from "express";
import { SYSTEM_PROMPT, buildContextBlock, type ModuleContext } from "./_shared";

const router = Router();

router.post("/module-assistant", async (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let anthropic: any;
  try {
    const mod = await import("@workspace/integrations-anthropic-ai");
    anthropic = mod.anthropic;
  } catch {
    return res.status(503).json({ error: "AI service unavailable: Anthropic integration not configured" });
  }
  if (!anthropic) {
    return res.status(503).json({ error: "AI service unavailable" });
  }

  try {
    const { messages, moduleContext } = req.body as {
      messages: { role: string; content: string }[];
      moduleContext: ModuleContext;
    };

    if (!messages || !moduleContext) {
      res.status(400).json({ error: "messages and moduleContext are required" });
      return;
    }

    const contextBlock = buildContextBlock(moduleContext);

    const chatMessages = messages.map((m) => ({
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

    const systemPrompt = `${SYSTEM_PROMPT}\n\n${contextBlock}`;

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
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }
});

export default router;
