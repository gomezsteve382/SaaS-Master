import { AgentRuntime } from "./agentRuntime.js";
import { LocalDatabase } from "./localDatabase.js";
import { ScheduledMissionRecord } from "./types.js";
import { makeId } from "./id.js";

export interface ScheduleCreateInput {
  title: string;
  workspaceId?: string;
  agentId: string;
  message: string;
  intervalMinutes: number;
  startAt?: string;
  enabled?: boolean;
}

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

export class ScheduleEngine {
  private running = false;

  constructor(private readonly db: LocalDatabase, private readonly runtime: AgentRuntime, private readonly cwd: string) {}

  create(input: ScheduleCreateInput): ScheduledMissionRecord {
    const now = new Date().toISOString();
    const intervalMinutes = Math.max(1, Math.floor(input.intervalMinutes));
    const schedule: ScheduledMissionRecord = {
      id: makeId("sch"),
      title: input.title.trim() || input.message.slice(0, 80),
      workspaceId: input.workspaceId || "local",
      agentId: input.agentId,
      message: input.message,
      enabled: input.enabled !== false,
      intervalMinutes,
      nextRunAt: input.startAt || addMinutes(new Date(), intervalMinutes),
      status: input.enabled === false ? "disabled" : "idle",
      createdAt: now,
      updatedAt: now
    };
    this.db.upsertScheduledMission(schedule);
    return schedule;
  }

  list(): ScheduledMissionRecord[] {
    return this.db.listScheduledMissions();
  }

  get(id: string): ScheduledMissionRecord | undefined {
    return this.list().find((schedule) => schedule.id === id);
  }

  update(id: string, patch: Partial<Omit<ScheduledMissionRecord, "id" | "createdAt">>): ScheduledMissionRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Schedule not found: ${id}`);
    const next: ScheduledMissionRecord = {
      ...current,
      ...patch,
      status: patch.enabled === false ? "disabled" : patch.status ?? current.status,
      updatedAt: new Date().toISOString()
    };
    this.db.upsertScheduledMission(next);
    return next;
  }

  delete(id: string): boolean {
    return this.db.deleteScheduledMission(id);
  }

  async runDueOnce(now = new Date()): Promise<ScheduledMissionRecord[]> {
    if (this.running) return [];
    this.running = true;
    const executed: ScheduledMissionRecord[] = [];
    try {
      const due = this.list().filter((schedule) => schedule.enabled && schedule.nextRunAt <= now.toISOString());
      for (const schedule of due) {
        const running = this.update(schedule.id, { status: "running" });
        try {
          const sessionId = makeId("sched");
          const result = await this.runtime.run({
            workspaceId: running.workspaceId,
            sessionId,
            agentId: running.agentId,
            message: running.message,
            cwd: this.cwd,
            approveAll: false,
            dryRun: false
          });
          executed.push(this.update(running.id, {
            status: "idle",
            lastRunAt: new Date().toISOString(),
            nextRunAt: addMinutes(new Date(), running.intervalMinutes),
            lastResult: result.slice(0, 1000),
            lastError: undefined
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          executed.push(this.update(running.id, {
            status: "failed",
            lastRunAt: new Date().toISOString(),
            nextRunAt: addMinutes(new Date(), running.intervalMinutes),
            lastError: message,
            lastResult: undefined
          }));
        }
      }
      return executed;
    } finally {
      this.running = false;
    }
  }
}
