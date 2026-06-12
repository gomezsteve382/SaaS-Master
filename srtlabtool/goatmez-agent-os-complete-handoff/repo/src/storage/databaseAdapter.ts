import { ApprovalRecord, ConnectorActionRecord, MemoryRecord, MissionRecord, ScheduledMissionRecord, TaskRecord, WorkflowRunRecord } from "../core/types.js";

export interface GoatmezDatabaseShape {
  version: 4;
  updatedAt: string;
  tasks: TaskRecord[];
  memories: MemoryRecord[];
  approvals: ApprovalRecord[];
  missions: MissionRecord[];
  scheduledMissions: ScheduledMissionRecord[];
  workflowRuns: WorkflowRunRecord[];
  connectorActions: ConnectorActionRecord[];
}

export interface DatabaseAdapter {
  readonly name: string;
  read(): GoatmezDatabaseShape;
  write(next: GoatmezDatabaseShape): void;
}

export function emptyDatabase(): GoatmezDatabaseShape {
  return {
    version: 4,
    updatedAt: new Date().toISOString(),
    tasks: [],
    memories: [],
    approvals: [],
    missions: [],
    scheduledMissions: [],
    workflowRuns: [],
    connectorActions: []
  };
}

export function normalizeDatabase(input: Partial<GoatmezDatabaseShape> | undefined): GoatmezDatabaseShape {
  const now = new Date().toISOString();
  return {
    version: 4,
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : now,
    tasks: Array.isArray(input?.tasks) ? input.tasks : [],
    memories: Array.isArray(input?.memories) ? input.memories : [],
    approvals: Array.isArray(input?.approvals) ? input.approvals : [],
    missions: Array.isArray(input?.missions) ? input.missions : [],
    scheduledMissions: Array.isArray(input?.scheduledMissions) ? input.scheduledMissions : [],
    workflowRuns: Array.isArray(input?.workflowRuns) ? input.workflowRuns : [],
    connectorActions: Array.isArray((input as any)?.connectorActions) ? (input as any).connectorActions : []
  };
}
