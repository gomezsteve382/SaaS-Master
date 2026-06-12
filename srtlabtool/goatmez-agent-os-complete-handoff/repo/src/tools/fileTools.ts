import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ToolDefinition } from "../core/types.js";

const ReadInput = z.object({ path: z.string(), maxBytes: z.number().int().min(1).max(200000).default(50000) });
const WriteInput = z.object({ path: z.string(), content: z.string(), overwrite: z.boolean().default(false) });

type ReadInput = z.infer<typeof ReadInput>;
type WriteInput = z.infer<typeof WriteInput>;

function assertInsideWorkspace(path: string, cwd: string): string {
  const full = resolve(cwd, path);
  const root = resolve(cwd);
  if (!full.startsWith(root)) throw new Error("Path escapes the approved workspace root.");
  return full;
}

export function createFileReadTool(cwd: string): ToolDefinition<ReadInput, { path: string; content: string; truncated: boolean }> {
  return {
    name: "file.read",
    description: "Read a text file from the approved workspace.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: ["read_only", "approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root." },
        maxBytes: { type: "number", description: "Maximum bytes to read." }
      },
      required: ["path"]
    },
    validate(input) { return ReadInput.parse(input); },
    async execute(call) {
      const path = assertInsideWorkspace(call.input.path, cwd);
      const buffer = await readFile(path);
      const truncated = buffer.byteLength > call.input.maxBytes;
      const content = buffer.subarray(0, call.input.maxBytes).toString("utf8");
      return {
        ok: true,
        toolName: "file.read",
        callId: call.id,
        output: { path, content, truncated },
        summary: `Read ${content.length} characters from ${path}${truncated ? " with truncation" : ""}.`,
        audit: { path, maxBytes: call.input.maxBytes, truncated }
      };
    }
  };
}

export function createFileWriteTool(cwd: string): ToolDefinition<WriteInput, { path: string; bytes: number }> {
  return {
    name: "file.write",
    description: "Write a file inside the approved workspace. This is gated by permission mode.",
    riskLevel: "high",
    requiresApproval: true,
    allowedPermissionModes: ["approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root." },
        content: { type: "string", description: "Full UTF-8 file content to write." },
        overwrite: { type: "boolean", description: "Whether to overwrite an existing file." }
      },
      required: ["path", "content"]
    },
    validate(input) { return WriteInput.parse(input); },
    async execute(call) {
      const path = assertInsideWorkspace(call.input.path, cwd);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, call.input.content, { encoding: "utf8", flag: call.input.overwrite ? "w" : "wx" });
      return {
        ok: true,
        toolName: "file.write",
        callId: call.id,
        output: { path, bytes: Buffer.byteLength(call.input.content) },
        summary: `Wrote ${Buffer.byteLength(call.input.content)} bytes to ${path}.`,
        audit: { path, overwrite: call.input.overwrite }
      };
    }
  };
}
