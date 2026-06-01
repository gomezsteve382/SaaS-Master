import { pgTable, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/* Per-vehicle "keys on file" history (Task #986 client store, Task #991 server).
 *
 * Mirrors what `keyHistory.js` keeps in localStorage so the captured-key list
 * for a VIN survives across browsers, machines, and cleared site data — same
 * round-trip pattern as `module_backups` and `key_prog_archives`. localStorage
 * is treated as an offline cache that mirrors this server state.
 *
 * `skHex` is the per-transponder chip secret the operator's external tool
 * calculated (NOT the 16-byte RFHUB SEC16 master secret — the Key Dump card
 * has no SK==SEC16 path), so it is safe to persist alongside the rest of the
 * captured record for later re-export / clone-on-bench.
 */
export const keyHistoryTable = pgTable(
  "key_history",
  {
    id: text("id").primaryKey(),
    vin: text("vin").notNull(),
    chipId: text("chip_id").notNull(),
    uidHex: text("uid_hex").notNull().default(""),
    skHex: text("sk_hex").notNull().default(""),
    flags: jsonb("flags"),
    label: text("label").notNull().default(""),
    slotIdx: integer("slot_idx"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vinIdx: index("key_history_vin_idx").on(t.vin),
    capturedAtIdx: index("key_history_captured_at_idx").on(t.capturedAt),
  }),
);

export type KeyHistoryRow = typeof keyHistoryTable.$inferSelect;
