import { Router } from "express";

const router = Router();

const SYSTEM_PROMPT = `You are the SRT Lab Module Assistant — an expert in FCA/Stellantis ECU module diagnostics for Dodge Charger, Challenger, Durango, Grand Cherokee Trackhawk, and Ram TRX vehicles.

Your role is to help users understand and resolve IMMO/security module mismatches between BCM, RFHUB, and PCM (GPEC2A) chips.

Key knowledge:
- BCM (Body Control Module): MPC5606B DFLASH — stores VIN, SEC16, and FOBIK keys
- RFHUB (Remote/FOBIK Hub): Yazaki FCM EEPROM — stores VIN (byte-reversed), SEC16, and key slots
- PCM (Powertrain Control Module): Continental GPEC2A/GPEC5 — stores VIN and SEC6 derived from SEC16
- VIN MISMATCH: modules came from different vehicles and must be re-paired
- SEC16 MISMATCH: security token mismatch — BCM stores reverse(RFHUB SEC16); PCM SEC6 = first 6 bytes of RFHUB SEC16
- Standard fix flow: Load BCM+RFHUB → run VIN sync → run SEC16 sync → flash both modules → 30s power cycle
- BCM SEC16 → RFHUB: use when BCM has valid SEC16 but RFHUB came from different vehicle
- RFHUB is "master" for SEC16 in normal flow; BCM is master in BCM→RFH flow

Be concise, technical, and action-oriented. When describing hex data, use formatting like \`AB CD EF\`. Always guide the user toward the specific action button or step needed in the wizard. Never ask the user to open another tool — all actions are available in SRT Lab itself.`;

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
      moduleContext: {
        modules: string[];
        issues: string[];
        warnings: string[];
        hexSnippets?: string[];
      };
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

function buildContextBlock(ctx: {
  modules: string[];
  issues: string[];
  warnings: string[];
  hexSnippets?: string[];
}): string {
  const lines = ["## Current Module Context"];
  if (ctx.modules.length) {
    lines.push(`**Loaded modules:** ${ctx.modules.join(", ")}`);
  }
  if (ctx.issues.length) {
    lines.push("\n**Issues (errors):**");
    ctx.issues.forEach((i) => lines.push(`- ❌ ${i}`));
  }
  if (ctx.warnings.length) {
    lines.push("\n**Warnings:**");
    ctx.warnings.forEach((w) => lines.push(`- ⚠️ ${w}`));
  }
  if (ctx.hexSnippets?.length) {
    lines.push("\n**Hex snippets:**");
    ctx.hexSnippets.forEach((h) => lines.push(`\`${h}\``));
  }
  return lines.join("\n");
}

export default router;
