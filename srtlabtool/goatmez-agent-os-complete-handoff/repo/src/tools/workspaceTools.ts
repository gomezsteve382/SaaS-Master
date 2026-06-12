import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ToolDefinition } from "../core/types.js";

const ListInput = z.object({
  cwd: z.string().default("."),
  depth: z.number().int().min(0).max(5).default(2)
});

type ListInput = z.infer<typeof ListInput>;

async function walk(root: string, depth: number, currentDepth = 0): Promise<string[]> {
  if (currentDepth > depth) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", "build", ".goatmez"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    const info = await stat(path);
    result.push(`${entry.isDirectory() ? "dir" : "file"}: ${path} (${info.size} bytes)`);
    if (entry.isDirectory()) {
      result.push(...(await walk(path, depth, currentDepth + 1)));
    }
  }
  return result.slice(0, 200);
}

export const workspaceListTool: ToolDefinition<ListInput, { root: string; entries: string[] }> = {
  name: "workspace.list",
  description: "List files and folders inside the current workspace with safe defaults.",
  riskLevel: "low",
  requiresApproval: false,
  allowedPermissionModes: ["read_only", "approval_required", "workspace_write", "trusted_operator"],
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Workspace directory to inspect." },
      depth: { type: "number", description: "Directory depth from 0 to 5." }
    },
    required: []
  },
  validate(input: unknown): ListInput {
    return ListInput.parse(input);
  },
  async execute(call) {
    const root = resolve(call.input.cwd);
    const entries = await walk(root, call.input.depth);
    return {
      ok: true,
      toolName: "workspace.list",
      callId: call.id,
      output: { root, entries },
      summary: `Listed ${entries.length} workspace entries from ${root}.`,
      audit: { root, depth: call.input.depth }
    };
  }
};
