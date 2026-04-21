import { pgTable, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const diffReportsTable = pgTable(
  "diff_reports",
  {
    id: text("id").primaryKey(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    baselineLabel: text("baseline_label").notNull().default("(unlabeled)"),
    baselineTs: timestamp("baseline_ts", { withTimezone: true }),
    baselineModuleCount: integer("baseline_module_count").notNull().default(0),
    currentTs: timestamp("current_ts", { withTimezone: true }),
    currentModuleCount: integer("current_module_count").notNull().default(0),
    addedCount: integer("added_count").notNull().default(0),
    removedCount: integer("removed_count").notNull().default(0),
    changedCount: integer("changed_count").notNull().default(0),
    sameCount: integer("same_count").notNull().default(0),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    generatedAtIdx: index("diff_reports_generated_at_idx").on(t.generatedAt),
  }),
);

export type DiffReport = typeof diffReportsTable.$inferSelect;
