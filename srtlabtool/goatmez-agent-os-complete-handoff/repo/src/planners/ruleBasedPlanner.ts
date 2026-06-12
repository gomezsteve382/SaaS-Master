import { Planner, PlannerDecision, PlannerInput } from "../core/types.js";

function hasObservation(input: PlannerInput, toolName: string): boolean {
  return input.observations.some((observation) => observation.toolName === toolName);
}



function repoScan(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "repo.scan");
  if (!tool || hasObservation(input, "repo.scan")) return undefined;
  if (["scan repo", "inspect repo", "analyze repo", "developer", "build software", "write code", "codebase"].some((phrase) => lower.includes(phrase))) {
    return { action: "call_tool", thought: "The user wants developer-level repo awareness. Scan the workspace first.", toolName: "repo.scan", input: { path: ".", maxFiles: 400, maxDepth: 6 } };
  }
  return undefined;
}

function codeSearch(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "code.search");
  if (!tool || hasObservation(input, "code.search")) return undefined;
  const match = input.request.message.match(/(?:search|find)\s+(?:code\s+)?(?:for\s+)?["'`](.+?)["'`]/i);
  if (match || lower.includes("search code")) {
    return { action: "call_tool", thought: "The user asked to search the codebase.", toolName: "code.search", input: { query: match?.[1] || input.request.message, path: ".", maxFiles: 300, maxMatches: 50 } };
  }
  return undefined;
}

function scaffoldProject(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "project.scaffold");
  if (!tool || hasObservation(input, "project.scaffold")) return undefined;
  if (!(lower.includes("scaffold") || lower.includes("create project") || lower.includes("starter app") || lower.includes("new app"))) return undefined;
  let template: "typescript-cli" | "fastapi-api" | "static-dashboard" = "typescript-cli";
  if (lower.includes("fastapi") || lower.includes("api")) template = "fastapi-api";
  if (lower.includes("dashboard") || lower.includes("landing page") || lower.includes("static")) template = "static-dashboard";
  const explicitName = input.request.message.match(/(?:called|named|name(?:d)?\s+as)\s+([a-zA-Z0-9_.-]+)/i)?.[1];
  const projectName = input.request.message.match(/project\s+([a-zA-Z0-9_.-]+)/i)?.[1];
  const name = explicitName || (projectName && projectName !== "named" ? projectName : undefined) || "generated-app";
  return {
    action: "call_tool",
    thought: "The user asked to create a starter project. The scaffold tool will be approval-gated.",
    toolName: "project.scaffold",
    input: { name, template, targetDir: "generated" }
  };
}

function writeMentionedFile(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "file.write");
  if (!tool || hasObservation(input, "file.write")) return undefined;
  const match = input.request.message.match(/(?:write|create|save)\s+([\s\S]+?)\s+(?:to|as|into)\s+([\w./-]+\.[\w]+)/i);
  if (match && ["write", "create", "save"].some((word) => lower.includes(word))) {
    return {
      action: "call_tool",
      thought: "The user asked to create or write a specific file. The permission gateway will decide if approval is needed.",
      toolName: "file.write",
      input: { path: match[2], content: match[1].trim(), overwrite: false }
    };
  }
  return undefined;
}

function runSimpleShellCommand(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "shell.run");
  if (!tool || hasObservation(input, "shell.run")) return undefined;
  const match = input.request.message.match(/(?:run|execute)\s+`?([a-zA-Z0-9_-]+)([^`]*)`?/i);
  if (match && lower.includes("run")) {
    const args = match[2].trim().split(/\s+/).filter(Boolean);
    return {
      action: "call_tool",
      thought: "The user asked to run a command. The shell tool allowlist and permission gateway will decide if it can execute.",
      toolName: "shell.run",
      input: { command: match[1], args, cwd: input.request.cwd, timeoutMs: 10000 }
    };
  }
  return undefined;
}

function firstWorkspaceList(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "workspace.list");
  if (!tool || hasObservation(input, "workspace.list")) return undefined;
  if (["list", "inspect", "workspace", "files", "folder", "repo"].some((word) => lower.includes(word))) {
    return {
      action: "call_tool",
      thought: "The user wants to inspect the workspace. The safe listing tool is enough for the first step.",
      toolName: "workspace.list",
      input: { cwd: input.request.cwd, depth: 2 }
    };
  }
  return undefined;
}

function readMentionedFile(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "file.read");
  if (!tool || hasObservation(input, "file.read")) return undefined;
  const match = input.request.message.match(/(?:read|open|show)\s+([\w./-]+\.[\w]+)/i);
  if (match && (lower.includes("read") || lower.includes("open") || lower.includes("show"))) {
    return {
      action: "call_tool",
      thought: "The user named a file path and asked to read it.",
      toolName: "file.read",
      input: { path: match[1], maxBytes: 50000 }
    };
  }
  return undefined;
}


function knowledgeSearch(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "kb.search");
  if (!tool || hasObservation(input, "kb.search")) return undefined;
  const match = input.request.message.match(/(?:search|find|look up)\s+(?:knowledge|kb|docs|documents)?\s*(?:for\s+)?["'`](.+?)["'`]/i);
  if (match || lower.includes("knowledge base") || lower.includes("search kb") || lower.includes("search docs")) {
    return {
      action: "call_tool",
      thought: "The user asked to retrieve internal knowledge. Search the local knowledge base first.",
      toolName: "kb.search",
      input: { query: match?.[1] || input.request.message, limit: 8 }
    };
  }
  return undefined;
}

