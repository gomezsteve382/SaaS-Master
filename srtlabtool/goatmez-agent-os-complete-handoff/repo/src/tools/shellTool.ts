import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { ToolDefinition } from "../core/types.js";

const execFileAsync = promisify(execFile);

const ShellInput = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  timeoutMs: z.number().int().min(1000).max(60000).default(10000)
});

type ShellInput = z.infer<typeof ShellInput>;

const safeCommands = new Set(["ls", "pwd", "git", "node", "npm", "python", "python3", "bun"]);
const dangerousCommands = new Set(["rm", "sudo", "chmod", "chown", "dd", "mkfs", "shutdown", "reboot"]);

function classify(command: string): "medium" | "critical" {
  if (dangerousCommands.has(command)) return "critical";
  return "medium";
}

export const shellRunTool: ToolDefinition<ShellInput, { stdout: string; stderr: string }> = {
  name: "shell.run",
  description: "Run an approved shell command with timeout and logging.",
  riskLevel: "high",
  requiresApproval: true,
  allowedPermissionModes: ["approval_required", "trusted_operator"],
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Executable name from safe allowlist." },
      args: { type: "array", items: { type: "string" }, description: "Command arguments." },
      cwd: { type: "string", description: "Working directory." },
      timeoutMs: { type: "number", description: "Timeout in milliseconds, 1000-60000." }
    },
    required: ["command"]
  },
  validate(input) { return ShellInput.parse(input); },
  async execute(call) {
    const risk = classify(call.input.command);
    if (risk === "critical") {
      return {
        ok: false,
        toolName: "shell.run",
        callId: call.id,
        summary: "Command blocked by shell safety classifier.",
        error: `Refusing to run critical command: ${call.input.command}`,
        audit: { command: call.input.command, risk }
      };
    }
    if (!safeCommands.has(call.input.command)) {
      return {
        ok: false,
        toolName: "shell.run",
        callId: call.id,
        summary: "Command not on safe command allowlist.",
        error: `Command requires manual policy review: ${call.input.command}`,
        audit: { command: call.input.command, risk }
      };
    }
    const { stdout, stderr } = await execFileAsync(call.input.command, call.input.args, {
      cwd: call.input.cwd,
      timeout: call.input.timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return {
      ok: true,
      toolName: "shell.run",
      callId: call.id,
      output: { stdout, stderr },
      summary: `Executed ${call.input.command} ${call.input.args.join(" ")}`.trim(),
      audit: { command: call.input.command, args: call.input.args, cwd: call.input.cwd }
    };
  }
};
