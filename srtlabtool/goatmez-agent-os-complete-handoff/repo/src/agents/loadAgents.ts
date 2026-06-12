import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AgentProfile } from "../core/types.js";
import { defaultAgents } from "./defaultAgents.js";

const permissionModes = ["locked_down", "read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"] as const;

const agentSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_.:-]+$/),
  name: z.string().min(1),
  mission: z.string().min(1),
  defaultModel: z.string().min(1).optional(),
  permissionMode: z.enum(permissionModes),
  enabledTools: z.array(z.string()).default([]),
  memoryScopes: z.array(z.string()).default(["user", "workspace"]),
  maxSteps: z.number().int().min(1).max(30).default(6)
});

const agentsFileSchema = z.object({
  agents: z.array(agentSchema).min(1)
});

export async function loadAgentProfiles(cwd: string): Promise<AgentProfile[]> {
  const path = process.env.GOATMEZ_AGENTS_CONFIG || join(cwd, "config/agents.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = agentsFileSchema.parse(JSON.parse(raw));
    const fallbackModel = process.env.GOATMEZ_MODEL || "gpt-4.1-mini";
    return parsed.agents.map((agent) => ({
      ...agent,
      defaultModel: agent.defaultModel || fallbackModel
    }));
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn(`Agent config warning: ${error instanceof Error ? error.message : String(error)}`);
    }
    return defaultAgents;
  }
}

export function toAgentMap(agents: AgentProfile[]): Map<string, AgentProfile> {
  return new Map(agents.map((agent) => [agent.id, agent]));
}
