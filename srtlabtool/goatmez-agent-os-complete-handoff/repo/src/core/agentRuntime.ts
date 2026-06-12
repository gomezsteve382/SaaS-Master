import { AgentProfile, RuntimeRequest, ToolCall, ToolObservation } from "./types.js";
import { ContextCompiler } from "./contextCompiler.js";
import { EventLedger } from "./eventLedger.js";
import { ToolRegistry } from "./toolRegistry.js";
import { TaskEngine } from "./taskEngine.js";
import { makeId } from "./id.js";
import { Planner } from "./types.js";
import { ApprovalStore } from "./approvalStore.js";
import { MissionStore } from "./missionStore.js";

function serializeObservation(observation: ToolObservation): string {
  const lines = [`Tool: ${observation.toolName}`, `OK: ${String(observation.ok)}`, `Summary: ${observation.summary}`];
  if (observation.error) lines.push(`Error: ${observation.error}`);
  if (observation.output !== undefined) lines.push(`Output: ${JSON.stringify(observation.output, null, 2)}`);
  return lines.join("\n");
}

export class AgentRuntime {
  constructor(
    private readonly agents: Map<string, AgentProfile>,
    private readonly contextCompiler: ContextCompiler,
    private readonly tools: ToolRegistry,
    private readonly tasks: TaskEngine,
    private readonly ledger: EventLedger,
    private readonly planner: Planner,
    private readonly approvals?: ApprovalStore,
    private readonly missions?: MissionStore
  ) {}

  async run(request: RuntimeRequest): Promise<string> {
    const agent = this.agents.get(request.agentId);
    if (!agent) throw new Error(`Unknown agent: ${request.agentId}`);

    const mission = this.missions?.create({
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      agentId: agent.id,
      message: request.message,
      planner: this.planner.name
    });

    const task = this.tasks.create({ title: request.message, agentId: agent.id, workspaceId: request.workspaceId });
    this.missions?.update(mission!.id, { taskId: task.id });
    this.tasks.update(task.id, { status: "running", note: `Planner: ${this.planner.name}` });

    await this.ledger.record({
      type: "mission.started",
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      agentId: agent.id,
      payload: { missionId: mission?.id, message: request.message, planner: this.planner.name }
    });

    await this.ledger.record({
      type: "task.created",
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      agentId: agent.id,
      payload: { taskId: task.id, title: task.title, planner: this.planner.name, missionId: mission?.id }
    });

    const observations: ToolObservation[] = [];
    let finalMessage = "";

    try {
      for (let step = 1; step <= agent.maxSteps; step++) {
        const descriptors = this.tools.descriptorsFor(agent);
        const context = this.contextCompiler.compile(agent, request, descriptors.map((tool) => tool.name));

        await this.ledger.record({
          type: "context.compiled",
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          agentId: agent.id,
          payload: {
            missionId: mission?.id,
            step,
            estimatedTokens: context.estimatedTokens,
            blocks: context.blocks.map((block) => block.id),
            tools: descriptors.map((tool) => tool.name),
            observations: observations.length
          }
        });

        const decision = await this.planner.decide({ agent, context, request, tools: descriptors, observations, step });

        await this.ledger.record({
          type: "planner.decision",
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          agentId: agent.id,
          payload: { missionId: mission?.id, step, action: decision.action, toolName: decision.toolName, thought: decision.thought }
        });

        if (decision.action === "respond" || decision.action === "finish") {
          finalMessage = decision.message ?? "Mission complete.";
          this.tasks.update(task.id, { status: "done", note: finalMessage.slice(0, 500) });
          this.missions?.update(mission!.id, { status: "done", result: finalMessage });
          await this.ledger.record({
            type: "mission.completed",
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            agentId: agent.id,
            payload: { missionId: mission?.id, result: finalMessage.slice(0, 1000) }
          });
          return finalMessage;
        }

        if (decision.action !== "call_tool" || !decision.toolName) {
          finalMessage = `Planner returned an unusable decision at step ${step}.`;
          this.tasks.update(task.id, { status: "failed", note: finalMessage });
          this.missions?.update(mission!.id, { status: "failed", error: finalMessage });
          return finalMessage;
        }

        const call: ToolCall = {
          id: makeId("call"),
          toolName: decision.toolName,
          input: decision.input ?? {},
          requestedBy: agent.id,
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          approved: request.approveAll === true
        };

        await this.ledger.record({
          type: "tool.requested",
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          agentId: agent.id,
          toolCallId: call.id,
          payload: { missionId: mission?.id, step, toolName: call.toolName, approved: call.approved, input: call.input }
        });

        if (request.dryRun) {
          const observation: ToolObservation = {
            toolName: call.toolName,
            ok: false,
            summary: "Dry run: tool call was planned but not executed.",
            output: { plannedInput: call.input }
          };
          observations.push(observation);
          this.tasks.update(task.id, { status: "blocked", note: observation.summary });
          finalMessage = ["Dry run planned tool call:", serializeObservation(observation)].join("\n\n");
          this.missions?.update(mission!.id, { status: "blocked", result: finalMessage });
          return finalMessage;
        }

        const result = await this.tools.execute(agent, call);

        await this.ledger.record({
          type: result.ok ? "tool.executed" : result.summary.includes("Approval required") ? "tool.approval_required" : "tool.blocked",
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          agentId: agent.id,
          toolCallId: call.id,
          payload: { missionId: mission?.id, step, summary: result.summary, error: result.error, audit: result.audit }
        });

        const observation: ToolObservation = {
          toolName: result.toolName,
          ok: result.ok,
          summary: result.summary,
          output: result.output,
          error: result.error
        };
        observations.push(observation);

        if (!result.ok && result.summary.includes("Approval required")) {
          const approval = this.approvals
            ? await this.approvals.create({
                workspaceId: request.workspaceId,
                sessionId: request.sessionId,
                agentId: agent.id,
                toolCallId: call.id,
                toolName: call.toolName,
                input: call.input,
                reason: result.error ?? result.summary
              })
            : undefined;
          const message = [
            "Approval required before I run this tool.",
            "",
            serializeObservation(observation),
            "",
            approval ? `Approval ID: ${approval.id}` : undefined,
            "Review the requested action in the dashboard, then approve only if it looks right."
          ].filter(Boolean).join("\n");
          this.tasks.update(task.id, { status: "blocked", note: message.slice(0, 500) });
          this.missions?.update(mission!.id, { status: "blocked", result: message });
          return message;
        }
      }

      finalMessage = [
        `Stopped after ${agent.maxSteps} steps.`,
        "Observations gathered:",
        ...observations.map(serializeObservation)
      ].join("\n\n");
      this.tasks.update(task.id, { status: "done", note: finalMessage.slice(0, 500) });
      this.missions?.update(mission!.id, { status: "done", result: finalMessage });
      return finalMessage;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.tasks.update(task.id, { status: "failed", note: message });
      this.missions?.update(mission!.id, { status: "failed", error: message });
      await this.ledger.record({
        type: "mission.failed",
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        agentId: agent.id,
        payload: { missionId: mission?.id, error: message }
      });
      throw error;
    }
  }
}
