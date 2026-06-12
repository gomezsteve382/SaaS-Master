import { readFile } from "node:fs/promises";
import { JsonObject, ToolDefinition } from "./types.js";
import { CredentialVault } from "../security/credentialVault.js";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  riskLevel?: "low" | "medium" | "high" | "critical";
  requiresApproval?: boolean;
}

export interface McpDiscoveredTool {
  serverId: string;
  name: string;
  runtimeName: string;
  description: string;
  inputSchema: JsonObject;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiresApproval: boolean;
}

type ConnectedServer = {
  config: McpServerConfig;
  client: any;
  transport: any;
};

async function dynamicImport(specifier: string): Promise<any> {
  const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  return importer(specifier);
}

async function loadMcpSdk(): Promise<any> {
  try {
    const clientModule = await dynamicImport("@modelcontextprotocol/sdk/client/index.js");
    const stdioModule = await dynamicImport("@modelcontextprotocol/sdk/client/stdio.js");
    return { version: "v1", clientModule, stdioModule };
  } catch {
    try {
      const clientModule = await dynamicImport("@modelcontextprotocol/client");
      const stdioModule = await dynamicImport("@modelcontextprotocol/client/stdio");
      return { version: "v2", clientModule, stdioModule };
    } catch {
      throw new Error(
        "MCP SDK is not installed. Run `npm install @modelcontextprotocol/sdk zod` or use fallback mode without MCP servers."
      );
    }
  }
}

function makeRuntimeToolName(serverId: string, toolName: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp.${safeServer}.${safeTool}`;
}

function sanitizeSchema(schema: unknown): JsonObject {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) return schema as JsonObject;
  return { type: "object", additionalProperties: true };
}

export class McpConnectorMesh {
  constructor(private readonly vault?: CredentialVault) {}

  private readonly servers = new Map<string, McpServerConfig>();
  private readonly connected = new Map<string, ConnectedServer>();
  private discovered: McpDiscoveredTool[] = [];

  registerServer(config: McpServerConfig): void {
    this.servers.set(config.id, config);
  }

  static async fromConfigFile(path: string, vault?: CredentialVault): Promise<McpConnectorMesh> {
    const mesh = new McpConnectorMesh(vault);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as McpServerConfig[];
      for (const server of parsed) mesh.registerServer(server);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    return mesh;
  }

  listServers(): McpServerConfig[] {
    return [...this.servers.values()].map((server) => ({
      ...server,
      url: server.url && server.url.includes("vault:") ? server.url.replace(/vault:[A-Za-z0-9_.:-]+|\$\{vault:[^}]+\}/g, "${vault:****}") : server.url,
      args: server.args?.map((arg) => arg.includes("vault:") ? arg.replace(/vault:[A-Za-z0-9_.:-]+|\$\{vault:[^}]+\}/g, "${vault:****}") : arg),
      env: this.vault?.redactEnv(server.env) ?? server.env
    }));
  }

  private resolveServerConfig(config: McpServerConfig): McpServerConfig {
    if (!this.vault) return config;
    return {
      ...config,
      command: config.command ? this.vault.resolveTemplate(config.command, config.id) : config.command,
      args: config.args?.map((arg) => this.vault!.resolveTemplate(arg, config.id)),
      url: config.url ? this.vault.resolveTemplate(config.url, config.id) : config.url,
      env: this.vault.resolveEnv(config.env, config.id)
    };
  }

  async connectEnabled(): Promise<void> {
    const enabledServers = [...this.servers.values()].filter((server) => server.enabled);
    if (enabledServers.length === 0) return;

    const sdk = await loadMcpSdk();
    const { Client } = sdk.clientModule;

    for (const rawConfig of enabledServers) {
      const config = this.resolveServerConfig(rawConfig);
      if (this.connected.has(config.id)) continue;
      const client = new Client({ name: "goatmez-agent-os", version: "0.8.0" });
      let transport: any;

      if (config.transport === "stdio") {
        if (!config.command) throw new Error(`MCP server '${config.id}' is missing command.`);
        const { StdioClientTransport } = sdk.stdioModule;
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          env: config.env
        });
      } else {
        if (!config.url) throw new Error(`MCP server '${config.id}' is missing url.`);
        const url = new URL(config.url);
        if (sdk.version === "v1") {
          const httpModule = await dynamicImport("@modelcontextprotocol/sdk/client/streamableHttp.js").catch(() => null);
          const sseModule = await dynamicImport("@modelcontextprotocol/sdk/client/sse.js").catch(() => null);
          if (config.transport === "http" && httpModule?.StreamableHTTPClientTransport) {
            transport = new httpModule.StreamableHTTPClientTransport(url);
          } else if (sseModule?.SSEClientTransport) {
            transport = new sseModule.SSEClientTransport(url);
          } else {
            throw new Error("Could not load MCP HTTP/SSE transport from installed SDK.");
          }
        } else {
          const { StreamableHTTPClientTransport, SSEClientTransport } = sdk.clientModule;
          transport = config.transport === "http" ? new StreamableHTTPClientTransport(url) : new SSEClientTransport(url);
        }
      }

      await client.connect(transport);
      this.connected.set(config.id, { config, client, transport });
    }
  }

  async discoverTools(): Promise<McpDiscoveredTool[]> {
    await this.connectEnabled();
    const discovered: McpDiscoveredTool[] = [];

    for (const { config, client } of this.connected.values()) {
      let cursor: string | undefined;
      do {
        const response = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of response.tools ?? []) {
          discovered.push({
            serverId: config.id,
            name: tool.name,
            runtimeName: makeRuntimeToolName(config.id, tool.name),
            description: tool.description ?? `MCP tool ${tool.name} from ${config.name}`,
            inputSchema: sanitizeSchema(tool.inputSchema),
            riskLevel: config.riskLevel ?? "medium",
            requiresApproval: config.requiresApproval ?? true
          });
        }
        cursor = response.nextCursor;
      } while (cursor);
    }

    this.discovered = discovered;
    return discovered;
  }

  asToolDefinitions(): ToolDefinition[] {
    return this.discovered.map((tool) => ({
      name: tool.runtimeName,
      description: `[MCP:${tool.serverId}] ${tool.description}`,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      inputSchema: tool.inputSchema,
      allowedPermissionModes: ["approval_required", "trusted_operator"],
      validate(input: unknown) {
        if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
        return {};
      },
      execute: async (call) => {
        const connected = this.connected.get(tool.serverId);
        if (!connected) {
          return {
            ok: false,
            toolName: tool.runtimeName,
            callId: call.id,
            summary: "MCP server is not connected.",
            error: `Server '${tool.serverId}' is not connected.`,
            audit: { serverId: tool.serverId, mcpToolName: tool.name }
          };
        }

        const result = await connected.client.callTool({ name: tool.name, arguments: call.input });
        return {
          ok: true,
          toolName: tool.runtimeName,
          callId: call.id,
          output: result,
          summary: `Called MCP tool ${tool.name} on server ${tool.serverId}.`,
          audit: { serverId: tool.serverId, mcpToolName: tool.name }
        };
      }
    }));
  }

  async close(): Promise<void> {
    for (const { client, transport } of this.connected.values()) {
      try {
        if (typeof transport?.terminateSession === "function") await transport.terminateSession();
      } catch {
        // Best effort termination.
      }
      try {
        await client.close();
      } catch {
        // Best effort close.
      }
    }
    this.connected.clear();
  }
}
