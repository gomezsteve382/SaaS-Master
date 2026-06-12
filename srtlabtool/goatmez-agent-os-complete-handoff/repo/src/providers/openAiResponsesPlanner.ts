import { Planner, PlannerDecision, PlannerInput } from "../core/types.js";

interface OpenAiPlannerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

function extractOutputText(payload: any): string {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const chunks: string[] = [];
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
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

export class OpenAiResponsesPlanner implements Planner {
  readonly name = "openai-responses-json-planner";
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAiPlannerOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  }

  async decide(input: PlannerInput): Promise<PlannerDecision> {
    const toolList = input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      inputSchema: tool.inputSchema
    }));

    const developerPrompt = [
      "You are the planner inside Goatmez Agent OS.",
      "Choose exactly one next action for the runtime.",
      "Return ONLY valid JSON with this shape:",
      '{"action":"respond|call_tool|finish","thought":"brief private operator note","message":"text for respond/finish","toolName":"tool.name for call_tool","input":{}}',
      "Never invent tool results. If a tool is needed, call one tool at a time.",
      "Use only tools listed in AVAILABLE_TOOLS.",
      "For file writes, shell commands, external sends, deletes, or irreversible work, prefer tool calls and let the permission gateway block/approve."
    ].join("\n");

    const userPrompt = JSON.stringify({
      agent: input.agent,
      step: input.step,
      userTask: input.request.message,
      cwd: input.request.cwd,
      compiledContext: input.context.text,
      availableTools: toolList,
      previousObservations: input.observations
    }, null, 2);

    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.agent.defaultModel || this.options.model,
        input: [
          { role: "developer", content: developerPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI planner request failed (${response.status}): ${errorText.slice(0, 1000)}`);
    }

    const payload = await response.json();
    const text = extractOutputText(payload);
    if (!text) throw new Error("OpenAI planner returned no text output.");
    return parseDecision(text);
  }
}
