import { createHash } from "node:crypto";
import { LocalDatabase } from "../core/localDatabase.js";
import { ConnectorActionRecord, ConnectorActionStatus } from "../core/types.js";
import { makeId } from "../core/id.js";
import { redactObject } from "../security/redaction.js";

export interface StartConnectorActionInput {
  connectorId: string;
  action: string;
  agentId: string;
  workspaceId?: string;
  sessionId?: string;
  dryRun?: boolean;
  request: unknown;
  status?: ConnectorActionStatus;
  idempotencyKey?: string;
  replayOf?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

export function makeConnectorIdempotencyKey(input: Pick<StartConnectorActionInput, "connectorId" | "action" | "agentId" | "request">): string {
  return createHash("sha256")
    .update(stableStringify({ connectorId: input.connectorId, action: input.action, agentId: input.agentId, request: input.request }))
    .digest("hex");
}

export class ConnectorActionStore {
  constructor(private readonly db: LocalDatabase) {}

  list(limit = 100): ConnectorActionRecord[] {
    return this.db.listConnectorActions().slice(0, Math.max(1, limit));
  }

  get(id: string): ConnectorActionRecord | undefined {
    return this.db.listConnectorActions().find((item) => item.id === id);
  }

  findByIdempotencyKey(key: string): ConnectorActionRecord | undefined {
    return this.db.listConnectorActions().find((item) => item.idempotencyKey === key && item.status === "executed");
  }

  start(input: StartConnectorActionInput): ConnectorActionRecord {
    const now = new Date().toISOString();
    const redactedRequest = redactObject(input.request as Record<string, unknown>);
    const idempotencyKey = input.idempotencyKey || makeConnectorIdempotencyKey({ ...input, request: redactedRequest });

    if (input.dryRun === false) {
      const existing = this.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        const blocked: ConnectorActionRecord = {
          id: makeId("connact"),
          connectorId: input.connectorId,
          action: input.action,
          agentId: input.agentId,
          workspaceId: input.workspaceId || "local",
          sessionId: input.sessionId || "connector",
          status: "blocked",
          dryRun: false,
          request: redactedRequest,
          response: { duplicateOf: existing.id, reason: "Idempotency key already executed." },
          idempotencyKey,
          createdAt: now,
          updatedAt: now,
          completedAt: now
        };
        this.db.upsertConnectorAction(blocked);
        throw new Error(`Duplicate connector execution blocked. Already executed as ${existing.id}.`);
      }
    }

    const record: ConnectorActionRecord = {
      id: makeId("connact"),
      connectorId: input.connectorId,
      action: input.action,
      agentId: input.agentId,
      workspaceId: input.workspaceId || "local",
      sessionId: input.sessionId || "connector",
      status: input.status || (input.dryRun === false ? "running" : "prepared"),
      dryRun: input.dryRun !== false,
      request: redactedRequest,
      idempotencyKey,
      replayOf: input.replayOf,
      createdAt: now,
      updatedAt: now
    };
    this.db.upsertConnectorAction(record);
    return record;
  }

  complete(id: string, response: unknown): ConnectorActionRecord {
    const existing = this.get(id);
    if (!existing) throw new Error(`Connector action not found: ${id}`);
    const now = new Date().toISOString();
    const next: ConnectorActionRecord = {
      ...existing,
      status: existing.dryRun ? "prepared" : "executed",
      response: redactObject(response as Record<string, unknown>),
      updatedAt: now,
      completedAt: now
    };
    this.db.upsertConnectorAction(next);
    return next;
  }

  fail(id: string, error: unknown): ConnectorActionRecord {
    const existing = this.get(id);
    if (!existing) throw new Error(`Connector action not found: ${id}`);
    const now = new Date().toISOString();
    const next: ConnectorActionRecord = {
      ...existing,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: now,
      completedAt: now
    };
    this.db.upsertConnectorAction(next);
    return next;
  }

  markReplayed(preparedId: string, executedAction: ConnectorActionRecord, response: unknown): ConnectorActionRecord {
    const existing = this.get(preparedId);
    if (!existing) throw new Error(`Connector action not found: ${preparedId}`);
    if (existing.status !== "prepared") throw new Error(`Only prepared connector actions can be replay-executed. Current status: ${existing.status}`);
    const now = new Date().toISOString();
    const next: ConnectorActionRecord = {
      ...existing,
      status: "replayed",
      replayedBy: executedAction.id,
      response: redactObject({ replayedBy: executedAction.id, executedStatus: executedAction.status, result: response } as Record<string, unknown>),
      updatedAt: now,
      completedAt: now
    };
    this.db.upsertConnectorAction(next);
    return next;
  }
}
