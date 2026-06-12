export type RiskLevel = "low" | "medium" | "high" | "critical";

export type PermissionMode =
  | "locked_down"
  | "read_only"
  | "draft_only"
  | "approval_required"
  | "workspace_write"
  | "trusted_operator";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface AgentProfile {
  id: string;
  name: string;
  mission: string;
  defaultModel: string;
  permissionMode: PermissionMode;
  enabledTools: string[];
  memoryScopes: string[];
  maxSteps: number;
}

export interface RuntimeRequest {
  workspaceId: string;
  sessionId: string;
  agentId: string;
  message: string;
  cwd: string;
  approveAll?: boolean;
  dryRun?: boolean;
}

export interface ContextBlock {
  id: string;
  priority: number;
  content: string;
  tokenEstimate: number;
}

export interface CompiledContext {
  blocks: ContextBlock[];
  text: string;
  estimatedTokens: number;
  warnings: string[];
}

export interface ToolCall<Input = unknown> {
  id: string;
  toolName: string;
  input: Input;
  requestedBy: string;
  workspaceId: string;
  sessionId: string;
  approved?: boolean;
}

export interface ToolResult<Output = unknown> {
  ok: boolean;
  toolName: string;
  callId: string;
  output?: Output;
  error?: string;
  summary: string;
  audit: Record<string, unknown>;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  allowedPermissionModes: PermissionMode[];
  inputSchema?: JsonObject;
  validate(input: unknown): Input;
  execute(call: ToolCall<Input>): Promise<ToolResult<Output>>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  inputSchema: JsonObject;
}

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  riskLevel: RiskLevel;
}

export interface AgentEvent {
  id: string;
  type: string;
  timestamp: string;
  workspaceId: string;
  sessionId: string;
  agentId?: string;
  toolCallId?: string;
  payload: Record<string, unknown>;
}

export interface MemoryRecord {
  id: string;
  scope: string;
  content: string;
  importance: number;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: "queued" | "running" | "blocked" | "done" | "failed";
  agentId: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  notes: string[];
}

export interface MissionRecord {
  id: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  message: string;
  status: "running" | "blocked" | "done" | "failed";
  planner: string;
  taskId?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executing" | "executed" | "failed";

export interface ApprovalExecutionResult {
  ok: boolean;
  summary: string;
  output?: unknown;
  error?: string;
  executedAt: string;
}

export interface ApprovalRecord {
  id: string;
  status: ApprovalStatus;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  reason: string;
  createdAt: string;
  updatedAt: string;
  decisionNote?: string;
  execution?: ApprovalExecutionResult;
}



export type ConnectorActionStatus = "prepared" | "running" | "executed" | "failed" | "replayed" | "blocked";

export interface ConnectorActionRecord {
  id: string;
  connectorId: string;
  action: string;
  agentId: string;
  workspaceId: string;
  sessionId: string;
  status: ConnectorActionStatus;
  dryRun: boolean;
  request: unknown;
  response?: unknown;
  idempotencyKey?: string;
  replayOf?: string;
  replayedBy?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type ScheduledMissionStatus = "idle" | "running" | "disabled" | "failed";

export interface ScheduledMissionRecord {
  id: string;
  title: string;
  workspaceId: string;
  agentId: string;
  message: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string;
  lastRunAt?: string;
  lastMissionId?: string;
  lastResult?: string;
  lastError?: string;
  status: ScheduledMissionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepTemplate {
  id: string;
  title: string;
  agentId: string;
  message: string;
  stopOnBlocked?: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  inputs?: string[];
  steps: WorkflowStepTemplate[];
}

export type WorkflowRunStatus = "running" | "blocked" | "done" | "failed";

export interface WorkflowStepRun {
  stepId: string;
  title: string;
  agentId: string;
  message: string;
  status: WorkflowRunStatus;
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface WorkflowRunRecord {
  id: string;
  playbookId: string;
  playbookName: string;
  workspaceId: string;
  status: WorkflowRunStatus;
  inputs: Record<string, string>;
  steps: WorkflowStepRun[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type PlannerAction = "respond" | "call_tool" | "finish";

export interface PlannerDecision {
  action: PlannerAction;
  thought?: string;
  message?: string;
  toolName?: string;
  input?: JsonObject;
}

export interface ToolObservation {
  toolName: string;
  ok: boolean;
  summary: string;
  output?: unknown;
  error?: string;
}

export interface PlannerInput {
  agent: AgentProfile;
  context: CompiledContext;
  request: RuntimeRequest;
  tools: ToolDescriptor[];
  observations: ToolObservation[];
  step: number;
}

export interface Planner {
  readonly name: string;
  decide(input: PlannerInput): Promise<PlannerDecision>;
}
