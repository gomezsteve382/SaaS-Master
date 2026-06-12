import { AgentProfile, PermissionDecision, ToolDefinition, ToolCall } from "./types.js";

function toolEnabledForAgent(agent: AgentProfile, toolName: string): boolean {
  return agent.enabledTools.some((enabled) => {
    if (enabled === toolName) return true;
    if (enabled.endsWith("*")) return toolName.startsWith(enabled.slice(0, -1));
    return false;
  });
}

export class PermissionGateway {
  decide(agent: AgentProfile, tool: ToolDefinition, call?: ToolCall): PermissionDecision {
    if (!toolEnabledForAgent(agent, tool.name)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Tool '${tool.name}' is not enabled for agent '${agent.id}'.`,
        riskLevel: tool.riskLevel
      };
    }

    if (!tool.allowedPermissionModes.includes(agent.permissionMode)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Tool '${tool.name}' is not allowed in permission mode '${agent.permissionMode}'.`,
        riskLevel: tool.riskLevel
      };
    }

    if (agent.permissionMode === "trusted_operator" && tool.riskLevel !== "critical") {
      return {
        allowed: true,
        requiresApproval: false,
        reason: "Trusted operator mode allows this tool.",
        riskLevel: tool.riskLevel
      };
    }

    if ((tool.requiresApproval || ["high", "critical"].includes(tool.riskLevel)) && !call?.approved) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `Tool '${tool.name}' requires approval because risk is '${tool.riskLevel}'.`,
        riskLevel: tool.riskLevel
      };
    }

    return {
      allowed: true,
      requiresApproval: false,
      reason: call?.approved ? "Tool was manually approved." : "Tool is allowed by policy.",
      riskLevel: tool.riskLevel
    };
  }
}
