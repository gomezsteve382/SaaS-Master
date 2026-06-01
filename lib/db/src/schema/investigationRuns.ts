import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
  customType,
} from "drizzle-orm/pg-core";

/**
 * PostgreSQL `bytea` column. drizzle-orm's node-postgres driver maps a
 * `bytea` column to a Node `Buffer` on read and accepts a `Buffer` on write,
 * so we surface it with that type.
 */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Investigation Swarm (Task #718).
 *
 * Five parallel specialist agents (CRYPTO, PROTOCOL, LAYOUT, IMMOBILIZER,
 * CROSS_REF) analyse a loaded ECU dump and a COORDINATOR agent synthesises
 * their findings into a single ranked report. Strictly read-only — no bytes
 * are written to any ECU or file.
 *
 * Each run is scoped per-launcher the same way `conversations` is, so
 * different bench sessions stay isolated.
 */

export const investigationRunsTable = pgTable(
  "investigation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: text("scope"),
    title: text("title"),
    dumpName: text("dump_name").notNull().default(""),
    dumpSize: integer("dump_size").notNull().default(0),
    referenceName: text("reference_name"),
    referenceSize: integer("reference_size"),
    status: text("status").notNull().default("pending"),
    summary: jsonb("summary"),
    report: jsonb("report"),
    binaryMeta: jsonb("binary_meta"),
    agentIterCap: integer("agent_iter_cap"),
    tokenBudget: integer("token_budget"),
    totalTokensUsed: integer("total_tokens_used"),
    /**
     * Durable, short-lived storage for the uploaded dump buffers so a swarm
     * run survives an API-server restart between the POST that creates it and
     * the SSE GET that consumes it (Task #937). Cleared once the run finishes
     * or after `bufferExpiresAt` passes (see the TTL sweep in the router).
     */
    primaryBuffer: bytea("primary_buffer"),
    referenceBuffer: bytea("reference_buffer"),
    bufferExpiresAt: timestamp("buffer_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => ({
    scopeIdx: index("investigation_runs_scope_idx").on(t.scope),
    startedAtIdx: index("investigation_runs_started_at_idx").on(t.startedAt),
  }),
);

export const investigationAgentFindingsTable = pgTable(
  "investigation_agent_findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => investigationRunsTable.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    findingType: text("finding_type").notNull().default("general"),
    description: text("description").notNull(),
    offsets: jsonb("offsets"),
    confidence: real("confidence").notNull().default(0),
    status: text("status").notNull().default("UNVERIFIED"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index("investigation_agent_findings_run_idx").on(t.runId),
    agentIdx: index("investigation_agent_findings_agent_idx").on(t.agent),
  }),
);

/**
 * Columns safe to return from the run list/detail read APIs. This explicitly
 * EXCLUDES the durable upload buffers (`primaryBuffer` / `referenceBuffer`)
 * and `bufferExpiresAt` so raw uploaded binaries are never disclosed through
 * the standard run read endpoints (Task #937). Every read endpoint must use
 * this projection instead of `select()` on the whole row.
 */
export const investigationRunPublicColumns = {
  id: investigationRunsTable.id,
  scope: investigationRunsTable.scope,
  title: investigationRunsTable.title,
  dumpName: investigationRunsTable.dumpName,
  dumpSize: investigationRunsTable.dumpSize,
  referenceName: investigationRunsTable.referenceName,
  referenceSize: investigationRunsTable.referenceSize,
  status: investigationRunsTable.status,
  summary: investigationRunsTable.summary,
  report: investigationRunsTable.report,
  binaryMeta: investigationRunsTable.binaryMeta,
  agentIterCap: investigationRunsTable.agentIterCap,
  tokenBudget: investigationRunsTable.tokenBudget,
  totalTokensUsed: investigationRunsTable.totalTokensUsed,
  startedAt: investigationRunsTable.startedAt,
  finishedAt: investigationRunsTable.finishedAt,
  completedAt: investigationRunsTable.completedAt,
  cancelledAt: investigationRunsTable.cancelledAt,
} as const;

export const investigationAgentRunsTable = pgTable(
  "investigation_agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => investigationRunsTable.id, { onDelete: "cascade" }),
    agentName: text("agent_name").notNull(),
    status: text("status").notNull().default("pending"),
    findings: jsonb("findings"),
    toolTrace: jsonb("tool_trace"),
    iterations: integer("iterations").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index("investigation_agent_runs_run_idx").on(t.runId),
  }),
);

export type InvestigationRun = typeof investigationRunsTable.$inferSelect;
export type InvestigationAgentFinding =
  typeof investigationAgentFindingsTable.$inferSelect;
export type InvestigationAgentRun =
  typeof investigationAgentRunsTable.$inferSelect;
