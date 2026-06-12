import { Planner, PlannerDecision, PlannerInput } from "../core/types.js";

interface OpenAiCompatibleChatPlannerOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  name?: string;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function extractChatText(payload: any): string {
  const message = payload?.choices?.[0]?.message?.content;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
  }
  return "";
}

function parseDecision(text: string): PlannerDecision {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonText = fenced ? fenced[1] : trimmed;
  const parsed = JSON.parse(jsonText) as PlannerDecision;
  if (!["respond", "call_tool", "finish"].includes(parsed.action)) {
    throw new Error(`Planner returned invalid action: ${String(parsed.action)}`);
  }
  if (parsed.action === "call_tool" && !parsed.toolName) {
    throw new Error("Planner requested a tool call without toolName.");
  }
  return parsed;
}

export class OpenAiCompatibleChatPlanner implements Planner {
  readonly name: string;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAiCompatibleChatPlannerOptions) {
    this.name = options.name || "openai-compatible-chat-planner";
    this.baseUrl = trimSlash(options.baseUrl);
  }

  async decide(input: PlannerInput): Promise<PlannerDecision> {
    const toolList = input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      inputSchema: tool.inputSchema
    }));

    const systemPrompt = [
      "You are the planner inside Goatmez Agent OS.",
      "Choose exactly one next action for the runtime.",
      "Return ONLY valid JSON with this shape:",
      '{"action":"respond|call_tool|finish","thought":"brief operator note","message":"text for respond/finish","toolName":"tool.name for call_tool","input":{}}',
      "Never invent tool results. If a tool is needed, call one tool at a time.",
      "Use only tools listed in AVAILABLE_TOOLS.",
      "For file writes, patching, scaffolding, shell commands, external sends, deletes, or irreversible work, use tool calls and let the permission gateway approve or block.",
      "When building software, prefer repo.scan first, then file reads/searches, then patch/write/scaffold tools, then shell/build tools."
    ].join("\n");

    const userPrompt = JSON.stringify({
      agent: input.agent,
      step: input.step,
      userTask: input.request.message,
      cwd: input.request.cwd,
      compiledContext: input.context.text,
      AVAILABLE_TOOLS: toolList,
      previousObservations: input.observations
    }, null, 2);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.agent.defaultModel || this.options.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Local/open-compatible planner request failed (${response.status}): ${errorText.slice(0, 1000)}`);
    }

    const payload = await response.json();
    const text = extractChatText(payload);
    if (!text) throw new Error("Local/open-compatible planner returned no text output.");
    return parseDecision(text);
  }
}
