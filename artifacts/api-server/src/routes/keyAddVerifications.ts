import { Router, type IRouter } from "express";
import { sql, desc, eq } from "drizzle-orm";
import { db, keyAddVerificationsTable } from "@workspace/db";

/**
 * Bench-verified offline key-add confirmations.
 *
 * Persists the clean before/after verdicts produced by CharRfhubKeyDiffPanel so
 * the confirmation survives a browser-data wipe and shows up on a second bench
 * laptop. Once a layout has at least one confirmation, the Offline Key Adder
 * softens its permanent "NOT BENCH-VERIFIED" caveat for that layout.
 *
 * Mirrors the round-trip pattern of /api/key-history: the client treats
 * localStorage as an offline cache. Records are scoped by `layout` (the write
 * path being verified) rather than by VIN. `confirmedAt` is exchanged with the
 * client as epoch milliseconds and stored as a timestamptz column.
 */

const router: IRouter = Router();

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const LAYOUT_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_LIST = 200;

function normalizeLayout(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return LAYOUT_PATTERN.test(s) ? s : "";
}

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  return 0;
}

function intOrNull(v: unknown): number | null {
  return Number.isInteger(v) ? Number(v) : null;
}

function rowToJson(row: typeof keyAddVerificationsTable.$inferSelect) {
  return {
    id: row.id,
    layout: row.layout,
    addedKeyId: row.addedKeyId ?? "",
    slot: row.slot ?? null,
    slotIdx: row.slotIdx ?? null,
    expectedSlotIdx: row.expectedSlotIdx ?? null,
    beforeKeyCount: row.beforeKeyCount ?? null,
    afterKeyCount: row.afterKeyCount ?? null,
    beforeName: row.beforeName ?? "",
    afterName: row.afterName ?? "",
    confirmedAt: toMs(row.confirmedAt),
  };
}

router.get("/key-add-verifications", async (req, res, next) => {
  try {
    const layout = normalizeLayout(req.query["layout"]);
    if (!layout) {
      res.status(400).json({ error: "valid layout query param is required" });
      return;
    }
    const rows = await db
      .select()
      .from(keyAddVerificationsTable)
      .where(eq(keyAddVerificationsTable.layout, layout))
      .orderBy(desc(keyAddVerificationsTable.confirmedAt))
      .limit(MAX_LIST);
    res.json({ entries: rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/key-add-verifications", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const layout = normalizeLayout(body.layout);
    if (!layout) {
      res.status(400).json({ error: "valid layout is required" });
      return;
    }

    const addedKeyId =
      typeof body.addedKeyId === "string" ? body.addedKeyId.slice(0, 64) : "";
    const beforeName =
      typeof body.beforeName === "string" ? body.beforeName.slice(0, 256) : "";
    const afterName =
      typeof body.afterName === "string" ? body.afterName.slice(0, 256) : "";
    const slot = intOrNull(body.slot);
    const slotIdx = intOrNull(body.slotIdx);
    const expectedSlotIdx = intOrNull(body.expectedSlotIdx);
    const beforeKeyCount = intOrNull(body.beforeKeyCount);
    const afterKeyCount = intOrNull(body.afterKeyCount);
    const confirmedAt =
      Number.isFinite(body.confirmedAt) && Number(body.confirmedAt) > 0
        ? new Date(Number(body.confirmedAt))
        : new Date();

    await db
      .insert(keyAddVerificationsTable)
      .values({
        id,
        layout,
        addedKeyId,
        slot,
        slotIdx,
        expectedSlotIdx,
        beforeKeyCount,
        afterKeyCount,
        beforeName,
        afterName,
        confirmedAt,
      })
      .onConflictDoUpdate({
        target: keyAddVerificationsTable.id,
        set: {
          layout,
          addedKeyId,
          slot,
          slotIdx,
          expectedSlotIdx,
          beforeKeyCount,
          afterKeyCount,
          beforeName,
          afterName,
          confirmedAt,
        },
      });

    res.json({ id, ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/key-add-verifications/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db
      .delete(keyAddVerificationsTable)
      .where(eq(keyAddVerificationsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/key-add-verifications", async (req, res, next) => {
  try {
    const layout = normalizeLayout(req.query["layout"]);
    if (layout) {
      await db
        .delete(keyAddVerificationsTable)
        .where(eq(keyAddVerificationsTable.layout, layout));
    } else {
      await db.execute(sql`DELETE FROM ${keyAddVerificationsTable}`);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
