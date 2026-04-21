import { pgTable, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const moduleBackupsTable = pgTable(
  "module_backups",
  {
    id: text("id").primaryKey(),
    module: text("module").notNull(),
    vin: text("vin").notNull(),
    didCount: integer("did_count").notNull().default(0),
    tx: integer("tx"),
    rx: integer("rx"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    moduleIdx: index("module_backups_module_idx").on(t.module),
    timestampIdx: index("module_backups_timestamp_idx").on(t.timestamp),
  }),
);

export type ModuleBackup = typeof moduleBackupsTable.$inferSelect;
