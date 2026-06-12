export type ModelProviderKind = "rule" | "openai_responses" | "openai_compatible_chat";

export interface ModelRouterStatus {
  provider: ModelProviderKind;
  model: string;
  baseUrl?: string;
  localFirst: boolean;
  hasApiKey: boolean;
  notes: string[];
}

export function getModelRouterStatus(): ModelRouterStatus {
  const provider = (process.env.GOATMEZ_PLANNER_PROVIDER || "auto").toLowerCase();
  const localBaseUrl = process.env.GOATMEZ_LLM_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL;
  const localModel = process.env.GOATMEZ_LOCAL_MODEL || process.env.GOATMEZ_MODEL || "llama3.1";
  const cloudModel = process.env.GOATMEZ_MODEL || "gpt-4.1-mini";
  const notes: string[] = [];

  if (provider === "rule") {
    notes.push("Rule planner is active. No model endpoint required.");
    return { provider: "rule", model: "rule-based-fallback", localFirst: false, hasApiKey: false, notes };
  }

  if (provider === "local" || (provider === "auto" && localBaseUrl)) {
    notes.push("Local/open-compatible planner is active. Set GOATMEZ_LLM_BASE_URL and GOATMEZ_LOCAL_MODEL for your local server.");
    return {
      provider: "openai_compatible_chat",
      model: localModel,
      baseUrl: localBaseUrl,
      localFirst: true,
      hasApiKey: Boolean(process.env.GOATMEZ_LLM_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY),
      notes
    };
  }

  if (provider === "openai" || (provider === "auto" && process.env.OPENAI_API_KEY)) {
    notes.push("Responses planner is active as a cloud fallback.");
    return {
      provider: "openai_responses",
      model: cloudModel,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      localFirst: false,
      hasApiKey: Boolean(process.env.OPENAI_API_KEY),
      notes
    };
  }

  notes.push("No model endpoint configured. Falling back to deterministic rules.");
  return { provider: "rule", model: "rule-based-fallback", localFirst: false, hasApiKey: false, notes };
}
