import { Router, type IRouter } from "express";
import { and, desc, eq, gt } from "drizzle-orm";
import {
  db,
  task634VerificationsTable,
  type Task634Verification,
} from "@workspace/db";

const router: IRouter = Router();

/**
 * Task #641 — bench verification flags for task-634 entries.
 *
 * Lets the UnlockCoverageTab promote a hand-curated task-634 row from
 * "bench-pending" to "verified" once an operator has actually run the
 * capability against a real vehicle, and have that flip survive a page
 * reload AND show up on other bench machines.
 *
 *   GET    /api/task634-verifications          → list every verification
 *   POST   /api/task634-verifications          → upsert one (body: {entryId, vin?, notes?, operator?})
 *   DELETE /api/task634-verifications/:entryId → un-verify a single entry
 */

const MAX_ENTRY_ID_LEN = 64;
const MAX_VIN_LEN = 32;
const MAX_NOTES_LEN = 2000;
const MAX_OPERATOR_LEN = 120;
const ENTRY_ID_RE = /^[a-z0-9_]+$/;

function rowToJson(row: Task634Verification) {
  return {
    entryId: row.entryId,
    vin: row.vin ?? null,
    notes: row.notes ?? null,
    operator: row.operator ?? null,
    verifiedAt:
      row.verifiedAt instanceof Date
        ? row.verifiedAt.toISOString()
        : row.verifiedAt,
  };
}

function normEntryId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim().toLowerCase().slice(0, MAX_ENTRY_ID_LEN);
  if (!ENTRY_ID_RE.test(trimmed)) return null;
  return trimmed;
}

router.get("/task634-verifications", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(task634VerificationsTable)
      .orderBy(desc(task634VerificationsTable.verifiedAt));
    res.json({ verifications: rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/task634-verifications", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const entryId = normEntryId(body.entryId);
    if (!entryId) {
      res.status(400).json({ error: "invalid entryId" });
      return;
    }
    const vin =
      typeof body.vin === "string" && body.vin
        ? body.vin.toUpperCase().replace(/\s+/g, "").slice(0, MAX_VIN_LEN)
        : null;
    const notes =
      typeof body.notes === "string" && body.notes.trim()
        ? body.notes.trim().slice(0, MAX_NOTES_LEN)
        : null;
    const operator =
      typeof body.operator === "string" && body.operator.trim()
        ? body.operator.trim().slice(0, MAX_OPERATOR_LEN)
        : null;
    const verifiedAt = new Date();

    // Task #663 — optimistic-concurrency check for queued/offline writes.
    // The client passes `clientVerifiedAt` (the ISO timestamp it stamped
    // locally when the operator hit Save) for any operation that was
    // queued while the API was unreachable. If the server already has a
    // row with a strictly newer verifiedAt, somebody else verified the
    // same entry after this op was queued — we refuse to clobber and
    // return 409 with the authoritative row so the UI can surface it.
    const clientVerifiedAtRaw =
      typeof body.clientVerifiedAt === "string" ? body.clientVerifiedAt : null;
    const clientVerifiedAt = clientVerifiedAtRaw
      ? new Date(clientVerifiedAtRaw)
      : null;
    if (clientVerifiedAt && !Number.isFinite(clientVerifiedAt.getTime())) {
      res.status(400).json({ error: "invalid clientVerifiedAt" });
      return;
    }
    if (clientVerifiedAt) {
      const existing = await db
        .select()
        .from(task634VerificationsTable)
        .where(
          and(
            eq(task634VerificationsTable.entryId, entryId),
            gt(task634VerificationsTable.verifiedAt, clientVerifiedAt),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        const row = existing[0]!;
        res.status(409).json({
          error: "conflict",
          conflict: {
            clientVerifiedAt: clientVerifiedAt.toISOString(),
            server: rowToJson(row),
          },
        });
        return;
      }
    }

    await db
      .insert(task634VerificationsTable)
      .values({ entryId, vin, notes, operator, verifiedAt })
      .onConflictDoUpdate({
        target: task634VerificationsTable.entryId,
        set: { vin, notes, operator, verifiedAt },
      });

    res.json({
      ok: true,
      verification: {
        entryId,
        vin,
        notes,
        operator,
        verifiedAt: verifiedAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/task634-verifications/:entryId", async (req, res, next) => {
  try {
    const entryId = normEntryId(req.params["entryId"]);
    if (!entryId) {
      res.status(400).json({ error: "invalid entryId" });
      return;
    }
    await db
      .delete(task634VerificationsTable)
      .where(eq(task634VerificationsTable.entryId, entryId));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
