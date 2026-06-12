import { AgentProfile } from "./types.js";
import { ApprovalStore } from "./approvalStore.js";
import { ApprovalRecord } from "./types.js";
import { EventLedger } from "./eventLedger.js";
import { ToolRegistry } from "./toolRegistry.js";

export interface ApprovalExecutionDependencies {
  agents: Map<string, AgentProfile>;
  tools: ToolRegistry;
  approvals: ApprovalStore;
  ledger: EventLedger;
}

export interface ApprovalExecutionResponse {
  ok: boolean;
  approval: ApprovalRecord;
  result: {
    ok: boolean;
    summary: string;
    output?: unknown;
    error?: string;
  };
}

export async function executeApprovedToolCall(
  deps: ApprovalExecutionDependencies,
  approvalId: string,
  note = "Executed by operator"
): Promise<ApprovalExecutionResponse> {
  const record = await deps.approvals.get(approvalId);
  if (!record) throw new Error(`Approval not found: ${approvalId}`);
  if (record.status !== "approved") {
    throw new Error(`Approval must be approved before execution. Current status: ${record.status}`);
  }

  const agent = deps.agents.get(record.agentId);
  if (!agent) throw new Error(`Agent not found: ${record.agentId}`);

  await deps.approvals.markExecuting(approvalId, note);

  const result = await deps.tools.execute(agent, {
    id: record.toolCallId,
    toolName: record.toolName,
    input: record.input,
    requestedBy: record.agentId,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    approved: true
  });

  await deps.ledger.record({
    type: result.ok ? "approval.executed" : "approval.execution_failed",
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    agentId: record.agentId,
    toolCallId: record.toolCallId,
    payload: {
      approvalId: record.id,
      toolName: record.toolName,
      summary: result.summary,
      error: result.error,
      audit: result.audit
    }
  });

  const approval = await deps.approvals.markExecutionResult(approvalId, {
    ok: result.ok,
    summary: result.summary,
    output: result.output,
    error: result.error,
    executedAt: new Date().toISOString()
  });

  return {
    ok: result.ok,
    approval,
    result: {
      ok: result.ok,
      summary: result.summary,
      output: result.output,
      error: result.error
    }
  };
}
