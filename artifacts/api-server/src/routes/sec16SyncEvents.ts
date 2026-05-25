import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  sec16SyncEventsTable,
  type Sec16SyncEvent,
} from "@workspace/db";

/* Task #686 — retention.
 *
 * The table is append-only at the API surface but bounded at the storage
 * level by a per-VIN row cap plus an absolute age cutoff. Rows with a null
 * VIN share one bucket. Pruning runs best-effort after every successful
 * insert; failures are logged and swallowed so they never break a write.
 *
 *   RETENTION_PER_VIN     keep the N most-recent rows per VIN bucket
 *                         (the null-VIN bucket counts as one VIN)
 *   RETENTION_MAX_AGE_MS  hard cutoff — anything older is dropped
 *                         regardless of bucket size
 */
const RETENTION_PER_VIN = 200;
const RETENTION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

async function pruneSec16SyncEvents(vin: string | null): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_MAX_AGE_MS);
    await db
      .delete(sec16SyncEventsTable)
      .where(sql`${sec16SyncEventsTable.createdAt} < ${cutoff}`);
    if (vin === null) {
      await db.execute(sql`
        DELETE FROM ${sec16SyncEventsTable}
        WHERE vin IS NULL
          AND id IN (
            SELECT id FROM ${sec16SyncEventsTable}
            WHERE vin IS NULL
            ORDER BY created_at DESC, id DESC
            OFFSET ${RETENTION_PER_VIN}
          )
      `);
    } else {
      await db.execute(sql`
        DELETE FROM ${sec16SyncEventsTable}
        WHERE vin = ${vin}
          AND id IN (
            SELECT id FROM ${sec16SyncEventsTable}
            WHERE vin = ${vin}
            ORDER BY created_at DESC, id DESC
            OFFSET ${RETENTION_PER_VIN}
          )
      `);
    }
  } catch (err) {
    console.error("[sec16-sync-events] prune failed", err);
  }
}

/* Task #678 — SEC16 sync event log.
 *
 *   GET  /api/sec16-sync-events?vin=…        → list (descending), optional VIN filter
 *   POST /api/sec16-sync-events              → append one (always inserts, never upserts)
 *
 * The log is intentionally append-only — every sync attempt is its own
 * row so the audit trail survives even when a tech re-runs the same
 * recipe. DELETE is not exposed.
 */

const router: IRouter = Router();

const MAX_VIN_LEN = 32;
const MAX_PLATFORM_LEN = 64;
const MAX_ACTION_LEN = 128;
const MAX_TARGET_LEN = 32;
const MAX_RECIPE_LEN = 128;
const MAX_VERIFIED_LEN = 32;
const MAX_OPERATOR_LEN = 120;
const MAX_NOTES_LEN = 2000;
const ALLOWED_VERIFIED = new Set(["match", "mismatch", "unverified", "offline", "read-error"]);

function rowToJson(row: Sec16SyncEvent) {
  return {
    id: row.id,
    vin: row.vin ?? null,
    platform: row.platform ?? null,
    actionId: row.actionId,
    target: row.target,
    recipeId: row.recipeId ?? null,
    verified: row.verified,
    operator: row.operator ?? null,
    notes: row.notes ?? null,
    detail: row.detail ?? null,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

function trimStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t.length > 0 ? t : null;
}

router.get("/sec16-sync-events", async (req, res, next) => {
  try {
    const vinParam = typeof req.query["vin"] === "string" ? req.query["vin"] : "";
    const vin = vinParam
      ? vinParam.toUpperCase().replace(/\s+/g, "").slice(0, MAX_VIN_LEN)
      : null;
    const baseQuery = db.select().from(sec16SyncEventsTable);
    const rows = vin
      ? await baseQuery
          .where(eq(sec16SyncEventsTable.vin, vin))
          .orderBy(desc(sec16SyncEventsTable.createdAt))
          .limit(500)
      : await baseQuery
          .orderBy(desc(sec16SyncEventsTable.createdAt))
          .limit(500);
    res.json({ events: rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/sec16-sync-events", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const actionId = trimStr(body.actionId, MAX_ACTION_LEN);
    const target = trimStr(body.target, MAX_TARGET_LEN);
    const verifiedRaw = trimStr(body.verified, MAX_VERIFIED_LEN);
    if (!actionId) { res.status(400).json({ error: "actionId required" }); return; }
    if (!target) { res.status(400).json({ error: "target required" }); return; }
    if (!verifiedRaw || !ALLOWED_VERIFIED.has(verifiedRaw)) {
      res.status(400).json({ error: "verified must be one of " + Array.from(ALLOWED_VERIFIED).join(", ") });
      return;
    }
    const vin = typeof body.vin === "string" && body.vin
      ? body.vin.toUpperCase().replace(/\s+/g, "").slice(0, MAX_VIN_LEN)
      : null;
    const platform = trimStr(body.platform, MAX_PLATFORM_LEN);
    const recipeId = trimStr(body.recipeId, MAX_RECIPE_LEN);
    const operator = trimStr(body.operator, MAX_OPERATOR_LEN);
    const notes = trimStr(body.notes, MAX_NOTES_LEN);
    const detail = body.detail && typeof body.detail === "object" ? body.detail : null;

    const inserted = await db
      .insert(sec16SyncEventsTable)
      .values({
        vin, platform, actionId, target, recipeId,
        verified: verifiedRaw, operator, notes, detail,
      })
      .returning();
    const row = inserted[0];
    if (!row) { res.status(500).json({ error: "insert returned no row" }); return; }
    await pruneSec16SyncEvents(row.vin ?? null);
    res.json({ ok: true, event: rowToJson(row) });
  } catch (err) {
    next(err);
  }
});

export default router;
