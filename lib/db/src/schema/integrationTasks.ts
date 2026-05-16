import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Integration Tasks (Task #620).
 *
 * Backlog row per CAN Universe shortlisted tool. When a user clicks
 * "Convert shortlist to tasks" in the CAN Universe tab we upsert one
 * row per starred catalog entry so the team can track whether (and
 * how) each tool got wired into SRT Lab — UDS adapter, OBD-II decoder
 * library, DBC parser, etc. PK is a deterministic `tool:<entryId>`
 * so re-converting the shortlist refreshes existing rows in-place
 * instead of duplicating them.
 */
export const integrationTasksTable = pgTable(
  "integration_tasks",
  {
    id: text("id").primaryKey(),
    toolId: text("tool_id").notNull(),
    toolName: text("tool_name").notNull(),
    toolUrl: text("tool_url"),
    category: text("category"),
    target: text("target"),
    status: text("status").notNull().default("open"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index("integration_tasks_status_idx").on(t.status),
    updatedAtIdx: index("integration_tasks_updated_at_idx").on(t.updatedAt),
  }),
);

export type IntegrationTask = typeof integrationTasksTable.$inferSelect;
