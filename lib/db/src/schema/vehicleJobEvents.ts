import { pgTable, text, jsonb, timestamp, serial, index } from "drizzle-orm/pg-core";
import { vehicleJobsTable } from "./vehicleJobs";

/**
 * Append-only audit log for a vehicle job (Task #501).
 *
 * Each row records one workflow event so we can reconstruct what happened
 * during a swap: census snapshot, fix-plan step start/complete, NRC
 * encountered, security-access result, sign-off entries. Payload is open
 * jsonb so callers can record whatever step-specific context they need.
 */
export const vehicleJobEventsTable = pgTable(
  "vehicle_job_events",
  {
    id: serial("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => vehicleJobsTable.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(),
    module: text("module"),
    payload: jsonb("payload"),
  },
  (t) => ({
    jobIdIdx: index("vehicle_job_events_job_id_idx").on(t.jobId),
    tsIdx: index("vehicle_job_events_ts_idx").on(t.ts),
  }),
);

export type VehicleJobEvent = typeof vehicleJobEventsTable.$inferSelect;
