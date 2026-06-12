import { TaskRecord } from "./types.js";
import { makeId } from "./id.js";
import { LocalDatabase } from "./localDatabase.js";

export class TaskEngine {
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(private readonly db?: LocalDatabase) {
    for (const task of db?.listTasks() ?? []) this.tasks.set(task.id, task);
  }

  create(input: Pick<TaskRecord, "title" | "agentId" | "workspaceId">): TaskRecord {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: makeId("task"),
      title: input.title,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      notes: []
    };
    this.tasks.set(task.id, task);
    this.db?.upsertTask(task);
    return task;
  }

  update(id: string, patch: Partial<Pick<TaskRecord, "status">> & { note?: string }): TaskRecord {
    const current = this.tasks.get(id) ?? this.db?.listTasks().find((task) => task.id === id);
    if (!current) throw new Error(`Task not found: ${id}`);
    const { note, ...statusPatch } = patch;
    const next: TaskRecord = {
      ...current,
      ...statusPatch,
      updatedAt: new Date().toISOString(),
      notes: note ? [...current.notes, note] : current.notes
    };
    this.tasks.set(id, next);
    this.db?.upsertTask(next);
    return next;
  }

  list(): TaskRecord[] {
    const source = this.db ? this.db.listTasks() : [...this.tasks.values()];
    return [...source].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
