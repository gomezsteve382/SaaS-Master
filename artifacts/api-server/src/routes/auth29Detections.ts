import { Router, type IRouter } from "express";
import { desc, eq, and } from "drizzle-orm";
import { db, auth29DetectionsTable, type Auth29Detection } from "@workspace/db";

const router: IRouter = Router();

/**
 * UDS 0x29 detections (Task #573).
 *
 * Persists the records the in-tab detector previously kept only in
 * localStorage so the bench remembers — across browsers / machines —
 * which modules on a given VIN have moved to Authentication (0x29)
 * instead of SecurityAccess (0x27). Endpoints:
 *
 *   GET    /api/auth29-detections          → list (newest first), optional ?vin=…
 *   POST   /api/auth29-detections          → upsert one detection (PK is vin+tx+rx)
 *   DELETE /api/auth29-detections          → scoped clear (?vin=… required;
 *                                            optional &tx=…&rx=…). Refuses an
 *                                            unscoped wipe so a single user
 *                                            dismissing a banner can never
 *                                            blow away the fleet-wide map.
 */

const MAX_LIST = 500;
const MAX_LABEL_LEN = 64;
const MAX_VIN_LEN = 32;

function rowToJson(row: Auth29Detection) {
  return {
    vin: row.vin,
    tx: row.tx,
    // rx is stored as 0 when "unknown" so the PK stays total (PG won't
    // allow NULL in a PK column). Surface 0 as null on the wire so the
    // client renders an em-dash instead of "0x0000".
    rx: row.rx === 0 ? null : row.rx,
    label: row.label ?? null,
    nrc: row.nrc ?? null,
    detectedAt:
      row.detectedAt instanceof Date
        ? row.detectedAt.toISOString()
        : row.detectedAt,
  };
}

function normVin(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.toUpperCase().replace(/\s+/g, "").slice(0, MAX_VIN_LEN);
}

function coerceU16(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 0 || n > 0xffff) return null;
  return n;
}

function coerceU8(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v) & 0xff;
  return n;
}

router.get("/auth29-detections", async (req, res, next) => {
  try {
    const vinFilter =
      typeof req.query["vin"] === "string" ? normVin(req.query["vin"]) : null;
    const base = db.select().from(auth29DetectionsTable);
    const rows = vinFilter
      ? await base
          .where(eq(auth29DetectionsTable.vin, vinFilter))
          .orderBy(desc(auth29DetectionsTable.detectedAt))
          .limit(MAX_LIST)
      : await base
          .orderBy(desc(auth29DetectionsTable.detectedAt))
          .limit(MAX_LIST);
    res.json({ detections: rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/auth29-detections", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const tx = coerceU16(body.tx);
    if (tx === null) {
      res.status(400).json({ error: "invalid tx" });
      return;
    }
    const vin = normVin(body.vin);
    const rxRaw = coerceU16(body.rx);
    // Coerce missing rx to 0 so the composite PK (vin, tx, rx) stays
    // total. The wire format still surfaces 0 → null on read.
    const rx = rxRaw ?? 0;
    const nrc = body.nrc == null ? null : coerceU8(body.nrc);
    const label =
      typeof body.label === "string" && body.label
        ? body.label.slice(0, MAX_LABEL_LEN)
        : null;
    const detectedAt = new Date();

    await db
      .insert(auth29DetectionsTable)
      .values({ vin, tx, rx, label, nrc, detectedAt })
      .onConflictDoUpdate({
        target: [
          auth29DetectionsTable.vin,
          auth29DetectionsTable.tx,
          auth29DetectionsTable.rx,
        ],
        set: { label, nrc, detectedAt },
      });

    res.json({
      ok: true,
      detection: {
        vin,
        tx,
        rx: rxRaw,
        label,
        nrc,
        detectedAt: detectedAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/auth29-detections", async (req, res, next) => {
  try {
    // Scoping rules — the fleet-wide detection map is shared bench
    // state, so DELETE always requires at least a VIN. Without that
    // guard, any user dismissing a local banner could wipe history
    // for every other operator.
    const vinFilter =
      typeof req.query["vin"] === "string" ? normVin(req.query["vin"]) : null;
    if (!vinFilter) {
      res
        .status(400)
        .json({ error: "vin query param required to scope the delete" });
      return;
    }
    const txRaw = req.query["tx"];
    const tx =
      typeof txRaw === "string" && /^\d+$/.test(txRaw)
        ? coerceU16(Number(txRaw))
        : null;
    const rxRaw = req.query["rx"];
    const rx =
      typeof rxRaw === "string" && /^\d+$/.test(rxRaw)
        ? coerceU16(Number(rxRaw))
        : null;

    if (tx !== null && rx !== null) {
      await db
        .delete(auth29DetectionsTable)
        .where(
          and(
            eq(auth29DetectionsTable.vin, vinFilter),
            eq(auth29DetectionsTable.tx, tx),
            eq(auth29DetectionsTable.rx, rx),
          ),
        );
    } else if (tx !== null) {
      await db
        .delete(auth29DetectionsTable)
        .where(
          and(
            eq(auth29DetectionsTable.vin, vinFilter),
            eq(auth29DetectionsTable.tx, tx),
          ),
        );
    } else {
      await db
        .delete(auth29DetectionsTable)
        .where(eq(auth29DetectionsTable.vin, vinFilter));
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
