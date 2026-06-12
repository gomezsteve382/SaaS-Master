import { MissionRecord } from "./types.js";
import { makeId } from "./id.js";
import { LocalDatabase } from "./localDatabase.js";

export class MissionStore {
  constructor(private readonly db: LocalDatabase) {}

  create(input: Pick<MissionRecord, "workspaceId" | "sessionId" | "agentId" | "message" | "planner">): MissionRecord {
    const now = new Date().toISOString();
    const mission: MissionRecord = {
      id: makeId("msn"),
      status: "running",
      createdAt: now,
      updatedAt: now,
      ...input
    };
    this.db.upsertMission(mission);
    return mission;
  }

  update(id: string, patch: Partial<Pick<MissionRecord, "status" | "taskId" | "result" | "error">>): MissionRecord {
    const current = this.db.listMissions().find((mission) => mission.id === id);
    if (!current) throw new Error(`Mission not found: ${id}`);
    const next: MissionRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.db.upsertMission(next);
    return next;
  }

  list(): MissionRecord[] {
    return this.db.listMissions();
  }
}
