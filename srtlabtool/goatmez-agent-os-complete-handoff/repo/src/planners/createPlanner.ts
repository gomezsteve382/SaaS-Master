import { Planner } from "../core/types.js";
import { getModelRouterStatus } from "../models/modelRouter.js";
import { OpenAiResponsesPlanner } from "../providers/openAiResponsesPlanner.js";
import { OpenAiCompatibleChatPlanner } from "../providers/openAiCompatibleChatPlanner.js";
import { RuleBasedPlanner } from "./ruleBasedPlanner.js";

export function createPlanner(): Planner {
  const status = getModelRouterStatus();

  if (status.provider === "openai_compatible_chat" && status.baseUrl) {
    return new OpenAiCompatibleChatPlanner({
      baseUrl: status.baseUrl,
      apiKey: process.env.GOATMEZ_LLM_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "local-dev-key",
      model: status.model,
      name: "local-open-compatible-chat-planner"
    });
  }

  if (status.provider === "openai_responses" && process.env.OPENAI_API_KEY) {
    return new OpenAiResponsesPlanner({
      apiKey: process.env.OPENAI_API_KEY,
      model: status.model,
      baseUrl: status.baseUrl
    });
  }

  return new RuleBasedPlanner();
}
