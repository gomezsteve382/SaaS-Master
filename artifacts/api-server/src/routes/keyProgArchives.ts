import { Router, type IRouter } from "express";
import { sql, desc, eq } from "drizzle-orm";
import { db, keyProgArchivesTable } from "@workspace/db";

const router: IRouter = Router();

/**
 * Saved Key Prog ZIP archive history (Task #394).
 *
 * Persists the SAVED ARCHIVES rows from the Key Prog tab so a locksmith who
 * downloads a ZIP on the shop laptop sees the same row when they later open
 * SRT Lab on their bench tablet. Mirrors the shape of /api/diff-reports and
 * /api/backups: the client treats localStorage as an offline cache.
 */

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_LIST = 500;
const MAX_PAYLOAD_BYTES = 16 * 1024; // 16 KB — entries are tiny metadata records

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

function rowToJson(row: typeof keyProgArchivesTable.$inferSelect) {
  return {
    id: row.id,
    vin: row.vin,
    zipName: row.zipName,
    savedAt: row.savedAt instanceof Date ? row.savedAt.toISOString() : row.savedAt,
    bcmSec16: row.bcmSec16 ?? null,
  };
}

router.get("/key-prog-archives", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(keyProgArchivesTable)
      .orderBy(desc(keyProgArchivesTable.savedAt))
      .limit(MAX_LIST);
    res.json({ archives: rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/key-prog-archives", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const vin = typeof body.vin === "string" ? body.vin.slice(0, 32) : "";
    const zipName = typeof body.zipName === "string" ? body.zipName.slice(0, 256) : "";
    const savedAt = toDate(body.savedAt) ?? new Date();
    const bcmSec16 = body.bcmSec16 && typeof body.bcmSec16 === "object" ? body.bcmSec16 : null;

    if (bcmSec16) {
      const serialized = JSON.stringify(bcmSec16);
      if (serialized.length > MAX_PAYLOAD_BYTES) {
        res.status(413).json({ error: "payload too large" });
        return;
      }
    }

    await db
      .insert(keyProgArchivesTable)
      .values({ id, vin, zipName, savedAt, bcmSec16 })
      .onConflictDoUpdate({
        target: keyProgArchivesTable.id,
        set: { vin, zipName, savedAt, bcmSec16 },
      });

    res.json({ id, ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/key-prog-archives/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(keyProgArchivesTable).where(eq(keyProgArchivesTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/key-prog-archives", async (_req, res, next) => {
  try {
    await db.execute(sql`DELETE FROM ${keyProgArchivesTable}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
