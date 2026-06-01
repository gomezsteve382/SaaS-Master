import {
  pgTable,
  text,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Session paper-trail log (Task #936).
 *
 * One row per programming operation (VIN write, SEC16 sync, key/chip burn,
 * etc.) so the audit trail survives a browser clear, device switch, or being
 * shared across technicians. The SRT Lab Sessions tab is the primary consumer;
 * localStorage is used as an offline cache that mirrors the server state.
 *
 * Sessions are associated with the VIN / vehicle-job context (not a logged-in
 * user). The full client record is preserved verbatim in `payload` so report
 * generation keeps full fidelity; the flat columns exist for filtering and
 * list rendering.
 */
export const sessionLogTable = pgTable(
  "session_log",
  {
    // Client-generated id ("sess_<ts>_<rand>") — upsert target.
    id: text("id").primaryKey(),
    vin: text("vin"),
    module: text("module"),
    operation: text("operation"),
    success: boolean("success"),
    oldVin: text("old_vin"),
    newVin: text("new_vin"),
    technician: text("technician"),
    titleRef: text("title_ref"),
    titleNotes: text("title_notes"),
    adapter: text("adapter"),
    sgwRouted: boolean("sgw_routed"),
    algorithm: text("algorithm"),
    voltage: doublePrecision("voltage"),
    preWriteConfirmed: text("pre_write_confirmed"),
    notes: text("notes"),
    backupKey: text("backup_key"),
    jobId: text("job_id"),
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    vinIdx: index("session_log_vin_idx").on(t.vin),
    jobIdIdx: index("session_log_job_id_idx").on(t.jobId),
    timestampIdx: index("session_log_timestamp_idx").on(t.timestamp),
  }),
);

export type SessionLogRow = typeof sessionLogTable.$inferSelect;
