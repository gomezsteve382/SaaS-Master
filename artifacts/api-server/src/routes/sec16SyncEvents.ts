import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  sec16SyncEventsTable,
  type Sec16SyncEvent,
} from "@workspace/db";

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
    res.json({ ok: true, event: rowToJson(row) });
  } catch (err) {
    next(err);
  }
});

export default router;
