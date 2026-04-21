import { Router, type IRouter } from "express";
import { sql, desc, eq } from "drizzle-orm";
import { db, diffReportsTable } from "@workspace/db";

const router: IRouter = Router();

/**
 * Saved diff reports.
 * Persists baseline-vs-current scan comparisons so report history survives
 * across browsers, cleared site data, and multi-technician shop setups.
 * The Backups tab in srt-lab is the primary consumer; localStorage is used
 * as an offline cache that mirrors the server state. Mirrors the shape of
 * the /api/backups route.
 */

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_LIST = 200;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB per report (scans can be large)

function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function toDate(v: unknown): Date | null {
  const ms = toMs(v);
  return ms == null ? null : new Date(ms);
}

router.get("/diff-reports", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        id: diffReportsTable.id,
        generatedAt: diffReportsTable.generatedAt,
        baselineLabel: diffReportsTable.baselineLabel,
        baselineTs: diffReportsTable.baselineTs,
        baselineModuleCount: diffReportsTable.baselineModuleCount,
        currentTs: diffReportsTable.currentTs,
        currentModuleCount: diffReportsTable.currentModuleCount,
        addedCount: diffReportsTable.addedCount,
        removedCount: diffReportsTable.removedCount,
        changedCount: diffReportsTable.changedCount,
        sameCount: diffReportsTable.sameCount,
        author: diffReportsTable.author,
      })
      .from(diffReportsTable)
      .orderBy(desc(diffReportsTable.generatedAt))
      .limit(MAX_LIST);

    res.json({
      reports: rows.map((r) => ({
        id: r.id,
        generatedAt: r.generatedAt instanceof Date ? r.generatedAt.getTime() : r.generatedAt,
        baselineLabel: r.baselineLabel,
        baselineTs: r.baselineTs instanceof Date ? r.baselineTs.getTime() : r.baselineTs,
        baselineModuleCount: r.baselineModuleCount,
        currentTs: r.currentTs instanceof Date ? r.currentTs.getTime() : r.currentTs,
        currentModuleCount: r.currentModuleCount,
        addedCount: r.addedCount,
        removedCount: r.removedCount,
        changedCount: r.changedCount,
        sameCount: r.sameCount,
        author: r.author,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/diff-reports/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const rows = await db
      .select()
      .from(diffReportsTable)
      .where(eq(diffReportsTable.id, id))
      .limit(1);
    if (rows.length === 0) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const row = rows[0]!;
    res.json({
      id: row.id,
      generatedAt: row.generatedAt instanceof Date ? row.generatedAt.getTime() : row.generatedAt,
      baselineLabel: row.baselineLabel,
      baselineTs: row.baselineTs instanceof Date ? row.baselineTs.getTime() : row.baselineTs,
      baselineModuleCount: row.baselineModuleCount,
      currentTs: row.currentTs instanceof Date ? row.currentTs.getTime() : row.currentTs,
      currentModuleCount: row.currentModuleCount,
      addedCount: row.addedCount,
      removedCount: row.removedCount,
      changedCount: row.changedCount,
      sameCount: row.sameCount,
      author: row.author,
      payload: row.payload,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/diff-reports", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    const payload = body.payload ?? null;

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

    const baseline = (payload as { baseline?: { label?: unknown; ts?: unknown; modules?: unknown[] } }).baseline ?? {};
    const current = (payload as { current?: { ts?: unknown; modules?: unknown[] } }).current ?? {};
    const diff = (payload as { diff?: { added?: unknown[]; removed?: unknown[]; changed?: unknown[]; same?: unknown[] } }).diff ?? {};

    const baselineLabel =
      typeof body.baselineLabel === "string" ? body.baselineLabel :
      typeof baseline.label === "string" ? baseline.label : "(unlabeled)";
    const baselineTs = toDate(body.baselineTs ?? baseline.ts);
    const baselineModuleCount = Number.isFinite(body.baselineModuleCount)
      ? Number(body.baselineModuleCount)
      : Array.isArray(baseline.modules) ? baseline.modules.length : 0;
    const currentTs = toDate(body.currentTs ?? current.ts);
    const currentModuleCount = Number.isFinite(body.currentModuleCount)
      ? Number(body.currentModuleCount)
      : Array.isArray(current.modules) ? current.modules.length : 0;
    const addedCount = Number.isFinite(body.addedCount)
      ? Number(body.addedCount)
      : Array.isArray(diff.added) ? diff.added.length : 0;
    const removedCount = Number.isFinite(body.removedCount)
      ? Number(body.removedCount)
      : Array.isArray(diff.removed) ? diff.removed.length : 0;
    const changedCount = Number.isFinite(body.changedCount)
      ? Number(body.changedCount)
      : Array.isArray(diff.changed) ? diff.changed.length : 0;
    const sameCount = Number.isFinite(body.sameCount)
      ? Number(body.sameCount)
      : Array.isArray(diff.same) ? diff.same.length : 0;

    const rawAuthor =
      typeof body.author === "string" ? body.author :
      typeof (payload as { author?: unknown }).author === "string" ? (payload as { author: string }).author :
      null;
    const author = rawAuthor ? rawAuthor.trim().slice(0, 120) || null : null;

    const generatedAtRaw = body.generatedAt ?? (payload as { generatedAt?: unknown }).generatedAt ?? Date.now();
    const generatedAt = toDate(generatedAtRaw) ?? new Date();

    await db
      .insert(diffReportsTable)
      .values({
        id,
        generatedAt,
        baselineLabel,
        baselineTs,
        baselineModuleCount,
        currentTs,
        currentModuleCount,
        addedCount,
        removedCount,
        changedCount,
        sameCount,
        author,
        payload,
      })
      .onConflictDoUpdate({
        target: diffReportsTable.id,
        set: {
          generatedAt,
          baselineLabel,
          baselineTs,
          baselineModuleCount,
          currentTs,
          currentModuleCount,
          addedCount,
          removedCount,
          changedCount,
          sameCount,
          author,
          payload,
        },
      });

    res.json({ id, ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/diff-reports/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(diffReportsTable).where(eq(diffReportsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/diff-reports", async (_req, res, next) => {
  try {
    await db.execute(sql`DELETE FROM ${diffReportsTable}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
