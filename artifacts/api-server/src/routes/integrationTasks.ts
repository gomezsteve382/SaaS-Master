import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, integrationTasksTable, type IntegrationTask } from "@workspace/db";

const router: IRouter = Router();

/**
 * Integration Tasks (Task #620).
 *
 * Backlog of "should we integrate this tool?" decisions, one row per
 * shortlisted CAN Universe entry. The CAN Universe tab POSTs an array
 * of starred entries via /integration-tasks/bulk-upsert; the same tab
 * lists, updates and deletes them through the regular CRUD endpoints.
 *
 * Status is a free-form short string ("open" | "in_progress" | "done"
 * | "skipped" today, but we don't lock the vocabulary at the DB so
 * the UI can grow without a migration).
 */

const ID_PATTERN = /^[A-Za-z0-9_.:\-]{1,160}$/;
const MAX_LIST = 500;
const MAX_NAME = 256;
const MAX_URL = 1024;
const MAX_CATEGORY = 128;
const MAX_TARGET = 128;
const MAX_STATUS = 32;
const MAX_NOTES = 4096;
const ALLOWED_STATUS = new Set(["open", "in_progress", "done", "skipped"]);

function rowToJson(row: IntegrationTask) {
  return {
    id: row.id,
    toolId: row.toolId,
    toolName: row.toolName,
    toolUrl: row.toolUrl ?? null,
    category: row.category ?? null,
    target: row.target ?? null,
    status: row.status,
    notes: row.notes ?? null,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt,
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : row.updatedAt,
  };
}

function s(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.slice(0, max);
  return t.length ? t : null;
}

function normStatus(v: unknown): string {
  if (typeof v !== "string") return "open";
  const t = v.slice(0, MAX_STATUS);
  return ALLOWED_STATUS.has(t) ? t : "open";
}

router.get("/integration-tasks", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(integrationTasksTable)
      .orderBy(desc(integrationTasksTable.updatedAt))
      .limit(MAX_LIST);
    res.json({ tasks: rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/integration-tasks/bulk-upsert", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const entries = Array.isArray(body.entries) ? body.entries : null;
    if (!entries) {
      res.status(400).json({ error: "entries[] required" });
      return;
    }
    if (entries.length === 0) {
      res.json({ ok: true, upserted: 0, tasks: [] });
      return;
    }
    if (entries.length > 500) {
      res.status(413).json({ error: "too many entries (max 500)" });
      return;
    }

    const now = new Date();
    const inserted: IntegrationTask[] = [];
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const toolId = s(raw.toolId, 128);
      const toolName = s(raw.toolName, MAX_NAME);
      if (!toolId || !toolName) continue;
      const id = `tool:${toolId}`;
      if (!ID_PATTERN.test(id)) continue;
      const toolUrl = s(raw.toolUrl, MAX_URL);
      const category = s(raw.category, MAX_CATEGORY);
      const target = s(raw.target, MAX_TARGET);

      // onConflict: keep the prior status/notes (operator state) and
      // refresh only the catalog-derived fields + updatedAt. That way a
      // user can re-click "Convert shortlist to tasks" after editing the
      // shortlist without clobbering progress they've already recorded.
      const [row] = await db
        .insert(integrationTasksTable)
        .values({
          id,
          toolId,
          toolName,
          toolUrl,
          category,
          target,
          status: "open",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: integrationTasksTable.id,
          set: { toolName, toolUrl, category, target, updatedAt: now },
        })
        .returning();
      if (row) inserted.push(row);
    }

    req.log.info({ count: inserted.length }, "integration tasks bulk upserted");
    res.json({ ok: true, upserted: inserted.length, tasks: inserted.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

router.patch("/integration-tasks/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const body = req.body ?? {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.status === "string") updates["status"] = normStatus(body.status);
    if (typeof body.notes === "string") updates["notes"] = body.notes.slice(0, MAX_NOTES);
    if (body.notes === null) updates["notes"] = null;
    if (typeof body.target === "string") updates["target"] = body.target.slice(0, MAX_TARGET);

    const [row] = await db
      .update(integrationTasksTable)
      .set(updates)
      .where(eq(integrationTasksTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(rowToJson(row));
  } catch (err) {
    next(err);
  }
});

router.delete("/integration-tasks/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(integrationTasksTable).where(eq(integrationTasksTable.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
