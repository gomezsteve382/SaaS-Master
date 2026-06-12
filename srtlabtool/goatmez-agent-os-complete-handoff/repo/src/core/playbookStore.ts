import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WorkflowTemplate } from "./types.js";

const stepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  agentId: z.string().min(1),
  message: z.string().min(1),
  stopOnBlocked: z.boolean().optional()
});

const playbookSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  inputs: z.array(z.string()).optional(),
  steps: z.array(stepSchema).min(1)
});

const fileSchema = z.object({
  playbooks: z.array(playbookSchema).default([])
});

const defaultPlaybooks: WorkflowTemplate[] = [
  {
    id: "workspace_audit",
    name: "Workspace Audit",
    description: "Inspect the workspace and produce a short execution summary.",
    inputs: ["objective"],
    steps: [
      {
        id: "inspect",
        title: "Inspect workspace",
        agentId: "operator",
        message: "inspect this workspace for {{objective}}"
      },
      {
        id: "summary",
        title: "Summarize result",
        agentId: "empire_architect",
        message: "Create a short execution summary from this result: {{previousResult}}"
      }
    ]
  }
];

export class PlaybookStore {
  constructor(private readonly playbooks: WorkflowTemplate[]) {}

  static async fromConfig(cwd: string): Promise<PlaybookStore> {
    const path = process.env.GOATMEZ_PLAYBOOKS_CONFIG || join(cwd, "config/playbooks.json");
    try {
      const raw = await readFile(path, "utf8");
      const parsed = fileSchema.parse(JSON.parse(raw));
      return new PlaybookStore(parsed.playbooks.length ? parsed.playbooks : defaultPlaybooks);
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        console.warn(`Playbook config warning: ${error instanceof Error ? error.message : String(error)}`);
      }
      return new PlaybookStore(defaultPlaybooks);
    }
  }

  list(): WorkflowTemplate[] {
    return this.playbooks;
  }

  get(id: string): WorkflowTemplate | undefined {
    return this.playbooks.find((playbook) => playbook.id === id);
  }
}
