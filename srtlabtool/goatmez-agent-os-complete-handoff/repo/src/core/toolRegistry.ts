import { AgentProfile, JsonObject, ToolCall, ToolDefinition, ToolDescriptor, ToolResult } from "./types.js";
import { PermissionGateway } from "./permissionGateway.js";

const defaultInputSchema: JsonObject = { type: "object", additionalProperties: true };

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly permissions: PermissionGateway) {}

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  availableFor(agent: AgentProfile): string[] {
    const names = new Set<string>();
    for (const enabled of agent.enabledTools) {
      if (enabled.endsWith("*")) {
        const prefix = enabled.slice(0, -1);
        for (const name of this.tools.keys()) {
          if (name.startsWith(prefix)) names.add(name);
        }
      } else if (this.tools.has(enabled)) {
        names.add(enabled);
      }
    }
    return [...names].sort();
  }

  descriptorsFor(agent: AgentProfile): ToolDescriptor[] {
    return this.availableFor(agent).map((name) => {
      const tool = this.get(name);
      return {
        name: tool.name,
        description: tool.description,
        riskLevel: tool.riskLevel,
        requiresApproval: tool.requiresApproval,
        inputSchema: tool.inputSchema ?? defaultInputSchema
      };
    });
  }

  async execute(agent: AgentProfile, call: ToolCall): Promise<ToolResult> {
    const tool = this.get(call.toolName);
    const decision = this.permissions.decide(agent, tool, call);

    if (decision.requiresApproval) {
      return {
        ok: false,
        toolName: tool.name,
        callId: call.id,
        summary: "Approval required before execution.",
        error: decision.reason,
        audit: { decision, input: call.input }
      };
    }

    if (!decision.allowed) {
      return {
        ok: false,
        toolName: tool.name,
        callId: call.id,
        summary: "Tool execution denied.",
        error: decision.reason,
        audit: { decision, input: call.input }
      };
    }

    try {
      const input = tool.validate(call.input);
      return await tool.execute({ ...call, input });
    } catch (error) {
      return {
        ok: false,
        toolName: tool.name,
        callId: call.id,
        summary: "Tool execution failed.",
        error: error instanceof Error ? error.message : String(error),
        audit: { input: call.input }
      };
    }
  }
}
