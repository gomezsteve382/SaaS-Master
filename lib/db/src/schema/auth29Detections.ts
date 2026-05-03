import { pgTable, text, integer, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

/* UDS 0x29 Authentication detections (Task #573).
 *
 * Mirrors the per-bench `srtlab.auth29.detections` localStorage record
 * that the 0x29 detector writes when a module insists on
 * Authentication (0x29) instead of SecurityAccess (0x27). Persisting
 * here gives the team a fleet-wide coverage map of which modules — by
 * VIN + tx address — have already moved to 0x29, so a fresh browser /
 * shop laptop / bench tablet doesn't have to re-discover it.
 *
 * Composite PK on (vin, tx, rx) means "youngest record per
 * (vin, tx address, rx address) wins" — re-flagging the same ECU
 * pair upserts. `vin` defaults to '' and `rx` defaults to 0 because
 * some detections fire from contexts (initAdapter probes, bench
 * warm-ups) that don't have a VIN or rx bound yet; those still
 * surface in the banner so the operator sees them, and the PK stays
 * total (PG forbids NULL in PK columns).
 */
export const auth29DetectionsTable = pgTable(
  "auth29_detections",
  {
    vin: text("vin").notNull().default(""),
    tx: integer("tx").notNull(),
    rx: integer("rx").notNull().default(0),
    label: text("label"),
    nrc: integer("nrc"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.vin, t.tx, t.rx] }),
    detectedAtIdx: index("auth29_detections_detected_at_idx").on(t.detectedAt),
    vinIdx: index("auth29_detections_vin_idx").on(t.vin),
  }),
);

export type Auth29Detection = typeof auth29DetectionsTable.$inferSelect;
