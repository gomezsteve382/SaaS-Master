import { Router, type IRouter } from "express";
import { sql, desc, eq } from "drizzle-orm";
import { db, moduleBackupsTable } from "@workspace/db";

const router: IRouter = Router();

/**
 * Module backup snapshots.
 * Persists pre-write DID snapshots so backup history survives across browsers,
 * cleared site data, and multi-technician shop setups. The Backups tab in
 * srt-lab is the primary consumer; localStorage is used as an offline cache
 * that mirrors the server state.
 */

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_LIST = 200;
const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB per backup

router.get("/backups", async (req, res, next) => {
  try {
    const moduleFilter = typeof req.query["module"] === "string" ? req.query["module"] : null;

    const baseQuery = db
      .select({
        id: moduleBackupsTable.id,
        module: moduleBackupsTable.module,
        vin: moduleBackupsTable.vin,
        didCount: moduleBackupsTable.didCount,
        tx: moduleBackupsTable.tx,
        rx: moduleBackupsTable.rx,
        timestamp: moduleBackupsTable.timestamp,
        author: moduleBackupsTable.author,
      })
      .from(moduleBackupsTable);

    const rows = moduleFilter
      ? await baseQuery
          .where(eq(moduleBackupsTable.module, moduleFilter))
          .orderBy(desc(moduleBackupsTable.timestamp))
          .limit(MAX_LIST)
      : await baseQuery
          .orderBy(desc(moduleBackupsTable.timestamp))
          .limit(MAX_LIST);

    res.json({
      backups: rows.map((r) => ({
        id: r.id,
        key: r.id,
        module: r.module,
        vin: r.vin,
        didCount: r.didCount,
        tx: r.tx,
        rx: r.rx,
        timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
        author: r.author,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/backups/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const rows = await db
      .select()
      .from(moduleBackupsTable)
      .where(eq(moduleBackupsTable.id, id))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "not found" });
      return;
    }

    const row = rows[0]!;
    res.json({
      id: row.id,
      key: row.id,
      module: row.module,
      vin: row.vin,
      didCount: row.didCount,
      tx: row.tx,
      rx: row.rx,
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
      author: row.author,
      payload: row.payload,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/backups", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const id = typeof body.id === "string" ? body.id : typeof body.key === "string" ? body.key : "";
    const payload = body.payload ?? body.backup ?? null;

    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    if (!payload || typeof payload !== "object") {
      res.status(400).json({ error: "missing payload" });
      return;
    }

    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ error: "payload too large" });
      return;
    }

    const moduleType =
      typeof body.module === "string" ? body.module :
      typeof payload.module === "string" ? payload.module : "UNKNOWN";
    const vin = typeof body.vin === "string" ? body.vin : "unknown";
    const didCount = Number.isFinite(body.didCount)
      ? Number(body.didCount)
      : (payload.dids && typeof payload.dids === "object"
          ? Object.values(payload.dids).filter((d: unknown) => {
              const dd = d as { bytes?: unknown[]; missing?: boolean } | null;
              return !!dd && !dd.missing && Array.isArray(dd.bytes) && dd.bytes.length > 0;
            }).length
          : 0);
    const tx = Number.isFinite(body.tx) ? Number(body.tx) :
              Number.isFinite(payload.tx) ? Number(payload.tx) : null;
    const rx = Number.isFinite(body.rx) ? Number(body.rx) :
              Number.isFinite(payload.rx) ? Number(payload.rx) : null;
    const tsRaw = body.timestamp ?? payload.timestamp ?? null;
    const ts = tsRaw ? new Date(tsRaw) : new Date();
    const timestamp = Number.isNaN(ts.getTime()) ? new Date() : ts;

    const rawAuthor =
      typeof body.author === "string" ? body.author :
      typeof (payload as { author?: unknown }).author === "string" ? (payload as { author: string }).author :
      null;
    const author = rawAuthor ? rawAuthor.trim().slice(0, 120) || null : null;

    await db
      .insert(moduleBackupsTable)
      .values({
        id,
        module: moduleType,
        vin,
        didCount,
        tx,
        rx,
        timestamp,
        author,
        payload,
      })
      .onConflictDoUpdate({
        target: moduleBackupsTable.id,
        set: {
          module: moduleType,
          vin,
          didCount,
          tx,
          rx,
          timestamp,
          author,
          payload,
        },
      });

    res.json({ id, key: id, ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/backups/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(moduleBackupsTable).where(eq(moduleBackupsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/backups", async (_req, res, next) => {
  try {
    await db.execute(sql`DELETE FROM ${moduleBackupsTable}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
