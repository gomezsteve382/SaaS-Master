import { Router, type IRouter } from "express";
import { sql, desc, eq } from "drizzle-orm";
import { db, keyHistoryTable } from "@workspace/db";

const router: IRouter = Router();

/**
 * Per-vehicle key history (Task #991).
 *
 * Persists the "keys on file" list captured on the Key Dump card so the
 * history survives a browser-data wipe and shows up on a second bench laptop
 * for the same VIN. Mirrors the round-trip pattern of /api/backups and
 * /api/key-prog-archives: the client treats localStorage as an offline cache.
 *
 * Entries are scoped by VIN. `capturedAt` is exchanged with the client as
 * epoch milliseconds (the shape keyHistory.js already uses) and stored as a
 * timestamptz column.
 */

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
const MAX_LIST = 200;
const MAX_PAYLOAD_BYTES = 16 * 1024; // 16 KB — entries are tiny metadata records

function normalizeVin(v: unknown): string {
  if (typeof v !== "string") return "";
  const up = v.toUpperCase().replace(/\s/g, "");
  return VIN_PATTERN.test(up) ? up : "";
}

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  return 0;
}

function rowToJson(row: typeof keyHistoryTable.$inferSelect) {
  return {
    id: row.id,
    vin: row.vin,
    chipId: row.chipId,
    uidHex: row.uidHex ?? "",
    skHex: row.skHex ?? "",
    flags: row.flags ?? null,
    label: row.label ?? "",
    slotIdx: row.slotIdx ?? null,
    capturedAt: toMs(row.capturedAt),
  };
}

router.get("/key-history", async (req, res, next) => {
  try {
    const vin = normalizeVin(req.query["vin"]);
    if (!vin) {
      res.status(400).json({ error: "valid 17-char vin query param is required" });
      return;
    }
    const rows = await db
      .select()
      .from(keyHistoryTable)
      .where(eq(keyHistoryTable.vin, vin))
      .orderBy(desc(keyHistoryTable.capturedAt))
      .limit(MAX_LIST);
    res.json({ entries: rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/key-history", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const vin = normalizeVin(body.vin);
    if (!vin) {
      res.status(400).json({ error: "valid 17-char vin is required" });
      return;
    }
    const chipId = typeof body.chipId === "string" ? body.chipId.slice(0, 64) : "";
    if (!chipId) {
      res.status(400).json({ error: "chipId is required" });
      return;
    }

    const uidHex = typeof body.uidHex === "string" ? body.uidHex.slice(0, 256) : "";
    const skHex = typeof body.skHex === "string" ? body.skHex.slice(0, 256) : "";
    const label = typeof body.label === "string" ? body.label.slice(0, 256) : "";
    const flags = body.flags && typeof body.flags === "object" ? body.flags : null;
    const slotIdx = Number.isInteger(body.slotIdx) ? Number(body.slotIdx) : null;
    const capturedAt =
      Number.isFinite(body.capturedAt) && Number(body.capturedAt) > 0
        ? new Date(Number(body.capturedAt))
        : new Date();

    if (flags) {
      const serialized = JSON.stringify(flags);
      if (serialized.length > MAX_PAYLOAD_BYTES) {
        res.status(413).json({ error: "payload too large" });
        return;
      }
    }

    await db
      .insert(keyHistoryTable)
      .values({ id, vin, chipId, uidHex, skHex, flags, label, slotIdx, capturedAt })
      .onConflictDoUpdate({
        target: keyHistoryTable.id,
        set: { vin, chipId, uidHex, skHex, flags, label, slotIdx, capturedAt },
      });

    res.json({ id, ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/key-history/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(keyHistoryTable).where(eq(keyHistoryTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/key-history", async (req, res, next) => {
  try {
    const vin = normalizeVin(req.query["vin"]);
    if (vin) {
      await db.delete(keyHistoryTable).where(eq(keyHistoryTable.vin, vin));
    } else {
      await db.execute(sql`DELETE FROM ${keyHistoryTable}`);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
