import "dotenv/config";
import { resolve } from "node:path";
import { AgentRuntime } from "../core/agentRuntime.js";
import { ApprovalStore } from "../core/approvalStore.js";
import { ContextCompiler } from "../core/contextCompiler.js";
import { EventLedger } from "../core/eventLedger.js";
import { LocalDatabase } from "../core/localDatabase.js";
import { MemoryStore } from "../core/memoryStore.js";
import { MissionStore } from "../core/missionStore.js";
import { PermissionGateway } from "../core/permissionGateway.js";
import { PlaybookStore } from "../core/playbookStore.js";
import { ScheduleEngine } from "../core/scheduleEngine.js";
import { WorkflowEngine } from "../core/workflowEngine.js";
import { TaskEngine } from "../core/taskEngine.js";
import { ToolRegistry } from "../core/toolRegistry.js";
import { McpConnectorMesh } from "../core/mcpConnectorMesh.js";
import { loadAgentProfiles, toAgentMap } from "../agents/loadAgents.js";
import { createFileReadTool, createFileWriteTool } from "../tools/fileTools.js";
import { shellRunTool } from "../tools/shellTool.js";
import { workspaceListTool } from "../tools/workspaceTools.js";
import { createPlanner } from "../planners/createPlanner.js";
import { createDatabaseAdapter } from "../storage/createDatabaseAdapter.js";
import { CredentialVault } from "../security/credentialVault.js";
import { ConnectorRegistry } from "../connectors/connectorRegistry.js";
import { ConnectorExecutionHub } from "../connectors/connectorExecutor.js";
import { ConnectorActionStore } from "../connectors/connectorActionStore.js";
import { OAuthTokenManager } from "../connectors/oauthTokenManager.js";
import { ProviderAdapters } from "../connectors/providerAdapters.js";
import { ConnectorReplayService } from "../connectors/connectorReplayService.js";
import { ConnectorSetupWizard } from "../connectors/setupWizard.js";
import { createVaultCheckTool, createVaultListTool, createVaultStatusTool } from "../tools/vaultTools.js";
import { createCalendarCreateEventTool, createCalendarDraftTool, createConnectorHealthTool, createConnectorHttpRequestTool, createConnectorListTool, createGhlSearchContactsTool, createGmailCreateDraftTool, createGmailDraftTool, createOAuthRefreshGoogleTokenTool, createOpenAiResponsesConnectorTool, createStripeRetrieveAccountTool, createStripeWebhookTool } from "../tools/connectorTools.js";
import { createCodeSearchTool, createFilePatchTool, createProjectScaffoldTool, createRepoScanTool } from "../tools/developerTools.js";
import { KnowledgeBaseStore } from "../core/knowledgeBaseStore.js";
import { createKnowledgeEmbeddingProvider } from "../core/knowledgeEmbeddings.js";
import { createKnowledgeIngestFileTool, createKnowledgeIngestTextTool, createKnowledgeListTool, createKnowledgeReadTool, createKnowledgeReindexTool, createKnowledgeSearchTool } from "../tools/knowledgeTools.js";

export interface SystemOptions {
  cwd?: string;
  mcpConfig?: string;
}

export interface GoatmezSystem {
  cwd: string;
  agents: ReturnType<typeof toAgentMap>;
  db: LocalDatabase;
  memory: MemoryStore;
  permissions: PermissionGateway;
  tools: ToolRegistry;
  tasks: TaskEngine;
  ledger: EventLedger;
  approvals: ApprovalStore;
  missions: MissionStore;
  schedules: ScheduleEngine;
  playbooks: PlaybookStore;
  workflows: WorkflowEngine;
  vault: CredentialVault;
  connectors: ConnectorRegistry;
  connectorHub: ConnectorExecutionHub;
  connectorActions: ConnectorActionStore;
  oauth: OAuthTokenManager;
  providerAdapters: ProviderAdapters;
  connectorReplay: ConnectorReplayService;
  setupWizard: ConnectorSetupWizard;
  knowledge: KnowledgeBaseStore;
  mesh: McpConnectorMesh;
  runtime: AgentRuntime;
  close(): Promise<void>;
}

