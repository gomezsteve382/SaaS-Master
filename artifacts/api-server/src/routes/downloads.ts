import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, downloadCountersTable } from "@workspace/db";

const router: IRouter = Router();

/**
 * Shared global download counter.
 * Any client can POST /api/downloads/:assetId to bump a counter and
 * GET /api/downloads/:assetId (or GET /api/downloads) to read counts.
 * Counts are persisted in Postgres (download_counters table) via Drizzle.
 * The canonical list of asset IDs lives in
 * artifacts/srt-lab/src/lib/downloadAssets.js.
 */

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

router.get("/downloads", async (_req, res, next) => {
  try {
    const rows = await db.select().from(downloadCountersTable);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.id] = Number(r.count) || 0;
    res.json({ counts });
  } catch (err) {
    next(err);
  }
});

router.get("/downloads/:assetId", async (req, res, next) => {
  try {
    const id = req.params.assetId;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid assetId" });
      return;
    }

    const rows = await db
      .select()
      .from(downloadCountersTable)
      .where(sql`${downloadCountersTable.id} = ${id}`);

    const count = Number(rows[0]?.count ?? 0);
    res.json({ id, assetId: id, count });
  } catch (err) {
    next(err);
  }
});

router.post("/downloads/:assetId", async (req, res, next) => {
  try {
    const id = req.params.assetId;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid assetId" });
      return;
    }

    const rows = await db
      .insert(downloadCountersTable)
      .values({ id, count: 1 })
      .onConflictDoUpdate({
        target: downloadCountersTable.id,
        set: { count: sql`${downloadCountersTable.count} + 1` },
      })
      .returning();

    const count = Number(rows[0]?.count ?? 0);
    res.json({ id, assetId: id, count });
  } catch (err) {
    next(err);
  }
});

export default router;
