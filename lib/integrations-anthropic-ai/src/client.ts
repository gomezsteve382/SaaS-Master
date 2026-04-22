import Anthropic from "@anthropic-ai/sdk";

let _instance: Anthropic | null = null;

function getInstance(): Anthropic {
  if (_instance) return _instance;

  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
    throw new Error(
      "AI_INTEGRATIONS_ANTHROPIC_BASE_URL must be set. Did you forget to provision the Anthropic AI integration?",
    );
  }
  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
    throw new Error(
      "AI_INTEGRATIONS_ANTHROPIC_API_KEY must be set. Did you forget to provision the Anthropic AI integration?",
    );
  }

  _instance = new Anthropic({
    apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  });
  return _instance;
}

/* Proxy defers initialization until first property access.
 * This allows the API server to boot without Anthropic env vars;
 * individual route handlers will return 503 if vars are absent. */
export const anthropic = new Proxy({} as Anthropic, {
  get(_target, prop) {
    return (getInstance() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