export async function createSystem(options: SystemOptions = {}): Promise<GoatmezSystem> {
  const cwd = resolve(options.cwd || process.env.GOATMEZ_WORKSPACE_ROOT || process.cwd());
  const mcpConfig = resolve(cwd, options.mcpConfig || "config/mcp.servers.json");

  const db = new LocalDatabase(createDatabaseAdapter());
  const vault = new CredentialVault();
  const connectors = await ConnectorRegistry.fromConfig(cwd, vault);
  const connectorActions = new ConnectorActionStore(db);
  const connectorHub = new ConnectorExecutionHub({ registry: connectors, vault, actions: connectorActions });
  const oauth = new OAuthTokenManager(vault);
  const providerAdapters = new ProviderAdapters({ registry: connectors, oauth, actions: connectorActions });
  const connectorReplay = new ConnectorReplayService({ actions: connectorActions, hub: connectorHub, adapters: providerAdapters, vault });
  const setupWizard = new ConnectorSetupWizard(connectors, vault);
  const agents = toAgentMap(await loadAgentProfiles(cwd));
  const knowledgeEmbeddings = createKnowledgeEmbeddingProvider(vault);
  const knowledge = new KnowledgeBaseStore(cwd, ".goatmez/knowledge.json", { embeddings: knowledgeEmbeddings });
  const memory = new MemoryStore(db);
  memory.add("user", "Steven prefers direct, strategic build plans with practical execution steps.", 3);
  memory.add("workspace", "Goatmez Agent OS should prioritize agents, MCP connectors, approvals, logs, dashboards, persistent mission history, and scheduled autonomous runs.", 3);

  const permissions = new PermissionGateway();
  const tools = new ToolRegistry(permissions);
  tools.register(workspaceListTool);
  tools.register(createFileReadTool(cwd));
  tools.register(createFileWriteTool(cwd));
  tools.register(createRepoScanTool(cwd));
  tools.register(createCodeSearchTool(cwd));
  tools.register(createFilePatchTool(cwd));
  tools.register(createProjectScaffoldTool(cwd));
  tools.register(createKnowledgeListTool(knowledge));
  tools.register(createKnowledgeReadTool(knowledge));
  tools.register(createKnowledgeSearchTool(knowledge));
  tools.register(createKnowledgeReindexTool(knowledge));
  tools.register(createKnowledgeIngestFileTool(cwd, knowledge));
  tools.register(createKnowledgeIngestTextTool(knowledge));
  tools.register(shellRunTool);
  tools.register(createVaultStatusTool(vault));
  tools.register(createVaultListTool(vault));
  tools.register(createVaultCheckTool(vault));
  tools.register(createConnectorListTool(connectors));
  tools.register(createConnectorHealthTool(connectorHub));
  tools.register(createConnectorHttpRequestTool(connectorHub));
  tools.register(createOpenAiResponsesConnectorTool(connectorHub));
  tools.register(createGhlSearchContactsTool(providerAdapters));
  tools.register(createGmailDraftTool(connectors));
  tools.register(createCalendarDraftTool(connectors));
  tools.register(createStripeWebhookTool(connectors));
  tools.register(createOAuthRefreshGoogleTokenTool(providerAdapters));
  tools.register(createGmailCreateDraftTool(providerAdapters));
  tools.register(createCalendarCreateEventTool(providerAdapters));
  tools.register(createStripeRetrieveAccountTool(providerAdapters, vault));

  const mesh = await McpConnectorMesh.fromConfigFile(mcpConfig, vault);
  try {
    const discovered = await mesh.discoverTools();
    if (discovered.length) tools.registerMany(mesh.asToolDefinitions());
  } catch (error) {
    console.warn(`MCP startup warning: ${error instanceof Error ? error.message : String(error)}`);
  }

  const tasks = new TaskEngine(db);
  const ledger = new EventLedger();
  const approvals = new ApprovalStore(db);
  const missions = new MissionStore(db);
  const planner = createPlanner();
  const runtime = new AgentRuntime(
    agents,
    new ContextCompiler(memory),
    tools,
    tasks,
    ledger,
    planner,
    approvals,
    missions
  );
  const schedules = new ScheduleEngine(db, runtime, cwd);
  const playbooks = await PlaybookStore.fromConfig(cwd);
  const workflows = new WorkflowEngine(db, runtime, cwd);

  return {
    cwd,
    agents,
    db,
    memory,
    permissions,
    tools,
    tasks,
    ledger,
    approvals,
    missions,
    schedules,
    playbooks,
    workflows,
    vault,
    connectors,
    connectorHub,
    connectorActions,
    oauth,
    providerAdapters,
    connectorReplay,
    setupWizard,
    knowledge,
    mesh,
    runtime,
    async close() {
      await mesh.close();
    }
  };
}
