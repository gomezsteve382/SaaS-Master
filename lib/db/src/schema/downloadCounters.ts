import { pgTable, text, bigint } from "drizzle-orm/pg-core";

export const downloadCountersTable = pgTable("download_counters", {
  id: text("id").primaryKey(),
  count: bigint("count", { mode: "number" }).notNull().default(0),
});

export type DownloadCounter = typeof downloadCountersTable.$inferSelect;
