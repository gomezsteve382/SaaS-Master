import { AgentProfile, CompiledContext, ContextBlock, RuntimeRequest } from "./types.js";
import { MemoryStore } from "./memoryStore.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextCompiler {
  constructor(private readonly memory: MemoryStore) {}

  compile(agent: AgentProfile, request: RuntimeRequest, toolNames: string[]): CompiledContext {
    const blocks: ContextBlock[] = [];

    const add = (id: string, priority: number, content: string) => {
      blocks.push({ id, priority, content, tokenEstimate: estimateTokens(content) });
    };

    add(
      "runtime_policy",
      100,
      [
        "You are operating inside Goatmez Agent OS.",
        "Use tools only when they help complete the mission.",
        "Respect permission gates and never claim an action completed unless the tool result confirms it.",
        "For risky actions, request approval before execution."
      ].join("\n")
    );

    add("agent_identity", 90, `Agent: ${agent.name}\nMission: ${agent.mission}\nPermission mode: ${agent.permissionMode}`);

    const memories = this.memory.search(agent.memoryScopes, request.message, 6);
    if (memories.length) {
      add("memory", 50, memories.map((m) => `- [${m.scope}] ${m.content}`).join("\n"));
    }

    add("tools", 70, `Enabled tools: ${toolNames.join(", ") || "none"}`);
    add("user_message", 100, `User task: ${request.message}`);

    const ordered = blocks.sort((a, b) => b.priority - a.priority);
    const text = ordered.map((block) => `## ${block.id}\n${block.content}`).join("\n\n");

    return {
      blocks: ordered,
      text,
      estimatedTokens: estimateTokens(text),
      warnings: []
    };
  }
}
