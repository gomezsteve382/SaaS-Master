import { ApprovalRecord, ConnectorActionRecord, MemoryRecord, MissionRecord, ScheduledMissionRecord, TaskRecord, WorkflowRunRecord } from "./types.js";
import { DatabaseAdapter, GoatmezDatabaseShape } from "../storage/databaseAdapter.js";
import { JsonDatabaseAdapter } from "../storage/jsonDatabaseAdapter.js";

function byNewest<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export class LocalDatabase {
  constructor(private readonly adapter: DatabaseAdapter = new JsonDatabaseAdapter(process.env.GOATMEZ_DB_PATH || ".goatmez/database.json")) {}

  get driverName(): string {
    return this.adapter.name;
  }

  read(): GoatmezDatabaseShape {
    return this.adapter.read();
  }

  write(next: GoatmezDatabaseShape): void {
    this.adapter.write(next);
  }

  mutate(mutator: (db: GoatmezDatabaseShape) => GoatmezDatabaseShape | void): GoatmezDatabaseShape {
    const db = this.read();
    const maybeNext = mutator(db);
    const next = maybeNext ?? db;
    this.write(next);
    return next;
  }

  listTasks(): TaskRecord[] {
    return byNewest(this.read().tasks);
  }

  upsertTask(task: TaskRecord): void {
    this.mutate((db) => {
      db.tasks = [task, ...db.tasks.filter((item) => item.id !== task.id)];
    });
  }

  listMemories(): MemoryRecord[] {
    return byNewest(this.read().memories);
  }

  upsertMemory(memory: MemoryRecord): void {
    this.mutate((db) => {
      db.memories = [memory, ...db.memories.filter((item) => item.id !== memory.id)];
    });
  }

  listApprovals(): ApprovalRecord[] {
    return byNewest(this.read().approvals);
  }

  upsertApproval(approval: ApprovalRecord): void {
    this.mutate((db) => {
      db.approvals = [approval, ...db.approvals.filter((item) => item.id !== approval.id)];
    });
  }

  listMissions(): MissionRecord[] {
    return byNewest(this.read().missions);
  }

  upsertMission(mission: MissionRecord): void {
    this.mutate((db) => {
      db.missions = [mission, ...db.missions.filter((item) => item.id !== mission.id)];
    });
  }

  listScheduledMissions(): ScheduledMissionRecord[] {
    return byNewest(this.read().scheduledMissions);
  }

  upsertScheduledMission(schedule: ScheduledMissionRecord): void {
    this.mutate((db) => {
      db.scheduledMissions = [schedule, ...db.scheduledMissions.filter((item) => item.id !== schedule.id)];
    });
  }

  deleteScheduledMission(id: string): boolean {
    let deleted = false;
    this.mutate((db) => {
      const before = db.scheduledMissions.length;
      db.scheduledMissions = db.scheduledMissions.filter((item) => item.id !== id);
      deleted = db.scheduledMissions.length !== before;
    });
    return deleted;
  }

  listWorkflowRuns(): WorkflowRunRecord[] {
    return byNewest(this.read().workflowRuns);
  }

  upsertWorkflowRun(run: WorkflowRunRecord): void {
    this.mutate((db) => {
      db.workflowRuns = [run, ...db.workflowRuns.filter((item) => item.id !== run.id)];
    });
  }


  listConnectorActions(): ConnectorActionRecord[] {
    return byNewest(this.read().connectorActions);
  }

  upsertConnectorAction(action: ConnectorActionRecord): void {
    this.mutate((db) => {
      db.connectorActions = [action, ...db.connectorActions.filter((item) => item.id !== action.id)];
    });
  }
}

