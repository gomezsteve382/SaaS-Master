import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/* Saved Key Prog ZIP history (Task #394).
 *
 * Mirrors what `keyProgArchiveHistory.js` used to keep in localStorage so the
 * SAVED ARCHIVES list on the Key Prog tab survives across browsers, machines,
 * and cleared site data — same pattern as `module_backups` and `diff_reports`.
 */
export const keyProgArchivesTable = pgTable(
  "key_prog_archives",
  {
    id: text("id").primaryKey(),
    vin: text("vin").notNull().default(""),
    zipName: text("zip_name").notNull().default(""),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    bcmSec16: jsonb("bcm_sec16"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    savedAtIdx: index("key_prog_archives_saved_at_idx").on(t.savedAt),
  }),
);

export type KeyProgArchive = typeof keyProgArchivesTable.$inferSelect;
