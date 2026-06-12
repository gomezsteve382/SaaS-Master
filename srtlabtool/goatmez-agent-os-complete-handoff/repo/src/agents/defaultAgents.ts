import { AgentProfile } from "../core/types.js";

const defaultModel = process.env.GOATMEZ_LOCAL_MODEL || process.env.GOATMEZ_MODEL || "llama3.1";

export const defaultAgents: AgentProfile[] = [
  {
    id: "operator",
    name: "Operator",
    mission: "Execute technical tasks carefully, explain what changed, and request approval before risky actions.",
    defaultModel,
    permissionMode: "approval_required",
    enabledTools: ["workspace.list", "file.read", "kb.*", "vault.status", "vault.check", "connector.*", "file.write", "shell.run", "vault.*", "mcp.*"],
    memoryScopes: ["user", "workspace", "agent:operator"],
    maxSteps: 8
  },
  {
    id: "developer",
    name: "Developer Agent",
    mission: "Plan, scaffold, edit, test, debug, and package software inside the approved workspace with approval-gated writes and shell commands.",
    defaultModel,
    permissionMode: "approval_required",
    enabledTools: ["workspace.list", "repo.scan", "code.search", "file.read", "kb.*", "file.write", "file.patch", "project.scaffold", "shell.run", "vault.status", "vault.check", "connector.*", "mcp.*"],
    memoryScopes: ["user", "workspace", "agent:developer"],
    maxSteps: 12
  },
  {
    id: "credit_plug",
    name: "Credit Plug",
    mission: "Analyze credit repair workflows, draft compliant outputs, and never send or file anything without approval.",
    defaultModel,
    permissionMode: "draft_only",
    enabledTools: ["workspace.list", "file.read", "kb.*", "vault.status", "vault.check", "connector.list", "connector.health"],
    memoryScopes: ["user", "workspace", "agent:credit_plug"],
    maxSteps: 6
  },
  {
    id: "empire_architect",
    name: "Empire Architect",
    mission: "Turn ideas into execution plans, task lists, and accountability loops.",
    defaultModel,
    permissionMode: "read_only",
    enabledTools: ["workspace.list", "file.read", "kb.*", "vault.status", "vault.check", "connector.list", "connector.health"],
    memoryScopes: ["user", "workspace", "agent:empire_architect"],
    maxSteps: 5
  }
];

export function agentMap(): Map<string, AgentProfile> {
  return new Map(defaultAgents.map((agent) => [agent.id, agent]));
}
