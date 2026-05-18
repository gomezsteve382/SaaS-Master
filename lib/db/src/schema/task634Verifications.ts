import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/* Task #641 — bench-verification flags for the hand-curated task-634
 * competitor-parity entries (XC2268 RFHUB patch, ZF-8HP TCU VIN write,
 * Mopar radio code derivation, dealer-lockout bypass).
 *
 * Each row records that an operator has run the capability against a
 * real vehicle. The presence of a row promotes the entry from
 * "bench-pending" to "verified" in UnlockCoverageTab. Persisting here
 * (instead of only in localStorage) means a verification done on the
 * shop laptop shows up on the bench tablet too.
 *
 * Keyed by the task-634 entry id (matches the `id` field in
 * public/task634_entries.json). Re-marking is idempotent — the upsert
 * just refreshes verifiedAt / vin / notes.
 */
export const task634VerificationsTable = pgTable("task634_verifications", {
  entryId: text("entry_id").primaryKey(),
  verifiedAt: timestamp("verified_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  vin: text("vin"),
  notes: text("notes"),
  // Task #643 — who actually ran the capability against the car. Free-form
  // string (tech initials, name, badge number — whatever the shop uses).
  // Optional so legacy verifications without an operator stay valid.
  operator: text("operator"),
});

export type Task634Verification =
  typeof task634VerificationsTable.$inferSelect;
