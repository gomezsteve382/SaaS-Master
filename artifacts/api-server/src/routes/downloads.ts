import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, downloadCountersTable } from "@workspace/db";

const router: IRouter = Router();

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

router.get("/downloads/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const rows = await db
      .select()
      .from(downloadCountersTable)
      .where(sql`${downloadCountersTable.id} = ${id}`);

    const count = rows[0]?.count ?? 0;
    res.json({ id, count });
  } catch (err) {
    next(err);
  }
});

router.post("/downloads/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "Invalid id" });
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

    const count = rows[0]?.count ?? 0;
    res.json({ id, count });
  } catch (err) {
    next(err);
  }
});

export default router;
