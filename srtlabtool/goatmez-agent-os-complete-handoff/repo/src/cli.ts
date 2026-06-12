import "dotenv/config";
import { makeId } from "./core/id.js";
import { createSystem } from "./app/createSystem.js";

interface CliOptions {
  message: string;
  agentId: string;
  approveAll: boolean;
  dryRun: boolean;
  mcpConfig: string;
}

function parseArgs(argv: string[]): CliOptions {
  const parts = [...argv];
  let agentId = "operator";
  let approveAll = false;
  let dryRun = false;
  let mcpConfig = "config/mcp.servers.json";
  const messageParts: string[] = [];

  while (parts.length) {
    const part = parts.shift()!;
    if (part === "--agent") agentId = parts.shift() ?? agentId;
    else if (part === "--approve-all") approveAll = true;
    else if (part === "--dry-run") dryRun = true;
    else if (part === "--mcp-config") mcpConfig = parts.shift() ?? mcpConfig;
    else messageParts.push(part);
  }

  return {
    message: messageParts.join(" ") || "inspect this workspace",
    agentId,
    approveAll,
    dryRun,
    mcpConfig
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const system = await createSystem({ mcpConfig: options.mcpConfig });
  try {
    const result = await system.runtime.run({
      workspaceId: "local",
      sessionId: makeId("cli"),
      agentId: options.agentId,
      message: options.message,
      cwd: system.cwd,
      approveAll: options.approveAll,
      dryRun: options.dryRun
    });

    console.log(result);
  } finally {
    await system.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
