import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, sessionLogTable } from "@workspace/db";

const router: IRouter = Router();

/**
 * Session paper-trail log (Task #936).
 *
 * Append-only audit trail of every programming operation. Persisted here so
 * the paper trail survives a browser clear, device switch, or being shared
 * across technicians. localStorage in the client is an offline cache that
 * mirrors this server state.
 *
 * Sessions are associated with the VIN / vehicle-job context, not a logged-in
 * user. The full client record is stored verbatim in `payload`; GET returns
 * that payload so the client merge keeps full fidelity.
 */

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_LIST = 500;
const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB per session record

function str(v: unknown, max = 256): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

router.get("/sessions", async (req, res, next) => {
  try {
    const vin = typeof req.query["vin"] === "string" ? req.query["vin"] : null;
    const jobId = typeof req.query["jobId"] === "string" ? req.query["jobId"] : null;

    const baseQuery = db.select().from(sessionLogTable);
    const rows = vin
      ? await baseQuery
          .where(eq(sessionLogTable.vin, vin))
          .orderBy(desc(sessionLogTable.timestamp))
          .limit(MAX_LIST)
      : jobId
        ? await baseQuery
            .where(eq(sessionLogTable.jobId, jobId))
            .orderBy(desc(sessionLogTable.timestamp))
            .limit(MAX_LIST)
        : await baseQuery
            .orderBy(desc(sessionLogTable.timestamp))
            .limit(MAX_LIST);

    res.json({
      sessions: rows.map((r) => {
        const payload = (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<
          string,
          unknown
        >;
        return {
          // Spread the verbatim client record first, then pin the
          // server-authoritative fields so they always win.
          ...payload,
          id: r.id,
          timestamp:
            r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
          synced: true,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/sessions", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    // The whole client record is the payload (minus the volatile `synced`
    // flag, which is a client-only marker).
    const { synced: _synced, ...payload } = body as Record<string, unknown>;
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ error: "payload too large" });
      return;
    }

    const newVin = str(body.newVin, 32);
    const oldVin = str(body.oldVin, 32);
    const vin = newVin || oldVin;
    const tsRaw = body.timestamp ?? null;
    const ts = tsRaw ? new Date(tsRaw) : new Date();
    const timestamp = Number.isNaN(ts.getTime()) ? new Date() : ts;
    const voltage =
      typeof body.voltage === "number" && Number.isFinite(body.voltage)
        ? body.voltage
        : null;

    const values = {
      id,
      vin,
      module: str(body.module, 32),
      operation: str(body.operation),
      success: bool(body.success),
      oldVin,
      newVin,
      technician: str(body.technician),
      titleRef: str(body.titleRef),
      titleNotes: str(body.titleNotes, 2048),
      adapter: str(body.adapter),
      sgwRouted: bool(body.sgwRouted),
      algorithm: str(body.algorithm),
      voltage,
      preWriteConfirmed: str(body.preWriteConfirmed),
      notes: str(body.notes, 4096),
      backupKey: str(body.backupKey),
      jobId: str(body.jobId),
      timestamp,
      payload,
    };

    await db
      .insert(sessionLogTable)
      .values(values)
      .onConflictDoUpdate({
        target: sessionLogTable.id,
        set: {
          vin: values.vin,
          module: values.module,
          operation: values.operation,
          success: values.success,
          oldVin: values.oldVin,
          newVin: values.newVin,
          technician: values.technician,
          titleRef: values.titleRef,
          titleNotes: values.titleNotes,
          adapter: values.adapter,
          sgwRouted: values.sgwRouted,
          algorithm: values.algorithm,
          voltage: values.voltage,
          preWriteConfirmed: values.preWriteConfirmed,
          notes: values.notes,
          backupKey: values.backupKey,
          jobId: values.jobId,
          timestamp: values.timestamp,
          payload: values.payload,
        },
      });

    req.log.info({ sessionId: id, vin }, "session log upserted");
    res.json({ id, ok: true, synced: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/sessions/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(sessionLogTable).where(eq(sessionLogTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
