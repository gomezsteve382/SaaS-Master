import { ApprovalExecutionResult, ApprovalRecord, ApprovalStatus } from "./types.js";
import { makeId } from "./id.js";
import { LocalDatabase } from "./localDatabase.js";

type ApprovalCreateInput = Omit<ApprovalRecord, "id" | "status" | "createdAt" | "updatedAt">;

export class ApprovalStore {
  constructor(private readonly db: LocalDatabase) {}

  async create(input: ApprovalCreateInput): Promise<ApprovalRecord> {
    const now = new Date().toISOString();
    const record: ApprovalRecord = {
      id: makeId("appr"),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ...input
    };
    this.db.upsertApproval(record);
    return record;
  }

  async list(): Promise<ApprovalRecord[]> {
    return this.db.listApprovals();
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    return this.db.listApprovals().find((record) => record.id === id);
  }

  async decide(id: string, status: Exclude<ApprovalStatus, "pending" | "executing">, decisionNote?: string): Promise<ApprovalRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`Approval not found: ${id}`);
    if (["executed", "failed"].includes(record.status)) {
      throw new Error(`Approval ${id} is already closed with status '${record.status}'.`);
    }
    const next: ApprovalRecord = {
      ...record,
      status,
      decisionNote,
      updatedAt: new Date().toISOString()
    };
    this.db.upsertApproval(next);
    return next;
  }

  async markExecuting(id: string, decisionNote?: string): Promise<ApprovalRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`Approval not found: ${id}`);
    if (record.status !== "approved") {
      throw new Error(`Approval ${id} must be approved before execution. Current status: ${record.status}`);
    }
    const next: ApprovalRecord = {
      ...record,
      status: "executing",
      decisionNote,
      updatedAt: new Date().toISOString()
    };
    this.db.upsertApproval(next);
    return next;
  }

  async markExecutionResult(id: string, execution: ApprovalExecutionResult): Promise<ApprovalRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`Approval not found: ${id}`);
    const next: ApprovalRecord = {
      ...record,
      status: execution.ok ? "executed" : "failed",
      execution,
      updatedAt: new Date().toISOString()
    };
    this.db.upsertApproval(next);
    return next;
  }
}
