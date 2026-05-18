import { pgTable, text, timestamp, serial, jsonb } from "drizzle-orm/pg-core";

/* Task #678 — append-only log of SEC16 sync operations.
 *
 * Captures both the offline writers (writeBcmSec16Gen2, writePcmSec6,
 * writeRfhSec16FromBcm, writeBcmFlatSec16) and the new live writer
 * (liveImmo.writeSec16). One row per successful sync action so the
 * GO/NO-GO panel can show "last sync 12m ago by JD" and the bench
 * laptop's history follows the operator to the next car.
 *
 *   id          serial PK
 *   vin         17-char VIN of the vehicle (optional; not every fixture
 *               replay has one)
 *   platform    sec16Platforms.classifyPlatform() id
 *               ('lx-ld' | 'wk2-jeep' | 'wd-durango' | 'dt-ram-2019plus'
 *                | 'unknown')
 *   actionId    matches sec16Preflight action ids
 *               ('rfh-bcm-sec16-sync', 'flat-40c9-repair', etc.)
 *   target      module written ('BCM' | 'RFHUB' | 'PCM' | '95640')
 *   recipeId    optional — set when the live writer was used
 *               (matches SEC16_WRITE_RECIPES[*].id)
 *   verified    'match' | 'mismatch' | 'unverified' | 'offline'
 *               (offline writers always report 'offline'; live writer
 *               reports the read-back outcome)
 *   operator    free-form tech identifier
 *   notes       free-form notes
 *   detail      structured payload (recipe-specific tx/rx, byte counts,
 *               offsets — anything the writer wants to surface in the
 *               audit log)
 *   createdAt   server-side timestamp
 */
export const sec16SyncEventsTable = pgTable("sec16_sync_events", {
  id: serial("id").primaryKey(),
  vin: text("vin"),
  platform: text("platform"),
  actionId: text("action_id").notNull(),
  target: text("target").notNull(),
  recipeId: text("recipe_id"),
  verified: text("verified").notNull(),
  operator: text("operator"),
  notes: text("notes"),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Sec16SyncEvent = typeof sec16SyncEventsTable.$inferSelect;
