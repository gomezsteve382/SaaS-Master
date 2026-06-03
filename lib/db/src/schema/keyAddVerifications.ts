import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/* Bench-verified offline key-add confirmations (Charger RFHUB self-check).
 *
 * The before/after self-check (CharRfhubKeyDiffPanel) lets an operator prove,
 * on their own bench, that a real single offline key-add landed in the slot the
 * Offline Key Adder would pick with nothing changed outside the key table. When
 * that clean verdict is confirmed it is recorded here so the Offline Key Adder's
 * permanent "NOT BENCH-VERIFIED" caveat can be softened for that layout.
 *
 * Records are scoped by `layout` (e.g. the MPC Charger/Challenger 8-slot key
 * table) rather than by VIN: a single clean confirmation validates the layout's
 * write path, not one car. Mirrors the round-trip pattern of /api/key-history:
 * the client treats localStorage as an offline cache that mirrors this store.
 *
 * `confirmedAt` is exchanged with the client as epoch milliseconds and stored
 * as a timestamptz column.
 */
export const keyAddVerificationsTable = pgTable(
  "key_add_verifications",
  {
    id: text("id").primaryKey(),
    layout: text("layout").notNull(),
    addedKeyId: text("added_key_id").notNull().default(""),
    slot: integer("slot"),
    slotIdx: integer("slot_idx"),
    expectedSlotIdx: integer("expected_slot_idx"),
    beforeKeyCount: integer("before_key_count"),
    afterKeyCount: integer("after_key_count"),
    beforeName: text("before_name").notNull().default(""),
    afterName: text("after_name").notNull().default(""),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    layoutIdx: index("key_add_verifications_layout_idx").on(t.layout),
    confirmedAtIdx: index("key_add_verifications_confirmed_at_idx").on(t.confirmedAt),
  }),
);

export type KeyAddVerificationRow = typeof keyAddVerificationsTable.$inferSelect;
