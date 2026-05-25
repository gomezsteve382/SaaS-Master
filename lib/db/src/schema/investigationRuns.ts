import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

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
    dumpName: text("dump_name").notNull().default(""),
    dumpSize: integer("dump_size").notNull().default(0),
    referenceName: text("reference_name"),
    referenceSize: integer("reference_size"),
    status: text("status").notNull().default("pending"),
    summary: jsonb("summary"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
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

export type InvestigationRun = typeof investigationRunsTable.$inferSelect;
export type InvestigationAgentFinding =
  typeof investigationAgentFindingsTable.$inferSelect;
