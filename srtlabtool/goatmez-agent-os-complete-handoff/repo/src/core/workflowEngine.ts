import { AgentRuntime } from "./agentRuntime.js";
import { LocalDatabase } from "./localDatabase.js";
import { WorkflowRunRecord, WorkflowStepRun, WorkflowTemplate } from "./types.js";
import { makeId } from "./id.js";

export interface WorkflowRunInput {
  playbook: WorkflowTemplate;
  workspaceId?: string;
  inputs?: Record<string, string>;
  approveAll?: boolean;
  dryRun?: boolean;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, key: string) => values[key] ?? "");
}

export class WorkflowEngine {
  constructor(private readonly db: LocalDatabase, private readonly runtime: AgentRuntime, private readonly cwd: string) {}

  listRuns(): WorkflowRunRecord[] {
    return this.db.listWorkflowRuns();
  }

  getRun(id: string): WorkflowRunRecord | undefined {
    return this.listRuns().find((run) => run.id === id);
  }

  private save(run: WorkflowRunRecord): WorkflowRunRecord {
    this.db.upsertWorkflowRun(run);
    return run;
  }

  async run(input: WorkflowRunInput): Promise<WorkflowRunRecord> {
    const now = new Date().toISOString();
    const run: WorkflowRunRecord = {
      id: makeId("wf"),
      playbookId: input.playbook.id,
      playbookName: input.playbook.name,
      workspaceId: input.workspaceId || "local",
      status: "running",
      inputs: input.inputs || {},
      steps: [],
      createdAt: now,
      updatedAt: now
    };
    this.save(run);

    let previousResult = "";
    const values: Record<string, string> = { ...run.inputs, previousResult };

    for (const step of input.playbook.steps) {
      values.previousResult = previousResult;
      const message = renderTemplate(step.message, values);
      const stepRun: WorkflowStepRun = {
        stepId: step.id,
        title: step.title,
        agentId: step.agentId,
        message,
        status: "running",
        startedAt: new Date().toISOString()
      };
      run.steps.push(stepRun);
      run.updatedAt = new Date().toISOString();
      this.save(run);

      try {
        const result = await this.runtime.run({
          workspaceId: run.workspaceId,
          sessionId: makeId("wfstep"),
          agentId: step.agentId,
          message,
          cwd: this.cwd,
          approveAll: input.approveAll === true,
          dryRun: input.dryRun === true
        });
        previousResult = result;
        stepRun.result = result;
        stepRun.completedAt = new Date().toISOString();
        stepRun.status = result.includes("Approval required") ? "blocked" : "done";
        run.updatedAt = new Date().toISOString();
        if (stepRun.status === "blocked" && step.stopOnBlocked !== false) {
          run.status = "blocked";
          run.completedAt = new Date().toISOString();
          return this.save(run);
        }
        this.save(run);
      } catch (error) {
        stepRun.error = error instanceof Error ? error.message : String(error);
        stepRun.status = "failed";
        stepRun.completedAt = new Date().toISOString();
        run.status = "failed";
        run.updatedAt = new Date().toISOString();
        run.completedAt = new Date().toISOString();
        return this.save(run);
      }
    }

    run.status = "done";
    run.updatedAt = new Date().toISOString();
    run.completedAt = new Date().toISOString();
    return this.save(run);
  }
}