function knowledgeList(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "kb.list");
  if (!tool || hasObservation(input, "kb.list")) return undefined;
  if ((lower.includes("knowledge base") || lower.includes("kb")) && (lower.includes("list") || lower.includes("show") || lower.includes("documents"))) {
    return { action: "call_tool", thought: "The user asked to list knowledge-base documents.", toolName: "kb.list", input: { limit: 25 } };
  }
  return undefined;
}

function knowledgeIngestFile(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "kb.ingestFile");
  if (!tool || hasObservation(input, "kb.ingestFile")) return undefined;
  const match = input.request.message.match(/(?:ingest|index|add)\s+([\w./-]+\.[\w]+)\s+(?:to|into)\s+(?:knowledge|kb|knowledge base)/i);
  if (match || ((lower.includes("ingest") || lower.includes("index")) && (lower.includes("knowledge") || lower.includes("kb")))) {
    return {
      action: "call_tool",
      thought: "The user asked to index a workspace file into the knowledge base.",
      toolName: "kb.ingestFile",
      input: { path: match?.[1] || "README.md", tags: ["workspace"] }
    };
  }
  return undefined;
}

function connectorStatus(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const listTool = input.tools.find((item) => item.name === "connector.list");
  const healthTool = input.tools.find((item) => item.name === "connector.health");
  if (["connector", "connectors", "integration", "integrations"].some((word) => lower.includes(word))) {
    if ((lower.includes("health") || lower.includes("status") || lower.includes("ready")) && healthTool && !hasObservation(input, "connector.health")) {
      return { action: "call_tool", thought: "The user asked for connector readiness/status.", toolName: "connector.health", input: {} };
    }
    if (listTool && !hasObservation(input, "connector.list")) {
      return { action: "call_tool", thought: "The user asked about configured connectors.", toolName: "connector.list", input: {} };
    }
  }
  return undefined;
}

function openAiConnectorDryRun(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const tool = input.tools.find((item) => item.name === "connector.openai.responses");
  if (!tool || hasObservation(input, "connector.openai.responses")) return undefined;
  if (lower.includes("openai") && (lower.includes("test") || lower.includes("dry") || lower.includes("prompt"))) {
    return { action: "call_tool", thought: "Prepare an OpenAI connector request in dry-run mode.", toolName: "connector.openai.responses", input: { prompt: input.request.message, dryRun: true } };
  }
  return undefined;
}

function vaultStatus(input: PlannerInput): PlannerDecision | undefined {
  const lower = input.request.message.toLowerCase();
  const statusTool = input.tools.find((item) => item.name === "vault.status");
  const listTool = input.tools.find((item) => item.name === "vault.list");
  if ((lower.includes("list secrets") || lower.includes("show secrets")) && listTool && !hasObservation(input, "vault.list")) {
    return {
      action: "call_tool",
      thought: "The user asked to list secrets. Return safe metadata only.",
      toolName: "vault.list",
      input: {}
    };
  }
  if ((lower.includes("vault") || lower.includes("secret") || lower.includes("credential")) && statusTool && !hasObservation(input, "vault.status")) {
    return {
      action: "call_tool",
      thought: "The user asked about credentials or the vault. Check vault status without exposing plaintext.",
      toolName: "vault.status",
      input: {}
    };
  }
  return undefined;
}

export class RuleBasedPlanner implements Planner {
  readonly name = "rule-based-fallback";

  async decide(input: PlannerInput): Promise<PlannerDecision> {
    const scan = repoScan(input);
    if (scan) return scan;

    const search = codeSearch(input);
    if (search) return search;

    const scaffold = scaffoldProject(input);
    if (scaffold) return scaffold;

    const write = writeMentionedFile(input);
    if (write) return write;

    const shell = runSimpleShellCommand(input);
    if (shell) return shell;

    const read = readMentionedFile(input);
    if (read) return read;

    const kbIngest = knowledgeIngestFile(input);
    if (kbIngest) return kbIngest;

    const kbSearch = knowledgeSearch(input);
    if (kbSearch) return kbSearch;

    const kbList = knowledgeList(input);
    if (kbList) return kbList;

    const connector = connectorStatus(input);
    if (connector) return connector;

    const openai = openAiConnectorDryRun(input);
    if (openai) return openai;

    const vault = vaultStatus(input);
    if (vault) return vault;

    const list = firstWorkspaceList(input);
    if (list) return list;

    if (input.observations.length) {
      const lines = input.observations.map((observation) => {
        const payload = observation.ok ? JSON.stringify(observation.output, null, 2) : observation.error;
        return `Tool ${observation.toolName}: ${observation.summary}\n${payload ?? ""}`;
      });
      return {
        action: "finish",
        thought: "The fallback planner has enough observations to summarize.",
        message: [`Mission result:`, ...lines].join("\n\n")
      };
    }

    return {
      action: "finish",
      thought: "No tool rule matched, so answer directly.",
      message: [
        `Agent ${input.agent.name} received the mission.`,
        "No automatic tool action matched in fallback mode.",
        "Set GOATMEZ_LLM_BASE_URL for a local model, OPENAI_API_KEY for cloud fallback, or add more rules in src/planners/ruleBasedPlanner.ts."
      ].join("\n")
    };
  }
}
