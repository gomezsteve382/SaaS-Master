import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Vehicle Jobs (Task #501).
 *
 * A "job" is the full module-swap workflow for one vehicle: VIN, vehicle
 * metadata, current status, and the pluggable Fix Plan progress. Persisting
 * the job lets a tech start on the shop laptop, finish on a bench tablet,
 * and produce a Sign-Off summary later.
 *
 * Append-only events live in `vehicleJobEvents`.
 */
export const vehicleJobsTable = pgTable(
  "vehicle_jobs",
  {
    id: text("id").primaryKey(),
    vin: text("vin").notNull(),
    // Discriminates the workflow that owns this job. The original module-swap
    // WORKFLOW tab uses "workflow"; the universal VIN batch runner uses
    // "programAll" so its in-progress jobs can be resumed across devices
    // without colliding with workflow jobs.
    kind: text("kind").notNull().default("workflow"),
    title: text("title"),
    vehicle: jsonb("vehicle"),
    status: text("status").notNull().default("draft"),
    census: jsonb("census"),
    fixPlan: jsonb("fix_plan"),
    signOff: jsonb("sign_off"),
    owner: text("owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vinIdx: index("vehicle_jobs_vin_idx").on(t.vin),
    kindIdx: index("vehicle_jobs_kind_idx").on(t.kind),
    updatedAtIdx: index("vehicle_jobs_updated_at_idx").on(t.updatedAt),
  }),
);

export type VehicleJob = typeof vehicleJobsTable.$inferSelect;
